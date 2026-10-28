/**
 * v1.4.11-pre3 AI 底座：OpenAI 兼容 Provider 调用层。
 *
 * 设计约束：
 * - 直接走 fetch 而非 httpRequest：后者没有超时与按状态码分支的能力，而 LLM 调用两者都需要
 *   （首字慢、401/404/429 必须给出可读原因）。代理由主进程 session.setProxy 在 Chromium 网络层
 *   统一生效，不经 httpRequest 也照样走代理。
 * - 密钥只从主进程取（safeStorage 解密后回传），渲染层不落 localStorage。
 * - 不在这里做任何业务语义（歌单/歌词/画像），只提供 chat 与连通性测试两个原语。
 */

import { platform } from '@/platform'
import { recordUsage } from '@/services/aiUsage'
import type { AiProviderConfig, AiSettings } from '@/types'

/** 该环境是否支持 AI（桌面端才有主进程加密存储） */
export function isAiSupported(): boolean {
  return !!platform.aiConfig
}

/**
 * 不支持 AI 时的原因描述，用于在设置页给出可见提示而不是静默隐藏。
 *
 * v1.4.11-pre4 教训：pre3 的 AI 分组用 `isAiSupported() &&` 静默隐藏，
 * 而 OTA 渲染补丁把渲染层锁在旧版本时该能力探测必然失败，
 * 表现成「装了新包但设置里没有 AI」且没有任何线索。宁可显示一行说明。
 */
export function aiUnsupportedReason(): string {
  if (platform.aiConfig) return ''
  if (typeof window === 'undefined' || !window.electronAPI) {
    return 'AI 需要桌面端主进程支持，当前环境未加载桌面桥（若刚升级，请完全退出并重新打开应用）'
  }
  return '当前平台不支持 AI 配置（移动端无系统级加密存储）'
}

export async function getAiConfig(): Promise<AiSettings> {
  const cap = platform.aiConfig
  if (!cap) {
    return {
      baseUrl: '', model: '', apiKey: '', proxyMode: 'system', proxyUrl: '',
      recommendMode: 'click', userProfile: { text: '', updatedAt: '' }, persona: '',
    }
  }
  return cap.get()
}

export async function saveAiConfig(config: AiSettings): Promise<{ ok: boolean }> {
  const cap = platform.aiConfig
  if (!cap) throw new Error('当前平台不支持 AI 配置')
  return cap.set(config)
}

/**
 * 把 HTTP 状态码翻译成可操作的中文说明。
 *
 * v1.4.11-pre5：按 DeepSeek 官方错误码表对齐（用户提供了该表并要求照此优化）。
 * 各家 OpenAI 兼容服务基本沿用同一套语义，因此对 OpenAI 也通用。
 * 除了说「错在哪」，还要说「怎么办」——这是原实现只给状态码的短板。
 */
export function describeHttpError(status: number, body = ''): string {
  const detail = extractApiMessage(body)
  const suffix = detail ? `（服务端说明：${detail}）` : ''
  switch (status) {
    case 400:
      return `400 请求格式错误：请求体格式有误，请检查模型名与参数${suffix}`
    case 401:
      return `401 认证失败：API 密钥不正确或已失效，请重新复制密钥${suffix}`
    case 402:
      return `402 余额不足：请前往服务商控制台充值后重试${suffix}`
    case 403:
      return `403 无权限：该密钥无权访问此模型，请确认模型名与账号权限${suffix}`
    case 404:
      return `404 接口不存在：请检查 API 地址，DeepSeek 应为 https://api.deepseek.com${suffix}`
    case 422:
      return `422 参数错误：请求参数不合法，请检查模型名是否可用${suffix}`
    case 429:
      return `429 请求速率达到上限：请求过快或并发过高，请稍后重试${suffix}`
    case 500:
      return `500 服务器内部故障：服务商侧问题，请稍后重试${suffix}`
    case 503:
      return `503 服务器繁忙：服务暂时不可用，请稍后重试${suffix}`
    default:
      return `请求失败（${status}）${suffix}`
  }
}

/** 从错误响应体里抽出可读信息；解析不了就截断原文 */
function extractApiMessage(body: string): string {
  if (!body) return ''
  try {
    const j = JSON.parse(body) as { error?: { message?: string }; message?: string }
    return (j.error?.message || j.message || '').slice(0, 160)
  } catch {
    return body.slice(0, 160)
  }
}

/**
 * v1.4.13-pre4 通用 JSON 请求：给 /models 这类非 chat 端点用。
 *
 * 与 aiChat 共用同一套鉴权、超时与错误翻译，避免两处各写一份。
 * @param path 以 / 开头的相对路径，会拼到 baseURL 后
 */
export async function aiFetchJson(config: AiProviderConfig, path: string, timeoutMs = 20000): Promise<unknown> {
  const base = (config.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('未配置 API 地址')
  if (!config.apiKey) throw new Error('未配置 API 密钥')
  const url = base + (path.startsWith('/') ? path : '/' + path)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(describeHttpError(resp.status, body))
    }
    return (await resp.json()) as unknown
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('请求超时')
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiChatOptions {
  messages: AiChatMessage[]
  /** 温度，缺省 0.7 */
  temperature?: number
  /** 超时毫秒，缺省 60 秒（LLM 首字可能很慢） */
  timeoutMs?: number
}

/**
 * 归一化 baseURL：允许用户填 `https://api.deepseek.com` 或带 `/v1` 两种写法。
 * 统一补成 `.../v1/chat/completions`，避免用户漏写路径就报 404。
 */
export function resolveChatUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/.test(trimmed)) return trimmed
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`
  // DeepSeek 的规范 base URL 不带 /v1（https://api.deepseek.com），
  // 其 chat 端点实际在 /chat/completions 而非 /v1/chat/completions。
  if (/^https?:\/\/api\.deepseek\.com$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/**
 * 调一次 chat completions，返回首个 choice 的文本。
 *
 * 错误一律抛出带可读原因的中文 Error（缺配置 / 401 / 404 / 超时 / 网络），
 * 让设置页的「测试连接」能直接展示给人看，而不是抛原始 JSON。
 */
export async function aiChat(config: AiSettings, options: AiChatOptions): Promise<string> {
  /*
   * v1.4.13-pre7 修正：WorkBuddy 分支必须排在 baseUrl/apiKey/model 三项检查之前。
   *
   * 原来的顺序是先检查 OpenAI 兼容配置，于是选了 WorkBuddy 之后仍然要求填
   * API 地址与密钥——「所有调用仍走 API」「没有 API 就无法测试」都是这一处造成的。
   * WorkBuddy 用的是账号凭据，与那三项完全无关，不该被它们拦住。
   */
  if (config.source === 'workbuddy') {
    const wb = platform.workbuddy
    if (!wb) throw new Error('当前环境不支持 WorkBuddy')
    const cred = await wb.savedCredential()
    if (!cred) throw new Error('尚未登录 WorkBuddy，请在「服务预设」里选 WorkBuddy 完成登录')
    const model = config.wbModel || ''
    if (!model) throw new Error('尚未选择 WorkBuddy 模型，请重新打开 WorkBuddy 面板选一个')
    const text = await wb.chat(cred, model, options.messages, options.temperature ?? 0.7)
    recordUsage(
      options.messages.reduce((a, m) => a + m.content.length, 0),
      text.length,
    )
    return text
  }

  const url = resolveChatUrl(config.baseUrl)
  if (!url) throw new Error('未配置 API 地址')
  if (!config.apiKey) throw new Error('未配置 API 密钥')
  if (!config.model) throw new Error('未配置模型名称')

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 60000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
      }),
      signal: controller.signal,
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(describeHttpError(resp.status, body))
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const text = data.choices?.[0]?.message?.content
    if (!text) throw new Error('模型返回内容为空')
    // v1.4.13-pre1 成本可见：记一次调用与估算 token
    recordUsage(
      options.messages.reduce((a, m) => a + m.content.length, 0),
      text.length,
    )
    return text
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络或代理`)
    }
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    clearTimeout(timer)
  }
}

/** 连通性测试：发一条最小请求，验证地址/密钥/模型/代理四件事都通 */
export async function testAiConnection(config: AiSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await aiChat(
      config,
      { messages: [{ role: 'user', content: '回复两个字：可用' }], temperature: 0, timeoutMs: 30000 },
    )
    return { ok: true, message: `连接成功，模型回复：${reply.trim().slice(0, 40)}` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * v1.4.11-pre3 内置 Provider 预设：OpenAI 兼容格式 + DeepSeek（用户指定范围）。
 *
 * v1.4.11-pre5 修正：DeepSeek 官方 base URL 是 `https://api.deepseek.com`（不带 /v1），
 * 官方文档给的另一种写法是 `https://api.deepseek.com/v1`，两者都接受；
 * 这里统一用不带 /v1 的规范形式，由 resolveChatUrl 补全路径。
 */
export const AI_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  // v1.4.13-pre1 扩充国内常见 OpenAI 兼容服务：纯数据表，换服务商不必手填
  { id: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'dashscope', label: '通义千问（阿里）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  // v1.4.13-pre4 WorkBuddy 作为一种预设：选中后弹出面板完成登录/模型选择
  { id: 'workbuddy', label: 'WorkBuddy', baseUrl: '', model: '' },
] as const

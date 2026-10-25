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
import type { AiProviderConfig } from '@/types'

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

export async function getAiConfig(): Promise<AiProviderConfig> {
  const cap = platform.aiConfig
  if (!cap) return { baseUrl: '', model: '', apiKey: '', proxyMode: 'system', proxyUrl: '' }
  return cap.get()
}

export async function saveAiConfig(config: AiProviderConfig): Promise<{ ok: boolean }> {
  const cap = platform.aiConfig
  if (!cap) throw new Error('当前平台不支持 AI 配置')
  return cap.set(config)
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
  return `${trimmed}/v1/chat/completions`
}

/**
 * 调一次 chat completions，返回首个 choice 的文本。
 *
 * 错误一律抛出带可读原因的中文 Error（缺配置 / 401 / 404 / 超时 / 网络），
 * 让设置页的「测试连接」能直接展示给人看，而不是抛原始 JSON。
 */
export async function aiChat(config: AiProviderConfig, options: AiChatOptions): Promise<string> {
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

    if (resp.status === 401 || resp.status === 403) throw new Error('API 密钥无效或无权限（401/403）')
    if (resp.status === 404) throw new Error('接口地址不存在，请检查 API 地址是否含 /v1（404）')
    if (resp.status === 429) throw new Error('请求过于频繁或额度不足（429）')
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`请求失败（${resp.status}）${body ? '：' + body.slice(0, 200) : ''}`)
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const text = data.choices?.[0]?.message?.content
    if (!text) throw new Error('模型返回内容为空')
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
export async function testAiConnection(config: AiProviderConfig): Promise<{ ok: boolean; message: string }> {
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

/** v1.4.11-pre3 内置 Provider 预设：OpenAI 兼容格式 + DeepSeek（用户指定范围） */
export const AI_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
] as const

/**
 * v1.4.13-pre4 模型列表：优先从 Provider 的 /models 接口拉取，失败回落到内置表。
 *
 * 为什么要动态拉：各家的模型名与产品名变动频繁（DeepSeek 已有 flash / pro 等线），
 * 硬编码很快过期。但 /models 不是所有 OpenAI 兼容服务都实现，所以必须有回落。
 *
 * 展示用产品名而非接口名：接口名（如 deepseek-chat）对用户没有意义，
 * 下拉里显示「DeepSeek-V4.1-Flash 1017」这类产品名，选中后内部仍用接口名调用。
 */

import { aiFetchJson } from '@/services/ai'
import type { AiSettings } from '@/types'

export interface ModelOption {
  /** 接口实际使用的模型名 */
  id: string
  /** 展示给用户的产品名 */
  label: string
}

/**
 * 内置回落表：接口不可达时至少能用。
 *
 * v1.4.13-pre4 二次修正：按用户要求，**每个预设带自己的模型列表**，
 * 不再所有预设都摊一份 DeepSeek 的名字；展示一律用产品名（如 Deepseek-V4-Pro），
 * 不暴露接口名。
 */
export const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  'api.deepseek.com': [
    { id: 'deepseek-v4-pro', label: 'Deepseek-V4-Pro' },
    { id: 'deepseek-v4.1-flash', label: 'Deepseek-V4.1-Flash 1017' },
    { id: 'deepseek-flash', label: 'Deepseek-Flash' },
    { id: 'deepseek-pro', label: 'Deepseek-Pro' },
  ],
  'api.openai.com': [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  'api.moonshot.cn': [
    { id: 'kimi-k3', label: 'Kimi-K3' },
    { id: 'kimi-k2.6', label: 'Kimi-K2.6' },
    { id: 'moonshot-v1-8k', label: 'Moonshot v1 8K' },
  ],
  'dashscope.aliyuncs.com': [
    { id: 'qwen-plus', label: 'Qwen-Plus' },
    { id: 'qwen-max', label: 'Qwen-Max' },
  ],
  'open.bigmodel.cn': [
    { id: 'glm-5.3', label: 'GLM-5.3' },
    { id: 'glm-4-flash', label: 'GLM-4-Flash' },
  ],
  'api.siliconflow.cn': [
    { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B-Instruct' },
  ],
}

/** 从 baseURL 里取主机名，用于匹配回落表 */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 把接口模型名转成可读产品名。
 *
 * 规则保守：认得的转，不认得的原样返回——宁可显示接口名，也不要瞎猜一个错产品名。
 */
export function toProductName(id: string): string {
  const known: Record<string, string> = {
    'deepseek-flash': 'DeepSeek Flash',
    'deepseek-pro': 'DeepSeek Pro',
    'deepseek-chat': 'DeepSeek Chat（旧名）',
    'deepseek-reasoner': 'DeepSeek Reasoner（旧名）',
    'gpt-4o-mini': 'GPT-4o mini',
    'gpt-4o': 'GPT-4o',
  }
  if (known[id]) return known[id]
  // 形如 qwen-plus / glm-4-flash：把连字符转空格并首字母大写，至少比原始名好看
  return id
    .split('-')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ')
}

/** 拉取模型列表：成功用接口结果，失败回落到内置表 */
export async function fetchModelOptions(settings: AiSettings): Promise<{ models: ModelOption[]; fromApi: boolean }> {
  const host = hostOf(settings.baseUrl)
  const fallback = FALLBACK_MODELS[host] || []
  if (!settings.baseUrl || !settings.apiKey) return { models: fallback, fromApi: false }
  try {
    const data = await aiFetchJson(settings, '/models')
    const list = (data as { data?: { id?: string }[] })?.data || []
    const models = list
      .map((m) => (m.id ? { id: m.id, label: toProductName(m.id) } : null))
      .filter((m): m is ModelOption => !!m)
    if (!models.length) return { models: fallback, fromApi: false }
    return { models, fromApi: true }
  } catch {
    return { models: fallback, fromApi: false }
  }
}

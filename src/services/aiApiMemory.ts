/**
 * v1.4.13-pre11 API 记忆。
 *
 * 用户的要求很具体：切换预设、输入新地址、切到 WorkBuddy 时**不要清除**原 API，
 * 而是留进记忆，之后能在下拉里切回；只有显式点「清除」才删除。
 *
 * 设计取舍：
 * - 去重按 baseUrl + model，同一条重复保存只更新密钥与时间，不堆副本；
 * - 密钥只存在主进程（经 safeStorage 加密），渲染层拿到的是解密后的值，
 *   与当前配置同级，不再多一条泄露面；
 * - 纯函数，不碰存储，便于测试。
 */

import type { SavedApi } from '@/types'

/** 记忆条数上限：超出后丢弃最久未使用的，避免配置文件无限膨胀 */
export const MAX_SAVED_APIS = 20

/** 生成一个稳定 id（不依赖 crypto，浏览器/Node 都能跑） */
export function makeApiId(): string {
  return 'api_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 从地址里取一个可读的展示名：主机名去掉 www. 前缀 */
export function labelFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./i, '')
    return host || baseUrl
  } catch {
    return baseUrl
  }
}

/**
 * 把当前配置记进记忆。
 *
 * @param list 现有记忆
 * @param entry 要记的配置（需有 baseUrl）
 * @returns 新的记忆列表（新条目排在最前）
 */
export function rememberApi(list: SavedApi[], entry: Omit<SavedApi, 'id'>): SavedApi[] {
  const baseUrl = (entry.baseUrl || '').trim()
  if (!baseUrl) return list
  const model = (entry.model || '').trim()
  const existing = list.find((item) => item.baseUrl === baseUrl && item.model === model)
  const rest = list.filter((item) => item !== existing)
  const next: SavedApi = {
    id: existing?.id || makeApiId(),
    label: (entry.label || '').trim() || labelFromUrl(baseUrl),
    baseUrl,
    model,
    apiKey: entry.apiKey ?? existing?.apiKey ?? '',
    usedAt: entry.usedAt ?? Date.now(),
  }
  return [next, ...rest].slice(0, MAX_SAVED_APIS)
}

/** 显式删除一条记忆（用户点「清除」时才调用） */
export function forgetApi(list: SavedApi[], id: string): SavedApi[] {
  return list.filter((item) => item.id !== id)
}

/** 取最近使用的那条，用于「切回上一次」 */
export function mostRecentApi(list: SavedApi[]): SavedApi | null {
  if (!list.length) return null
  return [...list].sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0))[0]
}

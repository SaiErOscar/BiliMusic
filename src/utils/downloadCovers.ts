/**
 * v1.4.8-pre4 下载记录封面补齐。
 *
 * 旧版下载记录只存了 bvid，没有封面字段，列表里一直是无封面的占位。
 * 这里按 bvid 向 B 站取视频封面（view 接口的 pic），并做两层缓存：
 * 内存 Map 挡住同一次会话内的重复请求，localStorage 挡住跨次启动的重复请求。
 * 失败一律返回空串，调用方保持占位，不阻塞列表渲染。
 */

import { getVideoDetail, toHttpsUrl } from '@/services/bilibiliApi'

const CACHE_KEY = 'bilimusic_bvid_covers'
const MAX_ENTRIES = 300

let memory: Record<string, string> | null = null

function loadCache(): Record<string, string> {
  if (memory) return memory
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    memory = parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    memory = {}
  }
  return memory
}

function saveCache() {
  const cache = loadCache()
  const entries = Object.entries(cache)
  // 只保留最近写入的若干条，避免长期使用后把 localStorage 撑满
  if (entries.length > MAX_ENTRIES) {
    memory = Object.fromEntries(entries.slice(-MAX_ENTRIES))
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(memory))
  } catch { /* 配额不足时放弃持久化，内存缓存仍有效 */ }
}

/** 同一 bvid 的并发请求合并成一次 */
const inflight = new Map<string, Promise<string>>()

/** 取 bvid 对应的视频封面地址（缓存优先）；取不到返回空串 */
export function resolveDownloadCover(bvid: string): Promise<string> {
  if (!bvid) return Promise.resolve('')
  const cached = loadCache()[bvid]
  if (cached) return Promise.resolve(cached)

  const running = inflight.get(bvid)
  if (running) return running

  const task = getVideoDetail(bvid)
    .then((detail) => {
      const url = toHttpsUrl(detail.pic)
      if (url) {
        loadCache()[bvid] = url
        saveCache()
      }
      return url
    })
    .catch(() => '')
    .finally(() => { inflight.delete(bvid) })

  inflight.set(bvid, task)
  return task
}

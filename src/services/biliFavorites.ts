/**
 * Bilibili 收藏夹导入与同步服务
 *
 * 功能：
 * 1. 获取用户收藏夹列表
 * 2. 导入收藏夹内容为本地 Track
 * 3. 双向同步：本地收藏 ↔ B站收藏夹
 */

import { getFavoriteFolders, getAllFavoriteFolderContent, dealFavorite, type FavoriteFolder, type FavoriteItem } from '@/services/bilibiliApi'
import { loadFavoriteTracks, saveFavoriteTracks, loadBiliFolderCache, saveBiliFolderCache } from '@/utils/storage'
import type { Track } from '@/types'
import { toHttpsUrl } from '@/services/bilibiliApi'

function favoriteItemToTrack(item: FavoriteItem): Track {
  return {
    id: item.bvid,
    title: item.title?.replace(/<[^>]+>/g, '') || item.bvid,
    artist: item.upper?.name || '未知UP主',
    coverUrl: toHttpsUrl(item.cover || item.pic),
    duration: item.duration || 0,
    videoUrl: `https://www.bilibili.com/video/${item.bvid}`,
    bvid: item.bvid,
    aid: item.aid || item.id,
    cid: item.cid,
    playCount: item.cnt_info?.play || 0,
    isLiked: true,
    likedAt: item.fav_time ? new Date(item.fav_time * 1000).toISOString() : new Date().toISOString(),
  }
}

export interface BiliSyncResult {
  imported: number
  skipped: number
  total: number
  message: string
}

/**
 * 导入 B站收藏夹到本地收藏
 * @param folderId 收藏夹 ID
 * @param replaceExisting 是否替换已有收藏
 */
export async function importBiliFavorites(folderId: number, replaceExisting = false): Promise<BiliSyncResult> {
  const { title, items } = await getAllFavoriteFolderContent(folderId)
  if (!items.length) {
    return { imported: 0, skipped: 0, total: 0, message: `收藏夹「${title}」为空` }
  }

  const biliTracks = items.map(favoriteItemToTrack)
  const existing = replaceExisting ? [] : loadFavoriteTracks()
  const existingIds = new Set(existing.map(t => t.id))

  const newTracks = biliTracks.filter(t => !existingIds.has(t.id))
  const skipped = biliTracks.length - newTracks.length

  if (replaceExisting) {
    saveFavoriteTracks(biliTracks)
  } else {
    saveFavoriteTracks([...newTracks, ...existing])
  }

  return {
    imported: newTracks.length,
    skipped,
    total: biliTracks.length,
    message: `从「${title}」导入 ${newTracks.length} 首${skipped ? `（跳过 ${skipped} 首已存在）` : ''}`,
  }
}

/**
 * 双向同步：将本地已收藏的收藏夹数据推送到 B站收藏夹，同时拉取 B站全部内容保存到本地缓存。
 * 注意：不写入「我喜欢」（favoriteTracks），而是按收藏夹 ID 保存到本地缓存，供收藏夹页离线回退显示。
 */
export async function syncBiliFavorites(folderId: number): Promise<BiliSyncResult> {
  // 1. 拉取 B站收藏夹全部内容
  const { items } = await getAllFavoriteFolderContent(folderId)
  const biliIds = new Set(items.map(i => i.bvid))

  // 2. 读取该收藏夹的本地缓存（作为本地侧数据）
  const localTracks = loadBiliFolderCache(folderId)

  // 3. 找出本地有但 B站没有的 → 推送到 B站收藏夹
  const toPush = localTracks.filter(t => !biliIds.has(t.id) && t.aid)
  let pushed = 0
  for (const t of toPush) {
    try {
      await dealFavorite(t.aid ? Number(t.aid) : (t.bvid || t.id), [folderId])
      pushed++
    } catch {
      // 单首推送失败不阻塞其余
    }
  }

  // 4. 拉取 B站全部内容 → 保存到本地缓存（覆盖，以 B站为准）
  const biliTracks = items.map(favoriteItemToTrack)
  saveBiliFolderCache(folderId, biliTracks)

  const imported = biliTracks.length
  return {
    imported,
    skipped: 0,
    total: items.length,
    message: `同步完成：更新本地 ${imported} 首，推送 ${pushed} 首到B站`,
  }
}

/**
 * 获取用户收藏夹列表
 */
export async function listBiliFavoriteFolders(): Promise<{ count: number; list: FavoriteFolder[] }> {
  // 从 nav 接口获取 mid
  const { getNavInfo } = await import('@/services/bilibiliApi')
  const nav = await getNavInfo()
  if (!nav.isLogin || !nav.mid) {
    throw new Error('请先登录 Bilibili 账号')
  }
  return getFavoriteFolders(nav.mid)
}

/**
 * 判断指定 bvid 的曲目位于哪些收藏夹（默认勾选用）。
 * 遍历所有收藏夹，每个拉取最新一页（前 50 个）内容进行匹配。
 */
export async function getFoldersContainingBvid(bvid: string): Promise<number[]> {
  try {
    const { list } = await listBiliFavoriteFolders()
    const result: number[] = []
    for (const folder of list) {
      try {
        // 遍历收藏夹全部内容（自动翻页），确保超过单页上限时也能匹配
        const { items } = await getAllFavoriteFolderContent(folder.id)
        if (items.some((m) => m.bvid === bvid)) result.push(folder.id)
      } catch {
        // 单个收藏夹失败不影响其他
      }
    }
    return result
  } catch {
    return []
  }
}

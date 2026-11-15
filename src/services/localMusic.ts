// v1.4.15-pre5 本地音乐：渲染层业务口径（纯函数）
//
// 分工：主进程 electron/localMusic.ts 只做「对话框 + 递归读盘 + 搬字节」，
// 标签解析在 src/services/audioTags.ts（纯字节解析），
// 本模块负责所有需要判断的规则：文件名兜底、去重、排序、失效标记。
// 这样这些规则都能被单测直接覆盖，不必启动 Electron。
import type { Track } from '@/types'
import type { AudioTags } from '@/services/audioTags'

/** 支持扫描的音频扩展名（与主进程 AUDIO_EXTS 保持一致） */
export const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.wav', '.ogg'] as const

/**
 * 本地曲目的稳定 id。
 *
 * 用路径派生而不是随机 UUID：同一个文件重复扫描必须得到同一个 id，
 * 否则每次扫描都会把整个曲库当成新歌，收藏、播放统计全部丢失。
 * 路径本身可能很长，这里做一次轻量哈希压到 16 位十六进制。
 */
export function localTrackId(filePath: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const s = filePath.toLowerCase()
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return 'local_' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** 去掉扩展名的文件名主体 */
export function baseNameWithoutExt(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 文件名里常见的前导序号：01. / 01 - / 01_ / [01] */
const LEADING_INDEX = /^\s*(?:\[?\d{1,3}\]?\s*[-._)\]]\s*|\d{1,3}\s+)/

/**
 * 从文件名猜「歌手 - 标题」。
 *
 * 只在标签读不出来时使用。常见形态：
 *   "周杰伦 - 稻香"            → artist=周杰伦, title=稻香
 *   "01. 周杰伦 - 稻香"        → 先去掉序号
 *   "稻香"                     → 只有 title，artist 留空
 * 分隔符只认「空格-空格」「－」「—」，避免把 "AC-DC" 这类名字劈开。
 */
export function parseFileName(filePath: string): { title: string; artist: string } {
  let base = baseNameWithoutExt(filePath).trim()
  base = base.replace(LEADING_INDEX, '').trim()
  if (!base) return { title: baseNameWithoutExt(filePath), artist: '' }
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(base) || /^(.+?)\s*[－—]\s*(.+)$/.exec(base)
  if (m) {
    const artist = m[1].trim()
    const title = m[2].trim()
    if (artist && title) return { title, artist }
  }
  return { title: base, artist: '' }
}

/**
 * 把「扫描到的文件 + 解析出的标签」合成一条本地曲目。
 *
 * 本地曲目复用 Track 类型（用户拍板）：bvid/videoUrl 留空，localPath 指向真实文件。
 * 播放链路据此判断走 file:// 还是 B 站流（pre6 接线）。
 */
export function buildLocalTrack(
  filePath: string,
  tags: AudioTags | null,
): Track {
  const guessed = parseFileName(filePath)
  const title = tags?.title?.trim() || guessed.title
  const artist = tags?.artist?.trim() || guessed.artist
  return {
    id: localTrackId(filePath),
    title,
    artist,
    coverUrl: '',
    duration: tags?.duration ?? 0,
    videoUrl: '',
    bvid: '',
    playCount: 0,
    isLiked: false,
    localPath: filePath,
    addedAt: new Date().toISOString(),
  }
}

/**
 * 合并扫描结果与已有索引。
 *
 * 三条规则：
 * 1. 同一路径只保留一条（大小写不敏感——Windows 上同一文件可能两种写法）；
 * 2. 已存在的曲目保留原有字段（收藏状态、加入时间等），只更新标题/歌手/时长；
 * 3. 本次没扫到的旧条目**不删除**，标 missing 由用户显式清理（外接盘没插时不能误删）。
 */
export function mergeLocalTracks(existing: Track[], scanned: Track[]): Track[] {
  const byPath = new Map<string, Track>()
  for (const t of existing) {
    if (t.localPath) byPath.set(t.localPath.toLowerCase(), t)
  }
  for (const t of scanned) {
    if (!t.localPath) continue
    const key = t.localPath.toLowerCase()
    const old = byPath.get(key)
    byPath.set(key, old ? { ...old, title: t.title, artist: t.artist, duration: t.duration, localPath: t.localPath } : t)
  }
  return [...byPath.values()]
}

/** 排序：按歌手，再按标题；都用中文排序规则 */
export function sortLocalTracks(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => {
    const byArtist = (a.artist || '').localeCompare(b.artist || '', 'zh-CN')
    if (byArtist !== 0) return byArtist
    return (a.title || '').localeCompare(b.title || '', 'zh-CN')
  })
}

/**
 * 判断一条本地曲目的文件是否还在。
 *
 * 只做判断、不做删除：外接硬盘没插时大量条目「不存在」，
 * 自动删会把用户的曲库清空，必须由用户在界面上显式点清理。
 */
export function isMissing(track: Track, existingPaths: Set<string>): boolean {
  if (!track.localPath) return false
  return !existingPaths.has(track.localPath.toLowerCase())
}

/** 从曲库里挑出文件已丢失的条目（供「一键清理」使用） */
export function pickMissingTracks(tracks: Track[], existingPaths: Set<string>): Track[] {
  return tracks.filter((t) => isMissing(t, existingPaths))
}

/** scanNotice 只关心这几个字段，用结构化最小集而不是引入 electron 类型依赖 */
export interface ScanNoticeInput {
  ok: boolean
  canceled?: boolean
  message?: string
  truncated?: boolean
  truncatedReason?: string
  skipped?: number
  files?: readonly unknown[]
}

/** 扫描结果的说明文案：正常时不返回（null），有情况必须说清 */
export function scanNotice(result: ScanNoticeInput): string | null {
  if (result.canceled) return '已取消扫描'
  if (!result.ok) return result.message || '扫描失败'
  const count = result.files?.length ?? 0
  if (count === 0) return '这个目录里没有找到音频文件'
  if (result.truncated) {
    return '已扫描 ' + count + ' 个文件（' + (result.truncatedReason || '达到上限') + '），可分批导入'
  }
  if (result.skipped && result.skipped > 0) {
    return '已扫描 ' + count + ' 个文件，跳过 ' + result.skipped + ' 个（无权限、超大或层级过深）'
  }
  return null
}

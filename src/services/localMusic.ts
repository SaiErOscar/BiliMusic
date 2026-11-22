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
 * v1.4.16-pre1 把内嵌封面字节转成可显示的 Blob URL。
 *
 * 用 Blob URL 而不是 data URL：封面动辄几十到几百 KB，base64 会再放大 33%，
 * 且 data URL 会随曲目对象一起进 localStorage，把配额撑爆。
 *
 * 注意：调用方负责在曲目被移除/重新扫描时 revoke，否则每张封面泄漏一个 Blob。
 * 目前封面只在内存里（不落 localStorage），刷新页面即全部释放。
 */
export function createCoverUrl(cover: { data: Uint8Array; mime: string }): string {
  try {
    const blob = new Blob([cover.data], { type: cover.mime || 'image/jpeg' })
    return URL.createObjectURL(blob)
  } catch {
    // 非浏览器环境或 Blob 不可用：退回无封面，不影响曲目可用
    return ''
  }
}

/**
 * v1.4.15-pre6 本地音频播放协议。
 *
 * **为什么不是 file://（实测结论，别改回去）**：
 * 渲染层跑在自定义 app:// 标准安全源上，Chromium 直接拒绝 file:// 资源
 * （控制台报 "Not allowed to load local resource"），audio 连元数据都加载不出来。
 * 改由主进程的 lm:// 协议提供文件流后：加载正常、可 seek、
 * createMediaElementSource 成功且 analyser 能拿到真实频谱（均衡器/可视化照常）。
 */
export const LOCAL_AUDIO_SCHEME = 'lm'

/** 把本地绝对路径转成渲染层可播放的 lm:// URL（规则须与主进程 toLocalAudioUrl 一致） */
export function toLocalAudioUrl(filePath: string): string {
  return LOCAL_AUDIO_SCHEME + '://local/' + encodeURIComponent(filePath)
}

/** 该 URL 是否为本应用的本地音频 URL */
export function isLocalAudioUrl(url: string): boolean {
  return !!url && url.startsWith(LOCAL_AUDIO_SCHEME + '://local/')
}

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
  /** 可选：把内嵌封面字节转成可显示的 URL（渲染层传 Blob URL 工厂，测试可传桩） */
  coverUrlFactory?: (cover: { data: Uint8Array; mime: string }) => string,
  /** v1.4.16-pre2 文件指纹，供下次扫描做增量判断 */
  fileMeta?: { mtime: string; size: number },
): Track {
  const guessed = parseFileName(filePath)
  const title = tags?.title?.trim() || guessed.title
  const artist = tags?.artist?.trim() || guessed.artist
  // v1.4.16-pre1 内嵌封面：有就转 URL，没有留空走占位图。
  // 不在本模块直接造 Blob——本模块要能在 Node 测试环境跑，没有 URL.createObjectURL。
  const coverUrl = tags?.cover && coverUrlFactory ? coverUrlFactory(tags.cover) : ''
  return {
    id: localTrackId(filePath),
    title,
    artist,
    coverUrl,
    duration: tags?.duration ?? 0,
    videoUrl: '',
    bvid: '',
    playCount: 0,
    isLiked: false,
    localPath: filePath,
    addedAt: new Date().toISOString(),
    ...(fileMeta ? { localMtime: fileMeta.mtime, localSize: fileMeta.size } : {}),
  }
}

/**
 * v1.4.16-pre2 判断一个已索引的曲目是否需要重新读标签。
 *
 * 文件没变（mtime 与 size 都一致）就跳过——这是增量扫描的核心。
 * 缺字段的旧索引一律视为「需要重读」，保证升级后第一次扫描会把指纹补齐。
 */
export function needsRescan(
  existing: Track | undefined,
  fileMeta: { mtime: string; size: number },
): boolean {
  if (!existing) return true
  if (!existing.localMtime || existing.localSize === undefined) return true
  return existing.localMtime !== fileMeta.mtime || existing.localSize !== fileMeta.size
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

/** v1.4.16-pre1 本地曲库排序方式 */
export type LocalSortMode = 'artist' | 'title' | 'added' | 'duration'

/** 排序标签，供界面下拉使用 */
export const LOCAL_SORT_LABELS: Record<LocalSortMode, string> = {
  artist: '按歌手',
  title: '按标题',
  added: '按加入时间',
  duration: '按时长',
}

/**
 * v1.4.16-pre1 按指定方式排序。
 *
 * 与 sortLocalTracks（固定「歌手 → 标题」）并存：后者是默认口径，
 * 这里给用户显式选择。两者都不修改原数组。
 */
export function sortLocalTracksBy(tracks: Track[], mode: LocalSortMode): Track[] {
  const list = [...tracks]
  switch (mode) {
    case 'title':
      return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-CN'))
    case 'added':
      // 新加的在前；没有 addedAt 的排最后（旧索引可能缺这个字段）
      return list.sort((a, b) => {
        const ta = a.addedAt ? Date.parse(a.addedAt) : 0
        const tb = b.addedAt ? Date.parse(b.addedAt) : 0
        return tb - ta
      })
    case 'duration':
      return list.sort((a, b) => (b.duration || 0) - (a.duration || 0))
    case 'artist':
    default:
      return sortLocalTracks(list)
  }
}

/**
 * v1.4.16-pre1 按关键词过滤本地曲目。
 *
 * 同时匹配标题与歌手，大小写不敏感；空关键词返回全部（返回原数组引用，
 * 调用方可据此跳过重复计算）。
 */
export function filterLocalTracks(tracks: Track[], query: string): Track[] {
  const q = query.trim().toLowerCase()
  if (!q) return tracks
  return tracks.filter((t) =>
    (t.title || '').toLowerCase().includes(q) || (t.artist || '').toLowerCase().includes(q),
  )
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

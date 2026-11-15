// v1.4.15 歌单 M3U/M3U8 导出与导入（纯函数，不碰文件系统）
//
// 分层与 src/utils/backup.ts 一致：主进程只负责「另存为 / 打开」对话框与读写文本
// （electron/playlistFile.ts），M3U 的生成与解析都在渲染层，便于单测与跨端复用。
//
// 格式（标准 M3U8，UTF-8）：
//   #EXTM3U
//   #EXTINF:213,歌手 - 标题
//   https://www.bilibili.com/video/BV1xx411c7mD
//   （空行）
// 播放地址统一用 Track.videoUrl（B 站视频页），导入时从地址里取回 bvid。

import type { Playlist, Track } from '@/types'
import { baseNameWithoutExt, localTrackId } from '@/services/localMusic'

/** 解析出来的一条播放地址记录 */
export interface ParsedM3uEntry {
  /** 本条播放地址（原样，未归一化） */
  url: string
  /** 从地址里提取到的 bvid；提取不到为 undefined */
  bvid?: string
  /** #EXTINF 的标题（通常为「歌手 - 标题」），缺失时为 undefined */
  title?: string
  /** #EXTINF 的歌手（仅当标题按「 - 」拆分成功时才有） */
  artist?: string
  /** #EXTINF 的时长（秒）；缺失或非数字时为 undefined */
  duration?: number
}

export interface ParsedM3u {
  /** #PLAYLIST: 声明的歌单名，缺失时为空串 */
  name: string
  entries: ParsedM3uEntry[]
  /** 既不是空行/注释、也不是可识别播放地址而丢弃的行数 */
  skipped: number
}

const BVID_RE = /\/video\/(BV[0-9A-Za-z]+)/i

/**
 * 从播放地址里提取 bvid。
 * 支持 https://www.bilibili.com/video/BV1xx411c7mD 与带 ?p=2 / #reply 的变体；
 * 也接受直接写成 BV 号的行。提取不到返回 undefined。
 */
export function extractBvid(url: string): string | undefined {
  const raw = String(url ?? '').trim()
  if (!raw) return undefined
  const hit = BVID_RE.exec(raw)
  if (hit) return hit[1]
  // 裸 BV 号（没有站点前缀的 M3U 很常见）
  const bare = /^(BV[0-9A-Za-z]+)$/.exec(raw)
  return bare ? bare[1] : undefined
}

/** 该行是否是我们能认的播放地址（绝对 URL、协议相对、裸 BV 号或本地文件路径） */
function isAddressLine(line: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ||
    line.startsWith('//') ||
    /^BV[0-9A-Za-z]+$/.test(line) ||
    isLocalFilePathLine(line)
  )
}

/** 本地音频文件的扩展名（与 src/services/localMusic.ts 的 AUDIO_EXTS 一致） */
const LOCAL_AUDIO_EXT = /\.(mp3|flac|m4a|wav|ogg)$/i

/**
 * v1.4.15-pre6：该行是否指向一个本地音频文件。
 *
 * M3U 里本地路径有三种常见写法：
 *   file:///C:/Music/a.mp3   （标准 file URL，最规范）
 *   C:\Music\a.mp3          （Windows 裸路径）
 *   /home/u/Music/a.mp3      （POSIX 裸路径）
 * 只认扩展名是音频的行，避免把任意裸字符串当成路径。
 */
export function isLocalFilePathLine(line: string): boolean {
  const raw = String(line ?? '').trim()
  if (!raw) return false
  if (/^file:\/\//i.test(raw)) {
    // file URL 还要看解码后的扩展名（中文/空格会被百分号编码）
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // 编码坏了就按原样判断
    }
    return LOCAL_AUDIO_EXT.test(decoded)
  }
  // 裸 Windows 路径（C:\...）或 POSIX 绝对路径（/...），且扩展名是音频
  const looksLikePath = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')
  return looksLikePath && LOCAL_AUDIO_EXT.test(raw)
}

/**
 * 从本地路径行里取出绝对路径。
 * file:///C:/a.mp3 -> C:/a.mp3；file:///home/u/a.mp3 -> /home/u/a.mp3；
 * 裸路径原样返回。取不出来返回 null。
 */
export function localPathFromLine(line: string): string | null {
  const raw = String(line ?? '').trim()
  if (!raw || !isLocalFilePathLine(raw)) return null
  if (/^file:\/\//i.test(raw)) {
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return null
    }
    // 去掉 file:// 前缀：file:///C:/a.mp3 -> /C:/a.mp3，再判断是不是盘符
    let rest = decoded.replace(/^file:\/\//i, '')
    if (/^\/[a-zA-Z]:[\\/]/.test(rest)) rest = rest.slice(1)
    return rest || null
  }
  return raw
}

/** #EXTINF:<秒数>,<标题> —— 时长缺失或非数字时按 0 处理并保留标题 */
function parseExtInf(line: string): { duration?: number; title?: string } {
  const rest = line.slice('#EXTINF:'.length)
  const comma = rest.indexOf(',')
  // 没有逗号：整段就是时长（可能缺失），标题为空
  const durText = (comma >= 0 ? rest.slice(0, comma) : rest).trim()
  const title = comma >= 0 ? rest.slice(comma + 1).trim() : ''
  const duration = durText && /^\d+(\.\d+)?$/.test(durText) ? Number(durText) : undefined
  return { duration, title: title || undefined }
}

/** 「歌手 - 标题」拆分；拆不出歌手时整串当标题 */
function splitTitleArtist(title: string): { title: string; artist?: string } {
  const sep = title.indexOf(' - ')
  if (sep <= 0) return { title }
  return { title: title.slice(sep + 3).trim(), artist: title.slice(0, sep).trim() || undefined }
}

/**
 * 解析 M3U/M3U8 文本。
 *
 * 必须容忍真实世界的脏文件：CRLF 与 LF 混用、#EXTM3U 头、注释行、空行、
 * 没有 #EXTINF 的裸地址行、#EXTINF 时长缺失或非数字。
 * 不认识的行只计数（skipped），不让整个导入失败。
 */
export function parseM3u(text: string): ParsedM3u {
  const entries: ParsedM3uEntry[] = []
  let name = ''
  let skipped = 0
  let pending: { duration?: number; title?: string } | null = null

  // 统一换行，顺带吃掉 BOM（Windows 记事本导出的文件常带）
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('#')) {
      const upper = line.toUpperCase()
      if (upper.startsWith('#EXTINF')) {
        pending = parseExtInf(line)
      } else if (upper.startsWith('#PLAYLIST:')) {
        name = line.slice('#PLAYLIST:'.length).trim()
      }
      // #EXTM3U 及其它注释行（#EXT-X-*、# 备注）直接跳过，不影响后续地址行
      continue
    }

    if (!isAddressLine(line)) {
      skipped += 1
      continue
    }

    const bvid = extractBvid(line)
    const entry: ParsedM3uEntry = { url: line, bvid }
    if (pending) {
      entry.duration = pending.duration
      if (pending.title) {
        const split = splitTitleArtist(pending.title)
        entry.title = split.title
        entry.artist = split.artist
      }
      pending = null
    }
    entries.push(entry)
  }

  return { name, entries, skipped }
}

/** 秒数取整；非有限数按 0 处理（M3U 的 #EXTINF 时长是整数秒） */
function toWholeSeconds(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** 标题里不允许出现换行，否则会把 #EXTINF 行撑破成两行 */
function oneLine(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 生成标准 M3U8 文本。
 * 首行 #EXTM3U，#PLAYLIST: 带上歌单名（部分播放器用它做列表名），
 * 每首三行：#EXTINF:<秒数>,<歌手> - <标题> + 播放地址 + 空行。
 */
export function buildM3u(playlist: Playlist): string {
  const lines: string[] = ['#EXTM3U']
  const name = oneLine(playlist?.name)
  if (name) lines.push(`#PLAYLIST:${name}`)

  for (const track of playlist?.tracks ?? []) {
    const artist = oneLine(track?.artist)
    const title = oneLine(track?.title) || track?.bvid || '未知曲目'
    const label = artist && artist !== '未知歌手' ? `${artist} - ${title}` : title
    // 播放地址：优先 B 站视频页；老数据可能只有 bvid，用它拼出规范地址
    const url = oneLine(track?.videoUrl) || (track?.bvid ? `https://www.bilibili.com/video/${track.bvid}` : '')
    if (!url) continue
    lines.push(`#EXTINF:${toWholeSeconds(track?.duration)},${label}`)
    lines.push(url)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 一条解析结果 -> Track 骨架。
 *
 * 只做文件往返能确定的事：id 用 bvid（取不到用地址兜底），标题/歌手来自 EXTINF，
 * 缺则用地址。**不在这里发网络请求补全元数据**——封面、时长、播放量都要靠后续
 * 的稿件信息接口补齐，那是导入之后的事。
 */
export function entryToTrack(entry: ParsedM3uEntry): Track {
  const bvid = entry.bvid || ''
  const url = entry.url || (bvid ? `https://www.bilibili.com/video/${bvid}` : '')

  // v1.4.15-pre6：本地文件路径条目转成本地曲目，可直接播放。
  // 用与「本地音乐」页同一个 id 派生规则，两个入口扫到同一个文件时是同一条曲目。
  const localPath = bvid ? null : localPathFromLine(url)
  if (localPath) {
    return {
      id: localTrackId(localPath),
      title: entry.title || baseNameWithoutExt(localPath),
      artist: entry.artist || '',
      coverUrl: '',
      duration: toWholeSeconds(entry.duration),
      videoUrl: '',
      bvid: '',
      playCount: 0,
      isLiked: false,
      localPath,
      addedAt: new Date().toISOString(),
    }
  }

  return {
    id: bvid || url,
    title: entry.title || bvid || url,
    artist: entry.artist || '',
    coverUrl: '',
    duration: toWholeSeconds(entry.duration),
    videoUrl: url,
    bvid,
    playCount: 0,
    isLiked: false,
    addedAt: new Date().toISOString(),
  }
}

/**
 * 导入结果：新歌单名 + 曲目骨架 + 可读的跳过统计。
 * 名字优先级：#PLAYLIST: > 文件名（去扩展名）> 「导入的歌单」。
 */
export function buildImportedPlaylist(
  parsed: ParsedM3u,
  fileName?: string,
): { name: string; tracks: Track[]; imported: number; skipped: number } {
  const fromFile = String(fileName ?? '')
    // 既接受纯文件名，也接受完整路径：先取末段，再去扩展名
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '')
    .trim()
  const name = parsed.name.trim() || fromFile || '导入的歌单'
  const tracks = parsed.entries.map(entryToTrack)
  return { name, tracks, imported: tracks.length, skipped: parsed.skipped }
}

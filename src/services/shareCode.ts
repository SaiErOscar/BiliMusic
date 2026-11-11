// v1.4.15 分享二维码（纯函数，不碰 DOM / 不碰二维码库）
//
// 分层：本模块只负责「该分享什么文本」与「装不装得下」两件事。
// QRCode.toDataURL 的调用在组件里（与 LoginDialog.tsx:86 的既有用法一致），
// 这样容量判定、截断告知、文本转义都能被单测直接覆盖，不必在 jsdom 里画图。
//
// 容量口径（用户拍板，见 docs/v1.4.15-剩余规划.md 三·A）：
// - 单曲 → 直接放该曲的 B 站视频地址；
// - 歌单 → 纯文本清单（每首一行「标题 - 地址」）；
// - 装不下时**绝不静默截断**，必须回传 dropped 让界面说清「已放前 N 首」。

import type { Playlist, Track } from '@/types'

/**
 * 二维码容量上限（字节，UTF-8）。
 *
 * 取 1273：这是二维码版本 40、纠错等级 M 下字节模式的理论上限。
 * 不取纠错 L 的 2953——低纠错在手机摄像头、屏幕反光、缩放下的识别率明显更差，
 * 分享二维码是「扫一次就要成」的场景，宁可少放几首也要扫得出来。
 * 留 40 字节余量给不同编码器的实现差异，实际可写 SHARE_QR_MAX_BYTES。
 */
export const SHARE_QR_HARD_LIMIT = 1273
/** 实际可用字节数（硬上限减掉编码器差异余量） */
export const SHARE_QR_MAX_BYTES = SHARE_QR_HARD_LIMIT - 40

/** 分享文本的一行：一首歌 */
export interface ShareLine {
  title: string
  artist: string
  /** 该曲可分享的地址；B 站曲目为视频页地址，本地曲目为空串 */
  url: string
}

/** 单曲分享结果 */
export interface TrackSharePayload {
  kind: 'track'
  /** 二维码里放的内容 */
  payload: string
  /** 给人看的完整分享文本（复制按钮用，比二维码内容更完整） */
  text: string
  /** 该曲是否有可分享的地址 */
  shareable: boolean
}

/** 歌单分享结果 */
export interface PlaylistSharePayload {
  kind: 'playlist'
  /** 二维码里放的内容（可能是截断后的清单） */
  payload: string
  /** 给人看的完整分享文本（始终是全部曲目，不截断） */
  text: string
  /** 清单里一共多少首可分享曲目 */
  total: number
  /** 实际放进二维码的曲目数 */
  included: number
  /** 因容量被挡在二维码外的曲目数；> 0 时界面必须显式告知 */
  dropped: number
}

export type SharePayload = TrackSharePayload | PlaylistSharePayload

/** UTF-8 字节数（二维码按字节算容量，不能按字符数算） */
export function utf8Bytes(text: string): number {
  if (!text) return 0
  // 不依赖 TextEncoder：鸿蒙/旧 WebView 环境不一定有，且这里只是数长度
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 该文本能否装进一个二维码 */
export function fitsInQr(text: string): boolean {
  return utf8Bytes(text) <= SHARE_QR_MAX_BYTES
}

/**
 * 曲目是否可分享。
 *
 * 本地曲目（pre5 起的 localPath）没有可被别人打开的地址，二维码里放本地路径
 * 对扫码的人毫无意义，按不可分享处理，界面要说清原因而不是给个扫了没用的码。
 */
export function isShareableTrack(track: Track): boolean {
  if (track.localPath) return false
  const url = (track.videoUrl || '').trim()
  if (!url) return false
  // 只认 http(s)：file:// 之类的地址别人打不开
  return /^https?:\/\//i.test(url)
}

/**
 * 把可能含换行/制表符的字段压成一行。
 *
 * 清单的结构约定是「一首 = 标题行 + 地址行」，标题里混进换行会让一首歌散成多行，
 * 扫码的人看到的就是错位的清单。B 站标题与 ID3 标签都可能带换行，必须在拼行前压平。
 */
function oneLine(value: string): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 单行清单文本：有歌手时「歌手 - 标题」，没有就只写标题 */
function lineText(line: ShareLine): string {
  const artist = oneLine(line.artist)
  const title = oneLine(line.title)
  return artist ? artist + ' - ' + title : title
}

/** 分享文本里的一行：标题行 + 地址行（没有地址时只留标题行） */
function renderEntry(line: ShareLine): string {
  const url = line.url.trim()
  return url ? lineText(line) + '\n' + url : lineText(line)
}

/**
 * 单曲分享。
 *
 * 二维码只放地址——手机扫码直接跳到 B 站，比放一段「歌手 - 标题 + 地址」
 * 多出来的标题更实用（标题扫码的人打开页面就看得到）。
 * 复制文本才带标题，方便贴到聊天窗口里。
 */
export function buildTrackShare(track: Track): TrackSharePayload {
  const text = renderEntry({
    title: track.title,
    artist: track.artist,
    url: track.videoUrl,
  })
  const shareable = isShareableTrack(track)
  return {
    kind: 'track',
    payload: shareable ? track.videoUrl.trim() : '',
    text,
    shareable,
  }
}

/**
 * 歌单分享。
 *
 * 完整文本始终包含全部曲目（复制用）；二维码内容按容量从前往后装，
 * 装不下的计入 dropped 由界面显式告知。**绝不静默截断。**
 *
 * 不可分享的曲目（本地曲目、空地址）不进清单，但也不计入 dropped——
 * dropped 只表示「因为容量没放进去」，把两类混在一起会让提示自相矛盾。
 */
export function buildPlaylistShare(playlist: Playlist): PlaylistSharePayload {
  const shareable = playlist.tracks.filter(isShareableTrack)
  const lines: ShareLine[] = shareable.map(t => ({
    title: t.title,
    artist: t.artist,
    url: t.videoUrl,
  }))

  const header = playlist.name.trim() || '未命名歌单'
  const fullText = [header, ...lines.map(renderEntry)].join('\n')

  // 逐首累加，装不下就停：这样 included 一定是「真正放进去的连续前缀」
  let payload = header
  let included = 0
  for (const line of lines) {
    const next = payload + '\n' + renderEntry(line)
    if (!fitsInQr(next)) break
    payload = next
    included += 1
  }

  return {
    kind: 'playlist',
    payload,
    text: fullText,
    total: lines.length,
    included,
    dropped: lines.length - included,
  }
}

/** 按类型分派：歌单走清单，单曲走地址 */
export function buildShare(playlist: Playlist): PlaylistSharePayload
export function buildShare(track: Track): TrackSharePayload
export function buildShare(input: Playlist | Track): SharePayload {
  return 'tracks' in input ? buildPlaylistShare(input) : buildTrackShare(input)
}

/**
 * 给界面的提示文案。
 *
 * 截断、无曲目、全部不可分享三种情况必须说清，返回 null 表示正常无需提示。
 * 放在这里而不是组件里，是为了让「绝不静默截断」这条口径只有一处实现。
 */
export function shareNotice(result: SharePayload): string | null {
  if (result.kind === 'track') {
    return result.shareable ? null : '这首没有可分享的 B 站地址（本地音乐或链接缺失），复制文本仍可用'
  }
  if (result.total === 0) return '这个歌单里没有可分享的 B 站曲目'
  if (result.dropped > 0) {
    return '二维码容量有限，已放前 ' + result.included + ' 首（共 ' + result.total + ' 首），其余请用复制文本分享'
  }
  return null
}

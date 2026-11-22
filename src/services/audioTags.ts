// v1.4.15-pre5 本地音乐元数据解析（纯函数，只读字节，不碰文件系统）
//
// 为什么自己写而不用现成库：
// - 项目里没有任何元数据依赖，也没有 ffprobe（ffmpeg-static 只带 ffmpeg.exe）；
// - ffmpeg 读标签实测每首约 92ms 且要起一个进程，500 首串行就是 46 秒；
// - 这里只解析文件头部几十到几百字节，常见曲库整批解析通常在 1 秒内。
//
// 分工（用户拍板「纯 JS 解析为主 + ffmpeg 兜底」）：
// - 本模块覆盖 ID3v2 / ID3v1 / FLAC Vorbis Comment / MP4(iTunes) 四种最常见形态；
// - 解析不出来（如无标签的裸 WAV、异常容器）由主进程调 ffmpeg 兜底，见 electron/localMusic.ts。
//
// 所有函数都只接受 Uint8Array，不读盘、不抛异常：脏数据一律返回 null，
// 让上层走「退回文件名」而不是让整次扫描中断。

/** 解析出的元数据；字段缺失表示该标签里没有这一项 */
export interface AudioTags {
  title?: string
  artist?: string
  album?: string
  /** 时长（秒）；只有容器头里能算出总时长时才有（FLAC/MP4），MP3 一般拿不到 */
  duration?: number
  /** 命中的标签格式，便于排查「为什么这首没标签」 */
  source: 'id3v2' | 'id3v1' | 'flac' | 'mp4' | 'none'
  /**
   * v1.4.16-pre1 内嵌封面：原始图片字节。
   *
   * 三种格式的存放位置各不相同：
   * - MP3：ID3v2 的 APIC 帧（v2.2 叫 PIC）
   * - FLAC：PICTURE 元数据块（type=6）
   * - M4A：moov/udta/meta/ilst 下的 covr atom
   * 这里只取出字节与 MIME，不在这里生成 Blob URL——
   * 那是渲染层的事（主进程解析出的对象要能跨进程传，Blob 不行）。
   */
  cover?: { data: Uint8Array; mime: string }
}

/** 读取文件头部时建议读多少字节：ID3v2 帧与 MP4 moov 一般都在这个范围内 */
export const HEAD_BYTES = 256 * 1024
/** ID3v1 固定在文件最后 128 字节 */
export const ID3V1_BYTES = 128

function isAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** 去掉 NUL 与首尾空白：ID3 的定长字段用 0 填充，直接转字符串会带一串 \u0000 */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/\u0000+$/g, '').trim()
  return trimmed
}

/**
 * 按 ID3 的编码字节解码文本。
 * 0=ISO-8859-1，1=UTF-16(带 BOM)，2=UTF-16BE，3=UTF-8。
 * 解不出来返回空串，由调用方决定是否退回文件名。
 */
export function decodeText(bytes: Uint8Array, encoding: number): string {
  try {
    if (encoding === 0) {
      // ISO-8859-1：逐字节映射，不能用 UTF-8 解（中文标签在这条分支里本来就是乱码，属格式限制）
      let out = ''
      for (const b of bytes) out += String.fromCharCode(b)
      return clean(out)
    }
    if (encoding === 3) {
      return clean(new TextDecoder('utf-8').decode(bytes))
    }
    if (encoding === 1 || encoding === 2) {
      // UTF-16：encoding=1 时前两字节是 BOM，encoding=2 时是固定大端
      let little = false
      let start = 0
      if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
          little = true
          start = 2
        } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
          little = false
          start = 2
        } else {
          // 没有 BOM：encoding=1 按规范应视为 UTF-16LE，encoding=2 为 BE
          little = encoding === 1
        }
      }
      let out = ''
      for (let i = start; i + 1 < bytes.length; i += 2) {
        const code = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]
        if (code === 0) break
        out += String.fromCharCode(code)
      }
      return clean(out)
    }
  } catch {
    // TextDecoder 不可用或数据损坏：当作没解出来
  }
  return ''
}

/**
 * 按文件头魔数猜图片 MIME。
 *
 * 标签里声明的 MIME 经常是错的（或干脆为空），以实际字节为准更可靠。
 * 认不出来时退回 image/jpeg——封面绝大多数是 JPEG，且浏览器对错误 MIME
 * 的图片仍会尝试解码，不会白屏。
 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && isAscii(bytes, 0, 'GIF8')) return 'image/gif'
  if (bytes.length >= 12 && isAscii(bytes, 0, 'RIFF') && isAscii(bytes, 8, 'WEBP')) return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return 'image/jpeg'
}

/** 同步安全整数（ID3v2 的 size 字段每字节只用低 7 位） */
function syncSafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  )
}

function be32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function le32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

/** 文本类字段：只有这三个能从标签里读，duration/source 不算 */
type TextField = 'title' | 'artist' | 'album'

/** ID3v2 里我们关心的帧 → 字段 */
const ID3_FRAMES: Record<string, TextField> = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TALB: 'album',
  TAL: 'album',
}

/**
 * 解析 ID3v2 的 APIC / PIC 帧体，取出图片字节。
 *
 * 帧体结构：编码(1) + MIME(以 0 结尾，v2.2 是 3 字符图片格式) + 图片类型(1) + 描述(以 0 结尾) + 图片数据。
 * 描述字段的终止符宽度随编码变化（UTF-16 是 2 字节），跳过时必须按编码判断，
 * 否则描述为中文时会从图片数据中间开始读，得到一堆乱码。
 */
function parseApicFrame(body: Uint8Array, isV22: boolean): { data: Uint8Array; mime: string } | null {
  const encoding = body[0]
  let p = 1

  let mime = ''
  if (isV22) {
    // v2.2 的 PIC 用 3 字符图片格式（JPG/PNG），不是 MIME
    if (p + 3 > body.length) return null
    const fmt = String.fromCharCode(body[p], body[p + 1], body[p + 2]).toUpperCase()
    mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg'
    p += 3
  } else {
    // MIME 是 ISO-8859-1 的 0 结尾串
    const start = p
    while (p < body.length && body[p] !== 0) p++
    if (p >= body.length) return null
    let raw = ''
    for (let i = start; i < p; i++) raw += String.fromCharCode(body[i])
    mime = raw.toLowerCase()
    p += 1
  }

  // 图片类型（1 字节），随后是描述
  if (p >= body.length) return null
  p += 1

  // 描述终止符：UTF-16（encoding 1/2）是 2 字节 0，其余是 1 字节
  if (encoding === 1 || encoding === 2) {
    while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2
    p += 2
  } else {
    while (p < body.length && body[p] !== 0) p++
    p += 1
  }

  if (p >= body.length) return null
  const data = body.subarray(p)
  if (data.length < 32) return null
  // 声明的 MIME 常不可靠，以实际字节为准
  return { data, mime: sniffImageMime(data) || mime }
}

/**
 * 解析 ID3v2（mp3 开头）。
 *
 * 支持 v2.2（3 字符帧 ID + 3 字节长度）、v2.3（4 字符 + 普通 4 字节长度）、
 * v2.4（4 字符 + 同步安全 4 字节长度）。三种在真实曲库里都还在用。
 */
export function parseId3v2(bytes: Uint8Array): AudioTags | null {
  if (bytes.length < 10 || !isAscii(bytes, 0, 'ID3')) return null
  const major = bytes[3]
  if (major < 2 || major > 4) return null
  const tagSize = syncSafe(bytes, 6)
  const end = Math.min(bytes.length, 10 + tagSize)
  const tags: AudioTags = { source: 'id3v2' }

  let pos = 10
  // v2.2 的帧头是 6 字节，v2.3/v2.4 是 10 字节
  const headerLen = major === 2 ? 6 : 10
  while (pos + headerLen <= end) {
    // 帧区结束：后面全是 0 填充
    if (bytes[pos] === 0) break
    const id = major === 2
      ? String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2])
      : String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
    let size: number
    if (major === 2) {
      size = (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5]
    } else if (major === 4) {
      size = syncSafe(bytes, pos + 4)
    } else {
      size = be32(bytes, pos + 4)
    }
    if (size <= 0 || pos + headerLen + size > end) break

    const body = bytes.subarray(pos + headerLen, pos + headerLen + size)

    // v1.4.16-pre1 封面帧：APIC（v2.3/v2.4）与 PIC（v2.2）
    if ((id === 'APIC' || id === 'PIC') && body.length > 4 && !tags.cover) {
      const cover = parseApicFrame(body, id === 'PIC')
      if (cover) tags.cover = cover
    }

    const field = ID3_FRAMES[id]
    if (field) {
      if (body.length > 1) {
        const value = decodeText(body.subarray(1), body[0])
        // 同一字段出现多次时保留第一次：后面多半是翻译/备选版本
        if (value && !tags[field]) tags[field] = value
      }
    }
    pos += headerLen + size
  }

  // v1.4.16-pre1：只有封面、没有文字标签的曲目也必须返回结果，
  // 否则「有封面的纯音乐」会被整条丢弃（测试构造的正是这种情况）。
  return tags.title || tags.artist || tags.album || tags.cover ? tags : null
}

/**
 * 解析 ID3v1（文件最后 128 字节）。
 *
 * 这是 1996 年的老格式，定长字段、GBK 中文会被当成 Latin-1 显示成乱码，
 * 所以只在 ID3v2 完全没有结果时才用它兜底。
 */
export function parseId3v1(tail: Uint8Array): AudioTags | null {
  if (tail.length < ID3V1_BYTES) return null
  const base = tail.length - ID3V1_BYTES
  if (!isAscii(tail, base, 'TAG')) return null
  const read = (offset: number, len: number): string => {
    let out = ''
    for (let i = 0; i < len; i++) {
      const b = tail[base + offset + i]
      if (b === 0) break
      out += String.fromCharCode(b)
    }
    return clean(out)
  }
  const tags: AudioTags = { source: 'id3v1' }
  const title = read(3, 30)
  const artist = read(33, 30)
  const album = read(63, 30)
  if (title) tags.title = title
  if (artist) tags.artist = artist
  if (album) tags.album = album
  return tags.title || tags.artist || tags.album ? tags : null
}

/**
 * 解析 FLAC：STREAMINFO 提供时长，VORBIS_COMMENT 提供标签。
 *
 * 元数据块顺序不固定，但 STREAMINFO 必须在第一个；这里仍按块链走，不假设位置。
 */
export function parseFlac(bytes: Uint8Array): AudioTags | null {
  if (bytes.length < 4 || !isAscii(bytes, 0, 'fLaC')) return null
  const tags: AudioTags = { source: 'flac' }
  let pos = 4
  let sampleRate = 0
  let totalSamples = 0

  while (pos + 4 <= bytes.length) {
    const header = bytes[pos]
    const isLast = (header & 0x80) !== 0
    const type = header & 0x7f
    const len = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]
    const body = pos + 4
    if (body + len > bytes.length) break

    if (type === 0 && len >= 18) {
      // STREAMINFO：8 字节块/帧大小之后是 8 字节打包字段
      const d = bytes.subarray(body, body + len)
      sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4)
      // totalSamples 是 36 位：d[13] 低 4 位 + 后 4 字节
      totalSamples = (d[13] & 0x0f) * 0x100000000 + be32(d, 14)
    } else if (type === 6 && !tags.cover) {
      // v1.4.16-pre1 PICTURE 块：type(4) + MIME长度(4,BE) + MIME + 描述长度(4,BE) + 描述
      //                    + 宽(4) + 高(4) + 色深(4) + 索引色数(4) + 数据长度(4) + 数据
      const d = bytes.subarray(body, body + len)
      let p = 4 // 跳过图片类型
      if (p + 4 > d.length) break
      const mimeLen = be32(d, p)
      p += 4
      if (p + mimeLen + 4 > d.length) break
      let mime = ''
      for (let i = 0; i < mimeLen; i++) mime += String.fromCharCode(d[p + i])
      p += mimeLen
      const descLen = be32(d, p)
      p += 4 + descLen
      p += 16 // 宽高色深索引色各 4 字节
      if (p + 4 > d.length) break
      const dataLen = be32(d, p)
      p += 4
      if (dataLen <= 0 || p + dataLen > d.length) break
      const data = d.subarray(p, p + dataLen)
      if (data.length >= 32) tags.cover = { data, mime: sniffImageMime(data) || mime.toLowerCase() }
    } else if (type === 4) {
      // VORBIS_COMMENT：厂商长度(LE32) + 厂商 + 条目数(LE32) + 每条(长度 + "KEY=value")
      const d = bytes.subarray(body, body + len)
      let p = 0
      if (p + 4 > d.length) break
      const vendorLen = le32(d, p)
      p += 4 + vendorLen
      if (p + 4 > d.length) break
      const count = le32(d, p)
      p += 4
      for (let i = 0; i < count && p + 4 <= d.length; i++) {
        const itemLen = le32(d, p)
        p += 4
        if (p + itemLen > d.length) break
        const item = new TextDecoder('utf-8').decode(d.subarray(p, p + itemLen))
        p += itemLen
        const eq = item.indexOf('=')
        if (eq <= 0) continue
        const key = item.slice(0, eq).toUpperCase()
        const value = clean(item.slice(eq + 1))
        if (!value) continue
        if (key === 'TITLE' && !tags.title) tags.title = value
        else if (key === 'ARTIST' && !tags.artist) tags.artist = value
        else if (key === 'ALBUM' && !tags.album) tags.album = value
      }
    }

    if (isLast) break
    pos = body + len
  }

  if (sampleRate > 0 && totalSamples > 0) tags.duration = Math.round(totalSamples / sampleRate)
  // v1.4.16-pre1：只有封面的曲目也要返回
  return tags.title || tags.artist || tags.album || tags.duration || tags.cover ? tags : null
}

/** 在 [start, end) 范围内按 atom 结构找子 atom，返回其数据区间 */
function findAtom(bytes: Uint8Array, start: number, end: number, name: string): { dataStart: number; dataEnd: number } | null {
  let pos = start
  while (pos + 8 <= end) {
    const size = be32(bytes, pos)
    if (size < 8) return null
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const dataStart = pos + 8
    const dataEnd = Math.min(end, pos + size)
    if (type === name) return { dataStart, dataEnd }
    pos += size
  }
  return null
}

/** MP4/M4A 的 iTunes 标签字段 → 我们关心的键 */
const MP4_ITEMS: Record<string, TextField> = {
  '\u00a9nam': 'title',
  '\u00a9ART': 'artist',
  '\u00a9alb': 'album',
}

/**
 * 解析 MP4/M4A（m4a 常见）。
 *
 * 标签藏在 moov > udta > meta > ilst 里；meta 这个 atom 比规范多 4 字节
 * 的 version/flags，找子 atom 前必须跳过，否则整个 ilst 都找不到。
 */
export function parseMp4(bytes: Uint8Array): AudioTags | null {
  if (bytes.length < 12) return null
  if (!isAscii(bytes, 4, 'ftyp')) return null
  const tags: AudioTags = { source: 'mp4' }

  const moov = findAtom(bytes, 0, bytes.length, 'moov')
  if (!moov) return null

  // 时长：mvhd 里 timescale 与 duration
  const mvhd = findAtom(bytes, moov.dataStart, moov.dataEnd, 'mvhd')
  if (mvhd) {
    const v = bytes[mvhd.dataStart]
    const base = mvhd.dataStart + 4
    if (v === 1) {
      const timescale = be32(bytes, base + 16)
      const hi = be32(bytes, base + 20)
      const lo = be32(bytes, base + 24)
      const duration = hi * 0x100000000 + lo
      if (timescale > 0 && duration > 0) tags.duration = Math.round(duration / timescale)
    } else {
      const timescale = be32(bytes, base + 8)
      const duration = be32(bytes, base + 12)
      if (timescale > 0 && duration > 0) tags.duration = Math.round(duration / timescale)
    }
  }

  const udta = findAtom(bytes, moov.dataStart, moov.dataEnd, 'udta')
  if (udta) {
    const meta = findAtom(bytes, udta.dataStart, udta.dataEnd, 'meta')
    if (meta) {
      // meta 的 version/flags 占 4 字节
      const ilst = findAtom(bytes, meta.dataStart + 4, meta.dataEnd, 'ilst')
      if (ilst) {
        let pos = ilst.dataStart
        while (pos + 8 <= ilst.dataEnd) {
          const size = be32(bytes, pos)
          if (size < 8) break
          const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
          // v1.4.16-pre1 封面：covr atom（iTunes 用它存封面）
          if (type === 'covr' && !tags.cover) {
            const data = findAtom(bytes, pos + 8, Math.min(ilst.dataEnd, pos + size), 'data')
            if (data && data.dataEnd - data.dataStart > 8) {
              const coverBytes = bytes.subarray(data.dataStart + 8, data.dataEnd)
              if (coverBytes.length >= 32) {
                tags.cover = { data: coverBytes, mime: sniffImageMime(coverBytes) }
              }
            }
          }
          const field = MP4_ITEMS[type]
          if (field) {
            const data = findAtom(bytes, pos + 8, Math.min(ilst.dataEnd, pos + size), 'data')
            if (data && data.dataEnd - data.dataStart > 8) {
              // data atom：version/flags(4) + locale(4) + 正文
              const value = clean(new TextDecoder('utf-8').decode(bytes.subarray(data.dataStart + 8, data.dataEnd)))
              if (value && !tags[field]) tags[field] = value
            }
          }
          pos += size
        }
      }
    }
  }

  // v1.4.16-pre1：只有封面的曲目也要返回
  return tags.title || tags.artist || tags.album || tags.duration || tags.cover ? tags : null
}

/**
 * 按文件头魔数分派解析器。
 *
 * @param head 文件开头 HEAD_BYTES 字节
 * @param tail 文件最后 ID3V1_BYTES 字节（可选，只有 mp3 的 ID3v1 兜底用得上）
 */
export function parseAudioTags(head: Uint8Array, tail?: Uint8Array): AudioTags | null {
  if (!head || head.length === 0) return null
  // mp3：先看 ID3v2，没有再试 ID3v1
  if (isAscii(head, 0, 'ID3')) {
    const v2 = parseId3v2(head)
    if (v2) return v2
    return tail ? parseId3v1(tail) : null
  }
  if (isAscii(head, 0, 'fLaC')) return parseFlac(head)
  if (head.length >= 8 && isAscii(head, 4, 'ftyp')) return parseMp4(head)
  // 没有 ID3v2 头的 mp3（老文件直接以帧同步开头）：只能用 ID3v1
  if (tail) return parseId3v1(tail)
  return null
}

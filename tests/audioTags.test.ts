import { describe, it, expect } from 'vitest'
import {
  HEAD_BYTES,
  ID3V1_BYTES,
  decodeText,
  parseAudioTags,
  parseFlac,
  parseId3v1,
  parseId3v2,
  parseMp4,
} from '../src/services/audioTags'

// ── 字节构造工具 ───────────────────────────────────────────────
// 所有用例都用真实字节自己拼，不 mock 解析器：这些函数的输入就是字节，
// 只有真字节才能验出「syncsafe 当成 be32 读」「meta 少跳 4 字节」这类错。

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = []
  for (const p of parts) flat.push(...Array.from(p))
  return Uint8Array.from(flat)
}

/** Latin-1 编码：每字符取低 8 位 */
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff)
const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s))

function utf16le(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out.push(c & 0xff, (c >>> 8) & 0xff)
  }
  return out
}

function utf16be(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out.push((c >>> 8) & 0xff, c & 0xff)
  }
  return out
}

const u24be = (n: number): number[] => [(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

/** ID3v2 的同步安全整数：每字节只用低 7 位 */
const syncSafe = (n: number): number[] => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]

// ── ID3v2 ────────────────────────────────────────────────────

/** v2.3 帧：4 字符 ID + 普通 4 字节 BE 长度 + 2 字节 flags */
const frame23 = (id: string, body: number[]): number[] => [...ascii(id), ...u32be(body.length), 0, 0, ...body]
/** v2.4 帧：4 字符 ID + 同步安全 4 字节长度 + 2 字节 flags */
const frame24 = (id: string, body: number[]): number[] => [...ascii(id), ...syncSafe(body.length), 0, 0, ...body]
/** v2.2 帧：3 字符 ID + 3 字节 BE 长度，没有 flags */
const frame22 = (id: string, body: number[]): number[] => [...ascii(id), ...u24be(body.length), ...body]

function id3v2(major: number, frames: number[][]): Uint8Array {
  const body = frames.flat()
  return bytes(ascii('ID3'), [major, 0, 0], syncSafe(body.length), body)
}

/** 文本帧正文：编码字节 + 对应编码的正文 */
function textBody(encoding: number, text: string): number[] {
  if (encoding === 0) return [0, ...ascii(text)]
  if (encoding === 1) return [1, 0xff, 0xfe, ...utf16le(text)]
  if (encoding === 2) return [2, ...utf16be(text)]
  return [3, ...utf8(text)]
}

// ── ID3v1 ────────────────────────────────────────────────────

/** 128 字节的 ID3v1 块：TAG + title30 + artist30 + album30 + year4 + comment30 + genre1 */
function id3v1Tail(title: string, artist: string, album: string): number[] {
  const field = (s: string, len: number): number[] => {
    const out = ascii(s).slice(0, len)
    while (out.length < len) out.push(0)
    return out
  }
  return [...ascii('TAG'), ...field(title, 30), ...field(artist, 30), ...field(album, 30), ...field('2024', 4), ...field('', 30), 0xff]
}

// ── FLAC ─────────────────────────────────────────────────────

function flacBlock(type: number, body: number[], last: boolean): number[] {
  return [(last ? 0x80 : 0) | type, ...u24be(body.length), ...body]
}

/** 34 字节 STREAMINFO：把采样率(20bit)/声道/bps/总采样数(36bit)按位打包 */
function streaminfoBody(sampleRate: number, totalSamples: number, channels = 2, bps = 16): number[] {
  const d: number[] = new Array(34).fill(0)
  d[10] = (sampleRate >>> 12) & 0xff
  d[11] = (sampleRate >>> 4) & 0xff
  d[12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | (((bps - 1) >>> 4) & 0x01)
  d[13] = (((bps - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 0x100000000) & 0x0f)
  const lo = totalSamples % 0x100000000
  d[14] = (lo >>> 24) & 0xff
  d[15] = (lo >>> 16) & 0xff
  d[16] = (lo >>> 8) & 0xff
  d[17] = lo & 0xff
  return d
}

/** VORBIS_COMMENT：厂商长度(LE32)+厂商+条目数(LE32)+每条(长度+"KEY=value") */
function vorbisCommentBody(vendor: string, entries: [string, string][]): number[] {
  const v = utf8(vendor)
  const out = [...u32le(v.length), ...v, ...u32le(entries.length)]
  for (const [k, value] of entries) {
    const item = utf8(k + '=' + value)
    out.push(...u32le(item.length), ...item)
  }
  return out
}

// ── MP4 ──────────────────────────────────────────────────────

function atom(type: string, ...parts: number[][]): number[] {
  const body = parts.flat()
  return [...u32be(body.length + 8), ...ascii(type), ...body]
}

/** mvhd version=0：version/flags + creation + modification + timescale + duration */
function mvhd0(timescale: number, duration: number): number[] {
  return atom('mvhd', [0, 0, 0, 0], u32be(0), u32be(0), u32be(timescale), u32be(duration), new Array(80).fill(0))
}

/** mvhd version=1：creation/modification 各 8 字节，duration 64 位 */
function mvhd1(timescale: number, duration: number): number[] {
  const hi = Math.floor(duration / 0x100000000)
  const lo = duration % 0x100000000
  return atom(
    'mvhd',
    [1, 0, 0, 0],
    u32be(0), u32be(0), u32be(0), u32be(0),
    u32be(timescale), u32be(hi), u32be(lo),
    new Array(80).fill(0),
  )
}

/** data atom：version/flags(4) + locale(4) + UTF-8 正文 */
const dataAtom = (text: string): number[] => atom('data', u32be(1), u32be(0), utf8(text))

/** ilst 的一项：©nam / ©ART / ©alb，里面套一个 data atom */
const ilstItem = (name: string, text: string): number[] => atom(name, dataAtom(text))

const ftyp = (): number[] => atom('ftyp', ascii('M4A '), u32be(0), ascii('M4A mp42isom'))

const NAM = String.fromCharCode(0xa9) + 'nam'
const ART = String.fromCharCode(0xa9) + 'ART'
const ALB = String.fromCharCode(0xa9) + 'alb'

// ── 用例 ─────────────────────────────────────────────────────

describe('audioTags 常量', () => {
  it('HEAD_BYTES 是 256KB，ID3V1_BYTES 是 128', () => {
    expect(HEAD_BYTES).toBe(256 * 1024)
    expect(ID3V1_BYTES).toBe(128)
  })
})

describe('decodeText：四种 ID3 文本编码', () => {
  it('encoding=0 按 ISO-8859-1 逐字节映射（0xE9 → é）', () => {
    expect(decodeText(Uint8Array.from([0x43, 0x61, 0x66, 0xe9]), 0)).toBe('Café')
  })

  it('encoding=0 不按 UTF-8 解（多字节序列原样成 Latin-1 字符）', () => {
    // UTF-8 的 "中" = E4 B8 AD，按 Latin-1 应解成 3 个字符
    expect(decodeText(Uint8Array.from([0xe4, 0xb8, 0xad]), 0)).toBe('\u00e4\u00b8\u00ad')
  })

  it('encoding=1 UTF-16 带 LE BOM：中文', () => {
    expect(decodeText(Uint8Array.from([0xff, 0xfe, ...utf16le('周杰伦')]), 1)).toBe('周杰伦')
  })

  it('encoding=1 UTF-16 带 BE BOM：中文', () => {
    expect(decodeText(Uint8Array.from([0xfe, 0xff, ...utf16be('稻香')]), 1)).toBe('稻香')
  })

  it('encoding=1 无 BOM 时按规范当 UTF-16LE：中文', () => {
    expect(decodeText(Uint8Array.from(utf16le('中文')), 1)).toBe('中文')
  })

  it('encoding=1 带 emoji（代理对）', () => {
    expect(decodeText(Uint8Array.from([0xff, 0xfe, ...utf16le('🎵')]), 1)).toBe('🎵')
  })

  it('encoding=2 UTF-16BE 无 BOM：中文', () => {
    expect(decodeText(Uint8Array.from(utf16be('夜曲')), 2)).toBe('夜曲')
  })

  it('encoding=2 带 emoji（代理对）', () => {
    expect(decodeText(Uint8Array.from(utf16be('🎧')), 2)).toBe('🎧')
  })

  it('encoding=3 UTF-8：中文', () => {
    expect(decodeText(Uint8Array.from(utf8('七里香')), 3)).toBe('七里香')
  })

  it('encoding=3 UTF-8：emoji', () => {
    expect(decodeText(Uint8Array.from(utf8('🎵🎧')), 3)).toBe('🎵🎧')
  })

  it('去掉尾部 NUL 与首尾空白', () => {
    expect(decodeText(Uint8Array.from([0x41, 0x20, 0x00, 0x00]), 0)).toBe('A')
    expect(decodeText(Uint8Array.from(utf8('  x  ')), 3)).toBe('x')
  })

  it('UTF-16 遇到 0 码元即截断（定长字段的填充）', () => {
    expect(decodeText(Uint8Array.from([0xff, 0xfe, ...utf16le('AB'), 0, 0, 0, 0]), 1)).toBe('AB')
  })

  it('未知编码返回空串，不抛异常', () => {
    expect(decodeText(Uint8Array.from([0x41]), 5)).toBe('')
    expect(decodeText(new Uint8Array(0), 5)).toBe('')
  })

  it('空数组返回空串', () => {
    for (const enc of [0, 1, 2, 3]) expect(decodeText(new Uint8Array(0), enc)).toBe('')
  })
})

describe('parseId3v2', () => {
  it('v2.3：TIT2 / TPE1 / TALB 三帧', () => {
    const tag = id3v2(3, [
      frame23('TIT2', textBody(1, '稻香')),
      frame23('TPE1', textBody(1, '周杰伦')),
      frame23('TALB', textBody(1, '魔杰座')),
    ])
    expect(parseId3v2(tag)).toEqual({ source: 'id3v2', title: '稻香', artist: '周杰伦', album: '魔杰座' })
  })

  it('v2.4：TIT2 / TPE1 / TALB 三帧', () => {
    const tag = id3v2(4, [
      frame24('TIT2', textBody(3, '晴天')),
      frame24('TPE1', textBody(3, '周杰伦')),
      frame24('TALB', textBody(3, '叶惠美')),
    ])
    expect(parseId3v2(tag)).toEqual({ source: 'id3v2', title: '晴天', artist: '周杰伦', album: '叶惠美' })
  })

  it('v2.4 的帧长度确实按同步安全整数读（>127 字节的帧仍能解析）', () => {
    // 201 字节的正文：同步安全编码 00 00 01 49；若被当成普通 BE 就是 329，
    // 越界后解析器会 break，album 就拿不到了。
    const longAlbum = 'A'.repeat(200)
    const tag = id3v2(4, [
      frame24('TIT2', textBody(3, '标题')),
      frame24('TALB', textBody(3, longAlbum)),
    ])
    const tags = parseId3v2(tag)
    expect(tags?.title).toBe('标题')
    expect(tags?.album).toBe(longAlbum)
  })

  it('v2.2：3 字符帧 ID（TT2 / TP1 / TAL）', () => {
    const tag = id3v2(2, [
      frame22('TT2', textBody(1, '东风破')),
      frame22('TP1', textBody(1, '周杰伦')),
      frame22('TAL', textBody(1, '叶惠美')),
    ])
    expect(parseId3v2(tag)).toEqual({ source: 'id3v2', title: '东风破', artist: '周杰伦', album: '叶惠美' })
  })

  it('三种文本编码在帧里都能解出中文', () => {
    for (const enc of [1, 2, 3]) {
      const tag = id3v2(3, [frame23('TIT2', textBody(enc, '菊花台'))])
      expect(parseId3v2(tag)?.title).toBe('菊花台')
    }
  })

  it('同一字段出现多次时保留第一次', () => {
    const tag = id3v2(3, [frame23('TIT2', textBody(1, '第一版')), frame23('TIT2', textBody(1, '第二版'))])
    expect(parseId3v2(tag)?.title).toBe('第一版')
  })

  it('不认识的帧 ID 被跳过，不影响后面的已知帧', () => {
    const tag = id3v2(3, [frame23('XXXX', [0, 1, 2, 3]), frame23('TIT2', textBody(1, '稻香'))])
    expect(parseId3v2(tag)?.title).toBe('稻香')
  })

  it('只有未知帧时返回 null', () => {
    expect(parseId3v2(id3v2(3, [frame23('PRIV', [1, 2, 3])]))).toBeNull()
  })

  it('没有 ID3 魔数返回 null', () => {
    expect(parseId3v2(Uint8Array.from(ascii('ID4\u0003\u0000\u0000\u0000\u0000\u0000\u0000')))).toBeNull()
  })

  it('major 版本超出 2..4 返回 null', () => {
    expect(parseId3v2(id3v2(5, [frame23('TIT2', textBody(1, 'x'))]))).toBeNull()
    expect(parseId3v2(id3v2(1, [frame23('TIT2', textBody(1, 'x'))]))).toBeNull()
  })

  it('长度不足 10 字节返回 null', () => {
    expect(parseId3v2(Uint8Array.from(ascii('ID3')))).toBeNull()
  })

  it('帧声明的 size 超出标签范围时安全停下，返回 null', () => {
    // 帧头声称正文 1000 字节，但标签正文只有 10 字节
    const frameHeader = [...ascii('TIT2'), ...u32be(1000), 0, 0]
    const tag = bytes(ascii('ID3'), [3, 0, 0], syncSafe(frameHeader.length), frameHeader)
    expect(() => parseId3v2(tag)).not.toThrow()
    expect(parseId3v2(tag)).toBeNull()
  })

  it('标签被截断（头部声称的长度大于实际字节）不崩', () => {
    const full = id3v2(3, [frame23('TIT2', textBody(1, '稻香')), frame23('TPE1', textBody(1, '周杰伦'))])
    const truncated = full.subarray(0, 15)
    expect(() => parseId3v2(truncated)).not.toThrow()
    expect(parseId3v2(truncated)).toBeNull()
  })

  it('空数组不崩', () => {
    expect(() => parseId3v2(new Uint8Array(0))).not.toThrow()
    expect(parseId3v2(new Uint8Array(0))).toBeNull()
  })
})

describe('parseId3v1', () => {
  it('从尾部 128 字节读出 title / artist / album', () => {
    const tail = Uint8Array.from(id3v1Tail('Caf\u00e9', 'D\u00e9j\u00e0 Vu', 'Album'))
    expect(parseId3v1(tail)).toEqual({ source: 'id3v1', title: 'Caf\u00e9', artist: 'D\u00e9j\u00e0 Vu', album: 'Album' })
  })

  it('前面带音频字节时仍按「最后 128 字节」定位', () => {
    const tail = bytes(new Array(1000).fill(0x55), id3v1Tail('Song', 'Artist', 'Record'))
    expect(parseId3v1(tail)).toEqual({ source: 'id3v1', title: 'Song', artist: 'Artist', album: 'Record' })
  })

  it('字段按 Latin-1 逐字节解码：GBK/UTF-8 中文标签只会是乱码（1996 年格式的限制）', () => {
    // 直接用 GBK「稻香」= B5 BE CF E3 写进 title 字段
    const tail = bytes(ascii('TAG'), [0xb5, 0xbe, 0xcf, 0xe3], new Array(26).fill(0), new Array(30).fill(0), new Array(30).fill(0), ascii('2024'), new Array(30).fill(0), [0xff])
    const tags = parseId3v1(tail)
    // 不崩，也不假装解对：4 个字节映射成 4 个 Latin-1 字符
    expect(tags?.title).toBe(String.fromCharCode(0xb5, 0xbe, 0xcf, 0xe3))
    expect(tags?.title).not.toBe('稻香')
  })

  it('定长字段的 0 填充被去掉', () => {
    const tags = parseId3v1(Uint8Array.from(id3v1Tail('A', 'B', 'C')))
    expect(tags?.title).toBe('A')
    expect(tags?.artist).toBe('B')
    expect(tags?.album).toBe('C')
  })

  it('不足 128 字节返回 null', () => {
    expect(parseId3v1(new Uint8Array(127))).toBeNull()
    expect(parseId3v1(new Uint8Array(0))).toBeNull()
  })

  it('尾部不是 TAG 开头返回 null', () => {
    const tail = Uint8Array.from(id3v1Tail('稻香', '周杰伦', '魔杰座'))
    tail[0] = 0x58
    expect(parseId3v1(tail)).toBeNull()
  })

  it('TAG 存在但三个字段全空时返回 null', () => {
    expect(parseId3v1(Uint8Array.from(id3v1Tail('', '', '')))).toBeNull()
  })
})

describe('parseFlac', () => {
  it('STREAMINFO 算出时长 + VORBIS_COMMENT 读出三个标签', () => {
    const file = bytes(
      ascii('fLaC'),
      flacBlock(0, streaminfoBody(44100, 44100 * 180), false),
      flacBlock(4, vorbisCommentBody('reference libFLAC', [['TITLE', '夜曲'], ['ARTIST', '周杰伦'], ['ALBUM', '十一月的萧邦']]), true),
    )
    expect(parseFlac(file)).toEqual({ source: 'flac', title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', duration: 180 })
  })

  it('时长按 totalSamples / sampleRate 四舍五入', () => {
    const file = bytes(ascii('fLaC'), flacBlock(0, streaminfoBody(48000, 48000 * 3 + 24000), true))
    // 3.5 秒 → 4
    expect(parseFlac(file)?.duration).toBe(4)
  })

  it('另一组采样率与总采样数也对得上（44.1kHz / 245 秒）', () => {
    const file = bytes(
      ascii('fLaC'),
      flacBlock(0, streaminfoBody(44100, 44100 * 245), false),
      flacBlock(4, vorbisCommentBody('x', [['TITLE', 't']]), true),
    )
    expect(parseFlac(file)?.duration).toBe(245)
  })

  it('Vorbis 的键名大小写不敏感', () => {
    const file = bytes(
      ascii('fLaC'),
      flacBlock(0, streaminfoBody(44100, 44100 * 10), false),
      flacBlock(4, vorbisCommentBody('x', [['title', '小写标题'], ['Artist', '小写歌手'], ['ALBUM', '大写专辑']]), true),
    )
    const tags = parseFlac(file)
    expect(tags?.title).toBe('小写标题')
    expect(tags?.artist).toBe('小写歌手')
    expect(tags?.album).toBe('大写专辑')
  })

  it('只认识 TITLE / ARTIST / ALBUM，其他键被忽略', () => {
    const file = bytes(
      ascii('fLaC'),
      flacBlock(0, streaminfoBody(44100, 44100 * 10), false),
      flacBlock(4, vorbisCommentBody('x', [['GENRE', 'Pop'], ['DATE', '2005'], ['TITLE', '只认这个']]), true),
    )
    expect(parseFlac(file)).toEqual({ source: 'flac', title: '只认这个', duration: 10 })
  })

  it('没有 fLaC 魔数返回 null', () => {
    expect(parseFlac(Uint8Array.from(ascii('fLaX')))).toBeNull()
    expect(parseFlac(new Uint8Array(0))).toBeNull()
  })

  it('只有 fLaC 没有元数据块返回 null', () => {
    expect(parseFlac(Uint8Array.from(ascii('fLaC')))).toBeNull()
  })

  it('块长度超出实际字节时安全停下，不崩', () => {
    const bad = bytes(ascii('fLaC'), [0x00, 0x00, 0x10, 0x00], [0, 0, 0])
    expect(() => parseFlac(bad)).not.toThrow()
    expect(parseFlac(bad)).toBeNull()
  })

  it('VORBIS_COMMENT 内部长度越界时不崩', () => {
    const body = [...u32le(999), 0x41, 0x42, ...u32le(0)]
    const file = bytes(ascii('fLaC'), flacBlock(0, streaminfoBody(44100, 44100 * 5), false), flacBlock(4, body, true))
    expect(() => parseFlac(file)).not.toThrow()
    expect(parseFlac(file)?.duration).toBe(5)
  })
})

describe('parseMp4', () => {
  it('moov > udta > meta > ilst 读出三个标签，mvhd 算出时长', () => {
    const file = bytes(
      ftyp(),
      atom(
        'moov',
        mvhd0(1000, 245000),
        atom('udta', atom('meta', [0, 0, 0, 0], atom('ilst', ilstItem(NAM, '七里香'), ilstItem(ART, '周杰伦'), ilstItem(ALB, '七里香')))),
      ),
    )
    expect(parseMp4(file)).toEqual({ source: 'mp4', title: '七里香', artist: '周杰伦', album: '七里香', duration: 245 })
  })

  it('meta 的 4 字节 version/flags 必须被跳过（反证：少了这 4 字节就读不到标签）', () => {
    const ilst = atom('ilst', ilstItem(NAM, '七里香'))
    // 正例：meta 里带 version/flags
    const good = bytes(ftyp(), atom('moov', mvhd0(1000, 245000), atom('udta', atom('meta', [0, 0, 0, 0], ilst))))
    expect(parseMp4(good)?.title).toBe('七里香')

    // 反证：不带 version/flags 时，从 meta.dataStart+4 找 ilst 会落空
    const bad = bytes(ftyp(), atom('moov', mvhd0(1000, 245000), atom('udta', atom('meta', ilst))))
    const badTags = parseMp4(bad)
    expect(badTags?.title).toBeUndefined()
    // 时长走的是另一条路径，不受影响
    expect(badTags?.duration).toBe(245)
  })

  it('mvhd version=1（64 位时长）也能算出秒数', () => {
    const file = bytes(ftyp(), atom('moov', mvhd1(600, 600 * 128)))
    expect(parseMp4(file)?.duration).toBe(128)
  })

  it('时长按 duration / timescale 四舍五入', () => {
    const file = bytes(ftyp(), atom('moov', mvhd0(1000, 245500)))
    expect(parseMp4(file)?.duration).toBe(246)
  })

  it('没有 ftyp 返回 null', () => {
    expect(parseMp4(bytes(atom('moov', mvhd0(1000, 1000))))).toBeNull()
  })

  it('有 ftyp 但没有 moov 返回 null', () => {
    expect(parseMp4(bytes(ftyp()))).toBeNull()
  })

  it('有 moov 但没有 udta 时只拿到时长', () => {
    const tags = parseMp4(bytes(ftyp(), atom('moov', mvhd0(1000, 60000))))
    expect(tags).toEqual({ source: 'mp4', duration: 60 })
  })

  it('data atom 正文为空时该字段被忽略', () => {
    const empty = atom(NAM, atom('data', u32be(1), u32be(0)))
    const file = bytes(ftyp(), atom('moov', atom('udta', atom('meta', [0, 0, 0, 0], atom('ilst', empty)))))
    expect(parseMp4(file)).toBeNull()
  })

  it('ilst 里 size 异常（< 8）时安全跳出，不崩', () => {
    // 第一项正常，后面跟一个 size=0 的坏项：解析到坏项必须 break 而不是死循环
    const ilstBody = [...ilstItem(NAM, 'x'), 0, 0, 0, 0, ...ascii('junk')]
    const file = bytes(ftyp(), atom('moov', atom('udta', atom('meta', [0, 0, 0, 0], atom('ilst', ilstBody)))))
    expect(() => parseMp4(file)).not.toThrow()
    expect(parseMp4(file)?.title).toBe('x')
  })

  it('不足 12 字节返回 null', () => {
    expect(parseMp4(new Uint8Array(0))).toBeNull()
    expect(parseMp4(Uint8Array.from(ascii('M4A ')))).toBeNull()
  })
})

describe('parseAudioTags：按魔数分派', () => {
  it('ID3 开头 → ID3v2', () => {
    const head = id3v2(3, [frame23('TIT2', textBody(1, '稻香'))])
    expect(parseAudioTags(head)?.source).toBe('id3v2')
    expect(parseAudioTags(head)?.title).toBe('稻香')
  })

  it('ID3v2 解析不出东西时回落到 ID3v1', () => {
    const head = bytes(ascii('ID3'), [9, 0, 0], [0, 0, 0, 0])
    const tail = Uint8Array.from(id3v1Tail('Song', 'Artist', 'Record'))
    expect(parseAudioTags(head, tail)?.source).toBe('id3v1')
    expect(parseAudioTags(head, tail)?.title).toBe('Song')
  })

  it('ID3v2 解析不出东西且没有 tail 时返回 null', () => {
    const head = bytes(ascii('ID3'), [9, 0, 0], [0, 0, 0, 0])
    expect(parseAudioTags(head)).toBeNull()
  })

  it('fLaC 开头 → FLAC', () => {
    const head = bytes(ascii('fLaC'), flacBlock(0, streaminfoBody(44100, 44100 * 30), true))
    expect(parseAudioTags(head)?.source).toBe('flac')
    expect(parseAudioTags(head)?.duration).toBe(30)
  })

  it('偏移 4 处是 ftyp → MP4', () => {
    const head = bytes(ftyp(), atom('moov', mvhd0(1000, 60000)))
    expect(parseAudioTags(head)?.source).toBe('mp4')
    expect(parseAudioTags(head)?.duration).toBe(60)
  })

  it('没有魔数的裸 mp3 用 ID3v1 兜底', () => {
    const head = Uint8Array.from(ascii('FRAME-sync-bytes-here'))
    const tail = Uint8Array.from(id3v1Tail('Song', 'Artist', 'Record'))
    expect(parseAudioTags(head, tail)?.source).toBe('id3v1')
    expect(parseAudioTags(head, tail)?.title).toBe('Song')
  })

  it('既没魔数也没 tail → null', () => {
    expect(parseAudioTags(Uint8Array.from(ascii('FRAME-sync-bytes-here')))).toBeNull()
  })

  it('空 head → null', () => {
    expect(parseAudioTags(new Uint8Array(0))).toBeNull()
    expect(parseAudioTags(new Uint8Array(0), Uint8Array.from(id3v1Tail('a', 'b', 'c')))).toBeNull()
  })
})

describe('健壮性：脏数据一律不崩', () => {
  const dirty: [string, Uint8Array][] = [
    ['全 0 的 512 字节', new Uint8Array(512)],
    ['全 0xFF 的 512 字节', new Uint8Array(512).fill(0xff)],
    ['确定性伪随机字节', Uint8Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff)],
    ['纯文本', Uint8Array.from(utf8('this is definitely not an audio file at all'))],
    ['只有 1 字节', Uint8Array.from([0x00])],
    ['ID3 魔数后全是 0', bytes(ascii('ID3'), new Array(64).fill(0))],
    ['fLaC 魔数后全是 0', bytes(ascii('fLaC'), new Array(64).fill(0))],
    ['ftyp 在偏移 4 但后面是垃圾', bytes([0, 0, 0, 8], ascii('ftyp'), new Array(64).fill(0x41))],
  ]

  for (const [name, buf] of dirty) {
    it(name + '：四个解析器都不抛异常', () => {
      expect(() => parseAudioTags(buf)).not.toThrow()
      expect(() => parseId3v2(buf)).not.toThrow()
      expect(() => parseId3v1(buf)).not.toThrow()
      expect(() => parseFlac(buf)).not.toThrow()
      expect(() => parseMp4(buf)).not.toThrow()
      expect(parseAudioTags(buf)).toBeNull()
    })
  }

  it('空数组对所有入口都不抛异常', () => {
    const empty = new Uint8Array(0)
    expect(() => parseAudioTags(empty)).not.toThrow()
    expect(() => parseId3v2(empty)).not.toThrow()
    expect(() => parseId3v1(empty)).not.toThrow()
    expect(() => parseFlac(empty)).not.toThrow()
    expect(() => parseMp4(empty)).not.toThrow()
    expect(parseAudioTags(empty)).toBeNull()
    expect(parseId3v2(empty)).toBeNull()
    expect(parseId3v1(empty)).toBeNull()
    expect(parseFlac(empty)).toBeNull()
    expect(parseMp4(empty)).toBeNull()
  })
})

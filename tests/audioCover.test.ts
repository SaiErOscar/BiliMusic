// v1.4.16-pre1 内嵌封面解析（APIC / PICTURE / covr）
//
// 三种格式存放位置完全不同：
// - MP3：ID3v2 的 APIC 帧（v2.2 叫 PIC）
// - FLAC：PICTURE 元数据块（type=6）
// - M4A：moov/udta/meta/ilst 下的 covr atom
//
// 用真实字节构造，不依赖外部文件——这些是纯函数，输入输出都是字节。
import { describe, expect, it } from 'vitest'
import { parseAudioTags, sniffImageMime } from '../src/services/audioTags'

/** 最小的合法 JPEG 头（够嗅探用） */
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0]
/** 最小的 PNG 头 */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = []
  for (const p of parts) {
    if (p instanceof Uint8Array) flat.push(...Array.from(p))
    else flat.push(...p)
  }
  return new Uint8Array(flat)
}

/** 造一段假图片数据：合法头 + 填充 */
function fakeImage(head: number[], size = 64): number[] {
  const out = [...head]
  while (out.length < size) out.push(0x11)
  return out
}

function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function syncSafe(n: number): number[] {
  return [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]
}

describe('sniffImageMime —— 按字节判图片类型', () => {
  it('识别 JPEG / PNG / GIF / WEBP / BMP', () => {
    expect(sniffImageMime(new Uint8Array(fakeImage(JPEG_HEAD)))).toBe('image/jpeg')
    expect(sniffImageMime(new Uint8Array(fakeImage(PNG_HEAD)))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array(fakeImage([0x47, 0x49, 0x46, 0x38])))).toBe('image/gif')
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d, 0x00]))).toBe('image/bmp')
  })

  it('认不出来时退回 jpeg（封面绝大多数是 JPEG，且浏览器仍会尝试解码）', () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4]))).toBe('image/jpeg')
  })
})

describe('MP3 APIC 封面', () => {
  /** 构造一个带 APIC 的 ID3v2.3 标签 */
  function buildMp3WithApic(opts: { encoding?: number; mime?: string; image?: number[]; desc?: number[] } = {}) {
    const encoding = opts.encoding ?? 0
    const mimeStr = opts.mime ?? 'image/jpeg'
    const image = opts.image ?? fakeImage(JPEG_HEAD)
    const desc = opts.desc ?? []

    const bodyParts: number[] = [encoding]
    for (const ch of mimeStr) bodyParts.push(ch.charCodeAt(0))
    bodyParts.push(0) // MIME 结束
    bodyParts.push(3) // 图片类型：front cover
    // 描述终止符宽度随编码变化：UTF-16 是 2 字节 0，其余 1 字节
    if (encoding === 1 || encoding === 2) {
      bodyParts.push(...desc, 0, 0)
    } else {
      bodyParts.push(...desc, 0)
    }
    bodyParts.push(...image)

    const frameSize = bodyParts.length
    const frame = [
      ...'APIC'.split('').map((c) => c.charCodeAt(0)),
      ...u32be(frameSize),
      0, 0, // flags
      ...bodyParts,
    ]
    const tagSize = frame.length
    return bytes(
      'ID3'.split('').map((c) => c.charCodeAt(0)),
      [3, 0, 0], // v2.3, flags 0
      syncSafe(tagSize),
      frame,
    )
  }

  it('解析出图片字节与 MIME', () => {
    const tags = parseAudioTags(buildMp3WithApic())
    expect(tags?.cover).toBeDefined()
    expect(tags?.cover?.data.length).toBe(64)
    expect(tags?.cover?.mime).toBe('image/jpeg')
  })

  it('UTF-16 描述（2 字节终止符）不会让图片数据错位', () => {
    // encoding=1（UTF-16），描述用 2 字节 0 结尾
    const tags = parseAudioTags(
      buildMp3WithApic({ encoding: 1, desc: [0x00, 0x4e, 0x2d, 0x65] }),
    )
    expect(tags?.cover).toBeDefined()
    expect(tags?.cover?.data.length).toBe(64)
  })

  it('PNG 封面被正确识别为 image/png（不看声明看字节）', () => {
    const tags = parseAudioTags(buildMp3WithApic({ mime: 'image/jpeg', image: fakeImage(PNG_HEAD) }))
    expect(tags?.cover?.mime).toBe('image/png')
  })

  it('没有 APIC 帧时不产生 cover 字段', () => {
    // 只有 TIT2 的标签
    const titleBody = [0, ...'标题'.split('').map((c) => c.charCodeAt(0) & 0xff)]
    const frame = [...'TIT2'.split('').map((c) => c.charCodeAt(0)), ...u32be(titleBody.length), 0, 0, ...titleBody]
    const tag = bytes('ID3'.split('').map((c) => c.charCodeAt(0)), [3, 0, 0], syncSafe(frame.length), frame)
    const tags = parseAudioTags(tag)
    expect(tags?.cover).toBeUndefined()
  })
})

describe('FLAC PICTURE 封面', () => {
  function buildFlacWithPicture(image: number[] = fakeImage(JPEG_HEAD)) {
    const mime = 'image/jpeg'
    const mimeBytes = [...mime].map((c) => c.charCodeAt(0))
    const picBody = [
      ...u32be(3), // 图片类型
      ...u32be(mimeBytes.length),
      ...mimeBytes,
      ...u32be(0), // 描述长度 0
      ...u32be(64), ...u32be(64), ...u32be(24), ...u32be(0), // 宽高色深索引色
      ...u32be(image.length),
      ...image,
    ]
    const picHeader = [
      // 最后一个块：最高位 1；type 6
      0x80 | 6,
      (picBody.length >>> 16) & 0xff,
      (picBody.length >>> 8) & 0xff,
      picBody.length & 0xff,
    ]
    return bytes('fLaC'.split('').map((c) => c.charCodeAt(0)), picHeader, picBody)
  }

  it('解析出 PICTURE 块的图片字节', () => {
    const tags = parseAudioTags(buildFlacWithPicture())
    expect(tags?.cover).toBeDefined()
    expect(tags?.cover?.data.length).toBe(64)
    expect(tags?.cover?.mime).toBe('image/jpeg')
  })

  it('PNG 封面按字节识别', () => {
    const tags = parseAudioTags(buildFlacWithPicture(fakeImage(PNG_HEAD)))
    expect(tags?.cover?.mime).toBe('image/png')
  })
})

describe('健壮性：脏数据不崩', () => {
  it('空数组返回 null', () => {
    expect(parseAudioTags(new Uint8Array([]))).toBeNull()
  })

  it('截断的 APIC 帧不抛错', () => {
    // 注意：bytes() 的参数要么是 number[]，要么是 Uint8Array；
    // 不能用展开运算符把多个数组平铺进去（那会传成多个参数而非一个数组）
    const truncated = bytes(
      'ID3'.split('').map((c) => c.charCodeAt(0)),
      [3, 0, 0],
      syncSafe(20),
      [
        ...'APIC'.split('').map((c) => c.charCodeAt(0)),
        ...u32be(1000), // 声明长度远超实际
        0, 0,
        0, ...'image/jpeg'.split('').map((c) => c.charCodeAt(0)),
      ],
    )
    expect(() => parseAudioTags(truncated)).not.toThrow()
  })

  it('超小图片（<32 字节）被忽略，避免把噪声当封面', () => {
    const tiny = [0xff, 0xd8, 0xff, 0xe0, 0x00]
    const mimeBytes = [...'image/jpeg'].map((c) => c.charCodeAt(0))
    const bodyParts = [0, ...mimeBytes, 0, 3, 0, ...tiny]
    const frame = [...'APIC'.split('').map((c) => c.charCodeAt(0)), ...u32be(bodyParts.length), 0, 0, ...bodyParts]
    const tag = bytes('ID3'.split('').map((c) => c.charCodeAt(0)), [3, 0, 0], syncSafe(frame.length), frame)
    const tags = parseAudioTags(tag)
    expect(tags?.cover).toBeUndefined()
  })
})

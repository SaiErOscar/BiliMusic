import { describe, it, expect } from 'vitest'
import {
  SHARE_QR_HARD_LIMIT,
  SHARE_QR_MAX_BYTES,
  buildPlaylistShare,
  buildShare,
  buildTrackShare,
  fitsInQr,
  isShareableTrack,
  shareNotice,
  utf8Bytes,
} from '../src/services/shareCode'
import type { Playlist, Track } from '../src/types'

// 被测模块是纯函数：不 mock 二维码库、不碰 DOM、不画图。
// 口径见 src/services/shareCode.ts 顶部注释（容量 1273 硬上限 / 减 40 余量 / 绝不静默截断）。

const BILI = 'https://www.bilibili.com/video/'

/** 定长 bvid（13 字符），让每条清单项长度一致，截断边界才好断言 */
function bv(n: number): string {
  return 'BV1xx411c7' + String(n).padStart(3, '0')
}

function track(over: Partial<Track> = {}): Track {
  return {
    id: 'BV1xx411c7mD',
    title: '晴天',
    artist: '周杰伦',
    coverUrl: '',
    duration: 269,
    videoUrl: BILI + 'BV1xx411c7mD',
    bvid: 'BV1xx411c7mD',
    playCount: 0,
    isLiked: false,
    ...over,
  }
}

/** 第 n 首可分享的 B 站曲目 */
function biliTrack(n: number, over: Partial<Track> = {}): Track {
  const id = bv(n)
  return track({ id, bvid: id, videoUrl: BILI + id, ...over })
}

/** 本地曲目：pre5 起复用 Track，靠 localPath 判断 */
function localTrack(n: number, over: Partial<Track> = {}): Track {
  return biliTrack(n, { videoUrl: '', bvid: '', localPath: 'D:\\音乐\\本地' + n + '.flac', ...over })
}

/** 足够长的歌名：用来把清单撑过容量上限 */
function longTitle(n: number): string {
  return '第' + n + '首：这是一个很长的歌名用来把清单撑爆'
}

function playlist(tracks: Track[], name = '我的歌单'): Playlist {
  return {
    id: 'p1',
    name,
    coverUrl: '',
    tracks,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * 从完整文本里还原每一首的清单项（标题行 + 地址行）。
 * 只用于「标题无换行」的干净数据——那时 text = 歌单名 + 每首两行。
 */
function entriesOf(text: string): string[] {
  const lines = text.split('\n')
  const entries: string[] = []
  for (let i = 1; i + 1 < lines.length; i += 2) entries.push(lines[i] + '\n' + lines[i + 1])
  return entries
}

describe('utf8Bytes —— UTF-8 字节口径', () => {
  it('空串为 0', () => {
    expect(utf8Bytes('')).toBe(0)
  })

  it('ASCII 每个字符 1 字节', () => {
    expect(utf8Bytes('a')).toBe(1)
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes(BILI)).toBe(BILI.length)
  })

  it('中文每个字 3 字节', () => {
    expect(utf8Bytes('中')).toBe(3)
    expect(utf8Bytes('晴天')).toBe(6)
    expect(utf8Bytes('周杰伦')).toBe(9)
  })

  it('emoji 按 4 字节计（代理对被当成一个码点，不按两个 UTF-16 单元算 6 字节）', () => {
    expect(utf8Bytes('😀')).toBe(4)
    expect(utf8Bytes('🎵')).toBe(4)
    // 关键：两个 emoji 是 8 而不是 12
    expect(utf8Bytes('😀😀')).toBe(8)
    expect('😀'.length).toBe(2) // 证明按 code point 计数确实跳过了代理对
  })

  it('混合文本逐段累加，与 TextEncoder 逐串对拍', () => {
    const samples = ['', 'abc', '晴天', '标题\n副歌\t"引号"', '😀', '🎵中文abc😀', BILI + 'BV1xx411c7mD']
    const enc = new TextEncoder()
    for (const s of samples) expect(utf8Bytes(s)).toBe(enc.encode(s).length)
  })

  it('换行、制表符、引号各算 1 字节', () => {
    expect(utf8Bytes('\n')).toBe(1)
    expect(utf8Bytes('\t')).toBe(1)
    expect(utf8Bytes('"')).toBe(1)
    expect(utf8Bytes('a\nb\tc"d')).toBe(7)
  })
})

describe('fitsInQr —— 容量边界', () => {
  it('容量常量：MAX = HARD - 40 字节编码器余量', () => {
    expect(SHARE_QR_HARD_LIMIT).toBe(1273)
    expect(SHARE_QR_MAX_BYTES).toBe(SHARE_QR_HARD_LIMIT - 40)
    expect(SHARE_QR_MAX_BYTES).toBe(1233)
  })

  it('恰好等于上限返回 true，超 1 字节返回 false', () => {
    expect(fitsInQr('a'.repeat(SHARE_QR_MAX_BYTES))).toBe(true)
    expect(fitsInQr('a'.repeat(SHARE_QR_MAX_BYTES + 1))).toBe(false)
  })

  it('多字节字符跨过边界的那一刻返回 false', () => {
    // 1233 = 411 * 3，正好卡在中文的整字节边界上
    expect(utf8Bytes('中'.repeat(411))).toBe(SHARE_QR_MAX_BYTES)
    expect(fitsInQr('中'.repeat(411))).toBe(true)
    expect(fitsInQr('中'.repeat(412))).toBe(false)
    expect(fitsInQr('😀'.repeat(308))).toBe(true) // 1232 字节
    expect(fitsInQr('😀'.repeat(309))).toBe(false) // 1236 字节
  })
})

describe('isShareableTrack —— 可分享判定', () => {
  it('有 http(s) 地址的 B 站曲目可分享', () => {
    expect(isShareableTrack(track())).toBe(true)
    expect(isShareableTrack(track({ videoUrl: 'http://www.bilibili.com/video/BV1xx411c7mD' }))).toBe(true)
  })

  it('localPath 有值即不可分享，即使它同时带着 videoUrl', () => {
    expect(isShareableTrack(track({ localPath: 'D:\\音乐\\晴天.flac' }))).toBe(false)
    expect(isShareableTrack(localTrack(1))).toBe(false)
  })

  it('地址为空 / 只有空白 / 非 http(s) 协议都不可分享', () => {
    expect(isShareableTrack(track({ videoUrl: '' }))).toBe(false)
    expect(isShareableTrack(track({ videoUrl: '   ' }))).toBe(false)
    expect(isShareableTrack(track({ videoUrl: 'file:///D:/音乐/晴天.flac' }))).toBe(false)
    expect(isShareableTrack(track({ videoUrl: 'ftp://example.com/a.mp3' }))).toBe(false)
  })
})

describe('buildTrackShare / shareNotice —— 单曲', () => {
  it('B 站曲目：payload 就是该地址，shareable=true，无需提示', () => {
    const t = track()
    const share = buildTrackShare(t)
    expect(share.kind).toBe('track')
    expect(share.payload).toBe(t.videoUrl)
    expect(share.shareable).toBe(true)
    // 复制文本比二维码内容更完整：带「歌手 - 标题」
    expect(share.text).toBe('周杰伦 - 晴天\n' + t.videoUrl)
    expect(shareNotice(share)).toBeNull()
  })

  it('本地曲目：shareable=false，payload 为空，提示非空', () => {
    const t = localTrack(1)
    const share = buildTrackShare(t)
    expect(share.kind).toBe('track')
    expect(share.shareable).toBe(false)
    expect(share.payload).toBe('')
    const notice = shareNotice(share)
    expect(notice).not.toBeNull()
    expect(typeof notice).toBe('string')
    expect((notice as string).length).toBeGreaterThan(0)
    expect(notice).toContain('可分享')
  })

  it('地址两端的空白会被裁掉，不进入二维码内容', () => {
    const t = track({ videoUrl: '  ' + BILI + 'BV1xx411c7mD  ' })
    const share = buildTrackShare(t)
    expect(share.shareable).toBe(true)
    expect(share.payload).toBe(BILI + 'BV1xx411c7mD')
  })
})

describe('buildPlaylistShare —— 空歌单', () => {
  it('total / included / dropped 全为 0，且提示非空（不能是 null）', () => {
    const result = buildPlaylistShare(playlist([]))
    expect(result.kind).toBe('playlist')
    expect(result.total).toBe(0)
    expect(result.included).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.payload).toBe('我的歌单')
    expect(result.text).toBe('我的歌单')
    const notice = shareNotice(result)
    expect(notice).not.toBeNull()
    expect((notice as string).length).toBeGreaterThan(0)
    expect(notice).toContain('可分享')
  })

  it('歌单名为空白时标题回落为「未命名歌单」', () => {
    const result = buildPlaylistShare(playlist([], '   '))
    expect(result.payload).toBe('未命名歌单')
    expect(result.text).toBe('未命名歌单')
  })

  it('整单都是本地曲目时，等同空歌单', () => {
    const result = buildPlaylistShare(playlist([localTrack(1), localTrack(2)]))
    expect(result.total).toBe(0)
    expect(result.included).toBe(0)
    expect(result.dropped).toBe(0)
    expect(shareNotice(result)).not.toBeNull()
  })
})

describe('buildPlaylistShare —— 超长歌单（核心不变式：二维码内容永不超限）', () => {
  const big = playlist(Array.from({ length: 40 }, (_, i) => biliTrack(i, { title: longTitle(i), artist: '歌手' })))

  it('装不下时 dropped > 0、included < total，payload 仍不超过 SHARE_QR_MAX_BYTES', () => {
    const result = buildPlaylistShare(big)
    expect(result.total).toBe(40)
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.included).toBeLessThan(result.total)
    expect(result.included).toBeGreaterThan(0) // 至少放得进第一首
    expect(result.dropped).toBe(result.total - result.included)
    // ★ 核心不变式：二维码里放的内容始终在容量内
    expect(utf8Bytes(result.payload)).toBeLessThanOrEqual(SHARE_QR_MAX_BYTES)
    expect(fitsInQr(result.payload)).toBe(true)
  })

  it('included 是真正放进去的连续前缀，再多放一首就会超限', () => {
    const result = buildPlaylistShare(big)
    const entries = entriesOf(result.text)
    expect(entries).toHaveLength(40)
    const prefix = [result.payload.split('\n')[0], ...entries.slice(0, result.included)].join('\n')
    expect(result.payload).toBe(prefix)
    // 边界是紧的：再塞下一首就必然超限（否则 included 就不是「最大值」）
    const oneMore = [result.payload, entries[result.included]].join('\n')
    expect(utf8Bytes(oneMore)).toBeGreaterThan(SHARE_QR_MAX_BYTES)
  })

  it('提示文案里带上 included 的数字（告知「已放前 N 首」，绝不静默截断）', () => {
    const result = buildPlaylistShare(big)
    const notice = shareNotice(result)
    expect(notice).not.toBeNull()
    expect(notice).toContain('已放前 ' + result.included + ' 首')
    expect(notice).toContain('共 ' + result.total + ' 首')
    expect(notice).toContain(String(result.included))
  })

  it('任何规模下 payload 都不超限（1 / 5 / 40 / 200 首）', () => {
    for (const n of [1, 5, 40, 200]) {
      const tracks = Array.from({ length: n }, (_, i) => biliTrack(i, { title: longTitle(i), artist: '歌手' }))
      const result = buildPlaylistShare(playlist(tracks))
      expect(result.total).toBe(n)
      expect(fitsInQr(result.payload)).toBe(true)
      expect(utf8Bytes(result.payload)).toBeLessThanOrEqual(SHARE_QR_MAX_BYTES)
      expect(result.included + result.dropped).toBe(result.total)
    }
  })

  it('完整文本始终包含全部曲目（复制用，不截断）', () => {
    const result = buildPlaylistShare(big)
    const entries = entriesOf(result.text)
    expect(entries).toHaveLength(40)
    expect(entries[0]).toContain(BILI + bv(0))
    expect(entries[39]).toContain(BILI + bv(39))
    // 二维码内容被截断，但复制文本没有
    expect(utf8Bytes(result.text)).toBeGreaterThan(SHARE_QR_MAX_BYTES)
  })

  it('全部装得下时 dropped = 0、included = total，且无需提示', () => {
    const small = playlist([biliTrack(1), biliTrack(2), biliTrack(3)])
    const result = buildPlaylistShare(small)
    expect(result.total).toBe(3)
    expect(result.included).toBe(3)
    expect(result.dropped).toBe(0)
    expect(result.payload).toBe(result.text)
    expect(fitsInQr(result.payload)).toBe(true)
    expect(shareNotice(result)).toBeNull()
  })
})

describe('buildPlaylistShare —— 不可分享曲目不计入 dropped', () => {
  it('混入本地曲目时 total 只数可分享的，dropped 仍为 0', () => {
    const mixed = playlist([biliTrack(1), localTrack(2), biliTrack(3), localTrack(4)])
    const result = buildPlaylistShare(mixed)
    expect(result.total).toBe(2) // 本地曲目根本不进清单
    expect(result.included).toBe(2)
    expect(result.dropped).toBe(0) // 没有被容量挡掉的
    expect(shareNotice(result)).toBeNull()
    expect(result.text).not.toContain('.flac')
  })

  it('既超容量又混入本地曲目时，dropped 只反映容量截断', () => {
    const tracks: Track[] = []
    for (let i = 0; i < 40; i++) {
      tracks.push(biliTrack(i, { title: longTitle(i), artist: '歌手' }))
      if (i % 3 === 0) tracks.push(localTrack(100 + i)) // 每三首插一个本地曲目
    }
    const result = buildPlaylistShare(playlist(tracks))
    expect(result.total).toBe(40) // 本地曲目（14 个）不计入
    expect(result.dropped).toBe(result.total - result.included)
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.dropped).toBeLessThan(40) // 没有把不可分享的也算成 dropped
    expect(utf8Bytes(result.payload)).toBeLessThanOrEqual(SHARE_QR_MAX_BYTES)
    expect(result.text).not.toContain('.flac')
  })
})

describe('buildShare —— 重载分派', () => {
  it('传 Playlist 走歌单分支', () => {
    const result = buildShare(playlist([biliTrack(1), biliTrack(2)]))
    expect(result.kind).toBe('playlist')
    expect(result.total).toBe(2)
    expect(result.included).toBe(2)
    expect(result.payload).toBe(result.text)
  })

  it('传 Track 走单曲分支', () => {
    const t = biliTrack(1)
    const result = buildShare(t)
    expect(result.kind).toBe('track')
    expect(result.shareable).toBe(true)
    expect(result.payload).toBe(t.videoUrl)
  })

  it('本地曲目走单曲分支时同样判为不可分享', () => {
    const result = buildShare(localTrack(1))
    expect(result.kind).toBe('track')
    expect(result.shareable).toBe(false)
    expect(shareNotice(result)).not.toBeNull()
  })
})

describe('特殊字符 —— 换行 / 制表符 / 引号 / 中文 / emoji', () => {
  const title = '歌名\n副歌\t"引号" 中文😀'

  it('字节计数按实际内容累加（中文 3、emoji 4、换行与制表符各 1）', () => {
    // 歌名 6 + \n 1 + 副歌 6 + \t 1 + " 1 + 引号 6 + " 1 + 空格 1 + 中文 6 + 😀 4
    expect(utf8Bytes(title)).toBe(6 + 1 + 6 + 1 + 1 + 6 + 1 + 1 + 6 + 4)
    expect(utf8Bytes(title)).toBe(33)
    expect(utf8Bytes(title)).toBe(new TextEncoder().encode(title).length)
  })

  it('引号与 emoji 原样进入分享文本，不做转义', () => {
    const share = buildTrackShare(track({ title, artist: '歌手' }))
    expect(share.text).toContain('"引号"')
    expect(share.text).toContain('😀')
    // 二维码里只放地址，标题不污染二维码内容
    expect(share.payload).toBe(BILI + 'BV1xx411c7mD')
  })

  it('标题里的换行/制表符会被压成单个空格，「一首一行」结构不被破坏', () => {
    // 清单的结构约定是「一首 = 标题行 + 地址行」。
    // 标题含换行时若不压平，一首歌会散成多行，扫码的人看到的是错位清单。
    const result = buildPlaylistShare(playlist([track({ title, artist: '歌手' })], '歌单'))
    expect(result.included).toBe(1)
    expect(result.dropped).toBe(0)
    const lines = result.payload.split('\n')
    // 歌单名 1 行 + 标题行 1 行 + 地址行 1 行 = 3 行
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('歌单')
    expect(lines[1]).toBe('歌手 - 歌名 副歌 "引号" 中文😀')
    expect(lines[2]).toBe(BILI + 'BV1xx411c7mD')
    // 压平之后不应残留任何换行/制表符
    expect(result.payload).not.toMatch(/[\t]/)
  })

  it('单曲分享文本同样把标题压成一行', () => {
    const share = buildTrackShare(track({ title, artist: '歌手' }))
    expect(share.text).toBe('歌手 - 歌名 副歌 "引号" 中文😀\n' + BILI + 'BV1xx411c7mD')
    expect(share.text.split('\n')).toHaveLength(2)
  })
})

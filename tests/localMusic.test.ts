import { describe, it, expect } from 'vitest'
import {
  AUDIO_EXTS,
  baseNameWithoutExt,
  buildLocalTrack,
  isMissing,
  localTrackId,
  mergeLocalTracks,
  parseFileName,
  pickMissingTracks,
  scanNotice,
  sortLocalTracks,
} from '../src/services/localMusic'
import type { Track } from '../src/types'

function makeTrack(over: Partial<Track> = {}): Track {
  const base: Track = {
    id: 'id-1',
    title: '标题',
    artist: '歌手',
    coverUrl: '',
    duration: 0,
    videoUrl: '',
    bvid: '',
    playCount: 0,
    isLiked: false,
  }
  return { ...base, ...over }
}

describe('AUDIO_EXTS', () => {
  it('覆盖五种常见音频扩展名', () => {
    expect([...AUDIO_EXTS]).toEqual(['.mp3', '.flac', '.m4a', '.wav', '.ogg'])
  })
})

describe('localTrackId：同一路径必须恒等', () => {
  const p = 'C:\\Music\\周杰伦\\稻香.mp3'

  it('同一路径重复调用得到同一个 id（重复扫描不能换 id，否则收藏全丢）', () => {
    expect(localTrackId(p)).toBe(localTrackId(p))
    expect(localTrackId(p)).toBe(localTrackId(p))
  })

  it('id 是路径的纯函数：不掺时间、随机数或调用次序', () => {
    // 同一毫秒内连调两次证明不了「不掺时间」——把时钟推后一年再算一次。
    // 这条用例专门挡「id 里混进 Date.now()/Math.random()」这类写法：
    // 那样每次扫描都会把整个曲库当成新歌，收藏、播放统计全部丢失。
    const realNow = Date.now
    const realRandom = Math.random
    const first = localTrackId(p)
    try {
      Date.now = () => realNow() + 365 * 24 * 3600 * 1000
      Math.random = () => 0.999999
      expect(localTrackId(p)).toBe(first)
    } finally {
      Date.now = realNow
      Math.random = realRandom
    }
    expect(localTrackId(p)).toBe(first)
  })

  it('大小写不敏感', () => {
    expect(localTrackId('C:\\Music\\A.mp3')).toBe(localTrackId('c:\\music\\a.mp3'))
    expect(localTrackId('C:\\Music\\A.mp3')).toBe(localTrackId('C:\\MUSIC\\a.MP3'))
  })

  it('不同路径得到不同 id', () => {
    const paths = [
      'C:\\Music\\a.mp3',
      'C:\\Music\\b.mp3',
      'C:\\Music\\a.flac',
      'D:\\Music\\a.mp3',
      'C:\\Music\\子目录\\a.mp3',
      '/home/user/a.mp3',
      '',
    ]
    const ids = paths.map(localTrackId)
    expect(new Set(ids).size).toBe(paths.length)
  })

  it('格式为 local_ 前缀 + 16 位十六进制', () => {
    for (const path of ['C:\\Music\\a.mp3', '/tmp/x.flac', '']) {
      expect(localTrackId(path)).toMatch(/^local_[0-9a-f]{16}$/)
    }
  })
})

describe('baseNameWithoutExt', () => {
  it('取文件名主体，去掉目录与扩展名', () => {
    expect(baseNameWithoutExt('C:\\Music\\周杰伦\\稻香.mp3')).toBe('稻香')
    expect(baseNameWithoutExt('/home/u/a.flac')).toBe('a')
  })

  it('没有扩展名时原样返回', () => {
    expect(baseNameWithoutExt('C:\\Music\\稻香')).toBe('稻香')
  })

  it('以点开头的文件名不被当成扩展名', () => {
    expect(baseNameWithoutExt('C:\\Music\\.hidden')).toBe('.hidden')
  })

  it('多个点只去掉最后一段', () => {
    expect(baseNameWithoutExt('C:\\Music\\a.b.mp3')).toBe('a.b')
  })
})

describe('parseFileName：从文件名猜「歌手 - 标题」', () => {
  it('"周杰伦 - 稻香" → 歌手 + 标题', () => {
    expect(parseFileName('C:\\Music\\周杰伦 - 稻香.mp3')).toEqual({ title: '稻香', artist: '周杰伦' })
  })

  it('"01. 周杰伦 - 稻香" → 先去掉前导序号', () => {
    expect(parseFileName('C:\\Music\\01. 周杰伦 - 稻香.mp3')).toEqual({ title: '稻香', artist: '周杰伦' })
  })

  it('"01 - 稻香" 与 "[01]. 稻香" 的前导序号也能去掉', () => {
    expect(parseFileName('C:\\Music\\01 - 稻香.mp3')).toEqual({ title: '稻香', artist: '' })
    expect(parseFileName('C:\\Music\\[01]. 稻香.mp3')).toEqual({ title: '稻香', artist: '' })
  })

  it('"稻香"（无歌手）→ artist 留空', () => {
    expect(parseFileName('C:\\Music\\稻香.mp3')).toEqual({ title: '稻香', artist: '' })
  })

  it('全角分隔符 "－" 也能劈开', () => {
    expect(parseFileName('C:\\Music\\周杰伦 － 稻香.mp3')).toEqual({ title: '稻香', artist: '周杰伦' })
  })

  it('破折号 "—" 也能劈开', () => {
    expect(parseFileName('C:\\Music\\周杰伦 — 稻香.mp3')).toEqual({ title: '稻香', artist: '周杰伦' })
  })

  it('"AC-DC" 这类不该被劈开的名字保持完整', () => {
    expect(parseFileName('C:\\Music\\AC-DC.mp3')).toEqual({ title: 'AC-DC', artist: '' })
    expect(parseFileName('C:\\Music\\AC-DC - Back In Black.mp3')).toEqual({ title: 'Back In Black', artist: 'AC-DC' })
  })

  it('空文件名不崩', () => {
    expect(() => parseFileName('')).not.toThrow()
    expect(parseFileName('')).toEqual({ title: '', artist: '' })
    expect(parseFileName('C:\\Music\\')).toEqual({ title: 'C:\\Music\\', artist: '' })
  })
})

describe('buildLocalTrack', () => {
  const filePath = 'C:\\Music\\周杰伦 - 稻香.mp3'

  it('有标签时用标签，localPath 指向真实文件，bvid / videoUrl 留空', () => {
    const t = buildLocalTrack(filePath, { title: '稻香', artist: '周杰伦', album: '魔杰座', duration: 223, source: 'id3v2' })
    expect(t.title).toBe('稻香')
    expect(t.artist).toBe('周杰伦')
    expect(t.duration).toBe(223)
    expect(t.localPath).toBe(filePath)
    expect(t.bvid).toBe('')
    expect(t.videoUrl).toBe('')
    expect(t.coverUrl).toBe('')
    expect(t.playCount).toBe(0)
    expect(t.isLiked).toBe(false)
    expect(t.id).toBe(localTrackId(filePath))
  })

  it('没有标签时退回文件名', () => {
    const t = buildLocalTrack(filePath, null)
    expect(t.title).toBe('稻香')
    expect(t.artist).toBe('周杰伦')
    expect(t.duration).toBe(0)
  })

  it('标签里只有标题时，歌手仍从文件名补', () => {
    const t = buildLocalTrack(filePath, { title: '稻香(live)', source: 'id3v2' })
    expect(t.title).toBe('稻香(live)')
    expect(t.artist).toBe('周杰伦')
  })

  it('标签字段是空串或纯空白时同样退回文件名', () => {
    const t1 = buildLocalTrack(filePath, { title: '', artist: '', source: 'id3v1' })
    expect(t1.title).toBe('稻香')
    expect(t1.artist).toBe('周杰伦')
    const t2 = buildLocalTrack(filePath, { title: '   ', artist: '  ', source: 'id3v1' })
    expect(t2.title).toBe('稻香')
    expect(t2.artist).toBe('周杰伦')
  })

  it('addedAt 是合法的 ISO 时间', () => {
    const t = buildLocalTrack(filePath, null)
    expect(typeof t.addedAt).toBe('string')
    expect(Number.isNaN(Date.parse(t.addedAt as string))).toBe(false)
  })

  it('同一路径两次构建得到同一个 id', () => {
    expect(buildLocalTrack(filePath, null).id).toBe(buildLocalTrack(filePath, null).id)
  })
})

describe('mergeLocalTracks', () => {
  const A = 'C:\\Music\\a.mp3'
  const B = 'C:\\Music\\b.mp3'

  it('同路径保留旧条目的收藏状态与加入时间，只更新标题/歌手/时长', () => {
    const existing = [
      makeTrack({ id: 'local_a', localPath: A, title: '旧标题', artist: '旧歌手', duration: 1, isLiked: true, playCount: 7, addedAt: '2024-01-01T00:00:00.000Z' }),
    ]
    const scanned = [makeTrack({ id: 'local_a', localPath: A, title: '新标题', artist: '新歌手', duration: 200 })]

    const merged = mergeLocalTracks(existing, scanned)
    expect(merged).toHaveLength(1)
    const a = merged[0]
    expect(a.title).toBe('新标题')
    expect(a.artist).toBe('新歌手')
    expect(a.duration).toBe(200)
    expect(a.isLiked).toBe(true)
    expect(a.playCount).toBe(7)
    expect(a.addedAt).toBe('2024-01-01T00:00:00.000Z')
    expect(a.id).toBe('local_a')
  })

  it('本次没扫到的旧条目不删除（外接盘没插时不能误删曲库）', () => {
    const existing = [
      makeTrack({ id: 'local_a', localPath: A, title: 'A', isLiked: true }),
      makeTrack({ id: 'local_b', localPath: B, title: 'B', isLiked: true }),
    ]
    const scanned = [makeTrack({ id: 'local_a', localPath: A, title: 'A 新' })]

    const merged = mergeLocalTracks(existing, scanned)
    expect(merged).toHaveLength(2)
    expect(merged.map((t) => t.localPath)).toContain(B)
    const b = merged.find((t) => t.localPath === B)
    expect(b?.title).toBe('B')
    expect(b?.isLiked).toBe(true)
  })

  it('本次一个文件都没扫到时，旧条目原样保留', () => {
    const existing = [makeTrack({ localPath: A, title: 'A' }), makeTrack({ localPath: B, title: 'B' })]
    const merged = mergeLocalTracks(existing, [])
    expect(merged).toHaveLength(2)
    expect(merged.map((t) => t.title)).toEqual(['A', 'B'])
  })

  it('大小写不同的同一路径视为同一条', () => {
    const existing = [makeTrack({ id: 'local_a', localPath: 'C:\\Music\\A.mp3', title: '旧', isLiked: true })]
    const scanned = [makeTrack({ id: 'local_a', localPath: 'c:\\music\\a.MP3', title: '新' })]

    const merged = mergeLocalTracks(existing, scanned)
    expect(merged).toHaveLength(1)
    expect(merged[0].title).toBe('新')
    expect(merged[0].isLiked).toBe(true)
    // localPath 更新成本次扫描到的写法
    expect(merged[0].localPath).toBe('c:\\music\\a.MP3')
  })

  it('扫描结果里没有 localPath 的条目不会被写进本地库', () => {
    const merged = mergeLocalTracks([], [makeTrack({ id: 'bili_1', title: 'B 站曲目' })])
    expect(merged).toHaveLength(0)
  })

  it('空索引 + 扫描结果 = 扫描结果', () => {
    const scanned = [makeTrack({ localPath: A, title: 'A' }), makeTrack({ localPath: B, title: 'B' })]
    expect(mergeLocalTracks([], scanned).map((t) => t.title)).toEqual(['A', 'B'])
  })

  it('新扫到的曲目追加在旧条目之后', () => {
    const existing = [makeTrack({ localPath: A, title: 'A' })]
    const scanned = [makeTrack({ localPath: B, title: 'B' })]
    expect(mergeLocalTracks(existing, scanned).map((t) => t.title)).toEqual(['A', 'B'])
  })

  it('不修改传入的两个数组', () => {
    const existing = [makeTrack({ localPath: A, title: '旧' })]
    const scanned = [makeTrack({ localPath: A, title: '新' }), makeTrack({ localPath: B, title: 'B' })]
    mergeLocalTracks(existing, scanned)
    expect(existing).toHaveLength(1)
    expect(existing[0].title).toBe('旧')
    expect(scanned).toHaveLength(2)
  })
})

describe('sortLocalTracks', () => {
  it('先按歌手，再按标题', () => {
    const tracks = [
      makeTrack({ title: 'b', artist: 'Zed' }),
      makeTrack({ title: 'z', artist: 'Alice' }),
      makeTrack({ title: 'a', artist: 'Alice' }),
      makeTrack({ title: 'c', artist: 'Bob' }),
    ]
    expect(sortLocalTracks(tracks).map((t) => t.artist + '/' + t.title)).toEqual([
      'Alice/a',
      'Alice/z',
      'Bob/c',
      'Zed/b',
    ])
  })

  it('不修改原数组，返回新数组', () => {
    const tracks = [makeTrack({ title: 'b', artist: 'B' }), makeTrack({ title: 'a', artist: 'A' })]
    const sorted = sortLocalTracks(tracks)
    expect(sorted).not.toBe(tracks)
    expect(tracks.map((t) => t.artist)).toEqual(['B', 'A'])
    expect(sorted.map((t) => t.artist)).toEqual(['A', 'B'])
  })

  it('空数组与单元素不崩', () => {
    expect(sortLocalTracks([])).toEqual([])
    const one = [makeTrack({ title: 'x', artist: 'y' })]
    expect(sortLocalTracks(one)).toHaveLength(1)
  })
})

describe('isMissing / pickMissingTracks', () => {
  const A = 'C:\\Music\\a.mp3'
  const B = 'C:\\Music\\b.mp3'

  it('文件还在 → 不标记', () => {
    expect(isMissing(makeTrack({ localPath: A }), new Set([A.toLowerCase()]))).toBe(false)
  })

  it('文件不在 → 标记', () => {
    expect(isMissing(makeTrack({ localPath: B }), new Set([A.toLowerCase()]))).toBe(true)
  })

  it('没有 localPath 的条目（B 站曲目）不标记', () => {
    expect(isMissing(makeTrack({ id: 'bili_1' }), new Set())).toBe(false)
    expect(isMissing(makeTrack({ id: 'bili_1' }), new Set([A.toLowerCase()]))).toBe(false)
  })

  it('大小写不同视为同一个文件', () => {
    expect(isMissing(makeTrack({ localPath: 'C:\\Music\\A.MP3' }), new Set(['c:\\music\\a.mp3']))).toBe(false)
  })

  it('pickMissingTracks 只挑出真正丢失的本地条目', () => {
    const tracks = [
      makeTrack({ localPath: A, title: 'A' }),
      makeTrack({ localPath: B, title: 'B' }),
      makeTrack({ id: 'bili_1', title: 'B 站曲目' }),
    ]
    const missing = pickMissingTracks(tracks, new Set([A.toLowerCase()]))
    expect(missing.map((t) => t.title)).toEqual(['B'])
  })

  it('全部存在时返回空数组', () => {
    const tracks = [makeTrack({ localPath: A }), makeTrack({ localPath: B })]
    expect(pickMissingTracks(tracks, new Set([A.toLowerCase(), B.toLowerCase()]))).toEqual([])
  })
})

describe('scanNotice：正常返回 null，其余必须说清', () => {
  it('全部正常 → null', () => {
    expect(scanNotice({ ok: true, files: [1, 2, 3] })).toBeNull()
    expect(scanNotice({ ok: true, files: [1, 2, 3], skipped: 0 })).toBeNull()
  })

  it('取消 → 非空文案', () => {
    expect(scanNotice({ ok: false, canceled: true })).toBe('已取消扫描')
    // 取消优先于失败
    expect(scanNotice({ ok: false, canceled: true, message: '别的话' })).toBe('已取消扫描')
  })

  it('失败 → 用 message，没有 message 时给默认文案', () => {
    expect(scanNotice({ ok: false, message: '没有读取权限' })).toBe('没有读取权限')
    expect(scanNotice({ ok: false })).toBe('扫描失败')
  })

  it('空目录 → 非空文案', () => {
    expect(scanNotice({ ok: true, files: [] })).toBe('这个目录里没有找到音频文件')
    expect(scanNotice({ ok: true })).toBe('这个目录里没有找到音频文件')
  })

  it('截断 → 带上数量和原因', () => {
    const msg = scanNotice({ ok: true, files: [1, 2], truncated: true, truncatedReason: '超过 5000 个文件' })
    expect(msg).toBeTruthy()
    expect(msg).toContain('已扫描 2 个文件')
    expect(msg).toContain('超过 5000 个文件')
    expect(msg).toContain('可分批导入')
  })

  it('截断但没给原因 → 用「达到上限」兜底', () => {
    expect(scanNotice({ ok: true, files: [1], truncated: true })).toContain('达到上限')
  })

  it('有跳过 → 文案里带跳过数量', () => {
    const msg = scanNotice({ ok: true, files: [1, 2, 3], skipped: 4 })
    expect(msg).toBeTruthy()
    expect(msg).toContain('已扫描 3 个文件')
    expect(msg).toContain('跳过 4 个')
  })

  it('截断优先于跳过', () => {
    const msg = scanNotice({ ok: true, files: [1], truncated: true, skipped: 9 })
    expect(msg).toContain('可分批导入')
    expect(msg).not.toContain('跳过 9 个')
  })

  it('六种情况下只有「全部正常」返回 null', () => {
    const cases: Parameters<typeof scanNotice>[0][] = [
      { ok: true, files: [1] },
      { ok: false, canceled: true },
      { ok: false, message: '炸了' },
      { ok: true, files: [] },
      { ok: true, files: [1], truncated: true },
      { ok: true, files: [1], skipped: 1 },
    ]
    const notices = cases.map((c) => scanNotice(c))
    expect(notices[0]).toBeNull()
    for (const n of notices.slice(1)) {
      expect(typeof n).toBe('string')
      expect((n as string).length).toBeGreaterThan(0)
    }
  })
})

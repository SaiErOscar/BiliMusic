import { describe, it, expect } from 'vitest'
import {
  parseLrc,
  cleanTitle,
  dice,
  mergeDedup,
  normalizeCandidate,
  normalizeNetease,
  normalizeLrclib,
  type LyricCandidate,
} from '../src/services/lyrics'

// 构造一个完整的 LyricCandidate，用于 mergeDedup 测试
function cand(over: Partial<LyricCandidate>): LyricCandidate {
  return {
    id: over.id || 'qq:0',
    songId: over.songId ?? 0,
    source: over.source || 'qq',
    mid: over.mid || '',
    trackName: over.trackName || '',
    artistName: over.artistName || '',
    albumName: over.albumName || '',
    duration: over.duration || 0,
    image: over.image || '',
  }
}

describe('normalizeCandidate 源前缀 id', () => {
  it('QQ 候选 id 带 qq: 前缀', () => {
    const c = normalizeCandidate({ name: '告白', singer: ['沈以诚'], album: '告白', mid: 'abc', id: 123, album_mid: '', duration: 258, image: '' } as any)
    expect(c).not.toBeNull()
    expect(c!.id).toBe('qq:123')
    expect(c!.songId).toBe(123)
    expect(c!.source).toBe('qq')
    expect(c!.artistName).toBe('沈以诚')
  })

  it('网易云候选 id 带 ne: 前缀且毫秒时长折算为秒', () => {
    const c = normalizeNetease({ name: '告白', id: 1336856449, artists: [{ name: '沈以诚' }], album: { name: '告白' }, duration: 258000 } as any)
    expect(c!.id).toBe('ne:1336856449')
    expect(c!.source).toBe('netease')
    expect(c!.duration).toBe(258)
  })

  it('LRCLIB 候选 id 带 lc: 前缀', () => {
    const c = normalizeLrclib({ id: 34556231, trackName: '告白', artistName: '沈以诚', albumName: '告白', duration: 258 } as any)
    expect(c!.id).toBe('lc:34556231')
    expect(c!.source).toBe('lrclib')
  })

  it('缺字段的行返回 null', () => {
    expect(normalizeCandidate({ name: '', id: 1 } as any)).toBeNull()
    expect(normalizeNetease({ name: 'x', id: null } as any)).toBeNull()
    expect(normalizeLrclib({ id: 1, trackName: '' } as any)).toBeNull()
  })
})

describe('mergeDedup 跨源去重', () => {
  it('同名同艺人的跨源候选只保留先到者（QQ 优先）', () => {
    const qq = cand({ id: 'qq:1', source: 'qq', trackName: '告白', artistName: '沈以诚' })
    const ne = cand({ id: 'ne:2', source: 'netease', trackName: '告白', artistName: '沈以诚' })
    const merged = mergeDedup([qq], [ne])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('qq:1')
  })

  it('同名不同艺人保留为两条', () => {
    const a = cand({ id: 'qq:1', trackName: '告白', artistName: '沈以诚' })
    const b = cand({ id: 'ne:2', source: 'netease', trackName: '告白', artistName: '吴雨霏' })
    const merged = mergeDedup([a], [b])
    expect(merged.map(m => m.id)).toEqual(['qq:1', 'ne:2'])
  })

  it('标点与大小写差异视为同一歌名（归一化去重）', () => {
    const a = cand({ id: 'qq:1', trackName: '告白气球', artistName: '周杰伦' })
    const b = cand({ id: 'ne:2', source: 'netease', trackName: '告白 气球', artistName: '周杰伦' })
    const merged = mergeDedup([a], [b])
    expect(merged).toHaveLength(1)
  })

  it('existing 已展示项在追加时保持稳定且不被新结果重复', () => {
    const existing = [cand({ id: 'qq:1', trackName: 'A', artistName: 'X' })]
    const incoming = [
      cand({ id: 'qq:1', trackName: 'A', artistName: 'X' }), // 与已展示完全重复
      cand({ id: 'ne:9', source: 'netease', trackName: 'B', artistName: 'Y' }),
    ]
    const merged = mergeDedup(existing, incoming)
    expect(merged.map(m => m.id)).toEqual(['qq:1', 'ne:9'])
  })
})

describe('parseLrc', () => {
  it('应解析标准 LRC 时间标签', () => {
    const lrc = '[00:01.00]第一行\n[00:03.50]第二行\n[00:05.00]第三行'
    const lines = parseLrc(lrc)
    expect(lines).toHaveLength(3)
    expect(lines[0].time).toBe(1)
    expect(lines[0].text).toBe('第一行')
    expect(lines[1].time).toBe(3.5)
    expect(lines[2].time).toBe(5)
  })

  it('应处理多时间标签行', () => {
    const lrc = '[00:01.00][00:03.00]重复歌词'
    const lines = parseLrc(lrc)
    expect(lines).toHaveLength(2)
    expect(lines[0].time).toBe(1)
    expect(lines[1].time).toBe(3)
    expect(lines[0].text).toBe('重复歌词')
  })

  it('应跳过空行和元数据行', () => {
    const lrc = '[ti:歌曲名]\n[ar:歌手]\n[00:01.00]实际歌词\n\n[by:制作]'
    const lines = parseLrc(lrc)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('实际歌词')
  })

  it('应处理毫秒精度', () => {
    const lrc = '[00:01.123]毫秒测试'
    const lines = parseLrc(lrc)
    expect(lines[0].time).toBeCloseTo(1.123, 3)
  })

  it('空输入返回空数组', () => {
    expect(parseLrc('')).toEqual([])
  })
})

describe('cleanTitle', () => {
  it('应移除噪声关键词', () => {
    expect(cleanTitle('歌曲名 Official MV')).toBe('歌曲名')
    expect(cleanTitle('歌曲名 官方版')).toBe('歌曲名')
    expect(cleanTitle('歌曲名 [完整版]')).toBe('歌曲名')
  })

  it('应保留书名号内容', () => {
    const result = cleanTitle('《歌曲名》官方版')
    expect(result).toContain('歌曲名')
    expect(result).not.toContain('官方')
  })

  it('空输入返回空字符串', () => {
    expect(cleanTitle('')).toBe('')
  })

  it('移除 emoji', () => {
    const result = cleanTitle('歌曲名🎵MV')
    expect(result).not.toContain('🎵')
  })
})

describe('dice', () => {
  it('相同字符串返回1', () => {
    expect(dice('hello', 'hello')).toBe(1)
  })

  it('完全不同返回0', () => {
    expect(dice('abc', 'xyz')).toBe(0)
  })

  it('包含关系返回高分数', () => {
    const score = dice('歌曲名', '歌曲名 remix')
    expect(score).toBeGreaterThan(0.5)
  })

  it('空字符串返回0', () => {
    expect(dice('', 'test')).toBe(0)
    expect(dice('test', '')).toBe(0)
  })
})

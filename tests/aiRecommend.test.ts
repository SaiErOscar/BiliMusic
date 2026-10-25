// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { parseRecommendation, timeContext } from '../src/services/aiRecommend'
import type { AiPlaylistCandidate } from '../src/services/aiPlaylist'

// v1.4.12-pre2：推荐解析与时段推断（纯逻辑）。

function cand(idx: number, id: string): AiPlaylistCandidate {
  return {
    index: idx,
    track: { id, title: 'T' + id, artist: 'A', coverUrl: '', duration: 0, videoUrl: '', bvid: '', playCount: 0, isLiked: false },
  }
}

describe('时段推断', () => {
  it('按小时给出中文时段', () => {
    const at = (h: number) => timeContext(new Date(2026, 0, 1, h, 0, 0)).label
    expect(at(6)).toBe('清晨')
    expect(at(10)).toBe('上午')
    expect(at(12)).toBe('中午')
    expect(at(15)).toBe('下午')
    expect(at(20)).toBe('晚上')
    expect(at(2)).toBe('深夜')
  })
})

describe('推荐结果解析', () => {
  const pool = [cand(1, 'a'), cand(2, 'b'), cand(3, 'c')]

  it('解析问候语与推荐曲目', () => {
    const r = parseRecommendation('{"greeting":"晚上好","picks":[{"index":1,"reason":"安静"},{"index":3,"reason":"轻快"}]}', pool)
    expect(r.greeting).toBe('晚上好')
    expect(r.picked.map((p) => p.track.id)).toEqual(['a', 'c'])
    expect(r.picked[0].reason).toBe('安静')
  })

  it('编造编号被丢弃，不塞进推荐', () => {
    const r = parseRecommendation('{"greeting":"x","picks":[{"index":99,"reason":"假"},{"index":2}]}', pool)
    expect(r.picked.map((p) => p.track.id)).toEqual(['b'])
  })

  it('重复编号去重', () => {
    const r = parseRecommendation('{"picks":[{"index":1},{"index":1}]}', pool)
    expect(r.picked).toHaveLength(1)
  })

  it('容忍代码围栏', () => {
    const r = parseRecommendation('```json\n{"greeting":"hi","picks":[{"index":2}]}\n```', pool)
    expect(r.greeting).toBe('hi')
    expect(r.picked[0].track.id).toBe('b')
  })

  it('无 JSON 时抛可读错误', () => {
    expect(() => parseRecommendation('做不到', pool)).toThrow('JSON')
  })
})

describe('推荐方式与隐私约束', () => {
  it('默认点击后推荐（省费用）', () => {
    const src = readFileSync(path.resolve(__dirname, '../electron/ai.ts'), 'utf8')
    expect(src).toMatch(/recommendMode: 'click'/)
  })

  it('三种模式都存在', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8')
    for (const m of ['click', 'auto', 'off']) expect(src).toContain('value="' + m + '"')
  })

  it('用户画像只发聚合与自述，不发逐曲明细', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiRecommend.ts'), 'utf8')
    expect(src).toContain('renderSummary(portrait')
    expect(src).not.toContain('JSON.stringify(stats')
  })
})

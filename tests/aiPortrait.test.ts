// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { PORTRAIT_RANGE_LABELS, renderSummary, summarize } from '../src/services/aiPortrait'
import type { PlayStat } from '../src/utils/storage'

// v1.4.12-pre1：听歌画像的本地聚合口径（纯函数）。
// LLM 生成效果无法在 jsdom 里测，这里守住「统计算得对」与「只发聚合不发明细」。

function stat(over: Partial<PlayStat>): PlayStat {
  const now = new Date().toISOString()
  return {
    id: 'x', title: 't', artist: 'a', plays: 1, seconds: 60, completions: 0,
    firstAt: now, lastAt: now, ...over,
  }
}

describe('画像摘要聚合', () => {
  it('汇总曲目数、播放次数、小时数与完成率', () => {
    const stats = {
      a: stat({ id: 'a', plays: 3, seconds: 1800, completions: 2 }),
      b: stat({ id: 'b', plays: 1, seconds: 1800, completions: 0 }),
    }
    const s = summarize(stats, 'all')
    expect(s.trackCount).toBe(2)
    expect(s.totalPlays).toBe(4)
    expect(s.totalHours).toBe(1)
    expect(s.completionRate).toBe(0.5)
  })

  it('常听曲目按播放次数降序，最多 10 条', () => {
    const stats: Record<string, PlayStat> = {}
    for (let i = 0; i < 15; i++) stats['t' + i] = stat({ id: 't' + i, title: 'T' + i, plays: i + 1 })
    const s = summarize(stats, 'all')
    expect(s.topTracks).toHaveLength(10)
    expect(s.topTracks[0].title).toBe('T14')
    expect(s.topTracks[0].plays).toBe(15)
  })

  it('常听歌手按累计播放次数聚合，最多 8 条', () => {
    const stats = {
      a: stat({ id: 'a', artist: '周杰伦', plays: 5 }),
      b: stat({ id: 'b', artist: '周杰伦', plays: 3 }),
      c: stat({ id: 'c', artist: '李荣浩', plays: 2 }),
    }
    const s = summarize(stats, 'all')
    expect(s.topArtists[0]).toEqual({ artist: '周杰伦', plays: 8 })
    expect(s.topArtists[1]).toEqual({ artist: '李荣浩', plays: 2 })
  })

  it('空歌手归入「未知歌手」', () => {
    const s = summarize({ a: stat({ id: 'a', artist: '' }) }, 'all')
    expect(s.topArtists[0].artist).toBe('未知歌手')
  })

  it('时段分布固定四个桶且总和不超总播放', () => {
    const s = summarize({ a: stat({ id: 'a', plays: 4 }) }, 'all')
    expect(s.timeBuckets).toHaveLength(4)
    const sum = s.timeBuckets.reduce((a, b) => a + b.plays, 0)
    expect(sum).toBeLessThanOrEqual(4)
  })

  it('按时间范围过滤掉过期记录', () => {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString()
    const stats = {
      old: stat({ id: 'old', lastAt: old, plays: 9 }),
      now: stat({ id: 'now', plays: 1 }),
    }
    expect(summarize(stats, 'month').trackCount).toBe(1)
    expect(summarize(stats, 'all').trackCount).toBe(2)
  })
})

describe('摘要文本渲染', () => {
  it('包含范围、总量、曲目、歌手与时段', () => {
    const s = summarize({ a: stat({ id: 'a', title: '晴天', artist: '周杰伦', plays: 2 }) }, 'month')
    const text = renderSummary(s, 'month')
    expect(text).toContain('近一个月')
    expect(text).toContain('晴天')
    expect(text).toContain('周杰伦')
    expect(text).toContain('时段分布')
  })

  it('三种范围都有中文标签', () => {
    expect(PORTRAIT_RANGE_LABELS.month).toBe('近一个月')
    expect(PORTRAIT_RANGE_LABELS.year).toBe('近一年')
    expect(PORTRAIT_RANGE_LABELS.all).toBe('全部时间')
  })
})

describe('隐私约束', () => {
  it('只发聚合摘要，不发逐曲明细', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiPortrait.ts'), 'utf8')
    // 发给模型的是 renderSummary 的输出，不是原始 stats
    expect(src).toContain('renderSummary(summary, range)')
    expect(src).not.toContain('JSON.stringify(stats')
  })
})

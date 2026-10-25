// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { EMPTY_PROFILE_CONTEXT, renderLearnedSummary, renderProfileContext } from '../src/services/aiProfileContext'

// v1.4.13-pre2：学习信号渲染与画像上下文注入。

describe('学习信号渲染', () => {
  it('空信号返回空串', () => {
    expect(renderLearnedSummary(null)).toBe('')
    expect(renderLearnedSummary({})).toBe('')
  })

  it('按次数降序，最多 8 条', () => {
    const played: Record<string, number> = {}
    for (let i = 0; i < 12; i++) played['歌手' + i + '|歌' + i] = i + 1
    const text = renderLearnedSummary({ played })
    expect(text).toContain('常被播放')
    // 最多的那条（12）必须在
    expect(text).toContain('歌手11|歌11 ×12')
    // 只取前 8 条：最少的两条不应出现
    expect(text).not.toContain('歌手0|歌0')
  })

  it('播放与跳过分开陈述', () => {
    const text = renderLearnedSummary({ played: { 'A|a': 2 }, skipped: { 'B|b': 3 } })
    expect(text).toContain('常被播放')
    expect(text).toContain('常被跳过')
  })

  it('歌单保存与歌词还原也进摘要', () => {
    const text = renderLearnedSummary({ playlistSaved: { times: 2, tracks: 15 }, lyricReverted: 3 })
    expect(text).toContain('保存 2 次')
    expect(text).toContain('15 首')
    expect(text).toContain('还原 3 次')
  })
})

describe('画像上下文渲染', () => {
  it('都为空时返回空串（不污染 prompt）', () => {
    expect(renderProfileContext(EMPTY_PROFILE_CONTEXT)).toBe('')
  })

  it('手写画像与学习信号分节标注来源', () => {
    const text = renderProfileContext({ profile: '喜欢钢琴', learned: '常被播放：A ×2' })
    expect(text).toContain('用户画像：喜欢钢琴')
    expect(text).toContain('从使用中观察到的偏好')
  })
})

describe('三个 AI 服务都注入画像', () => {
  it('推荐 / 歌单 / 歌词都引用画像上下文', () => {
    for (const f of ['aiRecommend.ts', 'aiPlaylist.ts', 'aiLyrics.ts']) {
      const src = readFileSync(path.resolve(__dirname, '../src/services/' + f), 'utf8')
      expect(src, f + ' 未注入画像').toContain('loadProfileContext')
    }
  })

  it('画像模块不依赖任何 AI 服务（避免循环依赖）', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiProfileContext.ts'), 'utf8')
    expect(src).not.toContain("from '@/services/aiPlaylist'")
    expect(src).not.toContain("from '@/services/aiRecommend'")
    expect(src).not.toContain("from '@/services/aiLyrics'")
  })
})

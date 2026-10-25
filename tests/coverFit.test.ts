// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { COVER_ASPECT_LIMIT, coverAspectRatio, shouldFollowCoverAspect } from '../src/utils/coverFit'

// v1.4.11-pre2 封面取景：三档模式 + contain 时容器跟随封面比例。
//
// 这里的断言守住的是「比例换算与钳制」这一层纯逻辑（播放页与导出舞台共用同一实现）。
// 真实的留白/裁切观感仍需真机或离屏舞台逐像素确认——jsdom 不做布局，测不出像素。

describe('封面取景模式（v1.4.11-pre2）', () => {
  it('只有 contain 需要容器跟随封面比例', () => {
    expect(shouldFollowCoverAspect('contain')).toBe(true)
    // cover 铺满、fill 拉伸都填满方框，容器没有跟随的理由
    expect(shouldFollowCoverAspect('cover')).toBe(false)
    expect(shouldFollowCoverAspect('fill')).toBe(false)
  })

  it('封面未就绪时退回 1:1，不让 NaN 撑破布局', () => {
    expect(coverAspectRatio(0, 0)).toBe(1)
    expect(coverAspectRatio(0, 900)).toBe(1)
    expect(coverAspectRatio(900, 0)).toBe(1)
  })

  it('横版封面按真实比例跟随（16:9 / 21:9 / 4:3）', () => {
    expect(coverAspectRatio(1600, 900)).toBeCloseTo(16 / 9, 5)
    expect(coverAspectRatio(1680, 720)).toBeCloseTo(21 / 9, 5)
    expect(coverAspectRatio(1200, 900)).toBeCloseTo(4 / 3, 5)
  })

  it('方图保持 1:1', () => {
    expect(coverAspectRatio(900, 900)).toBe(1)
  })

  it('竖版比例超过上限时钳到 1:1.6，避免把导出舞台撑爆', () => {
    // 9:16 = 0.5625，低于下限 1/1.6 = 0.625，必须被钳住
    expect(coverAspectRatio(720, 1280)).toBeCloseTo(1 / COVER_ASPECT_LIMIT, 5)
  })

  it('未超上限的竖版保留真实比例（3:4 = 0.75、2:3 ≈ 0.667 均高于下限 0.625）', () => {
    expect(coverAspectRatio(900, 1200)).toBeCloseTo(0.75, 5)
    expect(coverAspectRatio(800, 1200)).toBeCloseTo(2 / 3, 5)
  })

  it('钳制后的比例始终落在可渲染区间内', () => {
    const extreme = coverAspectRatio(100, 10000)
    expect(extreme).toBeGreaterThan(0)
    expect(1 / extreme).toBeCloseTo(COVER_ASPECT_LIMIT, 5)
  })
})

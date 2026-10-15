import { describe, it, expect } from 'vitest'
import { PLAYBACK_RATE_STEPS, normalizePlaybackRate, nextPlaybackRate } from '../src/utils/playbackRate'

describe('normalizePlaybackRate', () => {
  it('合法档位原样通过', () => {
    for (const step of PLAYBACK_RATE_STEPS) {
      expect(normalizePlaybackRate(step)).toBe(step)
    }
  })

  it('非档位数值归一到 1', () => {
    expect(normalizePlaybackRate(0.9)).toBe(1)
    expect(normalizePlaybackRate(3)).toBe(1)
    expect(normalizePlaybackRate(-1)).toBe(1)
    expect(normalizePlaybackRate(0)).toBe(1)
  })

  it('非有限数与非法类型归一到 1', () => {
    expect(normalizePlaybackRate(NaN)).toBe(1)
    expect(normalizePlaybackRate(Infinity)).toBe(1)
    expect(normalizePlaybackRate(-Infinity)).toBe(1)
    expect(normalizePlaybackRate('1')).toBe(1)
    expect(normalizePlaybackRate(null)).toBe(1)
    expect(normalizePlaybackRate(undefined)).toBe(1)
    expect(normalizePlaybackRate({})).toBe(1)
  })
})

describe('nextPlaybackRate', () => {
  it('沿档位表逐级前进', () => {
    expect(nextPlaybackRate(0.5)).toBe(0.75)
    expect(nextPlaybackRate(0.75)).toBe(1)
    expect(nextPlaybackRate(1)).toBe(1.25)
    expect(nextPlaybackRate(1.25)).toBe(1.5)
    expect(nextPlaybackRate(1.5)).toBe(1.75)
    expect(nextPlaybackRate(1.75)).toBe(2)
  })

  it('最高档回绕到 0.5（循环）', () => {
    expect(nextPlaybackRate(2)).toBe(0.5)
  })

  it('非法当前值先归一到 1 再前进', () => {
    expect(nextPlaybackRate(0.9)).toBe(1.25)
    expect(nextPlaybackRate(NaN)).toBe(1.25)
  })

  it('全档位走满一圈回到起点', () => {
    let rate: number = PLAYBACK_RATE_STEPS[0]
    for (let i = 0; i < PLAYBACK_RATE_STEPS.length; i++) {
      rate = nextPlaybackRate(rate)
    }
    expect(rate).toBe(PLAYBACK_RATE_STEPS[0])
  })
})

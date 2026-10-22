import { describe, expect, it } from 'vitest'
import { COMPOSE_PERCENT, DONE_PERCENT, stagePercent, stageWindow } from '../electron/exportProgress'

/**
 * v1.4.10-pre2 MV 导出进度区间分配。
 *
 * 这里守的是「进度条只前进不后退」这条用户可感知的契约：v1.4.10-pre1 的分析阶段
 * 与渲染阶段各自从 0 起算，同一次导出里进度条会来回跳两次。区间分配后，
 * 任何阶段切换处的百分比都必须严格递增。
 */

describe('导出进度区间分配（v1.4.10-pre2）', () => {
  it('三个阶段区间互不重叠且按顺序排列', () => {
    expect(stageWindow('audio')).toEqual([0, 10])
    expect(stageWindow('analyze')).toEqual([10, 25])
    expect(stageWindow('render')).toEqual([25, 99])
  })

  it('阶段内只在自己的区间里推进，最高停在终点前一位', () => {
    expect(stagePercent('audio', 0)).toBe(0)
    expect(stagePercent('audio', 1)).toBe(9)
    expect(stagePercent('analyze', 0)).toBe(10)
    expect(stagePercent('analyze', 1)).toBe(24)
    expect(stagePercent('render', 0)).toBe(25)
    expect(stagePercent('render', 1)).toBe(98)
  })

  it('整条链路单调不回退（含三处阶段切换）', () => {
    const seq: number[] = []
    for (let i = 0; i <= 100; i++) seq.push(stagePercent('audio', i / 100))
    for (let i = 0; i <= 90; i++) seq.push(stagePercent('analyze', i / 90))
    for (let i = 0; i <= 5400; i += 5) seq.push(stagePercent('render', i / 5400))
    seq.push(COMPOSE_PERCENT, DONE_PERCENT)

    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1])
    }
    expect(seq[0]).toBe(0)
    expect(seq[seq.length - 1]).toBe(100)
  })

  it('越界与脏比例被钳到区间内，不产生 NaN 或负值', () => {
    expect(stagePercent('render', -1)).toBe(25)
    expect(stagePercent('render', 2)).toBe(98)
    expect(stagePercent('render', Number.NaN)).toBe(25)
    expect(stagePercent('audio', Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('合成与完成百分比衔接在渲染阶段之上', () => {
    expect(stagePercent('render', 1)).toBeLessThan(COMPOSE_PERCENT)
    expect(COMPOSE_PERCENT).toBeLessThan(DONE_PERCENT)
  })
})

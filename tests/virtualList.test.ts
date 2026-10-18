// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { computeVisibleRange, DEFAULT_ROW_HEIGHT } from '../src/components/VirtualList'

// v1.4.9-pre4 大列表虚拟化：可见区间计算的边界覆盖。
//
// 真实组件依赖 getBoundingClientRect 与滚动事件（jsdom 里恒为 0，测不出滚动行为），
// 所以核心算术抽成纯函数 computeVisibleRange，这里直接覆盖它的边界。

describe('computeVisibleRange 可见区间', () => {
  it('顶部未滚动时从 0 开始', () => {
    const { start } = computeVisibleRange(0, 800, 68, 1000)
    expect(start).toBe(0)
  })

  it('返回的区间覆盖整个视口（渲染行数 × 行高 >= 视口高）', () => {
    const rowHeight = 68
    const viewport = 800
    const { start, end } = computeVisibleRange(0, viewport, rowHeight, 1000, 0)
    expect((end - start) * rowHeight).toBeGreaterThanOrEqual(viewport)
  })

  it('滚动到中部时区间随之下移', () => {
    const top = computeVisibleRange(0, 800, 68, 1000)
    const mid = computeVisibleRange(6800, 800, 68, 1000)
    expect(mid.start).toBeGreaterThan(top.start)
    expect(mid.end).toBeGreaterThan(top.end)
  })

  it('overscan 上下各扩，减少快速滚动白屏', () => {
    const noOverscan = computeVisibleRange(6800, 800, 68, 1000, 0)
    const withOverscan = computeVisibleRange(6800, 800, 68, 1000, 6)
    expect(withOverscan.start).toBeLessThan(noOverscan.start)
    expect(withOverscan.end).toBeGreaterThan(noOverscan.end)
  })

  it('滚到底部时 end 被 total 截断，不越界', () => {
    const total = 100
    const { start, end } = computeVisibleRange(100 * 68, 800, 68, total)
    expect(end).toBeLessThanOrEqual(total)
    expect(start).toBeLessThanOrEqual(total)
  })

  it('start 永不为负（顶部回弹/负偏移）', () => {
    expect(computeVisibleRange(-500, 800, 68, 100).start).toBe(0)
  })

  it('空列表返回零区间', () => {
    expect(computeVisibleRange(0, 800, 68, 0)).toEqual({ start: 0, end: 0 })
  })

  it('行高非法时返回零区间，不产生 Infinity/NaN', () => {
    expect(computeVisibleRange(0, 800, 0, 100)).toEqual({ start: 0, end: 0 })
    const r = computeVisibleRange(0, 800, -10, 100)
    expect(Number.isFinite(r.start)).toBe(true)
    expect(Number.isFinite(r.end)).toBe(true)
  })

  it('视口高度为 0 时至少渲染 overscan 行，不出现空白列表', () => {
    const { start, end } = computeVisibleRange(0, 0, 68, 100, 6)
    expect(end).toBeGreaterThan(start)
  })

  it('数据量小于一屏时全部落在区间内', () => {
    const total = 5
    const { start, end } = computeVisibleRange(0, 800, 68, total)
    expect(start).toBe(0)
    expect(end).toBe(total)
  })

  it('end 恒不小于 start（区间不倒挂）', () => {
    for (const scrollTop of [0, 100, 5000, 99999]) {
      const { start, end } = computeVisibleRange(scrollTop, 800, 68, 1000)
      expect(end).toBeGreaterThanOrEqual(start)
    }
  })

  it('渲染行数有上界，不随总数据量增长（虚拟化的核心保证）', () => {
    const small = computeVisibleRange(0, 800, 68, 100)
    const huge = computeVisibleRange(0, 800, 68, 100_000)
    // 同样视口下，10 万行与 100 行的渲染数量应基本一致
    expect(huge.end - huge.start).toBeLessThanOrEqual(small.end - small.start + 1)
  })

  it('默认行高与 .am-track-row 的 min-height 一致', () => {
    expect(DEFAULT_ROW_HEIGHT).toBe(68)
  })
})

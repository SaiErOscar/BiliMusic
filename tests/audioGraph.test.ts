// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import {
  ANALYSER_FFT_SIZE,
  ANALYSER_SMOOTHING,
  SPECTRUM_USABLE_RATIO,
  closeAudioGraph,
  computeBars,
  disposeAudioGraph,
  ensureAudioGraph,
  getAnalyser,
  isAudioGraphReady,
  resumeAudioGraph,
} from '../src/services/audioGraph'

// v1.4.9-pre2 音频可视化：纯函数分桶 + 无 Web Audio 环境下的降级路径。
// jsdom 没有 AudioContext，正好覆盖「拿不到音频图也必须安全返回 null」这条分支。

afterEach(() => {
  closeAudioGraph()
})

describe('computeBars 频域分桶', () => {
  it('返回长度等于请求的柱子数', () => {
    const freq = new Uint8Array(1024).fill(128)
    expect(computeBars(freq, 40)).toHaveLength(40)
  })

  it('输出全部归一化在 0..1 之间', () => {
    const freq = new Uint8Array(1024)
    for (let i = 0; i < freq.length; i++) freq[i] = i % 256
    const bars = computeBars(freq, 32)
    expect(bars.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('全 255 时柱高为 1', () => {
    const bars = computeBars(new Uint8Array(512).fill(255), 8)
    expect(bars.every((v) => v === 1)).toBe(true)
  })

  it('全 0 时柱高为 0', () => {
    const bars = computeBars(new Uint8Array(512).fill(0), 8)
    expect(bars.every((v) => v === 0)).toBe(true)
  })

  it('取每段峰值而非平均值（避免个别接近 0 的频点拉平整根柱子）', () => {
    const freq = new Uint8Array(4)
    freq[0] = 0
    freq[1] = 255
    freq[2] = 0
    freq[3] = 0
    // 全部频点都在可用段内，单桶应取到峰值 255
    const bars = computeBars(freq, 1)
    expect(bars[0]).toBe(1)
  })

  it('空数据返回全 0，不抛错', () => {
    expect(computeBars(new Uint8Array(0), 16)).toEqual(new Array(16).fill(0))
  })

  it('非法 barCount（0 / 负数 / NaN / Infinity）按 1 兜底', () => {
    const freq = new Uint8Array(64).fill(200)
    expect(computeBars(freq, 0)).toHaveLength(1)
    expect(computeBars(freq, -5)).toHaveLength(1)
    expect(computeBars(freq, NaN)).toHaveLength(1)
    expect(computeBars(freq, Infinity)).toHaveLength(1)
  })

  it('脏数据（NaN / Infinity 频点）不会污染输出', () => {
    const freq = new Float64Array([NaN, Infinity, 100, 200])
    const bars = computeBars(freq, 4)
    expect(bars.every((v) => Number.isFinite(v))).toBe(true)
    expect(bars.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('高频尾部被丢弃：只有尾部有能量时柱高保持 0', () => {
    const len = 100
    const usable = Math.floor(len * SPECTRUM_USABLE_RATIO)
    const freq = new Uint8Array(len)
    for (let i = usable; i < len; i++) freq[i] = 255
    const bars = computeBars(freq, 8)
    expect(bars.every((v) => v === 0)).toBe(true)
  })
})

describe('无 Web Audio 环境下的降级', () => {
  it('jsdom 无 AudioContext：ensureAudioGraph 返回 null 而不是抛错', () => {
    expect(ensureAudioGraph(null)).toBeNull()
  })

  it('未建图时 getAnalyser / isAudioGraphReady 安全返回', () => {
    expect(getAnalyser()).toBeNull()
    expect(isAudioGraphReady()).toBe(false)
  })

  it('resumeAudioGraph 在无图时立即 resolve', async () => {
    await expect(resumeAudioGraph()).resolves.toBeUndefined()
  })

  it('dispose / close 在无图时是幂等空操作', () => {
    expect(() => disposeAudioGraph()).not.toThrow()
    expect(() => disposeAudioGraph()).not.toThrow()
    expect(() => closeAudioGraph()).not.toThrow()
  })
})

describe('常量契约', () => {
  it('FFT 窗口为 2 的幂且不小于 32', () => {
    expect(ANALYSER_FFT_SIZE).toBeGreaterThanOrEqual(32)
    expect(Math.log2(ANALYSER_FFT_SIZE) % 1).toBe(0)
  })

  it('平滑系数落在 0..1', () => {
    expect(ANALYSER_SMOOTHING).toBeGreaterThanOrEqual(0)
    expect(ANALYSER_SMOOTHING).toBeLessThanOrEqual(1)
  })

  it('可用频谱比例落在 (0, 1]', () => {
    expect(SPECTRUM_USABLE_RATIO).toBeGreaterThan(0)
    expect(SPECTRUM_USABLE_RATIO).toBeLessThanOrEqual(1)
  })
})

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_HZ,
  BAR_COUNT,
  FFT_SIZE,
  SAMPLE_RATE,
  barsAtTime as barsAtTimeMain,
  blackmanWindow,
  buildSpectrumTimeline,
  computeBarsFromBytes,
  encodeTimelineBase64,
  fftInPlace,
  linearMagnitudeToByte,
  spectrumFrameCount,
} from '../electron/spectrum'
import { barsAtTime, decodeSpectrum } from '../src/utils/spectrumDecode'

/**
 * v1.4.10-pre1 MV 导出可视化：离线频谱时间线。
 *
 * 这里守的是三件事：
 * 1. FFT 与分桶本身算得对（正弦输入峰值落在预期频段，不是「有输出就算过」）；
 * 2. 幅度映射与分桶口径跟播放页同源（0..255、峰值、可用带宽比）；
 * 3. 主进程编码的时间线，渲染层解码后按时间取到的柱高与主进程自己算的一致——
 *    这是「导出画面柱子跟着时间走」这条链路的接口契约。
 */

/** 生成 16bit 单声道正弦 PCM。 */
function sinePcm(freq: number, seconds: number, amplitude = 0.8): Int16Array {
  const length = Math.round(SAMPLE_RATE * seconds)
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * amplitude * 32767)
  }
  return pcm
}

describe('黑曼窗与 FFT（v1.4.10-pre1）', () => {
  it('黑曼窗中心接近 1、两端接近 0', () => {
    const win = blackmanWindow(64)
    expect(win[0]).toBeCloseTo(0, 5)
    expect(win[63]).toBeCloseTo(0, 5)
    expect(win[32]).toBeGreaterThan(0.99)
    expect(win.length).toBe(64)
  })

  it('单点窗不产生 NaN', () => {
    expect(blackmanWindow(1)[0]).toBe(1)
  })

  it('1kHz 正弦的谱峰落在对应 bin（bin = f*N/fs）', () => {
    const n = 1024
    const freq = 1000
    const expectedBin = Math.round((freq * n) / SAMPLE_RATE)
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE)
    fftInPlace(re, im)

    let peakBin = 0
    let peak = -1
    for (let k = 1; k < n / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      if (mag > peak) { peak = mag; peakBin = k }
    }
    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(1)
  })

  it('非 2 的幂长度直接报错，不做静默错算', () => {
    expect(() => fftInPlace(new Float64Array(3), new Float64Array(3))).toThrow()
  })
})

describe('幅度映射与分桶口径（v1.4.10-pre1）', () => {
  it('0 与低于下界的幅度映射为 0，上界以上映射为 255', () => {
    expect(linearMagnitudeToByte(0)).toBe(0)
    expect(linearMagnitudeToByte(Number.NaN)).toBe(0)
    expect(linearMagnitudeToByte(Number.POSITIVE_INFINITY)).toBe(0)
    expect(linearMagnitudeToByte(1e-5)).toBe(0)
    expect(linearMagnitudeToByte(1)).toBe(255)
    expect(linearMagnitudeToByte(10)).toBe(255)
  })

  it('中间幅度线性映射到 0..255 区间内', () => {
    // -65dB 正好落在 -100..-30 的中点，应接近 127/128
    const mid = linearMagnitudeToByte(10 ** (-65 / 20))
    expect(mid).toBeGreaterThanOrEqual(126)
    expect(mid).toBeLessThanOrEqual(129)
  })

  it('分桶取每段峰值、可用带宽只到 72%', () => {
    // 64 个频点，40 桶时最后若干桶落在 72% 之外，须为 0
    const freq = new Uint8Array(64)
    freq[0] = 255
    freq[63] = 255
    const bars = computeBarsFromBytes(freq, 8)
    expect(bars.length).toBe(8)
    expect(bars[0]).toBe(1)
    // 末尾频点在可用带宽之外：不应被计入任何桶
    expect(bars[7]).toBe(0)
    expect(bars.every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('空输入与脏数据返回全 0，不出现 NaN', () => {
    expect(computeBarsFromBytes(new Uint8Array(0), 4)).toEqual([0, 0, 0, 0])
    const dirty = [Number.NaN, Number.POSITIVE_INFINITY, -5] as unknown as Uint8Array
    const bars = computeBarsFromBytes(dirty, 3)
    expect(bars.every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('整曲时间线（v1.4.10-pre1）', () => {
  it('静音输入产出全 0 时间线（不会凭空出现律动）', () => {
    const pcm = new Int16Array(SAMPLE_RATE * 0.3)
    const timeline = buildSpectrumTimeline(pcm)
    expect(timeline.length).toBe(spectrumFrameCount(pcm.length) * BAR_COUNT)
    expect(timeline.every((v) => v === 0)).toBe(true)
  })

  it('1kHz 正弦的能量集中在低频桶，且该桶明显高于高频桶', () => {
    const pcm = sinePcm(1000, 0.5)
    const timeline = buildSpectrumTimeline(pcm, { onProgress: () => {} })
    // 取第 10 帧（约 0.33 秒，平滑已经稳定）
    const frame = 10
    const bars = Array.from(timeline.slice(frame * BAR_COUNT, (frame + 1) * BAR_COUNT))
    const maxBar = Math.max(...bars)
    const maxIndex = bars.indexOf(maxBar)
    expect(maxBar).toBeGreaterThan(0)
    // 1kHz → bin 46 → 桶 2（40 桶覆盖前 72% 频段）
    expect(maxIndex).toBeLessThanOrEqual(3)
    // 高频桶（后 1/3）不应有能量
    const highBars = bars.slice(27)
    expect(Math.max(...highBars)).toBeLessThan(maxBar)
  })

  it('帧数随时间长度增长，且每帧字节数恒为 BAR_COUNT', () => {
    const short = buildSpectrumTimeline(sinePcm(440, 0.5))
    const long = buildSpectrumTimeline(sinePcm(440, 1.5))
    expect(short.length / BAR_COUNT).toBeLessThan(long.length / BAR_COUNT)
    expect(short.length % BAR_COUNT).toBe(0)
    expect(long.length % BAR_COUNT).toBe(0)
  })

  it('帧率口径与分析帧率一致（30Hz）', () => {
    const pcm = new Int16Array(SAMPLE_RATE * 2)
    const frames = spectrumFrameCount(pcm.length)
    expect(frames).toBe(Math.floor((SAMPLE_RATE * 2) / (SAMPLE_RATE / ANALYSIS_HZ)) + 1)
  })
})

describe('时间线编解码往返与取样（v1.4.10-pre1）', () => {
  it('主进程编码 → 渲染层解码，字节完全一致', () => {
    const pcm = sinePcm(880, 1)
    const timeline = buildSpectrumTimeline(pcm)
    const decoded = decodeSpectrum(encodeTimelineBase64(timeline), BAR_COUNT, ANALYSIS_HZ)
    expect(decoded).not.toBeNull()
    expect(decoded!.frames).toBe(timeline.length / BAR_COUNT)
    expect(Array.from(decoded!.data)).toEqual(Array.from(timeline))
  })

  it('坏数据一律返回 null，不抛错', () => {
    expect(decodeSpectrum(undefined, BAR_COUNT, ANALYSIS_HZ)).toBeNull()
    expect(decodeSpectrum('', BAR_COUNT, ANALYSIS_HZ)).toBeNull()
    expect(decodeSpectrum('!!!not-base64!!!', BAR_COUNT, ANALYSIS_HZ)).toBeNull()
    expect(decodeSpectrum('AAAA', 0, ANALYSIS_HZ)).toBeNull()
    expect(decodeSpectrum('AAAA', BAR_COUNT, 0)).toBeNull()
  })

  it('按时间取样：主进程与渲染层两条路径结果一致', () => {
    const pcm = sinePcm(880, 1)
    const timeline = buildSpectrumTimeline(pcm)
    const decoded = decodeSpectrum(encodeTimelineBase64(timeline), BAR_COUNT, ANALYSIS_HZ)!
    for (const t of [0, 0.1, 0.5, 0.999]) {
      const main = barsAtTimeMain(timeline, t)
      const view = barsAtTime(decoded, t)
      for (let i = 0; i < BAR_COUNT; i++) {
        expect(Math.abs(main[i] - view[i])).toBeLessThanOrEqual(1 / 255 + 1e-9)
      }
    }
  })

  it('时间越界钳到首尾帧，不返回空数组', () => {
    const pcm = sinePcm(880, 0.5)
    const timeline = buildSpectrumTimeline(pcm)
    const decoded = decodeSpectrum(encodeTimelineBase64(timeline), BAR_COUNT, ANALYSIS_HZ)!
    expect(barsAtTime(decoded, -5).length).toBe(BAR_COUNT)
    expect(barsAtTime(decoded, 9999).length).toBe(BAR_COUNT)
    expect(barsAtTime(decoded, Number.NaN).length).toBe(BAR_COUNT)
  })
})

describe('FFT 尺寸常量与播放页同源（v1.4.10-pre1）', () => {
  it('窗口与桶数对齐播放页常量', () => {
    expect(FFT_SIZE).toBe(2048)
    expect(BAR_COUNT).toBe(40)
    expect(ANALYSIS_HZ).toBe(30)
  })
})

/**
 * v1.4.10-pre1 MV 导出音频可视化：离线频谱时间线。
 *
 * 为什么需要这个模块：
 *
 * MV 导出的离屏舞台是「时间步进 + paint 取帧」的静态渲染——主进程逐采样点
 * 调 window.__mvSetTime(t)，等一次 paint 取一帧。这条契约的前提是「时间不推进就
 * 不重绘」，否则帧与时间点无法对应。播放页那套实时 AnalyserNode + 常驻 rAF 的
 * 可视化因此不能搬进导出窗口，导出画面的柱子必须由「当前时间」唯一决定。
 *
 * 所以本模块在主进程侧把整曲音频离线分析成一条频谱时间线：每 1/30 秒一帧、
 * 每帧 BAR_COUNT 个 0..255 的桶值。舞台按当前时间索引取到柱高，只画一帧。
 *
 * 口径与播放页对齐（这是「观感一致」的关键，不是随手取的值）：
 * - FFT_SIZE / 分桶 / 可用带宽比 / 幅度映射全对齐 src/services/audioGraph.ts 与
 *   AnalyserNode.getByteFrequencyData 的实现口径：Blackman 窗、幅度按 fftSize
 *   归一化、20log10 后线性映射 minDecibels(-100)..maxDecibels(-30)、每桶取峰值。
 * - 两级平滑按帧率折算：播放页 analyser 每帧(60Hz) EMA 0.8 与组件每帧 EMA 0.35,
 *   等价时间常数分别是约 74.8ms 与约 38.8ms；本模块按 30Hz 折算成 0.64 与 0.576,
 *   保证柱子的起落节奏与播放页相近（原值直接搬过来会让导出画面明显更快更抖）。
 *
 * 纯函数、零 electron 依赖，可直接被 vitest 覆盖（同 electron/encoders.ts 的做法）。
 */

/** 分析帧率（帧/秒）。与主进程的 1/30 采样网格一一对应。 */
export const ANALYSIS_HZ = 30
/** FFT 窗口点数，与播放页 ANALYSER_FFT_SIZE 同值。 */
export const FFT_SIZE = 2048
/** 频率桶数量，与播放页 AudioVisualizer 的 BAR_COUNT 同值。 */
export const BAR_COUNT = 40
/** 统一重采样到的采样率（单声道）。 */
export const SAMPLE_RATE = 44100
/** 相邻分析帧的采样间隔。 */
export const HOP_SIZE = Math.round(SAMPLE_RATE / ANALYSIS_HZ)
/** 只取前 72% 频段参与分桶，与播放页 SPECTRUM_USABLE_RATIO 同值（高频段基本恒为 0）。 */
export const SPECTRUM_USABLE_RATIO = 0.72
/** 幅度映射下界（dB），对齐 AnalyserNode.minDecibels 默认值。 */
export const MIN_DECIBELS = -100
/** 幅度映射上界（dB），对齐 AnalyserNode.maxDecibels 默认值。 */
export const MAX_DECIBELS = -30
/** 频域线性幅度的平滑系数（30Hz 帧率下的等效值）。 */
export const ANALYSER_SMOOTHING = 0.64
/** 桶值的显示平滑系数（30Hz 帧率下的等效值）。 */
export const DISPLAY_SMOOTHING = 0.576

/** 生成 Blackman 窗系数（与 AnalyserNode 使用的窗函数同族）。 */
export function blackmanWindow(size: number): Float64Array {
  const n = Math.max(1, Math.floor(size))
  const win = new Float64Array(n)
  if (n === 1) {
    win[0] = 1
    return win
  }
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1)
    win[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
  }
  return win
}

/**
 * 原地 radix-2 复数 FFT（迭代 Cooley-Tukey）。
 * 长度必须是 2 的幂；调用方负责保证（FFT_SIZE = 2048）。
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error(`FFT 长度必须是 2 的幂，收到 ${n}`)

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }

  // 蝶形逐级合并
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/**
 * 线性幅度 → 0..255 字节，对齐 getByteFrequencyData 的 dB 映射。
 * 幅度为 0（或非有限）时返回 0（对应 dB 低于下界的钳位结果）。
 */
export function linearMagnitudeToByte(magnitude: number): number {
  if (!Number.isFinite(magnitude) || magnitude <= 0) return 0
  const db = 20 * Math.log10(magnitude)
  if (!Number.isFinite(db) || db <= MIN_DECIBELS) return 0
  if (db >= MAX_DECIBELS) return 255
  const ratio = (db - MIN_DECIBELS) / (MAX_DECIBELS - MIN_DECIBELS)
  return Math.round(ratio * 255)
}

/**
 * 频域字节数据 → 桶高（0..1）。
 *
 * 与 src/services/audioGraph.ts 的 computeBars 同一套分桶规则：只用前
 * SPECTRUM_USABLE_RATIO 频段、每桶取峰值、非法值按 0 处理。两处刻意保持同源，
 * 播放页与导出画面的柱子形态才不会漂移。
 */
export function computeBarsFromBytes(freqData: ArrayLike<number>, barCount: number = BAR_COUNT): number[] {
  const count = Number.isFinite(barCount) ? Math.max(1, Math.floor(barCount)) : 1
  const bars = new Array<number>(count).fill(0)
  const len = freqData ? freqData.length : 0
  if (!len) return bars

  const usable = Math.max(1, Math.floor(len * SPECTRUM_USABLE_RATIO))
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * usable) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * usable) / count))
    let peak = 0
    for (let j = start; j < end && j < len; j++) {
      const v = freqData[j]
      if (Number.isFinite(v) && v > peak) peak = v
    }
    const normalized = peak / 255
    bars[i] = normalized > 1 ? 1 : normalized
  }
  return bars
}

export interface SpectrumTimelineOptions {
  /** 分析帧率（默认 ANALYSIS_HZ） */
  analysisHz?: number
  /** 桶数（默认 BAR_COUNT） */
  barCount?: number
  /** 采样率（默认 SAMPLE_RATE，须与 PCM 实际一致） */
  sampleRate?: number
  /** 每处理多少帧回调一次进度（用于主进程上报「分析音频」阶段） */
  onProgress?: (frames: number, total: number) => void
}

/** 逐帧分析器：持有窗函数与平滑状态，供同步/异步两个入口共用。 */
class FrameAnalyzer {
  private readonly window: Float64Array
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly freqBytes: Uint8Array
  private previousMagnitude: Float64Array
  private smoothedBars: number[]

  constructor(
    private readonly fftSize: number,
    private readonly barCount: number,
    private readonly analyserSmoothing: number,
    private readonly displaySmoothing: number,
  ) {
    this.window = blackmanWindow(fftSize)
    this.re = new Float64Array(fftSize)
    this.im = new Float64Array(fftSize)
    this.freqBytes = new Uint8Array(fftSize / 2)
    this.previousMagnitude = new Float64Array(fftSize / 2)
    this.smoothedBars = new Array<number>(barCount).fill(0)
  }

  /**
   * 分析一帧（PCM 归一化浮点样本，长度须为 fftSize），返回该帧的桶值。
   * 样本从 offset 开始读取，越界部分按 0 补（尾部不足一窗时）。
   */
  analyzeFrame(samples: Float32Array, offset: number): number[] {
    const n = this.fftSize
    for (let i = 0; i < n; i++) {
      const s = offset + i < samples.length ? samples[offset + i] : 0
      this.re[i] = s * this.window[i]
      this.im[i] = 0
    }
    fftInPlace(this.re, this.im)

    const bins = n / 2
    for (let k = 0; k < bins; k++) {
      // 幅度按 fftSize 归一化，与 AnalyserNode 的 doFFT 缩放一致
      const mag = Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]) / n
      // 线性幅度上做 EMA 平滑后再转 dB（Blink 的实现顺序：先平滑线性值）
      const prev = this.previousMagnitude[k]
      const smoothed = this.analyserSmoothing * prev + (1 - this.analyserSmoothing) * mag
      this.previousMagnitude[k] = Number.isFinite(smoothed) ? smoothed : 0
      this.freqBytes[k] = linearMagnitudeToByte(this.previousMagnitude[k])
    }

    const bars = computeBarsFromBytes(this.freqBytes, this.barCount)
    // 第二级：桶值上再做一次显示平滑，等效播放页组件的逐帧插值
    for (let i = 0; i < this.barCount; i++) {
      const target = Number.isFinite(bars[i]) ? bars[i] : 0
      const next = this.smoothedBars[i] + (target - this.smoothedBars[i]) * this.displaySmoothing
      this.smoothedBars[i] = Number.isFinite(next) ? next : 0
    }
    return this.smoothedBars.slice()
  }
}

/** 内部实现选项解析：把入参钳到安全范围，避免脏配置产生 NaN 尺寸。 */
function resolveOptions(options: SpectrumTimelineOptions): {
  analysisHz: number
  barCount: number
  sampleRate: number
  hop: number
  onProgress?: (frames: number, total: number) => void
} {
  const analysisHz = Number.isFinite(options.analysisHz) && (options.analysisHz as number) > 0
    ? (options.analysisHz as number)
    : ANALYSIS_HZ
  const barCount = Number.isFinite(options.barCount) && (options.barCount as number) > 0
    ? Math.floor(options.barCount as number)
    : BAR_COUNT
  const sampleRate = Number.isFinite(options.sampleRate) && (options.sampleRate as number) > 0
    ? (options.sampleRate as number)
    : SAMPLE_RATE
  const hop = Math.max(1, Math.round(sampleRate / analysisHz))
  return { analysisHz, barCount, sampleRate, hop, onProgress: options.onProgress }
}

/** 分析帧总数（与舞台按时间索引的口径一致）。 */
export function spectrumFrameCount(pcmLength: number, sampleRate: number = SAMPLE_RATE, analysisHz: number = ANALYSIS_HZ): number {
  const hop = Math.max(1, Math.round(sampleRate / analysisHz))
  if (!Number.isFinite(pcmLength) || pcmLength <= 0) return 1
  return Math.max(1, Math.floor(pcmLength / hop) + 1)
}

/** 把 PCM 归一化成浮点样本（-1..1）。Int16 的 -32768 会得到 -1，属正常范围。 */
export function int16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i] / 32768
  }
  return out
}

/**
 * 同步生成整曲频谱时间线：长度 = 帧数 × barCount，每字节 0..255。
 *
 * 调用方（主进程）在长音频下应改用 buildSpectrumTimelineAsync，避免阻塞事件循环。
 */
export function buildSpectrumTimeline(pcm: Int16Array, options: SpectrumTimelineOptions = {}): Uint8Array {
  const { hop, barCount } = resolveOptions(options)
  const samples = int16ToFloat(pcm)
  const analyzer = new FrameAnalyzer(FFT_SIZE, barCount, ANALYSER_SMOOTHING, DISPLAY_SMOOTHING)
  // 帧数与 spectrumFrameCount 同口径（此处 hop 已解析，直接算，避免二次折算）
  const frames = Math.max(1, Math.floor(pcm.length / hop) + 1)
  const timeline = new Uint8Array(frames * barCount)

  for (let f = 0; f < frames; f++) {
    const bars = analyzer.analyzeFrame(samples, f * hop)
    for (let b = 0; b < barCount; b++) {
      const v = bars[b]
      timeline[f * barCount + b] = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 0) * 255)))
    }
    options.onProgress?.(f + 1, frames)
  }
  return timeline
}

/**
 * 异步版：每处理 yieldEvery 帧让出一次事件循环。
 * 主进程用它跑 3~10 分钟曲目，保证导出期间的进度上报与取消仍然响应。
 */
export async function buildSpectrumTimelineAsync(
  pcm: Int16Array,
  options: SpectrumTimelineOptions & { yieldEvery?: number } = {},
): Promise<Uint8Array> {
  const { hop, barCount } = resolveOptions(options)
  const yieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 150))
  const samples = int16ToFloat(pcm)
  const analyzer = new FrameAnalyzer(FFT_SIZE, barCount, ANALYSER_SMOOTHING, DISPLAY_SMOOTHING)
  // 帧数与 spectrumFrameCount 同口径（此处 hop 已解析，直接算，避免二次折算）
  const frames = Math.max(1, Math.floor(pcm.length / hop) + 1)
  const timeline = new Uint8Array(frames * barCount)

  for (let f = 0; f < frames; f++) {
    const bars = analyzer.analyzeFrame(samples, f * hop)
    for (let b = 0; b < barCount; b++) {
      const v = bars[b]
      timeline[f * barCount + b] = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 0) * 255)))
    }
    options.onProgress?.(f + 1, frames)
    if ((f + 1) % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  return timeline
}

/** 时间线 → base64（主进程侧编码，随 __mvInit 注入离屏舞台）。 */
export function encodeTimelineBase64(timeline: Uint8Array): string {
  return Buffer.from(timeline.buffer, timeline.byteOffset, timeline.byteLength).toString('base64')
}

/** 取某时刻的桶值（最近帧）。越界时间钳到首尾帧，供主进程自检与单测使用。 */
export function barsAtTime(
  timeline: Uint8Array,
  timeSeconds: number,
  barCount: number = BAR_COUNT,
  analysisHz: number = ANALYSIS_HZ,
): number[] {
  const count = Math.max(1, Math.floor(barCount))
  const frames = Math.floor(timeline.length / count)
  if (!frames) return new Array<number>(count).fill(0)
  const raw = Number.isFinite(timeSeconds) ? timeSeconds : 0
  const index = Math.max(0, Math.min(frames - 1, Math.round(raw * analysisHz)))
  const bars = new Array<number>(count)
  for (let b = 0; b < count; b++) bars[b] = timeline[index * count + b] / 255
  return bars
}

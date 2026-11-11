/**
 * v1.4.15-pre1 均衡器：预置曲线、归一化与频段定义。
 *
 * 本文件是**纯模块**——不碰 Web Audio、不碰 React、不读写存储。
 * 建立 BiquadFilter 链的那部分是 src/services/audioGraph.ts 的职责，
 * 这样曲线与钳制规则可以被单测直接覆盖（jsdom 里没有 AudioContext）。
 *
 * 设计取舍：
 *
 * 1. **频段固定十个**。十个频段是硬件均衡器的常见档位，也够覆盖「低频 / 人声 /
 *    高频」三类直觉需求；再细分会让设置界面在窄屏上挤成一条线，且 BiquadFilter
 *    每个频段都要过一次运算，边际收益递减。
 *
 * 2. **增益上限 ±12dB**。这是 Web Audio 的 GainNode / BiquadFilter 都能安稳工作的
 *    区间，也接近消费级播放器软件的口径；超过这个量程极容易把声音推爆成削波失真，
 *    用户听到的是「变难听」而不是「低频更足」。
 *
 * 3. **预置只存增益，不存 Q 值**。Q 固定由频段决定（见 EQ_BAND_Q），
 *    让每一条预置曲线都是「同一组滤波器、不同的增益」，
 *    这样切换预置时听感变化可预期，也省得为十个频段各调一个 Q。
 */

import type { EqualizerGains, EqualizerPresetId, EqualizerSettings } from '@/types'

/** 十个固定频段的中心频率（Hz），顺序即 UI 从左到右的顺序。 */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

/** 频段数量（恒定 10）。 */
export const EQ_BAND_COUNT = EQ_BANDS.length

/** 增益上下限（dB）。越界一律钳制，不静默丢弃整组设置。 */
export const EQ_MIN_GAIN_DB = -12
export const EQ_MAX_GAIN_DB = 12

/**
 * 每个频段的 Q 值。
 *
 * 低频用较小 Q（宽一些）避免窄带轰鸣，高频用较大 Q 让「齿音 / 空气感」这类
 * 细节能被单独拎出来。数值按「一个倍频程左右」的常见图形均衡器口径取。
 */
export function bandQ(index: number): number {
  if (index <= 1) return 0.7
  if (index <= 4) return 1.0
  if (index <= 7) return 1.1
  return 1.4
}

/** 预置曲线定义：id → { 显示名, 十段增益 }。flat 必须是全零，DEFAULT_EQUALIZER 依赖这一点。 */
export const EQ_PRESETS: Record<Exclude<EqualizerPresetId, 'custom'>, { label: string; gains: EqualizerGains }> = {
  flat: { label: '平坦', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  pop: { label: '流行', gains: [-1, 0, 2, 4, 4, 1, -1, -1, 0, 0] },
  rock: { label: '摇滚', gains: [5, 4, 2, 0, -1, -1, 1, 3, 4, 4] },
  jazz: { label: '爵士', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { label: '古典', gains: [4, 3, 2, 0, 0, 0, -1, -1, 2, 3] },
  electronic: { label: '电子', gains: [6, 5, 2, 0, -2, 1, 0, 2, 5, 5] },
  vocal: { label: '人声', gains: [-3, -2, -1, 2, 4, 5, 4, 2, 0, -1] },
  bass: { label: '重低音', gains: [8, 7, 5, 2, 0, 0, 0, 0, 0, 0] },
  treble: { label: '高音', gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
}

/** 预置 id 的稳定顺序，供 UI 按固定次序渲染（不依赖对象键序）。 */
export const EQ_PRESET_ORDER: Exclude<EqualizerPresetId, 'custom'>[] = [
  'flat',
  'pop',
  'rock',
  'jazz',
  'classical',
  'electronic',
  'vocal',
  'bass',
  'treble',
]

/** 把一个数钳到均衡器合法量程内；非有限值（NaN/Infinity）按 0 处理。 */
export function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < EQ_MIN_GAIN_DB) return EQ_MIN_GAIN_DB
  if (value > EQ_MAX_GAIN_DB) return EQ_MAX_GAIN_DB
  return value
}

/**
 * 把任意脏输入归一成合法的十段增益。
 *
 * 口径与项目既有做法一致（见 v1.4.14 的「宁可少做也不猜」）：
 * - 长度不足时**补齐 0**而不是整组丢弃——补齐等价于「这段不调」，没有副作用；
 * - 超长时截断到十段；
 * - 单个值越界钳制到 ±12dB，非有限值按 0；
 * - 每个值四舍五入到 0.1dB，避免浮点尾数让 UI 显示 3.0000000000000004。
 */
export function normalizeGains(input: unknown): EqualizerGains {
  const source = Array.isArray(input) ? input : []
  const out: EqualizerGains = new Array(EQ_BAND_COUNT)
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const raw = source[i]
    const num = typeof raw === 'number' ? raw : Number(raw)
    // 四舍五入到 0.1dB；Math.round(-0.05*10)/10 会得到 -0，加 0 归一掉
    out[i] = clampGain(Math.round(clampGain(num) * 10) / 10) + 0
  }
  return out
}

/** 取某个预置的增益副本（返回新数组，调用方可以随意改而不污染常量）。 */
export function presetGains(preset: EqualizerPresetId): EqualizerGains {
  if (preset === 'custom') return normalizeGains([])
  const def = EQ_PRESETS[preset]
  return def ? [...def.gains] : normalizeGains([])
}

/** 两组增益是否等价（按归一化后逐段比较，浮点尾数不参与判定）。 */
export function gainsEqual(a: EqualizerGains, b: EqualizerGains): boolean {
  const na = normalizeGains(a)
  const nb = normalizeGains(b)
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    if (na[i] !== nb[i]) return false
  }
  return true
}

/** 这组增益是否全零（全零时即使开着均衡器也等于直通）。 */
export function isFlat(gains: EqualizerGains): boolean {
  return gainsEqual(gains, presetGains('flat'))
}

/**
 * 归一化整组均衡器设置。
 *
 * 关键规则：**preset 与实际增益必须自洽**。
 * 若 preset 不是 custom，则增益以预置曲线为准（覆盖传进来的脏值）；
 * 只有 preset === 'custom' 时才信任调用方给的 gains。
 * 否则会出现「UI 显示『摇滚』但实际曲线是别的」这种对不上的状态。
 */
export function normalizeEqualizer(input: unknown): EqualizerSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Partial<EqualizerSettings>
  const presetRaw = src.preset
  const preset: EqualizerPresetId =
    typeof presetRaw === 'string' && (presetRaw === 'custom' || presetRaw in EQ_PRESETS)
      ? (presetRaw as EqualizerPresetId)
      : 'flat'

  const gains = preset === 'custom' ? normalizeGains(src.gains) : presetGains(preset)

  return {
    enabled: Boolean(src.enabled),
    preset,
    gains,
  }
}

/**
 * 用户手动拖动某一根柱子后，决定新的 preset 归属。
 *
 * 若调完的曲线恰好等于某个预置，就把 preset 归位到那个预置（而不是一律 custom），
 * 这样用户把柱子拖回原样时界面会自动显示回「平坦 / 流行」等名字，
 * 不必再多一次「手动切回预设」的操作。
 */
export function presetAfterManualEdit(gains: EqualizerGains): EqualizerPresetId {
  const normalized = normalizeGains(gains)
  for (const id of EQ_PRESET_ORDER) {
    if (gainsEqual(normalized, EQ_PRESETS[id].gains)) return id
  }
  return 'custom'
}

/**
 * 取某根柱子在 UI 上的填充比例（0~1）。
 *
 * 用 0dB 作中点：正增益向上、负增益向下，所以 UI 需要知道当前值在量程里的位置。
 * 这里只给「绝对值占满量程的比例」，正负方向由 UI 决定。
 */
export function gainToRatio(gain: number): number {
  return Math.abs(clampGain(gain)) / EQ_MAX_GAIN_DB
}

/** 频段的人类可读标签（1k 以上用 kHz 写法，省得界面上出现 16000）。 */
export function bandLabel(freq: number): string {
  if (freq >= 1000) {
    const k = freq / 1000
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`
  }
  return String(freq)
}

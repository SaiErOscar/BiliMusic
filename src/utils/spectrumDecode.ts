/**
 * v1.4.10-pre1 MV 导出：频谱时间线的渲染层解码与取样。
 *
 * 时间线由主进程用 electron/spectrum.ts 离线分析并 base64 编码，随 __mvInit 的
 * payload 注入离屏舞台。舞台这边只做两件事：解成 Uint8Array、按当前时间取柱高。
 *
 * 之所以不在渲染层复用主进程那个模块：编码端在 Node 侧用 Buffer，解码端在浏览器侧
 * 用 atob，两端各自十行、且本模块可独立单测；真正需要严格一致的是「时间线布局」——
 * 每帧 BAR_COUNT 个字节、帧序即时间序——这一点由 tests/spectrum.test.ts 的往返测试
 * 与契约测试共同守住。
 */

/** 解码后的频谱时间线。 */
export interface DecodedSpectrum {
  /** 每帧 barCount 个 0..255 的桶值，帧序即时间序 */
  data: Uint8Array
  /** 每帧桶数 */
  bars: number
  /** 分析帧率（帧/秒） */
  hz: number
  /** 总帧数 */
  frames: number
}

/**
 * base64 → 频谱时间线。
 * 任何异常（非法 base64、长度对不上、参数非正）都返回 null，调用方按「无可视化」处理，
 * 绝不因为一份坏数据把导出搞挂。
 */
export function decodeSpectrum(base64: string | undefined | null, bars: number, hz: number): DecodedSpectrum | null {
  if (!base64 || !Number.isFinite(bars) || bars <= 0 || !Number.isFinite(hz) || hz <= 0) return null
  const barCount = Math.floor(bars)
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff
  const frames = Math.floor(bytes.length / barCount)
  if (frames < 1) return null
  return { data: bytes, bars: barCount, hz, frames }
}

/**
 * 取某时刻的桶高（0..1），最近帧，越界钳到首尾。
 * 与主进程侧 barsAtTime 同口径：索引 = round(t * hz)，保证导出舞台与预分析完全对齐。
 */
export function barsAtTime(spectrum: DecodedSpectrum, seconds: number): number[] {
  const { data, bars, hz, frames } = spectrum
  const raw = Number.isFinite(seconds) ? seconds : 0
  const index = Math.max(0, Math.min(frames - 1, Math.round(raw * hz)))
  const out = new Array<number>(bars)
  for (let b = 0; b < bars; b++) out[b] = data[index * bars + b] / 255
  return out
}

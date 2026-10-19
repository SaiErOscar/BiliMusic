/**
 * v1.4.10-pre1 音频可视化：柱状图的唯一绘制实现。
 *
 * 播放页（实时 analyser）与 MV 导出舞台（时间索引预计算频谱）用的是两套完全不同的
 * 数据来源，但画面必须是同一张：柱数、柱宽、间隙、柱根直角加柱顶圆角、主题色渐变、
 * 未就绪时的占位基线，全部只在这里实现一份，两边只负责把柱高数组递进来。
 * 复制一份到另一处迟早会漂移（v1.4.9 的柱底对齐就吃过两处尺寸不一致的亏）。
 */

/** 柱子数量。40 根在播放页封面下方与导出画面里的密度都合适。 */
export const VISUALIZER_BAR_COUNT = 40

/**
 * 画布高度兜底值（CSS 像素）。
 * 实际高度由 CSS 类决定（.now-playing-visualizer 为 64px），这里只在 clientHeight
 * 取不到时兜底。两处必须一致，否则降级/首帧会用错误高度绘制导致柱子被拉伸。
 */
export const VISUALIZER_CANVAS_HEIGHT = 64

/** 未就绪/降级时的静态占位高度比例（一条浅浅的基线，暗示暂无频谱）。 */
export const VISUALIZER_PLACEHOLDER_RATIO = 0.08

/** 读取主题色 token；取不到时回退（兜底色仅用于「取不到」的极端情况）。 */
export function readThemeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * 把画布的位图尺寸与 CSS 尺寸对齐（按 DPR 放大），返回绘制用的 CSS 尺寸与 DPR。
 * 尺寸没变时不重设，避免每帧重置画布状态。
 */
export function resizeCanvasToDisplay(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = canvas.clientWidth || 320
  const height = canvas.clientHeight || VISUALIZER_CANVAS_HEIGHT
  const pixelW = Math.floor(width * dpr)
  const pixelH = Math.floor(height * dpr)
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW
    canvas.height = pixelH
  }
  return { width, height, dpr }
}

/**
 * 画一帧柱状图。bars 为 0..1 的柱高数组（长度即柱数），非有限值按 0 处理。
 * 颜色取自主题 token，随主题与明暗自动变化，不硬编码品牌色。
 */
export function drawVisualizerBars(canvas: HTMLCanvasElement, bars: ArrayLike<number>): void {
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) return
  const { width, height, dpr } = resizeCanvasToDisplay(canvas)
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx2d.clearRect(0, 0, width, height)

  const count = Math.max(1, bars.length)
  const primary = readThemeColor('--color-primary', '#FB7299')
  const accent = readThemeColor('--color-accent', primary)
  const gap = Math.max(1, (width / count) * 0.28)
  const barWidth = Math.max(1, (width - gap * (count - 1)) / count)
  const radius = Math.min(barWidth / 2, 3)

  const gradient = ctx2d.createLinearGradient(0, height, 0, 0)
  gradient.addColorStop(0, primary)
  gradient.addColorStop(1, accent)
  ctx2d.fillStyle = gradient

  for (let i = 0; i < count; i++) {
    const raw = bars[i]
    const ratio = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    const barHeight = Math.max(2, ratio * height)
    const x = i * (barWidth + gap)
    const top = height - barHeight
    // 柱根直角、只留柱顶圆角：柱根先是圆的时，每根柱子底部都向内收一个弧，
    // 连起来是虚线一样的锯齿，叠在封面下边缘上就不像「贴着底边长出来」；
    // 柱根切开后，一排柱根连成一条实的水平线，正好压在封面下边缘上。
    // 圆角半径不得超过柱半高，否则短视频里矮柱会被拉变形。
    const r = Math.min(radius, barHeight / 2, barWidth / 2)
    ctx2d.beginPath()
    ctx2d.moveTo(x, height)
    ctx2d.lineTo(x, top + r)
    ctx2d.quadraticCurveTo(x, top, x + r, top)
    ctx2d.lineTo(x + barWidth - r, top)
    ctx2d.quadraticCurveTo(x + barWidth, top, x + barWidth, top + r)
    ctx2d.lineTo(x + barWidth, height)
    ctx2d.closePath()
    ctx2d.fill()
  }
}

/** 画一帧静态占位（无频谱数据时的浅基线），播放页降级与单测都用它。 */
export function drawVisualizerPlaceholder(canvas: HTMLCanvasElement): void {
  drawVisualizerBars(canvas, new Array<number>(VISUALIZER_BAR_COUNT).fill(VISUALIZER_PLACEHOLDER_RATIO))
}

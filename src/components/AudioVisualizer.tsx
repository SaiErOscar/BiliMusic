/**
 * v1.4.9-pre2 音频可视化：频谱柱状图。
 *
 * 为什么单独做成组件：
 * - 绘制循环与播放器状态无关，只关心「有没有 analyser」和「音频在不在播」，
 *   独立组件可以按需挂载（只在播放页出现），不必让整个页面的状态变化触发重绘。
 * - 颜色完全取自当前主题 token（--color-primary / --color-accent），换主题或切
 *   明暗会自动跟随，不硬编码品牌色。
 *
 * 省电策略（三层）：
 * 1. 暂停后柱子衰减到底即停表，重新播放时再唤醒；
 * 2. 页面不可见（document.hidden，最小化/切后台）立刻停表；
 * 3. 用户开启「减少动态效果」时只画一帧静态频谱，完全不跑循环。
 *
 * 降级：拿不到 analyser（可视化未就绪 / AudioContext 不可用）时画静态占位条，
 * 不抛错、不崩溃，也绝不反向影响播放。
 */

import { useEffect, useRef } from 'react'
import { getAnalyser, computeBars } from '@/services/audioGraph'

/** 柱子数量。40 根在播放页封面下方的宽度下密度合适。 */
const BAR_COUNT = 40

/**
 * 画布高度兜底值（CSS 像素）。
 *
 * 实际高度由 CSS 类决定（.now-playing-visualizer 设为 64px），这里只在 clientHeight
 * 取不到时兜底。两处必须保持一致，否则降级/首帧会用错误高度绘制导致柱子被拉伸。
 */
const CANVAS_HEIGHT = 64

/** 未就绪/降级时的静态占位高度比例（一条浅浅的基线，暗示暂无频谱）。 */
const PLACEHOLDER_RATIO = 0.08

/** 每帧向目标插值的比例：越大越灵敏，越小越平滑。 */
const SMOOTHING_STEP = 0.35

/** 低于该值视为「已归零」，用于判断暂停后是否可以停表。 */
const REST_EPSILON = 0.01

/** 读取主题色 token；取不到时回退（兜底色仅用于「取不到」的极端情况）。 */
function readThemeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

interface Props {
  /** 是否正在播放：暂停时柱子衰减到静止，避免「没声音但还在跳」 */
  active: boolean
  className?: string
}

export default function AudioVisualizer({ active, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // active 用 ref 传进绘制循环：它变化时不需要重建 rAF 循环
  const activeRef = useRef(active)
  activeRef.current = active
  // 循环的启停句柄：主 effect 建立，active 变化时用来唤醒
  const startRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return

    const reducedMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false

    let rafId = 0
    let disposed = false
    // 平滑后的柱高：逐帧向目标插值，避免 analyser 数据抖动造成闪烁
    let smoothed: number[] = new Array<number>(BAR_COUNT).fill(0)

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = canvas.clientWidth || 320
      const height = canvas.clientHeight || CANVAS_HEIGHT
      const pixelW = Math.floor(width * dpr)
      const pixelH = Math.floor(height * dpr)
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW
        canvas.height = pixelH
      }
      return { width, height, dpr }
    }

    const drawBars = (bars: number[], width: number, height: number, dpr: number) => {
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2d.clearRect(0, 0, width, height)

      const primary = readThemeColor('--color-primary', '#FB7299')
      const accent = readThemeColor('--color-accent', primary)
      const gap = Math.max(1, (width / BAR_COUNT) * 0.28)
      const barWidth = Math.max(1, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT)
      const radius = Math.min(barWidth / 2, 3)

      const gradient = ctx2d.createLinearGradient(0, height, 0, 0)
      gradient.addColorStop(0, primary)
      gradient.addColorStop(1, accent)
      ctx2d.fillStyle = gradient

      for (let i = 0; i < BAR_COUNT; i++) {
        const ratio = Math.max(0, Math.min(1, bars[i] ?? 0))
        const barHeight = Math.max(2, ratio * height)
        const x = i * (barWidth + gap)
        const y = height - barHeight
        ctx2d.beginPath()
        // roundRect 在旧内核可能缺失，兜底用直角矩形，保证绘制不抛错
        if (typeof ctx2d.roundRect === 'function') {
          ctx2d.roundRect(x, y, barWidth, barHeight, radius)
        } else {
          ctx2d.rect(x, y, barWidth, barHeight)
        }
        ctx2d.fill()
      }
    }

    const frame = () => {
      rafId = 0
      if (disposed) return
      const { width, height, dpr } = resize()
      const analyser = getAnalyser()

      // 降级路径：没有 analyser 就只画一次静态占位并停表（不空转）
      if (!analyser) {
        drawBars(new Array<number>(BAR_COUNT).fill(PLACEHOLDER_RATIO), width, height, dpr)
        return
      }

      const freq = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(freq)
      const raw = computeBars(freq, BAR_COUNT)
      const target = activeRef.current ? raw : new Array<number>(BAR_COUNT).fill(0)

      smoothed = smoothed.map((prev, i) => {
        const next = prev + (target[i] - prev) * SMOOTHING_STEP
        // 防御脏数据：任何非有限值一律归零，避免 NaN 污染整条绘制链路
        return Number.isFinite(next) ? next : 0
      })
      drawBars(smoothed, width, height, dpr)

      // 暂停后柱子衰减到底就停表；重新播放由 active 变化唤醒
      const atRest = smoothed.every(v => v <= REST_EPSILON)
      if (activeRef.current || !atRest) {
        rafId = requestAnimationFrame(frame)
      }
    }

    const start = (): void => {
      if (disposed || rafId) return
      rafId = requestAnimationFrame(frame)
    }

    const stop = (): void => {
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
    }

    const onVisibilityChange = (): void => {
      if (document.hidden) stop()
      else if (!reducedMotion) start()
    }

    startRef.current = start

    if (reducedMotion) {
      // 减少动态效果：只画一帧，不挂循环也不监听可见性
      frame()
    } else {
      start()
      document.addEventListener('visibilitychange', onVisibilityChange)
    }

    return () => {
      disposed = true
      startRef.current = null
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  // 从暂停恢复播放时唤醒已停表的循环（此时 activeRef 已是 true）
  useEffect(() => {
    if (active) startRef.current?.()
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      // v1.4.9-pre3：高度交给 CSS 类（.now-playing-visualizer 定为 72px 绝对定位），
      // 这里不再写内联 height——内联样式优先级高于类，会把定位/尺寸一起锁死，
      // 且组件在别的容器里复用时无法按上下文调整高度。
      style={{ display: 'block', width: '100%' }}
    />
  )
}

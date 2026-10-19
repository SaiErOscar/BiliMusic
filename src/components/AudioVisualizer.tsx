/**
 * v1.4.9-pre2 音频可视化：频谱柱状图（播放页实时版）。
 *
 * v1.4.10-pre1 起，柱子的绘制实现搬到 services/visualizerDraw.ts，与 MV 导出舞台
 * 的静态版共用同一份：数据来源不同（这里实时读 analyser，导出那边按时间索引预计算
 * 频谱），但柱数、柱宽、间隙、柱根直角加柱顶圆角、主题色渐变必须逐像素一致，
 * 否则同一个开关在播放页与成片里会呈现出两副样子。
 *
 * 为什么单独做成组件：
 * - 绘制循环与播放器状态无关，只关心「有没有 analyser」和「音频在不在播」，
 *   独立组件可以按需挂载（只在播放页出现），不必让整个页面的状态变化触发重绘。
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
import {
  VISUALIZER_BAR_COUNT,
  drawVisualizerBars,
  drawVisualizerPlaceholder,
} from '@/services/visualizerDraw'

/** 每帧向目标插值的比例：越大越灵敏，越小越平滑。 */
const SMOOTHING_STEP = 0.35

/** 低于该值视为「已归零」，用于判断暂停后是否可以停表。 */
const REST_EPSILON = 0.01

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
    // 没有 2D 上下文（极端环境）时直接不启动循环，避免空转 rAF
    if (!canvas.getContext('2d')) return

    const reducedMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false

    let rafId = 0
    let disposed = false
    // 平滑后的柱高：逐帧向目标插值，避免 analyser 数据抖动造成闪烁
    let smoothed: number[] = new Array<number>(VISUALIZER_BAR_COUNT).fill(0)

    const frame = () => {
      rafId = 0
      if (disposed) return
      const analyser = getAnalyser()

      // 降级路径：没有 analyser 就只画一次静态占位并停表（不空转）
      if (!analyser) {
        drawVisualizerPlaceholder(canvas)
        return
      }

      const freq = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(freq)
      const raw = computeBars(freq, VISUALIZER_BAR_COUNT)
      const target = activeRef.current ? raw : new Array<number>(VISUALIZER_BAR_COUNT).fill(0)

      smoothed = smoothed.map((prev, i) => {
        const next = prev + (target[i] - prev) * SMOOTHING_STEP
        // 防御脏数据：任何非有限值一律归零，避免 NaN 污染整条绘制链路
        return Number.isFinite(next) ? next : 0
      })
      drawVisualizerBars(canvas, smoothed)

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
      // 尺寸完全交给 CSS 类（.now-playing-visualizer）。内联 height 会盖掉类的定位尺寸；
      // 内联 width:100% 更隐蔽——绝对定位元素同时有 left/right 时 right 会失效，
      // 画布因此整块右移并探出封面（v1.4.9 真机实测两侧各差 25.19px）。两个都不留。
      style={{ display: 'block' }}
    />
  )
}

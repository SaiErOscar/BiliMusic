import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { LyricLine } from '@/services/lyrics'

interface LyricsViewProps {
  lines: LyricLine[]
  currentTime: number
  synced: boolean
  onSeek: (time: number) => void
  /** 滚动动画行为；MV 导出离屏渲染传 'smooth' 捕获滚动中间态 */
  scrollBehavior?: ScrollBehavior
  /** 挂载后首次定位的行为（v1.4.7-pre2 MV 并行分段：初始即落位，不播从顶部滚入的动画）；缺省同 scrollBehavior */
  initialScrollBehavior?: ScrollBehavior
  /**
   * 重定位信号（v1.4.7-pre3）：值变化时立即以 'instant' 重新滚动到当前行。
   * MV 导出舞台在字体就绪后翻信号——初始定位发生在字体加载前，行高按回退字体测量，
   * 字体就绪后 offsetTop 变化，不重定位则首个换行会平滑滚一段残余距离（真机可见跳变）。
   */
  repositionSignal?: number
  /**
   * 时间驱动模式（v1.4.7-pre5 MV 导出歌词动画根修）：滚动位置与行样式全部改为
   * currentTime 的纯函数插值，不经浏览器 smooth 滚动 / framer-motion spring（两者按
   * 墙钟演化，离屏窗口按歌曲时间步进采样，动画进度与时间线解耦——成片里歌词滑动
   * 时快时慢、换行没滚完就切句；且多窗并行时各窗实际执行速度不同，接缝两侧动画
   * 状态不齐）。纯函数化后任意采样节奏下动画匀速精确，多窗接缝天然连续。
   */
  timeDriven?: boolean
}

// 二分：返回最后一个 time <= t 的下标
function activeIndexFor(lines: LyricLine[], t: number): number {
  let lo = 0
  let hi = lines.length - 1
  let res = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= t) {
      res = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return res
}

export default function LyricsView({ lines, currentTime, synced, onSeek, scrollBehavior = 'smooth', initialScrollBehavior, repositionSignal, timeDriven = false }: LyricsViewProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const userScrollingRef = useRef(false)
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [showScrollbar, setShowScrollbar] = useState(false)
  // 首次自动滚动用 initialScrollBehavior（MV 并行分段初始定位即时），此后恢复 scrollBehavior
  const firstAutoScrollRef = useRef(true)
  const lastRepositionRef = useRef(repositionSignal)

  const active = synced ? activeIndexFor(lines, currentTime) : -1
  const posIndex = Math.max(active, 0)

  const scrollActiveLineIntoView = () => {
    const vp = viewportRef.current
    const el = lineRefs.current[posIndex]
    if (!vp || !el) return
    const behavior = firstAutoScrollRef.current ? (initialScrollBehavior ?? scrollBehavior) : scrollBehavior
    firstAutoScrollRef.current = false
    const nextTop = el.offsetTop + el.offsetHeight / 2 - vp.clientHeight / 2
    vp.scrollTo({ top: Math.max(0, nextTop), behavior })
  }

  // 字体/布局就绪后的强制重定位（v1.4.7-pre3）：跳过用户滚动态判定，'instant' 不经 CSS 平滑
  useLayoutEffect(() => {
    if (repositionSignal === lastRepositionRef.current) return
    lastRepositionRef.current = repositionSignal
    const vp = viewportRef.current
    const el = lineRefs.current[posIndex]
    if (!vp || !el) return
    vp.scrollTo({ top: Math.max(0, el.offsetTop + el.offsetHeight / 2 - vp.clientHeight / 2), behavior: 'instant' as ScrollBehavior })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositionSignal])

  // 当前行变化 → 自动滚动到视口中间；用户手动滚动时短暂让出控制权。
  useLayoutEffect(() => {
    if (!synced) return
    if (timeDriven) return
    if (userScrollingRef.current) return
    scrollActiveLineIntoView()
  }, [posIndex, lines, synced, timeDriven])

  useEffect(() => {
    if (!synced) return
    if (timeDriven) return
    const recompute = () => scrollActiveLineIntoView()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [posIndex, synced, timeDriven])

  // ===== 时间驱动滚动（v1.4.7-pre5）：滚动位置 = currentTime 的分段线性函数 =====
  //
  // 设每行起点 t_i，换行动画时长 D=0.45s、可用缓动 easeOutCubic：
  // 目标滚动位 target_i = 行 i 居中位置。在 [t_i, t_i+D] 区间从 target_{i-1} 向 target_i
  // 按 easeOutCubic(p) 插值，其余时间停在 target_i。滚动位置只依赖 currentTime，
  // 采样节奏（0.03s 网格/多窗分段/掉帧）只影响采样密度不影响动画形状，成片里滑动
  // 匀速可期，多窗接缝两侧同时间参数同位置。
  const D_SCROLL = 0.45
  const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3)

  const timeDrivenTop = (): number | null => {
    const vp = viewportRef.current
    if (!vp || !lines.length) return null
    const targetOf = (idx: number): number => {
      const el = lineRefs.current[idx]
      if (!el) return 0
      return Math.max(0, el.offsetTop + el.offsetHeight / 2 - vp.clientHeight / 2)
    }
    const cur = Math.max(0, posIndex)
    const from = targetOf(Math.max(0, cur - 1))
    const to = targetOf(cur)
    if (cur === 0) return to
    const lineStart = lines[cur]?.time ?? 0
    const p = Math.min(1, Math.max(0, (currentTime - lineStart) / D_SCROLL))
    return from + (to - from) * easeOutCubic(p)
  }

  useLayoutEffect(() => {
    if (!synced || !timeDriven) return
    const top = timeDrivenTop()
    if (top == null) return
    const vp = viewportRef.current
    if (!vp) return
    vp.scrollTo({ top, behavior: 'instant' as ScrollBehavior })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, lines, synced, timeDriven])

  useEffect(() => {
    return () => {
      if (userScrollTimerRef.current) clearTimeout(userScrollTimerRef.current)
    }
  }, [])

  const markUserScrolling = () => {
    userScrollingRef.current = true
    setShowScrollbar(true)
    if (userScrollTimerRef.current) clearTimeout(userScrollTimerRef.current)
    userScrollTimerRef.current = setTimeout(() => {
      userScrollingRef.current = false
      setShowScrollbar(false)
    }, 2600)
  }

  const fade = 'linear-gradient(to bottom, transparent 0%, #000 13%, #000 84%, transparent 100%)'

  // 无时间戳：静态可滚动列表
  if (!synced) {
    return (
      <div
        className={`lyrics-scroll ${showScrollbar ? 'is-scrolling' : ''}`}
        style={{
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          maskImage: fade,
          WebkitMaskImage: fade,
          padding: '12% 4px',
        }}
      >
        {lines.map((l, i) => (
          <motion.p
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, delay: Math.min(i * 0.018, 0.22) }}
            style={{
              fontSize: 'clamp(1.2rem, 1.6vw, 1.7rem)',
              fontWeight: 720,
              fontFamily: 'var(--app-lyric-font, inherit)',
              lineHeight: 1.7,
              color: 'rgba(255,255,255,0.72)',
              margin: '0 0 6px',
            }}
          >
            {l.text}
          </motion.p>
        ))}
      </div>
    )
  }

  // 同步：spring 弹动居中 + 级联高亮
  return (
    <div
      ref={viewportRef}
      className={`lyrics-scroll ${showScrollbar ? 'is-scrolling' : ''}`}
      onWheel={markUserScrolling}
      onTouchMove={markUserScrolling}
      style={{
        position: 'relative',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        maskImage: fade,
        WebkitMaskImage: fade,
      }}
    >
      <motion.div
        initial={timeDriven ? false : { opacity: 0, y: 18 }}
        animate={timeDriven ? undefined : { opacity: 1, y: 0 }}
        transition={timeDriven ? undefined : { duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
        style={{ padding: '36% 0' }}
      >
        {lines.map((l, i) => {
          const isActive = i === active
          const dist = Math.abs(i - posIndex)
          const isNear = dist === 1
          // 时间驱动模式：行样式 = currentTime 的分段线性插值（与滚动同一套缓动），
          // 覆盖行 i 的 [t_i, t_i+D_STYLE] 区间从「非活跃」渐入「活跃」；D_STYLE 与
          // spring 观感时长接近，动画进度只由歌曲时间决定。
          let tdStyle: React.CSSProperties | null = null
          if (timeDriven) {
            const D_STYLE = 0.4
            const start = l.time ?? 0
            const p = Math.min(1, Math.max(0, (currentTime - start) / D_STYLE))
            const e = easeOutCubic(p)
            const prevActive = i === posIndex - 1
            const opPrev = 0.46, opNear = 0.22, scPrev = 1.015, scNear = 0.985, xPrev = 4
            const opacity = isActive ? opPrev + (1 - opPrev) * e : prevActive ? opPrev - (opPrev - opNear) * e : opNear
            const scale = isActive ? scNear + (1.075 - scNear) * e : prevActive ? scPrev - (scPrev - scNear) * e : scNear
            const x = isActive ? xPrev * e : prevActive ? xPrev * (1 - e) : 0
            const blur = isActive ? 0.5 * (1 - e) : prevActive ? 0.5 + (1.5 - 0.5) * e : 1.5
            tdStyle = {
              opacity,
              transform: `translateX(${x}px) scale(${scale})`,
              filter: `blur(${blur}px)`,
              transformOrigin: 'left center',
            }
          }
          return (
            <motion.div
              key={i}
              ref={(el) => { lineRefs.current[i] = el }}
              onClick={() => onSeek(l.time)}
              animate={timeDriven ? undefined : {
                opacity: isActive ? 1 : isNear ? 0.46 : 0.22,
                scale: isActive ? 1.075 : isNear ? 1.015 : 0.985,
                x: isActive ? 14 : isNear ? 4 : 0,
                filter: isActive ? 'blur(0px)' : isNear ? 'blur(0.5px)' : 'blur(1.5px)',
              }}
              transition={timeDriven ? undefined : {
                type: 'spring',
                stiffness: 150,
                damping: 24,
                delay: Math.min(dist * 0.025, 0.18),
              }}
              style={{
                transformOrigin: 'left center',
                cursor: 'pointer',
                color: '#fff',
                fontSize: 'clamp(1.46rem, 2.4vw, 2.42rem)',
                fontWeight: 820,
                fontFamily: 'var(--app-lyric-font, inherit)',
                lineHeight: 1.38,
                padding: '10px 8px',
                margin: 0,
                textShadow: isActive ? '0 8px 34px rgba(0,0,0,0.44), 0 0 26px rgba(255,255,255,0.1)' : 'none',
                ...(tdStyle || {}),
              }}
            >
              {l.text}
            </motion.div>
          )
        })}
      </motion.div>
    </div>
  )
}

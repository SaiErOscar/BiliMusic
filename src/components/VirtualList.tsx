/**
 * v1.4.9-pre4 大列表虚拟化：固定行高窗口渲染。
 *
 * 为什么自己写而不用第三方：
 * - 本项目的列表行是统一高度（`.am-track-row` 为 min-height:68px + 固定内边距，
 *   标题与歌手都是 nowrap+ellipsis），属于最简单的定高场景，第三方库的
 *   动态测量、ResizeObserver、多列等能力全用不上，反而多一份依赖与调试成本。
 * - 需要精确控制「滚动容器是哪个」——本项目的滚动发生在 MainLayout 的 <main>
 *   上，不是 window 也不是列表自身。第三方库默认盯 window，接入要额外传
 *   scrollParent，和自己写差不多。
 *
 * 布局策略（padding 撑高，不绝对定位）：
 * - 外层容器高度 = 总行数 × 行高，把滚动条撑到正确长度；
 * - 用 padding-top / padding-bottom 把可见区推到正确位置，中间只渲染窗口内的行。
 *   相比 top: Npx + position:absolute，这种写法不脱离文档流，行内的
 *   hover/边框/圆角行为与原实现完全一致，也不用担心绝对定位下父容器塌陷。
 *
 * 不改变既有交互：本组件只决定「渲染哪一段」，行本身仍是调用方给的节点，
 * 拖拽、选择模式、点击事件全部原样工作——前提是调用方传的 rowHeight 与真实
 * 行高一致，否则窗口会错位（见下方 rowHeight 说明）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** 默认行高：`.am-track-row` 的 min-height 68px（实测含边框约 69px，取 68 留 1px 余量） */
export const DEFAULT_ROW_HEIGHT = 68

/** 视口上下各多渲染的行数，减少快速滚动时的白屏 */
const OVERSCAN = 6

/** 首屏渲染前无法测量容器时，按这个高度估算可见行数（约等于常见窗口） */
const FALLBACK_VIEWPORT_HEIGHT = 800

interface VirtualListProps<T> {
  items: T[]
  /** 单行高度（px）。必须与真实渲染高度一致，否则窗口错位 */
  rowHeight?: number
  /** 渲染单行；index 是数据下标（不是渲染序号），调用方用它显示序号与判断选中 */
  renderRow: (item: T, index: number) => ReactNode
  /** 列表为空时渲染的内容 */
  empty?: ReactNode
  /**
   * 关闭虚拟化（全量渲染）。
   * 歌单页拖拽排序需要全部行存在 DOM 里才能计算落点，排序态下由调用方置 true。
   */
  disabled?: boolean
  /** 数据量低于该值时直接全量渲染：短列表虚拟化没有收益，反而多一层结构 */
  threshold?: number
  className?: string
  /** 滚动容器；不传则向上找第一个可滚动的祖先，找不到退化为 window */
  scrollParent?: HTMLElement | null
}

/**
 * 向上查找最近的可滚动祖先。
 *
 * 判定条件用 computedStyle 而不是 scrollHeight > clientHeight：后者在列表刚挂载、
 * 内容还没撑开时会误判成「不可滚动」，导致绑到 window 上而永远收不到滚动事件。
 */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null
  while (el) {
    const style = window.getComputedStyle(el)
    const overflowY = style.overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && el.scrollHeight > el.clientHeight) {
      return el
    }
    el = el.parentElement
  }
  return null
}

export default function VirtualList<T>({
  items,
  rowHeight = DEFAULT_ROW_HEIGHT,
  renderRow,
  empty = null,
  disabled = false,
  threshold = 60,
  className,
  scrollParent,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // 滚动容器：优先用传入的，否则挂载后自己找
  const [scroller, setScroller] = useState<HTMLElement | null>(scrollParent ?? null)
  // 窗口起止（数据下标）
  const [range, setRange] = useState({ start: 0, end: 0 })
  // 视口高度，用于算可见行数
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT)

  const total = items.length
  // 短列表直接全量：虚拟化对几十行没有收益，多一层 padding 反而让 DOM 结构变形
  const active = !disabled && total > threshold

  // 解析滚动容器（挂载后 + scrollParent 变化时）
  useEffect(() => {
    if (scrollParent) {
      setScroller(scrollParent)
      return
    }
    setScroller(findScrollParent(containerRef.current))
  }, [scrollParent])

  /**
   * 重算可见窗口。
   *
   * 用「列表顶部相对滚动容器的位置」而不是列表自身 scrollTop：列表不是滚动容器，
   * 它随整个页面移动。所以可见区间 = (scrollTop - listTop) / rowHeight。
   */
  const recalc = useCallback(() => {
    const el = containerRef.current
    if (!el || !active) return

    const parent = scroller
    const parentTop = parent ? parent.getBoundingClientRect().top : 0
    const parentHeight = parent ? parent.clientHeight : window.innerHeight
    const listTop = el.getBoundingClientRect().top - parentTop
    const scrolled = -listTop // 列表顶部已滚出视口多少（负数表示还没滚到）

    setViewportHeight(parentHeight)

    const firstVisible = Math.floor(Math.max(0, scrolled) / rowHeight)
    const visibleCount = Math.ceil(parentHeight / rowHeight) + 1
    const start = Math.max(0, firstVisible - OVERSCAN)
    const end = Math.min(total, firstVisible + visibleCount + OVERSCAN)

    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [active, rowHeight, scroller, total])

  // 首帧与数据变化时重算（layout 阶段算，避免先闪一帧全量再收起）
  useLayoutEffect(() => {
    recalc()
  }, [recalc, total])

  // 绑定滚动与尺寸变化
  useEffect(() => {
    if (!active) return
    const target: HTMLElement | Window = scroller ?? window
    const handler = () => recalc()
    target.addEventListener('scroll', handler, { passive: true })
    window.addEventListener('resize', handler)
    return () => {
      target.removeEventListener('scroll', handler)
      window.removeEventListener('resize', handler)
    }
  }, [active, scroller, recalc])

  // 关闭虚拟化 / 短列表：原样全量渲染，行为与改动前完全一致
  if (!active) {
    return (
      <div className={className} ref={containerRef}>
        {total === 0 ? empty : items.map((item, i) => renderRow(item, i))}
      </div>
    )
  }

  const { start, end } = range
  // 首帧 range 还是初始值 {0,0} 时，先按「视口能装多少」渲染一批，避免空白
  const effectiveEnd = end > start ? end : Math.min(total, Math.ceil(viewportHeight / rowHeight) + OVERSCAN)
  const paddingTop = start * rowHeight
  const paddingBottom = Math.max(0, (total - effectiveEnd) * rowHeight)

  return (
    <div
      className={className}
      ref={containerRef}
      style={{
        paddingTop,
        paddingBottom,
        // 高度由 padding 撑开；不设 height，避免与外层 flex/圆角冲突
        boxSizing: 'border-box',
      }}
    >
      {total === 0
        ? empty
        : items.slice(start, effectiveEnd).map((item, i) => renderRow(item, start + i))}
    </div>
  )
}

/**
 * 供测试与调用方使用的纯函数：计算可见区间。
 *
 * 抽出来单独导出，是因为真实组件依赖 getBoundingClientRect（jsdom 里恒为 0，
 * 测不出真实滚动行为）。这里把核心算术独立成纯函数，单测直接覆盖边界情况。
 *
 * @param scrollTop        列表顶部相对滚动容器的偏移（已滚出视口的距离，负数归零）
 * @param viewportHeight   滚动容器可视高度
 * @param rowHeight        单行高度
 * @param total            数据总行数
 * @param overscan         上下额外渲染行数
 */
export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const safeViewport = Math.max(0, viewportHeight)
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visibleCount = Math.ceil(safeViewport / rowHeight) + 1
  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(total, firstVisible + visibleCount + overscan)
  return { start: Math.min(start, total), end: Math.max(end, Math.min(total, start)) }
}

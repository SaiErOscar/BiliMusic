import { useEffect, useState } from 'react'
import type { DesktopLyricState } from '@/types/electron'

/**
 * 桌面歌词状态 hook（v1.3.1 意图/抑制分离后）。
 *
 * - 挂载时向主进程查询桌面歌词状态
 * - 监听主进程推送的状态变化（toggle / 窗口焦点 / 播放页开关后实时同步）
 * - visible：用户意图（按钮文字跟随它，而非窗口实际可见性）
 * - suppressed：播放页抑制中（此时 intent=true 也不会立即显示）
 * - toggle：切换用户意图，实际显示由主进程状态机决定
 */
export function useDesktopLyricVisible() {
  const [state, setState] = useState<DesktopLyricState>({ visible: false, intent: false, suppressed: false })

  useEffect(() => {
    let mounted = true
    window.electronAPI?.getDesktopLyricVisible?.()
      .then((v) => {
        if (mounted && v && typeof v === 'object') setState(v)
      })
      .catch(() => { /* 主进程不可用时降级 */ })
    const off = window.electronAPI?.onDesktopLyricVisible?.((v) => {
      if (v && typeof v === 'object') setState(v)
    })
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  const toggle = () => window.electronAPI?.toggleDesktopLyric?.()

  return { visible: state.intent, suppressed: state.suppressed, state, toggle }
}

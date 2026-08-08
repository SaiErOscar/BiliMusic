import { useEffect, useState } from 'react'

/**
 * 桌面歌词窗的可见状态 hook。
 *
 * - 挂载时向主进程查询桌面歌词当前是否可见
 * - 监听主进程推送的可见状态变化（打开/关闭后实时同步）
 * - 提供 toggle 用于切换桌面歌词开关
 */
export function useDesktopLyricVisible() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let mounted = true
    window.electronAPI?.getDesktopLyricVisible?.()
      .then((v) => { if (mounted) setVisible(Boolean(v)) })
      .catch(() => { /* 主进程不可用时降级 */ })
    const off = window.electronAPI?.onDesktopLyricVisible?.((v) => setVisible(Boolean(v)))
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  const toggle = () => window.electronAPI?.toggleDesktopLyric?.()

  return { visible, toggle }
}

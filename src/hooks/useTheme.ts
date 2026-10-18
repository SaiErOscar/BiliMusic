import { useState, useEffect } from 'react'
import type { ThemeMode } from '@/types'
import { applyTheme, initTheme, readStoredMode, writeStoredMode } from '@/theme/apply'

// 首次加载时同步应用主题与主题配色，避免 FOUC（模块被导入即执行，幂等）
initTheme()

export function useTheme() {
  // 惰性读取：每次挂载都从存储取最新值，
  // 避免路由切回设置页时用陈旧的模块级初始值导致主题回退为「系统」
  const [mode, setMode] = useState<ThemeMode>(readStoredMode)

  useEffect(() => {
    applyTheme(mode)
    writeStoredMode(mode)
  }, [mode])

  // v1.4.3-pre7：备份导入等外部修改主题后，同步刷新本组件状态（否则开关回显滞后）
  useEffect(() => {
    const handler = () => setMode(readStoredMode())
    window.addEventListener('bilimusic:theme-changed', handler)
    return () => window.removeEventListener('bilimusic:theme-changed', handler)
  }, [])

  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode])

  const toggle = () => {
    setMode(prev => {
      if (prev === 'light') return 'dark'
      if (prev === 'dark') return 'system'
      return 'light'
    })
  }

  return { mode, setMode, toggle }
}

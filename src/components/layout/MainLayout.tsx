import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import PlayerBar from './PlayerBar'
import NowPlaying from '@/components/NowPlaying'
import { useMiniWindowSync } from '@/hooks/useMiniWindowSync'
import { useNowPlaying } from '@/contexts/NowPlayingContext'

export default function MainLayout() {
  // 迷你窗口（桌面歌词/悬浮窗）状态同步：挂在主布局，随播放状态实时推送
  useMiniWindowSync()
  const { expanded, open } = useNowPlaying()
  const wasLyricVisibleRef = useRef(false)

  // 打开播放页时自动隐藏桌面歌词（不关闭），退出播放页时自动恢复显示
  useEffect(() => {
    if (expanded) {
      window.electronAPI?.getDesktopLyricVisible?.().then((v) => {
        wasLyricVisibleRef.current = Boolean(v)
        if (v) window.electronAPI?.hideDesktopLyric?.()
      })
    } else {
      if (wasLyricVisibleRef.current) {
        wasLyricVisibleRef.current = false
        window.electronAPI?.showDesktopLyric?.()
      }
    }
  }, [expanded])

  // 桌面歌词「打开播放器」→ 弹出主窗口并打开当前歌曲播放页
  useEffect(() => {
    return window.electronAPI?.onOpenNowPlaying?.(() => open())
  }, [open])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
      }}
    >
      <TitleBar />

      <div
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        }}
      >
        <Sidebar />

        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            background: 'var(--color-background)',
            padding: 'var(--space-lg) var(--space-xl)',
          }}
        >
          <Outlet />
        </main>
      </div>

      <PlayerBar />

      <NowPlaying />
    </div>
  )
}
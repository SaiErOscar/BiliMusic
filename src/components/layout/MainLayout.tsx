import { useEffect } from 'react'
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

  // v1.3.1：向主进程上报播放页开关状态，桌面歌词的隐藏/恢复
  // 统一由主进程状态机决定（意图与抑制分离），渲染层不再直接控制显隐
  useEffect(() => {
    window.electronAPI?.setNowPlayingOpen?.(expanded)
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
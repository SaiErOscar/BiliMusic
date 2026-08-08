import { Outlet } from 'react-router-dom'
import TitleBar from './TitleBar'
import Sidebar from './Sidebar'
import PlayerBar from './PlayerBar'
import NowPlaying from '@/components/NowPlaying'
import { useMiniWindowSync } from '@/hooks/useMiniWindowSync'

export default function MainLayout() {
  // 迷你窗口（桌面歌词/悬浮窗）状态同步：挂在主布局，随播放状态实时推送
  useMiniWindowSync()

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
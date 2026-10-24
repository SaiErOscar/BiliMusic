import { lazy, useEffect } from 'react'
import ErrorBoundary from '@/components/ErrorBoundary'
import { Routes, Route } from 'react-router-dom'
import { useAutoSync } from '@/hooks/useAutoSync'
import { platform } from '@/platform'
import { useAutoBiliFavoritesSync } from '@/hooks/useAutoBiliFavoritesSync'
import { PlayerProvider } from '@/contexts/PlayerContext'
import { NowPlayingProvider } from '@/contexts/NowPlayingContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { AddToPlaylistProvider } from '@/contexts/AddToPlaylistContext'
import LoginDialog from '@/components/LoginDialog'
import MainLayout from '@/components/layout/MainLayout'
import Discover from '@/pages/Discover'

// 路由级代码分割：只有首屏默认路由 Discover 静态打入入口包，其余页面按需拉取。
// 此前全部页面静态导入，入口 chunk 近 700KB，冷启动要为「可能永远不会打开的页面」
// 付出解析+编译成本。Suspense 边界在 MainLayout 的 <main> 内，切页时侧栏/播放条不挂起。
const SearchPage = lazy(() => import('@/pages/Search'))
const Recommend = lazy(() => import('@/pages/Recommend'))
const Recent = lazy(() => import('@/pages/Recent'))
const Favorites = lazy(() => import('@/pages/Favorites'))
const Playlists = lazy(() => import('@/pages/Playlists'))
const Downloads = lazy(() => import('@/pages/Downloads'))
const BiliFavorites = lazy(() => import('@/pages/BiliFavorites'))
const Settings = lazy(() => import('@/pages/Settings'))

function GlobalLoginDialog() {
  const { showLogin, setShowLogin, checkLogin } = useAuth()
  if (!showLogin) return null
  return (
    <LoginDialog
      onClose={() => setShowLogin(false)}
      onSuccess={() => {
        setShowLogin(false)
        checkLogin()
      }}
    />
  )
}

export default function App() {
  // 渲染层成功挂载后回报主进程：确认当前（可能是 OTA 热补丁的）渲染包可用，避免下次启动误回滚
  useEffect(() => {
    platform.runtime?.notifyRendererReady?.()
  }, [])

  // 云同步自动触发（启动 + 改动防抖 + 周期）
  useAutoSync()
  useAutoBiliFavoritesSync()

  return (
    <ErrorBoundary>
      <AuthProvider>
      <PlayerProvider>
        <NowPlayingProvider>
          <AddToPlaylistProvider>
            <Routes>
              <Route element={<MainLayout />}>
                <Route path="/" element={<Discover />} />
                <Route path="/discover" element={<Discover />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/recommend" element={<Recommend />} />
                <Route path="/recent" element={<Recent />} />
                <Route path="/favorites" element={<Favorites />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/playlists/:playlistId" element={<Playlists />} />
                <Route path="/downloads" element={<Downloads />} />
                <Route path="/bili-favorites" element={<BiliFavorites />} />
                <Route path="/settings" element={<Settings />} />
              </Route>
            </Routes>
            <GlobalLoginDialog />
          </AddToPlaylistProvider>
        </NowPlayingProvider>
      </PlayerProvider>
    </AuthProvider>
    </ErrorBoundary>
  )
}

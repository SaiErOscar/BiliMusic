import { useEffect, useRef } from 'react'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { platform } from '@/platform'

/**
 * Android 通知栏媒体控制（v1.4.7-pre4）：把播放器状态推给原生前台服务
 * （MediaSession + MediaStyle 通知），并订阅系统媒体控件的用户指令。
 * WebView 内 audio 仍是真正播放器，指令经 platform.mediaNotify 回抛后
 * 调用 PlayerContext 的 play/pause/next/prev/setProgress 执行。
 * 桌面端走 navigator.mediaSession（PlayerContext 已有），本 hook 仅在
 * Capacitor 原生容器生效（platform.mediaNotify 缺失即整体跳过）。
 */
export function useMediaSessionRemote() {
  const player = usePlayer()
  const { progress, duration, setProgress } = usePlayerProgress()

  const stateRef = useRef({ player, progress, duration, setProgress })
  stateRef.current = { player, progress, duration, setProgress }

  // 指令订阅（挂载一次；经 ref 读最新状态，避免重订阅）
  useEffect(() => {
    const cap = platform.mediaNotify
    if (!cap) return
    return cap.onCommand((action, value) => {
      const s = stateRef.current
      const p = s.player
      switch (action) {
        case 'play':
          if (!p.isPlaying) p.togglePlay()
          break
        case 'pause':
          if (p.isPlaying) p.togglePlay()
          break
        case 'next':
          p.next()
          break
        case 'previous':
          p.prev()
          break
        case 'seek':
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            s.setProgress(value)
          }
          break
      }
    })
  }, [])

  // 状态推送：曲目/播放态变化即推；播放中以 5s 节流刷新进度（对齐进度持久化节奏）
  useEffect(() => {
    const cap = platform.mediaNotify
    if (!cap) return
    const track = player.currentTrack
    if (!track) {
      void cap.stopSession().catch(() => {})
      return
    }
    const push = () => {
      const s = stateRef.current
      void cap.updateSession({
        title: track.title,
        artist: track.artist || '',
        coverUrl: track.coverUrl || undefined,
        isPlaying: s.player.isPlaying,
        positionSec: Math.round(s.progress),
        durationSec: Math.round(s.duration || track.duration || 0),
      }).catch(() => {})
    }
    push()
    if (!player.isPlaying) return
    const timer = setInterval(push, 5_000)
    return () => clearInterval(timer)
  }, [player.currentTrack, player.isPlaying])
}

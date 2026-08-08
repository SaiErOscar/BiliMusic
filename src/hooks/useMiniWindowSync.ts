import { useEffect, useRef, useState } from 'react'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { getLyricForTrack } from '@/services/lyrics'
import { useAppSettings } from '@/hooks/useAppSettings'
import type { MiniPlayerState, MiniCommand } from '@/types/electron'

/**
 * 迷你窗口（桌面歌词窗 / 悬浮窗）状态同步 hook。
 *
 * 挂载一次即可：
 * - 曲目变化时拉取歌词，供两个小窗显示
 * - 以 100ms 节流把完整播放状态（曲目/进度/音量/歌词行）推送给主进程，由主进程广播给小窗
 *   说明：降低推送间隔以减少桌面歌词歌词随播放切换的延迟（原 500ms）
 * - 监听并处理小窗发来的音量 / 进度命令
 */
export function useMiniWindowSync() {
  const player = usePlayer()
  const { progress, duration, setProgress } = usePlayerProgress()
  const { settings } = useAppSettings()
  const [lyrics, setLyrics] = useState<{ lines: { time: number; text: string }[]; synced: boolean }>({
    lines: [],
    synced: false,
  })
  const trackId = player.currentTrack?.id

  // 曲目变化时获取歌词（供桌面歌词/悬浮窗使用，与歌词页的 useLyrics 相互独立）
  useEffect(() => {
    let cancelled = false
    const track = player.currentTrack
    if (!track) {
      setLyrics({ lines: [], synced: false })
      return
    }
    getLyricForTrack(track)
      .then((res) => {
        if (cancelled) return
        setLyrics({ lines: res?.lines || [], synced: Boolean(res?.synced) })
      })
      .catch(() => {
        if (!cancelled) setLyrics({ lines: [], synced: false })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId])

  // 用 ref 保存最新状态，interval 定时读取，避免高频 progress 变化反复重建定时器
  const stateRef = useRef<MiniPlayerState>({
    hasTrack: false,
    title: '',
    artist: '',
    coverUrl: '',
    isPlaying: false,
    volume: 80,
    isMuted: false,
    progress: 0,
    duration: 0,
    lyricLines: [],
    synced: false,
    theme: 'dark',
    lyricTextColor: settings.lyricTextColor,
    lyricControlColor: settings.lyricControlColor,
  })
  stateRef.current = {
    hasTrack: Boolean(player.currentTrack),
    title: player.currentTrack?.title || '',
    artist: player.currentTrack?.artist || '',
    coverUrl: player.currentTrack?.coverUrl || '',
    isPlaying: player.isPlaying,
    volume: player.volume,
    isMuted: player.isMuted,
    progress,
    duration,
    lyricLines: lyrics.lines,
    synced: lyrics.synced,
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    lyricTextColor: settings.lyricTextColor,
    lyricControlColor: settings.lyricControlColor,
  }

  // 节流推送完整状态到主进程
  useEffect(() => {
    const push = () => window.electronAPI?.updateMiniPlayerState?.(stateRef.current)
    push()
    const timer = setInterval(push, 100)
    return () => clearInterval(timer)
  }, [])

  // 处理小窗发来的音量 / 进度命令
  useEffect(() => {
    return window.electronAPI?.onMiniPlayerCommand?.((cmd: MiniCommand) => {
      if (cmd.type === 'volume') player.setVolume(cmd.value)
      else if (cmd.type === 'seek') setProgress(cmd.value)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

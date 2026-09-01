import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { getLyricForTrack, LYRIC_OFFSET_CHANGED_EVENT } from '@/services/lyrics'
import { useAppSettings } from '@/hooks/useAppSettings'
import type { MiniPlayerState, MiniCommand } from '@/types/electron'

/**
 * 迷你窗口（桌面歌词窗）状态同步 hook。
 *
 * 挂载一次即可：
 * - 曲目变化时拉取歌词，供桌面歌词窗显示
 * - 实时推送完整播放状态（曲目/进度/音量/歌词行）给主进程，由主进程广播给桌面歌词窗
 *   说明：不再用定时节流，改为「每次关键状态变化即推送」（progress 由 audio timeupdate 驱动，
 *   约 250ms 一次），歌词高亮与播放/暂停切换即时同步
 * - 监听并处理小窗发来的音量 / 进度 / 播放顺序命令
 */
export function useMiniWindowSync() {
  const player = usePlayer()
  const { progress, duration, setProgress } = usePlayerProgress()
  const { settings, setAppSettings } = useAppSettings()
  const [lyrics, setLyrics] = useState<{ lines: { time: number; text: string }[]; synced: boolean }>({
    lines: [],
    synced: false,
  })
  const trackId = player.currentTrack?.id

  // 主题状态：监听 <html data-theme> 变化，保证实时推送里 theme 不滞后
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
  )
  useEffect(() => {
    const ob = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
    })
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => ob.disconnect()
  }, [])

  // 监听歌词偏移变化：播放页调整偏移后，桌面歌词据此重新拉取歌词以保持同步
  const [offsetVersion, setOffsetVersion] = useState(0)
  useEffect(() => {
    const onOffset = () => setOffsetVersion((v) => v + 1)
    window.addEventListener(LYRIC_OFFSET_CHANGED_EVENT, onOffset)
    return () => window.removeEventListener(LYRIC_OFFSET_CHANGED_EVENT, onOffset)
  }, [])

  // 曲目变化时获取歌词（供桌面歌词使用，与歌词页的 useLyrics 相互独立）
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
  }, [trackId, offsetVersion])

  // 实时组装完整播放状态：任一关键字段变化即重建对象
  const miniState = useMemo<MiniPlayerState>(() => ({
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
    theme,
    lyricTextColor: settings.lyricTextColor,
    lyricControlColor: settings.lyricControlColor,
    lyricFontSize: settings.lyricFontSize,
    lyricFontWeight: settings.lyricFontWeight,
    repeatMode: player.repeatMode,
  }), [
    player.currentTrack,
    player.isPlaying,
    player.volume,
    player.isMuted,
    progress,
    duration,
    lyrics.lines,
    lyrics.synced,
    theme,
    settings.lyricTextColor,
    settings.lyricControlColor,
    settings.lyricFontSize,
    settings.lyricFontWeight,
    player.repeatMode,
  ])

  // 实时推送：每次 miniState 变化（progress/播放状态/歌词/主题/配色等）即发送给主进程
  useEffect(() => {
    window.electronAPI?.updateMiniPlayerState?.(miniState)
  }, [miniState])

  // 命令回调闭包只注册一次，用 ref 持有最新 repeatMode，避免读到初始值
  const repeatModeRef = useRef(player.repeatMode)
  repeatModeRef.current = player.repeatMode

  // 处理小窗发来的音量 / 进度 / 播放顺序命令
  useEffect(() => {
    return window.electronAPI?.onMiniPlayerCommand?.((cmd: MiniCommand) => {
      if (cmd.type === 'update-lyric-appearance') {
        // v1.3.6 桌面歌词窗外观小面板：持久化到 AppSettings，
        // settings 变化经上方 miniState 推送回流歌词窗，形成即时生效闭环
        const patch: { lyricTextColor?: string; lyricControlColor?: string; lyricFontSize?: number; lyricFontWeight?: number } = {}
        if (typeof cmd.lyricTextColor === 'string') patch.lyricTextColor = cmd.lyricTextColor
        if (typeof cmd.lyricControlColor === 'string') patch.lyricControlColor = cmd.lyricControlColor
        if (Number.isFinite(cmd.lyricFontSize)) patch.lyricFontSize = cmd.lyricFontSize
        if (Number.isFinite(cmd.lyricFontWeight)) patch.lyricFontWeight = cmd.lyricFontWeight
        setAppSettings(patch)
      } else if (cmd.type === 'volume') player.setVolume(cmd.value)
      else if (cmd.type === 'seek') setProgress(cmd.value)
      else if (cmd.type === 'cycle-repeat-mode') {
        // 桌面歌词窗播放顺序按钮：none → all → one → shuffle → none（v1.3.2）
        const order = ['none', 'all', 'one', 'shuffle'] as const
        const idx = order.indexOf(repeatModeRef.current)
        player.setRepeatMode(order[(idx + 1) % order.length])
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

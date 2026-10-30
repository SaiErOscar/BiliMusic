import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { getLyricForTrack, LYRIC_OFFSET_CHANGED_EVENT } from '@/services/lyrics'
import { useAppSettings } from '@/hooks/useAppSettings'
import { attachSubLines, detectLyricLanguage } from '@/services/desktopLyricLines'
import { aiChat } from '@/services/ai'
import { getAiConfig } from '@/services/ai'
import { AI_LYRIC_BATCH, pickTranslatableIndexes, parseLyricLines } from '@/services/aiLyrics'
import { platform } from '@/platform'
import type { MiniPlayerState, MiniCommand } from '@/types/electron'
import type { AppSettings } from '@/types'

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
/**
 * v1.4.13-pre11：为桌面歌词做一次「只翻译」的 AI 增强。
 *
 * 与播放页的 aiLyrics 复用同一套分批与解析，但不落任何缓存——
 * 桌面歌词的副行是瞬时展示，关掉开关就该消失，不该污染歌词缓存。
 *
 * @returns 行号 → 译文（只含有结果的行）
 */
async function enhanceLyricsForDesktop(lines: { time: number; text: string }[]): Promise<Map<number, string>> {
  const config = await getAiConfig()
  const indexes = pickTranslatableIndexes(lines as never)
  const out = new Map<number, string>()
  for (let start = 0; start < indexes.length; start += AI_LYRIC_BATCH) {
    const batch = indexes.slice(start, start + AI_LYRIC_BATCH)
    const payload = batch.map((i) => ({ index: i, text: lines[i].text }))
    const reply = await aiChat(config, {
      messages: [
        {
          role: 'system',
          content:
            '你是歌词翻译。把每行歌词译成简体中文，保留语气。'
            + '只返回 JSON 数组，元素形如 {"index": 原行号, "text": "译文"}，不要解释。',
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      temperature: 0.2,
      timeoutMs: 45000,
    })
    for (const item of parseLyricLines(reply)) {
      if (item.text) out.set(item.index, item.text)
    }
  }
  return out
}

export function useMiniWindowSync() {
  const player = usePlayer()
  const { progress, duration, setProgress } = usePlayerProgress()
  const { settings, setAppSettings } = useAppSettings()
  const [lyrics, setLyrics] = useState<{
    lines: { time: number; text: string; sub?: string }[]
    synced: boolean
    noLyric: boolean
  }>({
    lines: [],
    synced: false,
    noLyric: false,
  })
  const trackId = player.currentTrack?.id
  /**
   * v1.4.13-pre11：拉歌词的 effect 依赖里不能塞整个 settings
   * （设置每次变化都会重拉一次歌词，代价太大），
   * 但又要读到最新的两个开关——用 ref 取当前值。
   */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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
      setLyrics({ lines: [], synced: false, noLyric: false })
      return
    }
    getLyricForTrack(track)
      .then(async (res) => {
        if (cancelled) return
        /*
         * v1.4.13-pre11（用户第 5 项）：把译文 / AI 增强作为副行一起送进歌词窗。
         * 官方 tlyric 优先；没有译文时若开了「外文自动增强」，再补一次 AI 结果。
         * 副行开关关闭时不下发 sub，歌词窗自然只显示主行。
         */
        const baseLines = res?.lines || []
        let withSub = baseLines
        if (settingsRef.current.desktopLyricSubline) {
          const subMap = new Map<number, string>()
          baseLines.forEach((line, i) => {
            const translated = (line as { ttext?: string }).ttext
            if (translated && translated.trim()) subMap.set(i, translated.trim())
          })
          if (subMap.size === 0 && settingsRef.current.autoAiLyricForeign) {
            const lang = detectLyricLanguage(baseLines)
            if (lang === 'foreign') {
              try {
                const ai = await enhanceLyricsForDesktop(baseLines)
                ai.forEach((text, i) => subMap.set(i, text))
              } catch {
                /* 自动增强失败不阻塞歌词显示 */
              }
            }
          }
          withSub = attachSubLines(baseLines, subMap)
        }
        // v1.4.5：透传 noLyric（用户主动「不显示歌词」），歌词窗据此显示「无歌词」
        setLyrics({ lines: withSub, synced: Boolean(res?.synced), noLyric: Boolean(res?.noLyric) })
      })
      .catch(() => {
        if (!cancelled) setLyrics({ lines: [], synced: false, noLyric: false })
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
    lyricFontFamily: settings.lyricFontFamily,
    repeatMode: player.repeatMode,
    autoTextColor: settings.autoTextColor,
    autoControlColor: settings.autoControlColor,
    autoLyricTextColor: settings.autoLyricTextColor,
    autoLyricControlColor: settings.autoLyricControlColor,
    noLyric: lyrics.noLyric,
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
    settings.lyricFontFamily,
    player.repeatMode,
    settings.autoTextColor,
    settings.autoControlColor,
    settings.autoLyricTextColor,
    settings.autoLyricControlColor,
    lyrics.noLyric,
  ])

  // 实时推送：每次 miniState 变化（progress/播放状态/歌词/主题/配色等）即发送给主进程
  useEffect(() => {
    platform.miniWindow?.updateMiniPlayerState?.(miniState)
  }, [miniState])

  // 命令回调闭包只注册一次，用 ref 持有最新 repeatMode，避免读到初始值
  const repeatModeRef = useRef(player.repeatMode)
  repeatModeRef.current = player.repeatMode

  // 处理小窗发来的音量 / 进度 / 播放顺序命令
  useEffect(() => {
    return platform.miniWindow?.onMiniPlayerCommand?.((cmd: MiniCommand) => {
      if (cmd.type === 'update-lyric-appearance') {
        // v1.3.6 桌面歌词窗外观小面板：持久化到 AppSettings，
        // settings 变化经上方 miniState 推送回流歌词窗，形成即时生效闭环
        const patch: Partial<AppSettings> = {}
        if (typeof cmd.lyricTextColor === 'string') patch.lyricTextColor = cmd.lyricTextColor
        if (typeof cmd.lyricControlColor === 'string') patch.lyricControlColor = cmd.lyricControlColor
        if (Number.isFinite(cmd.lyricFontSize)) patch.lyricFontSize = cmd.lyricFontSize
        if (Number.isFinite(cmd.lyricFontWeight)) patch.lyricFontWeight = cmd.lyricFontWeight
        if (typeof cmd.lyricFontFamily === 'string') patch.lyricFontFamily = cmd.lyricFontFamily
        // v1.3.10 自动颜色：开关（面板/设置页）+ 自动算出的实际色（主进程回流），均与手动色分离存储
        if (typeof cmd.autoTextColor === 'boolean') patch.autoTextColor = cmd.autoTextColor
        if (typeof cmd.autoControlColor === 'boolean') patch.autoControlColor = cmd.autoControlColor
        if (typeof cmd.autoLyricTextColor === 'string') patch.autoLyricTextColor = cmd.autoLyricTextColor
        if (typeof cmd.autoLyricControlColor === 'string') patch.autoLyricControlColor = cmd.autoLyricControlColor
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

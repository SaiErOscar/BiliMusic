import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createContext, useContext } from 'react'
import type { Track, RepeatMode } from '@/types'
import { useAppSettings } from '@/hooks/useAppSettings'
import { toggleFavoriteTrack, loadFavoriteTracks, addRecentTrack, recordPlayStart, recordPlayProgress } from '@/utils/storage'
import { resolveAudioPlayableUrl, releaseAudioPlayableUrl } from '@/services/http'
import { ensureAudioGraph, disposeAudioGraph } from '@/services/audioGraph'
import { normalizePlaybackRate } from '@/utils/playbackRate'
import { applySleepAction, formatSleepRemaining } from '@/utils/sleepTimer'
import {
  clearSystemMediaActions,
  registerSystemMediaActions,
  type SystemMediaTarget,
} from '@/utils/systemMedia'
import { platform } from '@/platform'

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// v1.4.8-pre1 倍速纯函数抽至 utils/playbackRate（单测直测纯函数）；此处再导出保持既有引用面
export { PLAYBACK_RATE_STEPS, normalizePlaybackRate, nextPlaybackRate } from '@/utils/playbackRate'

function shouldIgnoreSpaceShortcut(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

function getArtworkType(url: string): string {
  // B站 CDN 封面 URL 常带查询参数或派生路径（如 /bfs/archive/xxx.jpg@672w_378h_1c_!web-common.avif），
  // 直接 split('.') 取末段会把参数/路径片段当成扩展名，导致 MediaSession 封面 MIME 误判。
  // 用 URL.pathname 解析真正的文件扩展名。
  let ext = ''
  try {
    ext = (new URL(url).pathname.split('.').pop() || '').toLowerCase()
  } catch {
    // 非法 URL 时回退到原始拆分
    ext = (url.split('.').pop() || '').toLowerCase()
  }
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return 'image/png'
  }
}

/** v1.4.8-pre5 全局媒体键真实注册态（来自主进程回报，不是持久化的意愿值） */
export interface MediaKeysStatus {
  ok: boolean
  /** requires-restart：本次启动的收键路径与开关相反，重启后才会生效 */
  reason?: 'not-ready' | 'occupied' | 'partial' | 'error' | 'requires-restart'
  /** 注册失败的 accelerator 名（partial/occupied 时非空） */
  failedKeys: string[]
}

const MEDIA_KEY_LABELS: Record<string, string> = {
  MediaPlayPause: '播放/暂停',
  MediaNextTrack: '下一首',
  MediaPreviousTrack: '上一首',
  MediaStop: '停止',
}

/** accelerator 名转中文标签，未知键位原样返回 */
export function formatMediaKeyName(key: string): string {
  return MEDIA_KEY_LABELS[key] ?? key
}

interface PlayerContextValue {
  currentTrack: Track | null
  isPlaying: boolean
  volume: number
  isMuted: boolean
  repeatMode: RepeatMode
  /** 派生：repeatMode === 'shuffle' */
  isShuffled: boolean
  queue: Track[]
  loadingAudio: boolean
  play: (track: Track) => void
  pause: () => void
  togglePlay: () => void
  next: () => void
  prev: () => void
  setVolume: (v: number) => void
  setIsMuted: (m: boolean) => void
  setRepeatMode: (m: RepeatMode) => void
  /** 已废弃：请使用 setRepeatMode('shuffle') 代替 */
  setIsShuffled: (s: boolean) => void
  addToQueue: (track: Track) => void
  addTracksToQueue: (tracks: Track[]) => void
  removeFromQueue: (trackId: string) => void
  removeMultipleFromQueue: (trackIds: string[]) => void
  moveInQueue: (from: number, to: number) => void
  playNow: (track: Track) => void
  playNext: (track: Track) => void
  clearQueue: () => void
  toggleLike: (trackId: string) => void
  playAll: (tracks: Track[]) => void
  playFromQueue: (index: number) => void
  /** v1.4.8-pre1 当前倍速（0.5~2.0） */
  playbackRate: number
  /** v1.4.8-pre1 设置倍速（同步 audio、持久化、切歌后重设） */
  setPlaybackRate: (r: number) => void
  /** v1.4.8-pre1 睡眠定时：倒计时到点时刻（毫秒时间戳），null=未设倒计时 */
  sleepEndsAt: number | null
  /** v1.4.8-pre1 睡眠定时：是否播完当前曲后停止 */
  sleepAfterCurrent: boolean
  startSleepCountdown: (minutes: number) => void
  startSleepAfterCurrent: () => void
  cancelSleepTimer: () => void
  /** v1.4.8-pre5 全局媒体键真实注册态；null = 未开启或当前平台不支持 */
  mediaKeysStatus: MediaKeysStatus | null
}

interface PlayerProgress {
  progress: number
  duration: number
  setProgress: (p: number) => void
}

const PlayerContext = createContext<PlayerContextValue | null>(null)
const PlayerProgressContext = createContext<PlayerProgress | null>(null)
const PLAYER_STATE_KEY = 'bilimusic_player_state'

interface PersistedPlayerState {
  currentTrack: Track | null
  queue: Track[]
  progress: number
  duration: number
  volume: number
  isMuted: boolean
  repeatMode: RepeatMode
  isShuffled: boolean
  wasPlaying: boolean
  currentIndex: number
}

function loadPersistedPlayerState(): PersistedPlayerState {
  const fallbackVolume = localStorage.getItem('bilimusic_volume')
  const fallback: PersistedPlayerState = {
    currentTrack: null,
    queue: [],
    progress: 0,
    duration: 0,
    volume: fallbackVolume ? parseInt(fallbackVolume) : 80,
    isMuted: false,
    repeatMode: 'none',
    isShuffled: false,
    wasPlaying: false,
    currentIndex: -1,
  }

  try {
    const raw = localStorage.getItem(PLAYER_STATE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedPlayerState>
    const queue = Array.isArray(parsed.queue) ? parsed.queue : []

    // 迁移：旧版本有独立的 isShuffled，新版合并到 repeatMode
    let repeatMode: RepeatMode = 'none'
    if (parsed.repeatMode === 'one' || parsed.repeatMode === 'all' || parsed.repeatMode === 'shuffle') {
      repeatMode = parsed.repeatMode
    } else if (parsed.isShuffled) {
      repeatMode = 'shuffle'  // 迁移旧的 shuffle 状态
    }

    return {
      ...fallback,
      ...parsed,
      currentTrack: parsed.currentTrack || null,
      queue,
      progress: Math.max(0, Number(parsed.progress || 0)),
      duration: Math.max(0, Number(parsed.duration || 0)),
      volume: Math.min(100, Math.max(0, Number(parsed.volume ?? fallback.volume))),
      currentIndex: Number.isFinite(parsed.currentIndex) ? Number(parsed.currentIndex) : -1,
      repeatMode,
      isShuffled: repeatMode === 'shuffle',
    }
  } catch {
    return fallback
  }
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const { settings, setAppSettings } = useAppSettings()
  const qualityPreference =
    settings.playQuality === '标准' ? 'standard' :
    settings.playQuality === '高品质' ? 'high' : 'lossless'
  const restoredRef = useRef(loadPersistedPlayerState())
  const [currentTrack, setCurrentTrack] = useState<Track | null>(() => restoredRef.current.currentTrack)
  const [isPlaying, setIsPlaying] = useState(() => Boolean(restoredRef.current.currentTrack && restoredRef.current.wasPlaying))
  const [progress, setProgress] = useState(() => restoredRef.current.progress)
  const [duration, setDuration] = useState(() => restoredRef.current.duration)
  const [volume, setVolumeState] = useState(() => restoredRef.current.volume)
  const [isMuted, setIsMuted] = useState(() => restoredRef.current.isMuted)
  const [repeatMode, setRepeatModeState] = useState<RepeatMode>(() => restoredRef.current.repeatMode)
  const [queue, setQueue] = useState<Track[]>(() => restoredRef.current.queue)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // v1.4.9-pre2 音频可视化：设置项来源（默认 false）。仅驱动「开关瞬间」的副作用。
  const audioVisualizerEnabled = settings.audioVisualizer
  // 上一轮是否已把 audio 元素接进 Web Audio 图。用 ref 而非 state：它只影响副作用，
  // 不参与渲染；也不需要进依赖数组（否则关→开时会因为闭包旧值而重连失败）。
  const visualizerAttachedRef = useRef(false)
  // v1.4.8-pre1 倍速：初值从持久化 settings 归一读取，非法值回退 1
  const [playbackRate, setPlaybackRateState] = useState<number>(() => normalizePlaybackRate(settings.playbackRate))
  const playbackRateRef = useRef(playbackRate)
  // v1.4.8-pre1 睡眠定时：倒计时结束时刻（绝对时间戳，跨切歌不重置）+ 播完当前曲停
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null)
  const [sleepAfterCurrent, setSleepAfterCurrent] = useState(false)
  // handleTrackEnd / 迁移入口内用 ref 读睡眠态，避免把 setState 引入依赖数组触发 TDZ
  const sleepEndsAtRef = useRef<number | null>(sleepEndsAt)
  const sleepAfterCurrentRef = useRef(sleepAfterCurrent)
  // v1.4.8-pre5 全局媒体键真实注册态：null = 未开启或平台不支持；ok=false 时 failedKeys 为被占用键位
  const [mediaKeysStatus, setMediaKeysStatus] = useState<MediaKeysStatus | null>(null)
  // effect 内要用最新 setAppSettings，但不把它放进依赖（每次渲染都是新函数，会导致重复 IPC）
  const setAppSettingsRef = useRef(setAppSettings)
  setAppSettingsRef.current = setAppSettings
  // 同一失败签名只提示一次，避免设置页反复进入时刷屏
  const mediaKeysNoticeRef = useRef('')

  // 派生：isShuffled 从 repeatMode 推导
  const isShuffled = repeatMode === 'shuffle'

  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 当前播放用的 Blob URL（移动端音频下载转 Blob 后，切歌/停止时需释放）
  const playableUrlRef = useRef<string | null>(null)
  const shuffledQueueRef = useRef<Track[]>([])
  const currentIndexRef = useRef(restoredRef.current.currentIndex)
  const shouldAutoplayRef = useRef(Boolean(restoredRef.current.currentTrack && restoredRef.current.wasPlaying))
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const progressRef = useRef(progress)
  const durationRef = useRef(duration)
  // v1.4.13-pre14 系统媒体控制：系统面板回调只在注册时拿一次闭包，
  // 必须经 ref 读最新状态，否则按暂停会按到几秒前的 isPlaying、切歌会切到旧队列。
  const currentTrackRef = useRef(currentTrack)
  // 播放控制函数也走 ref：它们随依赖（队列/乱序）变化，而 actionHandler 不重注册
  const systemMediaTargetRef = useRef<SystemMediaTarget | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 2000)
  }, [])

  // setRepeatMode 包装
  const setRepeatMode = useCallback((m: RepeatMode) => {
    setRepeatModeState(m)
  }, [])

  // 兼容旧接口：setIsShuffled
  const setIsShuffled = useCallback((s: boolean) => {
    setRepeatModeState(prev => {
      if (s) return 'shuffle'
      // 关闭 shuffle 时回到 none（如果当前是 shuffle）
      return prev === 'shuffle' ? 'none' : prev
    })
  }, [])

  // 初始化 audio 元素
  useEffect(() => {
    const audio = new Audio()
    audio.volume = volume / 100
    audioRef.current = audio

    const onTimeUpdate = () => setProgress(audio.currentTime)
    const onDuration = () => setDuration(audio.duration || 0)
    const onEnded = () => { /* handled in playTrack */ }
    const onError = () => {
      setLoadingAudio(false)
      setIsPlaying(false)
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onDuration)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onDuration)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.pause()
      if (playableUrlRef.current) {
        releaseAudioPlayableUrl(playableUrlRef.current)
        playableUrlRef.current = null
      }
      audio.src = ''
      // v1.4.9-pre2：播放器卸载时释放分析分支并关闭 AudioContext
      disposeAudioGraph()
      visualizerAttachedRef.current = false
    }
  }, [])

  // v1.4.9-pre2 音频可视化接线：
  // - 开：接管 audio 元素建立分析图（同元素只建一次，重复调用是复用的），
  //   随后触发一次重载，让当前曲目改从 Blob 播放（跨域直链拿不到频谱）。
  // - 关：只断开分析分支，不重载、不中断播放——Blob 与直链对 <audio> 等价，
  //   当前曲目继续放完；下一首起 resolveAudioPlayableUrl 会重新走直链。
  // 延迟一帧是为了把 audio 元素的创建 effect 与「读设置」解耦，
  // 保证开关切换和首屏初始化都走同一条路径。
  useEffect(() => {
    const id = setTimeout(() => {
      const audio = audioRef.current
      if (!audio) return
      if (audioVisualizerEnabled) {
        // resume 已在 ensureAudioGraph 内部触发（suspended 时），这里无需重复
        const ctx = ensureAudioGraph(audio)
        visualizerAttachedRef.current = ctx !== null
        return
      }
      if (visualizerAttachedRef.current) {
        disposeAudioGraph()
        visualizerAttachedRef.current = false
      }
    }, 0)
    return () => clearTimeout(id)
  }, [audioVisualizerEnabled])

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume / 100
      audioRef.current.muted = isMuted
    }
    localStorage.setItem('bilimusic_volume', String(volume))
  }, [volume, isMuted])

  useEffect(() => {
    progressRef.current = progress
  }, [progress])

  useEffect(() => {
    durationRef.current = duration
  }, [duration])

  const handleTrackEnd = useCallback(() => {
    // v1.4.8-pre1 睡眠定时「播完当前曲停」：优先于续播逻辑；命中即整态清空（含可能并存的倒计时）
    const sleepHit = applySleepAction(
      { sleepEndsAt: sleepEndsAtRef.current, sleepAfterCurrent: sleepAfterCurrentRef.current },
      { type: 'track-end', now: Date.now() },
    )
    if (sleepHit.shouldStop) {
      audioRef.current?.pause()
      setIsPlaying(false)
      setSleepEndsAt(sleepHit.next.sleepEndsAt)
      setSleepAfterCurrent(sleepHit.next.sleepAfterCurrent)
      showToast('睡眠定时：播放已停止')
      return
    }
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (!settings.autoPlay && repeatMode !== 'one') {
      setIsPlaying(false)
      return
    }
    if (displayQueue.length === 0) {
      setIsPlaying(false)
      return
    }

    switch (repeatMode) {
      case 'one':
        if (audioRef.current) {
          audioRef.current.currentTime = 0
          shouldAutoplayRef.current = true
          audioRef.current.play().catch(() => {})
        }
        return
      case 'all':
      case 'shuffle': {
        // shuffle 和 all 都循环播放
        const nextIdx = currentIndexRef.current + 1 >= displayQueue.length
          ? 0 : currentIndexRef.current + 1
        currentIndexRef.current = nextIdx
        shouldAutoplayRef.current = true
        setCurrentTrack(displayQueue[nextIdx])
        setProgress(0)
        setIsPlaying(true)
        return
      }
      default: {
        const nextIdx = currentIndexRef.current + 1
        if (nextIdx >= displayQueue.length) {
          setIsPlaying(false)
          return
        }
        currentIndexRef.current = nextIdx
        shouldAutoplayRef.current = true
        setCurrentTrack(displayQueue[nextIdx])
        setProgress(0)
        setIsPlaying(true)
      }
    }
  }, [isShuffled, queue, repeatMode, settings.autoPlay])

  // Bind handleTrackEnd to audio ended event
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.addEventListener('ended', handleTrackEnd)
    return () => audio.removeEventListener('ended', handleTrackEnd)
  }, [handleTrackEnd])

  // 当 currentTrack 变化时记录最近播放（去重）
  useEffect(() => {
    if (currentTrack) addRecentTrack(currentTrack)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id])

  // v1.4.12-pre1 播放行为埋点：起播记一次，并在切歌/卸载时结算上一首的收听时长
  const playStatRef = useRef<{ id: string; lastPos: number; maxRatio: number } | null>(null)
  useEffect(() => {
    if (!currentTrack) return
    recordPlayStart(currentTrack)
    playStatRef.current = { id: currentTrack.id, lastPos: 0, maxRatio: 0 }
    return () => {
      const s = playStatRef.current
      if (!s) return
      // 卸载/切歌时按已推进的秒数结算；听完判定用最大进度比
      recordPlayProgress(s.id, s.lastPos, s.maxRatio >= 0.9)
      playStatRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id])

  // timeupdate 里累计实际推进量（只记正向增量，拖动进度条不计入）
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => {
      const s = playStatRef.current
      if (!s) return
      const pos = audio.currentTime
      const delta = pos - s.lastPos
      // 只接受 0~2 秒的正向增量：跳转/回退/卡顿都不会污染统计
      if (delta > 0 && delta <= 2) s.lastPos = pos
      const dur = audio.duration
      if (dur && Number.isFinite(dur) && dur > 0) {
        s.maxRatio = Math.max(s.maxRatio, Math.min(1, pos / dur))
      }
    }
    audio.addEventListener('timeupdate', onTime)
    return () => audio.removeEventListener('timeupdate', onTime)
  }, [currentTrack?.id])

  // 当 currentTrack 变化时加载并播放音频
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return

    let cancelled = false
    const audio = audioRef.current

    setLoadingAudio(true)

    const loadAndPlay = async () => {
      try {
        const { extractAudioFromVideo, getCachedAudioSource, cacheAudioSource } = await import('@/services/bilibiliApi')

        let source = getCachedAudioSource(currentTrack.bvid || currentTrack.id)
        if (!source) {
          source = await extractAudioFromVideo(
            currentTrack.bvid || currentTrack.id,
            { aid: currentTrack.aid, cid: currentTrack.cid },
            qualityPreference,
          )
          cacheAudioSource(currentTrack.bvid || currentTrack.id, source)
        }

        if (cancelled) return

        // 释放上一个 Blob URL（移动端音频下载转 Blob 后需释放）
        if (playableUrlRef.current) {
          releaseAudioPlayableUrl(playableUrlRef.current)
          playableUrlRef.current = null
        }

        // 移动端始终下载音频流转 Blob（绕过 Referer 防盗链），桌面端默认原样返回；
        // v1.4.9-pre2：桌面端开启可视化时也要 Blob（跨域直链拿不到频谱数据）
        const playableUrl = await resolveAudioPlayableUrl(source.audioUrl, settings.audioVisualizer)
        if (cancelled) {
          // 本次加载已被切歌/卸载取消：刚建出的 Blob URL 必须立刻释放，否则泄漏
          releaseAudioPlayableUrl(playableUrl)
          return
        }
        // 同样要处理「上一个 Blob 在 await 期间又被写入」的竞态：以 ref 为准释放
        if (playableUrlRef.current && playableUrlRef.current !== playableUrl) {
          releaseAudioPlayableUrl(playableUrlRef.current)
        }
        playableUrlRef.current = playableUrl
        audio.src = playableUrl
        audio.load()
        // 换 src 会重置 playbackRate，必须在 play 前重设当前倍速
        audio.playbackRate = playbackRateRef.current

        if (shouldAutoplayRef.current) {
          await audio.play().catch((e) => {
            console.warn('[player] autoplay failed:', e)
          })
          if (!cancelled) setIsPlaying(true)
        }
      } catch (e) {
        if (!cancelled) {
          setLoadingAudio(false)
          setIsPlaying(false)

          // 403 重试：清除缓存后重新加载
          if (e instanceof Error && (e.message.includes('403') || e.message.includes('Forbidden'))) {
            const { clearAudioUrlCache } = await import('@/services/bilibiliApi')
            clearAudioUrlCache()
          }
        }
      } finally {
        if (!cancelled) setLoadingAudio(false)
      }
    }

    loadAndPlay()

    return () => {
      cancelled = true
    }
  }, [currentTrack?.bvid, currentTrack?.id, qualityPreference, settings.audioVisualizer])

  // v1.4.8-pre1 倍速：state 变同步 audio + 持久化 settings，playbackRateRef 供 loadAndPlay 重设时使用
  useEffect(() => {
    playbackRateRef.current = playbackRate
    if (audioRef.current) audioRef.current.playbackRate = playbackRate
    if (settings.playbackRate !== playbackRate) {
      setAppSettings({ playbackRate })
    }
  }, [playbackRate, settings.playbackRate, setAppSettings])

  const setPlaybackRate = useCallback((r: number) => {
    setPlaybackRateState(normalizePlaybackRate(r))
  }, [])

  // v1.4.8-pre1 睡眠定时：state 变化回同步 ref（handleTrackEnd 与迁移入口读 ref 避免 TDZ）
  useEffect(() => {
    sleepEndsAtRef.current = sleepEndsAt
    sleepAfterCurrentRef.current = sleepAfterCurrent
  }, [sleepEndsAt, sleepAfterCurrent])

  // v1.4.8-pre1 睡眠定时：倒计时到点则暂停 + 整态清空（基于绝对时间戳 sleepEndsAt，跨切歌不重置）
  useEffect(() => {
    if (sleepEndsAt === null) return
    const fire = () => {
      const hit = applySleepAction(
        { sleepEndsAt, sleepAfterCurrent: sleepAfterCurrentRef.current },
        { type: 'tick', now: Date.now() },
      )
      if (!hit.shouldStop) return
      audioRef.current?.pause()
      setIsPlaying(false)
      setSleepEndsAt(hit.next.sleepEndsAt)
      setSleepAfterCurrent(hit.next.sleepAfterCurrent)
      showToast('睡眠定时：播放已停止')
    }
    const ms = sleepEndsAt - Date.now()
    if (ms <= 0) {
      fire()
      return
    }
    const timer = setTimeout(fire, ms)
    return () => clearTimeout(timer)
  }, [sleepEndsAt, showToast])

  const startSleepCountdown = useCallback((minutes: number) => {
    const m = Math.floor(minutes)
    if (!Number.isFinite(m) || m <= 0) return
    const t = applySleepAction(
      { sleepEndsAt: sleepEndsAtRef.current, sleepAfterCurrent: sleepAfterCurrentRef.current },
      { type: 'start-countdown', minutes: m, now: Date.now() },
    )
    setSleepEndsAt(t.next.sleepEndsAt)
    setSleepAfterCurrent(t.next.sleepAfterCurrent)
    showToast(`睡眠定时：${m} 分钟后停止`)
  }, [showToast])

  const startSleepAfterCurrent = useCallback(() => {
    const t = applySleepAction(
      { sleepEndsAt: sleepEndsAtRef.current, sleepAfterCurrent: sleepAfterCurrentRef.current },
      { type: 'start-after-current' },
    )
    setSleepAfterCurrent(t.next.sleepAfterCurrent)
    showToast('将播完当前曲目后停止')
  }, [showToast])

  const cancelSleepTimer = useCallback(() => {
    const t = applySleepAction(
      { sleepEndsAt: sleepEndsAtRef.current, sleepAfterCurrent: sleepAfterCurrentRef.current },
      { type: 'cancel' },
    )
    setSleepEndsAt(t.next.sleepEndsAt)
    setSleepAfterCurrent(t.next.sleepAfterCurrent)
  }, [])

  const play = useCallback((track: Track) => {
    shouldAutoplayRef.current = true
    setCurrentTrack(track)
    setProgress(0)
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    const idx = displayQueue.findIndex(t => t.id === track.id)
    currentIndexRef.current = idx >= 0 ? idx : 0
  }, [isShuffled, queue])

  const pause = useCallback(() => {
    shouldAutoplayRef.current = false
    audioRef.current?.pause()
    setIsPlaying(false)
  }, [])

  const togglePlay = useCallback(() => {
    if (!currentTrack) return
    if (isPlaying) {
      shouldAutoplayRef.current = false
      audioRef.current?.pause()
      setIsPlaying(false)
    } else {
      shouldAutoplayRef.current = true
      audioRef.current?.play().then(() => setIsPlaying(true)).catch(() => {})
    }
  }, [currentTrack, isPlaying])

  const next = useCallback(() => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (displayQueue.length === 0) return
    const nextIdx = currentIndexRef.current + 1 >= displayQueue.length
      ? 0 : currentIndexRef.current + 1
    currentIndexRef.current = nextIdx
    shouldAutoplayRef.current = true
    setCurrentTrack(displayQueue[nextIdx])
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled, queue])

  const prev = useCallback(() => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (displayQueue.length === 0) return
    const prevIdx = currentIndexRef.current - 1 < 0
      ? displayQueue.length - 1 : currentIndexRef.current - 1
    currentIndexRef.current = prevIdx
    shouldAutoplayRef.current = true
    setCurrentTrack(displayQueue[prevIdx])
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled, queue])

  const handleSetProgress = useCallback((p: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = p
    }
    setProgress(p)
  }, [])

  const handleSetVolume = useCallback((v: number) => {
    setVolumeState(v)
  }, [])

  const addToQueue = useCallback((track: Track) => {
    const exists = queue.some(t => t.id === track.id)
    setQueue(prev => {
      if (prev.some(t => t.id === track.id)) return prev
      const newQueue = [...prev, track]
      if (!currentTrack) {
        shouldAutoplayRef.current = true
        setCurrentTrack(track)
        currentIndexRef.current = 0
      }
      return newQueue
    })
    showToast(exists ? '已在播放列表中' : '已加入播放列表')
  }, [queue, currentTrack, showToast])

  const addTracksToQueue = useCallback((tracks: Track[]) => {
    setQueue(prev => {
      const existingIds = new Set(prev.map(t => t.id))
      const newTracks = tracks.filter(t => !existingIds.has(t.id))
      const newQueue = [...prev, ...newTracks]
      if (!currentTrack && newQueue.length > 0) {
        shouldAutoplayRef.current = true
        setCurrentTrack(newQueue[0])
        currentIndexRef.current = 0
      }
      return newQueue
    })
  }, [currentTrack])

  const resyncIndex = useCallback((nextQueue: Track[]) => {
    const curId = currentTrack?.id
    if (curId) currentIndexRef.current = nextQueue.findIndex(t => t.id === curId)
  }, [currentTrack])

  const removeFromQueue = useCallback((trackId: string) => {
    setQueue(prev => {
      const next = prev.filter(t => t.id !== trackId)
      resyncIndex(next)
      return next
    })
  }, [resyncIndex])

  const removeMultipleFromQueue = useCallback((trackIds: string[]) => {
    const idSet = new Set(trackIds)
    setQueue(prev => {
      const next = prev.filter(t => !idSet.has(t.id))
      resyncIndex(next)
      return next
    })
  }, [resyncIndex])

  const moveInQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(prev => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 || fromIndex >= prev.length ||
        toIndex < 0 || toIndex >= prev.length
      ) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      resyncIndex(next)
      return next
    })
  }, [resyncIndex])

  const playNow = useCallback((track: Track) => {
    shouldAutoplayRef.current = true
    setQueue(prev => [track, ...prev.filter(t => t.id !== track.id)])
    setCurrentTrack(track)
    setProgress(0)
    currentIndexRef.current = 0
    setIsPlaying(true)
  }, [])

  const playNext = useCallback((track: Track) => {
    if (!currentTrack) { playNow(track); return }
    setQueue(prev => {
      const without = prev.filter(t => t.id !== track.id)
      const curIdx = without.findIndex(t => t.id === currentTrack.id)
      const insertAt = curIdx >= 0 ? curIdx + 1 : without.length
      const next = [...without.slice(0, insertAt), track, ...without.slice(insertAt)]
      resyncIndex(next)
      return next
    })
    showToast('已设为下一首播放')
  }, [currentTrack, resyncIndex, showToast, playNow])

  const clearQueue = useCallback(() => {
    shouldAutoplayRef.current = false
    setQueue([])
    setCurrentTrack(null)
    setIsPlaying(false)
    if (audioRef.current) {
      audioRef.current.pause()
      if (playableUrlRef.current) {
        releaseAudioPlayableUrl(playableUrlRef.current)
        playableUrlRef.current = null
      }
      audioRef.current.src = ''
    }
  }, [])

  const toggleLike = useCallback((trackId: string) => {
    const track = queue.find(t => t.id === trackId) || currentTrack
    if (track) {
      toggleFavoriteTrack(track)
    }
    setCurrentTrack(prev => prev && prev.id === trackId ? { ...prev, isLiked: !prev.isLiked } : prev)
    setQueue(prev => prev.map(t => t.id === trackId ? { ...t, isLiked: !t.isLiked } : t))
  }, [queue, currentTrack])

  const playAll = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return
    const favs = loadFavoriteTracks()
    const favIds = new Set(favs.map(t => t.id))
    const synced = tracks.map(t => ({ ...t, isLiked: favIds.has(t.id) }))
    setQueue(synced)
    shouldAutoplayRef.current = true
    setCurrentTrack(synced[0])
    currentIndexRef.current = 0
    setProgress(0)
    setIsPlaying(true)
  }, [])

  const playFromQueue = useCallback((index: number) => {
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    if (index < 0 || index >= displayQueue.length) return
    currentIndexRef.current = index
    shouldAutoplayRef.current = true
    setCurrentTrack(displayQueue[index])
    setProgress(0)
    setIsPlaying(true)
  }, [isShuffled, queue])

  // 更新 shuffledQueueRef
  useEffect(() => {
    shuffledQueueRef.current = isShuffled ? shuffleArray(queue) : queue
  }, [queue, isShuffled])

  useEffect(() => {
    if (!currentTrack) {
      currentIndexRef.current = -1
      return
    }
    const displayQueue = isShuffled ? shuffledQueueRef.current : queue
    const index = displayQueue.findIndex(track => track.id === currentTrack.id)
    currentIndexRef.current = index >= 0 ? index : 0
  }, [currentTrack?.id, isShuffled, queue])

  // 主状态持久化
  useEffect(() => {
    try {
      const state: PersistedPlayerState = {
        currentTrack,
        queue,
        progress: progressRef.current,
        duration,
        volume,
        isMuted,
        repeatMode,
        isShuffled,
        wasPlaying: isPlaying,
        currentIndex: currentIndexRef.current,
      }
      localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(state))
    } catch {
      // ignore persistence failures
    }
  }, [currentTrack, duration, isMuted, isPlaying, isShuffled, queue, repeatMode, volume])

  // 进度持久化
  useEffect(() => {
    if (!currentTrack) return
    const timer = setInterval(() => {
      try {
        const raw = localStorage.getItem(PLAYER_STATE_KEY)
        const parsed = raw ? JSON.parse(raw) : {}
        parsed.progress = progressRef.current
        parsed.duration = durationRef.current
        parsed.wasPlaying = isPlaying
        localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify(parsed))
      } catch {
        // ignore
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [currentTrack, isPlaying])

  useEffect(() => {
    const pushTrayState = () => platform.tray?.updateTrayPlayerState?.({
      hasTrack: Boolean(currentTrack),
      title: currentTrack?.title || '未在播放',
      artist: currentTrack?.artist || '搜索并播放音乐',
      coverUrl: currentTrack?.coverUrl || '',
      isPlaying,
      queueLength: queue.length,
      theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    })
    pushTrayState()
    const observer = new MutationObserver(pushTrayState)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [currentTrack?.artist, currentTrack?.coverUrl, currentTrack?.id, currentTrack?.title, isPlaying, queue.length])

  useEffect(() => {
    return platform.tray?.onTrayPlayerCommand?.((command) => {
      if (command === 'toggle-play') togglePlay()
      if (command === 'next') next()
      if (command === 'prev') prev()
    })
  }, [next, prev, togglePlay])

  // v1.4.8-pre1 桌面全局媒体键：主进程投递命令后映射到播放控制；非桌面 platform.mediaKeys 缺失自然跳过
  useEffect(() => {
    return platform.mediaKeys?.onCommand?.((command) => {
      if (command === 'toggle-play') togglePlay()
      else if (command === 'next') next()
      else if (command === 'prev') prev()
      else if (command === 'stop') pause()
    })
  }, [next, prev, togglePlay, pause])

  // v1.4.8-pre5 全局媒体键开关：settings 变化同步到主进程，并用主进程回报的真实结果
  // 更新状态。原实现只 console.warn，界面停在「已开启」而实际一个键都没注册成功。
  useEffect(() => {
    const setEnabled = platform.mediaKeys?.setEnabled
    if (!setEnabled) return
    const desired = Boolean(settings.globalMediaKeys)
    let cancelled = false
    setEnabled(desired).then((res) => {
      if (cancelled) return
      const failedKeys = res.failedKeys ?? []
      setMediaKeysStatus(desired ? { ok: res.ok, reason: res.reason, failedKeys } : null)
      if (!desired) {
        // 关闭时清掉提示签名，用户下次手动开启若仍失败会重新提示
        mediaKeysNoticeRef.current = ''
        return
      }
      if (res.ok) {
        mediaKeysNoticeRef.current = ''
        return
      }
      // v1.4.13-pre14：收键路径在启动时就固定了（HardwareMediaKeyHandling 与
      // SMTC 互斥，appendSwitch 只在 app ready 前有效）。本次启动走的是另一条
      // 路径，注册不会发生——把开关回退并说清要重启，而不是让它停在「已开启」。
      if (res.reason === 'requires-restart') {
        // 这里**不能**把开关回退。主进程已把意图写进镜像文件，下次启动才会切到
        // hardware-keys 路径；若此刻回退成 false，下次启动又会走 media-session，
        // 于是「开了→要重启→回退→再开」永远循环，用户再也开不起来。
        // 保持用户的选择，只如实提示需要重启；状态里 ok=false 已让界面显示未生效。
        const sig = 'requires-restart'
        if (mediaKeysNoticeRef.current === sig) return
        mediaKeysNoticeRef.current = sig
        showToast('已切换媒体键来源，重启应用后生效')
        return
      }
      const sig = `${res.reason ?? 'unknown'}:${failedKeys.join(',')}`
      if (mediaKeysNoticeRef.current === sig) return
      mediaKeysNoticeRef.current = sig
      if (res.reason === 'partial') {
        showToast(`部分媒体键被占用：${failedKeys.map(formatMediaKeyName).join('、')}`)
        return
      }
      showToast('全局媒体键未生效，键位可能被其他程序占用')
      // 全失败时把开关回退，避免界面停在「已开启但无任何键生效」的假象
      setAppSettingsRef.current({ globalMediaKeys: false })
    }).catch(() => { /* 主进程不可用时静默降级 */ })
    return () => { cancelled = true }
  }, [settings.globalMediaKeys, showToast])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.code !== 'Space' || shouldIgnoreSpaceShortcut(event.target)) return
      event.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [togglePlay])

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return

    if (!currentTrack) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
      return
    }

    const artwork = currentTrack.coverUrl
      ? [{ src: currentTrack.coverUrl, sizes: '512x512', type: getArtworkType(currentTrack.coverUrl) }]
      : undefined

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack?.title || '未命名歌曲',
      artist: currentTrack?.artist || 'BiliMusic',
      album: 'BiliMusic',
      artwork,
    })
  }, [currentTrack?.artist, currentTrack?.coverUrl, currentTrack?.id, currentTrack?.title])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = currentTrack ? (isPlaying ? 'playing' : 'paused') : 'none'
  }, [currentTrack, isPlaying])

  // v1.4.13-pre14 系统媒体控制：把最新状态与最新控制函数同步进 ref。
  // actionHandler 只在挂载时注册一次（避免反复重注册导致系统面板短暂丢失控件），
  // 因此回调里读到的一切都必须来自 ref，而不是注册时的闭包。
  useEffect(() => {
    currentTrackRef.current = currentTrack
  }, [currentTrack])

  // 无依赖：每次渲染后刷新，保证 ref 里永远是本次渲染的 next/prev/pause 版本
  useEffect(() => {
    systemMediaTargetRef.current = {
      play: () => {
        if (!currentTrackRef.current) return
        shouldAutoplayRef.current = true
        audioRef.current?.play().then(() => setIsPlaying(true)).catch(() => {})
      },
      pause: () => {
        shouldAutoplayRef.current = false
        audioRef.current?.pause()
        setIsPlaying(false)
      },
      next,
      prev,
      seek: (seconds, fast) => {
        const audio = audioRef.current
        if (!audio) return
        if (fast && typeof audio.fastSeek === 'function') {
          // fastSeek 只保证「近似到位」，正是系统拖拽进度条期望的语义
          audio.fastSeek(seconds)
        } else {
          audio.currentTime = seconds
        }
        setProgress(seconds)
      },
    }
  })

  /**
   * v1.4.13-pre14 注册系统媒体面板动作（Windows SMTC / macOS Now Playing）。
   *
   * 与全局媒体键的关系：globalShortcut 注册的 MediaPlayPause 等键位在
   * HardwareMediaKeyHandling 关闭后才由 OS 直接投递给本应用；而 MediaSession 的
   * actionHandler 走的是 Chromium 的媒体会话通道。两者都能收到硬件媒体键，
   * 但只有后者能让系统面板（音量浮层）出现 BiliMusic 卡片与可用控件。
   * 因此这里无条件注册，与 globalMediaKeys 开关无关。
   */
  const hasTrack = Boolean(currentTrack)

  useEffect(() => {
    const mediaSession = 'mediaSession' in navigator ? navigator.mediaSession : undefined
    if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return

    // 没有在播曲目时不注册：系统面板上不该出现一个点了没反应的播放按钮。
    // 清空队列 / 退出时由 cleanup 解绑，避免残留指向已卸载曲目的控件。
    if (!hasTrack) {
      clearSystemMediaActions(mediaSession)
      return
    }

    const registered = registerSystemMediaActions(
      mediaSession,
      () => systemMediaTargetRef.current,
      () => ({ currentTime: progressRef.current, duration: durationRef.current }),
    )

    return () => {
      clearSystemMediaActions(mediaSession, registered)
    }
  }, [hasTrack])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        // v1.4.8-pre1 修复：原写死 1，倍速播放时系统媒体面板进度条会算错
        playbackRate: playbackRate,
        position: Math.min(Math.max(progress, 0), duration),
      })
    } catch {
      // Invalid transient durations/progress values should not affect playback.
    }
  }, [currentTrack, duration, progress, playbackRate])

  const value = useMemo<PlayerContextValue>(() => ({
    currentTrack,
    isPlaying,
    volume,
    isMuted,
    repeatMode,
    isShuffled,
    queue,
    loadingAudio,
    play,
    pause,
    togglePlay,
    next,
    prev,
    setVolume: handleSetVolume,
    setIsMuted,
    setRepeatMode,
    setIsShuffled,
    addToQueue,
    addTracksToQueue,
    removeFromQueue,
    removeMultipleFromQueue,
    moveInQueue,
    playNow,
    playNext,
    clearQueue,
    toggleLike,
    playAll,
    playFromQueue,
    playbackRate,
    setPlaybackRate,
    sleepEndsAt,
    sleepAfterCurrent,
    startSleepCountdown,
    startSleepAfterCurrent,
    cancelSleepTimer,
    mediaKeysStatus,
  }), [
    currentTrack, isPlaying, volume, isMuted, repeatMode, isShuffled, queue, loadingAudio,
    play, pause, togglePlay, next, prev, handleSetVolume, setIsMuted, setRepeatMode, setIsShuffled,
    addToQueue, addTracksToQueue, removeFromQueue, removeMultipleFromQueue, moveInQueue,
    playNow, playNext, clearQueue, toggleLike, playAll, playFromQueue,
    playbackRate, setPlaybackRate, sleepEndsAt, sleepAfterCurrent,
    startSleepCountdown, startSleepAfterCurrent, cancelSleepTimer, mediaKeysStatus,
  ])

  const progressValue = useMemo<PlayerProgress>(() => ({
    progress,
    duration,
    setProgress: handleSetProgress,
  }), [progress, duration, handleSetProgress])

  return (
    <PlayerContext.Provider value={value}>
      <PlayerProgressContext.Provider value={progressValue}>
      {children}
      {toast && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 96,
            transform: 'translateX(-50%)',
            zIndex: 80,
            padding: '8px 18px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--glass-bg-heavy)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid var(--glass-border)',
            boxShadow: 'var(--shadow-lg)',
            color: 'var(--color-foreground)',
            fontSize: 13,
            fontFamily: 'var(--font-body)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          } as React.CSSProperties}
        >
          {toast}
        </div>
      )}
      </PlayerProgressContext.Provider>
    </PlayerContext.Provider>
  )
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider')
  return ctx
}

export function usePlayerProgress(): PlayerProgress {
  const ctx = useContext(PlayerProgressContext)
  if (!ctx) throw new Error('usePlayerProgress must be used within PlayerProvider')
  return ctx
}

/**
 * v1.4.8-pre1 睡眠倒计时剩余文案（m:ss）。
 * 1 秒定时器驱动，暂停/失焦时也照常走表（原先依赖播放进度渲染刷新，暂停时会冻结）；
 * 未设倒计时返回 null。PlayerBar 弹层与设置页睡眠定时行共用。
 */
export function useSleepRemainingText(): string | null {
  const { sleepEndsAt } = usePlayer()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (sleepEndsAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sleepEndsAt])
  if (sleepEndsAt === null) return null
  return formatSleepRemaining(sleepEndsAt, now)
}

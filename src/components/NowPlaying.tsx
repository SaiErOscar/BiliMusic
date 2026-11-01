import { useCallback, useEffect, useState, type ReactNode, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  ChevronDown, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat,
  Heart, Volume2, VolumeX, Search, Music, Loader2, Maximize2, Minimize2, X, MessageCircle, ExternalLink, ThumbsUp, RefreshCw, ChevronUp, RotateCcw, Star, Monitor, Sparkles,
} from 'lucide-react'
import DownloadButton from '@/components/DownloadButton'
import BiliFavoriteDialog from '@/components/BiliFavoriteDialog'
import { usePlayer, usePlayerProgress } from '@/contexts/PlayerContext'
import { useNowPlaying } from '@/contexts/NowPlayingContext'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useLyrics } from '@/hooks/useLyrics'
import { useDesktopLyricVisible } from '@/hooks/useDesktopLyric'
import PlayerSlider from '@/components/PlayerSlider'
import LyricsView from '@/components/LyricsView'
import AudioVisualizer from '@/components/AudioVisualizer'
import { enhanceLyrics } from '@/services/aiLyrics'
import { aiUnsupportedReason, getAiConfig, isAiSupported, saveAiConfig } from '@/services/ai'
import {
  createTrackInsightCache,
  insightCacheKey,
  isAiConfigured,
  loadTrackInsight,
  type TrackInsight,
} from '@/services/aiTrackInsight'
import { detectLyricLanguage } from '@/services/desktopLyricLines'
import { cleanTrackTitle } from '@/services/titleClean'
import {
  searchMultiSourceRound,
  initialMultiSourceState,
  NO_LYRIC_CANDIDATE,
  LYRIC_SOURCE_LABELS,
  type LyricCandidate,
  type MultiSourceState,
} from '@/services/lyrics'
import { getVideoComments, type VideoComment } from '@/services/api'
import { platform } from '@/platform'
import { coverAspectRatio, shouldFollowCoverAspect } from '@/utils/coverFit'

const sliderTheme = {
  ['--track-bg']: 'rgba(255,255,255,0.18)',
  ['--track-fill']: '#ffffff',
  ['--track-thumb']: '#ffffff',
} as React.CSSProperties

const spring = { type: 'spring', stiffness: 360, damping: 32, mass: 0.75 } as const
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
const commentPageSize = 20

export default function NowPlaying() {
  const navigate = useNavigate()
  const player = usePlayer()
  const { progress, duration: liveDuration, setProgress } = usePlayerProgress()
  const { expanded, close } = useNowPlaying()
  const { settings } = useAppSettings()
  const track = player.currentTrack
  const lyrics = useLyrics(track, expanded && settings.showLyrics)
  const duration = liveDuration || track?.duration || 0
  const [fullscreen, setFullscreen] = useState(false)
  // v1.4.11-pre2 封面取景：记录封面固有比例，contain 模式下用它驱动容器高度
  const [coverAspect, setCoverAspect] = useState(1)

  const followCoverAspect = shouldFollowCoverAspect(settings.coverFit) && coverAspect > 0
  const [controlsVisible, setControlsVisible] = useState(true)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [biliFavOpen, setBiliFavOpen] = useState(false)
  const [commentsStatus, setCommentsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [comments, setComments] = useState<VideoComment[]>([])
  const [commentsPage, setCommentsPage] = useState(1)
  const [commentsTotal, setCommentsTotal] = useState(0)
  const [commentsError, setCommentsError] = useState('')
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false)

  /*
   * v1.4.14-pre4 播放页 AI 曲目解析。
   *
   * 缓存只活一个会话（Map 放 ref，不触发重渲染）：同一首歌二次点击直接命中，
   * 不再消耗额度。请求期间不碰 player，播放继续。
   */
  const insightCacheRef = useRef(createTrackInsightCache())
  /** 请求序号：切歌或取消后，晚到的结果不回写，避免串到别的曲目上 */
  const insightSeqRef = useRef(0)
  const [insightOpen, setInsightOpen] = useState(false)
  const [insightBusy, setInsightBusy] = useState(false)
  const [insight, setInsight] = useState<TrackInsight | null>(null)
  const [insightError, setInsightError] = useState('')
  const [insightCached, setInsightCached] = useState(false)
  /** 未配置 / 环境不支持：与「请求失败」分开，给的是去设置页的指引而不是报错 */
  const [insightNeedConfig, setInsightNeedConfig] = useState(false)
  /** 用户主动取消：既不等于失败也不等于加载中，单独一个状态免得卡片空白 */
  const [insightCancelled, setInsightCancelled] = useState(false)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, close])

  useEffect(() => {
    const shell = platform.shell
    if (!shell) return
    shell.isFullscreen?.().then(setFullscreen).catch(() => {})
    return shell.onFullscreenChange?.(setFullscreen)
  }, [])

  useEffect(() => {
    const shell = platform.shell
    if (platform.runtime?.platform !== 'openharmony') return
    shell?.setWindowButtonVisibility?.(!expanded)
    return () => shell?.setWindowButtonVisibility?.(true)
  }, [expanded])

  const toggleFullscreen = () => {
    const shell = platform.shell
    shell?.toggleFullscreen?.()
    shell?.isFullscreen?.()
      .then(setFullscreen)
      .catch(() => {})
    window.setTimeout(() => {
      shell?.isFullscreen?.()
        .then(setFullscreen)
        .catch(() => {})
    }, 180)
  }

  const closeToTray = () => {
    platform.shell?.close()
  }

  const openArtistSpace = () => {
    if (!track?.artist.trim()) return
    close()
    navigate('/search', { state: { openArtist: track.artist } })
  }

  const openSourceVideo = () => {
    if (!track?.bvid) return
    platform.shell?.openExternal?.(`https://www.bilibili.com/video/${track.bvid}`)
  }

  const loadComments = useCallback(async (page = 1) => {
    if (!track?.bvid && !track?.aid) return
    if (page === 1) {
      setCommentsStatus('loading')
      setCommentsError('')
    } else {
      setCommentsLoadingMore(true)
    }

    try {
      const data = await getVideoComments({ bvid: track.bvid, aid: track.aid }, page, commentPageSize)
      setComments((prev) => page === 1 ? data.items : [...prev, ...data.items])
      setCommentsTotal(data.total)
      setCommentsPage(page)
      setCommentsStatus('ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : '评论加载失败'
      setCommentsError(message)
      setCommentsStatus('error')
    } finally {
      setCommentsLoadingMore(false)
    }
  }, [track?.aid, track?.bvid])

  const toggleComments = () => {
    const nextOpen = !commentsOpen
    setCommentsOpen(nextOpen)
    if (nextOpen && commentsStatus === 'idle') {
      void loadComments(1)
    }
  }

  /**
   * v1.4.14-pre4：生成（或命中缓存）当前曲目的 AI 解析。
   *
   * 三个原则：
   * 1. **未配置不发请求**——直接给「去设置页」的指引，比让用户等一次 401 更省事；
   * 2. **全程不碰 player**——这是「实时、可感知」而不是「打断播放」，请求期间音频照常；
   * 3. **可取消**：序号自增后，在途结果回来时发现序号已变就丢弃，不会串到别的曲目上。
   */
  const runInsight = async (force = false) => {
    if (!track) return
    setInsightError('')
    setInsightNeedConfig(false)
    setInsightCancelled(false)

    if (!isAiSupported()) {
      setInsightNeedConfig(true)
      setInsightError(aiUnsupportedReason())
      return
    }

    const seq = ++insightSeqRef.current
    setInsightBusy(true)
    try {
      const config = await getAiConfig()
      if (seq !== insightSeqRef.current) return
      if (!isAiConfigured(config)) {
        setInsightNeedConfig(true)
        setInsight(null)
        return
      }
      /*
       * 歌词片段：只在已经加载出歌词时顺带送前若干行，用来判断语言与主题。
       * 没有歌词不算失败——退化成「只根据标题与歌手」即可（服务层会据此降置信度）。
       */
      const lyricSnippet = lyrics.rawResult?.lines?.map((l) => l.text) || []
      /*
       * v1.4.14-pre4 标题清洗接线：B 站标题常带【4K修复】【翻唱】、UP 主前缀、播放量等噪声，
       * 直接交给模型会带偏对曲目的理解。清洗模式由设置里的 titleCleanMode 决定
       * （off 用原标题 / rule 程序清洗 / ai 让模型洗一次）。
       *
       * 在 UI 侧清洗而不是服务层：cleanTrackTitle 需要 AppSettings（含 titleCleanMode），
       * 而服务层的 settings 是 AiSettings，两者不是同一份配置。在这里洗完传干净标题进去，
       * 服务层签名不用改。
       *
       * 清洗失败不阻断：cleanTrackTitle 内部已兜底（AI 不可信/未配置时退回程序清洗，
       * 再不行用原标题），这里再包一层 catch 防止意外把整个解析拖挂。
       */
      const rawTitle = track.title
      let cleanedTitle = rawTitle
      try {
        const cleaned = await cleanTrackTitle(rawTitle, { settings })
        if (cleaned?.title) cleanedTitle = cleaned.title
      } catch {
        /* 清洗是增强，失败就用原标题继续 */
      }
      const cache = insightCacheRef.current
      // 「重来」要真的重来：先把这个键从缓存里删掉，否则会原样命中旧结果
      if (force) cache.delete(insightCacheKey({ id: track.id, title: cleanedTitle, artist: track.artist }))
      const { insight: result, cached } = await loadTrackInsight(cache, {
        settings: config,
        track: { id: track.id, title: cleanedTitle, artist: track.artist },
        lyricSnippet,
      })
      if (seq !== insightSeqRef.current) return
      setInsight(result)
      setInsightCached(cached)
    } catch (err) {
      if (seq !== insightSeqRef.current) return
      setInsight(null)
      setInsightError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === insightSeqRef.current) setInsightBusy(false)
    }
  }

  const toggleInsight = () => {
    const nextOpen = !insightOpen
    setInsightOpen(nextOpen)
    if (nextOpen && !insight && !insightBusy) void runInsight()
  }

  /**
   * 取消：作废在途请求（fetch 无法真正 abort，但结果不会再被采用）。
   *
   * 必须留一句可见的说明——取消后既没有结果也没有错误，四个状态全不匹配，
   * 卡片会变成一片空白，看起来像坏了。
   */
  const cancelInsight = () => {
    insightSeqRef.current += 1
    setInsightBusy(false)
    setInsightError('')
    setInsightCancelled(true)
  }

  useEffect(() => {
    if (!expanded || !fullscreen) {
      setControlsVisible(true)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const revealControls = () => {
      setControlsVisible(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setControlsVisible(false), 5000)
    }

    revealControls()
    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart', 'touchmove']
    events.forEach(event => window.addEventListener(event, revealControls, { passive: true }))
    return () => {
      if (timer) clearTimeout(timer)
      events.forEach(event => window.removeEventListener(event, revealControls))
    }
  }, [expanded, fullscreen])

  useEffect(() => {
    setCommentsOpen(false)
    setCommentsStatus('idle')
    setComments([])
    setCommentsPage(1)
    setCommentsTotal(0)
    setCommentsError('')
    setCommentsLoadingMore(false)
    /*
     * v1.4.14-pre4：切歌时收起解析卡片并作废在途请求。
     * 缓存不清——同一首歌切回来还该命中；但界面上的结果必须属于当前这首。
     */
    insightSeqRef.current += 1
    setInsightOpen(false)
    setInsightBusy(false)
    setInsight(null)
    setInsightError('')
    setInsightCached(false)
    setInsightNeedConfig(false)
    setInsightCancelled(false)
  }, [track?.id])

  return (
    <AnimatePresence>
      {expanded && track && (
        <motion.div
          key="now-playing"
          className={`now-playing ${fullscreen ? 'is-fullscreen' : ''} ${fullscreen && !controlsVisible ? 'is-immersive-idle' : ''}`}
          initial={{ opacity: 0, scale: 1.015 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="now-playing-smoke" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="now-playing-bg">
            {track.coverUrl && (
              <>
                <motion.div
                  className="now-playing-bg__cover"
                  style={{ backgroundImage: `url(${track.coverUrl})` }}
                  initial={{ opacity: 0, scale: 1.12 }}
                  animate={{ opacity: 0.72, scale: [1.16, 1.25, 1.18] }}
                  transition={{ opacity: { duration: 0.8 }, scale: { duration: 22, repeat: Infinity, ease: 'easeInOut' } }}
                />
                <motion.div
                  className="now-playing-bg__disc"
                  style={{ backgroundImage: `url(${track.coverUrl})` }}
                  animate={{ rotate: player.isPlaying ? 360 : 0 }}
                  transition={{ duration: 34, repeat: player.isPlaying ? Infinity : 0, ease: 'linear' }}
                />
              </>
            )}
          </div>

          <header className="now-playing-top now-playing-ui now-playing-ui--top" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
            <motion.button
              type="button"
              className="now-playing-close"
              onClick={close}
              title="收起 (Esc)"
              style={noDrag}
              whileHover={{ y: 1, backgroundColor: 'rgba(255,255,255,0.18)' }}
              whileTap={{ scale: 0.92 }}
            >
              <ChevronDown size={21} />
            </motion.button>
            <div className="now-playing-top__actions" style={noDrag}>
              <motion.button
                type="button"
                className="now-playing-close"
                onClick={openSourceVideo}
                title="在浏览器中打开视频"
                whileHover={{ y: 1, backgroundColor: 'rgba(255,255,255,0.18)' }}
                whileTap={{ scale: 0.92 }}
              >
                <ExternalLink size={18} />
              </motion.button>
              <motion.button
                type="button"
                className="now-playing-close"
                onClick={toggleFullscreen}
                title={fullscreen ? '退出全屏' : '全屏'}
                whileHover={{ y: 1, backgroundColor: 'rgba(255,255,255,0.18)' }}
                whileTap={{ scale: 0.92 }}
              >
                {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </motion.button>
              <motion.button
                type="button"
                className="now-playing-close"
                onClick={closeToTray}
                title="关闭到托盘"
                whileHover={{ y: 1, backgroundColor: 'rgba(255,255,255,0.18)' }}
                whileTap={{ scale: 0.92 }}
              >
                <X size={19} />
              </motion.button>
            </div>
          </header>

          <main className="now-playing-main">
            <motion.section
              className="now-playing-left"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: 0.08 }}
            >
              {/* v1.4.11-pre2 封面取景：contain 时容器跟随封面真实比例（上限见 coverFit.ts），
                  让柱子与图片下缘保持贴合；cover/fill 保持 1:1 方框 */}
              <div
                className={`now-playing-cover-wrap${followCoverAspect ? ' is-follow-aspect' : ''}`}
                style={followCoverAspect ? { aspectRatio: String(coverAspect) } : undefined}
              >
                <motion.div
                  className="now-playing-cover-glow"
                  animate={{ opacity: player.isPlaying ? [0.35, 0.72, 0.4] : 0.26 }}
                  transition={{ duration: 3.8, repeat: Infinity, ease: 'easeInOut' }}
                />
                <motion.img
                  layoutId="np-cover"
                  className="now-playing-cover"
                  src={track.coverUrl}
                  alt={track.title}
                  loading="eager"
                  decoding="sync"
                  draggable={false}
                  style={{ objectFit: settings.coverFit }}
                  onLoad={(e) => {
                    const img = e.currentTarget
                    setCoverAspect(coverAspectRatio(img.naturalWidth, img.naturalHeight))
                  }}
                  initial={false}
                  animate={{ opacity: 1, scale: 1, rotateX: 0 }}
                  transition={spring}
                />
                {/* v1.4.9-pre2 音频可视化：叠在封面下缘，仅在开启时渲染 */}
                {settings.audioVisualizer && (
                  <AudioVisualizer
                    active={player.isPlaying}
                    className="now-playing-visualizer"
                  />
                )}
              </div>

              <div className="now-playing-meta">
                <div className="now-playing-title-block">
                  <motion.h1 layoutId="np-title" transition={spring}>{track.title}</motion.h1>
                  <motion.button
                    type="button"
                    className="now-playing-artist-link"
                    layoutId="np-artist"
                    transition={spring}
                    onClick={openArtistSpace}
                    title={`查看 ${track.artist} 的个人空间`}
                  >
                    {track.artist}
                  </motion.button>
                </div>
                <motion.button
                  type="button"
                  className={`now-playing-heart now-playing-ui ${track.isLiked ? 'is-liked' : ''}`}
                  onClick={() => player.toggleLike(track.id)}
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.88 }}
                  title="喜欢"
                >
                  <Heart size={22} fill={track.isLiked ? 'currentColor' : 'none'} />
                </motion.button>
                <motion.button
                  type="button"
                  className="now-playing-ui"
                  onClick={() => setBiliFavOpen(true)}
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.88 }}
                  title="收藏到B站收藏夹"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--now-playing-muted, rgba(255,255,255,0.6))',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 6,
                  }}
                >
                  <Star size={20} />
                </motion.button>
              </div>

              <div className="now-playing-progress now-playing-ui" style={sliderTheme}>
                <PlayerSlider
                  ariaLabel="播放进度"
                  value={progress}
                  max={duration}
                  onChange={setProgress}
                  disabled={duration <= 0}
                  formatValue={formatTime}
                  variant="progress"
                />
                <div className="now-playing-time">
                  <span>{formatTime(progress)}</span>
                  <span>-{formatTime(Math.max(duration - progress, 0))}</span>
                </div>
              </div>

              <div className="now-playing-controls now-playing-ui now-playing-ui--controls">
                {/* 左侧：下载按钮 + 音量 */}
                <div className="now-playing-controls-left">
                  <DownloadButton variant="full" size={20} />
                  <div className="now-playing-volume-popover" style={sliderTheme}>
                    <motion.button
                      type="button"
                      className="now-playing-volume-trigger"
                      onClick={() => player.setIsMuted(!player.isMuted)}
                      title={player.isMuted ? '取消静音' : '静音'}
                      whileHover={{ scale: 1.08, y: -1 }}
                      whileTap={{ scale: 0.9 }}
                    >
                      {player.isMuted || player.volume <= 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                    </motion.button>
                    <div className="now-playing-volume-panel">
                      <div className="now-playing-volume-slider-wrap">
                        <PlayerSlider
                          ariaLabel="音量"
                          value={player.isMuted ? 0 : player.volume}
                          max={100}
                          step={5}
                          vertical
                          onChange={(v) => { player.setVolume(Math.round(v)); if (player.isMuted && v > 0) player.setIsMuted(false) }}
                          variant="volume"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* 中间：上一首 + 播放 + 下一首（对称布局） */}
                <div className="now-playing-control-cluster">
                  <RoundIcon onClick={player.prev} title="上一首">
                    <SkipBack size={27} />
                  </RoundIcon>
                  <motion.button
                    type="button"
                    className="now-playing-play"
                    onClick={player.togglePlay}
                    disabled={player.loadingAudio}
                    whileHover={{ scale: player.loadingAudio ? 1 : 1.045 }}
                    whileTap={{ scale: player.loadingAudio ? 1 : 0.94 }}
                  >
                    {player.loadingAudio
                      ? <Loader2 size={27} className="spin" />
                      : player.isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" style={{ marginLeft: 3 }} />}
                  </motion.button>
                  <RoundIcon onClick={player.next} title="下一首">
                    <SkipForward size={27} />
                  </RoundIcon>
                </div>

                {/* 右侧：循环/随机 + 评论按钮 */}
                <div className="now-playing-controls-right">
                  <RoundIcon
                    active={player.repeatMode !== 'none'}
                    onClick={() => {
                      const modes = ['none', 'all', 'one', 'shuffle'] as const
                      player.setRepeatMode(modes[(modes.indexOf(player.repeatMode) + 1) % 4])
                    }}
                    title={
                      player.repeatMode === 'none' ? '顺序播放' :
                      player.repeatMode === 'all' ? '列表循环' :
                      player.repeatMode === 'one' ? '单曲循环' : '随机播放'
                    }
                  >
                    <span className="now-playing-repeat">
                      {player.repeatMode === 'shuffle' ? <Shuffle size={20} /> : <Repeat size={20} />}
                      {player.repeatMode === 'one' && <span>1</span>}
                    </span>
                  </RoundIcon>
                  <RoundIcon active={commentsOpen} onClick={toggleComments} title="查看评论">
                    <MessageCircle size={20} />
                  </RoundIcon>
                  {/* v1.4.14-pre4 AI 曲目解析入口：与评论同一排，复用同一套圆形按钮样式 */}
                  <RoundIcon
                    active={insightOpen}
                    onClick={toggleInsight}
                    title="让 AI 说说这首歌（风格、在唱什么、适合什么时候听）"
                  >
                    <Sparkles size={20} />
                  </RoundIcon>
                </div>
              </div>
            </motion.section>

            <motion.section
              className="now-playing-lyrics-card"
              initial={{ opacity: 0, x: 34 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ ...spring, delay: 0.16 }}
            >
              {settings.showLyrics ? (
                <LyricsPanel lyrics={lyrics} track={track} onSeek={setProgress} currentTime={progress} />
              ) : (
                <Centered>
                  <Music size={42} strokeWidth={1.25} />
                  <strong>歌词显示已关闭</strong>
                  <span>可以在设置中重新开启歌词显示</span>
                </Centered>
              )}
            </motion.section>
          </main>

          <AnimatePresence>
            {insightOpen && (
              <InsightPanel
                track={track}
                insight={insight}
                busy={insightBusy}
                error={insightError}
                needConfig={insightNeedConfig}
                cancelled={insightCancelled}
                cached={insightCached}
                onClose={() => setInsightOpen(false)}
                onRetry={() => void runInsight(true)}
                onCancel={cancelInsight}
                onOpenSettings={() => {
                  // 去设置页前先收起卡片：回来时不该看到一个仍然「未配置」的空面板
                  setInsightOpen(false)
                  close()
                  navigate('/settings')
                }}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {commentsOpen && (
              <CommentsPanel
                comments={comments}
                status={commentsStatus}
                error={commentsError}
                total={commentsTotal}
                coverUrl={track.coverUrl}
                hasMore={comments.length > 0 && comments.length < commentsTotal}
                loadingMore={commentsLoadingMore}
                onClose={() => setCommentsOpen(false)}
                onRetry={() => loadComments(1)}
                onLoadMore={() => loadComments(commentsPage + 1)}
              />
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {track && <BiliFavoriteDialog
        open={biliFavOpen}
        onClose={() => setBiliFavOpen(false)}
        aid={track.aid}
        bvid={track.bvid || track.id}
        title={track.title}
      />}
    </AnimatePresence>
  )
}

/**
 * v1.4.14-pre4 AI 曲目解析卡片。
 *
 * 与评论面板同一套视觉语言（右侧浮层 + 毛玻璃），但只做一件事：
 * 把「风格 / 在唱什么 / 适合什么时候听」三件事说清楚。
 *
 * 四种状态互斥且都有明确文案——未配置给指引、失败给原因、生成中可取消。
 * 绝不静默失败：宁可显示一行「为什么没有结果」，也不留一片空白。
 */
function InsightPanel({
  track,
  insight,
  busy,
  error,
  needConfig,
  cancelled,
  cached,
  onClose,
  onRetry,
  onCancel,
  onOpenSettings,
}: {
  track: { title: string; artist: string }
  insight: TrackInsight | null
  busy: boolean
  error: string
  needConfig: boolean
  cancelled: boolean
  cached: boolean
  onClose: () => void
  onRetry: () => void
  onCancel: () => void
  onOpenSettings: () => void
}) {
  return (
    <motion.aside
      className="now-playing-insight"
      initial={{ opacity: 0, x: 42, scale: 0.985 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 42, scale: 0.985 }}
      transition={spring}
      role="dialog"
      aria-label="AI 曲目解析"
    >
      <div className="now-playing-insight__head">
        <div>
          <span><Sparkles size={17} />AI 解析</span>
          <small>
            {cached ? '来自本次会话的缓存' : busy ? '正在听你这首歌…' : '风格 · 在唱什么 · 适合什么时候听'}
          </small>
        </div>
        <button type="button" onClick={onClose} title="关闭解析">
          <X size={18} />
        </button>
      </div>

      <div className="now-playing-insight__body">
        {needConfig && (
          <Centered>
            <Sparkles size={42} strokeWidth={1.25} />
            <strong>还没有配置 AI</strong>
            <span>{error || '在设置里填好 API 地址、密钥与模型后就能用了'}</span>
            <button type="button" onClick={onOpenSettings}>去设置页配置</button>
          </Centered>
        )}

        {!needConfig && busy && (
          <Centered>
            <Loader2 size={28} className="spin" />
            <strong>正在解析《{track.title}》</strong>
            <span>不影响播放，你可以继续听</span>
            <button type="button" onClick={onCancel}>取消</button>
          </Centered>
        )}

        {!needConfig && !busy && !error && cancelled && (
          <Centered>
            <Sparkles size={38} strokeWidth={1.25} />
            <strong>已取消</strong>
            <span>这次没有生成解析，需要时随时可以重来</span>
            <button type="button" onClick={onRetry}><RefreshCw size={14} /> 重新生成</button>
          </Centered>
        )}

        {!needConfig && !busy && error && (
          <Centered>
            <RefreshCw size={38} strokeWidth={1.25} />
            <strong>解析失败</strong>
            <span>{error}</span>
            <button type="button" onClick={onRetry}><RefreshCw size={14} /> 重新生成</button>
          </Centered>
        )}

        {!needConfig && !busy && !error && !cancelled && insight && (
          <div className="now-playing-insight__content">
            {insight.summary && <p className="now-playing-insight__summary">{insight.summary}</p>}

            <div className="now-playing-insight__grid">
              {insight.style && (
                <div className="now-playing-insight__cell">
                  <span>风格</span>
                  <strong>{insight.style}</strong>
                </div>
              )}
              {insight.mood && (
                <div className="now-playing-insight__cell">
                  <span>情绪</span>
                  <strong>{insight.mood}</strong>
                </div>
              )}
              {insight.scene && (
                <div className="now-playing-insight__cell">
                  <span>适合</span>
                  <strong>{insight.scene}</strong>
                </div>
              )}
            </div>

            <div className="now-playing-insight__foot">
              <span>
                {insight.usedLyrics ? '结合了歌词片段' : '仅根据歌名与歌手'}
                {typeof insight.confidence === 'number' && ` · 置信度 ${Math.round(insight.confidence * 100)}%`}
              </span>
              <button type="button" onClick={onRetry} title="重新生成">
                <RefreshCw size={13} /> 重来
              </button>
            </div>
          </div>
        )}
      </div>
    </motion.aside>
  )
}

function CommentsPanel({
  comments,
  status,
  error,
  total,
  coverUrl,
  hasMore,
  loadingMore,
  onClose,
  onRetry,
  onLoadMore,
}: {
  comments: VideoComment[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  total: number
  coverUrl: string
  hasMore: boolean
  loadingMore: boolean
  onClose: () => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  return (
    <motion.aside
      className="now-playing-comments"
      style={{ '--comment-cover': coverUrl ? `url(${coverUrl})` : 'none' } as React.CSSProperties}
      initial={{ opacity: 0, x: 42, scale: 0.985 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 42, scale: 0.985 }}
      transition={spring}
    >
      <div className="now-playing-comments__aura" aria-hidden="true" />
      <div className="now-playing-comments__head">
        <div>
          <span><MessageCircle size={17} />评论</span>
          <small>{total > 0 ? `${formatCount(total)} 条互动` : '正在读取 Bilibili 评论'}</small>
        </div>
        <button type="button" onClick={onClose} title="关闭评论">
          <X size={18} />
        </button>
      </div>

      <div className="now-playing-comments__body">
        {status === 'loading' && (
          <Centered>
            <Loader2 size={28} className="spin" />
            <span>正在加载评论...</span>
          </Centered>
        )}

        {status === 'error' && (
          <Centered>
            <MessageCircle size={42} strokeWidth={1.25} />
            <strong>评论加载失败</strong>
            <span>{error || '稍后再试一次'}</span>
            <button type="button" onClick={onRetry}><RefreshCw size={14} /> 重新加载</button>
          </Centered>
        )}

        {status === 'ready' && comments.length === 0 && (
          <Centered>
            <MessageCircle size={42} strokeWidth={1.25} />
            <strong>暂无评论</strong>
            <span>这个视频下还没有可展示的评论</span>
          </Centered>
        )}

        {status === 'ready' && comments.length > 0 && (
          <div className="now-playing-comments__list">
            {comments.map((comment) => (
              <article key={comment.id} className="now-playing-comment">
                {comment.avatar
                  ? <img src={comment.avatar} alt="" />
                  : <div className="now-playing-comment__avatar">{comment.author.slice(0, 1).toUpperCase()}</div>}
                <div className="now-playing-comment__content">
                  <div className="now-playing-comment__meta">
                    <strong>{comment.author}</strong>
                    <span>{formatCommentTime(comment.createdAt)}</span>
                  </div>
                  <p>{comment.message}</p>
                  <div className="now-playing-comment__stats">
                    <span><ThumbsUp size={13} />{formatCount(comment.like)}</span>
                    {comment.replyCount > 0 && <span>{formatCount(comment.replyCount)} 条回复</span>}
                  </div>
                </div>
              </article>
            ))}

            {hasMore && (
              <button type="button" className="now-playing-comments__more" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? <Loader2 size={15} className="spin" /> : <MessageCircle size={15} />}
                {loadingMore ? '加载中...' : '加载更多评论'}
              </button>
            )}
          </div>
        )}
      </div>
    </motion.aside>
  )
}

function LyricsPanel({
  lyrics, track, onSeek, currentTime,
}: {
  lyrics: ReturnType<typeof useLyrics>
  track: { title: string; artist: string }
  onSeek: (t: number) => void
  currentTime: number
}) {
  const { status, result, choose, retry, offset, adjustOffset, resetOffset } = lyrics

  // v1.4.11-pre6 AI 歌词增强：单键切换「生成 → 还原」
  const [aiLyricBusy, setAiLyricBusy] = useState(false)
  const toggleAiLyric = async () => {
    if (lyrics.hasAiEnhance) {
      lyrics.clearAiEnhance()
      // v1.4.13-pre2 学习信号：还原说明这次增强不合口味
      void platform.userProfile?.record('lyricReverted').catch(() => {})
      return
    }
    if (!lyrics.rawResult?.lines?.length) return
    /*
     * v1.4.13-pre11（用户第 7 项）：中文歌先提示「这是中文歌曲」，
     * 用户确认后再增强。
     *
     * 理由：中文歌做翻译没有意义（译出来的还是中文），而这一步会真实消耗 API。
     * 所以不直接拒绝，也不默默执行——问一句，让用户自己决定。
     */
    if (detectLyricLanguage(lyrics.rawResult.lines) === 'zh') {
      /*
       * v1.4.13-pre14：改用系统原生对话框（主进程 dialog.showMessageBox），
       * 不再用 window.confirm 的 Chromium 自绘弹窗。无该 capability（Web / 移动端 /
       * 老 preload）时降级回 window.confirm，行为与原来完全一致。
       */
      const ask = platform.nativeDialog?.confirm
      const ok = ask
        ? await ask({
            message: '这是中文歌曲',
            detail: '翻译对中文歌通常没有意义，且会消耗 API 额度。仍要做 AI 增强吗？',
          })
        : window.confirm('这是中文歌曲。\n\n翻译对中文歌通常没有意义，且会消耗 API 额度。\n仍要做 AI 增强吗？')
      if (!ok) return
    }
    setAiLyricBusy(true)
    try {
      const config = await getAiConfig()
      // 先落盘：主进程按已存配置下发代理与密钥
      await saveAiConfig(config)
      const { result: enhanced } = await enhanceLyrics(config, lyrics.rawResult.lines, 'translate', {
        title: track.title,
        artist: track.artist,
      })
      lyrics.applyAiEnhance(enhanced)
    } catch {
      // 失败静默：播放页不适合弹错误框，用户可到设置页「测试连接」排查
    } finally {
      setAiLyricBusy(false)
    }
  }
  // v1.4.9-pre2 歌词双语开关：LyricsPanel 是独立组件，需自行读取设置
  // （顶层 NowPlaying 的 settings 不在本作用域内）
  const { settings } = useAppSettings()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LyricCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [choosingId, setChoosingId] = useState<string | null>(null)
  // v1.3.7：多源合并去重 + 加载更多（各源翻页游标）
  const [pageState, setPageState] = useState<MultiSourceState>(initialMultiSourceState)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // 搜索序号：防止快速连点/重开后过期请求回写
  const searchSeqRef = useRef(0)
  const { visible: desktopLyricVisible, suppressed: desktopLyricSuppressed, toggle: toggleDesktopLyric } = useDesktopLyricVisible()

  // v1.3.1：播放页内切换桌面歌词的小提示（顶部悬浮 3 秒，不干扰体验）
  const [lyricToast, setLyricToast] = useState<string | null>(null)
  const lyricToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showLyricToast = (text: string) => {
    setLyricToast(text)
    if (lyricToastTimer.current) clearTimeout(lyricToastTimer.current)
    lyricToastTimer.current = setTimeout(() => setLyricToast(null), 3000)
  }
  useEffect(() => () => {
    if (lyricToastTimer.current) clearTimeout(lyricToastTimer.current)
  }, [])

  // 播放页抑制中：点击“显示桌面歌词”只记录意图，退出播放页后才出现
  const handleToggleDesktopLyric = () => {
    const nextIntent = !desktopLyricVisible
    if (nextIntent && desktopLyricSuppressed) {
      showLyricToast('桌面歌词已显示，退出后即出现')
    } else if (!nextIntent) {
      showLyricToast('桌面歌词已隐藏')
    }
    toggleDesktopLyric()
  }

  /** 跑一轮多源搜索（fresh=首搜重置游标；否则在已展示结果上追加下一页） */
  const runRound = async (q: string, fresh: boolean) => {
    if (!q.trim()) return
    const seq = ++searchSeqRef.current
    const baseState = fresh ? initialMultiSourceState() : pageState
    const baseList = fresh ? [] : results
    if (fresh) setSearching(true)
    else setLoadingMore(true)
    try {
      const round = await searchMultiSourceRound(q, baseList, baseState)
      if (seq !== searchSeqRef.current) return
      setResults(round.candidates)
      setPageState(round.state)
      setHasMore(round.hasMore)
    } finally {
      if (seq === searchSeqRef.current) {
        if (fresh) setSearching(false)
        else setLoadingMore(false)
      }
    }
  }

  const openSearch = () => {
    const q = `${track.title} ${track.artist}`.trim()
    setQuery(q)
    setResults([])
    setPageState(initialMultiSourceState())
    setHasMore(false)
    setSearchOpen(true)
    // 打开即自动三源并发首搜，省去重复点搜索
    runRound(q, true)
  }

  const doSearch = () => runRound(query, true)

  const loadMore = () => runRound(query, false)

  const pick = async (record: LyricCandidate) => {
    // v1.4.5：选「不显示歌词」仅置标记，不发起取词请求，不进 spinner
    if (record.id === NO_LYRIC_CANDIDATE.id) {
      await choose(record)
      setSearchOpen(false)
      return
    }
    setChoosingId(record.id)
    await choose(record)
    setChoosingId(null)
    setSearchOpen(false)
  }

  return (
    <div className="lyrics-panel">
      {lyricToast && <div className="lyrics-panel__toast">{lyricToast}</div>}
      <div className="lyrics-panel__body">
        {status === 'loading' && (
          <Centered>
            <Loader2 size={28} className="spin" />
            <span>匹配歌词中...</span>
          </Centered>
        )}
        {status === 'empty' && (
          <Centered>
            <Music size={42} strokeWidth={1.25} />
            <strong>暂无歌词</strong>
            <span>这首歌在歌词库里还没有匹配到</span>
            <button type="button" onClick={openSearch}><Search size={14} /> 手动搜索歌词</button>
          </Centered>
        )}
        {status === 'none' && (
          <Centered>
            <Music size={42} strokeWidth={1.25} />
            <strong>无歌词</strong>
            <span>已选择「不显示歌词」，可在切换歌词里改回</span>
          </Centered>
        )}
        {(status === 'ok' || status === 'unsynced') && result && (
          <>
            {status === 'unsynced' && <div className="lyrics-panel__hint">该版本无逐行时间轴，按普通歌词显示</div>}
            <LyricsView
              lines={result.lines}
              currentTime={currentTime}
              synced={result.synced}
              onSeek={onSeek}
              bilingual={settings.lyricBilingual}
            />
          </>
        )}
      </div>

      {/* 歌词底部控制栏：切换歌词 + 时间偏移调整（none 态保留以便改回歌词） */}
      {(status === 'ok' || status === 'unsynced' || status === 'none') && (
        <div className="lyrics-panel__controls">
          <button type="button" className="lyrics-panel__ctrl-btn" onClick={handleToggleDesktopLyric} title={desktopLyricVisible ? '隐藏桌面歌词' : '显示桌面歌词'}>
            <Monitor size={15} />
            <span>{desktopLyricVisible ? '隐藏桌面歌词' : '显示桌面歌词'}</span>
          </button>
          <button type="button" className="lyrics-panel__ctrl-btn" onClick={openSearch} title="切换歌词版本">
            <Search size={15} />
            <span>切换歌词</span>
          </button>
          {/* v1.4.11-pre6 AI 歌词增强：翻译 / 逐句赏析，仅叠加显示、不改原歌词 */}
          {isAiSupported() && (
            <button
              type="button"
              className="lyrics-panel__ctrl-btn"
              onClick={() => void toggleAiLyric()}
              disabled={aiLyricBusy}
              title="用 AI 翻译或逐句赏析当前歌词（只影响显示）"
            >
              <Sparkles size={15} />
              <span>{aiLyricBusy ? '处理中…' : lyrics.hasAiEnhance ? '还原歌词' : 'AI 增强'}</span>
            </button>
          )}
          {status === 'ok' && (
            <div className="lyrics-panel__offset">
              <button type="button" onClick={() => adjustOffset(-200)} title="歌词提前 0.2s">
                <ChevronUp size={15} />
              </button>
              <span title="歌词时间偏移">
                {offset > 0 ? '+' : ''}{(offset / 1000).toFixed(1)}s
              </span>
              <button type="button" onClick={() => adjustOffset(200)} title="歌词延后 0.2s">
                <ChevronDown size={15} />
              </button>
              {offset !== 0 && (
                <button type="button" onClick={resetOffset} title="重置偏移">
                  <RotateCcw size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {searchOpen && (
          <motion.div
            className="lyrics-drawer"
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.985 }}
            transition={spring}
          >
            <div className="lyrics-drawer__head">
              <span>手动匹配歌词</span>
              <button type="button" onClick={() => setSearchOpen(false)}><X size={18} /></button>
            </div>
            <div className="lyrics-drawer__search">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doSearch() }}
                placeholder="歌名 歌手"
                autoFocus
              />
              <button type="button" onClick={doSearch} disabled={searching}>
                {searching ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
                搜索
              </button>
            </div>
            <div className="lyrics-drawer__list">
              {results.length === 0 && !searching && (
                <div className="lyrics-drawer__empty">{query.trim() ? '未找到相关歌曲，可换个关键词试试' : '输入歌名或歌手后搜索'}</div>
              )}
              <button type="button" className="lyrics-candidate" onClick={() => pick(NO_LYRIC_CANDIDATE)}>
                <span>
                  <strong>{NO_LYRIC_CANDIDATE.trackName}</strong>
                  <small>该曲目不再匹配、不再下载歌词</small>
                </span>
                <span>选择</span>
              </button>
              {results.map((r) => (
                <button key={r.id} type="button" className="lyrics-candidate" onClick={() => pick(r)} disabled={choosingId === r.id}>
                  <span>
                    <strong>
                      {r.trackName}
                      <em className={`lyrics-drawer__source is-${r.source}`}>{LYRIC_SOURCE_LABELS[r.source]}</em>
                    </strong>
                    <small>{r.artistName} · {r.albumName || '—'} · {formatTime(r.duration)}</small>
                  </span>
                  {choosingId === r.id ? <Loader2 size={16} className="spin" /> : <span>选择</span>}
                </button>
              ))}
              {results.length > 0 && (
                hasMore ? (
                  <button type="button" className="lyrics-drawer__more" onClick={loadMore} disabled={loadingMore || searching}>
                    {loadingMore ? <Loader2 size={14} className="spin" /> : <ChevronDown size={14} />}
                    {loadingMore ? '加载中...' : '加载更多'}
                  </button>
                ) : (
                  <div className="lyrics-drawer__more is-end">没有更多结果了</div>
                )
              )}
            </div>
            <button type="button" className="lyrics-drawer__retry" onClick={() => { retry(); setSearchOpen(false) }}>
              重新自动匹配
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function RoundIcon({ children, active, onClick, title }: { children: ReactNode; active?: boolean; onClick: () => void; title: string }) {
  return (
    <motion.button
      type="button"
      className={`now-playing-round ${active ? 'is-active' : ''}`}
      onClick={onClick}
      title={title}
      whileHover={{ scale: 1.08, y: -1 }}
      whileTap={{ scale: 0.9 }}
    >
      {children}
    </motion.button>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="lyrics-centered">{children}</div>
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`
  return n.toString()
}

function formatCommentTime(seconds: number): string {
  if (!seconds) return ''
  const date = new Date(seconds * 1000)
  const now = Date.now()
  const diff = Math.max(0, now - date.getTime())
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

import { useEffect, useState } from 'react'
import { Pause, SkipBack, SkipForward, Volume2, Repeat } from 'lucide-react'
import LyricsView from '@/components/LyricsView'
import PlayerSlider from '@/components/PlayerSlider'
import type { LyricLine } from '@/services/lyrics'

/**
 * v1.4.6-pre3 方案 A：MV 导出专用离屏渲染舞台（#/mv-export 路由）。
 *
 * 与 NowPlaying 复用同一套真实 UI：同款 CSS（.now-playing-*）、同款组件
 * （LyricsView / PlayerSlider）、同款图标布局，由主进程驱动「当前播放时间」
 * 步进并逐帧捕获；进度条/时间数字/水印全部由本组件画进帧内，
 * ffmpeg 侧不再有任何 drawbox/drawtext 叠画。
 *
 * 通信约定（无 preload，主进程 executeJavaScript 直呼）：
 * - window.__mvInit(payloadJson)  注入曲目信息（主进程在页面加载后调用）
 * - window.__mvSetTime(seconds)   步进当前时间（渲染 + 歌词高亮随之更新）
 * - window.__mvReady              字体/封面就绪后置 true，主进程轮询后开始捕获
 */

interface MvStagePayload {
  title: string
  artist: string
  cover: string
  duration: number
  /** 并行分段渲染：本窗起始时间（v1.4.7-pre2），舞台直接落位到该处，歌词不从开头滚入 */
  startTime?: number
  lyrics: LyricLine[]
  watermark: boolean
}

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const sliderTheme = {
  ['--track-bg']: 'rgba(255,255,255,0.18)',
  ['--track-fill']: '#ffffff',
  ['--track-thumb']: '#ffffff',
} as React.CSSProperties

// 桥接必须挂在模块加载期：主进程 loadURL 返回后立刻 executeJavaScript 调 __mvInit，
// 不能等 React effect 挂载（存在竞态）。payload 先落 pending，组件挂载后取走。
let pendingPayloadJson: string | null = null
let timeSink: ((t: number) => void) | null = null

if (typeof window !== 'undefined') {
  window.__mvInit = (json: string) => {
    pendingPayloadJson = json
    window.dispatchEvent(new Event('mv-payload'))
  }
  window.__mvSetTime = (t: number) => timeSink?.(t)
}

function parsePayload(json: string | null): MvStagePayload | null {
  if (!json) return null
  try {
    return JSON.parse(json) as MvStagePayload
  } catch {
    return null
  }
}

export default function MvExportStage() {
  const [payload, setPayload] = useState<MvStagePayload | null>(() => parsePayload(pendingPayloadJson))
  // 初始时间来自 startTime（并行分段每窗各自起点），不是 0——避免首个 __mvSetTime 触发歌词整页跳滚
  const [time, setTime] = useState(() => parsePayload(pendingPayloadJson)?.startTime || 0)
  // 字体就绪后翻 1 → LyricsView 立即重定位（初始定位发生在字体加载前，行高会变，pre3 跳变残余根因）
  const [layoutSettled, setLayoutSettled] = useState(0)

  useEffect(() => {
    timeSink = setTime
    const onPayload = () => setPayload(parsePayload(pendingPayloadJson))
    window.addEventListener('mv-payload', onPayload)
    return () => {
      timeSink = null
      window.removeEventListener('mv-payload', onPayload)
    }
  }, [])

  // 封面解码 + 字体就绪后才允许主进程开始捕获，保证第一帧就是完整画面
  useEffect(() => {
    if (!payload) return
    let cancelled = false
    const cover = document.querySelector<HTMLImageElement>('.now-playing-cover')
    Promise.all([
      document.fonts.ready,
      cover?.decode().catch(() => {}),
    ]).then(() => {
      if (cancelled) return
      setLayoutSettled((n) => n + 1)
      window.__mvReady = true
    })
    return () => { cancelled = true }
  }, [payload])

  const track = {
    title: payload?.title || '',
    artist: payload?.artist || '',
    coverUrl: payload?.cover || '',
  }
  const duration = payload?.duration || 0
  const lyrics = payload?.lyrics || []

  return (
    <div className="now-playing">
      <div className="now-playing-smoke" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="now-playing-bg">
        {track.coverUrl && (
          <>
            <div
              className="now-playing-bg__cover"
              style={{ backgroundImage: `url(${track.coverUrl})`, opacity: 0.72 }}
            />
            <div
              className="now-playing-bg__disc"
              style={{ backgroundImage: `url(${track.coverUrl})` }}
            />
          </>
        )}
      </div>

      {payload?.watermark && (
        <div
          style={{
            position: 'absolute',
            top: 20,
            right: 24,
            zIndex: 5,
            fontSize: 12.5,
            fontWeight: 500,
            fontFamily: "'Poppins', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            letterSpacing: 1.6,
            color: 'rgba(255,255,255,0.42)',
            textShadow: '0 1px 12px rgba(0,0,0,0.45)',
            userSelect: 'none',
          }}
        >
          音乐源自Bilibili，由BiliMusic进行渲染
        </div>
      )}

      <div className="now-playing-main">
        <section className="now-playing-left">
          <div className="now-playing-cover-wrap">
            <div className="now-playing-cover-glow" style={{ opacity: 0.4 }} />
            <img
              className="now-playing-cover"
              src={track.coverUrl}
              alt={track.title}
              draggable={false}
            />
          </div>

          <div className="now-playing-meta">
            <div className="now-playing-title-block">
              <h1>{track.title}</h1>
              <span className="now-playing-artist-link">{track.artist}</span>
            </div>
          </div>

          <div className="now-playing-progress now-playing-ui" style={sliderTheme}>
            <PlayerSlider
              ariaLabel="播放进度"
              value={time}
              max={duration}
              onChange={() => {}}
              disabled={duration <= 0}
              formatValue={formatTime}
              variant="progress"
            />
            <div className="now-playing-time">
              <span>{formatTime(time)}</span>
              <span>-{formatTime(Math.max(duration - time, 0))}</span>
            </div>
          </div>

          {/* 底部控件区：静态展示（暂停态），与真实播放页同构 */}
          <div className="now-playing-controls now-playing-ui now-playing-ui--controls">
            <div className="now-playing-controls-left">
              <div className="now-playing-volume-popover" style={sliderTheme}>
                <button type="button" className="now-playing-volume-trigger" style={{ cursor: 'default' }}>
                  <Volume2 size={20} />
                </button>
              </div>
            </div>
            <div className="now-playing-control-cluster">
              <button type="button" className="now-playing-round" style={{ cursor: 'default' }}>
                <SkipBack size={27} />
              </button>
              <button type="button" className="now-playing-play" style={{ cursor: 'default' }}>
                {/* 成片语义为「播放中」（pre3）：显示暂停态图标 ⏸，此前误用播放三角呈暂停观感 */}
                <Pause size={30} fill="currentColor" />
              </button>
              <button type="button" className="now-playing-round" style={{ cursor: 'default' }}>
                <SkipForward size={27} />
              </button>
            </div>
            <div className="now-playing-controls-right">
              <button type="button" className="now-playing-round" style={{ cursor: 'default' }}>
                <span className="now-playing-repeat">
                  <Repeat size={20} />
                </span>
              </button>
            </div>
          </div>
        </section>

        <section className="now-playing-lyrics-card">
          <div className="lyrics-panel">
            <div className="lyrics-panel__body">
              {lyrics.length > 0 ? (
                <LyricsView
                  lines={lyrics}
                  currentTime={time}
                  synced
                  onSeek={() => {}}
                  // v1.4.7-pre5 时间驱动根修：滚动与行样式全部由 currentTime 纯函数插值，
                  // 不依赖浏览器 smooth 滚动/spring 的墙钟演化——离屏按歌曲时间步进采样，
                  // 动画匀速精确、掉帧只降采样密度不改变形状，多窗接缝两侧状态天然连续。
                  timeDriven
                  // v1.4.7-pre3：字体就绪后强制重定位，消除字体度量变化导致的残余跳变
                  repositionSignal={layoutSettled}
                />
              ) : (
                <div className="lyrics-centered">
                  <strong>暂无歌词</strong>
                  <span>这首歌还没有匹配到逐行歌词</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    __mvInit?: (json: string) => void
    __mvSetTime?: (t: number) => void
    __mvReady?: boolean
  }
}

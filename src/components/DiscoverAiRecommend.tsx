/**
 * v1.4.12-pre3 发现页 AI 推荐板块。
 *
 * 三种模式（设置里可切，默认 click）：
 * - click：显示「获取推荐」按钮，用户点击才请求（不点不消耗 API）
 * - auto：挂载即请求一次
 * - off：整块不渲染
 *
 * 组件自己管请求与错误态，不污染 Discover 页的数据流。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, RefreshCw, Heart, EyeOff } from 'lucide-react'
import { getAiConfig, isAiSupported } from '@/services/ai'
import { platform } from '@/platform'
import { generateRecommendation, type AiRecommendation } from '@/services/aiRecommend'
import { usePlayer } from '@/contexts/PlayerContext'
import { toHttpsUrl } from '@/services/bilibiliApi'
import type { AiSettings } from '@/types'

interface Props {
  /** 点击曲目播放；由 Discover 注入以复用既有播放逻辑 */
  onPlayTrack: (track: import('@/types').Track) => void
}

export default function DiscoverAiRecommend({ onPlayTrack }: Props) {
  const player = usePlayer()
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState<AiRecommendation | null>(null)
  /** v1.4.13-pre1：本轮已播放过的曲目 id，用于判定哪些被跳过 */
  const playedRef = useRef<Set<string>>(new Set())
  /**
   * v1.4.14-pre3 显式反馈的本地状态，key 为 track.id。
   *
   * 只存本轮的 UI 状态，不存次数——真实计数在 ai-learned.json 里。
   * 用 state 而不是 ref：点了按钮必须立刻重渲染出「已喜欢 / 已忽略」。
   */
  const [feedback, setFeedback] = useState<Record<string, 'liked' | 'disliked'>>({})
  /**
   * 同一份反馈的 ref 副本。
   *
   * load 的依赖数组只有 [settings]（不重造它，否则 auto 模式会反复触发请求），
   * 直接闭包读 state 会拿到旧值——换一批时就会给已表态的曲目补记 skipped。
   * 用 ref 让 load 始终读到最新表态。
   */
  const feedbackRef = useRef<Record<string, 'liked' | 'disliked'>>({})

  // 读取设置（模式与 Provider 配置都在这）
  useEffect(() => {
    if (!isAiSupported()) return
    let cancelled = false
    void getAiConfig().then((cfg) => { if (!cancelled) setSettings(cfg) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const mode = settings?.recommendMode || 'click'
  /*
   * v1.4.13-pre9 修正（用户第 2 项）：首页仍显示「未配置 AI」。
   *
   * 原来只认 OpenAI 兼容三件套（baseUrl + apiKey + model），而 WorkBuddy 走的是
   * 账号凭据，这三项本来就是空的——于是其它 AI 功能都能用，唯独这一块判成未配置。
   * WorkBuddy 只要选了模型就算已配置，实际可用性由调用时的报错兜底。
   */
  const configured =
    settings?.source === 'workbuddy'
      ? !!settings.wbModel
      : !!(settings?.baseUrl && settings?.apiKey && settings?.model)

  /**
   * v1.4.14-pre3：记一次显式表态。
   *
   * 互斥在前端也做一层：同一首点了喜欢又点不感兴趣时，UI 只保留最后一次选择；
   * 落盘的互斥由主进程 applyExplicitFeedback 保证（它会清掉对侧计数）。
   * 前端这层是为了让按钮状态和磁盘状态永远一致，不依赖 IPC 往返时序。
   */
  const feedbackKey = (t: { artist: string; title: string }) => t.artist + '|' + t.title
  const sendFeedback = useCallback((id: string, kind: 'liked' | 'disliked', key: string) => {
    if (feedbackRef.current[id] === kind) return
    feedbackRef.current = { ...feedbackRef.current, [id]: kind }
    setFeedback(feedbackRef.current)
    void platform.userProfile?.record(kind, key).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!settings) return
    // v1.4.13-pre1 学习信号：换一批时把上一批里「一首都没播」的记作跳过
    // v1.4.14-pre3：已经显式表态过的曲目不再补记 skipped——用户已经说得很清楚，
    // 再叠一条隐式信号只会让同一件事被计两次，稀释权重
    if (data && platform.userProfile) {
      for (const t of data.tracks) {
        if (!playedRef.current.has(t.id) && !feedbackRef.current[t.id]) {
          void platform.userProfile.record('skipped', t.artist + '|' + t.title).catch(() => {})
        }
      }
    }
    playedRef.current = new Set()
    feedbackRef.current = {}
    setFeedback({})
    setBusy(true)
    setError('')
    try {
      const res = await generateRecommendation({ settings })
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [settings])

  // auto 模式：配置就绪后自动请求一次（已有结果不重复请求，避免切回页面就烧钱）
  useEffect(() => {
    if (mode !== 'auto' || !configured || data || busy) return
    void load()
  }, [mode, configured, data, busy, load])

  if (!isAiSupported() || mode === 'off') return null

  const greeting = data?.greeting
  const tracks = data?.tracks || []

  return (
    <section className="am-section discover-ai">
      <div className="discover-ai__head">
        <div className="discover-ai__title">
          <Sparkles size={20} />
          <strong>为你推荐</strong>
          {/*
            v1.4.13-pre10（用户第 2 项）：生成过程中要有明确的「在动」信号。
            没有它时，用户打开首页看到空白会以为坏了。
          */}
          {busy && (
            <span className="discover-ai__dots" aria-label="正在生成" role="status">
              <i /><i /><i />
            </span>
          )}
          {data?.contextLabel && <span className="discover-ai__ctx">{data.contextLabel}</span>}
        </div>
        {mode === 'click' && (
          <button
            type="button"
            className="discover-ai__btn"
            onClick={() => void load()}
            disabled={busy || !configured}
          >
            <RefreshCw size={14} />
            {busy ? '生成中…' : data ? '换一批' : '获取推荐'}
          </button>
        )}
        {mode === 'auto' && data && (
          <button type="button" className="discover-ai__btn" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={14} />
            {busy ? '生成中…' : '换一批'}
          </button>
        )}
      </div>

      {!configured && (
        <p className="discover-ai__hint">
          {settings?.source === 'workbuddy'
            ? '已选择 WorkBuddy，但还没有选模型：到「设置 → AI 助手 → 服务预设」重新选一次 WorkBuddy 并挑一个模型。'
            : '还没有配置 AI：到「设置 → AI 助手」填入地址、模型与密钥后即可使用。'}
        </p>
      )}

      {/*
        v1.4.13-pre10：生成中给骨架占位，而不是留一片空白。
        骨架的行数与最终结果一致，切换时不跳动。
      */}
      {busy && !data && (
        <div className="discover-ai__list discover-ai__list--skeleton" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="discover-ai__item discover-ai__item--skeleton">
              <span className="discover-ai__sk-cover" />
              <span className="discover-ai__sk-meta">
                <span className="discover-ai__sk-line" />
                <span className="discover-ai__sk-line discover-ai__sk-line--short" />
              </span>
            </div>
          ))}
        </div>
      )}

      {greeting && <p className="discover-ai__greeting">{greeting}</p>}

      {error && <p className="discover-ai__error">{error}</p>}

      {tracks.length > 0 && (
        <div className="discover-ai__list">
          {tracks.map((t) => {
            const state = feedback[t.id]
            const disliked = state === 'disliked'
            return (
              /*
                v1.4.14-pre3：整项从 <button> 改成容器。
                反馈按钮必须能单独点，而 button 不能嵌套 button——
                否则键盘 Tab 会进到非法结构里，点反馈也会冒泡触发播放。
              */
              <div
                key={t.id}
                className={
                  'discover-ai__item' +
                  (state ? ' discover-ai__item--' + state : '') +
                  (disliked ? ' discover-ai__item--muted' : '')
                }
              >
                <button
                  type="button"
                  className="discover-ai__play"
                  onClick={() => {
                    if (disliked) return
                    onPlayTrack(t)
                    // 顺手加入播放队列，避免只播一首就停
                    if (!player.queue.some((q) => q.id === t.id)) player.addToQueue(t)
                    // v1.4.13-pre1 学习信号：记下「被播放」，与跳过互斥
                    playedRef.current.add(t.id)
                    void platform.userProfile?.record('played', t.artist + '|' + t.title).catch(() => {})
                  }}
                  aria-label={'播放 ' + t.title + (t.artist ? ' - ' + t.artist : '')}
                >
                  <img src={toHttpsUrl(t.coverUrl)} alt="" loading="lazy" />
                  <div className="discover-ai__meta">
                    <strong>{t.title}</strong>
                    <span>{t.artist}</span>
                    {data?.reasons[t.id] && <em>{data.reasons[t.id]}</em>}
                  </div>
                </button>
                {/*
                  降级：platform.userProfile 缺失（Web / 移动端）时整组按钮不渲染，
                  而不是渲染出点了没反应的死按钮。
                */}
                {platform.userProfile && (
                  <div className="discover-ai__acts">
                    <button
                      type="button"
                      className={
                        'discover-ai__act discover-ai__act--like' +
                        (state === 'liked' ? ' is-active' : '')
                      }
                      aria-pressed={state === 'liked'}
                      aria-label={state === 'liked' ? '已喜欢 ' + t.title : '喜欢 ' + t.title}
                      title={state === 'liked' ? '已喜欢' : '喜欢'}
                      onClick={() => sendFeedback(t.id, 'liked', feedbackKey(t))}
                    >
                      <Heart size={14} aria-hidden="true" />
                      {/* 文字与图标同时存在：不靠颜色区分状态 */}
                      <span>{state === 'liked' ? '已喜欢' : '喜欢'}</span>
                    </button>
                    <button
                      type="button"
                      className={
                        'discover-ai__act discover-ai__act--dislike' +
                        (disliked ? ' is-active' : '')
                      }
                      aria-pressed={disliked}
                      aria-label={disliked ? '已忽略 ' + t.title : '不感兴趣 ' + t.title}
                      title={disliked ? '已忽略' : '不感兴趣'}
                      onClick={() => sendFeedback(t.id, 'disliked', feedbackKey(t))}
                    >
                      <EyeOff size={14} aria-hidden="true" />
                      <span>{disliked ? '已忽略' : '不感兴趣'}</span>
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!data && !error && configured && mode === 'click' && !busy && (
        <p className="discover-ai__hint">点「获取推荐」，让 AI 按当前时间与你的听歌习惯挑几首。</p>
      )}
    </section>
  )
}

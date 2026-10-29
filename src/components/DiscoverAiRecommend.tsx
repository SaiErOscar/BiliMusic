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
import { Sparkles, RefreshCw } from 'lucide-react'
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

  const load = useCallback(async () => {
    if (!settings) return
    // v1.4.13-pre1 学习信号：换一批时把上一批里「一首都没播」的记作跳过
    if (data && platform.userProfile) {
      for (const t of data.tracks) {
        if (!playedRef.current.has(t.id)) {
          void platform.userProfile.record('skipped', t.artist + '|' + t.title).catch(() => {})
        }
      }
    }
    playedRef.current = new Set()
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

      {greeting && <p className="discover-ai__greeting">{greeting}</p>}

      {error && <p className="discover-ai__error">{error}</p>}

      {tracks.length > 0 && (
        <div className="discover-ai__list">
          {tracks.map((t) => (
            <button
              key={t.id}
              type="button"
              className="discover-ai__item"
              onClick={() => {
                onPlayTrack(t)
                // 顺手加入播放队列，避免只播一首就停
                if (!player.queue.some((q) => q.id === t.id)) player.addToQueue(t)
                // v1.4.13-pre1 学习信号：记下「被播放」，与跳过互斥
                playedRef.current.add(t.id)
                void platform.userProfile?.record('played', t.artist + '|' + t.title).catch(() => {})
              }}
            >
              <img src={toHttpsUrl(t.coverUrl)} alt="" loading="lazy" />
              <div className="discover-ai__meta">
                <strong>{t.title}</strong>
                <span>{t.artist}</span>
                {data?.reasons[t.id] && <em>{data.reasons[t.id]}</em>}
              </div>
            </button>
          ))}
        </div>
      )}

      {!data && !error && configured && mode === 'click' && !busy && (
        <p className="discover-ai__hint">点「获取推荐」，让 AI 按当前时间与你的听歌习惯挑几首。</p>
      )}
    </section>
  )
}

/**
 * v1.4.14-pre5 对话式音乐助手 · 对话 UI。
 *
 * 职责分工：意图解析在 services/aiChatAssistant（它只「听懂」，不执行），
 * 本组件负责「听懂之后干什么」——按 intent 分发到既有的推荐 / 歌单 / 搜索 /
 * 曲目解析 / 播放控制能力，不重造任何一条下游链路。
 *
 * 设计取舍：
 * - **不打断播放**：除 control 分支与用户主动点曲目外，全程不碰 player。
 *   请求期间播放继续，用户不会因为「问了一句话」而被打断。
 * - **用序号作废在途请求**（seqRef，与 NowPlaying 的 insightSeqRef 同一范式）：
 *   用户连续追问时，晚到的旧结果不许回写，否则会串到新问题下面。
 * - **没听懂就说没听懂**：unknown 或 confidence < 0.5 一律给可点击的意图候选，
 *   不静默失败、不硬猜——猜错会真的去放歌或建歌单，代价比多问一句高。
 * - **未配置 AI 不报错**：入口照常可见，点了给「去设置」的指引，
 *   而不是发一个注定失败的请求再弹红字。
 *
 * ## v1.4.14-pre8（用户第 4 项）：从「页面顶部常驻」改成「抽屉里打开」
 *
 * 用户原话：把「和助手说句话」做成「为你推荐」旁的按钮，需要时在抽屉中打开，
 * 避免占用启动后「为你推荐」的推荐位、占据焦点，应将焦点还给推荐。
 *
 * 于是本组件拆成两层：
 * - AiChatAssistant：对话本体（输入框 + 对话流），只管「说一句话之后干什么」，
 *   六种意图分支、缓存、取消逻辑一行没动，只把最外层容器从 section 换成 div，
 *   因为抽屉外壳已经提供了 section 语义。
 * - AiChatSheet：入口按钮 + 抽屉外壳（复用 ai-sheet__* 范式）。
 *   关闭时对话本体**不挂载**：既不占页面顶部，也不在初始加载时抢焦点。
 *
 * 关掉再打开会丢对话记录，这是刻意的——抽屉是「需要时才叫出来」的临时面板，
 * 保留跨次会话的历史会让「打开抽屉」变成「翻旧账」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, MessageCircle, Send, Sparkles, Trash2 } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { getAiConfig, isAiSupported } from '@/services/ai'
import {
  planAssistantRequest,
  renderPlanHint,
  UNKNOWN_REPLY,
  type AssistantIntent,
  type AssistantPlan,
} from '@/services/aiChatAssistant'
import { generateRecommendation, timeContext } from '@/services/aiRecommend'
import { generateAiPlaylist, saveAiPlaylist, type AiPlaylistResult } from '@/services/aiPlaylist'
import { generateTrackInsight, isAiConfigured, type TrackInsight } from '@/services/aiTrackInsight'
import { searchVideo, type SearchItem } from '@/services/api'
import { cleanTrackTitle } from '@/services/titleClean'
import { useAppSettings } from '@/hooks/useAppSettings'
import { platform } from '@/platform'
import type { AiSettings, Track } from '@/types'

/** 五个可执行意图（unknown 不在候选里：它不是一个「动作」） */
type ActionableIntent = Exclude<AssistantIntent, 'unknown'>

const INTENT_LABELS: Record<ActionableIntent, string> = {
  recommend: '推荐几首',
  playlist: '做个歌单',
  search: '搜 B 站',
  explain: '解释这首歌',
  control: '播放控制',
}

const INTENT_ORDER: ActionableIntent[] = ['recommend', 'playlist', 'search', 'explain', 'control']

/** 意图候选之外，给「播放控制」二次展开的四个动作 */
const CONTROL_ACTIONS: { action: 'play' | 'pause' | 'next' | 'prev'; label: string }[] = [
  { action: 'play', label: '播放' },
  { action: 'pause', label: '暂停' },
  { action: 'next', label: '下一首' },
  { action: 'prev', label: '上一首' },
]

/** 输入框下方的示例句：让「能说什么」一眼可见，而不是让用户猜 */
const QUICK_PROMPTS = ['来点适合跑步的', '做个写作业听的歌单', '下一首']

/** 置信度低于此值就不执行，改为请用户改选（与服务层注释的口径一致） */
const CONFIDENCE_FLOOR = 0.5

type TurnStatus = 'understanding' | 'working' | 'done'

/** 助手回合的附加产物：决定气泡下面渲染什么 */
type Payload =
  | { kind: 'recommend'; tracks: Track[]; reasons: Record<string, string> }
  | { kind: 'playlist'; result: AiPlaylistResult; saved: boolean }
  | { kind: 'search'; items: SearchItem[] }
  | { kind: 'explain'; insight: TrackInsight }
  | { kind: 'candidates'; actions: boolean }

interface Turn {
  id: number
  role: 'user' | 'assistant'
  text: string
  status?: TurnStatus
  payload?: Payload
  /** 失败原因或补充说明，与正文分开渲染（不混进对话语气里） */
  notice?: string
  /** 未配置 AI：额外给一个「去设置」按钮 */
  needConfig?: boolean
}

/** B 站搜索结果 → Track；时长解析与 Search 页同口径 */
function parseDuration(d: string): number {
  if (!d) return 0
  const parts = d.split(':').map(Number)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

function searchItemToTrack(item: SearchItem): Track {
  return {
    id: item.bvid,
    title: item.title,
    artist: item.author,
    coverUrl: item.pic,
    duration: parseDuration(item.duration),
    videoUrl: `https://www.bilibili.com/video/${item.bvid}`,
    bvid: item.bvid,
    playCount: item.play,
    isLiked: false,
  }
}

/**
 * 对话本体：输入框 + 对话流 + 六种意图分支。
 *
 * 不对外导出——入口与外壳由下面的 AiChatAssistant 负责，
 * 这样「什么时候显示对话」和「说一句话之后干什么」互不纠缠。
 */
function AiChatBody() {
  const player = usePlayer()
  const navigate = useNavigate()
  const { settings } = useAppSettings()

  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, setPending] = useState(false)
  /** 回合 id 自增；同时用来做 React key */
  const turnIdRef = useRef(0)
  /** 请求序号：新请求 / 取消都会自增，晚到的旧结果据此丢弃 */
  const seqRef = useRef(0)
  const logRef = useRef<HTMLDivElement | null>(null)

  // 新内容进来时滚到底部，用户不必手动往下拉
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  const updateTurn = useCallback((id: number, patch: Partial<Turn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  /** 读 AI 配置；环境不支持或读取失败一律返回 null，由调用方给指引 */
  const loadConfig = useCallback(async (): Promise<AiSettings | null> => {
    if (!isAiSupported()) return null
    try {
      return await getAiConfig()
    } catch {
      return null
    }
  }, [])

  /**
   * 按意图执行。
   *
   * seq 由调用方持有：每个 await 之后都要重新比对，否则一次慢响应
   * 就会把结果写到用户已经翻篇的回合里。
   */
  const runPlan = useCallback(
    async (plan: AssistantPlan, seq: number, turnId: number, config: AiSettings) => {
      const hint = renderPlanHint(plan)
      const text = plan.reply || UNKNOWN_REPLY

      switch (plan.intent) {
        case 'recommend': {
          updateTurn(turnId, { status: 'working', text: '正在挑歌…' })
          try {
            const rec = await generateRecommendation({ settings: config, limit: 5 })
            if (seq !== seqRef.current) return
            updateTurn(turnId, {
              status: 'done',
              text: [text, hint].filter(Boolean).join(' '),
              payload: { kind: 'recommend', tracks: rec.tracks, reasons: rec.reasons },
            })
          } catch (err) {
            if (seq !== seqRef.current) return
            updateTurn(turnId, { status: 'done', text: '没能挑出歌来。', notice: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        case 'playlist': {
          updateTurn(turnId, { status: 'working', text: '正在攒歌单…' })
          try {
            /*
             * 这里能把用户的偏好真正传下去：generateAiPlaylist 的第二个参数就是
             * 自然语言描述，renderPlanHint 产出的正是「用户的额外要求」那一段。
             */
            const result = await generateAiPlaylist(config, hint || plan.mood || plan.subject || text)
            if (seq !== seqRef.current) return
            updateTurn(turnId, {
              status: 'done',
              text: [text, hint].filter(Boolean).join(' '),
              payload: { kind: 'playlist', result, saved: false },
            })
          } catch (err) {
            if (seq !== seqRef.current) return
            updateTurn(turnId, { status: 'done', text: '歌单没攒成。', notice: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        case 'search': {
          const query = (plan.query || '').trim()
          if (!query) {
            updateTurn(turnId, { status: 'done', text: '没听出要搜什么，说个关键词我再去 B 站找。' })
            return
          }
          updateTurn(turnId, { status: 'working', text: `正在 B 站搜「${query}」…` })
          try {
            const data = await searchVideo(query, 1)
            if (seq !== seqRef.current) return
            if (!data.items.length) {
              updateTurn(turnId, { status: 'done', text: `B 站没搜到「${query}」，换个关键词试试。` })
              return
            }
            updateTurn(turnId, {
              status: 'done',
              text: `在 B 站找到 ${data.items.length} 个结果。`,
              payload: { kind: 'search', items: data.items.slice(0, 8) },
            })
          } catch (err) {
            if (seq !== seqRef.current) return
            updateTurn(turnId, { status: 'done', text: '搜索没成功。', notice: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        case 'explain': {
          const track = player.currentTrack
          if (!track) {
            updateTurn(turnId, {
              status: 'done',
              text: plan.subject ? `想让我说说《${plan.subject}》的话，先把它放起来。` : '现在没有在放的歌，先挑一首，我再讲讲它。',
            })
            return
          }
          updateTurn(turnId, { status: 'working', text: '正在听这首歌…' })
          try {
            /*
             * 标题清洗放在 UI 侧（与 NowPlaying 的 runInsight 同一理由）：
             * cleanTrackTitle 要的是 AppSettings（含 titleCleanMode），
             * 而 generateTrackInsight 要的是 AiSettings，两者不是同一份配置。
             */
            let cleanedTitle = track.title
            try {
              const cleaned = await cleanTrackTitle(track.title, { settings })
              if (cleaned?.title) cleanedTitle = cleaned.title
            } catch {
              /* 清洗是增强，失败就用原标题继续 */
            }
            if (seq !== seqRef.current) return
            const insight = await generateTrackInsight({
              settings: config,
              track: { id: track.id, title: cleanedTitle, artist: track.artist },
            })
            if (seq !== seqRef.current) return
            updateTurn(turnId, {
              status: 'done',
              text: text || `说说《${cleanedTitle}》。`,
              payload: { kind: 'explain', insight },
            })
          } catch (err) {
            if (seq !== seqRef.current) return
            updateTurn(turnId, { status: 'done', text: '这首歌我没能解析出来。', notice: err instanceof Error ? err.message : String(err) })
          }
          return
        }

        case 'control': {
          if (!player.currentTrack) {
            updateTurn(turnId, { status: 'done', text: '现在没有在播放，先挑一首歌吧。' })
            return
          }
          const action = plan.action
          if (!action) {
            updateTurn(turnId, { status: 'done', text: '要我做什么？', payload: { kind: 'candidates', actions: true } })
            return
          }
          applyControl(action)
          updateTurn(turnId, { status: 'done', text: text || controlDoneText(action) })
          return
        }

        default: {
          // 服务层已保证 unknown 走不到这里；兜底仍给改选引导，不静默
          updateTurn(turnId, { status: 'done', text: UNKNOWN_REPLY, payload: { kind: 'candidates', actions: false } })
        }
      }

      function applyControl(action: 'play' | 'pause' | 'next' | 'prev') {
        /*
         * play / pause 都用 togglePlay，但先按当前状态判一次：
         * 用户说「播放」时如果已经在播，再 toggle 就成了暂停——那不是他要的。
         */
        if (action === 'play') {
          if (!player.isPlaying) player.togglePlay()
        } else if (action === 'pause') {
          if (player.isPlaying) player.togglePlay()
        } else if (action === 'next') {
          player.next()
        } else {
          player.prev()
        }
      }

      function controlDoneText(action: 'play' | 'pause' | 'next' | 'prev'): string {
        if (action === 'play') return '开始播放。'
        if (action === 'pause') return '已暂停。'
        if (action === 'next') return '切到下一首。'
        return '回到上一首。'
      }
    },
    [player, settings, updateTurn],
  )

  /** 提交一句话：先「正在理解…」，再按意图分发 */
  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text) return
      setInput('')

      const seq = ++seqRef.current
      const userTurnId = ++turnIdRef.current
      const replyTurnId = ++turnIdRef.current
      setTurns((prev) => [
        ...prev,
        { id: userTurnId, role: 'user', text },
        { id: replyTurnId, role: 'assistant', text: '正在理解…', status: 'understanding' },
      ])
      setPending(true)

      const config = await loadConfig()
      if (seq !== seqRef.current) return
      if (!config || !isAiConfigured(config)) {
        // 未配置：给指引而不是报错，入口保持可用
        setPending(false)
        updateTurn(replyTurnId, {
          status: 'done',
          text: '还没有配置 AI，我暂时听不懂你说的话。',
          notice: isAiSupported()
            ? '到「设置 → AI 助手」填入地址、模型与密钥后就能用了。'
            : 'AI 需要桌面端主进程支持，当前环境未加载桌面桥。',
          needConfig: true,
        })
        return
      }

      let plan: AssistantPlan
      try {
        plan = await planAssistantRequest(
          {
            text,
            currentTrack: player.currentTrack
              ? { title: player.currentTrack.title, artist: player.currentTrack.artist }
              : null,
            timeLabel: timeContext().label,
          },
          config,
        )
      } finally {
        if (seq === seqRef.current) setPending(false)
      }
      if (seq !== seqRef.current) return

      const unsure = plan.intent === 'unknown' || plan.confidence < CONFIDENCE_FLOOR
      if (unsure) {
        /*
         * 不静默失败也不硬猜：把「我猜你想干嘛」说出来，并给可点的候选。
         * unknown 直接用服务层的统一措辞，避免两处文案漂移。
         */
        const guess = plan.intent === 'unknown' ? '' : INTENT_LABELS[plan.intent]
        updateTurn(replyTurnId, {
          status: 'done',
          text: guess
            ? `没太听懂。我猜你想「${guess}」，点一下确认，或者直接说个场景。`
            : plan.reply || UNKNOWN_REPLY,
          payload: { kind: 'candidates', actions: false },
        })
        return
      }

      await runPlan(plan, seq, replyTurnId, config)
    },
    [loadConfig, player.currentTrack, runPlan, updateTurn],
  )

  /** 用户改选意图：跳过模型，直接按所选意图执行（confidence 视为确定） */
  const pickIntent = useCallback(
    (turnId: number, intent: ActionableIntent) => {
      const seq = ++seqRef.current
      if (intent === 'control') {
        updateTurn(turnId, { status: 'done', text: '要我做什么？', payload: { kind: 'candidates', actions: true } })
        return
      }
      const plan: AssistantPlan = { intent, reply: '', confidence: 1 }
      setPending(true)
      void (async () => {
        const config = await loadConfig()
        if (seq !== seqRef.current) return
        if (!config || !isAiConfigured(config)) {
          setPending(false)
          updateTurn(turnId, { status: 'done', text: '还没有配置 AI。', needConfig: true })
          return
        }
        updateTurn(turnId, { status: 'working', text: '好，这就去…' })
        try {
          await runPlan(plan, seq, turnId, config)
        } finally {
          if (seq === seqRef.current) setPending(false)
        }
      })()
    },
    [loadConfig, runPlan, updateTurn],
  )

  /** 候选里的四个播放动作：直接执行，不再问模型 */
  const runControl = useCallback(
    (turnId: number, action: 'play' | 'pause' | 'next' | 'prev') => {
      seqRef.current += 1
      if (!player.currentTrack) {
        updateTurn(turnId, { status: 'done', text: '现在没有在播放，先挑一首歌吧。', payload: undefined })
        return
      }
      if (action === 'play') {
        if (!player.isPlaying) player.togglePlay()
      } else if (action === 'pause') {
        if (player.isPlaying) player.togglePlay()
      } else if (action === 'next') {
        player.next()
      } else {
        player.prev()
      }
      const done = action === 'play' ? '开始播放。' : action === 'pause' ? '已暂停。' : action === 'next' ? '切到下一首。' : '回到上一首。'
      updateTurn(turnId, { status: 'done', text: done, payload: undefined })
    },
    [player, updateTurn],
  )

  /** 保存生成的歌单：先确认（原生对话框），没有该能力就直接存 */
  const savePlaylist = useCallback(
    async (turnId: number, result: AiPlaylistResult) => {
      const ask = platform.nativeDialog?.confirm
      if (ask) {
        const ok = await ask({
          message: '保存这个歌单？',
          detail: `「${result.name}」共 ${result.tracks.length} 首，会加入你的歌单列表。`,
        })
        if (!ok) return
      }
      try {
        saveAiPlaylist(result)
        updateTurn(turnId, { payload: { kind: 'playlist', result, saved: true }, notice: '' })
      } catch (err) {
        updateTurn(turnId, { notice: err instanceof Error ? err.message : String(err) })
      }
    },
    [updateTurn],
  )

  /** 取消在途请求：自增序号即可作废，晚到的结果不会回写 */
  const cancel = useCallback(() => {
    seqRef.current += 1
    setPending(false)
    setTurns((prev) =>
      prev.map((t) =>
        t.status === 'understanding' || t.status === 'working'
          ? { ...t, status: 'done' as TurnStatus, text: '已取消。', payload: undefined }
          : t,
      ),
    )
  }, [])

  const clearLog = useCallback(() => {
    seqRef.current += 1
    setPending(false)
    setTurns([])
  }, [])

  return (
    <div className="ai-chat ai-chat--body">
      {/*
        标题由抽屉头承担（ai-sheet__head），这里只留「清空」——
        同一个标题出现两次会让抽屉显得像两层嵌套的弹窗。
      */}
      <div className="ai-chat__head">
        <p className="ai-chat__sub">
          用一句人话说你想听什么、想干什么，助手会去调对应的功能。
        </p>
        {turns.length > 0 && (
          <button type="button" className="ai-chat__ghost" onClick={clearLog} aria-label="清空对话记录">
            <Trash2 size={14} aria-hidden="true" />
            清空
          </button>
        )}
      </div>

      <form
        className="ai-chat__form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(input)
        }}
      >
        <input
          className="ai-chat__input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="比如：来点适合跑步的"
          aria-label="用一句话告诉助手你想听什么"
          maxLength={200}
        />
        <button type="submit" className="ai-chat__send" disabled={!input.trim()} aria-label="发送这句话">
          <Send size={16} aria-hidden="true" />
          发送
        </button>
        {pending && (
          <button type="button" className="ai-chat__ghost" onClick={cancel} aria-label="取消这次请求">
            取消
          </button>
        )}
      </form>

      {turns.length === 0 && (
        <div className="ai-chat__quick">
          {QUICK_PROMPTS.map((p) => (
            <button key={p} type="button" className="ai-chat__chip" onClick={() => void submit(p)}>
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="ai-chat__log" ref={logRef} aria-live="polite">
        {turns.map((turn) => {
          /*
           * 先把 payload 提到局部变量：JSX 里有多层闭包（map 回调），
           * 直接写 turn.payload?.kind 收窄会在回调内失效。
           */
          const payload = turn.payload
          return (
          <div key={turn.id} className={`ai-chat__turn ai-chat__turn--${turn.role}`}>
            <div className="ai-chat__bubble">
              <span className="ai-chat__text">{turn.text}</span>

              {/* 状态用文字说明，不靠颜色区分 */}
              {turn.status === 'understanding' && (
                <span className="ai-chat__status" role="status">
                  <Loader2 size={13} className="ai-chat__spin" aria-hidden="true" />
                  正在理解…
                </span>
              )}
              {turn.status === 'working' && (
                <span className="ai-chat__status" role="status">
                  <Loader2 size={13} className="ai-chat__spin" aria-hidden="true" />
                  处理中…
                </span>
              )}

              {turn.notice && <span className="ai-chat__notice">{turn.notice}</span>}
              {turn.needConfig && (
                <button
                  type="button"
                  className="ai-chat__chip"
                  onClick={() => navigate('/settings')}
                  aria-label="前往设置页配置 AI"
                >
                  去设置
                </button>
              )}

              {payload?.kind === 'recommend' && (
                <ul className="ai-chat__list">
                  {payload.tracks.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="ai-chat__item"
                        onClick={() => player.playNow(t)}
                        aria-label={`播放 ${t.title}`}
                      >
                        <span className="ai-chat__item-title">{t.title}</span>
                        <span className="ai-chat__item-sub">{t.artist || '未知 UP 主'}</span>
                        {payload.reasons[t.id] && <span className="ai-chat__reason">{payload.reasons[t.id]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {payload?.kind === 'search' && (
                <ul className="ai-chat__list">
                  {payload.items.map((item) => (
                    <li key={item.bvid}>
                      <button
                        type="button"
                        className="ai-chat__item"
                        onClick={() => player.playNow(searchItemToTrack(item))}
                        aria-label={`播放 ${item.title}`}
                      >
                        <span className="ai-chat__item-title">{item.title}</span>
                        <span className="ai-chat__item-sub">{item.author}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {payload?.kind === 'playlist' && (
                <div className="ai-chat__playlist">
                  <strong>{payload.result.name}</strong>
                  {payload.result.description && (
                    <span className="ai-chat__item-sub">{payload.result.description}</span>
                  )}
                  <ul className="ai-chat__list">
                    {payload.result.tracks.map((t) => (
                      <li key={t.id}>
                        <button
                          type="button"
                          className="ai-chat__item"
                          onClick={() => player.playNow(t)}
                          aria-label={`播放 ${t.title}`}
                        >
                          <span className="ai-chat__item-title">{t.title}</span>
                          <span className="ai-chat__item-sub">{t.artist || '未知 UP 主'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {payload.saved ? (
                    <span className="ai-chat__notice">已保存到歌单列表。</span>
                  ) : (
                    <button
                      type="button"
                      className="ai-chat__chip"
                      onClick={() => void savePlaylist(turn.id, payload.result)}
                      aria-label={`保存歌单 ${payload.result.name}`}
                    >
                      保存歌单
                    </button>
                  )}
                </div>
              )}

              {payload?.kind === 'explain' && (
                <dl className="ai-chat__insight">
                  <div>
                    <dt>风格</dt>
                    <dd>{payload.insight.style || '说不准'}</dd>
                  </div>
                  <div>
                    <dt>情绪</dt>
                    <dd>{payload.insight.mood || '说不准'}</dd>
                  </div>
                  <div>
                    <dt>适合</dt>
                    <dd>{payload.insight.scene || '说不准'}</dd>
                  </div>
                </dl>
              )}

              {payload?.kind === 'candidates' && (
                <div className="ai-chat__candidates">
                  {payload.actions
                    ? CONTROL_ACTIONS.map((c) => (
                        <button
                          key={c.action}
                          type="button"
                          className="ai-chat__chip"
                          onClick={() => runControl(turn.id, c.action)}
                          aria-label={`播放控制：${c.label}`}
                        >
                          {c.label}
                        </button>
                      ))
                    : INTENT_ORDER.map((intent) => (
                        <button
                          key={intent}
                          type="button"
                          className="ai-chat__chip"
                          onClick={() => pickIntent(turn.id, intent)}
                          aria-label={`改为${INTENT_LABELS[intent]}`}
                        >
                          {INTENT_LABELS[intent]}
                        </button>
                      ))}
                </div>
              )}
            </div>
          </div>
          )
        })}
      </div>
    </div>
  )
}

interface SheetProps {
  /** 抽屉开关；由「为你推荐」标题行上的按钮控制 */
  open: boolean
  onClose: () => void
}

/**
 * 入口按钮（v1.4.14-pre8 用户第 4 项）。
 *
 * 只出按钮，摆位交给调用方——「为你推荐」标题行右侧是它该在的地方。
 * 拆成独立组件是为了让调用方能在推荐板块整块不渲染时（AI 不可用 /
 * 推荐方式为 off）仍然把这个入口留在页面上。
 */
export function AiChatSheetButton({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      className="discover-ai__btn ai-chat__entry"
      onClick={() => onOpenChange(true)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="打开对话式音乐助手"
    >
      <MessageCircle size={14} aria-hidden="true" />
      和助手说句话
    </button>
  )
}

/**
 * 抽屉外壳（v1.4.14-pre8 用户第 4 项）。
 *
 * 复用项目既有的 ai-sheet__* 范式：点遮罩关闭、Esc 关闭、打开时焦点进输入框。
 *
 * 关闭时对话本体**完全不挂载**——这是「把焦点还给推荐」的硬保证：
 * 页面初始加载时 DOM 里根本没有助手的输入框，也就无从抢焦点或占位。
 */
export function AiChatSheet({ open, onClose }: SheetProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null)

  // Esc 关闭：抽屉的通用预期，不依赖鼠标
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /*
   * 打开后把焦点交给输入框：用户点「和助手说句话」就是想马上说，
   * 让焦点落在对话面板外会白白多一次点击。
   * 关闭时不主动把焦点送回按钮——浏览器会回退到触发元素，够用且不打断。
   */
  useEffect(() => {
    if (!open) return
    const input = sheetRef.current?.querySelector<HTMLInputElement>('.ai-chat__input')
    input?.focus()
  }, [open])

  if (!open) return null

  return (
    <div className="ai-sheet-overlay ai-chat-sheet__overlay" onClick={onClose}>
      <div
        className="ai-sheet ai-chat-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="对话式音乐助手"
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-sheet__head">
          <div className="ai-chat__title">
            <MessageCircle size={18} aria-hidden="true" />
            <strong>和助手说句话</strong>
            <Sparkles size={13} aria-hidden="true" />
          </div>
          <button type="button" className="ai-sheet__close" onClick={onClose} aria-label="关闭对话助手">
            ×
          </button>
        </div>
        <div className="ai-sheet__body ai-chat-sheet__body">
          <AiChatBody />
        </div>
      </div>
    </div>
  )
}

/**
 * 默认导出：按钮 + 抽屉的一体化组合，自带开关状态。
 *
 * 给「只想在原位放一个入口」的调用方用；需要把按钮摆进别人的标题行时，
 * 直接用上面的 AiChatSheetButton + AiChatSheet 两个具名导出共享同一份状态。
 */
export default function AiChatAssistant() {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <AiChatSheetButton open={open} onOpenChange={setOpen} />
      <AiChatSheet open={open} onClose={close} />
    </>
  )
}

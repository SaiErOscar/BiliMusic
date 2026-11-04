/**
 * v1.4.14-pre9 对话 UI · 多步会话状态流转测试。
 *
 * 与 tests/aiChatUi.test.ts 分工不同：
 * - 那边守的是「源码里有没有某个分支 / 调用」的结构契约（读源码字符串）；
 * - 这边**真的调用**组件导出的纯函数，断言状态流转本身：
 *   缺参数→反问、回答→合并、齐了→执行、危险动作→确认卡片。
 *
 * 组件本体依赖 PlayerProvider 与网络，整棵渲染成本高且不可控，
 * 所以多步逻辑刻意抽成纯函数（startAssistantAction / answerAssistantAction /
 * buildExecuteContext / describeCreatePlaylist），在这里被直接断言。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  startAssistantAction,
  answerAssistantAction,
  isUnparsedAnswer,
  describeCreatePlaylist,
  describeChoice,
  buildExecuteContext,
  describeExecuteResult,
} from '../src/components/AiChatAssistant'
import { CREATE_PLAYLIST_KEY, type PendingAction } from '../src/services/assistantSession'
import { getAssistantAction } from '../src/services/assistantActions'
import type { AssistantPlayer } from '../src/services/assistantExecutor'
import type { AssistantPlan } from '../src/services/aiChatAssistant'

const read = (rel: string) =>
  readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

const chatSrc = read('../src/components/AiChatAssistant.tsx')

/** 两个歌单的固定上下文，与执行器测试同构 */
const PLAYLISTS = [
  { id: 'pl-1', name: '跑步歌单' },
  { id: 'pl-2', name: '夜跑' },
]
const CTX = { playlists: PLAYLISTS }

/** 造一个 plan：只关心 actionId 与 params */
function plan(actionId: string, params?: Record<string, unknown>): Pick<AssistantPlan, 'actionId' | 'params'> {
  return params ? { actionId, params } : { actionId }
}

describe('多步会话 · 缺参数时反问并给选项', () => {
  it('「添加至歌单」缺歌单 → ask，且问题里列出已有歌单', () => {
    // playlist.add-track 需要 track + playlist；只给了 track，缺 playlist
    const step = startAssistantAction(plan('playlist.add-track', { track: '夜跑' }), CTX)
    expect(step.kind).toBe('ask')
    if (step.kind !== 'ask') throw new Error('unreachable')

    expect(step.pending.actionId).toBe('playlist.add-track')
    expect(step.pending.missing).toEqual(['playlist'])
    expect(step.pending.question).toContain('添加到哪个歌单')
    // 问题里点名已有歌单，用户才知道能说什么
    expect(step.pending.question).toContain('跑步歌单')
    expect(step.pending.question).toContain('夜跑')
  })

  it('ask 的 choices 就是现有歌单，可渲染成按钮', () => {
    const step = startAssistantAction(plan('playlist.add-track', { track: '夜跑' }), CTX)
    if (step.kind !== 'ask') throw new Error('unreachable')
    expect(step.pending.choices).toEqual([
      { value: 'pl-1', label: '跑步歌单' },
      { value: 'pl-2', label: '夜跑' },
    ])
  })

  it('一个歌单都没有时提示可以新建，而不是给一个空列表', () => {
    const step = startAssistantAction(plan('playlist.add-track', { track: '夜跑' }), { playlists: [] })
    if (step.kind !== 'ask') throw new Error('unreachable')
    expect(step.pending.choices).toBeUndefined()
    expect(step.pending.question).toContain('新建')
  })

  it('actionId 不认识时明确拒绝，不静默也不硬执行', () => {
    const step = startAssistantAction(plan('nope.not-exist'), CTX)
    expect(step.kind).toBe('reject')
    if (step.kind !== 'reject') throw new Error('unreachable')
    expect(step.message).toContain('nope.not-exist')
  })

  it('没有 actionId 时不崩溃，给可读的拒绝', () => {
    const step = startAssistantAction({}, CTX)
    expect(step.kind).toBe('reject')
  })
})

describe('多步会话 · 回答合并后执行', () => {
  /** 先走到「等歌单」这一步 */
  function pendingForPlaylist(): PendingAction {
    const step = startAssistantAction(plan('playlist.add-track', { track: '夜跑' }), CTX)
    if (step.kind !== 'ask') throw new Error('expected ask')
    return step.pending
  }

  it('回答「第二个」→ 参数齐了，准备执行，params 带上歌单 id', () => {
    const step = answerAssistantAction(pendingForPlaylist(), '第二个', CTX)
    expect(step.kind).toBe('run')
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.actionId).toBe('playlist.add-track')
    expect(step.params.playlist).toBe('pl-2')
    // 原本已收集的参数不能丢
    expect(step.params.track).toBe('夜跑')
  })

  it('回答歌单名「我的跑步歌单」→ 也能命中', () => {
    const step = answerAssistantAction(pendingForPlaylist(), '我的跑步歌单', CTX)
    expect(step.kind).toBe('run')
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.params.playlist).toBe('pl-1')
  })

  it('点选项（直接给 label）与手打走同一条路径', () => {
    const byClick = answerAssistantAction(pendingForPlaylist(), '夜跑', CTX)
    const byTyping = answerAssistantAction(pendingForPlaylist(), '夜跑', CTX)
    expect(byClick).toEqual(byTyping)
    expect(byClick.kind).toBe('run')
  })

  it('回答认不出时继续问，并把「没听懂」写进问题', () => {
    const step = answerAssistantAction(pendingForPlaylist(), '随便啦', CTX)
    expect(step.kind).toBe('ask')
    if (step.kind !== 'ask') throw new Error('unreachable')
    expect(step.pending.missing).toEqual(['playlist'])
    expect(isUnparsedAnswer(step.pending)).toBe(true)
  })

  it('没被接住的回答可被识别（供 UI 判断「用户其实换了话题」）', () => {
    const rejected = answerAssistantAction(pendingForPlaylist(), '随便啦', CTX)
    if (rejected.kind !== 'ask') throw new Error('unreachable')
    expect(isUnparsedAnswer(rejected.pending)).toBe(true)

    const normal = pendingForPlaylist()
    expect(isUnparsedAnswer(normal)).toBe(false)
  })

  it('多步：填完一个参数后继续问下一个，最后才执行', () => {
    // 只给 playlist，缺 track
    const first = startAssistantAction(plan('playlist.add-track', { playlist: 'pl-1' }), CTX)
    expect(first.kind).toBe('ask')
    if (first.kind !== 'ask') throw new Error('unreachable')
    expect(first.pending.missing).toEqual(['track'])
    expect(first.pending.question).toContain('哪首歌')

    const second = answerAssistantAction(first.pending, '夜跑', CTX)
    expect(second.kind).toBe('run')
    if (second.kind !== 'run') throw new Error('unreachable')
    expect(second.params).toEqual({ playlist: 'pl-1', track: '夜跑' })
  })
})

describe('多步会话 · 新建歌单走 CREATE_PLAYLIST_KEY', () => {
  it('「新建一个叫夜跑的」→ 打上新建标记，params.playlist 是名字不是 id', () => {
    const pending: PendingAction = {
      actionId: 'playlist.add-track',
      params: { track: '夜跑' },
      missing: ['playlist'],
      question: '要添加到哪个歌单？',
      choices: PLAYLISTS.map(p => ({ value: p.id, label: p.name })),
    }
    const step = answerAssistantAction(pending, '新建一个叫夜跑的', CTX)
    expect(step.kind).toBe('run')
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.params[CREATE_PLAYLIST_KEY]).toBe(true)
    expect(step.params.playlist).toBe('夜跑')
    // 不能是任何已存在的 id——否则执行器会去改已有歌单
    expect(PLAYLISTS.some(p => p.id === step.params.playlist)).toBe(false)
  })

  it('新建意图优先于同名已有歌单的模糊匹配', () => {
    const pending: PendingAction = {
      actionId: 'playlist.add-track',
      params: { track: '夜跑' },
      missing: ['playlist'],
      question: '要添加到哪个歌单？',
      choices: PLAYLISTS.map(p => ({ value: p.id, label: p.name })),
    }
    const step = answerAssistantAction(pending, '新建一个叫夜跑的', CTX)
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.params[CREATE_PLAYLIST_KEY]).toBe(true)
  })

  it('describeCreatePlaylist 让「将新建」在执行前就可见', () => {
    expect(describeCreatePlaylist({ playlist: '夜跑', [CREATE_PLAYLIST_KEY]: true })).toBe('将新建歌单「夜跑」')
  })

  it('不是新建时不显示预告（普通加歌单不该说「将新建」）', () => {
    expect(describeCreatePlaylist({ playlist: 'pl-2' })).toBeNull()
    expect(describeCreatePlaylist({})).toBeNull()
    // 标记为 true 但名字是空的不算
    expect(describeCreatePlaylist({ playlist: '  ', [CREATE_PLAYLIST_KEY]: true })).toBeNull()
  })
})

describe('多步会话 · 参数齐了直接执行', () => {
  it('无参数动作直接 run', () => {
    const step = startAssistantAction(plan('playback.next'), CTX)
    expect(step.kind).toBe('run')
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.actionId).toBe('playback.next')
  })

  it('参数全给齐时直接 run，不再多问一句', () => {
    const step = startAssistantAction(plan('playlist.add-track', { track: '夜跑', playlist: 'pl-2' }), CTX)
    expect(step.kind).toBe('run')
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.params).toEqual({ track: '夜跑', playlist: 'pl-2' })
  })

  it('run 带上的是合并后的参数，不是原始 plan.params 的引用', () => {
    const params = { track: '夜跑', playlist: 'pl-2' }
    const step = startAssistantAction(plan('playlist.add-track', params), CTX)
    if (step.kind !== 'run') throw new Error('unreachable')
    expect(step.params).toEqual(params)
  })

  it('执行结果的成功文案原样展示', () => {
    const view = describeExecuteResult({ ok: true, message: '已添加到歌单「夜跑」。' })
    expect(view.text).toBe('已添加到歌单「夜跑」。')
    expect(view.notice).toBeUndefined()
  })

  it('执行失败时正文与原因分开，原因不吞掉', () => {
    const view = describeExecuteResult({ ok: false, message: '没找到歌单「X」。', error: '没找到歌单「X」。' })
    expect(view.text).toBe('没找到歌单「X」。')
    expect(view.notice).toBe('没找到歌单「X」。')
  })

  it('执行器只回错误码没回正文时也有可读文案', () => {
    const view = describeExecuteResult({ ok: false, message: '' })
    expect(view.text).toBe('这个动作没做成。')
  })
})

describe('多步会话 · 危险动作先出确认卡片', () => {
  it('playlist.delete 在注册表里是 confirm 级', () => {
    const action = getAssistantAction('playlist.delete')
    expect(action?.risk).toBe('confirm')
  })

  it('export.mv-single 在注册表里是 confirm 级', () => {
    const action = getAssistantAction('export.mv-single')
    expect(action?.risk).toBe('confirm')
  })

  it('参数齐了的 confirm 动作也走 run——是否确认由执行器判定，UI 不抢跑', () => {
    // 关键设计：UI 不在参数齐了就自己弹确认框，而是先交给执行器，
    // 由它返回 needsConfirm 才出卡片（执行器是风险的唯一权威）。
    const step = startAssistantAction(plan('playlist.delete', { playlist: 'pl-2' }), CTX)
    expect(step.kind).toBe('run')
  })

  it('UI 侧真的把 needsConfirm 转成确认卡片，且带 confirmed 才二次调用', () => {
    // 结构断言：这两句是「先问再动手」的落地点
    expect(chatSrc).toContain('result.needsConfirm')
    expect(chatSrc).toContain("payload: { kind: 'confirm', actionId, params }")
    expect(chatSrc).toContain('{ confirmed: true }')
  })

  it('确认卡片是应用内按钮，不用 window.confirm / nativeDialog', () => {
    expect(chatSrc).not.toContain('window.confirm')
    /*
     * 既有「保存 AI 歌单」仍走 nativeDialog（那是另一条链路，不动它），
     * 但多步动作的确认卡片必须是应用内按钮——只切确认卡片那一段来断言。
     */
    const cardAt = chatSrc.indexOf("payload?.kind === 'confirm'")
    expect(cardAt).toBeGreaterThan(-1)
    const confirmBlock = chatSrc.slice(cardAt, chatSrc.indexOf('</div>', chatSrc.indexOf('算了', cardAt)))
    expect(confirmBlock).not.toContain('nativeDialog')
    expect(confirmBlock).toContain('resolveConfirm(turn.id, payload.actionId, payload.params, true)')
    expect(confirmBlock).toContain('resolveConfirm(turn.id, payload.actionId, payload.params, false)')
    expect(chatSrc).toContain('aria-label="确认执行"')
    expect(chatSrc).toContain('aria-label="取消执行"')
  })

  it('取消确认时不产生任何副作用，只回一句「不动」', () => {
    expect(chatSrc).toContain('好，这次不动。')
    const resolveAt = chatSrc.indexOf('const resolveConfirm = useCallback')
    expect(resolveAt).toBeGreaterThan(-1)
    const slice = chatSrc.slice(resolveAt, resolveAt + 900)
    // 未接受时直接返回，不进入 runAction
    expect(slice).toContain('if (!accepted)')
    const rejectBranch = slice.slice(slice.indexOf('if (!accepted)'), slice.indexOf('const seq = ++seqRef.current'))
    expect(rejectBranch).not.toContain('runAction(')
  })
})

describe('多步会话 · 执行上下文组装（两个坑）', () => {
  it('setProgress 来自 usePlayerProgress，被并进 player', () => {
    const calls: number[] = []
    const player: AssistantPlayer = { currentTrack: null, isPlaying: false, queue: [] }
    const progress = { setProgress: (p: number) => { calls.push(p) } }
    const ctx = buildExecuteContext(player, progress, PLAYLISTS)
    expect(ctx.player.setProgress).toBe(progress.setProgress)
    ctx.player.setProgress?.(42)
    expect(calls).toEqual([42])
  })

  it('组件真的同时拿了两个 hook，并把 progress 传给组装函数', () => {
    expect(chatSrc).toContain('const player = usePlayer()')
    expect(chatSrc).toContain('const progress = usePlayerProgress()')
    expect(chatSrc).toContain('buildExecuteContext(')
    // 组装时用的是 progress（不是 player）
    const at = chatSrc.indexOf('const ctx = buildExecuteContext(')
    expect(at).toBeGreaterThan(-1)
    const slice = chatSrc.slice(at, at + 260)
    expect(slice).toContain('progress,')
  })

  it('不覆盖 playbackRate 只读字段，setPlaybackRate 原样透传', () => {
    const setter = (r: number) => { void r }
    const player = { playbackRate: 1.5, setPlaybackRate: setter } as unknown as AssistantPlayer & { playbackRate: number }
    const ctx = buildExecuteContext(player, { setProgress: () => {} }, PLAYLISTS)
    // 只读字段不被改写
    expect((ctx.player as unknown as { playbackRate: number }).playbackRate).toBe(1.5)
    // setter 原样保留（同一个函数引用）
    expect(ctx.player.setPlaybackRate).toBe(setter)
  })

  it('除 setProgress 外不改写任何 player 成员', () => {
    const player: AssistantPlayer = {
      currentTrack: null,
      isPlaying: true,
      volume: 60,
      queue: [],
    }
    const ctx = buildExecuteContext(player, { setProgress: () => {} }, PLAYLISTS)
    expect(ctx.player.isPlaying).toBe(true)
    expect(ctx.player.volume).toBe(60)
    expect(ctx.player.queue).toBe(player.queue)
  })

  it('歌单列表与当前曲目原样带进上下文', () => {
    const ctx = buildExecuteContext({}, { setProgress: () => {} }, PLAYLISTS, { title: '夜跑', artist: 'UP' })
    expect(ctx.playlists).toEqual(PLAYLISTS)
    expect(ctx.currentTrack).toEqual({ title: '夜跑', artist: 'UP' })
  })

  it('没有当前曲目时 currentTrack 是 null，不是 undefined', () => {
    const ctx = buildExecuteContext({}, { setProgress: () => {} }, PLAYLISTS)
    expect(ctx.currentTrack).toBeNull()
  })
})

describe('多步会话 · 选项渲染与状态收尾', () => {
  it('选项带序号，用户能说「第一个」', () => {
    expect(describeChoice(0, '跑步歌单')).toBe('1. 跑步歌单')
    expect(describeChoice(1, '夜跑')).toBe('2. 夜跑')
  })

  it('选项按钮把 label 交回 submit——点与说走同一条路径', () => {
    expect(chatSrc).toContain('onClick={() => void submit(choice.label)}')
  })

  it('取消与清空都会丢掉待办动作，避免下一次输入被误当答案', () => {
    const cancelAt = chatSrc.indexOf('const cancel = useCallback')
    const cancelSlice = chatSrc.slice(cancelAt, chatSrc.indexOf('const clearLog = useCallback'))
    expect(cancelSlice).toContain('setPendingAction(null)')

    const clearAt = chatSrc.indexOf('const clearLog = useCallback')
    const clearSlice = chatSrc.slice(clearAt, clearAt + 200)
    expect(clearSlice).toContain('setPendingAction(null)')
  })

  it('等待回答时提示可以直接打字，不逼用户点按钮', () => {
    expect(chatSrc).toContain('也可以直接打字回答')
  })

  it('多步状态在 UI 层用 useState 持有，不写回服务层', () => {
    expect(chatSrc).toContain('const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)')
    // 服务层是纯函数：这里只调用，不往里存状态
    expect(chatSrc).toContain('nextPendingAction(')
    expect(chatSrc).toContain('mergeAnswer(')
    expect(chatSrc).toContain('isPendingReady(')
  })
})

describe('多步会话 · 原有行为不被破坏', () => {
  it('六种既有意图分支仍在（action 是新增的第七个）', () => {
    for (const intent of ['recommend', 'playlist', 'search', 'explain', 'control', 'action']) {
      expect(chatSrc).toContain("case '" + intent + "':")
    }
    expect(chatSrc).toContain('default:')
  })

  it('取消与序号作废机制原样保留', () => {
    expect(chatSrc).toContain('seq !== seqRef.current')
    expect(chatSrc).toContain('aria-label="取消这次请求"')
  })

  it('低置信改选引导没被改掉', () => {
    expect(chatSrc).toContain('CONFIDENCE_FLOOR = 0.5')
    expect(chatSrc).toContain("plan.intent === 'unknown' || plan.confidence < CONFIDENCE_FLOOR")
  })

  it('不打断播放：没有硬停调用', () => {
    expect(chatSrc).not.toContain('player.pause()')
  })

  it('新增的 ask/confirm 渲染块只在对应 payload 下出现', () => {
    expect(chatSrc).toContain("payload?.kind === 'ask'")
    expect(chatSrc).toContain("payload?.kind === 'confirm'")
  })
})

/**
 * v1.4.14-pre9 验收修正的回归守卫
 *
 * 两处都是独立验收发现的问题：
 * 1. 等待回答时说「取消」被 assistantSession 的 FALSE_WORDS 解析成 false，
 *    对 boolean 设置等于「用户想中止却把设置关掉了」。
 * 2. 语音下载没有走标题清洗（只有 UI 两个入口接了）。
 */
describe('多步等待中的中止与语音下载清洗（v1.4.14-pre9）', () => {
  it('明确的短句中止词被识别', async () => {
    const { isCancelWord } = await import('../src/components/AiChatAssistant')
    for (const w of ['取消', '算了', '不用了', '不做了', '放弃', '停止', '取消吧', '别弄了']) {
      expect(isCancelWord(w)).toBe(true)
    }
  })

  it('带标点或空格的中止词同样识别', async () => {
    const { isCancelWord } = await import('../src/components/AiChatAssistant')
    expect(isCancelWord('  取消  ')).toBe(true)
    expect(isCancelWord('算了。')).toBe(true)
    expect(isCancelWord('不用了！')).toBe(true)
  })

  it('正常指令不被误判成中止', async () => {
    const { isCancelWord } = await import('../src/components/AiChatAssistant')
    // 「取消收藏」是完整指令，不是中止当前动作
    expect(isCancelWord('取消收藏')).toBe(false)
    expect(isCancelWord('取消收藏这首歌')).toBe(false)
    // 回答歌单名 / 序号也不是中止
    expect(isCancelWord('第二个')).toBe(false)
    expect(isCancelWord('跑步歌单')).toBe(false)
    expect(isCancelWord('')).toBe(false)
  })

  it('语音下载路径接入了标题清洗（单曲与批量）', async () => {
    const src = await import('node:fs')
    const code = src.readFileSync('src/services/assistantExecutor.ts', 'utf8')
    // 单曲：download.track 里必须先洗再传
    expect(code).toContain('cleanFilenameForDownload')
    // 批量：整批洗一次，不是每首一次
    expect(code).toContain('cleanFilenamesForDownload')
    // 清洗结果要真的被传进 downloadTrack，而不是洗了却传原标题
    expect(code).toMatch(/const filename = await cleanFilenameForDownload/)
    expect(code).toMatch(/const cleaned = await cleanFilenamesForDownload/)
  })
})


/**
 * v1.4.14-pre9 对话助手 · 多步会话状态机（纯逻辑）。
 *
 * 设计要点：
 * - **无状态**：本模块只提供两个纯函数，会话状态（pendingAction）由 UI 层持有。
 *   服务层 planAssistantRequest 依然是无状态纯函数，UI 记住「上一轮问了什么、
 *   正在完成哪个动作」，把状态作为参数传进来。
 * - **不碰 React、不发请求**：只 import 类型和动作注册表，可被单测完整覆盖。
 * - **两种「齐了」的表达**：nextPendingAction 用 null 表示参数齐了；
 *   mergeAnswer 因为返回类型是 PendingAction，用 missing.length === 0 表示齐了。
 *   两者语义等价，见 isPendingReady。
 */

import { getAssistantAction } from '@/services/assistantActions'
import type { ActionParam, AssistantAction } from '@/services/assistantActions'

/** 会话中待完成的一次动作 */
export interface PendingAction {
  actionId: string
  /** 已收集到的参数 */
  params: Record<string, unknown>
  /** 还缺哪些必填参数 */
  missing: string[]
  /** 上一轮问了什么，供 UI 展示 */
  question: string
  /** 给用户的可选项（如歌单列表），用户可点也可自然语言回答 */
  choices?: { value: string; label: string }[]
}

/** 动作上下文：目前只需要歌单列表，将来要加收藏/下载列表就往这里加 */
export interface ActionContext {
  playlists?: { id: string; name: string }[]
}

/**
 * mergeAnswer 在识别出「新建歌单」意图时写入 params 的标记键。
 * 执行器看到 params[CREATE_PLAYLIST_KEY] === true，就先建歌单再把歌放进去，
 * 而不是把 params.playlist 当成已存在的歌单 id。
 */
export const CREATE_PLAYLIST_KEY = 'createPlaylist'

/* ---------- 内部工具（纯函数） ---------- */

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 「十一」「二十三」这类中文数字转阿拉伯数字；不认识的返回 null */
function chineseToNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  if (token === '十') return 10
  const tenAt = token.indexOf('十')
  if (tenAt >= 0) {
    const high = tenAt === 0 ? 1 : CN_DIGITS[token.slice(0, tenAt)]
    const rest = token.slice(tenAt + 1)
    const low = rest ? CN_DIGITS[rest] : 0
    if (high === undefined || low === undefined) return null
    return high * 10 + low
  }
  const single = CN_DIGITS[token]
  return single === undefined ? null : single
}

/**
 * 解析序号回答：「第二个」「第2个」「2」「二」。
 * 返回 1-based 序号；不是序号回答则返回 null。
 */
export function parseOrdinal(answer: string): number | null {
  const text = answer.trim()
  const withPrefix = text.match(/第\s*([0-9]+|[零一二两三四五六七八九十]+)\s*[个条首项]?/)
  if (withPrefix) return chineseToNumber(withPrefix[1])
  const bare = text.match(/^([0-9]+|[零一二两三四五六七八九十]+)\s*[个条首项]?$/)
  if (bare) return chineseToNumber(bare[1])
  return null
}

/** 去掉中文/英文引号与包裹的括号 */
function stripQuotes(text: string): string {
  return text.replace(/^[「『"'《（(\s]+|[」』"'》）)\s]+$/g, '')
}

function normalize(text: string): string {
  return stripQuotes(text).toLowerCase()
}

/** 从「新建一个叫夜跑的」里抽出歌单名；没有新建意图返回 null */
export function extractCreateName(answer: string): string | null {
  const text = answer.trim()
  if (!/(新建|创建|新开|再建|建一个|加一个|新歌单)/.test(text)) return null

  const named = text.match(/(?:叫|名字是|名字叫|命名为|名称为)\s*[「『"'《]?([^」』"'》，,。.！!？?\s]+)/)
  if (named) {
    const name = stripQuotes(named[1]).replace(/[的了吧呀啊呢]+$/, '').trim()
    if (name) return name
  }

  const stripped = text
    .replace(/(?:新建|创建|新开|再建|建一个|加一个|一个新的|一个|新的)/g, '')
    .replace(/(?:歌单|列表|吧|呀|啊|呢|的|了)/g, '')
    .replace(/[「」『』"'《》（）()，,。.！!？?、\s]/g, '')
  return stripped || null
}

/** 在候选里按 value / label / 包含 匹配，返回下标；匹配不到返回 -1 */
function findChoice(choices: { value: string; label: string }[], answer: string): number {
  const q = normalize(answer)
  if (!q) return -1

  const exact = choices.findIndex(c => c.value.toLowerCase() === q || c.label.toLowerCase() === q)
  if (exact >= 0) return exact

  // 长候选优先，避免「跑步」误命中「跑步歌单」与「夜跑歌单」里较短的那个
  let best = -1
  let bestLen = 0
  choices.forEach((c, i) => {
    const label = c.label.toLowerCase()
    if (q.includes(label) && label.length > bestLen) {
      best = i
      bestLen = label.length
    }
  })
  if (best >= 0) return best

  choices.forEach((c, i) => {
    const label = c.label.toLowerCase()
    if (q.length >= 2 && label.includes(q) && q.length > bestLen) {
      best = i
      bestLen = q.length
    }
  })
  return best
}

const TRUE_WORDS = ['是', '对', '要', '开', '启用', '好', '可以', '行', '嗯', '打开', '开启', 'true', 'yes', 'on']
const FALSE_WORDS = ['不', '否', '关', '别', '取消', '关闭', '停用', '不用', '不要', 'false', 'no', 'off']

/** 把「开 / 关 / 是 / 不要」这类回答收窄成布尔；认不出返回 null */
export function parseBooleanAnswer(answer: string): boolean | null {
  const q = normalize(answer)
  if (!q) return null
  // 先判否：「不要」里含「要」，「不是」里含「是」
  if (FALSE_WORDS.some(w => q.includes(w))) return false
  if (TRUE_WORDS.some(w => q.includes(w))) return true
  return null
}

/** 取回答里的第一个数字（支持小数与负号）；没有返回 null */
export function parseNumberAnswer(answer: string): number | null {
  const m = answer.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

function firstMissing(action: AssistantAction, collected: Record<string, unknown>): string[] {
  return action.params.filter(p => p.required && isBlank(collected[p.name])).map(p => p.name)
}

function choicesFor(param: ActionParam, context: ActionContext): { value: string; label: string }[] | undefined {
  if (param.type === 'playlist') {
    const list = context.playlists
    if (!list?.length) return undefined
    return list.map(p => ({ value: p.id, label: p.name }))
  }
  if (param.type === 'enum' && param.options?.length) return param.options
  return undefined
}

/** 给问题补上「有哪些可选」，让自然语言回答有意义 */
function decorateQuestion(
  base: string,
  param: ActionParam,
  choices: { value: string; label: string }[] | undefined,
): string {
  if (param.type === 'playlist') {
    if (!choices?.length) return `${base}（还没有歌单，可以说「新建一个叫 XX 的」）`
    return `${base}现有歌单：${choices.map(c => c.label).join('、')}（也可以说「新建一个叫 XX 的」）`
  }
  if (param.type === 'enum' && choices?.length) {
    return `${base}可选：${choices.map(c => c.label).join(' / ')}`
  }
  return base
}

/* ---------- 对外的两个纯函数 ---------- */

/**
 * 纯函数：给定动作 + 已有参数，算出还缺什么、该问什么。
 * 返回 null 表示必填参数齐了，可以执行。
 */
export function nextPendingAction(
  action: AssistantAction,
  collected: Record<string, unknown>,
  context: ActionContext,
): PendingAction | null {
  const missing = firstMissing(action, collected)
  if (missing.length === 0) return null

  const param = action.params.find(p => p.name === missing[0])
  const choices = param ? choicesFor(param, context) : undefined
  const base = action.askFor?.(missing) ?? `${action.label}还需要补充信息，请说清楚。`
  const question = param ? decorateQuestion(base, param, choices) : base

  const pending: PendingAction = {
    actionId: action.id,
    params: { ...collected },
    missing,
    question,
  }
  if (choices?.length) pending.choices = choices
  return pending
}

/** mergeAnswer 合并完成后，missing 为空即代表可以执行（与 nextPendingAction 返回 null 等价） */
export function isPendingReady(pending: PendingAction): boolean {
  return pending.missing.length === 0
}

/** 回答匹配不上时，保留原 missing，只把提示写进 question */
function reject(pending: PendingAction, answer: string): PendingAction {
  return { ...pending, question: `没听懂「${answer}」。${pending.question}` }
}

/**
 * 把用户对上一个问题的回答合并进参数（自然语言，如「第二个」「我的跑步歌单」「新建一个叫夜跑的」）。
 *
 * 支持的回答形态：
 * - 序号：「第二个」「第2个」「2」「二」
 * - 名称：「跑步歌单」、点选项（value 或 label 都行）
 * - 新建意图：「新建一个叫夜跑的」→ params.playlist 存名字，并置 createPlaylist 标记
 * 匹配不到时保持 missing 与 params 不变，question 前面加一句「没听懂」。
 */
export function mergeAnswer(pending: PendingAction, answer: string, context: ActionContext): PendingAction {
  const trimmed = answer.trim()
  if (!trimmed) return reject(pending, answer)
  if (pending.missing.length === 0) return pending

  const action = getAssistantAction(pending.actionId)
  if (!action) return reject(pending, answer)

  const missingName = pending.missing[0]
  const param = action.params.find(p => p.name === missingName)
  if (!param) return reject(pending, answer)

  const choices = pending.choices ?? choicesFor(param, context)
  const params: Record<string, unknown> = { ...pending.params }

  const commit = (value: unknown, extra?: Record<string, unknown>) => {
    params[missingName] = value
    if (extra) Object.assign(params, extra)
    const next = nextPendingAction(action, params, context)
    if (next) return next
    // 参数齐了：保留原 params，missing 清空，question 清空
    return { actionId: action.id, params, missing: [], question: '' }
  }

  if (param.type === 'playlist') {
    const list = context.playlists ?? []

    // 1. 名字/id 精确命中
    const exact = list.find(p => p.id === trimmed || p.name === trimmed)
    if (exact) return commit(exact.id)

    // 2. 序号
    const ordinal = parseOrdinal(trimmed)
    if (ordinal !== null && ordinal >= 1 && ordinal <= list.length) return commit(list[ordinal - 1].id)

    // 3. 新建意图
    const created = extractCreateName(trimmed)
    if (created) return commit(created, { [CREATE_PLAYLIST_KEY]: true })

    // 4. 模糊包含
    const fuzzy = findChoice(list.map(p => ({ value: p.id, label: p.name })), trimmed)
    if (fuzzy >= 0) return commit(list[fuzzy].id)

    return reject(pending, answer)
  }

  if (param.type === 'enum') {
    const options = param.options ?? []
    const exact = options.findIndex(o => o.value.toLowerCase() === normalize(trimmed) || o.label.toLowerCase() === normalize(trimmed))
    if (exact >= 0) return commit(options[exact].value)

    const ordinal = parseOrdinal(trimmed)
    if (ordinal !== null && ordinal >= 1 && ordinal <= options.length) return commit(options[ordinal - 1].value)

    const fuzzy = findChoice(options, trimmed)
    if (fuzzy >= 0) return commit(options[fuzzy].value)

    return reject(pending, answer)
  }

  if (param.type === 'boolean') {
    const value = parseBooleanAnswer(trimmed)
    if (value === null) return reject(pending, answer)
    return commit(value)
  }

  if (param.type === 'number') {
    const value = parseNumberAnswer(trimmed)
    if (value === null) return reject(pending, answer)
    return commit(value)
  }

  // 'string' 与 'track'：原文即可（track 的执行器自己去做搜索/匹配）
  if (param.type === 'track' && choices?.length) {
    const ordinal = parseOrdinal(trimmed)
    if (ordinal !== null && ordinal >= 1 && ordinal <= choices.length) return commit(choices[ordinal - 1].value)
    const picked = findChoice(choices, trimmed)
    if (picked >= 0) return commit(choices[picked].value)
  }

  return commit(stripQuotes(trimmed))
}

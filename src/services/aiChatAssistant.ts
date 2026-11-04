/**
 * v1.4.14-pre5 对话式音乐助手 · 意图引擎。
 *
 * 把用户的一句自然语言（「来点适合跑步的」「推荐点像刚才那首的」「帮我做个写作业听的歌单」）
 * 解析成结构化意图，供对话 UI 决定下一步动作（推荐 / 歌单 / 搜索 / 解释 / 播放控制）。
 *
 * 设计要点：
 * - **本模块只做「听懂」，不做「执行」**：不发推荐请求、不建歌单、不碰播放器。
 *   UI 拿到 AssistantPlan 后自己调 aiRecommend / aiPlaylist / 搜索 / 播放控制。
 *   这样意图解析可以纯逻辑单测，也避免把五个下游的副作用缠在一起。
 * - **提示词构造与解析都是导出的纯函数**（buildPlanMessages / parsePlan），
 *   单测断言提示词约束与容错行为，不必真发请求。
 * - **绝不抛错**：UI 是对话流，用户发一句话就崩掉整个界面是最坏的结果。
 *   任何异常（网络、401、模型胡言乱语）都收敛成 intent:'unknown' 的可用结果。
 * - **不许编造偏好**：模型只许转写用户说过的内容，不许替用户「补全」跑步=燃脂、
 *   写作业=钢琴曲这类它自己想的偏好——那会让用户觉得助手在瞎猜。
 * - **指代消解**：「像这首」「刚才那首」必须落到 currentTrack 上；
 *   currentTrack 为空时，宁可在 reply 里问一句，也不许编一个曲名出来。
 * - **动作识别（v1.4.14-pre9）**：除六个高层意图外，还能识别 assistantActions 注册表里的
 *   具体动作（intent:'action' + actionId + params）。actionId 必须命中注册表，参数按
 *   ActionParam 收窄——不合法的参数丢弃而不是猜，因为猜错的值比缺参数更难收拾。
 */

import { aiChat, type AiChatMessage } from '@/services/ai'
import { getAssistantAction, renderActionsForPrompt } from '@/services/assistantActions'
import type { ActionParam, AssistantAction } from '@/services/assistantActions'
import type { AiSettings } from '@/types'

/** 用户意图类型 */
export type AssistantIntent =
  | 'recommend'      // 推荐几首歌
  | 'playlist'       // 生成歌单
  | 'search'         // 搜索 B 站
  | 'explain'        // 解释某首歌/某个概念
  | 'control'        // 播放控制（播放/暂停/下一首）
  | 'action'         // 识别到注册表里的具体动作（配合 actionId / params）
  | 'unknown'        // 无法判断

export interface AssistantRequest {
  /** 原始用户输入 */
  text: string
  /** 当前播放的曲目（可能为空），供「像这首」「刚才那首」等指代消解 */
  currentTrack?: { title: string; artist: string } | null
  /** 当前时段标签，如「晚上」 */
  timeLabel?: string
}

export interface AssistantPlan {
  intent: AssistantIntent
  /** 给用户看的回应（一两句，说人话） */
  reply: string
  /** recommend/playlist 时：补充给下游的偏好描述，如「适合跑步，节奏快」 */
  mood?: string
  /** search 时：搜索关键词 */
  query?: string
  /** explain 时：要解释的对象 */
  subject?: string
  /** control 时：具体动作 */
  action?: 'play' | 'pause' | 'next' | 'prev'
  /** intent==='action' 时：注册表里的动作 id，如 'playlist.add-track' */
  actionId?: string
  /**
   * intent==='action' 时：已按注册表 ActionParam 收窄过的参数。
   * 类型不符或枚举越界的参数**不会出现**在这里（丢弃而非猜测）。
   */
  params?: Record<string, unknown>
  /** 解析置信度 0~1；低于 0.5 时 UI 应显示为「不确定」并允许用户改选 */
  confidence: number
}

/** 七个合法 intent，解析时按此白名单收窄；不在其中的一律 unknown */
export const ASSISTANT_INTENTS: readonly AssistantIntent[] = [
  'recommend',
  'playlist',
  'search',
  'explain',
  'control',
  'action',
  'unknown',
] as const

/** 四个合法播放动作 */
export const ASSISTANT_ACTIONS: readonly ('play' | 'pause' | 'next' | 'prev')[] = [
  'play',
  'pause',
  'next',
  'prev',
] as const

/** 听不懂时的统一回应。抽成常量，UI 与单测都引用同一句，避免两处措辞漂移。 */
export const UNKNOWN_REPLY = '没太听懂，换个说法试试？比如「来点适合跑步的」或者「下一首」。'

/** 各字段的长度上限：模型偶尔会写小作文，截断避免 UI 撑爆 */
const FIELD_MAX = 120
const REPLY_MAX = 200

/** 类型守卫：判断任意值是否落在 intent 白名单里 */
export function isAssistantIntent(value: unknown): value is AssistantIntent {
  return typeof value === 'string' && (ASSISTANT_INTENTS as readonly string[]).includes(value)
}

/** 类型守卫：判断任意值是否落在播放动作白名单里 */
export function isAssistantAction(value: unknown): value is AssistantPlan['action'] {
  return typeof value === 'string' && (ASSISTANT_ACTIONS as readonly string[]).includes(value)
}

/** 兜底的 unknown 结果：所有失败路径都走这里，保证形状统一 */
export function unknownPlan(reply = UNKNOWN_REPLY): AssistantPlan {
  return { intent: 'unknown', reply, confidence: 0 }
}

/** 把任意文本清洗成单行、限长的字段；非字符串返回空串 */
function cleanText(value: unknown, max = FIELD_MAX): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max).trim() : flat
}

/**
 * 把模型的 confidence 夹到 0~1。
 *
 * - 非数字（含 '0.8' 这种字符串、NaN、Infinity）按 0.5：既不当成满分也不当听不懂；
 * - 越界夹紧而不是丢弃：模型写 95（百分制）时夹成 1 比归零更贴近它想表达的确定。
 */
export function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/**
 * 从模型回复里抠出 JSON 对象。
 *
 * 容忍三种常见的「不听话」：代码围栏、前后废话、以及 JSON 里混了前后缀。
 * 抠不出来返回 null——由 parsePlan 收敛成 unknown，这里不抛错。
 */
export function extractJsonObject(reply: string): Record<string, unknown> | null {
  if (typeof reply !== 'string' || !reply.trim()) return null
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/* ---------- 动作参数收窄（v1.4.14-pre9） ---------- */

/** 数值参数的合理区间；越界的数值视为模型口胡，丢弃而不是夹紧 */
const NUMBER_RANGE: Record<string, { min: number; max: number }> = {
  volume: { min: 0, max: 100 },
  rate: { min: 0.5, max: 2 },
  playbackRate: { min: 0.5, max: 2 },
  lyricFontSize: { min: 8, max: 72 },
  lyricFontWeight: { min: 100, max: 900 },
}

/** 字符串参数的长度上限，防止模型把一整段话塞进 query */
const PARAM_STRING_MAX = 120

/**
 * 按注册表的 ActionParam 收窄单个参数值。
 *
 * 返回 `undefined` 表示「这个值不可用」，调用方直接丢弃该参数。
 * **不做任何模糊纠正**：类型不符、枚举越界、数值越界一律丢弃。
 * 理由：猜出来的参数会让执行器做出用户没要求的副作用（比如把音量设成 500），
 * 而缺参数只会让会话多问一句——后者的代价小得多。
 */
function narrowParam(param: ActionParam, value: unknown): unknown {
  switch (param.type) {
    case 'number': {
      // 只接受真正的数字；'80' 这种字符串不当成数字，避免模型把单位也写进来
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      const range = NUMBER_RANGE[param.name]
      if (range && (value < range.min || value > range.max)) return undefined
      return value
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'enum': {
      if (typeof value !== 'string') return undefined
      const hit = param.options?.find(o => o.value === value)
      return hit ? hit.value : undefined
    }
    case 'string':
    case 'track':
    case 'playlist': {
      // track/playlist 在 plan 阶段只保证「是个非空短字符串」，
      // 真正的 id 匹配交给 assistantSession 的 mergeAnswer / 执行器
      const text = cleanText(value, PARAM_STRING_MAX)
      return text || undefined
    }
    default:
      return undefined
  }
}

/**
 * 把模型给的 params 按注册表收窄成一份干净参数表。
 *
 * - 注册表里没有的参数名一律丢弃（模型不许自造参数）；
 * - 单个参数不合法只丢这一个，不影响其它合法参数；
 * - 结果为空对象时返回 undefined，让 plan 上不出现空的 params。
 */
export function narrowActionParams(
  action: AssistantAction,
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const param of action.params) {
    if (!Object.prototype.hasOwnProperty.call(source, param.name)) continue
    const narrowed = narrowParam(param, source[param.name])
    if (narrowed !== undefined) out[param.name] = narrowed
  }

  return Object.keys(out).length ? out : undefined
}

/**
 * 用户这句话里有没有「指代当前播放曲目」的意图。
 *
 * 只认明确的指代词，不做模糊匹配：宁可漏判（模型还能自己填），
 * 也不要把「来点像这首歌那么吵的」误判成需要 currentTrack。
 */
const REFERENCE_WORDS = /这首|这一首|当前这首|现在放的|正在放的|刚才那首|刚刚那首|上一首|这个歌|它/g

export function mentionsCurrentTrack(text: string): boolean {
  return /这首|这一首|当前这首|现在放的|正在放的|刚才那首|刚刚那首|上一首|这个歌|它/.test(text || '')
}

/**
 * 把文本里的指代词替换成真实曲目标签。
 *
 * 用替换而不是整段覆盖，是为了不丢掉用户/模型已经说清的其它信息：
 * 「像刚才那首一样快的」→「像晴天 - 周杰伦一样快的」，既消解了指代又保住了「快」。
 */
export function resolveReference(text: string, trackLabel: string): string {
  if (!text || !trackLabel) return text || ''
  return text.replace(REFERENCE_WORDS, trackLabel)
}

/**
 * 解析模型回复 → AssistantPlan。
 *
 * **永不抛错**：非法 JSON、非法 intent、空对象一律返回 unknown。
 * 这是 UI 稳定性的底线——对话里一次异常就会让用户以为助手挂了。
 *
 * @param reply 模型原文
 * @param request 原始请求（用于指代消解：currentTrack 为空时不许编造曲名）
 */
export function parsePlan(reply: string, request?: AssistantRequest): AssistantPlan {
  const obj = extractJsonObject(reply)
  if (!obj) return unknownPlan()

  const rawIntent = obj.intent
  // intent 不在枚举内（含缺失、拼错、大小写不符）→ unknown，不做模糊纠正
  if (!isAssistantIntent(rawIntent)) return unknownPlan()
  const intent = rawIntent
  if (intent === 'unknown') return unknownPlan(cleanText(obj.reply, REPLY_MAX) || UNKNOWN_REPLY)

  /*
   * 动作识别：actionId 必须真的在注册表里。
   *
   * 模型可能编一个像模像样的 id（'playback.mute'、'playlist.reorder'），
   * 这类 id 执行器查不到，硬塞进 plan 只会让 UI 拿到一个无法分发的动作。
   * 降级成 unknown 是唯一安全的选择——同样不抛错。
   */
  if (intent === 'action') {
    const rawId = obj.actionId
    const action = typeof rawId === 'string' && rawId.trim()
      ? getAssistantAction(rawId.trim())
      : undefined
    if (!action) return unknownPlan(cleanText(obj.reply, REPLY_MAX) || UNKNOWN_REPLY)

    const actionPlan: AssistantPlan = {
      intent: 'action',
      reply: cleanText(obj.reply, REPLY_MAX),
      actionId: action.id,
      confidence: clampConfidence(obj.confidence),
    }
    const params = narrowActionParams(action, obj.params)
    if (params) actionPlan.params = params
    if (!actionPlan.reply) actionPlan.reply = defaultReply(actionPlan)
    return actionPlan
  }

  const current = request?.currentTrack
  const hasCurrent = !!current && !!cleanText(current.title, FIELD_MAX)

  const plan: AssistantPlan = {
    intent,
    reply: cleanText(obj.reply, REPLY_MAX),
    confidence: clampConfidence(obj.confidence),
  }

  const mood = cleanText(obj.mood)
  const query = cleanText(obj.query)
  const subject = cleanText(obj.subject)
  const action = obj.action

  if (mood) plan.mood = mood
  if (query) plan.query = query
  if (subject) plan.subject = subject
  if (isAssistantAction(action)) plan.action = action

  /*
   * 指代消解：用户说「像这首」时，模型常把 subject/mood 写成「像这首」「当前这首」，
   * 或者干脆空着。两种情况都该由本地用 currentTrack 补上，而不是把指代词原样传给下游
   * ——下游拿着「像这首」四个字什么也做不了。
   */
  if (intent === 'explain' || intent === 'recommend' || intent === 'playlist') {
    const title = hasCurrent ? cleanText(current.title, FIELD_MAX) : ''
    const artist = hasCurrent ? cleanText(current.artist, FIELD_MAX) : ''
    const trackLabel = title ? (artist ? title + ' - ' + artist : title) : ''

    // 指代可能出现在用户原话、subject、mood 任一处
    const pointsAtCurrent =
      mentionsCurrentTrack(request?.text || '') ||
      mentionsCurrentTrack(plan.subject || '') ||
      mentionsCurrentTrack(plan.mood || '')

    if (intent === 'explain') {
      if (plan.subject && trackLabel) plan.subject = resolveReference(plan.subject, trackLabel)
      /*
       * 只有「subject 本身是指代词」才算悬空引用。
       * 「晴天这首歌讲什么」里的「这首」是同位语，subject 已经是晴天，
       * 不该因为它出现过指代词就被判成听不懂。
       */
      const subjectIsDangling = !!plan.subject && mentionsCurrentTrack(plan.subject)
      /*
       * 悬空的指代 + 播放器空着：模型这时很可能自己编一个曲名出来
       * （它看到「刚才那首」就会顺着写一个），这种编造用户无从分辨。
       * 宁可回一句「你想让我讲哪首」，也不接受一个没有来源的曲名。
       */
      if (subjectIsDangling && !trackLabel) {
        return unknownPlan('现在没有在放歌，你想让我讲哪首？说个歌名。')
      }
      if (!plan.subject && pointsAtCurrent && trackLabel) plan.subject = trackLabel
      if (!plan.subject && pointsAtCurrent) {
        return unknownPlan('现在没有在放歌，你想让我讲哪首？说个歌名。')
      }
      if (!plan.subject) return unknownPlan('你想让我讲哪首？说个歌名，或者先放一首再问我。')
    } else if (pointsAtCurrent && trackLabel) {
      /*
       * 推荐/歌单：把指代词就地换成真实曲目，模型写的「像这首」不能直接进下游
       * ——下游拿着四个字什么也做不了。用替换而非整段覆盖，是为了留住
       * 用户已经说清的其它限定（「像刚才那首一样快的」里的「快」）。
       */
      if (plan.mood) {
        plan.mood = resolveReference(plan.mood, trackLabel)
      } else {
        plan.mood = '类似 ' + trackLabel + ' 的风格'
      }
      if (!plan.reply) plan.reply = '好，照《' + title + '》的感觉来找。'
    } else if (pointsAtCurrent && !trackLabel) {
      /*
       * 用户指代了当前曲目，但播放器是空的（currentTrack 为 null）。
       * 不编曲名，也不假装听懂了——降置信度并让 UI 有机会追问。
       */
      plan.confidence = Math.min(plan.confidence, 0.3)
      plan.reply = '现在没有在放歌，说个歌名或风格我才能照着找。'
      // 指代词原样留给下游是有害的：删掉，宁可不给偏好也不要给错的
      if (plan.mood && mentionsCurrentTrack(plan.mood)) delete plan.mood
    }
  }

  if (!plan.reply) plan.reply = defaultReply(plan)

  // unknown 的置信度强制 0（此处 intent 已非 unknown，但仍守住契约）
  if (plan.intent === 'unknown') plan.confidence = 0

  return plan
}

/** 模型没给 reply 时的兜底回应：按 intent 说一句人话，不空着让 UI 显示空白 */
function defaultReply(plan: AssistantPlan): string {
  switch (plan.intent) {
    case 'recommend':
      return '好，给你挑几首。'
    case 'playlist':
      return '好，我来攒个歌单。'
    case 'search':
      return plan.query ? '去 B 站搜「' + plan.query + '」。' : '去 B 站找找。'
    case 'explain':
      return plan.subject ? '我看看《' + plan.subject + '》。' : '我看看。'
    case 'control':
      return '好。'
    case 'action': {
      const action = plan.actionId ? getAssistantAction(plan.actionId) : undefined
      return action ? '好，' + action.label + '。' : '好。'
    }
    default:
      return UNKNOWN_REPLY
  }
}

/**
 * 组装意图解析提示词。抽成导出纯函数便于单测断言约束是否写进去了。
 *
 * 三类约束缺一不可：
 * 1. 输出格式（只输出 JSON、字段名固定、intent 七选一）——决定能否解析；
 * 2. 事实纪律（不编造偏好、不替用户补全、指代必须落到给定曲目）——决定解析对不对；
 * 3. 兜底指令（听不懂就 unknown）——决定模型不会硬猜。
 *
 * 另外拼上 renderActionsForPrompt()：动作清单由注册表渲染，
 * 新增动作只要往注册表加一行，这里不用改。
 */
export function buildPlanMessages(input: AssistantRequest): AiChatMessage[] {
  const text = (input.text || '').trim()
  const current = input.currentTrack
  const hasCurrent = !!current && !!(current.title || '').trim()
  const timeLabel = (input.timeLabel || '').trim()

  const system = [
    '你是音乐 App 的对话助手，任务是把用户随口说的一句话，判断成结构化意图。',
    '你只做「听懂」，不做推荐、不生成歌单内容、不解释歌曲。',
    '',
    '输出格式（严格遵守）：',
    '1. 只输出一个 JSON 对象，不要任何解释文字、不要代码围栏、不要前后缀；',
    '2. intent 只能是这七个字符串之一：recommend、playlist、search、explain、control、action、unknown；',
    '   不在其中一律输出 unknown，不要自创意图名；',
    '3. 字段：{"intent":"...","reply":"回应（60 字内）","mood":"偏好描述（可选）","query":"搜索词（可选）",'
      + '"subject":"要解释的对象（可选）","action":"play|pause|next|prev（可选）",'
      + '"actionId":"动作 id（仅 intent 为 action 时）","params":{动作参数（仅 intent 为 action 时）},'
      + '"confidence":0.0到1.0}',
    '4. 与 intent 无关的字段直接省略，不要填 null，也不要填「无」。',
    '',
    '事实纪律（重要）：',
    '5. 不要编造用户没说过的偏好。用户说「跑步」就只写跑步，不要替他补成「燃脂、电子、128BPM」；',
    '6. 不要编造曲名、歌手、歌单名——你不知道用户指的是哪首歌时，就把 intent 设为 unknown；',
    '7. 用户说「像这首」「刚才那首」「当前这首」时，指的是下面给出的「当前播放」；',
    '   当前播放为空时，不要凭空填一个曲名，把 confidence 调低并说明需要歌名；',
    '8. 拿不准就输出 unknown 并把 confidence 调低，硬猜比说不知道更糟。',
    '',
    '各 intent 的判定口径：',
    '- recommend：想要几首歌，但不要求整理成歌单；',
    '- playlist：明确要求「做个歌单」「整理成列表」；',
    '- search：要在 B 站找具体的东西（视频、歌曲、UP 主），query 填搜索词；',
    '- explain：要解释某首歌或某个概念，subject 填对象；',
    '- control：播放控制，只可能是 play、pause、next、prev 四选一；',
    '- action：用户的话对应下面动作清单里的某一条具体动作，',
    '  这时输出 {"intent":"action","actionId":"动作 id","params":{...},"reply":"...","confidence":0.0到1.0}；',
    '  actionId 必须原样取自清单，不许自己拼；params 的键必须出现在该动作的参数列表里，',
    '  类型要对得上（number 就给数字、boolean 就给 true/false、enum 只能取 =a|b|c 里的值）；',
    '  拿不准的参数宁可省略，不要猜一个值填进去——缺了会再问，猜错了就做错事。',
    '',
    renderActionsForPrompt(),
  ].join('\n')

  const userLines = ['用户说：' + text]
  if (hasCurrent) {
    const artist = (current.artist || '').trim()
    userLines.push('当前播放：' + current.title.trim() + (artist ? ' - ' + artist : ''))
  } else {
    userLines.push('当前播放：（无）')
  }
  if (timeLabel) userLines.push('当前时段：' + timeLabel)

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ]
}

/**
 * 解析入口：调一次模型，拿到 plan。
 *
 * 任何失败（空输入、未配置、网络、401、超时、模型返回垃圾）都收敛成 unknown 结果，
 * 不抛错——UI 只需要一个稳定可渲染的 AssistantPlan。
 */
export async function planAssistantRequest(
  input: AssistantRequest,
  settings: AiSettings,
): Promise<AssistantPlan> {
  const text = (input.text || '').trim()
  // 空输入不必花一次请求；直接告诉用户说点什么
  if (!text) return unknownPlan('你想听点什么？说个场景、歌手或歌名都行。')

  try {
    const reply = await aiChat(settings, {
      messages: buildPlanMessages({ ...input, text }),
      // 意图分类要稳定，不需要发散：低温让同一句话尽量得到同一个判定
      temperature: 0.2,
      timeoutMs: 30000,
    })
    return parsePlan(reply, { ...input, text })
  } catch (err) {
    // 配置缺失 / 401 / 超时：说清原因，但仍然是可渲染的结果
    const reason = err instanceof Error ? err.message : String(err)
    return unknownPlan(reason ? '解析没成功（' + reason + '），稍后再试或直接说个歌名。' : UNKNOWN_REPLY)
  }
}

/**
 * 把 plan 渲染成给下游 AI（推荐 / 歌单）用的补充指令文本；无补充时返回空串。
 *
 * 下游是 aiRecommend / aiPlaylist，它们各自已有自己的提示词；
 * 这里只补「用户这句话额外的偏好」，不重复下游已经会做的事。
 */
export function renderPlanHint(plan: AssistantPlan): string {
  const parts: string[] = []
  const mood = (plan.mood || '').trim()
  if (mood) parts.push(mood)
  // search 的 query 对推荐/歌单也有意义：用户想搜的东西本身就是偏好线索
  const query = (plan.query || '').trim()
  if (query && plan.intent === 'search') parts.push('用户想找：' + query)
  const subject = (plan.subject || '').trim()
  if (subject && (plan.intent === 'explain' || plan.intent === 'playlist')) {
    parts.push('围绕：' + subject)
  }
  if (!parts.length) return ''
  return '用户的额外要求：' + parts.join('；') + '。'
}

/**
 * v1.4.12-pre2 发现页 AI 推荐：问候语 + 几首歌曲建议。
 *
 * 设计要点：
 * - **输入三要素**：当前时间（含时段）、所在环境（由时段与本地状态推断，不读系统定位）、
 *   最近听歌状况（听歌画像聚合摘要）+ 用户自述画像（可编辑）。
 * - **只发聚合与自述**：不发逐曲播放明细、不发完整歌单，也不发任何设备或位置标识。
 * - **推荐给的是本地曲库里真实存在的歌**：模型只能从候选池里按编号挑，
 *   与智能歌单同一套「编号映射回 Track」的防幻觉做法。
 * - 返回问候语 + 推荐理由，让板块看起来像「有人打招呼」而不是一张列表。
 */

import { aiChat } from '@/services/ai'
import { summarize, renderSummary } from '@/services/aiPortrait'
import { loadPlayStats } from '@/utils/storage'
import { buildCandidatePool, type AiPlaylistCandidate } from '@/services/aiPlaylist'
import { loadProfileContext, renderExplicitFeedback, type ProfileContext } from '@/services/aiProfileContext'
import { pickExternalTracks, type SelectedCandidate } from '@/services/videoVerify'
import type { AiSettings, Track } from '@/types'


/**
 * v1.4.13-pre4 推荐去重：记录最近几轮推荐过的曲目，喂给模型作为「别再推」清单。
 *
 * 只存本地 sessionStorage：去重是会话内的体感优化，跨重启保留意义不大，
 * 还会让「过一阵再推」永远推不出来。
 */
const RECENT_RECOMMEND_KEY = 'bilimusic_ai_recent_recommended'
const RECENT_RECOMMEND_LIMIT = 40

export function loadRecentlyRecommended(): string[] {
  try {
    const raw = sessionStorage.getItem(RECENT_RECOMMEND_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function rememberRecommended(tracks: { id: string }[]): void {
  try {
    const prev = loadRecentlyRecommended()
    const merged = [...tracks.map((t) => t.id), ...prev.filter((id) => !tracks.some((t) => t.id === id))]
    sessionStorage.setItem(RECENT_RECOMMEND_KEY, JSON.stringify(merged.slice(0, RECENT_RECOMMEND_LIMIT)))
  } catch {
    /* ignore */
  }
}

/**
 * v1.4.14-pre6 池外推荐的验证状态。
 *
 * UI 必须据此给出明确文案：只有 'disabled' 才允许什么都不说。
 * 其余三种都意味着「开关开着，但这一批没有池外结果」，静默会让用户以为开关没生效。
 */
export type ExternalStatus = 'ok' | 'all-rejected' | 'ai-failed' | 'disabled'

export interface AiRecommendation {
  /** 问候语（结合时段与环境，一两句） */
  greeting: string
  /** 推荐曲目（池内；数量与顺序不受池外推荐影响） */
  tracks: Track[]
  /** 每首的推荐理由，key 为 track.id */
  reasons: Record<string, string>
  /** 生成时的时段描述，用于 UI 展示 */
  contextLabel: string
  /**
   * v1.4.14-pre7 池外曲目：歌单/收藏/喜欢之外、经搜索并筛出的条目。
   * 未开启池外推荐、或一条都没筛出时为空数组（此时看 externalStatus）。
   */
  externalTracks?: Track[]
  /** 池外推荐的状态；老调用方没有该字段时按 'disabled' 处理 */
  externalStatus?: ExternalStatus
  /** 搜到但未采用（被 AI 判为不对题或超出条数）的数量，用于 UI 说明 */
  externalRejected?: number
}

/** 把小时映射成中文时段，同时作为「环境推断」的依据 */
export function timeContext(now = new Date()): { label: string; hour: number } {
  const h = now.getHours()
  let label = '深夜'
  if (h >= 5 && h < 9) label = '清晨'
  else if (h >= 9 && h < 12) label = '上午'
  else if (h >= 12 && h < 14) label = '中午'
  else if (h >= 14 && h < 18) label = '下午'
  else if (h >= 18 && h < 23) label = '晚上'
  return { label, hour: h }
}

/**
 * v1.4.14-pre7 池外目标条数：池内条数 × 1.5 向上取整。
 *
 * 多要 50% 是给筛选留余量：搜索能拿回一批候选，但 AI 只会挑其中真正对题的部分，
 * 按 1.5 倍申请、筛选后再截断到池内条数，才可能凑满而不缩水。
 */
export function externalTargetCount(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return Math.ceil(limit * 1.5)
}

/**
 * 从模型回复里取出池外搜索关键词（v1.4.14-pre7）。
 *
 * 模型只负责「描述想找什么」，不负责给 ID——BV 号一律由 B 站搜索接口给出。
 * 这是 pre6 失败的教训：让模型编 BV 号，验证再严也救不回来。
 */
export function parseExternalKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    // 容忍模型把关键词写成对象 {"q": "..."} 或直接写字符串
    const raw = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof (item as { q?: unknown }).q === 'string'
        ? (item as { q: string }).q
        : ''
    const kw = raw.trim()
    if (!kw) continue
    const key = kw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(kw)
  }
  return out
}

/**
 * 从候选池里挑出推荐曲目。
 *
 * 复用智能歌单的候选池（收藏 → 最近播放 → 下载，去重上限 120）。
 * 模型只返回编号，本地映射回真实 Track；编造编号丢弃。
 */
export function parseRecommendation(
  reply: string,
  pool: AiPlaylistCandidate[],
): {
  greeting: string
  picked: { track: Track; reason: string }[]
  /** v1.4.14-pre7 池外搜索关键词；没有该字段时为空数组 */
  externalKeywords: string[]
} {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回可解析的 JSON')
  /*
   * v1.4.14-pre5：与 aiPlaylist 同因——模型可能返回截断 JSON。
   * 原来直接 parse 会让用户看到原生 SyntaxError，现统一为可读中文。
   */
  let obj: { greeting?: unknown; picks?: unknown; externalKeywords?: unknown }
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as {
      greeting?: unknown
      picks?: unknown
      externalKeywords?: unknown
    }
  } catch {
    throw new Error('模型返回的内容不是合法 JSON，请重试')
  }
  const greeting = typeof obj.greeting === 'string' ? obj.greeting.trim() : ''
  const byIndex = new Map(pool.map((c) => [c.index, c.track]))
  const picked: { track: Track; reason: string }[] = []
  const used = new Set<string>()
  if (Array.isArray(obj.picks)) {
    for (const item of obj.picks) {
      if (!item || typeof item !== 'object') continue
      const rec = item as { index?: unknown; reason?: unknown }
      const idx = Number(rec.index)
      if (!Number.isFinite(idx)) continue
      const track = byIndex.get(idx)
      if (!track) continue // 编造编号直接丢弃
      if (used.has(track.id)) continue
      used.add(track.id)
      picked.push({ track, reason: typeof rec.reason === 'string' ? rec.reason.trim() : '' })
    }
  }
  return { greeting, picked, externalKeywords: parseExternalKeywords(obj.externalKeywords) }
}

export interface RecommendInput {
  settings: AiSettings
  /** 最多推荐几首（池内条数；池外目标条数由它 × 1.5 推出） */
  limit?: number
  now?: Date
  /**
   * v1.4.14-pre6 是否额外推荐池外曲目。
   *
   * 缺省 false：老调用方（含所有既有测试）不传该字段时，请求与解析路径
   * 与池外功能上线前完全一致——不发验证请求、不产生任何池外字段。
   */
  external?: boolean
}

/**
 * v1.4.14-pre3 反馈闭环：从候选池里剔除用户明确表示「不感兴趣」的曲目。
 *
 * 判断：**剔除，而不是只靠提示词嘱咐**。
 * - 提示词是软约束，模型完全可能因为「凑够 limit 首」而把被否掉的歌再挑回来；
 *   一旦发生，用户会觉得「点了不感兴趣也没用」，反馈闭环当场失信。
 * - 曲库通常远大于一次推荐的 5 首，剔除十几首不会让池子见底；
 *   万一真的剔到不够（只剩不到 3 首），buildRecommendPrompt 会退回未剔除的池子，
 *   宁可推出用户否过的歌，也不能让「曲库不为空却推荐失败」。
 * 显式喜欢的曲目**不剔除也不加权**：用户已经知道它，重复推荐只是浪费名额；
 * 但把它留在池里作为「口味锚点」交给模型参考，比硬编码加权更稳。
 */
export function excludeDisliked(
  pool: AiPlaylistCandidate[],
  disliked: string[],
): AiPlaylistCandidate[] {
  if (!disliked.length) return pool
  const banned = new Set(disliked)
  const kept = pool.filter((c) => !banned.has(trackKey(c.track)))
  // 剔除后不足以凑一盘时退回原池：宁可有噪音，也不要让推荐直接失败
  if (kept.length < 3) return pool
  // 编号必须重排，否则提示词里的清单会出现跳号，模型容易挑到不存在的编号
  return kept.map((c, i) => ({ track: c.track, index: i + 1 }))
}

/** artist|title 归一化串，与主进程 profile.ts 的 key 口径一致 */
function trackKey(track: { artist?: string; title?: string }): string {
  return (track.artist || '') + '|' + (track.title || '')
}

/** 提示词构造的输入（抽成纯函数，便于单测断言注入内容） */
export interface RecommendPromptInput {
  settings: AiSettings
  limit: number
  contextLabel: string
  hour: number
  profileContext: ProfileContext
  portraitText: string
  hasHistory: boolean
  pool: AiPlaylistCandidate[]
  /**
   * v1.4.14-pre6 池外推荐条数；0（默认）= 不生成池外部分，提示词与旧版逐字一致。
   * 这样「开关关闭时行为完全不变」不是靠调用方自觉，而是提示词本身就不含池外段落。
   */
  externalLimit?: number
}

/** 组装推荐提示词；纯函数，不发请求 */
export function buildRecommendPrompt(input: RecommendPromptInput): {
  system: string
  user: string
} {
  const {
    settings, limit, contextLabel, hour, profileContext, portraitText, hasHistory, pool,
    externalLimit = 0,
  } = input
  const wantsExternal = externalLimit > 0
  const userText = profileContext.profile
  const learned = profileContext.learned
  // v1.4.14-pre3：显式表态单独成段，并带上「必须避开」的行动指令
  const explicit = renderExplicitFeedback(profileContext)

  const persona = (settings.persona || '').trim()
  const personaLine = persona ? '你的说话风格：' + persona : ''

  /*
   * v1.4.14-pre6 池外推荐规则：只在开关打开时追加。
   *
   * 关键是第 8 条——必须把「编造会被校验丢弃」写成明确后果，
   * 否则模型会把 BV 号当占位符随便填，验证器全部丢弃后用户只会看到一条失败提示。
   */
  /*
   * v1.4.14-pre7 池外推荐规则：模型只给**搜索关键词**，不给 BV 号。
   *
   * pre6 让模型直接写 BV 号，实测幻觉严重：BV 号是 B 站内部标识，模型没有可靠来源，
   * 只能编。验证再严也救不回来——大部分候选在存在性那步就死了。
   * 现在改成模型描述「想找什么」，BV 号由搜索接口给出，模型永远碰不到 ID。
   */
  const externalRules = wantsExternal
    ? [
      '5. 候选清单之外，**另外**给 3~5 组搜索关键词，用来在 B 站上找曲库里没有的歌；',
      '6. 关键词要能搜到具体的歌：写成「歌手 歌名」或「风格 场景」，不要写成一句话；',
      '7. **不要给 BV 号，也不要写具体曲名清单**——你只需要描述该找什么样的歌，程序会去搜索；',
      '8. 关键词之间不要重复，覆盖不同角度（如一首具体歌 + 一种风格 + 一个场景）；',
    ]
    : []
  // 输出格式那一条的编号跟着池外规则走，避免出现「5. …9. …5.」这种跳号
  const formatRuleNo = wantsExternal ? 9 : 5

  const jsonFormat = wantsExternal
    ? '{"greeting":"问候语（60 字内）","picks":[{"index":编号,"reason":"一句推荐理由（20 字内）"}],'
      + '"externalKeywords":["搜索关键词1","搜索关键词2"]}'
    : '{"greeting":"问候语（60 字内）","picks":[{"index":编号,"reason":"一句推荐理由（20 字内）"}]}'

  const system = [
    '你是音乐 App 的推荐助手。请像朋友打招呼一样，先写一两句问候，再推荐几首歌。',
    personaLine,
    '严格要求：',
    '1. 只能从候选清单里挑，index 必须是清单中真实存在的数字，不得编造；',
    '2. 推荐 ' + limit + ' 首左右，宁少勿滥；',
    '3. 问候语要结合当前时段与听歌习惯，不要空洞套话，不要「根据数据显示」这类表述；',
    // v1.4.14-pre3：把显式否定升级为硬约束，避免模型为凑数而回捞
    '4. 用户明确表示不感兴趣的曲目一律不得推荐，即使候选清单里还有它们；',
    ...externalRules,
    formatRuleNo + '. 只输出一个 JSON 对象，不要任何解释文字或代码围栏：',
    jsonFormat,
  ]
    .filter(Boolean)
    .join('\n')

  const userLines = [
    '当前时间：' + contextLabel + '（' + hour + ' 点）',
    '用户自述偏好：' + (userText || '（未填写）'),
    learned ? '从使用中观察到的偏好：\n' + learned : '',
    explicit ? '用户的显式反馈（权重最高）：\n' + explicit : '',
    '最近一个月的听歌状况：',
    hasHistory ? portraitText : '（暂无播放记录）',
    '',
    '候选曲目：',
    pool.map((c) => c.index + '. ' + c.track.title + (c.track.artist ? ' - ' + c.track.artist : '')).join('\n'),
  ]
    .filter(Boolean)
    .join('\n')

  return { system, user: userLines }
}

/**
 * 把验证通过的候选转成可播放的 Track。
 *
 * 字段口径与 aiPlaylist 的候选池一致：videoUrl 留空（播放链路按 bvid 取流），
 * playCount / isLiked 置零——池外曲目本来就不在曲库里，没有这两个概念。
 */
function toExternalTrack(candidate: SelectedCandidate): Track {
  return {
    id: 'ext-' + candidate.bvid,
    title: candidate.title,
    artist: candidate.ownerName,
    coverUrl: candidate.coverUrl,
    duration: candidate.duration,
    videoUrl: '',
    bvid: candidate.bvid,
    playCount: 0,
    isLiked: false,
  }
}

/** 生成推荐（不落库、不改任何状态） */
export async function generateRecommendation(input: RecommendInput): Promise<AiRecommendation> {
  const { settings, limit = 5, now = new Date(), external = false } = input
  const externalLimit = external ? externalTargetCount(limit) : 0
  const pool = buildCandidatePool()
  if (!pool.length) throw new Error('曲库为空：先收藏、播放或下载一些歌曲')

  const ctx = timeContext(now)
  const portrait = summarize(loadPlayStats(), 'month')
  const hasHistory = portrait.totalPlays > 0
  // v1.4.13-pre1：画像改读外部文件 + 学习信号，不再从 settings 里取
  // v1.4.14-pre3：同时取显式表态（liked / disliked），既用于剔除候选，也用于提示词
  const profileContext = await loadProfileContext()

  // v1.4.13-pre4 推荐去重：把最近推过的曲目告诉模型，别再推
  const recently = new Set(loadRecentlyRecommended())
  const freshPool = pool.filter((c) => !recently.has(c.track.id))
  const dedupedPool = freshPool.length >= 3 ? freshPool : pool
  // v1.4.14-pre3 反馈闭环：明确「不感兴趣」的曲目先从池子里剔除（理由见 excludeDisliked）
  const usablePool = excludeDisliked(dedupedPool, profileContext.disliked || [])

  const { system, user: userLines } = buildRecommendPrompt({
    settings,
    limit,
    contextLabel: ctx.label,
    hour: ctx.hour,
    profileContext,
    portraitText: hasHistory ? renderSummary(portrait, 'month') : '',
    hasHistory,
    pool: usablePool,
    externalLimit,
  })

  const reply = await aiChat(settings, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userLines },
    ],
    temperature: 0.85,
    timeoutMs: 90000,
  })

  const { greeting, picked, externalKeywords: keywords } = parseRecommendation(reply, usablePool)
  if (!picked.length) throw new Error('模型没有选出可用曲目，稍后再试')

  const reasons: Record<string, string> = {}
  for (const p of picked) if (p.reason) reasons[p.track.id] = p.reason

  /*
   * 给池外筛选用的「用户此刻想要什么」。
   *
   * 不能只传关键词——AI 判断「搜索结果是否对题」时需要知道用户的处境
   * （时段、自述偏好、从使用中观察到的口味），否则它只能凭标题字面猜。
   * 这里拼成一段紧凑描述，与池内推荐用的是同一份上下文。
   */
  const externalIntent = [
    ctx.label + '（' + ctx.hour + ' 点）',
    profileContext.profile ? '自述偏好：' + profileContext.profile : '',
    profileContext.learned ? '观察到的偏好：' + profileContext.learned : '',
  ].filter(Boolean).join('；')

  /*
   * 池内结果先定稿：下面无论池外怎么失败，tracks 的数量与顺序都不受影响。
   * 这是用户明确要求的第一条——池外是「额外」的，不能挤占或重排池内名额。
   */
  const result: AiRecommendation = {
    greeting: greeting || '给你挑了几首，试试看。',
    tracks: picked.map((p) => p.track),
    reasons,
    contextLabel: ctx.label,
  }

  if (!external) {
    /*
     * 关闭时仍然把两个池外字段填成空值，而不是留 undefined：
     * 返回结构对调用方恒定，UI 不必为「开过又关掉」写两套分支。
     * 池内 tracks / reasons 与上线前逐字一致。
     */
    result.externalTracks = []
    result.externalRejected = 0
    result.externalStatus = 'disabled'
    return result
  }

  // 模型一组关键词都没给：同样是「开关开着却没有结果」，必须告知，不能静默
  if (!keywords.length) {
    result.externalTracks = []
    result.externalRejected = 0
    result.externalStatus = 'ai-failed'
    return result
  }

  let externalPick: Awaited<ReturnType<typeof pickExternalTracks>>
  try {
    externalPick = await pickExternalTracks(
      keywords,
      { intent: externalIntent, limit: externalLimit },
      settings,
    )
  } catch (err) {
    /*
     * 搜索/筛选链路本身抛错不能让整次推荐失败：
     * 池内结果已经拿到，用户至少还能看到它；池外如实标记。
     */
    result.externalTracks = []
    result.externalRejected = 0
    result.externalStatus = 'ai-failed'
    if (import.meta.env?.DEV) console.warn('[aiRecommend] 池外搜索失败', err)
    return result
  }

  /*
   * externalRejected 的语义统一为「搜到但没采用」：既包括被 AI 判为不对题的，
   * 也包括超出条数被截掉的。AI 失败时 considered 是搜索到的全部候选、
   * kept 为空，于是它自然等于 considered——表示「这些都没能用」，与 UI 文案一致。
   */
  const kept = externalPick.selected.slice(0, limit)
  result.externalTracks = kept.map(toExternalTrack)
  result.externalRejected = Math.max(0, externalPick.considered - kept.length)

  if (!kept.length) {
    result.externalStatus = externalPick.aiFailed ? 'ai-failed' : 'all-rejected'
    return result
  }

  result.externalStatus = 'ok'
  /*
   * 池外理由用 AI 筛选时给出的原话——它判断「这条是否符合用户意图」时写的理由，
   * 比「标题一致」这类机械说明对用户有信息量。
   */
  const reasonByBvid = new Map(externalPick.selected.map((s) => [s.bvid, s.reason]))
  for (const track of result.externalTracks) {
    const reason = reasonByBvid.get(track.bvid)
    if (reason) reasons[track.id] = reason
  }
  return result
}

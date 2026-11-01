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

export interface AiRecommendation {
  /** 问候语（结合时段与环境，一两句） */
  greeting: string
  /** 推荐曲目 */
  tracks: Track[]
  /** 每首的推荐理由，key 为 track.id */
  reasons: Record<string, string>
  /** 生成时的时段描述，用于 UI 展示 */
  contextLabel: string
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
 * 从候选池里挑出推荐曲目。
 *
 * 复用智能歌单的候选池（收藏 → 最近播放 → 下载，去重上限 120）。
 * 模型只返回编号，本地映射回真实 Track；编造编号丢弃。
 */
export function parseRecommendation(
  reply: string,
  pool: AiPlaylistCandidate[],
): { greeting: string; picked: { track: Track; reason: string }[] } {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回可解析的 JSON')
  const obj = JSON.parse(raw.slice(start, end + 1)) as {
    greeting?: unknown
    picks?: unknown
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
  return { greeting, picked }
}

export interface RecommendInput {
  settings: AiSettings
  /** 最多推荐几首 */
  limit?: number
  now?: Date
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
}

/** 组装推荐提示词；纯函数，不发请求 */
export function buildRecommendPrompt(input: RecommendPromptInput): {
  system: string
  user: string
} {
  const { settings, limit, contextLabel, hour, profileContext, portraitText, hasHistory, pool } = input
  const userText = profileContext.profile
  const learned = profileContext.learned
  // v1.4.14-pre3：显式表态单独成段，并带上「必须避开」的行动指令
  const explicit = renderExplicitFeedback(profileContext)

  const persona = (settings.persona || '').trim()
  const personaLine = persona ? '你的说话风格：' + persona : ''

  const system = [
    '你是音乐 App 的推荐助手。请像朋友打招呼一样，先写一两句问候，再推荐几首歌。',
    personaLine,
    '严格要求：',
    '1. 只能从候选清单里挑，index 必须是清单中真实存在的数字，不得编造；',
    '2. 推荐 ' + limit + ' 首左右，宁少勿滥；',
    '3. 问候语要结合当前时段与听歌习惯，不要空洞套话，不要「根据数据显示」这类表述；',
    // v1.4.14-pre3：把显式否定升级为硬约束，避免模型为凑数而回捞
    '4. 用户明确表示不感兴趣的曲目一律不得推荐，即使候选清单里还有它们；',
    '5. 只输出一个 JSON 对象，不要任何解释文字或代码围栏：',
    '{"greeting":"问候语（60 字内）","picks":[{"index":编号,"reason":"一句推荐理由（20 字内）"}]}',
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

/** 生成推荐（不落库、不改任何状态） */
export async function generateRecommendation(input: RecommendInput): Promise<AiRecommendation> {
  const { settings, limit = 5, now = new Date() } = input
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
  })

  const reply = await aiChat(settings, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userLines },
    ],
    temperature: 0.85,
    timeoutMs: 90000,
  })

  const { greeting, picked } = parseRecommendation(reply, usablePool)
  if (!picked.length) throw new Error('模型没有选出可用曲目，稍后再试')

  const reasons: Record<string, string> = {}
  for (const p of picked) if (p.reason) reasons[p.track.id] = p.reason

  return {
    greeting: greeting || '给你挑了几首，试试看。',
    tracks: picked.map((p) => p.track),
    reasons,
    contextLabel: ctx.label,
  }
}

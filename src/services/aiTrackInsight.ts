/**
 * v1.4.14-pre4 播放页 AI 曲目解析：说明这首歌是什么风格、可能在唱什么、适合什么场景听。
 *
 * 设计要点：
 * - **输入只有标题、歌手与可选歌词片段**：不发音频、不发封面、不发 bvid/播放量这类
 *   与「听起来是什么」无关的元数据。信息越少，模型越不容易顺着无关线索编故事。
 * - **B 站标题天然含噪声**（【4K修复】/【翻唱】/「官方MV」/「1.2万播放」等），
 *   提示词明确要求以歌名与歌手为主，其余当作不可靠线索。
 * - **不许编造歌手生平**：模型对冷门曲目的事实记忆极不可靠，一旦编出「某年发行、
 *   获某奖」，用户无从分辨真假。这里只让它描述听感与可能的情境。
 * - **解析失败要抛可读的中文错误**，由调用方展示——播放页不静默失败。
 * - 会话内缓存放在调用方（组件），服务层保持纯函数式，便于单测。
 */

import { aiChat, type AiChatMessage } from '@/services/ai'
import type { AiSettings } from '@/types'

/** 歌词片段最多送多少行：够判断语言与主题，又不至于把整首词塞进上下文 */
export const AI_INSIGHT_LYRIC_LINES = 24

/** 单行歌词截断长度，防止个别行异常长把提示词撑爆 */
const LYRIC_LINE_MAX = 120

/** 结构化解析结果 */
export interface TrackInsight {
  /** 一句话总结这首歌听起来是什么（60 字内） */
  summary: string
  /** 风格/曲风（如「City Pop」「民谣」「电子舞曲」） */
  style: string
  /** 情绪/氛围（如「松弛」「怅然」「亢奋」） */
  mood: string
  /** 适合听的场景（如「深夜独自走路」「通勤路上」） */
  scene: string
  /** 模型对本次判断的自评置信度 0~1；缺省或非法时为 null */
  confidence: number | null
  /** 是否参考了歌词（UI 据此说明「结合了歌词」还是「只看了标题」） */
  usedLyrics: boolean
}

/** 供 UI 展示的输入：只要这几个字段，不依赖完整 Track */
export interface TrackInsightInput {
  /** 曲目 id（缓存键；缺省时退回 artist|title） */
  id?: string
  /** 原始标题（B 站标题，可能含噪声） */
  title: string
  /** 歌手/UP 主 */
  artist: string
}

export interface GenerateTrackInsightOptions {
  settings: AiSettings
  track: TrackInsightInput
  /** 可选歌词片段（前若干行原文）。传空或不传则只用标题与歌手 */
  lyricSnippet?: string[]
  /** 超时毫秒，缺省 60 秒 */
  timeoutMs?: number
}

/**
 * 从模型回复里解析出结构化结果。
 *
 * 容忍代码围栏与前后废话（与 aiPlaylist / aiRecommend 同一套做法）。
 * 解析不出 JSON、或 JSON 里没有任何可用字段时抛错——由调用方展示，
 * 不返回半空对象让 UI 显示一片空白。
 */
export function parseTrackInsight(reply: string): Omit<TrackInsight, 'usedLyrics'> {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 返回的内容不是可解析的格式，请重试')

  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error('AI 返回的内容不是可解析的格式，请重试')
  }
  if (!obj || typeof obj !== 'object') throw new Error('AI 返回的内容不是可解析的格式，请重试')

  const rec = obj as Record<string, unknown>
  const pick = (key: string): string => {
    const v = rec[key]
    return typeof v === 'string' ? v.trim() : ''
  }

  const summary = pick('summary')
  const style = pick('style')
  const mood = pick('mood')
  const scene = pick('scene')

  // 至少要有总结或风格，否则等于什么都没说
  if (!summary && !style) throw new Error('AI 没有给出可用的解析内容，请重试')

  const rawConfidence = rec.confidence
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : null

  return { summary, style, mood, scene, confidence }
}

/** 清洗歌词片段：去空行、截断超长行、限行数 */
export function prepareLyricSnippet(lines: string[] | undefined): string[] {
  if (!lines || !lines.length) return []
  const out: string[] = []
  for (const line of lines) {
    const text = (line || '').trim()
    if (!text) continue
    out.push(text.slice(0, LYRIC_LINE_MAX))
    if (out.length >= AI_INSIGHT_LYRIC_LINES) break
  }
  return out
}

/**
 * 组装提示词。抽成导出函数便于单测断言「有没有把噪声警告与禁编造要求写进去」。
 */
export function buildTrackInsightMessages(
  track: TrackInsightInput,
  lyricSnippet: string[],
): AiChatMessage[] {
  const system = [
    '你是音乐 App 里的曲目解析助手。用户正在听一首歌，想知道它听起来是什么、可能在唱什么、适合什么时候听。',
    '',
    '输出要求：',
    '1. 说人话，像朋友随口讲两句，不要「根据您提供的信息」「综上所述」这类套话；',
    '2. 只输出一个 JSON 对象，不要任何解释文字或代码围栏；',
    '3. 格式：{"summary":"一句话总结（60 字内）","style":"风格（10 字内）","mood":"情绪（10 字内）","scene":"适合场景（20 字内）","confidence":0.0到1.0}',
    '',
    '事实纪律（重要）：',
    '4. 不要编造歌手生平、发行年份、获奖记录、销量等任何事实性信息——你不知道的就是不知道；',
    '5. 拿不准就写听感与可能的情境，并把 confidence 调低；',
    '6. 这是 B 站视频标题，可能混有「4K修复」「翻唱」「官方MV」「合集」「多少万播放」等噪声，',
    '   判断时以歌名与歌手为主，噪声部分不要当成歌曲信息。',
  ].join('\n')

  const userLines = [
    '歌名/标题：' + track.title.trim(),
    '歌手/UP 主：' + (track.artist.trim() || '（未知）'),
  ]
  if (lyricSnippet.length) {
    userLines.push('', '歌词片段（前 ' + lyricSnippet.length + ' 行，仅供参考，可能不完整）：')
    userLines.push(lyricSnippet.join('\n'))
  } else {
    userLines.push('', '（没有歌词可用，只根据歌名与歌手判断，置信度请相应调低）')
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ]
}

/**
 * 生成曲目解析。
 *
 * 抛出的错误一律是可读中文（未配置 / 超时 / 401 / 解析失败），
 * 由播放页直接展示在卡片里，而不是静默失败。
 */
export async function generateTrackInsight(options: GenerateTrackInsightOptions): Promise<TrackInsight> {
  const { settings, track, timeoutMs = 60000 } = options
  /*
   * 标题清洗（v1.4.14-pre4）：由调用方在传进来之前完成，本函数收到的 track.title
   * 应当已是清洗后的结果。这样安排是因为 cleanTrackTitle 需要 AppSettings
   * （含 titleCleanMode），而本函数的 settings 是 AiSettings，两者不是同一份配置。
   * 播放页见 NowPlaying 的 runInsight，那里已接入。
   *
   * 兜底：调用方没洗（或洗失败）时，提示词已明确要求模型以歌名与歌手为主、
   * 不要把 B 站标题里的噪声当成歌曲信息，因此原文也能用，只是准确度略低。
   */
  const title = (track.title || '').trim()
  if (!title) throw new Error('当前曲目没有标题，无法解析')

  const lyricSnippet = prepareLyricSnippet(options.lyricSnippet)
  const messages = buildTrackInsightMessages({ title, artist: track.artist || '' }, lyricSnippet)

  const reply = await aiChat(settings, { messages, temperature: 0.6, timeoutMs })
  const parsed = parseTrackInsight(reply)
  return { ...parsed, usedLyrics: lyricSnippet.length > 0 }
}

/**
 * 判断 AI 是否已配置。
 *
 * 与 DiscoverAiRecommend 同一口径：WorkBuddy 走账号凭据，OpenAI 兼容走三件套。
 * 未配置时 UI 直接给「去设置页」的指引，而不是发一个注定失败的请求。
 */
export function isAiConfigured(settings: AiSettings | null | undefined): boolean {
  if (!settings) return false
  if (settings.source === 'workbuddy') return !!settings.wbModel
  return !!(settings.baseUrl && settings.apiKey && settings.model)
}

/** 会话内缓存的对外形状（便于单测替换实现） */
export interface TrackInsightCache {
  get(key: string): TrackInsight | undefined
  set(key: string, value: TrackInsight): void
  delete(key: string): void
  has(key: string): boolean
  size(): number
  clear(): void
}

/**
 * 建一个会话内缓存。
 *
 * 为什么只活一个会话：曲目解析的价值在「当前这首歌想了解」，
 * 跨重启保留会让人过一阵看到一份基于旧提示词的结果还以为是新的；
 * 会话内命中已经足够省掉「同一首歌反复点」的重复请求。
 */
export function createTrackInsightCache(): TrackInsightCache {
  const store = new Map<string, TrackInsight>()
  return {
    get: (key) => store.get(key),
    set: (key, value) => { store.set(key, value) },
    delete: (key) => { store.delete(key) },
    has: (key) => store.has(key),
    size: () => store.size,
    clear: () => { store.clear() },
  }
}

/**
 * 缓存键：优先用 track.id（同一首歌同一版本），缺失时退回 artist|title。
 *
 * 用 id 是因为同一首歌的现场版/翻唱版在 B 站是两个稿件，解析结论本就该分开；
 * 而 id 缺失（少数构造出来的 Track）时退回文本键，至少不会每次都请求。
 */
export function insightCacheKey(track: TrackInsightInput): string {
  if (track.id && track.id.trim()) return track.id.trim()
  return ((track.artist || '') + '|' + (track.title || '')).trim()
}

/**
 * 带缓存的解析入口：命中则不发请求。
 *
 * 返回 cached 标志，UI 与单测都能据此确认「这次是缓存命中还是真的请求了」。
 */
export async function loadTrackInsight(
  cache: TrackInsightCache,
  options: GenerateTrackInsightOptions,
): Promise<{ insight: TrackInsight; cached: boolean }> {
  const key = insightCacheKey(options.track)
  const hit = cache.get(key)
  if (hit) return { insight: hit, cached: true }
  const insight = await generateTrackInsight(options)
  cache.set(key, insight)
  return { insight, cached: false }
}

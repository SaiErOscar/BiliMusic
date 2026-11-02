/**
 * 曲库外推荐：搜索 + 筛选（v1.4.14-pre7 重构）
 *
 * ## 为什么不再「模型给 BV 号 + 验证」
 *
 * pre6 让模型自由生成「标题 + BV号」，再由程序查存在性、AI 判断标题是否相符。
 * 实测证明这条路走不通：BV 号是 B 站内部标识，模型没有可靠的记忆来源，任何模型都只能编。
 * 验证能拦住不存在的号，却拦不住「存在但完全无关」的号；更麻烦的是模型给的候选
 * 大多在第一步就死掉，池外推荐长期凑不够数。
 *
 * 联网搜索也救不了：搜到的仍是网页文本，从文本里提取的 ID 照样可能错。
 *
 * ## 现在的做法
 *
 * 模型只输出**搜索关键词**（它擅长的语义理解），BV 号与标题**全部来自 B 站搜索接口**。
 * 模型永远碰不到 ID，幻觉从源头消失。
 *
 *   模型给关键词 → searchVideo 搜出真实候选 → AI 判断哪些符合用户意图
 *
 * ## 硬约束
 *
 * - 候选的 bvid / title / coverUrl / ownerName 一律来自接口返回值，不接受模型自述。
 * - 「是否符合意图」由另起 AI 请求判断，**绝不降级为本地关键词匹配**：
 *   AI 失败时整批丢弃并置 aiFailed，宁可全丢也不猜。
 * - 计量不在本模块做：aiChat 内部已调用 recordUsage，这里再记一次就是双计。
 */

import { aiChat, type AiChatMessage } from '@/services/ai'
import { searchVideo } from '@/services/api'
import type { AiSettings } from '@/types'

/** 一次 AI 筛选最多送几条候选，超出分批 */
export const FILTER_BATCH_SIZE = 10

/** 搜索并发上限：同时打多个搜索请求容易触发 B 站风控 */
export const SEARCH_CONCURRENCY = 3

/** 每个关键词取前几条搜索结果进候选池 */
export const RESULTS_PER_KEYWORD = 8

/** 关键词上限：太多会拖慢且互相重复 */
export const MAX_KEYWORDS = 5

/** 搜索接口返回的一条真实候选（字段全部来自接口） */
export interface SearchCandidate {
  bvid: string
  title: string
  coverUrl: string
  ownerName: string
  duration: number
  /** 命中的关键词，供诊断参考 */
  keyword: string
}

/** 通过 AI 筛选的最终结果 */
export interface SelectedCandidate extends SearchCandidate {
  /** AI 给出的「为什么符合意图」 */
  reason: string
}

export interface ExternalPickResult {
  selected: SelectedCandidate[]
  /** 参与筛选的候选总数（供 UI 说明丢弃情况） */
  considered: number
  /** 是否发生过 AI 筛选失败——UI 需据此给出不同文案 */
  aiFailed: boolean
}

/** AI 对一条候选的判断 */
export interface FilterJudgement {
  bvid: string
  keep: boolean
  reason: string
}

/** 把搜索结果的时长字符串（如 "04:12"）转成秒；解析不了返回 0 */
export function parseDurationText(text: string): number {
  if (!text) return 0
  const parts = text.trim().split(':').map((n) => Number(n))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  let seconds = 0
  for (const p of parts) seconds = seconds * 60 + p
  return seconds > 0 ? seconds : 0
}

/**
 * 用一组关键词搜索，汇总去重后的真实候选。
 *
 * 去重键用 bvid：同一首歌常被多个关键词命中。
 * 并发受限（SEARCH_CONCURRENCY），单个关键词失败不影响其它关键词。
 */
export async function collectSearchCandidates(keywords: string[]): Promise<SearchCandidate[]> {
  const list = keywords.map((k) => (k || '').trim()).filter(Boolean).slice(0, MAX_KEYWORDS)
  if (!list.length) return []

  const seen = new Set<string>()
  const out: SearchCandidate[] = []

  // 固定 worker 池：按下标轮流取，避免一次性打满并发
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= list.length) return
      const keyword = list[i]
      try {
        const res = await searchVideo(keyword, 1, RESULTS_PER_KEYWORD)
        for (const item of res.items) {
          if (!item.bvid || seen.has(item.bvid)) continue
          // 标题可能带高亮标签，接口层已剥离过一次，这里再兜一层
          const title = String(item.title || '').replace(/<[^>]+>/g, '').trim()
          if (!title) continue
          seen.add(item.bvid)
          out.push({
            bvid: item.bvid,
            title,
            coverUrl: item.pic || '',
            ownerName: item.author || '',
            duration: parseDurationText(item.duration),
            keyword,
          })
        }
      } catch {
        /* 单个关键词失败不致命：其它关键词仍可能给出候选 */
      }
    }
  }

  const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, list.length) }, () => worker())
  await Promise.all(workers)
  return out
}

/** 构造筛选提示词；纯函数，便于单测 */
export function buildFilterMessages(
  candidates: SearchCandidate[],
  context: { intent: string; limit: number },
): AiChatMessage[] {
  const system = [
    '你是音乐推荐助手。下面是从 B 站搜索到的真实视频列表（标题与 UP 主都来自接口，不是编的）。',
    '请判断其中哪些符合用户此刻的需求，并给出简短理由。',
    '严格要求：',
    '1. 只能从给出的列表里挑，bvid 必须与列表中的完全一致，不得改动或编造；',
    '2. 挑选 ' + context.limit + ' 条左右，宁少勿滥；没有合适的就返回空数组，不要硬凑；',
    '3. 判断依据是视频标题与 UP 主体现的内容是否对题，不要臆测视频里有什么；',
    '4. 理由要具体，不要「很适合你」这类空话；',
    '5. 只输出一个 JSON 对象，不要任何解释文字或代码围栏：',
    '{"picks":[{"bvid":"BV1xx411c7mD","reason":"一句理由（20 字内）"}]}',
  ].join('\n')

  const user = [
    '用户此刻的需求：' + (context.intent || '随便听听'),
    '',
    '搜索到的候选：',
    candidates.map((c, i) => i + 1 + '. [' + c.bvid + '] ' + c.title + ' —— ' + c.ownerName).join('\n'),
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * 解析筛选回复。
 *
 * 只认列表里真实存在的 bvid——模型回抄错一个字符就丢弃该条，
 * 不会因为「看起来像」而放行。
 */
export function parseFilterReply(reply: string, allowed: Set<string>): FilterJudgement[] {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('筛选结果不是可解析的格式')
  let obj: { picks?: unknown }
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as { picks?: unknown }
  } catch {
    throw new Error('筛选结果不是合法 JSON')
  }
  const out: FilterJudgement[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.picks)) {
    for (const item of obj.picks) {
      if (!item || typeof item !== 'object') continue
      const rec = item as { bvid?: unknown; reason?: unknown }
      const bvid = typeof rec.bvid === 'string' ? rec.bvid.trim() : ''
      if (!bvid || !allowed.has(bvid) || seen.has(bvid)) continue
      seen.add(bvid)
      out.push({
        bvid,
        keep: true,
        reason: typeof rec.reason === 'string' ? rec.reason.trim() : '',
      })
    }
  }
  return out
}

/**
 * 主流程：关键词 → 搜索 → AI 筛选 → 每个关键词只留一条。
 *
 * AI 筛选失败时整批丢弃并置 aiFailed=true，**不降级为本地关键词匹配**。
 *
 * ## 为什么每个关键词只留一条
 *
 * 用户明确要求：曲库外推荐「每个搜索词只取一首」。
 * 同一关键词的搜索结果彼此高度相似（同一首歌的多个投稿、同一类翻唱），
 * 全收会让池外分组被一个关键词灌满，看起来像「推荐」实则是同一件事的复读。
 * 一个词一条，最终条数自然受关键词数量约束——3 个词最多 3 条。
 *
 * 保留规则是**AI 排序里最先出现的那条**：AI 已按符合意图的程度排过序，
 * 首条就是它最认可的一条，不是随便取第一条。
 *
 * 与「截断到池内条数」的关系：本函数先按词去重，调用方（aiRecommend）
 * 再 slice 到条数上限——顺序反过来的话，被截掉的可能是去重后本该留下的那条。
 */
export async function pickExternalTracks(
  keywords: string[],
  context: { intent: string; limit: number },
  settings: AiSettings,
): Promise<ExternalPickResult> {
  const candidates = await collectSearchCandidates(keywords)
  if (!candidates.length) {
    return { selected: [], considered: 0, aiFailed: false }
  }

  const allowed = new Set(candidates.map((c) => c.bvid))
  const byBvid = new Map(candidates.map((c) => [c.bvid, c]))
  const selected: SelectedCandidate[] = []
  const seen = new Set<string>()
  /** 已贡献过结果的关键词：一个词只出一条 */
  const usedKeywords = new Set<string>()

  // 分批送 AI：一次太多会降低判断准确度
  for (let i = 0; i < candidates.length; i += FILTER_BATCH_SIZE) {
    const batch = candidates.slice(i, i + FILTER_BATCH_SIZE)
    let judged: FilterJudgement[]
    try {
      const reply = await aiChat(settings, {
        messages: buildFilterMessages(batch, context),
        temperature: 0.3,
        timeoutMs: 60000,
      })
      judged = parseFilterReply(reply, allowed)
    } catch {
      /*
       * 任何一批失败都整批作废并上报。
       * 绝不退回「本地按关键词匹配标题」——那等于用规则冒充判断，
       * 用户会拿到一堆看似相关实则无关的歌。
       */
      return { selected: [], considered: candidates.length, aiFailed: true }
    }
    for (const j of judged) {
      if (seen.has(j.bvid)) continue
      const base = byBvid.get(j.bvid)
      if (!base) continue
      /*
       * 每个关键词只收一条。
       *
       * judged 已按 AI 的排序，循环又是顺序的，所以「第一次遇到某个关键词」
       * 拿到的就是 AI 最认可的那条；后面的同词候选直接跳过。
       * 判断放在 byBvid 之后：模型回抄的无效 bvid 不占额度，
       * 否则一个错号就能让该关键词白白失去唯一的名额。
       */
      if (usedKeywords.has(base.keyword)) continue
      usedKeywords.add(base.keyword)
      seen.add(j.bvid)
      selected.push({ ...base, reason: j.reason })
    }
  }

  return { selected, considered: candidates.length, aiFailed: false }
}

/**
 * v1.4.11-pre6 AI 歌词翻译：翻译与逐句赏析。
 *
 * 设计要点：
 * - 只发歌词正文与行号，不发音频、不发曲目元数据以外的信息。
 * - 要求模型按行号返回，行数与顺序由本地对齐——模型漏行/错序都不会破坏时间轴。
 * - 结果不写回歌词缓存：AI 产出是「叠加层」，原始歌词（含官方 tlyric）保持权威，
 *   关掉开关即恢复原样，也不会污染 .lrc 导出。
 * - v1.4.14-pre8（用户反馈）：常规长度**整首一次发完**。此前一律按 40 行分批，
 *   批与批之间互不可见，同一首歌里的称呼、意象、语气词各译各的，
 *   读起来不像同一首歌的歌词。只有超过 AI_LYRIC_SINGLE_PASS_MAX 行才降级分批，
 *   降级时每批都带上全曲语境与已译片段，并要求模型沿用同一套译法。
 */

import { aiChat, type AiChatMessage } from '@/services/ai'
import type { AiSettings } from '@/types'
import type { LyricLine } from '@/services/lyrics'
import { loadProfileContext, renderProfileContext } from '@/services/aiProfileContext'

/**
 * 降级分批时的单批行数。
 *
 * v1.4.14-pre8 起常规路径不再分批（整首直发），这个常量只在
 * 超过 AI_LYRIC_SINGLE_PASS_MAX 时用于切批。
 *
 * 刻意保持 40 而不随阈值一起抬高：桌面歌词那条链路（useMiniWindowSync）
 * 也导入它，那边超时只有 45s，批量放大会把超时风险带过去。
 */
export const AI_LYRIC_BATCH = 40

/**
 * 整首一次发送的行数阈值；超过它才降级分批。
 *
 * 120 行覆盖了绝大多数歌曲：整首直发时模型能一次看到全曲，
 * 同一处原文自然译成同一句，不存在「各批各译一套」。
 * 分批要多付语境说明的 token，所以阈值不设得过低。
 */
export const AI_LYRIC_SINGLE_PASS_MAX = 120

export type AiLyricMode = 'translate' | 'interpret'

export const AI_LYRIC_MODE_LABELS: Record<AiLyricMode, string> = {
  translate: '翻译',
  interpret: '逐句赏析',
}

export interface AiLyricLineResult {
  /** 原歌词行号（0 基，与传入 lines 对齐） */
  index: number
  text: string
}

/** 从模型回复里解析出「行号 → 内容」，容忍代码围栏与多余说明 */
export function parseLyricLines(reply: string): AiLyricLineResult[] {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: AiLyricLineResult[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { index?: unknown; text?: unknown }
    const index = Number(rec.index)
    if (!Number.isFinite(index) || index < 0) continue
    if (typeof rec.text !== 'string' || !rec.text.trim()) continue
    out.push({ index, text: rec.text.trim() })
  }
  return out
}

/** 只取有文字的行参与增强（纯音乐空行、间奏空串跳过，避免浪费 token） */
export function pickTranslatableIndexes(lines: LyricLine[]): number[] {
  const idx: number[] = []
  lines.forEach((l, i) => {
    if (l.text && l.text.trim()) idx.push(i)
  })
  return idx
}

/** 分批时给模型的语境说明：全曲概览 + 已译片段，避免各批各译一套 */
export interface AiLyricBatchContext {
  /** 本批是全曲的第几批（0 基） */
  batchIndex: number
  /** 总批数 */
  totalBatches: number
  /** 本批覆盖的行号区间（人类可读，如「第 121–240 行」） */
  rangeLabel: string
  /** 全曲开头若干行，用作主题与称呼的锚点 */
  opening: string[]
  /** 已译好的片段（前几批的结果），供模型沿用同一套译法 */
  translated: { index: number; text: string }[]
}

/** 语境对照表最多带多少条已译行（控制 token） */
export const AI_LYRIC_GLOSSARY_MAX = 24

/** 全曲开头带多少行做主题锚点 */
export const AI_LYRIC_OPENING_MAX = 8

/**
 * 把已译片段压成对照表。只取最近若干条：
 * 语境是「别忘了前面怎么译的」，不是把整首再发一遍。
 */
export function renderTranslatedGlossary(
  translated: { index: number; text: string }[],
  limit = AI_LYRIC_GLOSSARY_MAX,
): string {
  if (!translated.length || limit <= 0) return ''
  return translated
    .slice(-limit)
    .map((t) => t.index + ': ' + t.text)
    .join('\n')
}

function buildMessages(
  mode: AiLyricMode,
  batch: { index: number; text: string }[],
  title: string,
  artist: string,
  contextText = '',
  batchContext?: AiLyricBatchContext,
): AiChatMessage[] {
  const task = mode === 'translate'
    ? [
        '这是歌曲歌词，不是普通文章或对话：它按行排布，有韵脚、有语气、有反复出现的意象。',
        '把每一行翻译成简体中文。若原文已是中文，则改写成更自然通顺的表达。',
        '允许适当意译：为了押韵、语气和意境，不必逐字对应，读起来要像中文歌词而不是翻译腔。',
        '整首歌词是同一首作品，同一个称呼、意象、语气词在全曲内必须保持同一种译法；',
        '重复出现的副歌要译成同样的文字，不要每遍换一种说法。',
        '不要解释，不要加注释，不要补充原文没有的内容。',
      ].join('')
    : [
        '这是歌曲歌词，不是普通文章：它按行排布，有韵脚、有语气、有反复出现的意象。',
        '为每一行写一句简短赏析（不超过 30 字），说明它的意象、情绪或修辞。',
        '允许结合上下文理解，但不要复述原句，不要写成长篇评论。',
        '整首歌词是同一首作品，全曲的解读口径要一致，不要前后矛盾。',
      ].join('')
  const system = [
    '你是歌词处理助手，专门处理歌曲歌词。',
    '任务：' + task,
    '严格要求：',
    '1. 输入是一个 JSON 数组，每项形如 {"index":行号,"text":歌词}；',
    '2. 你必须原样返回同样数量的项，index 与输入一一对应，不得增删或改号；',
    '3. 只输出 JSON 数组，不要任何解释文字或代码围栏；',
    '4. 输出格式：[{"index":行号,"text":"处理结果"}]',
  ].join('\n')

  const parts: string[] = []
  if (contextText) parts.push(contextText)
  parts.push('歌曲：' + title + (artist ? ' - ' + artist : ''))

  if (batchContext) {
    // 分批路径：先把「你在译同一首歌的一段」讲清楚，再给全曲锚点与已译对照
    const ctx: string[] = [
      '你在翻译同一首歌的不同片段：这是全曲第 ' + (batchContext.batchIndex + 1)
        + ' / ' + batchContext.totalBatches + ' 段（' + batchContext.rangeLabel + '）。',
      '请与全曲其余部分保持术语、称呼、意象与语气一致；同一处原文在不同段落要译成同样的文字。',
    ]
    if (batchContext.opening.length) {
      ctx.push('全曲开头（用于把握主题与称呼）：\n' + batchContext.opening.join('\n'))
    }
    const glossary = renderTranslatedGlossary(batchContext.translated)
    if (glossary) {
      ctx.push('前面段落已定的译法（沿用，不要另起一套）：\n' + glossary)
    }
    parts.push(ctx.join('\n'))
  }

  parts.push('歌词：\n' + JSON.stringify(batch, null, 0))
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/** 按阈值把待处理行切批；不超阈值就是一批（整首直发） */
export function planBatches<T>(items: T[], batchSize = AI_LYRIC_BATCH): T[][] {
  const size = Math.max(1, batchSize)
  if (!items.length) return []
  if (items.length <= AI_LYRIC_SINGLE_PASS_MAX) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 人类可读的行号区间，如「第 121–240 行」；给模型定位自己在全曲哪一段 */
export function batchRangeLabel(batch: { index: number }[]): string {
  if (!batch.length) return '第 0 行'
  const first = batch[0].index + 1
  const last = batch[batch.length - 1].index + 1
  return first === last ? '第 ' + first + ' 行' : '第 ' + first + '–' + last + ' 行'
}

/**
 * 翻译整首歌词。返回 行号 → 处理结果 的映射（缺失的行不填）。
 *
 * v1.4.14-pre8：常规长度整首一次发完——分批会让各批互不可见，同一首歌里的
 * 称呼/意象/语气词各译各的，用户读到的就是「上下不统一」。
 * 只有超过 AI_LYRIC_SINGLE_PASS_MAX 行才降级分批；那时每批都带全曲语境
 * （开头锚点 + 已译对照），并要求模型沿用同一套译法。
 *
 * 分批路径**串行**：后一批的语境要用前一批的译文，并发就无从谈一致性。
 */
export async function enhanceLyrics(
  config: AiSettings,
  lines: LyricLine[],
  mode: AiLyricMode,
  meta: { title: string; artist: string },
): Promise<{ result: Map<number, string>; failedBatches: number; totalBatches: number }> {
  const indexes = pickTranslatableIndexes(lines)
  if (!indexes.length) throw new Error('当前歌词没有可处理的文字行')

  const batches = planBatches(
    indexes.map((idx) => ({ index: idx, text: lines[idx].text })),
  )

  // v1.4.13-pre2 画像注入：让翻译/赏析贴合用户口味（例如讨厌过度解读）
  const contextText = renderProfileContext(await loadProfileContext())

  const result = new Map<number, string>()
  let failedBatches = 0

  // 整首直发：没有跨批一致性问题，一次调用最省心
  if (batches.length === 1) {
    try {
      const reply = await aiChat(config, {
        messages: buildMessages(mode, batches[0], meta.title, meta.artist, contextText),
        temperature: 0.3,
        timeoutMs: 90000,
      })
      const allowed = new Set(batches[0].map((b) => b.index))
      for (const item of parseLyricLines(reply)) {
        if (allowed.has(item.index)) result.set(item.index, item.text)
      }
    } catch {
      failedBatches = 1
    }
    if (!result.size) throw new Error('模型没有返回可用结果，请稍后重试')
    return { result, failedBatches, totalBatches: 1 }
  }

  // 降级分批：串行，每批带上全曲语境与已译对照
  const opening = batches[0].slice(0, AI_LYRIC_OPENING_MAX).map((b) => b.text)
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]
    const translated = Array.from(result.entries()).map(([index, text]) => ({ index, text }))
    try {
      const reply = await aiChat(config, {
        messages: buildMessages(mode, batch, meta.title, meta.artist, contextText, {
          batchIndex: i,
          totalBatches: batches.length,
          rangeLabel: batchRangeLabel(batch),
          opening,
          translated,
        }),
        temperature: 0.3,
        timeoutMs: 90000,
      })
      const allowed = new Set(batch.map((b) => b.index))
      for (const item of parseLyricLines(reply)) {
        // 只接受本批内的行号，防止模型改号或串批
        if (allowed.has(item.index)) result.set(item.index, item.text)
      }
    } catch {
      // 单批失败只丢该批，不中断整首
      failedBatches += 1
    }
  }

  if (!result.size) throw new Error('模型没有返回可用结果，请稍后重试')
  return { result, failedBatches, totalBatches: batches.length }
}

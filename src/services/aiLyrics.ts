/**
 * v1.4.11-pre6 AI 歌词增强：翻译与逐句赏析。
 *
 * 设计要点：
 * - 只发歌词正文与行号，不发音频、不发曲目元数据以外的信息。
 * - 要求模型按行号返回，行数与顺序由本地对齐——模型漏行/错序都不会破坏时间轴。
 * - 结果不写回歌词缓存：AI 产出是「叠加层」，原始歌词（含官方 tlyric）保持权威，
 *   关掉开关即恢复原样，也不会污染 .lrc 导出。
 * - 分批处理：长歌词一次发完容易超上下文，按批切分并保留行号偏移。
 */

import { aiChat, type AiChatMessage } from '@/services/ai'
import type { AiProviderConfig } from '@/types'
import type { LyricLine } from '@/services/lyrics'

/** 单批最多送多少行（长歌词分批，控制 token 与失败面） */
export const AI_LYRIC_BATCH = 40

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

function buildMessages(mode: AiLyricMode, batch: { index: number; text: string }[], title: string, artist: string): AiChatMessage[] {
  const task = mode === 'translate'
    ? '把每一行歌词翻译成简体中文。若原文已是中文，则改写成更自然通顺的表达；不要解释，不要加注释。'
    : '为每一行歌词写一句简短赏析（不超过 30 字），说明它的意象、情绪或修辞。不要复述原句，不要写成长篇评论。'
  const system = [
    '你是歌词处理助手。',
    '任务：' + task,
    '严格要求：',
    '1. 输入是一个 JSON 数组，每项形如 {"index":行号,"text":歌词}；',
    '2. 你必须原样返回同样数量的项，index 与输入一一对应，不得增删或改号；',
    '3. 只输出 JSON 数组，不要任何解释文字或代码围栏；',
    '4. 输出格式：[{"index":行号,"text":"处理结果"}]',
  ].join('\n')
  const user = '歌曲：' + title + (artist ? ' - ' + artist : '') + '\n歌词：\n' + JSON.stringify(batch, null, 0)
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * 增强整首歌词。返回 行号 → 处理结果 的映射（缺失的行不填）。
 *
 * 分批并发上限 3，兼顾速度与限流；单批失败只丢该批，不中断整首。
 */
export async function enhanceLyrics(
  config: AiProviderConfig,
  lines: LyricLine[],
  mode: AiLyricMode,
  meta: { title: string; artist: string },
): Promise<{ result: Map<number, string>; failedBatches: number; totalBatches: number }> {
  const indexes = pickTranslatableIndexes(lines)
  if (!indexes.length) throw new Error('当前歌词没有可处理的文字行')

  const batches: { index: number; text: string }[][] = []
  for (let i = 0; i < indexes.length; i += AI_LYRIC_BATCH) {
    batches.push(indexes.slice(i, i + AI_LYRIC_BATCH).map((idx) => ({ index: idx, text: lines[idx].text })))
  }

  const result = new Map<number, string>()
  let failedBatches = 0
  const CONCURRENCY = 3
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      slice.map((batch) => aiChat(config, { messages: buildMessages(mode, batch, meta.title, meta.artist), temperature: 0.3, timeoutMs: 90000 })),
    )
    settled.forEach((s, k) => {
      if (s.status === 'rejected') {
        failedBatches += 1
        return
      }
      const allowed = new Set(slice[k].map((b) => b.index))
      for (const item of parseLyricLines(s.value)) {
        // 只接受本批内的行号，防止模型改号或串批
        if (allowed.has(item.index)) result.set(item.index, item.text)
      }
    })
  }

  if (!result.size) throw new Error('模型没有返回可用结果，请稍后重试')
  return { result, failedBatches, totalBatches: batches.length }
}

/**
 * v1.4.13-pre11 桌面歌词的副行与语言判定。
 *
 * 用户的三条要求集中在这里：
 * - 第 5 项：桌面歌词上下显示双语字幕或 AI 增强字幕；
 * - 第 6 项：外文歌词在没有翻译时自动 AI 增强（默认关闭的选项）；
 * - 第 7 项：中文歌点「AI 增强」先提示「这是中文歌曲」，确认后再增强。
 *
 * 纯函数，便于测试；不碰网络也不碰存储。
 */

import type { LyricLine } from '@/services/lyrics'

/** 中日韩统一表意文字 + 扩展 A：用来判断「是不是中文歌」 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/
/** 拉丁 / 假名 / 谚文：用来判断「是不是外文」 */
const NON_CJK_LETTER = /[A-Za-z\u3040-\u30ff\uac00-\ud7af]/

export type LyricLanguage = 'zh' | 'foreign' | 'unknown'

/**
 * 判定歌词主体语言。
 *
 * 只看有文字的行，且用「占比」而不是「出现过」——
 * 中文歌里夹一句英文很常见，不能因为出现 A-Z 就判成外文。
 */
export function detectLyricLanguage(lines: LyricLine[]): LyricLanguage {
  let zhChars = 0
  let otherChars = 0
  for (const line of lines) {
    const text = (line.text || '').trim()
    if (!text) continue
    for (const ch of text) {
      if (CJK.test(ch)) zhChars++
      else if (NON_CJK_LETTER.test(ch)) otherChars++
    }
  }
  const total = zhChars + otherChars
  if (total === 0) return 'unknown'
  // 中文字符占三成以上即视为中文歌
  if (zhChars / total >= 0.3) return 'zh'
  return 'foreign'
}

/**
 * 给每一行配上副行文本。
 *
 * @param lines 原始歌词行
 * @param subByIndex 行号 → 副行（译文或 AI 增强结果）
 * @returns 带 sub 的新数组；没有副行的行不带该字段，避免空串占位
 */
export function attachSubLines(lines: LyricLine[], subByIndex: Map<number, string>): LyricLine[] {
  if (!subByIndex.size) return lines
  return lines.map((line, i) => {
    const sub = (subByIndex.get(i) || '').trim()
    return sub ? { ...line, sub } : line
  })
}

/**
 * 按字号估算一段文本的渲染宽度（px）。
 *
 * 中文字符约等于 1em 宽，拉丁字符约 0.55em。这是估算而非测量：
 * 歌词窗拿不到 canvas 测量结果时也要能立刻决定布局，宁可保守。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  if (!text) return 0
  let width = 0
  for (const ch of text) {
    width += CJK.test(ch) ? fontSize : fontSize * 0.55
  }
  return width
}

/**
 * 桌面歌词窗口是否需要因「单句过长」而自适应。
 *
 * 判定口径：按当前字号估算宽度，超过窗口可用宽度就需要处理
 * （缩小字号或横向滚动）。这里只给判定，具体怎么处理交给歌词窗。
 */
export function isLineTooLong(text: string, fontSize: number, availableWidth: number): boolean {
  if (!text) return false
  return estimateTextWidth(text, fontSize) > availableWidth
}

/** 主行在歌词窗里的排布方式 */
export type LyricLayoutMode =
  /** 一行放得下，正常居中 */
  | 'plain'
  /** 放不下一行但两行放得下：折行显示（仅单语时允许） */
  | 'wrap'
  /** 两行也放不下，或双语时主行必须独占一行：横向缓慢滚动一次 */
  | 'scroll'

export interface LyricLayoutPlan {
  mode: LyricLayoutMode
  /** 需要滚动时的水平位移（px，正数；0 表示不滚） */
  scrollDistance: number
  /** 滚动时长（毫秒）；mode 非 scroll 时为 0 */
  scrollMs: number
  /** 估算宽度（px），供调试与断言 */
  estimatedWidth: number
}

/** 滚动速度：刻意放慢，让人跟得上。约每秒 45px。 */
const SCROLL_PX_PER_SEC = 45
/** 滚动时长下限：再短就变成闪一下，看不清 */
const SCROLL_MIN_MS = 900
/** 滚动时长上限：再长这句早就唱完了 */
const SCROLL_MAX_MS = 9000

/**
 * 决定一句歌词该怎么摆。
 *
 * 用户的规则（v1.4.17-pre1）：
 * - **非双语**时允许占两行，不要因为一行放不下就滚动；
 * - **双语**时主行 + 副行已经是两行，主行放不下才滚动；
 * - 真要滚动时，时长按「这句唱多久」与「要滚多远」一起算，**只滚一次不循环**。
 *
 * @param hasSub 是否带副行（双语）。副行固定占一行，因此会挤压主行的可用行数。
 * @param lineSeconds 这句歌词的演唱时长（秒）。未知或 <= 0 时只用距离估算。
 */
export function planLyricLayout(options: {
  text: string
  fontSize: number
  availableWidth: number
  hasSub: boolean
  lineSeconds?: number
}): LyricLayoutPlan {
  const { text, fontSize, availableWidth, hasSub, lineSeconds = 0 } = options
  const width = estimateTextWidth(text, fontSize)
  const fitsOneLine = width <= availableWidth

  if (fitsOneLine) {
    return { mode: 'plain', scrollDistance: 0, scrollMs: 0, estimatedWidth: width }
  }

  /*
   * 双语时副行占掉一行，主行必须留在一行内——否则两行主行 + 一行副行会顶到控制按钮。
   * 单语时可以把这两行的额度都给主行。
   */
  if (!hasSub && width <= availableWidth * 2) {
    return { mode: 'wrap', scrollDistance: 0, scrollMs: 0, estimatedWidth: width }
  }

  const distance = Math.max(0, Math.round(width - availableWidth))
  let ms = (distance / SCROLL_PX_PER_SEC) * 1000
  // 必须在这句唱完前滚到位，否则歌词已经换行了还在滚上一句
  if (lineSeconds > 0) ms = Math.min(ms, lineSeconds * 1000 * 0.8)
  ms = Math.round(Math.min(SCROLL_MAX_MS, Math.max(SCROLL_MIN_MS, ms)))

  return { mode: 'scroll', scrollDistance: distance, scrollMs: ms, estimatedWidth: width }
}

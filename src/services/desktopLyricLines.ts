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
 * 桌面歌词窗口是否需要因「单句过长」而自适应。
 *
 * 判定口径：按当前字号估算宽度，超过窗口可用宽度就需要处理
 * （缩小字号或横向滚动）。这里只给判定，具体怎么处理交给歌词窗。
 */
export function isLineTooLong(text: string, fontSize: number, availableWidth: number): boolean {
  if (!text) return false
  // 中文字符约等于 1em 宽，拉丁字符约 0.55em
  let width = 0
  for (const ch of text) {
    width += CJK.test(ch) ? fontSize : fontSize * 0.55
  }
  return width > availableWidth
}

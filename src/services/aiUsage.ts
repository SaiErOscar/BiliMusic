/**
 * v1.4.13-pre1 AI 调用成本可见：本地统计调用次数与估算 token。
 *
 * 目的不是精确计费，而是让「省费用」这件事可感知——用户能看到本月用了几次、大概多少 token。
 * 只记本地、不上传；token 用「字符数 / 3」粗估（中英混排的经验系数），
 * 明确标注为估算值，避免被当成账单。
 */

const USAGE_KEY = 'bilimusic_ai_usage'

export interface AiUsageEntry {
  /** 月份，形如 2026-10 */
  month: string
  /** 调用次数 */
  calls: number
  /** 估算输入 token */
  inputTokens: number
  /** 估算输出 token */
  outputTokens: number
}

function currentMonth(): string {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

/** 粗估 token：中文约 1 字 1 token、英文约 4 字符 1 token，混排取字符数/3 的经验值 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3)
}

export function loadUsage(): AiUsageEntry {
  const month = currentMonth()
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AiUsageEntry
      // 跨月自动归零，避免历史月份累加失真
      if (parsed.month === month) return parsed
    }
  } catch {
    /* ignore */
  }
  return { month, calls: 0, inputTokens: 0, outputTokens: 0 }
}

export function recordUsage(inputChars: number, outputChars: number): void {
  try {
    const cur = loadUsage()
    const next: AiUsageEntry = {
      month: cur.month,
      calls: cur.calls + 1,
      inputTokens: cur.inputTokens + estimateTokens('x'.repeat(inputChars)),
      outputTokens: cur.outputTokens + estimateTokens('x'.repeat(outputChars)),
    }
    localStorage.setItem(USAGE_KEY, JSON.stringify(next))
  } catch {
    /* 统计失败不影响功能 */
  }
}

export function clearUsage(): void {
  try {
    localStorage.removeItem(USAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function formatUsage(u: AiUsageEntry): string {
  if (!u.calls) return '本月尚未调用'
  const total = u.inputTokens + u.outputTokens
  return '本月调用 ' + u.calls + ' 次，约 ' + total.toLocaleString() + ' tokens（估算）'
}

/**
 * v1.4.13-pre11 AI 调用成本可见：本地统计调用次数、token 与估算金额。
 *
 * 用户要求「DeepSeek 查看用量时可直接查看消耗金额」，
 * 而金额只有在区分**命中缓存输入 / 非命中缓存输入 / 输出**之后才算得准——
 * DeepSeek 的缓存命中价约为未命中的 1/10，混在一起算会高估十倍。
 *
 * 口径声明（不写进 UI 就当没说清）：
 * - token 仍是**估算值**（字符数 / 3），不是账单；
 * - 单价写死在 DEEPSEEK_PRICE 里，官方调价后需要同步更新，UI 上标注「按内置单价估算」；
 * - 只记本地、不上传。
 */

const USAGE_KEY = 'bilimusic_ai_usage'

export interface AiUsageEntry {
  /** 月份，形如 2026-10 */
  month: string
  /** 调用次数 */
  calls: number
  /** 估算输入 token（总计，= cacheHit + cacheMiss） */
  inputTokens: number
  /** 估算输出 token */
  outputTokens: number
  /** v1.4.13-pre11：其中命中缓存的输入 token（单价更低） */
  cacheHitTokens: number
  /** v1.4.13-pre11：其中未命中缓存的输入 token（全价） */
  cacheMissTokens: number
  /** v1.4.13-pre11：WorkBuddy 消耗的积分（由上游 usage.credit 汇总） */
  wbCredits: number
}

/**
 * DeepSeek 单价（元 / 百万 token）。
 *
 * 来源：DeepSeek 官方定价页（deepseek-chat 标准时段）。
 * 这是一个会变的常量，所以 UI 上必须写「按内置单价估算」而不是「费用」。
 */
export const DEEPSEEK_PRICE = {
  cacheHit: 0.5,
  cacheMiss: 2,
  output: 8,
} as const

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
      const parsed = JSON.parse(raw) as Partial<AiUsageEntry>
      // 跨月自动归零，避免历史月份累加失真
      if (parsed.month === month) {
        return {
          month,
          calls: parsed.calls || 0,
          inputTokens: parsed.inputTokens || 0,
          outputTokens: parsed.outputTokens || 0,
          cacheHitTokens: parsed.cacheHitTokens || 0,
          cacheMissTokens: parsed.cacheMissTokens || 0,
          wbCredits: parsed.wbCredits || 0,
        }
      }
    }
  } catch {
    /* ignore */
  }
  return {
    month, calls: 0, inputTokens: 0, outputTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, wbCredits: 0,
  }
}

export interface RecordUsageOptions {
  /** 命中缓存的输入字符数（上游 usage.prompt_cache_hit_tokens 换算） */
  cacheHitChars?: number
  /** WorkBuddy 本次消耗的积分 */
  credits?: number
}

export function recordUsage(inputChars: number, outputChars: number, options?: RecordUsageOptions): void {
  try {
    const cur = loadUsage()
    const hitChars = Math.max(0, options?.cacheHitChars || 0)
    // 命中数不会超过输入总数；超出时按全量视为命中，避免出现负数未命中
    const hit = Math.min(hitChars, inputChars)
    const miss = Math.max(0, inputChars - hit)
    const next: AiUsageEntry = {
      month: cur.month,
      calls: cur.calls + 1,
      inputTokens: cur.inputTokens + estimateTokens('x'.repeat(inputChars)),
      outputTokens: cur.outputTokens + estimateTokens('x'.repeat(outputChars)),
      cacheHitTokens: cur.cacheHitTokens + estimateTokens('x'.repeat(hit)),
      cacheMissTokens: cur.cacheMissTokens + estimateTokens('x'.repeat(miss)),
      wbCredits: cur.wbCredits + (options?.credits || 0),
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

/** 按内置单价估算金额（元）。只对 DeepSeek 有意义，其它服务商返回 null。 */
export function estimateCostYuan(u: AiUsageEntry): number | null {
  if (!u.calls) return 0
  const hit = u.cacheHitTokens * DEEPSEEK_PRICE.cacheHit
  const miss = u.cacheMissTokens * DEEPSEEK_PRICE.cacheMiss
  const out = u.outputTokens * DEEPSEEK_PRICE.output
  return (hit + miss + out) / 1_000_000
}

export function formatUsage(u: AiUsageEntry): string {
  if (!u.calls) return '本月尚未调用'
  const total = u.inputTokens + u.outputTokens
  const parts = ['本月调用 ' + u.calls + ' 次，约 ' + total.toLocaleString() + ' tokens（估算）']
  if (u.cacheHitTokens > 0) {
    parts.push('缓存命中 ' + u.cacheHitTokens.toLocaleString())
  }
  const cost = estimateCostYuan(u)
  if (cost !== null && cost > 0) {
    parts.push('约 ¥' + cost.toFixed(2) + '（按内置单价估算）')
  }
  if (u.wbCredits > 0) {
    parts.push('WorkBuddy 积分 ' + u.wbCredits.toFixed(2))
  }
  return parts.join(' · ')
}

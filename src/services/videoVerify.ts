/**
 * v1.4.14-pre6 池外候选验证器：把模型随口给出的「标题 + BV 号」变成可信条目。
 *
 * 背景：推荐侧允许模型提出歌单/收藏/喜欢之外的候选，但模型编 BV 号、张冠李戴是常态。
 * 因此这里做三步流水线，顺序不可颠倒：
 *   1. 本地格式筛查（只筛 BV 号形状，不发任何请求，省接口也省 AI）；
 *   2. 存在性查询（getVideoDetail 是存在性的唯一权威源，顺带拿到接口的真实标题）；
 *   3. 批量 AI 相符判断（以真实标题为基准，一次最多 10 条）。
 *
 * 关键取舍：
 * - **标题是否相符只由 AI 判断**，本地绝不做字符串相似度兜底。宁可整批丢弃
 *   （verify-failed + aiFailed），也不放行一条张冠李戴的候选——错放的歌比少放的歌更伤信任。
 * - **计量不在本模块做**：aiChat 内部已经调用 recordUsage，这里再记一次就是双计。
 * - 提示词与解析都抽成导出的纯函数，单测不碰网络。
 */

import { getVideoDetail } from '@/services/api'
import { aiChat, type AiChatMessage } from '@/services/ai'
import type { AiSettings } from '@/types'

/** 一次 AI 请求最多核对多少条：再多模型容易漏答或串行，成本也不划算 */
export const VERIFY_BATCH_SIZE = 10

/** getVideoDetail 的并发上限：B 站接口对短时并发敏感，超过容易触发限流 */
export const DETAIL_CONCURRENCY = 4

/** BV 号形状：BV + 10 位字母数字（不做任何语义校验，只是形状筛查） */
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/

const PARSE_ERROR = 'AI 返回的内容不是可解析的格式，请重试'

/** 一条待验证的池外候选 */
export interface RawExternalCandidate {
  /** 模型声称的标题 */
  claimedTitle: string
  /** 模型给出的 BV 号 */
  bvid: string
}

/** 单条验证结果 */
export interface VerifiedCandidate {
  bvid: string
  /** 接口返回的真实标题（不是模型声称的） */
  title: string
  /** 模型声称的标题，保留供诊断 */
  claimedTitle: string
  /** 接口返回的封面 */
  coverUrl: string
  /** UP 主名 */
  ownerName: string
  /** 时长（秒） */
  duration: number
  /** AI 给出的相符理由（一句话） */
  matchReason: string
}

/** 被丢弃的条目及原因 */
export interface RejectedCandidate {
  bvid: string
  claimedTitle: string
  reason: 'bad-format' | 'not-found' | 'mismatch' | 'verify-failed'
  /** 人类可读说明 */
  detail: string
}

export interface VerifyResult {
  verified: VerifiedCandidate[]
  rejected: RejectedCandidate[]
  /** 是否发生过 AI 判断失败（网络/解析）——UI 需要据此告知用户 */
  aiFailed: boolean
}

/** 交给 AI 的一条核对材料：声称标题 vs 接口真实标题 */
export interface VerifyPair {
  bvid: string
  claimedTitle: string
  realTitle: string
}

/** AI 对单条的判定 */
export interface VerifyJudgement {
  bvid: string
  /** 是否指向同一个视频 */
  match: boolean
  /** 一句话理由；模型没给时为空串 */
  reason: string
}

/** 只做形状筛查：去掉首尾空白后必须完全匹配 BV + 10 位字母数字 */
export function isValidBvid(bvid: string): boolean {
  return BVID_PATTERN.test((bvid || '').trim())
}

/**
 * 组装批量核对提示词。
 *
 * 提示词必须说清「真实标题来自 B 站接口、BV 号已由程序验证存在」，
 * 否则模型会把注意力放到猜 BV 号对不对上，而不是比对标题。
 * 抽成导出函数便于单测断言这些约束确实写进去了。
 */
export function buildVerifyMessages(pairs: VerifyPair[]): AiChatMessage[] {
  const system = [
    '你是视频标题核对助手。用户会给出若干条「模型声称的标题」与「B 站接口查到的真实标题」，',
    '你要判断：模型声称的标题是否指向同一个视频。',
    '',
    '事实前提（重要）：',
    '1. 下面给出的真实标题都是从 B 站接口查到的，视频确实存在；BV 号不需要你判断对错，不要去猜；',
    '2. 只比对标题含义，不要因为 BV 号看着陌生就判不符。',
    '',
    '判定口径：',
    '3. 同一个视频的不同写法算相符：带不带「官方」「MV」「4K修复」「翻唱」「Live」「纯享版」等前后缀、',
    '   标题里多打的【】「」标签、错别字、繁简差异、标点与空格差异、副标题顺序不同，都算相符；',
    '4. 只有当真实标题明显是另一首歌 / 另一个作品 / 完全无关时才判不符；',
    '5. 拿不准时判不符——宁可少放一条，也不要把张冠李戴的条目放进去。',
    '',
    '输出要求：',
    '6. 只输出一个 JSON 对象，不要解释文字，不要代码围栏；',
    '7. 格式：{"results":[{"bvid":"BV1xx411c7mD","match":true,"reason":"一句话理由"}]}；',
    '8. results 的条数必须与输入条数一致，bvid 原样抄回，reason 控制在 20 字以内。',
  ].join('\n')

  const userLines: string[] = ['请核对以下 ' + pairs.length + ' 条候选：', '']
  pairs.forEach((pair, i) => {
    userLines.push(
      `${i + 1}. bvid: ${pair.bvid}`,
      `   模型声称标题：${pair.claimedTitle || '（空）'}`,
      `   接口真实标题：${pair.realTitle}`,
    )
  })

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ]
}

/**
 * 解析 AI 的批量核对回复。
 *
 * 容忍代码围栏与前后废话（与 aiTrackInsight / aiPlaylist 同一套做法）。
 * 结构不对（不是 JSON、没有 results 数组）一律抛可读中文错误，由调用方整批丢弃；
 * 单条字段不合法（缺 bvid、match 不是布尔）只跳过该条，让调用方把它算作「AI 没判断」。
 */
export function parseVerifyReply(reply: string): VerifyJudgement[] {
  const text = reply || ''
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(PARSE_ERROR)

  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error(PARSE_ERROR)
  }
  if (!obj || typeof obj !== 'object') throw new Error(PARSE_ERROR)

  const results = (obj as Record<string, unknown>).results
  if (!Array.isArray(results)) throw new Error(PARSE_ERROR)

  const out: VerifyJudgement[] = []
  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const bvid = typeof rec.bvid === 'string' ? rec.bvid.trim() : ''
    if (!bvid) continue
    if (typeof rec.match !== 'boolean') continue
    const reason = typeof rec.reason === 'string' ? rec.reason.trim().slice(0, 120) : ''
    out.push({ bvid, match: rec.match, reason })
  }
  return out
}

/** 把未知错误转成一句可读中文 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 限并发地跑一遍异步任务，返回结果按输入顺序排列。
 *
 * 用固定数量的 worker 轮流取下一个下标，而不是先切片再 Promise.all——
 * 后者会在某个任务提前失败时留下没跑完的批次。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  }
  const size = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: size }, () => worker()))
  return results
}

/** 单个候选在流水线里的中间态 */
interface Resolved {
  bvid: string
  claimedTitle: string
  title: string
  coverUrl: string
  ownerName: string
  duration: number
}

type Slot =
  | { kind: 'verified'; value: VerifiedCandidate }
  | { kind: 'rejected'; value: RejectedCandidate }

/**
 * 验证一批池外候选。三步顺序不可颠倒，任何一步失败都只丢弃，不猜测。
 */
export async function verifyExternalCandidates(
  candidates: RawExternalCandidate[],
  settings: AiSettings,
): Promise<VerifyResult> {
  const slots: (Slot | undefined)[] = []
  let aiFailed = false

  // 去重：同一 bvid 只验证一次；声称标题保留首次出现的那条（后续重复不覆盖，保证结果可复现）
  const unique: RawExternalCandidate[] = []
  const seen = new Set<string>()
  for (const candidate of candidates || []) {
    const bvid = (candidate?.bvid || '').trim()
    const claimedTitle = (candidate?.claimedTitle || '').trim()
    const key = bvid.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ bvid, claimedTitle })
  }

  // 步骤 1：本地格式筛查。不合格直接丢弃，不发任何请求
  const formatted: { item: RawExternalCandidate; index: number }[] = []
  unique.forEach((item, index) => {
    if (isValidBvid(item.bvid)) {
      formatted.push({ item, index })
      return
    }
    slots[index] = {
      kind: 'rejected',
      value: {
        bvid: item.bvid,
        claimedTitle: item.claimedTitle,
        reason: 'bad-format',
        detail: item.bvid
          ? `BV 号格式不合法（应为 BV 加 10 位字母数字）：${item.bvid}`
          : 'BV 号为空',
      },
    }
  })

  // 步骤 2：存在性查询，并发不超过 DETAIL_CONCURRENCY
  const lookups = await mapWithConcurrency(formatted, DETAIL_CONCURRENCY, async ({ item }) => {
    try {
      const info = await getVideoDetail(item.bvid)
      const title = (info?.title || '').trim()
      if (!title) {
        return { ok: false as const, detail: 'B 站接口没有返回标题，无法判断是否相符' }
      }
      return {
        ok: true as const,
        resolved: {
          bvid: item.bvid,
          claimedTitle: item.claimedTitle,
          title,
          coverUrl: info.pic || '',
          ownerName: info.ownerName || '',
          duration: info.duration || 0,
        } satisfies Resolved,
      }
    } catch (err) {
      return { ok: false as const, detail: `B 站接口查不到这个视频：${errMessage(err)}` }
    }
  })

  const resolved: { item: Resolved; index: number }[] = []
  lookups.forEach((lookup, i) => {
    const index = formatted[i].index
    if (!lookup.ok) {
      const source = formatted[i].item
      slots[index] = {
        kind: 'rejected',
        value: {
          bvid: source.bvid,
          claimedTitle: source.claimedTitle,
          reason: 'not-found',
          detail: lookup.detail,
        },
      }
      return
    }
    resolved.push({ item: lookup.resolved, index })
  })

  // 步骤 3：批量 AI 相符判断，一次最多 VERIFY_BATCH_SIZE 条
  for (let offset = 0; offset < resolved.length; offset += VERIFY_BATCH_SIZE) {
    const batch = resolved.slice(offset, offset + VERIFY_BATCH_SIZE)
    const pairs: VerifyPair[] = batch.map(({ item }) => ({
      bvid: item.bvid,
      claimedTitle: item.claimedTitle,
      realTitle: item.title,
    }))

    let judgements: VerifyJudgement[] = []
    let failure = ''
    try {
      const reply = await aiChat(settings, { messages: buildVerifyMessages(pairs), temperature: 0 })
      judgements = parseVerifyReply(reply)
    } catch (err) {
      failure = errMessage(err)
    }

    // 整批 AI 失败：全部丢弃并上报。绝不降级为本地相似度判断
    if (failure) {
      aiFailed = true
      for (const { item, index } of batch) {
        slots[index] = {
          kind: 'rejected',
          value: {
            bvid: item.bvid,
            claimedTitle: item.claimedTitle,
            reason: 'verify-failed',
            detail: `AI 核对失败，本条已丢弃：${failure}`,
          },
        }
      }
      continue
    }

    // 模型回抄 bvid 时可能改动大小写，按小写建索引做容错匹配（不是标题相似度判断）
    const byBvid = new Map<string, VerifyJudgement>()
    for (const judgement of judgements) byBvid.set(judgement.bvid.toLowerCase(), judgement)

    for (const { item, index } of batch) {
      const judgement = byBvid.get(item.bvid.toLowerCase())
      if (!judgement) {
        aiFailed = true
        slots[index] = {
          kind: 'rejected',
          value: {
            bvid: item.bvid,
            claimedTitle: item.claimedTitle,
            reason: 'verify-failed',
            detail: 'AI 没有对这一条给出判断，本条已丢弃',
          },
        }
        continue
      }
      if (!judgement.match) {
        slots[index] = {
          kind: 'rejected',
          value: {
            bvid: item.bvid,
            claimedTitle: item.claimedTitle,
            reason: 'mismatch',
            detail: judgement.reason || 'AI 判断声称的标题与接口返回的标题不是同一个视频',
          },
        }
        continue
      }
      slots[index] = {
        kind: 'verified',
        value: {
          bvid: item.bvid,
          title: item.title,
          claimedTitle: item.claimedTitle,
          coverUrl: item.coverUrl,
          ownerName: item.ownerName,
          duration: item.duration,
          matchReason: judgement.reason || '标题相符',
        },
      }
    }
  }

  // 按输入顺序还原成两个数组，UI 展示顺序与用户看到的候选顺序一致
  const verified: VerifiedCandidate[] = []
  const rejected: RejectedCandidate[] = []
  for (const slot of slots) {
    if (!slot) continue
    if (slot.kind === 'verified') verified.push(slot.value)
    else rejected.push(slot.value)
  }

  return { verified, rejected, aiFailed }
}

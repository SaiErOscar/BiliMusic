/**
 * v1.4.12-pre1 AI 听歌画像：把播放统计聚合成本地摘要，再交给 LLM 写成叙事化画像。
 *
 * 设计要点：
 * - **本地先聚合，只把摘要发出去**：不发逐曲明细、不发完整歌单，只发 top 曲目/歌手/时段分布
 *   这类聚合量，既省 token 也少暴露。
 * - **统计口径集中在 summarize()**，纯函数、可测；LLM 只负责把数字写成话。
 * - 没有数据时明确报错，不生成空洞的画像。
 */

import { aiChat } from '@/services/ai'
import { loadPlayStats, type PlayStat } from '@/utils/storage'
import type { AiSettings } from '@/types'

/** 画像时间范围 */
export type PortraitRange = 'month' | 'year' | 'all'

export const PORTRAIT_RANGE_LABELS: Record<PortraitRange, string> = {
  month: '近一个月',
  year: '近一年',
  all: '全部时间',
}

export interface PortraitSummary {
  /** 参与统计的曲目数 */
  trackCount: number
  /** 总播放次数 */
  totalPlays: number
  /** 总收听小时数（一位小数） */
  totalHours: number
  /** 完整听完比例（0~1） */
  completionRate: number
  /** 播放最多的曲目（最多 10 条） */
  topTracks: { title: string; artist: string; plays: number }[]
  /** 播放最多的歌手（最多 8 条） */
  topArtists: { artist: string; plays: number }[]
  /** 各时段播放次数分布（0-5 / 6-11 / 12-17 / 18-23） */
  timeBuckets: { label: string; plays: number }[]
}

function rangeStart(range: PortraitRange): number {
  const now = Date.now()
  if (range === 'month') return now - 30 * 24 * 3600 * 1000
  if (range === 'year') return now - 365 * 24 * 3600 * 1000
  return 0
}

const TIME_BUCKETS = [
  { label: '凌晨 0-5 点', from: 0, to: 6 },
  { label: '上午 6-11 点', from: 6, to: 12 },
  { label: '下午 12-17 点', from: 12, to: 18 },
  { label: '夜晚 18-23 点', from: 18, to: 24 },
]

/**
 * 把播放统计聚合成画像摘要。纯函数，便于测试。
 *
 * 时段分布只能从 lastAt 推断（每次播放更新该字段），因此是「最近一次播放落在哪个时段」
 * 的分布，不是逐次播放的精确分布——统计精度受限于现有埋点粒度，这里如实按此口径聚合。
 */
export function summarize(stats: Record<string, PlayStat>, range: PortraitRange): PortraitSummary {
  const since = rangeStart(range)
  const list = Object.values(stats).filter((s) => {
    const t = Date.parse(s.lastAt || '')
    return Number.isFinite(t) && t >= since
  })

  const totalPlays = list.reduce((a, s) => a + (s.plays || 0), 0)
  const totalSeconds = list.reduce((a, s) => a + (s.seconds || 0), 0)
  const totalCompletions = list.reduce((a, s) => a + (s.completions || 0), 0)

  const topTracks = [...list]
    .sort((a, b) => (b.plays || 0) - (a.plays || 0))
    .slice(0, 10)
    .map((s) => ({ title: s.title, artist: s.artist, plays: s.plays || 0 }))

  const artistMap = new Map<string, number>()
  for (const s of list) {
    const name = (s.artist || '未知歌手').trim() || '未知歌手'
    artistMap.set(name, (artistMap.get(name) || 0) + (s.plays || 0))
  }
  const topArtists = [...artistMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([artist, plays]) => ({ artist, plays }))

  const bucketCounts = TIME_BUCKETS.map((b) => ({ label: b.label, plays: 0 }))
  for (const s of list) {
    const t = Date.parse(s.lastAt || '')
    if (!Number.isFinite(t)) continue
    const hour = new Date(t).getHours()
    const idx = TIME_BUCKETS.findIndex((b) => hour >= b.from && hour < b.to)
    if (idx >= 0) bucketCounts[idx].plays += s.plays || 0
  }

  return {
    trackCount: list.length,
    totalPlays,
    totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
    completionRate: totalPlays ? Math.round((totalCompletions / totalPlays) * 100) / 100 : 0,
    topTracks,
    topArtists,
    timeBuckets: bucketCounts,
  }
}

/** 把摘要渲染成给模型的紧凑文本 */
export function renderSummary(summary: PortraitSummary, range: PortraitRange): string {
  const lines = [
    '时间范围：' + PORTRAIT_RANGE_LABELS[range],
    '曲目数：' + summary.trackCount + '，总播放 ' + summary.totalPlays + ' 次，累计 ' + summary.totalHours + ' 小时，完整听完率 ' + Math.round(summary.completionRate * 100) + '%',
    '常听曲目：' + (summary.topTracks.map((t) => t.title + (t.artist ? '(' + t.artist + ')' : '') + ' x' + t.plays).join('；') || '无'),
    '常听歌手：' + (summary.topArtists.map((a) => a.artist + ' x' + a.plays).join('；') || '无'),
    '时段分布：' + summary.timeBuckets.map((b) => b.label + ' ' + b.plays + ' 次').join('；'),
  ]
  return lines.join('\n')
}

/** 生成画像文本（叙事化，不是表格复述） */
export async function generatePortrait(
  config: AiSettings,
  range: PortraitRange,
  stats = loadPlayStats(),
): Promise<{ text: string; summary: PortraitSummary }> {
  const summary = summarize(stats, range)
  if (!summary.trackCount || !summary.totalPlays) {
    throw new Error('这段时间还没有播放记录，先听几首歌再来')
  }

  const messages = [
    {
      role: 'system' as const,
      content: [
        '你是听歌画像撰写者。用户会给你一份听歌统计摘要。',
        '写一段 150~250 字的中文画像，要求：',
        '1. 用第二人称「你」，像朋友聊天，不要客服腔、不要「根据数据显示」这类套话；',
        '2. 不要罗列表格数字，要把它翻译成听歌习惯的描述（什么时候听、偏什么情绪、口味是否集中）；',
        '3. 可以给一句温和的观察或建议，但不要说教；',
        '4. 只输出画像正文，不要标题、不要 markdown。',
      ].join('\n'),
    },
    { role: 'user' as const, content: renderSummary(summary, range) },
  ]

  const text = await aiChat(config, { messages, temperature: 0.8, timeoutMs: 90000 })
  return { text: text.trim(), summary }
}

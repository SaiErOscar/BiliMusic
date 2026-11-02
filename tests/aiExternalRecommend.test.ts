// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiPlaylistCandidate } from '../src/services/aiPlaylist'
import type { AiSettings } from '../src/types'

/*
 * v1.4.14-pre7 池外推荐（曲库之外）。
 *
 * pre6 让模型直接给「标题 + BV 号」，实测幻觉严重：BV 号是 B 站内部标识，
 * 模型没有可靠来源只能编，验证再严也救不回来。pre7 改成：
 *
 *   模型只输出搜索关键词 → pickExternalTracks 去 searchVideo 搜 → AI 判是否对题
 *
 * 于是本文件的断言重心也变了：
 *   1. 模型给的是**关键词**，不是 ID——Track 的 title/bvid 必须来自搜索结果；
 *   2. 开关关闭时提示词里根本没有池外段落，模型多给字段也不进结果；
 *   3. 池内条数与顺序不受池外影响，池外截断到池内条数；
 *   4. 失败态必须如实上报（ai-failed / all-rejected），绝不静默。
 */

const pickMock = vi.hoisted(() => ({ pickExternalTracks: vi.fn() }))
vi.mock('../src/services/videoVerify', () => pickMock)

const chatMock = vi.hoisted(() => ({ aiChat: vi.fn() }))
vi.mock('../src/services/ai', () => chatMock)

const portraitMock = vi.hoisted(() => ({
  summarize: vi.fn(() => ({
    totalPlays: 3,
    totalDuration: 600,
    topArtists: [],
    topTracks: [],
    byHour: [],
    updatedAt: '',
  })),
  renderSummary: vi.fn(() => '总播放 3 次'),
}))
vi.mock('../src/services/aiPortrait', () => portraitMock)

vi.mock('../src/services/aiProfileContext', () => ({
  loadProfileContext: vi.fn(async () => ({ profile: '', learned: '', liked: [], disliked: [] })),
  renderExplicitFeedback: vi.fn(() => ''),
}))

const poolMock = vi.hoisted(() => ({ buildCandidatePool: vi.fn() }))
vi.mock('../src/services/aiPlaylist', () => poolMock)

const statsMock = vi.hoisted(() => ({ loadPlayStats: vi.fn(() => ({})) }))
vi.mock('../src/utils/storage', () => statsMock)

import {
  buildRecommendPrompt,
  externalTargetCount,
  generateRecommendation,
  parseExternalKeywords,
  parseRecommendation,
} from '../src/services/aiRecommend'

import type { SelectedCandidate } from '../src/services/videoVerify'
import type { ExternalPickResult } from '../src/services/videoVerify'

function cand(idx: number, id: string): AiPlaylistCandidate {
  return {
    index: idx,
    track: {
      id,
      title: 'T' + id,
      artist: 'A',
      coverUrl: '',
      duration: 0,
      videoUrl: '',
      bvid: '',
      playCount: 0,
      isLiked: false,
    },
  }
}

function settings(): AiSettings {
  return {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: 'k',
    proxyMode: 'system',
    proxyUrl: '',
    recommendMode: 'click',
    userProfile: { text: '', updatedAt: '' },
    persona: '',
  }
}

/** 造一条「通过 AI 筛选」的搜索结果（字段口径同 SearchCandidate + reason） */
function picked(bvid: string, title: string, extra: Partial<SelectedCandidate> = {}): SelectedCandidate {
  return {
    bvid,
    title,
    coverUrl: 'https://example.com/' + bvid + '.jpg',
    ownerName: '搜索结果UP',
    duration: 252,
    keyword: '晴天 周杰伦',
    reason: 'AI 说对题',
    ...extra,
  }
}

/** 池外流程的返回值 */
function pickResult(selected: SelectedCandidate[], considered: number, aiFailed = false): ExternalPickResult {
  return { selected, considered, aiFailed }
}

const POOL = [cand(1, 'a'), cand(2, 'b'), cand(3, 'c'), cand(4, 'd'), cand(5, 'e'), cand(6, 'f')]

/** 模型回复：池内编号 + 可选的池外搜索关键词 */
function modelReply(picks: number[], keywords?: string[]): string {
  const obj: { greeting: string; picks: { index: number; reason: string }[]; externalKeywords?: string[] } = {
    greeting: '晚上好',
    picks: picks.map((i) => ({ index: i, reason: 'r' + i })),
  }
  if (keywords) obj.externalKeywords = keywords
  return JSON.stringify(obj)
}

/** 固定时间，避免测试依赖真实时钟（20 点 → 晚上） */
const NIGHT = new Date(2026, 0, 1, 20, 0, 0)

const PROMPT_BASE = {
  settings: settings(),
  limit: 5,
  contextLabel: '晚上',
  hour: 20,
  profileContext: { profile: '', learned: '', liked: [], disliked: [] },
  portraitText: '',
  hasHistory: false,
  pool: POOL,
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // 池外失败时源码会在 DEV 下 console.warn：那是预期行为，别污染测试输出
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // 推荐去重读 sessionStorage：不清会串场，导致候选池被意外缩小
  sessionStorage.clear()
  poolMock.buildCandidatePool.mockReturnValue(POOL)
  chatMock.aiChat.mockReset()
  pickMock.pickExternalTracks.mockReset()
  pickMock.pickExternalTracks.mockResolvedValue(pickResult([], 0))
})

afterEach(() => {
  warnSpy.mockRestore()
  vi.clearAllMocks()
})

describe('parseExternalKeywords：只认关键词，不认 ID', () => {
  it('字符串数组原样取出', () => {
    expect(parseExternalKeywords(['晴天 周杰伦', '粤语 慢歌'])).toEqual(['晴天 周杰伦', '粤语 慢歌'])
  })

  it('容忍对象写法 {"q":"..."}', () => {
    expect(
      parseExternalKeywords([{ q: '晴天 周杰伦' }, '粤语 慢歌', { q: '  夜车  ' }]),
    ).toEqual(['晴天 周杰伦', '粤语 慢歌', '夜车'])
  })

  it('去重（大小写不敏感），保留首次出现的写法', () => {
    expect(parseExternalKeywords(['晴天', '晴天', 'AB', 'ab', ' 晴天 '])).toEqual(['晴天', 'AB'])
  })

  it('空值与结构不对的条目被过滤', () => {
    expect(parseExternalKeywords(['', '   ', null, undefined, 42, {}, { q: '' }, { q: 1 }])).toEqual([])
  })

  it('非数组输入返回空数组', () => {
    expect(parseExternalKeywords(undefined)).toEqual([])
    expect(parseExternalKeywords(null)).toEqual([])
    expect(parseExternalKeywords('晴天')).toEqual([])
    expect(parseExternalKeywords({ q: '晴天' })).toEqual([])
  })

  it('模型给的 BV 号不会被当成关键词之外的任何东西（关键词里含 BV 也只是一段文本）', () => {
    // 关键词就是关键词：实现不做语义解释，也不会把它当 ID 用
    expect(parseExternalKeywords(['BV1xx411c7mD'])).toEqual(['BV1xx411c7mD'])
  })
})

describe('parseRecommendation 取出 externalKeywords', () => {
  it('解析出关键词数组', () => {
    const r = parseRecommendation(modelReply([1], ['晴天 周杰伦', '粤语 慢歌']), POOL)
    expect(r.externalKeywords).toEqual(['晴天 周杰伦', '粤语 慢歌'])
    expect(r.picked.map((p) => p.track.id)).toEqual(['a'])
  })

  it('没有该字段时为空数组（旧格式兼容）', () => {
    expect(parseRecommendation(modelReply([1, 2]), POOL).externalKeywords).toEqual([])
  })

  it('字段类型不对时为空数组，不影响池内解析', () => {
    const r = parseRecommendation(
      JSON.stringify({ greeting: 'hi', picks: [{ index: 1 }], externalKeywords: '晴天' }),
      POOL,
    )
    expect(r.externalKeywords).toEqual([])
    expect(r.picked).toHaveLength(1)
  })
})

describe('池外目标条数 = ceil(池内 × 1.5)', () => {
  it('5 首池内要 8 首池外', () => {
    expect(externalTargetCount(5)).toBe(8)
    expect(externalTargetCount(4)).toBe(6)
    expect(externalTargetCount(1)).toBe(2)
  })

  it('非法条数不产生池外请求', () => {
    expect(externalTargetCount(0)).toBe(0)
    expect(externalTargetCount(-1)).toBe(0)
    expect(externalTargetCount(Number.NaN)).toBe(0)
  })
})

describe('开关关闭：行为与上线前一致', () => {
  it('不调用 pickExternalTracks', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2, 3, 4, 5]))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT })

    expect(pickMock.pickExternalTracks).not.toHaveBeenCalled()
    expect(r.externalTracks).toEqual([])
    expect(r.externalStatus).toBe('disabled')
    expect(r.externalRejected).toBe(0)
  })

  it('显式传 external: false 同样不调用', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2, 3, 4, 5]))
    await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: false })
    expect(pickMock.pickExternalTracks).not.toHaveBeenCalled()
  })

  it('关闭时提示词不含任何池外段落', () => {
    const off = buildRecommendPrompt(PROMPT_BASE)
    expect(off.system).not.toContain('候选清单之外')
    expect(off.system).not.toContain('externalKeywords')
    expect(off.system).not.toContain('搜索关键词')
    expect(off.system).not.toContain('BV')
    // 默认值与显式 0 逐字等价
    expect(buildRecommendPrompt({ ...PROMPT_BASE, externalLimit: 0 })).toEqual(off)
  })

  it('关闭时模型多给 externalKeywords 也不进结果', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2], ['晴天 周杰伦']))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT })

    expect(r.externalTracks).toEqual([])
    expect(r.externalStatus).toBe('disabled')
    // 有关键词也不该去搜
    expect(pickMock.pickExternalTracks).not.toHaveBeenCalled()
    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('开关打开：提示词要求搜索关键词，明确不要 BV 号', () => {
  const on = () => buildRecommendPrompt({ ...PROMPT_BASE, externalLimit: 8 })

  it('要求 3~5 组搜索关键词', () => {
    expect(on().system).toContain('3~5 组搜索关键词')
  })

  it('明确禁止给 BV 号，并说明程序会去搜索', () => {
    const system = on().system
    expect(system).toContain('不要给 BV 号')
    expect(system).toContain('程序会去搜索')
  })

  it('输出格式是 externalKeywords 数组', () => {
    expect(on().system).toContain('"externalKeywords"')
  })

  it('不再要求模型输出 bvid / title / external 数组（pre6 的旧格式已废弃）', () => {
    const system = on().system
    expect(system).not.toContain('"bvid"')
    expect(system).not.toContain('"external"')
    expect(system).not.toContain('编造的 BV 号会被校验直接丢弃')
  })

  it('池内规则没被挤掉，且编号连续不跳号', () => {
    const system = on().system
    expect(system).toContain('只能从候选清单里挑')
    expect(system).toContain('推荐 5 首左右')
    // 1..9 每条规则都该在，避免出现「5. …9. …5.」这种跳号
    for (let i = 1; i <= 9; i += 1) {
      expect(system).toContain('\n' + i + '. ')
    }
  })

  it('关闭时编号只到 5，没有 6~9 的池外规则', () => {
    const system = buildRecommendPrompt(PROMPT_BASE).system
    expect(system).toContain('\n5. ')
    expect(system).not.toContain('\n6. ')
    expect(system).not.toContain('\n9. ')
  })
})

describe('池内不减少：开关打开后池内仍是原样', () => {
  it('5 首且顺序不变', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2, 3, 4, 5], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockResolvedValue(
      pickResult([picked('BV1xx411c7mD', 'E1'), picked('BV1yy411c7mD', 'E2')], 2),
    )

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.tracks).toHaveLength(5)
    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(r.externalStatus).toBe('ok')
  })

  it('池外全部失败时池内也不受影响', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2, 3], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockRejectedValue(new Error('搜索接口 500'))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(r.reasons).toEqual({ a: 'r1', b: 'r2', c: 'r3' })
    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
  })
})

describe('调用约定：把关键词交给搜索，把 intent 与条数交给筛选', () => {
  it('第一个参数是模型给的关键词，不是 bvid/标题', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天 周杰伦', '粤语 慢歌']))

    await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(pickMock.pickExternalTracks).toHaveBeenCalledTimes(1)
    const [keywords, context] = pickMock.pickExternalTracks.mock.calls[0] as [
      string[],
      { intent: string; limit: number },
      AiSettings,
    ]
    expect(keywords).toEqual(['晴天 周杰伦', '粤语 慢歌'])
    // 条数用 ceil(5 × 1.5) = 8，而不是池内 5
    expect(context.limit).toBe(8)
    // intent 带上时段，供 AI 判断「搜索结果是否对题」
    expect(context.intent).toContain('晚上')
    expect(context.intent).toContain('20 点')
  })

  it('把 settings 原样传下去', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天']))
    const s = settings()
    await generateRecommendation({ settings: s, limit: 5, now: NIGHT, external: true })
    expect(pickMock.pickExternalTracks.mock.calls[0][2]).toBe(s)
  })

  it('模型一组关键词都没给 → 不去搜，直接 ai-failed', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2]))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(pickMock.pickExternalTracks).not.toHaveBeenCalled()
    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
    expect(r.tracks).toHaveLength(2)
  })
})

describe('Track 来源：title / bvid 来自搜索结果，不是模型', () => {
  it('外部 Track 逐字采用搜索结果的字段', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockResolvedValue(
      pickResult(
        [
          picked('BV1GJ411x7h7', '周杰伦《晴天》官方MV', {
            ownerName: '杰威尔音乐',
            coverUrl: 'https://example.com/real.jpg',
            duration: 252,
          }),
        ],
        1,
      ),
    )

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })
    const t = r.externalTracks?.[0]

    expect(t?.title).toBe('周杰伦《晴天》官方MV')
    expect(t?.bvid).toBe('BV1GJ411x7h7')
    expect(t?.artist).toBe('杰威尔音乐')
    expect(t?.coverUrl).toBe('https://example.com/real.jpg')
    expect(t?.duration).toBe(252)
    // id 稳定、不与池内撞车；池外没有播放量/收藏概念
    expect(t?.id).toBe('ext-BV1GJ411x7h7')
    expect(t?.playCount).toBe(0)
    expect(t?.isLiked).toBe(false)
    expect(t?.videoUrl).toBe('')
  })

  it('池外理由用 AI 筛选时给的原话', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockResolvedValue(
      pickResult([picked('BV1GJ411x7h7', '周杰伦《晴天》官方MV', { reason: '正是原曲' })], 1),
    )

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.reasons['ext-BV1GJ411x7h7']).toBe('正是原曲')
    // 池内理由不受影响
    expect(r.reasons.a).toBe('r1')
  })
})

describe('截断：池外不超过池内条数', () => {
  it('搜索 + 筛选给出 8 条时截断到 5 条', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2, 3, 4, 5], ['晴天 周杰伦']))
    const many = Array.from({ length: 8 }, (_, i) => picked('BV1xx411c7m' + i, 'E' + i))
    pickMock.pickExternalTracks.mockResolvedValue(pickResult(many, 12))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.externalTracks).toHaveLength(5)
    expect(r.externalTracks?.map((t) => t.bvid)).toEqual(many.slice(0, 5).map((m) => m.bvid))
    // considered 12、保留 5 → 丢弃 7
    expect(r.externalRejected).toBe(7)
    expect(r.externalStatus).toBe('ok')
  })

  it('不足池内条数时全保留', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天']))
    pickMock.pickExternalTracks.mockResolvedValue(
      pickResult([picked('BV1xx411c7mD', 'E1')], 9),
    )

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.externalTracks).toHaveLength(1)
    expect(r.externalRejected).toBe(8)
  })
})

describe('失败态：必须如实上报，不静默', () => {
  it('AI 筛选失败 → ai-failed', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockResolvedValue(pickResult([], 6, true))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
    // 参与筛选的 6 条全部没留下：丢弃计数如实上报（considered - kept）
    expect(r.externalRejected).toBe(6)
    expect(r.tracks.map((t) => t.id)).toEqual(['a'])
  })

  it('有候选但全被 AI 拒 → all-rejected，并带上丢弃条数', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockResolvedValue(pickResult([], 6, false))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.externalStatus).toBe('all-rejected')
    expect(r.externalTracks).toEqual([])
    expect(r.externalRejected).toBe(6)
    expect(r.tracks.map((t) => t.id)).toEqual(['a'])
  })

  it('搜索完全无结果 → all-rejected，丢弃 0 条', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1], ['不存在的歌']))
    pickMock.pickExternalTracks.mockResolvedValue(pickResult([], 0, false))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.externalStatus).toBe('all-rejected')
    expect(r.externalRejected).toBe(0)
  })

  it('pickExternalTracks 抛错 → 池内仍返回，状态 ai-failed', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1, 2], ['晴天 周杰伦']))
    pickMock.pickExternalTracks.mockRejectedValue(new Error('boom'))

    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT, external: true })

    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
  })

  it('关闭时也填齐两个池外字段（结构恒定，UI 不必写两套分支）', async () => {
    chatMock.aiChat.mockResolvedValue(modelReply([1]))
    const r = await generateRecommendation({ settings: settings(), limit: 5, now: NIGHT })
    expect(r.externalTracks).toEqual([])
    expect(r.externalRejected).toBe(0)
    expect(r.externalStatus).toBe('disabled')
  })
})

describe('默认值：池外推荐默认关闭', () => {
  it('AppSettings 的 aiExternalRecommend 默认 false', async () => {
    // 走真实模块（本文件把 storage mock 掉了），确认出厂默认是关
    const actual = await vi.importActual<typeof import('../src/utils/storage')>(
      '../src/utils/storage',
    )
    expect(actual.loadAppSettings().aiExternalRecommend).toBe(false)
  })
})

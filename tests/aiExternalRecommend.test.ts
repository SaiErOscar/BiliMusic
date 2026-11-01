// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import type { AiPlaylistCandidate } from '../src/services/aiPlaylist'
import type { VerifyResult } from '../src/services/videoVerify'
import type { AiSettings } from '../src/types'

// v1.4.14-pre6：池外推荐（曲库之外）。
//
// 用户给的四条硬要求在这里逐条落成断言：
//   1. 开关默认关闭，关闭时行为与现在完全一致（不发池外请求）；
//   2. 池内条数不减少；
//   3. 池外目标 = ceil(池内 × 1.5) 用于生成，验证后截断到池内条数；
//   4. 验证全失败时状态正确且 UI 有明确文案。

const verifyMock = vi.hoisted(() => ({
  verifyExternalCandidates: vi.fn(),
}))

vi.mock('../src/services/videoVerify', () => verifyMock)

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
  parseRecommendation,
} from '../src/services/aiRecommend'

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

/** 造一条验证通过的候选 */
function verified(bvid: string, title: string) {
  return {
    bvid,
    title,
    claimedTitle: title,
    coverUrl: '',
    ownerName: 'UP',
    duration: 100,
    matchReason: '标题相符',
  }
}

const POOL = [cand(1, 'a'), cand(2, 'b'), cand(3, 'c'), cand(4, 'd'), cand(5, 'e'), cand(6, 'f')]

/** 模型回复：5 首池内 + n 首池外 */
function reply(picks: number[], external: { title: string; bvid: string }[] = []): string {
  return JSON.stringify({
    greeting: '晚上好',
    picks: picks.map((i) => ({ index: i, reason: 'r' + i })),
    ...(external.length ? { external: external.map((e) => ({ ...e, reason: 'ext' })) } : {}),
  })
}

beforeEach(() => {
  poolMock.buildCandidatePool.mockReturnValue(POOL)
  chatMock.aiChat.mockReset()
  verifyMock.verifyExternalCandidates.mockReset()
  verifyMock.verifyExternalCandidates.mockResolvedValue({
    verified: [],
    rejected: [],
    aiFailed: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('池外目标条数 = ceil(池内 × 1.5)', () => {
  it('5 首池内要 8 首池外（5 × 1.5 = 7.5 向上取整）', () => {
    expect(externalTargetCount(5)).toBe(8)
  })

  it('偶数与奇数都按向上取整', () => {
    expect(externalTargetCount(4)).toBe(6)
    expect(externalTargetCount(6)).toBe(9)
    expect(externalTargetCount(1)).toBe(2)
  })

  it('非法条数不产生池外请求', () => {
    expect(externalTargetCount(0)).toBe(0)
    expect(externalTargetCount(-1)).toBe(0)
    expect(externalTargetCount(Number.NaN)).toBe(0)
  })
})

describe('开关关闭时行为与现在完全一致', () => {
  it('不调用验证器（不发任何池外请求）', async () => {
    chatMock.aiChat.mockResolvedValue(reply([1, 2, 3, 4, 5]))
    const r = await generateRecommendation({ settings: settings(), limit: 5 })
    expect(verifyMock.verifyExternalCandidates).not.toHaveBeenCalled()
    expect(r.externalTracks).toEqual([])
    expect(r.externalStatus).toBe('disabled')
  })

  it('显式传 external: false 同样不调用验证器', async () => {
    chatMock.aiChat.mockResolvedValue(reply([1, 2, 3, 4, 5]))
    await generateRecommendation({ settings: settings(), limit: 5, external: false })
    expect(verifyMock.verifyExternalCandidates).not.toHaveBeenCalled()
  })

  it('关闭时提示词不含任何池外段落（逐字回到旧版）', () => {
    const input = {
      settings: settings(),
      limit: 5,
      contextLabel: '晚上',
      hour: 20,
      profileContext: { profile: '', learned: '', liked: [], disliked: [] },
      portraitText: '',
      hasHistory: false,
      pool: POOL,
    }
    const off = buildRecommendPrompt(input)
    expect(off.system).not.toContain('候选清单之外')
    expect(off.system).not.toContain('external')
    expect(off.system).not.toContain('BV')
    // 默认值与显式 0 等价
    expect(buildRecommendPrompt({ ...input, externalLimit: 0 })).toEqual(off)
  })

  it('关闭时模型即使多给了 external 字段，也不进入结果', async () => {
    chatMock.aiChat.mockResolvedValue(
      reply([1, 2], [{ title: 'X', bvid: 'BV1xx411c7mD' }]),
    )
    const r = await generateRecommendation({ settings: settings(), limit: 5 })
    expect(r.externalTracks).toEqual([])
    expect(verifyMock.verifyExternalCandidates).not.toHaveBeenCalled()
  })
})

describe('开关打开时提示词要求真实 BV 号', () => {
  const base = {
    settings: settings(),
    limit: 5,
    contextLabel: '晚上',
    hour: 20,
    profileContext: { profile: '', learned: '', liked: [], disliked: [] },
    portraitText: '',
    hasHistory: false,
    pool: POOL,
  }

  it('写明池外条数与「另外」推荐', () => {
    const { system } = buildRecommendPrompt({ ...base, externalLimit: 8 })
    expect(system).toContain('候选清单之外')
    expect(system).toContain('8 首')
  })

  it('要求 BV 号真实存在，并说明编造会被校验丢弃', () => {
    const { system } = buildRecommendPrompt({ ...base, externalLimit: 8 })
    expect(system).toContain('BV')
    expect(system).toContain('编造的 BV 号会被校验直接丢弃')
    // 标题也要核对，避免「BV 真、歌不对」
    expect(system).toContain('真实标题核对')
  })

  it('输出格式里带 external 数组与 title/bvid/reason 三字段', () => {
    const { system } = buildRecommendPrompt({ ...base, externalLimit: 8 })
    expect(system).toContain('"external"')
    expect(system).toContain('"bvid"')
    expect(system).toContain('"title"')
  })

  it('池内规则保持原样（条数与「只能从候选清单里挑」没被挤掉）', () => {
    const { system } = buildRecommendPrompt({ ...base, externalLimit: 8 })
    expect(system).toContain('只能从候选清单里挑')
    expect(system).toContain('推荐 5 首左右')
  })
})

describe('池外候选解析', () => {
  it('取出 external 的 title/bvid/reason', () => {
    const r = parseRecommendation(
      reply([1], [{ title: '晴天 - 周杰伦', bvid: 'BV1xx411c7mD' }]),
      POOL,
    )
    expect(r.external).toHaveLength(1)
    expect(r.external[0]).toMatchObject({ title: '晴天 - 周杰伦', bvid: 'BV1xx411c7mD' })
  })

  it('缺 title 或 bvid 的条目直接跳过', () => {
    const r = parseRecommendation(
      JSON.stringify({
        picks: [{ index: 1 }],
        external: [
          { title: '有标题没 BV' },
          { bvid: 'BV1xx411c7mD' },
          { title: 'X', bvid: 'BV1yy411c7mD' },
        ],
      }),
      POOL,
    )
    expect(r.external.map((e) => e.bvid)).toEqual(['BV1yy411c7mD'])
  })

  it('重复 BV 号去重', () => {
    const r = parseRecommendation(
      JSON.stringify({
        picks: [{ index: 1 }],
        external: [
          { title: 'A', bvid: 'BV1xx411c7mD' },
          { title: 'B', bvid: 'BV1xx411c7mD' },
        ],
      }),
      POOL,
    )
    expect(r.external).toHaveLength(1)
  })

  it('没有 external 字段时为空数组（旧格式兼容）', () => {
    const r = parseRecommendation(reply([1, 2]), POOL)
    expect(r.external).toEqual([])
  })
})

describe('生成流程：池内不减少、池外截断、状态正确', () => {
  it('池内 5 首在开关打开后仍是 5 首且顺序不变', async () => {
    chatMock.aiChat.mockResolvedValue(
      reply([1, 2, 3, 4, 5], [
        { title: 'E1', bvid: 'BV1xx411c7mD' },
        { title: 'E2', bvid: 'BV1yy411c7mD' },
      ]),
    )
    verifyMock.verifyExternalCandidates.mockResolvedValue({
      verified: [verified('BV1xx411c7mD', 'E1'), verified('BV1yy411c7mD', 'E2')],
      rejected: [],
      aiFailed: false,
    } as VerifyResult)

    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    expect(r.tracks).toHaveLength(5)
    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(r.externalTracks?.map((t) => t.bvid)).toEqual(['BV1xx411c7mD', 'BV1yy411c7mD'])
    expect(r.externalStatus).toBe('ok')
  })

  it('向验证器请求 ceil(5 × 1.5) = 8 条，并截断到池内 5 条', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      title: 'E' + i,
      bvid: 'BV1xx411c7m' + i,
    }))
    chatMock.aiChat.mockResolvedValue(reply([1, 2, 3, 4, 5], many))
    // 验证器把 8 条全判为通过：结果必须截断到 5 条
    verifyMock.verifyExternalCandidates.mockResolvedValue({
      verified: many.map((m) => verified(m.bvid, m.title)),
      rejected: [],
      aiFailed: false,
    } as VerifyResult)

    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    expect(r.externalTracks).toHaveLength(5)
    expect(r.externalTracks?.map((t) => t.bvid)).toEqual(many.slice(0, 5).map((m) => m.bvid))
  })

  it('池外 Track 带上验证器的真实标题与 bvid', async () => {
    chatMock.aiChat.mockResolvedValue(
      reply([1], [{ title: '模型声称的标题', bvid: 'BV1xx411c7mD' }]),
    )
    verifyMock.verifyExternalCandidates.mockResolvedValue({
      verified: [verified('BV1xx411c7mD', '接口真实标题')],
      rejected: [],
      aiFailed: false,
    } as VerifyResult)

    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    const t = r.externalTracks?.[0]
    expect(t?.title).toBe('接口真实标题')
    expect(t?.bvid).toBe('BV1xx411c7mD')
    // id 稳定且不与池内 id 撞车
    expect(t?.id).toBe('ext-BV1xx411c7mD')
  })

  it('验证全部失败 → all-rejected，且池内结果不受影响', async () => {
    chatMock.aiChat.mockResolvedValue(
      reply([1, 2, 3], [{ title: 'X', bvid: 'BV1xx411c7mD' }]),
    )
    verifyMock.verifyExternalCandidates.mockResolvedValue({
      verified: [],
      rejected: [
        { bvid: 'BV1xx411c7mD', claimedTitle: 'X', reason: 'mismatch', detail: '不是同一首' },
      ],
      aiFailed: false,
    } as VerifyResult)

    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    expect(r.externalStatus).toBe('all-rejected')
    expect(r.externalTracks).toEqual([])
    expect(r.externalRejected).toBe(1)
    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('AI 核对失败且无通过项 → ai-failed', async () => {
    chatMock.aiChat.mockResolvedValue(
      reply([1], [{ title: 'X', bvid: 'BV1xx411c7mD' }]),
    )
    verifyMock.verifyExternalCandidates.mockResolvedValue({
      verified: [],
      rejected: [
        { bvid: 'BV1xx411c7mD', claimedTitle: 'X', reason: 'verify-failed', detail: 'AI 失败' },
      ],
      aiFailed: true,
    } as VerifyResult)

    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
  })

  it('模型一条池外都没给 → ai-failed，不静默', async () => {
    chatMock.aiChat.mockResolvedValue(reply([1, 2]))
    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
    // 没有候选就不该白跑一趟验证
    expect(verifyMock.verifyExternalCandidates).not.toHaveBeenCalled()
    expect(r.tracks).toHaveLength(2)
  })

  it('验证器抛错时池内结果仍然返回', async () => {
    chatMock.aiChat.mockResolvedValue(
      reply([1, 2], [{ title: 'X', bvid: 'BV1xx411c7mD' }]),
    )
    verifyMock.verifyExternalCandidates.mockRejectedValue(new Error('boom'))

    const r = await generateRecommendation({ settings: settings(), limit: 5, external: true })
    expect(r.tracks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(r.externalStatus).toBe('ai-failed')
    expect(r.externalTracks).toEqual([])
  })
})

describe('设置项与 UI 契约（读源码断言）', () => {
  const typesSrc = readFileSync(path.resolve(__dirname, '../src/types/index.ts'), 'utf8')
  const storageSrc = readFileSync(path.resolve(__dirname, '../src/utils/storage.ts'), 'utf8')
  const sheetSrc = readFileSync(
    path.resolve(__dirname, '../src/components/AiSettingsSheet.tsx'),
    'utf8',
  )
  const componentSrc = readFileSync(
    path.resolve(__dirname, '../src/components/DiscoverAiRecommend.tsx'),
    'utf8',
  )
  const cssSrc = readFileSync(path.resolve(__dirname, '../src/styles/index.css'), 'utf8')

  it('AppSettings 有 aiExternalRecommend 字段，默认 false', () => {
    expect(typesSrc).toContain('aiExternalRecommend: boolean')
    expect(storageSrc).toContain('aiExternalRecommend: false')
  })

  it('开关在推荐分区可见，且默认关闭（初值取 AppSettings）', () => {
    expect(sheetSrc).toContain('曲库之外的推荐')
    expect(sheetSrc).toContain('role="switch"')
    // 初值直接来自 AppSettings 默认值（false），不是硬编码 true
    expect(sheetSrc).toContain('loadAppSettings().aiExternalRecommend')
    expect(sheetSrc).toContain('aria-checked={externalOn}')
    expect(sheetSrc).toContain('updateAppSettings({ aiExternalRecommend:')
    // 说明会消耗更多额度
    expect(sheetSrc).toContain('会消耗更多额度')
    // 抽屉会被测试以普通函数调用，任何 hook 都会炸
    expect(sheetSrc).not.toContain('useAppSettings()')
  })

  it('发现页把开关透传给生成函数', () => {
    expect(componentSrc).toContain('external: externalOn')
    expect(componentSrc).toContain('appSettings.aiExternalRecommend')
  })

  it('验证全失败时 UI 有明确文案（不静默）', () => {
    expect(componentSrc).toContain('曲库外推荐暂未找到可信结果')
    expect(componentSrc).toContain("externalStatus === 'all-rejected'")
    expect(componentSrc).toContain("externalStatus === 'ai-failed'")
  })

  it('池外分组有视觉区分且复用 onPlayTrack', () => {
    expect(componentSrc).toContain('曲库之外')
    expect(componentSrc).toContain('discover-ai__item--external')
    expect(componentSrc).toContain('onPlayTrack(t)')
    // 对应样式真的追加进了 index.css
    expect(cssSrc).toContain('.discover-ai__external')
    expect(cssSrc).toContain('.discover-ai__item--external')
  })

  it('新增 CSS 只用已存在的 token', () => {
    const start = cssSrc.indexOf('/* ===== v1.4.14-pre6 池外推荐')
    expect(start).toBeGreaterThan(-1)
    const section = cssSrc.slice(start)
    const vars = Array.from(new Set(section.match(/var\((--[\w-]+)\)/g) || []))
    expect(vars.length).toBeGreaterThan(0)
    for (const v of vars) {
      const name = v.slice(4, -1)
      expect(cssSrc).toContain(name + ':')
    }
  })
})

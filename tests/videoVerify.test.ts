// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * v1.4.14-pre6 池外候选验证器：三步流水线（格式筛查 → 存在性 → 批量 AI 相符判断）。
 *
 * 这里只测逻辑，不发真实请求：getVideoDetail 与 aiChat 都被 vi.mock 顶掉，
 * 断言的是「哪一步该丢弃什么原因」「AI 到底被调了几次、每次几条」「标题取自哪里」。
 *
 * 特别守住的底线：AI 失败时整批丢弃，绝不降级为本地字符串相似度判断。
 */

const getVideoDetailMock = vi.fn()
vi.mock('../src/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/api')>()
  return { ...actual, getVideoDetail: (...args: unknown[]) => getVideoDetailMock(...args) }
})

const aiChatMock = vi.fn()
vi.mock('../src/services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai')>()
  return { ...actual, aiChat: (...args: unknown[]) => aiChatMock(...args) }
})

const {
  VERIFY_BATCH_SIZE,
  DETAIL_CONCURRENCY,
  isValidBvid,
  buildVerifyMessages,
  parseVerifyReply,
  verifyExternalCandidates,
} = await import('../src/services/videoVerify')

import type { AiSettings } from '../src/types'
import type { RawExternalCandidate, VerifyPair } from '../src/services/videoVerify'

const baseSettings: AiSettings = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  proxyMode: 'system',
  proxyUrl: '',
  recommendMode: 'click',
  userProfile: { text: '', updatedAt: '' },
  persona: '',
}

/** 造一个 getVideoDetail 的返回值 */
function videoInfo(bvid: string, title: string) {
  return {
    bvid,
    aid: 1,
    title,
    desc: '',
    pic: 'https://example.com/cover.jpg',
    ownerName: '某个UP',
    ownerMid: 42,
    duration: 215,
    cid: 100,
    stat: { view: 1, like: 1, favorite: 1 },
  }
}

/** 从发给模型的提示词里抠出这次问到的 bvid 列表 */
function bvidsInCall(call: unknown[]): string[] {
  const options = call[1] as { messages: { content: string }[] }
  const user = options.messages.map((m) => m.content).join('\n')
  return [...user.matchAll(/bvid: (BV[0-9A-Za-z]{10})/g)].map((m) => m[1])
}

/** 默认 AI 行为：对提示词里出现的每条都判相符 */
function replyAllMatch() {
  aiChatMock.mockImplementation((_settings: unknown, options: { messages: { content: string }[] }) => {
    const user = options.messages.map((m) => m.content).join('\n')
    const bvids = [...user.matchAll(/bvid: (BV[0-9A-Za-z]{10})/g)].map((m) => m[1])
    return Promise.resolve(
      JSON.stringify({
        results: bvids.map((bvid) => ({ bvid, match: true, reason: '标题一致' })),
      }),
    )
  })
}

beforeEach(() => {
  getVideoDetailMock.mockReset()
  aiChatMock.mockReset()
})

describe('isValidBvid', () => {
  it('只接受 BV + 10 位字母数字', () => {
    expect(isValidBvid('BV1GJ411x7h7')).toBe(true)
    expect(isValidBvid('  BV1GJ411x7h7  ')).toBe(true)
    expect(isValidBvid('bv1GJ411x7h7')).toBe(false)
    expect(isValidBvid('BV1GJ411x7h')).toBe(false)
    expect(isValidBvid('BV1GJ411x7h77')).toBe(false)
    expect(isValidBvid('BV1GJ411x7h!')).toBe(false)
    expect(isValidBvid('')).toBe(false)
  })
})

describe('buildVerifyMessages', () => {
  const pairs: VerifyPair[] = [
    { bvid: 'BV1GJ411x7h7', claimedTitle: '晴天', realTitle: '周杰伦《晴天》官方MV' },
  ]

  it('把接口真实标题与声称标题成对写进提示词', () => {
    const messages = buildVerifyMessages(pairs)
    const all = messages.map((m) => m.content).join('\n')
    expect(all).toContain('周杰伦《晴天》官方MV')
    expect(all).toContain('晴天')
    expect(all).toContain('BV1GJ411x7h7')
  })

  it('明确声明真实标题来自 B 站接口，且不需要 AI 判断 BV 号对错', () => {
    const all = buildVerifyMessages(pairs).map((m) => m.content).join('\n')
    expect(all).toContain('B 站接口')
    expect(all).toContain('不需要你判断对错')
    expect(all).toMatch(/JSON/)
  })

  it('空标题有占位，不会写出 undefined', () => {
    const all = buildVerifyMessages([{ bvid: 'BV1GJ411x7h7', claimedTitle: '', realTitle: 'x' }])
      .map((m) => m.content)
      .join('\n')
    expect(all).not.toContain('undefined')
    expect(all).toContain('（空）')
  })
})

describe('parseVerifyReply', () => {
  it('解析标准 JSON', () => {
    const out = parseVerifyReply('{"results":[{"bvid":"BV1GJ411x7h7","match":true,"reason":"一致"}]}')
    expect(out).toEqual([{ bvid: 'BV1GJ411x7h7', match: true, reason: '一致' }])
  })

  it('容忍代码围栏与前后废话', () => {
    const reply = '好的，结果如下：\n```json\n{"results":[{"bvid":"BV1GJ411x7h7","match":false,"reason":"不是同一首"}]}\n```\n以上。'
    const out = parseVerifyReply(reply)
    expect(out).toHaveLength(1)
    expect(out[0].match).toBe(false)
  })

  it('跳过字段不合法的单条，保留合法的', () => {
    const reply = JSON.stringify({
      results: [
        { bvid: 'BV1GJ411x7h7', match: true, reason: 'ok' },
        { bvid: '', match: true, reason: 'no bvid' },
        { bvid: 'BV1GJ411x7h8', match: 'yes' },
        { match: true },
      ],
    })
    const out = parseVerifyReply(reply)
    expect(out).toEqual([{ bvid: 'BV1GJ411x7h7', match: true, reason: 'ok' }])
  })

  it('结构不对时抛可读中文错误', () => {
    expect(() => parseVerifyReply('我觉得都挺像的')).toThrow('不是可解析的格式')
    expect(() => parseVerifyReply('{"foo":1}')).toThrow('不是可解析的格式')
    expect(() => parseVerifyReply('')).toThrow('不是可解析的格式')
  })
})

describe('verifyExternalCandidates 三步流水线', () => {
  it('格式非法 → bad-format，且一个请求都不发', async () => {
    const result = await verifyExternalCandidates(
      [
        { claimedTitle: '晴天', bvid: 'not-a-bvid' },
        { claimedTitle: '七里香', bvid: 'BV123' },
        { claimedTitle: '', bvid: '' },
      ],
      baseSettings,
    )

    expect(result.verified).toEqual([])
    expect(result.rejected.map((r) => r.reason)).toEqual(['bad-format', 'bad-format', 'bad-format'])
    expect(result.aiFailed).toBe(false)
    expect(getVideoDetailMock).not.toHaveBeenCalled()
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('接口抛错 → not-found，且不送 AI', async () => {
    getVideoDetailMock.mockRejectedValue(new Error('稿件不可见'))

    const result = await verifyExternalCandidates(
      [{ claimedTitle: '晴天', bvid: 'BV1GJ411x7h7' }],
      baseSettings,
    )

    expect(getVideoDetailMock).toHaveBeenCalledTimes(1)
    expect(aiChatMock).not.toHaveBeenCalled()
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toBe('not-found')
    expect(result.rejected[0].detail).toContain('稿件不可见')
    expect(result.aiFailed).toBe(false)
  })

  it('AI 判为不符 → mismatch，并带上 AI 给的理由', async () => {
    getVideoDetailMock.mockResolvedValue(videoInfo('BV1GJ411x7h7', '周杰伦《晴天》'))
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        results: [{ bvid: 'BV1GJ411x7h7', match: false, reason: '真实标题是另一首歌' }],
      }),
    )

    const result = await verifyExternalCandidates(
      [{ claimedTitle: '稻香', bvid: 'BV1GJ411x7h7' }],
      baseSettings,
    )

    expect(result.verified).toEqual([])
    expect(result.rejected[0].reason).toBe('mismatch')
    expect(result.rejected[0].detail).toBe('真实标题是另一首歌')
    expect(result.aiFailed).toBe(false)
  })

  it('AI 判为相符 → 通过，且 title 来自接口而非模型声称', async () => {
    getVideoDetailMock.mockResolvedValue(videoInfo('BV1GJ411x7h7', '周杰伦《晴天》官方MV'))
    aiChatMock.mockResolvedValue(
      JSON.stringify({ results: [{ bvid: 'BV1GJ411x7h7', match: true, reason: '同一个视频' }] }),
    )

    const result = await verifyExternalCandidates(
      [{ claimedTitle: '晴天 周杰伦', bvid: 'BV1GJ411x7h7' }],
      baseSettings,
    )

    expect(result.rejected).toEqual([])
    expect(result.verified).toHaveLength(1)
    const item = result.verified[0]
    expect(item.title).toBe('周杰伦《晴天》官方MV')
    expect(item.title).not.toBe('晴天 周杰伦')
    expect(item.claimedTitle).toBe('晴天 周杰伦')
    expect(item.coverUrl).toBe('https://example.com/cover.jpg')
    expect(item.ownerName).toBe('某个UP')
    expect(item.duration).toBe(215)
    expect(item.matchReason).toBe('同一个视频')
  })

  it('AI 调用失败 → 整批 verify-failed 且 aiFailed=true，绝不降级为本地判断', async () => {
    // 标题与接口返回完全一致，本地相似度必然判「相符」——这条就是降级陷阱
    getVideoDetailMock.mockResolvedValue(videoInfo('BV1GJ411x7h7', '晴天'))
    aiChatMock.mockRejectedValue(new Error('401 认证失败：API 密钥不正确或已失效'))

    const result = await verifyExternalCandidates(
      [{ claimedTitle: '晴天', bvid: 'BV1GJ411x7h7' }],
      baseSettings,
    )

    expect(result.verified).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toBe('verify-failed')
    expect(result.rejected[0].detail).toContain('401')
    expect(result.aiFailed).toBe(true)
  })

  it('AI 回复解析不出 → 同样 verify-failed 且 aiFailed=true', async () => {
    getVideoDetailMock.mockResolvedValue(videoInfo('BV1GJ411x7h7', '晴天'))
    aiChatMock.mockResolvedValue('这几条看着都挺像的')

    const result = await verifyExternalCandidates(
      [{ claimedTitle: '晴天', bvid: 'BV1GJ411x7h7' }],
      baseSettings,
    )

    expect(result.verified).toEqual([])
    expect(result.rejected[0].reason).toBe('verify-failed')
    expect(result.aiFailed).toBe(true)
  })

  it('AI 漏答某条 → 该条 verify-failed 并置 aiFailed，不猜', async () => {
    getVideoDetailMock.mockImplementation((bvid: string) =>
      Promise.resolve(videoInfo(bvid, '标题-' + bvid)),
    )
    aiChatMock.mockResolvedValue(
      JSON.stringify({ results: [{ bvid: 'BV1GJ411x7h7', match: true, reason: '一致' }] }),
    )

    const result = await verifyExternalCandidates(
      [
        { claimedTitle: 'A', bvid: 'BV1GJ411x7h7' },
        { claimedTitle: 'B', bvid: 'BV1GJ411x7h8' },
      ],
      baseSettings,
    )

    expect(result.verified.map((v) => v.bvid)).toEqual(['BV1GJ411x7h7'])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].bvid).toBe('BV1GJ411x7h8')
    expect(result.rejected[0].reason).toBe('verify-failed')
    expect(result.aiFailed).toBe(true)
  })

  it('超过 10 条自动分批：25 条合法候选 → 3 次 AI 请求，每批不超过 10', async () => {
    const candidates: RawExternalCandidate[] = Array.from({ length: 25 }, (_, i) => ({
      claimedTitle: '歌曲' + i,
      // 生成形如 BV1aa0000000 的合法 bvid
      bvid: 'BV1' + String(i).padStart(2, '0') + 'abcdefg'.slice(0, 7),
    }))
    getVideoDetailMock.mockImplementation((bvid: string) =>
      Promise.resolve(videoInfo(bvid, '真实标题-' + bvid)),
    )
    replyAllMatch()

    const result = await verifyExternalCandidates(candidates, baseSettings)

    expect(VERIFY_BATCH_SIZE).toBe(10)
    expect(aiChatMock).toHaveBeenCalledTimes(3)
    const sizes = aiChatMock.mock.calls.map((call) => bvidsInCall(call).length)
    expect(sizes).toEqual([10, 10, 5])
    expect(result.verified).toHaveLength(25)
    expect(result.rejected).toEqual([])
    expect(result.aiFailed).toBe(false)
  })

  it('重复 bvid 只验证一次', async () => {
    getVideoDetailMock.mockResolvedValue(videoInfo('BV1GJ411x7h7', '晴天'))
    aiChatMock.mockResolvedValue(
      JSON.stringify({ results: [{ bvid: 'BV1GJ411x7h7', match: true, reason: '一致' }] }),
    )

    const result = await verifyExternalCandidates(
      [
        { claimedTitle: '晴天', bvid: 'BV1GJ411x7h7' },
        { claimedTitle: '晴天（重复）', bvid: 'BV1GJ411x7h7' },
        { claimedTitle: '晴天（再重复）', bvid: ' BV1GJ411x7h7 ' },
      ],
      baseSettings,
    )

    expect(getVideoDetailMock).toHaveBeenCalledTimes(1)
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(result.verified).toHaveLength(1)
    expect(result.rejected).toEqual([])
  })

  it('getVideoDetail 并发不超过 DETAIL_CONCURRENCY', async () => {
    let inFlight = 0
    let peak = 0
    const candidates: RawExternalCandidate[] = Array.from({ length: 12 }, (_, i) => ({
      claimedTitle: '歌曲' + i,
      bvid: 'BV1' + String(i).padStart(2, '0') + 'abcdefg'.slice(0, 7),
    }))
    getVideoDetailMock.mockImplementation(async (bvid: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return videoInfo(bvid, '真实标题-' + bvid)
    })
    replyAllMatch()

    await verifyExternalCandidates(candidates, baseSettings)

    expect(DETAIL_CONCURRENCY).toBe(4)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('结果顺序与输入顺序一致（跨批次也不打乱）', async () => {
    const candidates: RawExternalCandidate[] = [
      { claimedTitle: '坏格式', bvid: 'bad' },
      { claimedTitle: 'A', bvid: 'BV1GJ411x7h7' },
      { claimedTitle: 'B', bvid: 'BV1GJ411x7h8' },
    ]
    getVideoDetailMock.mockImplementation((bvid: string) =>
      bvid === 'BV1GJ411x7h8'
        ? Promise.reject(new Error('稿件已删除'))
        : Promise.resolve(videoInfo(bvid, '标题-' + bvid)),
    )
    replyAllMatch()

    const result = await verifyExternalCandidates(candidates, baseSettings)

    expect(result.verified.map((v) => v.bvid)).toEqual(['BV1GJ411x7h7'])
    expect(result.rejected.map((r) => r.bvid)).toEqual(['bad', 'BV1GJ411x7h8'])
    expect(result.rejected.map((r) => r.reason)).toEqual(['bad-format', 'not-found'])
  })

  it('空输入不发请求', async () => {
    const result = await verifyExternalCandidates([], baseSettings)
    expect(result).toEqual({ verified: [], rejected: [], aiFailed: false })
    expect(getVideoDetailMock).not.toHaveBeenCalled()
    expect(aiChatMock).not.toHaveBeenCalled()
  })
})

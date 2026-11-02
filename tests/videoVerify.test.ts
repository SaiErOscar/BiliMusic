// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * v1.4.14-pre7 池外推荐：关键词 → searchVideo → AI 筛选。
 *
 * pre6 的做法（模型给「标题 + BV 号」→ 程序验证）已被证伪：BV 号是 B 站内部标识，
 * 模型没有可靠来源，只能编；验证再严也拦不住「存在但完全无关」。
 *
 * 现在模型只输出搜索关键词，ID 与标题**全部来自 searchVideo 的返回值**。
 * 这里守住三条底线：
 *   1. 候选字段只能来自接口，不能来自模型；
 *   2. 模型回抄的 bvid 只要不在候选集合里就丢弃（改一个字符也不放行）；
 *   3. AI 筛选失败时整批丢弃并置 aiFailed，**绝不降级为本地关键词匹配**。
 *
 * 不发真实请求：searchVideo 与 aiChat 都被 vi.mock 顶掉。
 */

const searchVideoMock = vi.fn()
vi.mock('../src/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/api')>()
  return { ...actual, searchVideo: (...args: unknown[]) => searchVideoMock(...args) }
})

const aiChatMock = vi.fn()
vi.mock('../src/services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai')>()
  return { ...actual, aiChat: (...args: unknown[]) => aiChatMock(...args) }
})

const {
  FILTER_BATCH_SIZE,
  SEARCH_CONCURRENCY,
  RESULTS_PER_KEYWORD,
  MAX_KEYWORDS,
  parseDurationText,
  collectSearchCandidates,
  buildFilterMessages,
  parseFilterReply,
  pickExternalTracks,
} = await import('../src/services/videoVerify')

import type { AiSettings } from '../src/types'
import type { SearchCandidate } from '../src/services/videoVerify'

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

/** 造一条 searchVideo 的返回条目（字段口径与 SearchItem 一致） */
function searchItem(
  bvid: string,
  title: string,
  extra: { author?: string; pic?: string; duration?: string } = {},
) {
  return {
    bvid,
    aid: 1,
    title,
    author: extra.author ?? 'UP-' + bvid,
    play: 1,
    duration: extra.duration ?? '04:12',
    pic: extra.pic ?? 'https://example.com/' + bvid + '.jpg',
  }
}

function searchResult(items: ReturnType<typeof searchItem>[]) {
  return { items, totalPages: 1, totalResults: items.length }
}

/** 生成形如 BV1aa0000000 的合法 bvid（BV + 10 位） */
function makeBvid(n: number): string {
  return 'BV1' + String(n).padStart(2, '0') + 'abcdefg'
}

/** 从一次筛选请求里抠出送去的候选 bvid（buildFilterMessages 写成 "[BVxxx] 标题"） */
function bvidsInFilterCall(call: unknown[]): string[] {
  const options = call[1] as { messages: { content: string }[] }
  const text = options.messages.map((m) => m.content).join('\n')
  return [...text.matchAll(/\[(BV[0-9A-Za-z]{10})\]/g)].map((m) => m[1])
}

/** 让 AI 把提示词里出现的候选全部判为保留 */
function keepEverything() {
  aiChatMock.mockImplementation((_settings: unknown, options: { messages: { content: string }[] }) => {
    const text = options.messages.map((m) => m.content).join('\n')
    const bvids = [...text.matchAll(/\[(BV[0-9A-Za-z]{10})\]/g)].map((m) => m[1])
    return Promise.resolve(
      JSON.stringify({ picks: bvids.map((bvid) => ({ bvid, reason: '标题对题' })) }),
    )
  })
}

function candidate(bvid: string, title: string, keyword = '关键词'): SearchCandidate {
  return {
    bvid,
    title,
    coverUrl: 'https://example.com/' + bvid + '.jpg',
    ownerName: '某个UP',
    duration: 252,
    keyword,
  }
}

beforeEach(() => {
  searchVideoMock.mockReset()
  aiChatMock.mockReset()
})

describe('parseDurationText', () => {
  it('mm:ss 与 hh:mm:ss 都转成秒', () => {
    expect(parseDurationText('04:12')).toBe(252)
    expect(parseDurationText('1:02:03')).toBe(3723)
    expect(parseDurationText('10:00')).toBe(600)
  })

  it('解析不了的输入返回 0，不抛错', () => {
    expect(parseDurationText('')).toBe(0)
    expect(parseDurationText('abc')).toBe(0)
    expect(parseDurationText('00:00')).toBe(0)
    expect(parseDurationText('12:ab')).toBe(0)
  })

  it('两端空白不影响解析', () => {
    expect(parseDurationText('  03:30  ')).toBe(210)
  })
})

describe('collectSearchCandidates：候选全部来自搜索接口', () => {
  it('bvid / title / coverUrl / ownerName / duration 逐字取自 searchVideo 返回值', async () => {
    searchVideoMock.mockResolvedValue(
      searchResult([
        searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV', {
          author: '某个UP',
          pic: 'https://example.com/cover.jpg',
          duration: '04:12',
        }),
      ]),
    )

    const out = await collectSearchCandidates(['晴天 周杰伦'])

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      bvid: 'BV1GJ411x7h7',
      title: '周杰伦《晴天》官方MV',
      coverUrl: 'https://example.com/cover.jpg',
      ownerName: '某个UP',
      duration: 252,
      keyword: '晴天 周杰伦',
    })
    // 标题来自接口，不是关键词本身
    expect(out[0].title).not.toBe('晴天 周杰伦')
  })

  it('按每个关键词取 RESULTS_PER_KEYWORD 条（第一页）', async () => {
    searchVideoMock.mockResolvedValue(searchResult([]))
    await collectSearchCandidates(['晴天'])
    expect(searchVideoMock).toHaveBeenCalledWith('晴天', 1, RESULTS_PER_KEYWORD)
    expect(RESULTS_PER_KEYWORD).toBe(8)
  })

  it('多个关键词汇总，同一 bvid 只保留一次', async () => {
    searchVideoMock.mockImplementation((keyword: string) => {
      if (keyword === '晴天 周杰伦') {
        return Promise.resolve(
          searchResult([
            searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV'),
            searchItem('BV1aa411x7h7', '晴天 翻唱合集'),
          ]),
        )
      }
      return Promise.resolve(
        searchResult([
          // 与第一个关键词重复命中的同一条
          searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV'),
          searchItem('BV1bb411x7h7', '晴天 吉他弹唱'),
        ]),
      )
    })

    const out = await collectSearchCandidates(['晴天 周杰伦', '晴天 翻唱'])

    const bvids = out.map((c) => c.bvid)
    expect(bvids).toHaveLength(3)
    expect(new Set(bvids).size).toBe(3)
    expect(bvids.filter((b) => b === 'BV1GJ411x7h7')).toHaveLength(1)
    expect(bvids).toEqual(expect.arrayContaining(['BV1GJ411x7h7', 'BV1aa411x7h7', 'BV1bb411x7h7']))
  })

  it('单个关键词失败不影响其它关键词', async () => {
    searchVideoMock.mockImplementation((keyword: string) => {
      if (keyword === '会失败的关键词') return Promise.reject(new Error('风控拦截'))
      return Promise.resolve(searchResult([searchItem('BV1GJ411x7h7', '周杰伦《晴天》')]))
    })

    const out = await collectSearchCandidates(['会失败的关键词', '晴天 周杰伦'])

    expect(searchVideoMock).toHaveBeenCalledTimes(2)
    expect(out.map((c) => c.bvid)).toEqual(['BV1GJ411x7h7'])
    expect(out[0].keyword).toBe('晴天 周杰伦')
  })

  it('关键词超过 MAX_KEYWORDS 被截断，只搜前几条', async () => {
    searchVideoMock.mockResolvedValue(searchResult([]))
    const many = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']

    await collectSearchCandidates(many)

    expect(MAX_KEYWORDS).toBe(5)
    expect(searchVideoMock).toHaveBeenCalledTimes(MAX_KEYWORDS)
    expect(searchVideoMock.mock.calls.map((c) => c[0])).toEqual(['k1', 'k2', 'k3', 'k4', 'k5'])
  })

  it('空白关键词被过滤，全空时一个请求都不发', async () => {
    expect(await collectSearchCandidates([])).toEqual([])
    expect(await collectSearchCandidates(['', '   '])).toEqual([])
    expect(searchVideoMock).not.toHaveBeenCalled()
  })

  it('并发不超过 SEARCH_CONCURRENCY', async () => {
    let inFlight = 0
    let peak = 0
    searchVideoMock.mockImplementation(async (keyword: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return searchResult([searchItem(makeBvid(Number(keyword.slice(1))), '歌-' + keyword)])
    })

    // 关键词数取满 MAX_KEYWORDS（5 个）：超过并发上限，才能看出是否被限制住
    const keywords = Array.from({ length: MAX_KEYWORDS }, (_, i) => 'k' + (i + 1))
    const out = await collectSearchCandidates(keywords)

    expect(SEARCH_CONCURRENCY).toBe(3)
    expect(peak).toBeLessThanOrEqual(SEARCH_CONCURRENCY)
    // 确实并行过，不是串行一个一个跑
    expect(peak).toBe(SEARCH_CONCURRENCY)
    expect(out).toHaveLength(MAX_KEYWORDS)
  })

  it('跳过没有 bvid 或标题为空的条目，标题里的高亮标签被剥掉', async () => {
    searchVideoMock.mockResolvedValue(
      searchResult([
        searchItem('', '没有 bvid'),
        searchItem('BV1cc411x7h7', ''),
        searchItem('BV1dd411x7h7', '<em class="keyword">晴天</em>周杰伦'),
      ]),
    )

    const out = await collectSearchCandidates(['晴天'])

    expect(out).toHaveLength(1)
    expect(out[0].bvid).toBe('BV1dd411x7h7')
    expect(out[0].title).toBe('晴天周杰伦')
  })
})

describe('buildFilterMessages', () => {
  const candidates = [
    candidate('BV1GJ411x7h7', '周杰伦《晴天》官方MV'),
    candidate('BV1aa411x7h7', '晴天 吉他弹唱'),
  ]
  const context = { intent: '晚上想听点安静的华语老歌', limit: 3 }

  it('把候选的真实标题与 bvid 写进用户消息', () => {
    const messages = buildFilterMessages(candidates, context)
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    const user = messages[1].content
    expect(user).toContain('周杰伦《晴天》官方MV')
    expect(user).toContain('晴天 吉他弹唱')
    expect(user).toContain('BV1GJ411x7h7')
    expect(user).toContain('BV1aa411x7h7')
  })

  it('带上用户意图与目标条数', () => {
    const all = buildFilterMessages(candidates, context).map((m) => m.content).join('\n')
    expect(all).toContain('晚上想听点安静的华语老歌')
    expect(all).toContain('3 条左右')
  })

  it('要求只能从列表里挑、不得编造或改动 bvid', () => {
    const system = buildFilterMessages(candidates, context)[0].content
    expect(system).toContain('只能从给出的列表里挑')
    expect(system).toContain('不得改动或编造')
    expect(system).toMatch(/JSON/)
  })

  it('要求没有合适的就返回空数组，不要硬凑', () => {
    const system = buildFilterMessages(candidates, context)[0].content
    expect(system).toContain('返回空数组')
    expect(system).toContain('不要硬凑')
  })
})

describe('parseFilterReply', () => {
  const allowed = new Set(['BV1GJ411x7h7', 'BV1aa411x7h7'])

  it('解析标准 JSON 并保留理由', () => {
    const out = parseFilterReply(
      '{"picks":[{"bvid":"BV1GJ411x7h7","reason":"就是这首"}]}',
      allowed,
    )
    expect(out).toEqual([{ bvid: 'BV1GJ411x7h7', keep: true, reason: '就是这首' }])
  })

  it('容忍代码围栏与前后废话', () => {
    const reply = [
      '好的，结果如下：',
      '```json',
      '{"picks":[{"bvid":"BV1aa411x7h7","reason":"翻唱也行"}]}',
      '```',
      '以上。',
    ].join('\n')
    const out = parseFilterReply(reply, allowed)
    expect(out).toHaveLength(1)
    expect(out[0].bvid).toBe('BV1aa411x7h7')
  })

  it('模型回抄的 bvid 不在 allowed 里 → 丢弃（改一个字符也不放行）', () => {
    const out = parseFilterReply(
      JSON.stringify({
        picks: [
          { bvid: 'BV1GJ411x7h7', reason: '真的存在' },
          // 与 allowed 里的 BV1aa411x7h7 只差最后一位
          { bvid: 'BV1aa411x7h8', reason: '编的' },
          { bvid: 'BV1zz411x7h7', reason: '凭空捏造' },
        ],
      }),
      allowed,
    )
    expect(out.map((j) => j.bvid)).toEqual(['BV1GJ411x7h7'])
  })

  it('重复 bvid 去重，只保留第一次', () => {
    const out = parseFilterReply(
      JSON.stringify({
        picks: [
          { bvid: 'BV1GJ411x7h7', reason: '第一次' },
          { bvid: 'BV1GJ411x7h7', reason: '第二次' },
          { bvid: ' BV1aa411x7h7 ', reason: '带空白' },
        ],
      }),
      allowed,
    )
    expect(out).toHaveLength(2)
    expect(out[0].reason).toBe('第一次')
    expect(out[1].bvid).toBe('BV1aa411x7h7')
  })

  it('缺 bvid 或结构不完整的单条被跳过，合法的保留', () => {
    const out = parseFilterReply(
      JSON.stringify({
        picks: [
          { reason: '没有 bvid' },
          { bvid: '', reason: '空 bvid' },
          null,
          42,
          { bvid: 'BV1GJ411x7h7' },
        ],
      }),
      allowed,
    )
    expect(out).toEqual([{ bvid: 'BV1GJ411x7h7', keep: true, reason: '' }])
  })

  it('picks 不是数组时返回空数组，而不是抛错', () => {
    expect(parseFilterReply('{"foo":1}', allowed)).toEqual([])
    expect(parseFilterReply('{"picks":"BV1GJ411x7h7"}', allowed)).toEqual([])
  })

  it('非 JSON / 结构错 → 抛可读中文错误', () => {
    expect(() => parseFilterReply('我觉得都挺像的', allowed)).toThrow('不是可解析的格式')
    expect(() => parseFilterReply('', allowed)).toThrow('不是可解析的格式')
    expect(() => parseFilterReply('{"picks": [}', allowed)).toThrow('不是合法 JSON')
  })
})

describe('pickExternalTracks：搜索 → AI 筛选', () => {
  it('正常流程：搜索出的候选经 AI 判定后返回，字段来自接口、理由来自 AI', async () => {
    searchVideoMock.mockResolvedValue(
      searchResult([
        searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV', { author: '某个UP' }),
        searchItem('BV1aa411x7h7', '晴天 吉他弹唱', { author: '吉他手' }),
        searchItem('BV1bb411x7h7', '晴天 架子鼓教学', { author: '鼓手' }),
      ]),
    )
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        picks: [
          { bvid: 'BV1GJ411x7h7', reason: '就是原曲' },
          { bvid: 'BV1aa411x7h7', reason: '安静的翻唱' },
        ],
      }),
    )

    const r = await pickExternalTracks(
      ['晴天 周杰伦'],
      { intent: '晚上想听点安静的', limit: 3 },
      baseSettings,
    )

    expect(r.aiFailed).toBe(false)
    expect(r.considered).toBe(3)
    expect(r.selected.map((s) => s.bvid)).toEqual(['BV1GJ411x7h7', 'BV1aa411x7h7'])
    expect(r.selected[0]).toEqual({
      bvid: 'BV1GJ411x7h7',
      title: '周杰伦《晴天》官方MV',
      coverUrl: 'https://example.com/BV1GJ411x7h7.jpg',
      ownerName: '某个UP',
      duration: 252,
      keyword: '晴天 周杰伦',
      reason: '就是原曲',
    })
  })

  it('AI 失败 → selected 为空且 aiFailed=true，绝不降级为本地关键词匹配', async () => {
    /*
     * 降级陷阱：候选标题里就含着关键词「晴天」，任何本地字符串匹配都会判「相关」。
     * 如果实现偷偷退回本地匹配，这条测试就会拿到一条结果。
     */
    searchVideoMock.mockResolvedValue(
      searchResult([searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV')]),
    )
    aiChatMock.mockRejectedValue(new Error('401 认证失败：API 密钥不正确或已失效'))

    const r = await pickExternalTracks(
      ['晴天 周杰伦'],
      { intent: '晚上想听点安静的', limit: 3 },
      baseSettings,
    )

    expect(r.selected).toEqual([])
    expect(r.aiFailed).toBe(true)
    expect(r.considered).toBe(1)
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })

  it('AI 回复解析不出 → 同样整批丢弃并置 aiFailed', async () => {
    searchVideoMock.mockResolvedValue(
      searchResult([searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV')]),
    )
    aiChatMock.mockResolvedValue('这几条看着都挺像的')

    const r = await pickExternalTracks(['晴天'], { intent: '随便', limit: 3 }, baseSettings)

    expect(r.selected).toEqual([])
    expect(r.aiFailed).toBe(true)
    expect(r.considered).toBe(1)
  })

  it('AI 把候选全判为不合适 → selected 为空但 aiFailed=false（不是失败）', async () => {
    searchVideoMock.mockResolvedValue(
      searchResult([searchItem('BV1GJ411x7h7', '晴天 架子鼓教学')]),
    )
    aiChatMock.mockResolvedValue(JSON.stringify({ picks: [] }))

    const r = await pickExternalTracks(['晴天'], { intent: '想听原曲', limit: 3 }, baseSettings)

    expect(r.selected).toEqual([])
    expect(r.aiFailed).toBe(false)
    expect(r.considered).toBe(1)
  })

  it('搜索无结果 → selected 空、considered=0、aiFailed=false，且不调 AI', async () => {
    searchVideoMock.mockResolvedValue(searchResult([]))

    const r = await pickExternalTracks(['不存在的东西'], { intent: '随便', limit: 3 }, baseSettings)

    expect(r).toEqual({ selected: [], considered: 0, aiFailed: false })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('模型给出的 bvid 不在候选里 → 该条被丢弃，不进入 selected', async () => {
    searchVideoMock.mockResolvedValue(
      searchResult([searchItem('BV1GJ411x7h7', '周杰伦《晴天》官方MV')]),
    )
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        picks: [
          { bvid: 'BV1GJ411x7h7', reason: '对' },
          { bvid: 'BV1xx411c7mD', reason: '编的' },
        ],
      }),
    )

    const r = await pickExternalTracks(['晴天'], { intent: '随便', limit: 3 }, baseSettings)

    expect(r.selected.map((s) => s.bvid)).toEqual(['BV1GJ411x7h7'])
    expect(r.aiFailed).toBe(false)
  })

  it('候选超过 FILTER_BATCH_SIZE 时分批送 AI', async () => {
    // 3 个关键词 × 8 条 = 24 条候选 → 10 + 10 + 4 三批
    searchVideoMock.mockImplementation((keyword: string) => {
      const base = Number(keyword.slice(1)) * 10
      const items = Array.from({ length: RESULTS_PER_KEYWORD }, (_, i) =>
        searchItem(makeBvid(base + i), '歌-' + keyword + '-' + i),
      )
      return Promise.resolve(searchResult(items))
    })
    keepEverything()

    const r = await pickExternalTracks(
      ['k1', 'k2', 'k3'],
      { intent: '随便', limit: 5 },
      baseSettings,
    )

    expect(FILTER_BATCH_SIZE).toBe(10)
    expect(r.considered).toBe(24)
    expect(aiChatMock).toHaveBeenCalledTimes(3)
    expect(aiChatMock.mock.calls.map((call) => bvidsInFilterCall(call).length)).toEqual([10, 10, 4])
    expect(r.selected).toHaveLength(24)
    expect(r.aiFailed).toBe(false)
  })

  it('任一批 AI 失败 → 整批作废，已成功批次的结果也不返回', async () => {
    searchVideoMock.mockImplementation((keyword: string) => {
      const base = Number(keyword.slice(1)) * 10
      return Promise.resolve(
        searchResult(
          Array.from({ length: RESULTS_PER_KEYWORD }, (_, i) =>
            searchItem(makeBvid(base + i), '歌-' + keyword + '-' + i),
          ),
        ),
      )
    })
    // 第一批成功，第二批抛错
    let call = 0
    aiChatMock.mockImplementation(() => {
      call += 1
      if (call === 2) return Promise.reject(new Error('超时'))
      const bvids = Array.from({ length: 10 }, (_, i) => makeBvid(10 + i))
      return Promise.resolve(JSON.stringify({ picks: bvids.map((bvid) => ({ bvid, reason: 'x' })) }))
    })

    const r = await pickExternalTracks(['k1', 'k2'], { intent: '随便', limit: 5 }, baseSettings)

    expect(r.selected).toEqual([])
    expect(r.aiFailed).toBe(true)
    expect(r.considered).toBe(16)
  })
})

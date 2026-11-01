// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
 * v1.4.14-pre4 播放页 AI 曲目解析：提示词约束、解析容错、缓存命中、未配置判定。
 *
 * 这里只测纯逻辑（不发真实请求）：aiChat 用 vi.mock 顶掉，
 * 断言的是「发给模型的话里有没有该有的约束」和「模型回什么我们会怎么处理」。
 */

const aiChatMock = vi.fn()
vi.mock('../src/services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai')>()
  return { ...actual, aiChat: (...args: unknown[]) => aiChatMock(...args) }
})

const {
  AI_INSIGHT_LYRIC_LINES,
  parseTrackInsight,
  prepareLyricSnippet,
  buildTrackInsightMessages,
  generateTrackInsight,
  isAiConfigured,
  createTrackInsightCache,
  insightCacheKey,
  loadTrackInsight,
} = await import('../src/services/aiTrackInsight')

import type { AiSettings } from '../src/types'

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

beforeEach(() => {
  aiChatMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('提示词约束', () => {
  it('明确告知 B 站标题含噪声，要求以歌名与歌手为主', () => {
    const [system] = buildTrackInsightMessages({ title: '【4K修复】夜曲 - 周杰伦', artist: '周杰伦' }, [])
    const text = system.content
    expect(text).toContain('噪声')
    expect(text).toContain('以歌名与歌手为主')
    // 「4K修复」「翻唱」这类词要被点名，模型才知道哪些算噪声
    expect(text).toContain('4K修复')
  })

  it('禁止编造歌手生平与发行事实', () => {
    const [system] = buildTrackInsightMessages({ title: '某首歌', artist: '某歌手' }, [])
    expect(system.content).toContain('不要编造歌手生平')
    expect(system.content).toContain('发行年份')
    expect(system.content).toContain('获奖记录')
  })

  it('要求说人话，不要套话', () => {
    const [system] = buildTrackInsightMessages({ title: '某首歌', artist: '某歌手' }, [])
    expect(system.content).toContain('说人话')
    expect(system.content).toContain('根据您提供的信息')
  })

  it('要求只输出 JSON，并给出字段格式', () => {
    const [system] = buildTrackInsightMessages({ title: '某首歌', artist: '某歌手' }, [])
    expect(system.content).toContain('只输出一个 JSON 对象')
    for (const key of ['summary', 'style', 'mood', 'scene', 'confidence']) {
      expect(system.content).toContain(key)
    }
  })

  it('有歌词时把片段写进 user 消息，并声明仅供参考', () => {
    const [, user] = buildTrackInsightMessages({ title: '晴天', artist: '周杰伦' }, ['故事的小黄花', '从出生那年就飘着'])
    expect(user.content).toContain('故事的小黄花')
    expect(user.content).toContain('仅供参考')
  })

  it('没有歌词时明确说明只按标题与歌手判断，并要求降置信度', () => {
    const [, user] = buildTrackInsightMessages({ title: '晴天', artist: '周杰伦' }, [])
    expect(user.content).toContain('没有歌词可用')
    expect(user.content).toContain('置信度请相应调低')
    expect(user.content).not.toContain('仅供参考')
  })

  it('歌手为空时写「未知」而不是留空', () => {
    const [, user] = buildTrackInsightMessages({ title: '晴天', artist: '' }, [])
    expect(user.content).toContain('（未知）')
  })
})

describe('歌词片段清洗', () => {
  it('去空行与首尾空白', () => {
    expect(prepareLyricSnippet(['  第一行 ', '', '   ', '第二行'])).toEqual(['第一行', '第二行'])
  })

  it('限制行数，避免整首词塞进上下文', () => {
    const many = Array.from({ length: 100 }, (_, i) => '第' + i + '行')
    expect(prepareLyricSnippet(many)).toHaveLength(AI_INSIGHT_LYRIC_LINES)
  })

  it('截断异常超长的单行', () => {
    const long = 'x'.repeat(500)
    expect(prepareLyricSnippet([long])[0].length).toBeLessThan(long.length)
  })

  it('undefined / 空数组返回空片段', () => {
    expect(prepareLyricSnippet(undefined)).toEqual([])
    expect(prepareLyricSnippet([])).toEqual([])
  })
})

describe('解析结果容错', () => {
  it('解析标准 JSON', () => {
    const r = parseTrackInsight('{"summary":"一首温柔的民谣","style":"民谣","mood":"怅然","scene":"深夜独处","confidence":0.8}')
    expect(r.summary).toBe('一首温柔的民谣')
    expect(r.style).toBe('民谣')
    expect(r.mood).toBe('怅然')
    expect(r.scene).toBe('深夜独处')
    expect(r.confidence).toBe(0.8)
  })

  it('容忍代码围栏与前后废话', () => {
    const r = parseTrackInsight('好的，结果如下：\n```json\n{"summary":"轻快","style":"流行"}\n```\n希望有帮助')
    expect(r.summary).toBe('轻快')
    expect(r.style).toBe('流行')
  })

  it('confidence 越界被夹到 0~1', () => {
    expect(parseTrackInsight('{"summary":"x","confidence":5}').confidence).toBe(1)
    expect(parseTrackInsight('{"summary":"x","confidence":-3}').confidence).toBe(0)
  })

  it('confidence 非数字时为 null（不显示假精度）', () => {
    expect(parseTrackInsight('{"summary":"x","confidence":"高"}').confidence).toBeNull()
    expect(parseTrackInsight('{"summary":"x"}').confidence).toBeNull()
  })

  it('不是 JSON 时抛可读错误', () => {
    expect(() => parseTrackInsight('我觉得这首歌很好听')).toThrow('不是可解析的格式')
  })

  it('JSON 里没有任何可用字段时抛错，不返回半空对象', () => {
    expect(() => parseTrackInsight('{"foo":"bar"}')).toThrow('没有给出可用的解析内容')
  })

  it('只有 style 也算可用（summary 可空）', () => {
    expect(parseTrackInsight('{"style":"电子"}').style).toBe('电子')
  })
})

describe('generateTrackInsight', () => {
  it('正常生成并标记 usedLyrics', async () => {
    aiChatMock.mockResolvedValue('{"summary":"轻快","style":"流行","mood":"开心","scene":"通勤","confidence":0.7}')
    const r = await generateTrackInsight({
      settings: baseSettings,
      track: { id: 'bv1', title: '晴天', artist: '周杰伦' },
      lyricSnippet: ['故事的小黄花'],
    })
    expect(r.style).toBe('流行')
    expect(r.usedLyrics).toBe(true)
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })

  it('没有歌词时 usedLyrics 为 false', async () => {
    aiChatMock.mockResolvedValue('{"summary":"x","style":"y"}')
    const r = await generateTrackInsight({ settings: baseSettings, track: { title: '晴天', artist: '' } })
    expect(r.usedLyrics).toBe(false)
  })

  it('标题为空时直接抛错，不发请求', async () => {
    await expect(generateTrackInsight({ settings: baseSettings, track: { title: '   ', artist: 'x' } }))
      .rejects.toThrow('没有标题')
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('模型回复无法解析时把错误抛给调用方（不静默吞掉）', async () => {
    aiChatMock.mockResolvedValue('抱歉，我不能判断')
    await expect(generateTrackInsight({ settings: baseSettings, track: { title: '晴天', artist: '周杰伦' } }))
      .rejects.toThrow('不是可解析的格式')
  })

  it('底层 aiChat 报错（如 401）原样上抛，由 UI 展示', async () => {
    aiChatMock.mockRejectedValue(new Error('401 认证失败：API 密钥不正确或已失效'))
    await expect(generateTrackInsight({ settings: baseSettings, track: { title: '晴天', artist: '周杰伦' } }))
      .rejects.toThrow('401 认证失败')
  })
})

describe('未配置判定', () => {
  it('OpenAI 兼容三件套齐全才算已配置', () => {
    expect(isAiConfigured(baseSettings)).toBe(true)
    expect(isAiConfigured({ ...baseSettings, apiKey: '' })).toBe(false)
    expect(isAiConfigured({ ...baseSettings, baseUrl: '' })).toBe(false)
    expect(isAiConfigured({ ...baseSettings, model: '' })).toBe(false)
  })

  it('WorkBuddy 只看 wbModel（账号凭据与三件套无关）', () => {
    const wb = { ...baseSettings, source: 'workbuddy' as const, baseUrl: '', apiKey: '', model: '' }
    expect(isAiConfigured({ ...wb, wbModel: 'wb-model' })).toBe(true)
    expect(isAiConfigured(wb)).toBe(false)
  })

  it('null / undefined 一律判未配置', () => {
    expect(isAiConfigured(null)).toBe(false)
    expect(isAiConfigured(undefined)).toBe(false)
  })
})

describe('会话内缓存', () => {
  it('同一首歌二次调用命中缓存，不重复请求', async () => {
    aiChatMock.mockResolvedValue('{"summary":"轻快","style":"流行"}')
    const cache = createTrackInsightCache()
    const opts = { settings: baseSettings, track: { id: 'bv-same', title: '晴天', artist: '周杰伦' } }

    const first = await loadTrackInsight(cache, opts)
    expect(first.cached).toBe(false)
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    const second = await loadTrackInsight(cache, opts)
    expect(second.cached).toBe(true)
    expect(second.insight.style).toBe('流行')
    // 关键断言：第二次没有产生新的请求
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })

  it('不同曲目各自请求，互不串用', async () => {
    aiChatMock.mockResolvedValueOnce('{"summary":"a","style":"民谣"}')
      .mockResolvedValueOnce('{"summary":"b","style":"摇滚"}')
    const cache = createTrackInsightCache()

    const a = await loadTrackInsight(cache, { settings: baseSettings, track: { id: 'a', title: 'A', artist: '' } })
    const b = await loadTrackInsight(cache, { settings: baseSettings, track: { id: 'b', title: 'B', artist: '' } })
    expect(a.insight.style).toBe('民谣')
    expect(b.insight.style).toBe('摇滚')
    expect(b.cached).toBe(false)
    expect(aiChatMock).toHaveBeenCalledTimes(2)
    expect(cache.size()).toBe(2)
  })

  it('失败的请求不写缓存，重试仍会重新请求', async () => {
    aiChatMock.mockRejectedValueOnce(new Error('超时')).mockResolvedValueOnce('{"summary":"ok","style":"电子"}')
    const cache = createTrackInsightCache()
    const opts = { settings: baseSettings, track: { id: 'c', title: 'C', artist: '' } }

    await expect(loadTrackInsight(cache, opts)).rejects.toThrow('超时')
    expect(cache.size()).toBe(0)

    const retry = await loadTrackInsight(cache, opts)
    expect(retry.cached).toBe(false)
    expect(retry.insight.style).toBe('电子')
    expect(aiChatMock).toHaveBeenCalledTimes(2)
  })

  it('缓存键优先用 track.id，缺失时退回 artist|title', () => {
    expect(insightCacheKey({ id: 'bv1', title: '晴天', artist: '周杰伦' })).toBe('bv1')
    expect(insightCacheKey({ title: '晴天', artist: '周杰伦' })).toBe('周杰伦|晴天')
    // 同一首歌的现场版/翻唱版是两个稿件，本就该分开缓存
    expect(insightCacheKey({ id: 'bv-live', title: '晴天', artist: '周杰伦' }))
      .not.toBe(insightCacheKey({ id: 'bv-studio', title: '晴天', artist: '周杰伦' }))
  })

  it('delete 掉某个键后该曲目重新请求，其它曲目仍命中（「重来」靠这个）', async () => {
    aiChatMock.mockResolvedValue('{"summary":"x","style":"y"}')
    const cache = createTrackInsightCache()
    const a = { settings: baseSettings, track: { id: 'a', title: 'A', artist: '' } }
    const b = { settings: baseSettings, track: { id: 'b', title: 'B', artist: '' } }
    await loadTrackInsight(cache, a)
    await loadTrackInsight(cache, b)
    expect(aiChatMock).toHaveBeenCalledTimes(2)

    cache.delete('a')
    const again = await loadTrackInsight(cache, a)
    expect(again.cached).toBe(false)
    expect(aiChatMock).toHaveBeenCalledTimes(3)

    const hit = await loadTrackInsight(cache, b)
    expect(hit.cached).toBe(true)
    expect(aiChatMock).toHaveBeenCalledTimes(3)
  })

  it('clear 后重新请求', async () => {
    aiChatMock.mockResolvedValue('{"summary":"x","style":"y"}')
    const cache = createTrackInsightCache()
    const opts = { settings: baseSettings, track: { id: 'd', title: 'D', artist: '' } }
    await loadTrackInsight(cache, opts)
    expect(cache.has('d')).toBe(true)
    cache.clear()
    expect(cache.has('d')).toBe(false)
    await loadTrackInsight(cache, opts)
    expect(aiChatMock).toHaveBeenCalledTimes(2)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

/*
 * v1.4.14-pre8 用户反馈第 1、2 项：
 * - 翻译要说明「这是歌词」、允许适当意译、并要求全曲译法一致；
 * - 常规长度整首一次发完（此前按 40 行分批，批与批互不可见 → 上下不统一）；
 * - 超长歌词才降级分批，且每批都带全曲语境；
 * - 中文歌的二次确认从系统原生对话框改为应用内抽屉。
 *
 * 只测纯逻辑与提示词内容，不发真实请求。
 */

const aiChatMock = vi.hoisted(() => vi.fn())
vi.mock('../src/services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai')>()
  return { ...actual, aiChat: (...args: unknown[]) => aiChatMock(...args) }
})

import {
  AI_LYRIC_BATCH,
  AI_LYRIC_OPENING_MAX,
  AI_LYRIC_SINGLE_PASS_MAX,
  batchRangeLabel,
  enhanceLyrics,
  planBatches,
  renderTranslatedGlossary,
} from '../src/services/aiLyrics'
import type { AiSettings } from '../src/types'
import type { LyricLine } from '../src/services/lyrics'

const AI_CONFIG = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' } as unknown as AiSettings

/** 造 n 行可翻译歌词 */
function makeLines(n: number): LyricLine[] {
  return Array.from({ length: n }, (_, i) => ({ time: i, text: 'line ' + (i + 1) }))
}

/** 模型回复：把每行译成「译 n」 */
function replyFor(batch: { index: number }[]): string {
  return JSON.stringify(batch.map((b) => ({ index: b.index, text: '译 ' + (b.index + 1) })))
}

/** 从一次 aiChat 调用的参数里取出 user 消息正文 */
function userContent(call: unknown[]): string {
  const opts = call[1] as { messages: { role: string; content: string }[] }
  return opts.messages.find((m) => m.role === 'user')!.content
}

/** 从一次 aiChat 调用的参数里取出 system 消息正文 */
function systemContent(call: unknown[]): string {
  const opts = call[1] as { messages: { role: string; content: string }[] }
  return opts.messages.find((m) => m.role === 'system')!.content
}

/** 从 user 正文里解析出本次送出的行（JSON 数组在「歌词：」之后） */
function sentLines(call: unknown[]): { index: number; text: string }[] {
  const content = userContent(call)
  const marker = content.lastIndexOf('歌词：\n')
  return JSON.parse(content.slice(marker + 4))
}

beforeEach(() => {
  aiChatMock.mockReset()
})

describe('翻译提示词（用户第 1 项：说明这是歌词 / 允许意译 / 全曲一致）', () => {
  it('明确告诉模型这是歌曲歌词，不是普通文本', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    await enhanceLyrics(AI_CONFIG, makeLines(5), 'translate', { title: 't', artist: 'a' })
    const system = systemContent(aiChatMock.mock.calls[0])
    expect(system).toContain('歌曲歌词')
    expect(system).toContain('不是普通文章')
  })

  it('允许适当意译（为押韵、语气、意境服务，不要求逐字对应）', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    await enhanceLyrics(AI_CONFIG, makeLines(5), 'translate', { title: 't', artist: 'a' })
    const system = systemContent(aiChatMock.mock.calls[0])
    expect(system).toContain('适当意译')
    expect(system).toContain('押韵')
    expect(system).toContain('不必逐字对应')
  })

  it('要求全曲术语、意象、语气一致，副歌重复处译成同样文字', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    await enhanceLyrics(AI_CONFIG, makeLines(5), 'translate', { title: 't', artist: 'a' })
    const system = systemContent(aiChatMock.mock.calls[0])
    expect(system).toContain('同一首作品')
    expect(system).toContain('保持同一种译法')
    expect(system).toContain('副歌')
  })
})

describe('常规长度整首一次发送（用户第 1 项：避免上下不统一）', () => {
  it('100 行歌词只调用一次 aiChat，且一次送出全部 100 行', async () => {
    const lines = makeLines(100)
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })

    const { result, totalBatches } = await enhanceLyrics(AI_CONFIG, lines, 'translate', { title: 't', artist: 'a' })

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(totalBatches).toBe(1)
    expect(sentLines(aiChatMock.mock.calls[0])).toHaveLength(100)
    expect(result.size).toBe(100)
  })

  it('整首直发时不带分批语境（没有跨批问题就不用解释）', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    await enhanceLyrics(AI_CONFIG, makeLines(60), 'translate', { title: 't', artist: 'a' })
    expect(userContent(aiChatMock.mock.calls[0])).not.toContain('同一首歌的不同片段')
  })

  it('空行不参与翻译，但不影响「整首一次发送」的判定', async () => {
    const lines: LyricLine[] = [
      { time: 0, text: 'a' },
      { time: 1, text: '' },
      { time: 2, text: 'b' },
    ]
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    const { result } = await enhanceLyrics(AI_CONFIG, lines, 'translate', { title: 't', artist: 'a' })
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(sentLines(aiChatMock.mock.calls[0])).toHaveLength(2)
    expect(result.size).toBe(2)
  })
})

describe('超长歌词降级分批（每批带全曲语境）', () => {
  const longLines = () => makeLines(AI_LYRIC_SINGLE_PASS_MAX + 20)

  it('超过阈值才分批，每批行数不超过 AI_LYRIC_BATCH', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    const total = AI_LYRIC_SINGLE_PASS_MAX + 20
    const expectedBatches = Math.ceil(total / AI_LYRIC_BATCH)
    const { totalBatches, result } = await enhanceLyrics(AI_CONFIG, longLines(), 'translate', { title: 't', artist: 'a' })
    expect(totalBatches).toBe(expectedBatches)
    expect(aiChatMock).toHaveBeenCalledTimes(expectedBatches)
    for (const call of aiChatMock.mock.calls) {
      expect(sentLines(call).length).toBeLessThanOrEqual(AI_LYRIC_BATCH)
    }
    expect(result.size).toBe(total)
  })

  it('每批都声明「你在翻译同一首歌的不同片段」并给出批序号与行号区间', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    await enhanceLyrics(AI_CONFIG, longLines(), 'translate', { title: 't', artist: 'a' })

    const total = Math.ceil((AI_LYRIC_SINGLE_PASS_MAX + 20) / AI_LYRIC_BATCH)
    const first = userContent(aiChatMock.mock.calls[0])
    const second = userContent(aiChatMock.mock.calls[1])
    // 每一批都要带语境，不只是第一批
    for (const call of aiChatMock.mock.calls) {
      const content = userContent(call)
      expect(content).toContain('同一首歌的不同片段')
      expect(content).toContain('保持术语、称呼、意象与语气一致')
      expect(content).toContain('全曲开头')
    }
    expect(first).toContain('第 1 / ' + total + ' 段')
    expect(second).toContain('第 2 / ' + total + ' 段')
    expect(second).toContain('第 ' + (AI_LYRIC_BATCH + 1) + '–')
  })

  it('第二批带上第一批已定的译法，避免另起一套', async () => {
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    await enhanceLyrics(AI_CONFIG, longLines(), 'translate', { title: 't', artist: 'a' })

    expect(userContent(aiChatMock.mock.calls[0])).not.toContain('前面段落已定的译法')
    const second = userContent(aiChatMock.mock.calls[1])
    expect(second).toContain('前面段落已定的译法')
    // 只带最近若干条（控制 token），但要包含紧邻本批的那条
    expect(second).toContain((AI_LYRIC_BATCH - 1) + ': 译 ' + AI_LYRIC_BATCH)
  })

  it('分批串行执行：第二批发出前第一批已返回（语境要吃到前批译文）', async () => {
    const order: number[] = []
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      const batch = JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))
      order.push(batch[0].index)
      return Promise.resolve(replyFor(batch))
    })
    await enhanceLyrics(AI_CONFIG, longLines(), 'translate', { title: 't', artist: 'a' })
    // 严格递增即串行：后一批的语境要吃前一批的译文，不能并发
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order[0]).toBe(0)
    expect(order[1]).toBe(AI_LYRIC_BATCH)
  })

  it('单批失败只丢该批，其余批次照常返回', async () => {
    aiChatMock.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    aiChatMock.mockImplementation((_c: unknown, opts: unknown) => {
      const msgs = (opts as { messages: { role: string; content: string }[] }).messages
      return Promise.resolve(replyFor(JSON.parse(msgs[1].content.slice(msgs[1].content.lastIndexOf('歌词：\n') + 4))))
    })
    const total = AI_LYRIC_SINGLE_PASS_MAX + 20
    const { failedBatches, result } = await enhanceLyrics(AI_CONFIG, longLines(), 'translate', { title: 't', artist: 'a' })
    expect(failedBatches).toBe(1)
    // 只丢第一批，其余照常返回
    expect(result.size).toBe(total - AI_LYRIC_BATCH)
  })
})

describe('分批工具函数', () => {
  it('不超阈值时返回单批（整首直发）', () => {
    const items = Array.from({ length: AI_LYRIC_SINGLE_PASS_MAX }, (_, i) => i)
    expect(planBatches(items)).toEqual([items])
  })

  it('超过阈值时按 AI_LYRIC_BATCH 切分', () => {
    const items = Array.from({ length: AI_LYRIC_SINGLE_PASS_MAX + 1 }, (_, i) => i)
    const batches = planBatches(items)
    expect(batches).toHaveLength(Math.ceil((AI_LYRIC_SINGLE_PASS_MAX + 1) / AI_LYRIC_BATCH))
    expect(batches[0]).toHaveLength(AI_LYRIC_BATCH)
  })

  it('空输入返回空数组', () => {
    expect(planBatches([])).toEqual([])
  })

  it('行号区间按 1 基显示，单行不带破折号', () => {
    expect(batchRangeLabel([{ index: 0 }, { index: 119 }])).toBe('第 1–120 行')
    expect(batchRangeLabel([{ index: 5 }])).toBe('第 6 行')
  })

  it('已译对照只取最近若干条，控制 token', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ index: i, text: 'x' + i }))
    const out = renderTranslatedGlossary(many, 3)
    expect(out.split('\n')).toHaveLength(3)
    expect(out).toContain('37: x37')
    expect(renderTranslatedGlossary([], 3)).toBe('')
  })

  it('全曲开头锚点只带前若干行', () => {
    expect(AI_LYRIC_OPENING_MAX).toBeLessThanOrEqual(10)
  })
})

describe('中文歌提醒改为应用内抽屉（用户第 2 项）', () => {
  const np = readFileSync(path.resolve(__dirname, '../src/components/NowPlaying.tsx'), 'utf8')

  it('不再使用系统原生对话框，也不使用 window.confirm', () => {
    expect(np).not.toContain('nativeDialog?.confirm')
    expect(np).not.toContain('nativeDialog.confirm')
    expect(np).not.toContain('window.confirm')
  })

  it('改用 ai-sheet 抽屉范式，并提供继续翻译 / 取消两个动作', () => {
    expect(np).toContain('ai-sheet-overlay')
    expect(np).toContain('ai-sheet__body')
    expect(np).toContain('继续翻译')
    expect(np).toContain('取消')
  })

  it('抽屉说明「这是中文歌曲」「意义有限」「消耗 API 额度」', () => {
    expect(np).toContain('这是中文歌曲')
    expect(np).toContain('翻译对中文歌意义有限')
    expect(np).toContain('会消耗 API 额度')
  })

  it('抽屉 portal 到 body：沉浸态歌词面板的 filter/overflow 会裁掉 fixed 定位', () => {
    expect(np).toContain('createPortal')
    expect(np).toContain('document.body')
  })

  it('中文歌只打开抽屉，不直接发起翻译', () => {
    // 检测到 zh 之后必须 setZhConfirmOpen(true) 并 return，翻译只在确认路径里跑
    expect(np).toContain('setZhConfirmOpen(true)')
    expect(np).toContain('runAiTranslate')
  })
})

describe('面向用户文案统一为「AI 翻译」', () => {
  const np = readFileSync(path.resolve(__dirname, '../src/components/NowPlaying.tsx'), 'utf8')

  it('按钮文案是「AI 翻译」，没有「AI 增强」残留', () => {
    expect(np).toContain("'AI 翻译'")
    expect(np).not.toContain('AI 增强')
  })

  it('内部标识符保持原名（不因改名波及 useLyrics）', () => {
    expect(np).toContain('hasAiEnhance')
    expect(np).toContain('applyAiEnhance')
  })
})

describe('确认抽屉样式为纯追加', () => {
  const css = readFileSync(path.resolve(__dirname, '../src/styles/index.css'), 'utf8')

  it('抽屉样式复用 ai-sheet 前缀，并只用已存在的 token', () => {
    expect(css).toContain('.ai-sheet--confirm')
    expect(css).toContain('.ai-sheet__btn--primary')
    expect(css).toContain('var(--color-primary)')
    expect(css).toContain('var(--font-body)')
  })
})

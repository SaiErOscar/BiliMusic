import { describe, it, expect, vi, beforeEach } from 'vitest'

// AI 批量清洗要能断言「发了几次请求、每次带了几条」，所以 mock 掉 aiChat。
// getAiConfig 也 mock：默认「已配置」，避免测试真的去碰主进程桥。
const aiChatMock = vi.hoisted(() => vi.fn())
const getAiConfigMock = vi.hoisted(() => vi.fn())
vi.mock('../src/services/ai', () => ({ aiChat: aiChatMock, getAiConfig: getAiConfigMock }))

import {
  cleanTrackTitle,
  cleanTrackTitles,
  cleanFilenameForDownload,
  cleanFilenamesForDownload,
  loadTitleCleanAiConfig,
  sanitizeFilename,
  planTitleCleanBatches,
  buildTitleCleanBatchMessages,
  parseCleanedTitleList,
  TITLE_CLEAN_BATCH_SIZE,
  TITLE_CLEAN_BATCH_SYSTEM_PROMPT,
  FILENAME_MAX_LENGTH,
} from '../src/services/titleClean'
import type { AiSettings } from '../src/types'

const AI_CONFIG = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' } as unknown as AiSettings

/** 把一组清洗结果打包成模型会返回的 JSON 数组文本 */
const replyFor = (items: { index: number; title: string }[]) => JSON.stringify(items)

/** 孤立代理对检测：合法的 emoji 由一对代理组成，不能只按区间判断 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

beforeEach(() => {
  aiChatMock.mockReset()
  getAiConfigMock.mockReset()
  getAiConfigMock.mockResolvedValue(AI_CONFIG)
})

describe('sanitizeFilename：文件名非法字符处理', () => {
  it('Windows 九类非法字符全部替换成下划线', () => {
    expect(sanitizeFilename('a\\b/c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('控制字符被剔除，不是替换成下划线', () => {
    expect(sanitizeFilename('稻香\u0000\u0007 - 周杰伦')).toBe('稻香 - 周杰伦')
  })

  it('收尾的点与空格去掉（Windows 会截断或直接拒绝）', () => {
    expect(sanitizeFilename('稻香. . ')).toBe('稻香')
  })

  it('超长按码点截断到上限，且不劈开 emoji 代理对', () => {
    const long = '歌'.repeat(FILENAME_MAX_LENGTH + 40)
    expect(Array.from(sanitizeFilename(long))).toHaveLength(FILENAME_MAX_LENGTH)

    // 一个 emoji 在 UTF-16 里占两个码元：按 length 截断会把它劈成孤立 surrogate
    const emoji = '🎵'.repeat(FILENAME_MAX_LENGTH + 1)
    const out = sanitizeFilename(emoji)
    expect(Array.from(out)).toHaveLength(FILENAME_MAX_LENGTH)
    expect(hasLoneSurrogate(out)).toBe(false)
  })

  it('空串与 Windows 保留设备名兜底，不返回空文件名', () => {
    expect(sanitizeFilename('')).toBe('未知曲目')
    expect(sanitizeFilename('   ')).toBe('未知曲目')
    expect(sanitizeFilename('CON')).toBe('CON_')
    expect(sanitizeFilename('nul')).toBe('nul_')
    expect(sanitizeFilename('COM1')).toBe('COM1_')
  })

  it('正常歌名原样通过，不误伤书名号与中文标点', () => {
    expect(sanitizeFilename('周杰伦 - 稻香（Live）')).toBe('周杰伦 - 稻香（Live）')
    expect(sanitizeFilename('《演员》- 薛之谦')).toBe('《演员》- 薛之谦')
  })
})

describe('批量清洗的批处理原语', () => {
  it('planTitleCleanBatches 按上限切批，空输入返回空数组', () => {
    expect(planTitleCleanBatches([])).toEqual([])
    const items = Array.from({ length: TITLE_CLEAN_BATCH_SIZE + 5 }, (_, i) => i)
    const batches = planTitleCleanBatches(items)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(TITLE_CLEAN_BATCH_SIZE)
    expect(batches[1]).toHaveLength(5)
  })

  it('批量提示词要求原样返回 index、禁止解释', () => {
    expect(TITLE_CLEAN_BATCH_SYSTEM_PROMPT).toContain('不得增删、改号或调换顺序')
    expect(TITLE_CLEAN_BATCH_SYSTEM_PROMPT).toContain('不要任何解释文字')
    expect(TITLE_CLEAN_BATCH_SYSTEM_PROMPT).toContain('只输出 JSON 数组')
  })

  it('一轮对话的 user 消息里确实装了多条标题', () => {
    const msgs = buildTitleCleanBatchMessages([
      { index: 0, title: 'A' },
      { index: 1, title: 'B' },
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(JSON.parse(msgs[1].content)).toEqual([
      { index: 0, title: 'A' },
      { index: 1, title: 'B' },
    ])
  })

  it('parseCleanedTitleList 容忍代码围栏与前后废话，只取数组', () => {
    expect(parseCleanedTitleList('好的，结果如下：\n[{"index":0,"title":"稻香"}]')).toEqual([
      { index: 0, title: '稻香' },
    ])
    expect(parseCleanedTitleList('\u0060\u0060\u0060json\n[{"index":0,"title":"稻香"}]\n\u0060\u0060\u0060')).toEqual([
      { index: 0, title: '稻香' },
    ])
  })

  it('parseCleanedTitleList 对坏数据一律返回空数组，不抛错', () => {
    expect(parseCleanedTitleList('')).toEqual([])
    expect(parseCleanedTitleList('不是 JSON')).toEqual([])
    expect(parseCleanedTitleList('[{"index":0}]')).toEqual([])
    expect(parseCleanedTitleList('["纯字符串"]')).toEqual([])
  })
})

describe('AC1 单曲下载：按 titleCleanMode 清洗文件名', () => {
  const raw = '【4K修复】周杰伦 - 稻香（Live）'

  it('rule 模式清洗文件名，且非法字符被处理', async () => {
    const name = await cleanFilenameForDownload(raw, { mode: 'rule' })
    expect(name).toBe('周杰伦 稻香')
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('ai 模式采用模型结果，并过一遍文件名合法性', async () => {
    // 模型吐了一个带非法字符的名字：下载侧必须还能落盘
    aiChatMock.mockResolvedValue('周杰伦 - 稻香/官方版')
    const name = await cleanFilenameForDownload(raw, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(name).toBe('周杰伦 - 稻香_官方版')
  })

  it('off 模式用原标题，但仍处理非法字符', async () => {
    const name = await cleanFilenameForDownload('稻香/周杰伦', { mode: 'off' })
    expect(name).toBe('稻香_周杰伦')
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('缺省模式读 settings.titleCleanMode', async () => {
    const name = await cleanFilenameForDownload(raw, { settings: { titleCleanMode: 'off' } })
    expect(name).toBe(raw)
  })
})

describe('AC2 批量下载：一次请求洗多首', () => {
  it('10 首只发 1 次请求，且请求里带着全部 10 条', async () => {
    const raws = Array.from({ length: 10 }, (_, i) => `【4K】歌手${i} - 歌曲${i} 1.${i}万播放`)
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      return replyFor(batch.map((b) => ({ index: b.index, title: `歌手${b.index} - 歌曲${b.index}` })))
    })

    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })

    // 关键断言：不是每首一次
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(aiChatMock.mock.calls[0][1].messages[1].content) as unknown[]
    expect(sent).toHaveLength(10)
    expect(out).toHaveLength(10)
    expect(out.every((r) => r.source === 'ai')).toBe(true)
    expect(out[0].title).toBe('歌手0 - 歌曲0')
  })

  it('结果顺序与入参一一对应（按下标取名，错位就是给错歌改名）', async () => {
    const raws = ['【4K】甲 - 一', '【4K】乙 - 二', '【4K】丙 - 三']
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      // 每条按自身原文清洗（保留原字符才过得了防幻觉校验）；故意倒序返回，
      // 调用方必须按 index 对回去，而不是按返回顺序摊开
      return replyFor(
        batch.slice().reverse().map((b) => ({ index: b.index, title: b.title.replace(/^【4K】/, '') })),
      )
    })
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(out.map((r) => r.title)).toEqual(['甲 - 一', '乙 - 二', '丙 - 三'])
  })

  it('超过上限才切批，且仍然是「每批一次」而不是「每首一次」', async () => {
    const n = TITLE_CLEAN_BATCH_SIZE + 5
    const raws = Array.from({ length: n }, (_, i) => `【4K】歌手${i} - 歌曲${i}`)
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      return replyFor(batch.map((b) => ({ index: b.index, title: `歌手${b.index} - 歌曲${b.index}` })))
    })
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(aiChatMock).toHaveBeenCalledTimes(2)
    expect(out).toHaveLength(n)
    expect(out.every((r) => r.source === 'ai')).toBe(true)
  })

  it('重复标题只洗一次，回填时按原下标摊开', async () => {
    const raws = ['【4K】甲 - 一', '【4K】甲 - 一', '【4K】乙 - 二']
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      return replyFor(batch.map((b) => ({ index: b.index, title: b.title.replace(/^【4K】/, '') })))
    })
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    // 去重后只有 2 条进请求（重复的那首不必再洗一遍）
    expect(JSON.parse(aiChatMock.mock.calls[0][1].messages[1].content)).toHaveLength(2)
    // 回填时按原下标摊开：两条重复项拿到同一份结果
    expect(out.map((r) => r.title)).toEqual(['甲 - 一', '甲 - 一', '乙 - 二'])
  })

  it('批量入口也返回文件名（含非法字符处理），供批量下载直接落盘', async () => {
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      // 模型吐了带非法字符（/）的名字：落盘前必须被替换掉
      return replyFor(
        batch.map((b) => ({ index: b.index, title: b.title.replace(/^【4K】/, '').replace(/ /g, '/') })),
      )
    })
    const names = await cleanFilenamesForDownload(['【4K】甲 - 一', '【4K】乙 - 二'], {
      mode: 'ai',
      aiConfig: AI_CONFIG,
    })
    expect(names).toEqual(['甲_-_一', '乙_-_二'])
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })
})

describe('AC3 AI 失败/不可信时退回规则清洗，下载不中断', () => {
  const raws = ['【4K修复】周杰伦 - 稻香（Live）', '【4K】五月天 - 温柔 3:45']

  it('单曲：请求抛错时静默退回规则结果，不抛异常', async () => {
    aiChatMock.mockRejectedValue(new Error('429 请求速率达到上限'))
    const r = await cleanTrackTitle(raws[0], { mode: 'ai', aiConfig: AI_CONFIG })
    expect(r).toEqual({ title: '周杰伦 稻香', source: 'ai-fallback-rule' })
  })

  it('单曲：模型编了个歌名（不可信）时退回规则结果', async () => {
    aiChatMock.mockResolvedValue('完全不相干的歌名')
    const r = await cleanTrackTitle(raws[0], { mode: 'ai', aiConfig: AI_CONFIG })
    expect(r.source).toBe('ai-fallback-rule')
    expect(r.title).toBe('周杰伦 稻香')
  })

  it('批量：请求抛错时整批退回规则清洗，仍返回可用文件名', async () => {
    aiChatMock.mockRejectedValue(new Error('请求超时'))
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(out.every((r) => r.source === 'ai-fallback-rule')).toBe(true)
    expect(out[0].title).toBe('周杰伦 稻香')
    expect(out[1].title).toBe('五月天 温柔')
  })

  it('批量：不可信的那一条退回，同批其它条仍采用模型结果', async () => {
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      return replyFor([
        { index: batch[0].index, title: '周杰伦 - 稻香' },
        // 第二条：与原文几乎无重叠，等于自己编了一个
        { index: batch[1].index, title: '完全不相干的歌名' },
      ])
    })
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(out[0]).toEqual({ title: '周杰伦 - 稻香', source: 'ai' })
    expect(out[1]).toEqual({ title: '五月天 温柔', source: 'ai-fallback-rule' })
  })

  it('批量：模型漏项时该条退回规则清洗，不产生空文件名', async () => {
    aiChatMock.mockResolvedValue('[{"index":0,"title":"周杰伦 - 稻香"}]')
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(out[0].source).toBe('ai')
    expect(out[1].source).toBe('ai-fallback-rule')
    expect(out[1].title).toBe('五月天 温柔')
  })

  it('批量：模型返回的不是 JSON 时整批退回，绝不抛错', async () => {
    aiChatMock.mockResolvedValue('抱歉，我无法完成这个任务')
    const out = await cleanTrackTitles(raws, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(out.every((r) => r.source === 'ai-fallback-rule')).toBe(true)
  })

  it('批量：多批中某一批失败，只影响该批', async () => {
    const n = TITLE_CLEAN_BATCH_SIZE + 3
    const many = Array.from({ length: n }, (_, i) => `【4K】歌手${i} - 歌曲${i}`)
    let call = 0
    aiChatMock.mockImplementation(async (_c: AiSettings, opts: { messages: { role: string; content: string }[] }) => {
      call += 1
      if (call === 1) throw new Error('第一批失败')
      const batch = JSON.parse(opts.messages[1].content) as { index: number; title: string }[]
      return replyFor(batch.map((b) => ({ index: b.index, title: `歌手${b.index} - 歌曲${b.index}` })))
    })
    const out = await cleanTrackTitles(many, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(out.slice(0, TITLE_CLEAN_BATCH_SIZE).every((r) => r.source === 'ai-fallback-rule')).toBe(true)
    expect(out.slice(TITLE_CLEAN_BATCH_SIZE).every((r) => r.source === 'ai')).toBe(true)
  })
})

describe('AC5 off/rule 模式不发 AI 请求', () => {
  it('批量：rule 模式一次请求都不发', async () => {
    const out = await cleanTrackTitles(['【4K】周杰伦 - 稻香', '【4K】五月天 - 温柔'], { mode: 'rule' })
    expect(out.every((r) => r.source === 'rule')).toBe(true)
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('批量：off 模式原样返回，一次请求都不发', async () => {
    const raws = ['【4K】周杰伦 - 稻香', '五月天 - 温柔']
    const out = await cleanTrackTitles(raws, { mode: 'off' })
    expect(out).toEqual(raws.map((title) => ({ title, source: 'off' })))
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('批量：settings 里是 rule 时同样不发请求', async () => {
    await cleanFilenamesForDownload(['【4K】周杰伦 - 稻香'], { settings: { titleCleanMode: 'rule' } })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('loadTitleCleanAiConfig 只在 ai 模式才去读配置', async () => {
    expect(await loadTitleCleanAiConfig('off')).toBeUndefined()
    expect(await loadTitleCleanAiConfig('rule')).toBeUndefined()
    expect(getAiConfigMock).not.toHaveBeenCalled()

    expect(await loadTitleCleanAiConfig('ai')).toBe(AI_CONFIG)
    expect(getAiConfigMock).toHaveBeenCalledTimes(1)
  })

  it('ai 模式但未配置时返回 undefined，调用方据此直接退回、不发请求', async () => {
    getAiConfigMock.mockResolvedValue({ baseUrl: '', model: '', apiKey: '' })
    expect(await loadTitleCleanAiConfig('ai')).toBeUndefined()

    const out = await cleanTrackTitles(['【4K】周杰伦 - 稻香'], { mode: 'ai' })
    expect(out[0].source).toBe('ai-fallback-rule')
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('getAiConfig 抛错时当作未配置，不让下载崩掉', async () => {
    getAiConfigMock.mockRejectedValue(new Error('主进程桥不可用'))
    expect(await loadTitleCleanAiConfig('ai')).toBeUndefined()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// AI 模式要能单测「不可信判定」而不真发请求：mock 掉 aiChat。
// 必须在使用前 hoist 声明，vitest 会把 vi.mock 提升到 import 之前。
const aiChatMock = vi.hoisted(() => vi.fn())
vi.mock('../src/services/ai', () => ({ aiChat: aiChatMock }))

import {
  cleanTrackTitle,
  cleanTitleByRule,
  isTrustworthyTitle,
  parseCleanedTitle,
  resolveTitleCleanMode,
  TITLE_CLEAN_SYSTEM_PROMPT,
} from '../src/services/titleClean'
import type { AiSettings } from '../src/types'

const AI_CONFIG = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' } as unknown as AiSettings

beforeEach(() => {
  aiChatMock.mockReset()
})

describe('cleanTitleByRule：典型 B 站噪声标题', () => {
  it('去掉【4K】这类画质前缀，保留歌手与歌名', () => {
    expect(cleanTitleByRule('【4K修复】周杰伦 - 稻香（Live）')).toBe('周杰伦 稻香')
    expect(cleanTitleByRule('【4K】邓紫棋《光年之外》官方MV 高音质')).toBe('邓紫棋 光年之外')
  })

  it('去掉【翻唱】/【中文字幕】这类版本与字幕标记', () => {
    expect(cleanTitleByRule('【翻唱】某某某 - 歌手名（Live）')).toBe('某某某 歌手名')
    expect(cleanTitleByRule('【中文字幕】君の名は。 - RADWIMPS / 前前前世')).toBe('君の名は RADWIMPS 前前前世')
  })

  it('去掉 emoji', () => {
    expect(cleanTitleByRule('🎵【纯享版】夜曲 - 周杰伦 高清无损')).toBe('夜曲 周杰伦')
  })

  it('去掉 UP 主前缀（括号段 / UP主： 标签 / 标签后紧跟的名字）', () => {
    expect(cleanTitleByRule('【某UP主】晴天 - 周杰伦 【官方MV】')).toBe('晴天 周杰伦')
    expect(cleanTitleByRule('UP主：某音乐区UP · 起风了 - 买辣椒也用券')).toBe('起风了 买辣椒也用券')
  })

  it('去掉尾部播放量与时长（cleanTitle 会把它们拆成孤立数字）', () => {
    expect(cleanTitleByRule('告白气球 周杰伦 1.2万播放')).toBe('告白气球 周杰伦')
    expect(cleanTitleByRule('五月天 - 温柔 [完整版] 3:45')).toBe('五月天 温柔')
    expect(cleanTitleByRule('【原创音乐】我的新歌 12.3万播放 03:21')).toBe('我的新歌')
  })

  it('去掉残留分辨率与列表计数前缀', () => {
    expect(cleanTitleByRule('薛之谦《演员》 - 官方版 1080P 超清')).toBe('薛之谦 演员')
    expect(cleanTitleByRule('【歌单】100首华语经典 一小时循环')).toBe('华语经典')
  })

  it('干净标题原样通过，且不误伤歌名里的数字与书名号', () => {
    expect(cleanTitleByRule('起风了 - 买辣椒也用券')).toBe('起风了 买辣椒也用券')
    // 【稻香】是歌名不是 UP 主：前缀规则不能把它削掉
    expect(cleanTitleByRule('【稻香】周杰伦')).toBe('稻香 周杰伦')
    expect(cleanTitleByRule('2002年的第一场雪 - 刀郎')).toBe('2002年的第一场雪 刀郎')
  })

  it('空输入返回空串，不抛错', () => {
    expect(cleanTitleByRule('')).toBe('')
    expect(cleanTitleByRule('   ')).toBe('')
  })

  it('整条标题都是噪声时退回原标题，不返回空串', () => {
    const out = cleanTitleByRule('【4K】')
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('isTrustworthyTitle：AI 返回的不可信判定（不发请求）', () => {
  const raw = '【4K修复】周杰伦 - 稻香（Live）'

  it('正常清洗结果可信', () => {
    expect(isTrustworthyTitle(raw, '周杰伦 - 稻香')).toBe(true)
  })

  it('空串不可信', () => {
    expect(isTrustworthyTitle(raw, '')).toBe(false)
    expect(isTrustworthyTitle(raw, '   ')).toBe(false)
  })

  it('长度超过原标题 1.5 倍（模型在解释/扩写）不可信', () => {
    const padded = '周杰伦 - 稻香 这是一首由周杰伦演唱的歌曲它来自专辑我很忙非常好听值得一听'
    expect(padded.length).toBeGreaterThan(raw.length * 1.5)
    expect(isTrustworthyTitle(raw, padded)).toBe(false)
  })

  it('与原标题字符重叠率过低（等于自己编了一个歌名）不可信', () => {
    expect(isTrustworthyTitle(raw, '完全不相干的歌名')).toBe(false)
  })

  it('多行或带引号包裹（没按「只输出标题」约定）不可信', () => {
    expect(isTrustworthyTitle(raw, '周杰伦 - 稻香\n解释：去掉了【4K】')).toBe(false)
    expect(isTrustworthyTitle(raw, '「周杰伦 - 稻香」')).toBe(false)
  })
})

describe('parseCleanedTitle：从模型回复里取出标题', () => {
  it('去掉「标题：」前缀与首尾引号', () => {
    expect(parseCleanedTitle('标题：周杰伦 - 稻香')).toBe('周杰伦 - 稻香')
    expect(parseCleanedTitle('「周杰伦 - 稻香」')).toBe('周杰伦 - 稻香')
  })

  it('容忍代码围栏，只取第一行非空内容', () => {
    expect(parseCleanedTitle('```\n周杰伦 - 稻香\n```')).toBe('周杰伦 - 稻香')
    expect(parseCleanedTitle('\n\n周杰伦 - 稻香\n多余的第二行')).toBe('周杰伦 - 稻香')
  })
})

describe('resolveTitleCleanMode：老用户兜底', () => {
  it('缺字段（undefined）按 rule 兜底', () => {
    expect(resolveTitleCleanMode(undefined)).toBe('rule')
  })

  it('非法值也按 rule 兜底，不抛错', () => {
    expect(resolveTitleCleanMode('')).toBe('rule')
    expect(resolveTitleCleanMode('aii')).toBe('rule')
    expect(resolveTitleCleanMode(null)).toBe('rule')
    expect(resolveTitleCleanMode(123)).toBe('rule')
  })

  it('三档合法值原样返回', () => {
    expect(resolveTitleCleanMode('off')).toBe('off')
    expect(resolveTitleCleanMode('rule')).toBe('rule')
    expect(resolveTitleCleanMode('ai')).toBe('ai')
  })
})

describe('cleanTrackTitle：模式分派与 source 标记', () => {
  const raw = '【4K修复】周杰伦 - 稻香（Live）'

  it('off 模式用原标题，不发请求', async () => {
    const r = await cleanTrackTitle(raw, { mode: 'off' })
    expect(r).toEqual({ title: raw, source: 'off' })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('rule 模式走程序清洗，不发请求', async () => {
    const r = await cleanTrackTitle(raw, { mode: 'rule' })
    expect(r).toEqual({ title: '周杰伦 稻香', source: 'rule' })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('AI 模式独立一次请求、只发一个标题、提示词禁止解释与加引号', async () => {
    aiChatMock.mockResolvedValue('周杰伦 - 稻香')
    const r = await cleanTrackTitle(raw, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(r).toEqual({ title: '周杰伦 - 稻香', source: 'ai' })

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const [config, options] = aiChatMock.mock.calls[0]
    expect(config).toBe(AI_CONFIG)
    const msgs = options.messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    // 提示词明确禁止解释与加引号
    expect(msgs[0].content).toContain('不要解释')
    expect(msgs[0].content).toContain('不要加引号')
    // 一次只洗一个标题：user 消息就是原标题本身
    expect(msgs[1]).toEqual({ role: 'user', content: raw })
  })

  it('AI 返回不可信时退回程序结果，source = ai-fallback-rule', async () => {
    aiChatMock.mockResolvedValue('完全不相干的歌名')
    const r = await cleanTrackTitle(raw, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(r).toEqual({ title: '周杰伦 稻香', source: 'ai-fallback-rule' })
  })

  it('AI 抛错（未配置/超时/401）时静默退回，不抛异常', async () => {
    aiChatMock.mockRejectedValue(new Error('未配置 API 密钥'))
    const r = await cleanTrackTitle(raw, { mode: 'ai', aiConfig: AI_CONFIG })
    expect(r).toEqual({ title: '周杰伦 稻香', source: 'ai-fallback-rule' })
  })

  it('AI 模式但没有可用配置时直接退回，不发请求', async () => {
    const r = await cleanTrackTitle(raw, { mode: 'ai' })
    expect(r).toEqual({ title: '周杰伦 稻香', source: 'ai-fallback-rule' })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('模式缺省时读 settings.titleCleanMode；老用户缺字段按 rule', async () => {
    const withMode = await cleanTrackTitle(raw, { settings: { titleCleanMode: 'off' } })
    expect(withMode.source).toBe('off')

    // 老用户：settings 里根本没有该字段
    const legacy = await cleanTrackTitle(raw, { settings: {} })
    expect(legacy).toEqual({ title: '周杰伦 稻香', source: 'rule' })
    expect(aiChatMock).not.toHaveBeenCalled()
  })
})

describe('提示词与常量', () => {
  it('system 提示词要求只输出标题、不改歌手名与歌名', () => {
    expect(TITLE_CLEAN_SYSTEM_PROMPT).toContain('只输出清洗后的标题本身')
    expect(TITLE_CLEAN_SYSTEM_PROMPT).toContain('不要改动歌手名与歌名本身的文字')
  })
})

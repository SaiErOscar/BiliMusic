// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
 * v1.4.14-pre5 对话式音乐助手 · 意图引擎。
 *
 * 只测纯逻辑（不发真实请求）：aiChat 用 vi.mock 顶掉，
 * 断言的是「发给模型的话里有没有该有的约束」和「模型回什么我们会怎么处理」。
 *
 * 覆盖三件 UI 最依赖的事：
 * 1. 六个 intent 都能解析出来；
 * 2. 任何畸形回复都不抛错（UI 要稳定拿到结果）；
 * 3. 指代消解不许编造曲名。
 */

const aiChatMock = vi.fn()
vi.mock('../src/services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ai')>()
  return { ...actual, aiChat: (...args: unknown[]) => aiChatMock(...args) }
})

const {
  ASSISTANT_INTENTS,
  ASSISTANT_ACTIONS,
  UNKNOWN_REPLY,
  isAssistantIntent,
  isAssistantAction,
  unknownPlan,
  clampConfidence,
  extractJsonObject,
  mentionsCurrentTrack,
  resolveReference,
  parsePlan,
  buildPlanMessages,
  planAssistantRequest,
  renderPlanHint,
  narrowActionParams,
} = await import('../src/services/aiChatAssistant')

// 动作注册表：只读引用，用于断言提示词确实拼进了清单、以及测试里取真实动作定义
const { renderActionsForPrompt, ASSISTANT_ACTIONS: ACTION_REGISTRY } =
  await import('../src/services/assistantActions')

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

/** 模型回复的构造器：省得每处都手写整串 JSON */
function modelSays(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

beforeEach(() => {
  aiChatMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('六个 intent 都能解析', () => {
  it('recommend：拿到 mood 与回应', () => {
    const plan = parsePlan(
      modelSays({ intent: 'recommend', reply: '给你找几首适合跑步的。', mood: '适合跑步，节奏快', confidence: 0.9 }),
      { text: '来点适合跑步的' },
    )
    expect(plan.intent).toBe('recommend')
    expect(plan.reply).toBe('给你找几首适合跑步的。')
    expect(plan.mood).toBe('适合跑步，节奏快')
    expect(plan.confidence).toBe(0.9)
  })

  it('playlist：拿到 mood', () => {
    const plan = parsePlan(
      modelSays({ intent: 'playlist', reply: '好，我来攒。', mood: '写作业听的，安静不吵', confidence: 0.85 }),
      { text: '帮我做个写作业听的歌单' },
    )
    expect(plan.intent).toBe('playlist')
    expect(plan.mood).toBe('写作业听的，安静不吵')
  })

  it('search：拿到 query', () => {
    const plan = parsePlan(
      modelSays({ intent: 'search', reply: '去 B 站搜一下。', query: '周杰伦 晴天', confidence: 0.8 }),
      { text: '帮我搜一下周杰伦的晴天' },
    )
    expect(plan.intent).toBe('search')
    expect(plan.query).toBe('周杰伦 晴天')
  })

  it('explain：拿到 subject', () => {
    const plan = parsePlan(
      modelSays({ intent: 'explain', reply: '我看看。', subject: '晴天', confidence: 0.7 }),
      { text: '晴天这首歌讲什么' },
    )
    expect(plan.intent).toBe('explain')
    expect(plan.subject).toBe('晴天')
  })

  it('control：四个动作都能解析', () => {
    for (const action of ['play', 'pause', 'next', 'prev'] as const) {
      const plan = parsePlan(modelSays({ intent: 'control', reply: '好。', action, confidence: 0.95 }), { text: action })
      expect(plan.intent).toBe('control')
      expect(plan.action).toBe(action)
    }
  })

  it('control 的非法 action 被丢弃，不塞进 plan', () => {
    const plan = parsePlan(modelSays({ intent: 'control', reply: '好。', action: 'stop', confidence: 0.9 }), { text: '停' })
    expect(plan.intent).toBe('control')
    expect(plan.action).toBeUndefined()
  })

  it('unknown：原样保留模型给的回应，置信度强制 0', () => {
    const plan = parsePlan(modelSays({ intent: 'unknown', reply: '你是想听歌还是想找视频？', confidence: 0.9 }), { text: '嗯' })
    expect(plan.intent).toBe('unknown')
    expect(plan.reply).toBe('你是想听歌还是想找视频？')
    expect(plan.confidence).toBe(0)
  })
})

describe('非法回复一律收敛成 unknown，且不抛错', () => {
  it('完全不是 JSON', () => {
    expect(() => parsePlan('我觉得你想听歌')).not.toThrow()
    const plan = parsePlan('我觉得你想听歌')
    expect(plan.intent).toBe('unknown')
    expect(plan.confidence).toBe(0)
    expect(plan.reply).toBe(UNKNOWN_REPLY)
  })

  it('残缺 JSON', () => {
    const plan = parsePlan('{"intent":"recommend", "reply":')
    expect(plan.intent).toBe('unknown')
    expect(plan.confidence).toBe(0)
  })

  it('JSON 但不是对象（数组 / 字符串 / null）', () => {
    expect(parsePlan('[1,2,3]').intent).toBe('unknown')
    expect(parsePlan('"recommend"').intent).toBe('unknown')
    expect(parsePlan('null').intent).toBe('unknown')
  })

  it('空回复', () => {
    expect(parsePlan('').intent).toBe('unknown')
    expect(parsePlan('   ').intent).toBe('unknown')
  })

  it('intent 不在六枚举内（自造意图名）', () => {
    const plan = parsePlan(modelSays({ intent: 'play_music', reply: '好', confidence: 0.9 }))
    expect(plan.intent).toBe('unknown')
    expect(plan.confidence).toBe(0)
  })

  it('intent 大小写不符也不做模糊纠正', () => {
    expect(parsePlan(modelSays({ intent: 'Recommend', confidence: 0.9 })).intent).toBe('unknown')
  })

  it('intent 缺失', () => {
    expect(parsePlan(modelSays({ reply: '好', confidence: 0.9 })).intent).toBe('unknown')
  })

  it('intent 是数字等非字符串', () => {
    expect(parsePlan(modelSays({ intent: 1, confidence: 0.9 })).intent).toBe('unknown')
  })

  it('容忍代码围栏与前后废话', () => {
    const plan = parsePlan('好的，结果如下：\n```json\n{"intent":"recommend","mood":"轻快","confidence":0.8}\n```\n希望有帮助', {
      text: '来点轻快的',
    })
    expect(plan.intent).toBe('recommend')
    expect(plan.mood).toBe('轻快')
  })

  it('isAssistantIntent / isAssistantAction 白名单判定', () => {
    for (const i of ASSISTANT_INTENTS) expect(isAssistantIntent(i)).toBe(true)
    expect(isAssistantIntent('play_music')).toBe(false)
    expect(isAssistantIntent(null)).toBe(false)
    expect(isAssistantIntent(3)).toBe(false)
    for (const a of ASSISTANT_ACTIONS) expect(isAssistantAction(a)).toBe(true)
    expect(isAssistantAction('stop')).toBe(false)
  })

  it('unknownPlan 的形状固定', () => {
    expect(unknownPlan()).toEqual({ intent: 'unknown', reply: UNKNOWN_REPLY, confidence: 0 })
    expect(unknownPlan('自定义').reply).toBe('自定义')
  })
})

describe('置信度夹紧', () => {
  it('越界被夹到 0~1', () => {
    expect(parsePlan(modelSays({ intent: 'recommend', confidence: 5 }), { text: 'x' }).confidence).toBe(1)
    expect(parsePlan(modelSays({ intent: 'recommend', confidence: -3 }), { text: 'x' }).confidence).toBe(0)
    expect(parsePlan(modelSays({ intent: 'recommend', confidence: 95 }), { text: 'x' }).confidence).toBe(1)
  })

  it('非数字按 0.5', () => {
    expect(parsePlan(modelSays({ intent: 'recommend', confidence: '高' }), { text: 'x' }).confidence).toBe(0.5)
    expect(parsePlan(modelSays({ intent: 'recommend' }), { text: 'x' }).confidence).toBe(0.5)
    expect(clampConfidence(Number.NaN)).toBe(0.5)
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0.5)
    expect(clampConfidence(null)).toBe(0.5)
    expect(clampConfidence('0.8')).toBe(0.5)
  })

  it('intent 为 unknown 时强制 0，即使模型给了高分', () => {
    expect(parsePlan(modelSays({ intent: 'unknown', confidence: 0.99 }), { text: '嗯' }).confidence).toBe(0)
  })

  it('0 与 1 两个端点原样保留', () => {
    expect(clampConfidence(0)).toBe(0)
    expect(clampConfidence(1)).toBe(1)
  })
})

describe('指代消解', () => {
  const current = { title: '晴天', artist: '周杰伦' }

  it('currentTrack 有值时，explain 把「这首」补成真实曲目', () => {
    const plan = parsePlan(modelSays({ intent: 'explain', reply: '我看看。', confidence: 0.8 }), {
      text: '这首是什么风格',
      currentTrack: current,
    })
    expect(plan.intent).toBe('explain')
    expect(plan.subject).toBe('晴天 - 周杰伦')
  })

  it('currentTrack 有值时，模型写的「像这首」被替换成真实曲目（保留其它限定）', () => {
    const plan = parsePlan(
      modelSays({ intent: 'recommend', reply: '好。', mood: '像这首一样快的', confidence: 0.8 }),
      { text: '推荐点像刚才那首的', currentTrack: current },
    )
    expect(plan.intent).toBe('recommend')
    expect(plan.mood).toContain('晴天 - 周杰伦')
    // 用户说过的「快」不能因为替换而丢掉
    expect(plan.mood).toContain('快')
    expect(plan.mood).not.toContain('这首')
  })

  it('currentTrack 有值时，模型没给 mood 也能补上', () => {
    const plan = parsePlan(modelSays({ intent: 'recommend', reply: '好。', confidence: 0.8 }), {
      text: '来点像刚才那首的',
      currentTrack: current,
    })
    expect(plan.mood).toContain('晴天 - 周杰伦')
  })

  it('「晴天这首歌讲什么」这类同位语不算悬空指代，照常解析', () => {
    const plan = parsePlan(
      modelSays({ intent: 'explain', reply: '我看看。', subject: '晴天', confidence: 0.8 }),
      { text: '晴天这首歌讲什么', currentTrack: null },
    )
    expect(plan.intent).toBe('explain')
    expect(plan.subject).toBe('晴天')
  })

  it('currentTrack 为空时，绝不编造曲名（explain）', () => {
    const plan = parsePlan(
      modelSays({ intent: 'explain', reply: '这首是…', subject: '刚才那首', confidence: 0.9 }),
      { text: '刚才那首是什么歌', currentTrack: null },
    )
    expect(plan.intent).toBe('unknown')
    expect(plan.confidence).toBe(0)
    // 关键：没有把「刚才那首」当成曲名塞出去
    expect(plan.subject).toBeUndefined()
    expect(plan.reply).not.toContain('《')
  })

  it('currentTrack 为空时，推荐类降置信度并说明，不编曲名', () => {
    const plan = parsePlan(modelSays({ intent: 'recommend', reply: '好。', mood: '像这首的风格', confidence: 0.9 }), {
      text: '推荐点像刚才那首的',
      currentTrack: null,
    })
    expect(plan.intent).toBe('recommend')
    expect(plan.confidence).toBeLessThanOrEqual(0.3)
    // 指代词不能原样漏给下游
    expect(plan.mood).toBeUndefined()
    expect(plan.reply).not.toContain('这首')
  })

  it('currentTrack 的 title 是空白串，等同于没有当前曲目', () => {
    const plan = parsePlan(modelSays({ intent: 'explain', reply: 'x', confidence: 0.9 }), {
      text: '这首呢',
      currentTrack: { title: '   ', artist: '某人' },
    })
    expect(plan.intent).toBe('unknown')
  })

  it('没有指代词、也没有 subject 的 explain 会被退回追问', () => {
    const plan = parsePlan(modelSays({ intent: 'explain', reply: '好的', confidence: 0.8 }), { text: '讲讲' })
    expect(plan.intent).toBe('unknown')
    expect(plan.reply).toContain('哪首')
  })

  it('mentionsCurrentTrack 只认明确的指代词', () => {
    expect(mentionsCurrentTrack('来点像刚才那首的')).toBe(true)
    expect(mentionsCurrentTrack('这首怎么样')).toBe(true)
    expect(mentionsCurrentTrack('推荐点适合跑步的')).toBe(false)
    expect(mentionsCurrentTrack('')).toBe(false)
  })

  it('resolveReference 保留上下文，只换指代词', () => {
    expect(resolveReference('像刚才那首一样安静', '晴天 - 周杰伦')).toBe('像晴天 - 周杰伦一样安静')
    expect(resolveReference('', '晴天')).toBe('')
    expect(resolveReference('像这首', '')).toBe('像这首')
  })
})

describe('提示词约束', () => {
  const messages = buildPlanMessages({ text: '来点适合跑步的', currentTrack: null })
  const system = messages[0].content

  it('要求只输出 JSON，且说明不要代码围栏', () => {
    expect(system).toContain('只输出一个 JSON 对象')
    expect(system).toContain('代码围栏')
  })

  it('把六个 intent 全部列进提示词，并要求不在其中一律 unknown', () => {
    for (const intent of ASSISTANT_INTENTS) expect(system).toContain(intent)
    expect(system).toContain('不在其中一律输出 unknown')
  })

  it('含「不要编造」这类事实纪律', () => {
    expect(system).toContain('不要编造')
    expect(system).toContain('不要编造用户没说过的偏好')
    expect(system).toContain('不要编造曲名')
  })

  it('要求指代落到当前播放，且当前播放为空时不许编曲名', () => {
    expect(system).toContain('刚才那首')
    expect(system).toContain('当前播放')
    expect(system).toContain('不要凭空填一个曲名')
  })

  it('要求拿不准就 unknown，而不是硬猜', () => {
    expect(system).toContain('拿不准就输出 unknown')
    expect(system).toContain('硬猜比说不知道更糟')
  })

  it('四个播放动作写进提示词', () => {
    for (const action of ASSISTANT_ACTIONS) expect(system).toContain(action)
  })

  it('有当前曲目时写进 user 消息', () => {
    const [, user] = buildPlanMessages({ text: '这首呢', currentTrack: { title: '晴天', artist: '周杰伦' } })
    expect(user.content).toContain('当前播放：晴天 - 周杰伦')
  })

  it('无当前曲目时明确写「（无）」，不给模型脑补空间', () => {
    const [, user] = buildPlanMessages({ text: '这首呢', currentTrack: null })
    expect(user.content).toContain('当前播放：（无）')
  })

  it('时段标签有则写入，无则不留空行', () => {
    const [, withTime] = buildPlanMessages({ text: 'x', timeLabel: '晚上' })
    expect(withTime.content).toContain('当前时段：晚上')
    const [, without] = buildPlanMessages({ text: 'x' })
    expect(without.content).not.toContain('当前时段')
  })

  it('用户原话原样带进 user 消息', () => {
    const [, user] = buildPlanMessages({ text: '  帮我做个写作业听的歌单  ' })
    expect(user.content).toContain('帮我做个写作业听的歌单')
  })
})

describe('planAssistantRequest', () => {
  it('正常路径：发一次请求并把模型回复解析成 plan', async () => {
    aiChatMock.mockResolvedValue(modelSays({ intent: 'recommend', reply: '给你挑几首。', mood: '适合跑步', confidence: 0.88 }))
    const plan = await planAssistantRequest({ text: '来点适合跑步的' }, baseSettings)
    expect(plan.intent).toBe('recommend')
    expect(plan.mood).toBe('适合跑步')
    expect(plan.confidence).toBe(0.88)
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })

  it('空输入不发请求，直接返回可渲染的结果', async () => {
    const plan = await planAssistantRequest({ text: '   ' }, baseSettings)
    expect(plan.intent).toBe('unknown')
    expect(plan.confidence).toBe(0)
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it('模型返回垃圾不抛错，返回 unknown', async () => {
    aiChatMock.mockResolvedValue('抱歉，我不确定')
    await expect(planAssistantRequest({ text: '嗯' }, baseSettings)).resolves.toMatchObject({ intent: 'unknown', confidence: 0 })
  })

  it('底层 aiChat 报错（401）也不抛错，把原因写进 reply', async () => {
    aiChatMock.mockRejectedValue(new Error('401 认证失败：API 密钥不正确或已失效'))
    const plan = await planAssistantRequest({ text: '来点歌' }, baseSettings)
    expect(plan.intent).toBe('unknown')
    expect(plan.confidence).toBe(0)
    expect(plan.reply).toContain('401')
  })

  it('调用时把 currentTrack 一起交给提示词构造', async () => {
    aiChatMock.mockResolvedValue(modelSays({ intent: 'explain', reply: 'x', confidence: 0.8 }))
    const plan = await planAssistantRequest(
      { text: '这首是什么风格', currentTrack: { title: '晴天', artist: '周杰伦' } },
      baseSettings,
    )
    expect(plan.subject).toBe('晴天 - 周杰伦')
    const messages = aiChatMock.mock.calls[0][1].messages as { role: string; content: string }[]
    expect(messages[1].content).toContain('晴天 - 周杰伦')
  })
})

describe('renderPlanHint', () => {
  it('有 mood 时渲染成下游可用的补充指令', () => {
    const hint = renderPlanHint({ intent: 'recommend', reply: '好', mood: '适合跑步，节奏快', confidence: 0.9 })
    expect(hint).toContain('适合跑步，节奏快')
    expect(hint).toContain('用户的额外要求')
  })

  it('无补充信息时返回空串（下游据此不加任何提示）', () => {
    expect(renderPlanHint({ intent: 'control', reply: '好', action: 'next', confidence: 0.9 })).toBe('')
    expect(renderPlanHint({ intent: 'recommend', reply: '好', confidence: 0.9 })).toBe('')
    expect(renderPlanHint({ intent: 'unknown', reply: '嗯', confidence: 0 })).toBe('')
  })

  it('search 的 query 也算补充线索', () => {
    const hint = renderPlanHint({ intent: 'search', reply: '好', query: '周杰伦', confidence: 0.8 })
    expect(hint).toContain('周杰伦')
  })

  it('mood 与 subject 同时存在时都带上', () => {
    const hint = renderPlanHint({ intent: 'playlist', reply: '好', mood: '安静', subject: '晴天', confidence: 0.8 })
    expect(hint).toContain('安静')
    expect(hint).toContain('晴天')
  })
})

describe('extractJsonObject', () => {
  it('从围栏里抠出对象', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('抠不出来时返回 null，不抛错', () => {
    expect(extractJsonObject('没有 JSON')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('{坏的}')).toBeNull()
    expect(extractJsonObject('[]')).toBeNull()
  })
})

/* ================= v1.4.14-pre9：动作识别 ================= */

describe('动作识别：intent=action 与参数抽取', () => {
  it('识别注册表里的动作，并把 actionId 与合法参数带出来', () => {
    const plan = parsePlan(
      modelSays({
        intent: 'action',
        actionId: 'playback.volume',
        params: { volume: 60 },
        reply: '音量调到 60。',
        confidence: 0.9,
      }),
      { text: '音量调到60' },
    )
    expect(plan.intent).toBe('action')
    expect(plan.actionId).toBe('playback.volume')
    expect(plan.params).toEqual({ volume: 60 })
    expect(plan.reply).toBe('音量调到 60。')
    expect(plan.confidence).toBe(0.9)
  })

  it('枚举参数取值合法时原样保留', () => {
    const plan = parsePlan(
      modelSays({ intent: 'action', actionId: 'playback.repeat', params: { mode: 'one' }, confidence: 0.8 }),
      { text: '单曲循环' },
    )
    expect(plan.intent).toBe('action')
    expect(plan.params).toEqual({ mode: 'one' })
  })

  it('无参数动作（playback.next）也能识别，且不硬塞空 params', () => {
    const plan = parsePlan(
      modelSays({ intent: 'action', actionId: 'playback.next', confidence: 0.95 }),
      { text: '下一首' },
    )
    expect(plan.intent).toBe('action')
    expect(plan.actionId).toBe('playback.next')
    expect(plan.params).toBeUndefined()
  })

  it('多参数动作：布尔参数被正确收窄', () => {
    const plan = parsePlan(
      modelSays({
        intent: 'action',
        actionId: 'export.mv-single',
        params: { watermark: true, cleanExport: false },
        confidence: 0.8,
      }),
      { text: '导出无控件MV' },
    )
    expect(plan.intent).toBe('action')
    expect(plan.params).toEqual({ watermark: true, cleanExport: false })
  })

  it('模型没给 reply 时按动作名兜底一句人话', () => {
    const plan = parsePlan(modelSays({ intent: 'action', actionId: 'playback.next', confidence: 0.9 }), { text: '下一首' })
    expect(plan.reply).toContain('下一首')
  })
})

describe('动作识别：actionId 不存在时降级 unknown', () => {
  it('编造的 actionId 不进入 plan，降级为 unknown 且不抛错', () => {
    expect(() =>
      parsePlan(modelSays({ intent: 'action', actionId: 'playback.mute', params: {}, confidence: 0.9 })),
    ).not.toThrow()
    const plan = parsePlan(modelSays({ intent: 'action', actionId: 'playback.mute', confidence: 0.9 }), { text: '静音' })
    expect(plan.intent).toBe('unknown')
    expect(plan.actionId).toBeUndefined()
    expect(plan.confidence).toBe(0)
  })

  it('actionId 缺失 / 非字符串 / 空白，一律 unknown', () => {
    expect(parsePlan(modelSays({ intent: 'action', confidence: 0.9 })).intent).toBe('unknown')
    expect(parsePlan(modelSays({ intent: 'action', actionId: 123, confidence: 0.9 })).intent).toBe('unknown')
    expect(parsePlan(modelSays({ intent: 'action', actionId: '   ', confidence: 0.9 })).intent).toBe('unknown')
  })

  it('降级时保留模型写的回应，让用户看到一句可读的话', () => {
    const plan = parsePlan(
      modelSays({ intent: 'action', actionId: 'playlist.reorder', reply: '这个我还不会。', confidence: 0.9 }),
      { text: '重新排序' },
    )
    expect(plan.intent).toBe('unknown')
    expect(plan.reply).toBe('这个我还不会。')
  })
})

describe('动作识别：参数类型不符 / 枚举越界一律丢弃而非猜测', () => {
  it('number 参数收到字符串 → 丢弃该参数', () => {
    const plan = parsePlan(
      modelSays({ intent: 'action', actionId: 'playback.volume', params: { volume: '80' }, confidence: 0.9 }),
      { text: '音量八十' },
    )
    expect(plan.intent).toBe('action')
    expect(plan.params).toBeUndefined()
  })

  it('number 参数越界（音量 500）→ 丢弃，不夹紧成 100', () => {
    const plan = parsePlan(
      modelSays({ intent: 'action', actionId: 'playback.volume', params: { volume: 500 }, confidence: 0.9 }),
      { text: '音量最大' },
    )
    expect(plan.params).toBeUndefined()
  })

  it('enum 参数取值不在候选里 → 丢弃，不回退到第一个候选', () => {
    const plan = parsePlan(
      modelSays({ intent: 'action', actionId: 'playback.repeat', params: { mode: 'loop' }, confidence: 0.9 }),
      { text: '循环' },
    )
    expect(plan.intent).toBe('action')
    expect(plan.params).toBeUndefined()
  })

  it('boolean 参数收到字符串 → 丢弃', () => {
    const plan = parsePlan(
      modelSays({
        intent: 'action',
        actionId: 'export.mv-single',
        params: { watermark: 'yes', cleanExport: true },
        confidence: 0.9,
      }),
      { text: '导出MV' },
    )
    // 只丢坏的那一个，合法的 cleanExport 必须留下
    expect(plan.params).toEqual({ cleanExport: true })
  })

  it('注册表里没有的参数名被丢弃（模型不许自造参数）', () => {
    const plan = parsePlan(
      modelSays({
        intent: 'action',
        actionId: 'playback.volume',
        params: { volume: 50, fade: true, device: 'speaker' },
        confidence: 0.9,
      }),
      { text: '音量50' },
    )
    expect(plan.params).toEqual({ volume: 50 })
  })

  it('params 不是对象（数组 / 字符串 / null）时忽略，不抛错', () => {
    for (const bad of [[1, 2], 'volume=50', null, 42]) {
      const plan = parsePlan(
        modelSays({ intent: 'action', actionId: 'playback.volume', params: bad, confidence: 0.9 }),
        { text: '音量' },
      )
      expect(plan.intent).toBe('action')
      expect(plan.params).toBeUndefined()
    }
  })

  it('narrowActionParams 是纯函数，可直接按注册表定义断言', () => {
    const action = ACTION_REGISTRY.find(a => a.id === 'playback.repeat')
    expect(action).toBeDefined()
    if (!action) return
    expect(narrowActionParams(action, { mode: 'all' })).toEqual({ mode: 'all' })
    expect(narrowActionParams(action, { mode: 'nope' })).toBeUndefined()
    expect(narrowActionParams(action, {})).toBeUndefined()
    expect(narrowActionParams(action, null)).toBeUndefined()
  })
})

describe('动作识别：提示词接入注册表', () => {
  const system = buildPlanMessages({ text: '下一首' })[0].content
  const rendered = renderActionsForPrompt()

  it('系统提示词包含 renderActionsForPrompt() 的完整输出', () => {
    expect(rendered.length).toBeGreaterThan(0)
    expect(system).toContain(rendered)
  })

  it('提示词要求模型在识别到动作时输出 intent=action + actionId + params', () => {
    expect(system).toContain('"intent":"action"')
    expect(system).toContain('actionId')
    expect(system).toContain('params')
  })

  it('action 已进入 intent 白名单文案', () => {
    expect(system).toContain('action')
    expect(ASSISTANT_INTENTS).toContain('action')
  })

  it('注册表里每个动作 id 都出现在提示词中（新增动作自动可见）', () => {
    for (const action of ACTION_REGISTRY) expect(system).toContain(action.id)
  })

  it('提示词要求参数拿不准就省略，不许猜值', () => {
    expect(system).toContain('宁可省略')
  })
})

describe('动作识别：永不抛错的契约不变', () => {
  it('各种畸形 action 回复都不抛错', () => {
    const junk = [
      '{"intent":"action"}',
      '{"intent":"action","actionId":null}',
      '{"intent":"action","actionId":"playback.next","params":"x"}',
      '{"intent":"action","actionId":["a"],"params":{}}',
      '{"intent":"action","actionId":"playback.volume","params":{"volume":{}}}',
      '{"intent":"action","actionId":"","confidence":"高"}',
    ]
    for (const reply of junk) {
      expect(() => parsePlan(reply)).not.toThrow()
      expect(parsePlan(reply).confidence).toBeLessThanOrEqual(1)
    }
  })

  it('action 的 unknown 降级同样把 confidence 归零', () => {
    expect(parsePlan(modelSays({ intent: 'action', actionId: 'nope.nope', confidence: 0.99 })).confidence).toBe(0)
  })
})

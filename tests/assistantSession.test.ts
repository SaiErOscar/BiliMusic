import { describe, it, expect } from 'vitest'

import {
  CREATE_PLAYLIST_KEY,
  extractCreateName,
  isPendingReady,
  mergeAnswer,
  nextPendingAction,
  parseBooleanAnswer,
  parseNumberAnswer,
  parseOrdinal,
} from '../src/services/assistantSession'
import type { PendingAction } from '../src/services/assistantSession'
import { getAssistantAction } from '../src/services/assistantActions'
import type { AssistantAction } from '../src/services/assistantActions'

const PLAYLISTS = [
  { id: 'p1', name: '我的跑步歌单' },
  { id: 'p2', name: '夜跑专用' },
  { id: 'p3', name: '写作业' },
]
const CTX = { playlists: PLAYLISTS }

function must(id: string): AssistantAction {
  const action = getAssistantAction(id)
  if (!action) throw new Error(`missing action ${id}`)
  return action
}

describe('parseOrdinal', () => {
  it('识别中文序号', () => {
    expect(parseOrdinal('第二个')).toBe(2)
    expect(parseOrdinal('第一个')).toBe(1)
    expect(parseOrdinal('第十个')).toBe(10)
    expect(parseOrdinal('第十二个')).toBe(12)
    expect(parseOrdinal('二十三个')).toBe(23)
    expect(parseOrdinal('两首')).toBe(2)
  })

  it('识别阿拉伯数字序号与裸数字', () => {
    expect(parseOrdinal('第2个')).toBe(2)
    expect(parseOrdinal('2')).toBe(2)
    expect(parseOrdinal(' 3 ')).toBe(3)
  })

  it('不是序号回答时返回 null', () => {
    expect(parseOrdinal('跑步歌单')).toBeNull()
    expect(parseOrdinal('新建一个叫夜跑的')).toBeNull()
    expect(parseOrdinal('')).toBeNull()
  })
})

describe('parseBooleanAnswer / parseNumberAnswer', () => {
  it('先判否再判是（「不要」不能被当成「要」）', () => {
    expect(parseBooleanAnswer('不要')).toBe(false)
    expect(parseBooleanAnswer('不是')).toBe(false)
    expect(parseBooleanAnswer('关闭')).toBe(false)
    expect(parseBooleanAnswer('打开')).toBe(true)
    expect(parseBooleanAnswer('好的')).toBe(true)
    expect(parseBooleanAnswer('嗯')).toBe(true)
  })

  it('认不出返回 null', () => {
    expect(parseBooleanAnswer('蓝色')).toBeNull()
    expect(parseBooleanAnswer('')).toBeNull()
  })

  it('取第一个数字，支持小数与负号', () => {
    expect(parseNumberAnswer('调到 80')).toBe(80)
    expect(parseNumberAnswer('1.25 倍')).toBe(1.25)
    expect(parseNumberAnswer('-3')).toBe(-3)
    expect(parseNumberAnswer('很大声')).toBeNull()
  })
})

describe('extractCreateName', () => {
  it('从「新建一个叫X的」里抽名字', () => {
    expect(extractCreateName('新建一个叫夜跑的')).toBe('夜跑')
    expect(extractCreateName('创建一个叫「睡前」的歌单')).toBe('睡前')
    expect(extractCreateName('新建歌单，名字是通勤')).toBe('通勤')
  })

  it('没有新建意图返回 null', () => {
    expect(extractCreateName('跑步歌单')).toBeNull()
    expect(extractCreateName('第二个')).toBeNull()
  })

  it('没有「叫 X」时退化为去掉动词与名词的残句', () => {
    expect(extractCreateName('新建歌单 夜跑')).toBe('夜跑')
  })
})

describe('nextPendingAction', () => {
  it('参数齐了返回 null', () => {
    const action = must('playlist.add-track')
    expect(nextPendingAction(action, { track: 't1', playlist: 'p1' }, CTX)).toBeNull()
  })

  it('无参数动作直接返回 null', () => {
    expect(nextPendingAction(must('playback.play'), {}, CTX)).toBeNull()
  })

  it('缺歌单时给出提问与候选歌单', () => {
    const action = must('playlist.add-track')
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    expect(pending).not.toBeNull()
    expect(pending?.actionId).toBe('playlist.add-track')
    expect(pending?.missing).toEqual(['playlist'])
    expect(pending?.params).toEqual({ track: 't1' })
    expect(pending?.question).toContain('要添加到哪个歌单')
    expect(pending?.question).toContain('我的跑步歌单')
    expect(pending?.choices?.map(c => c.value)).toEqual(['p1', 'p2', 'p3'])
  })

  it('缺多个参数时只问第一个，missing 列出全部', () => {
    const action = must('playlist.add-track')
    const pending = nextPendingAction(action, {}, CTX)
    expect(pending?.missing).toEqual(['track', 'playlist'])
    expect(pending?.question).toContain('要添加哪首歌')
  })

  it('没有歌单时提示可以新建', () => {
    const pending = nextPendingAction(must('download.playlist'), {}, {})
    expect(pending?.question).toContain('还没有歌单')
    expect(pending?.choices).toBeUndefined()
  })

  it('enum 参数把候选值写进问题', () => {
    const pending = nextPendingAction(must('playback.repeat'), {}, CTX)
    expect(pending?.question).toContain('不循环')
    expect(pending?.choices?.map(c => c.value)).toEqual(['none', 'all', 'one', 'shuffle'])
  })

  it('空串参数视为缺失', () => {
    const pending = nextPendingAction(must('playlist.create'), { name: '   ' }, CTX)
    expect(pending?.missing).toEqual(['name'])
  })

  it('可选参数缺失不算缺失', () => {
    expect(nextPendingAction(must('favorite.add'), {}, CTX)).toBeNull()
    expect(nextPendingAction(must('export.mv-single'), {}, CTX)).toBeNull()
  })

  it('不修改传入的 collected 对象', () => {
    const collected = { track: 't1' }
    nextPendingAction(must('playlist.add-track'), collected, CTX)
    expect(collected).toEqual({ track: 't1' })
  })
})

describe('mergeAnswer · 序号回答', () => {
  const action = must('playlist.add-track')

  it('「第二个」选中第二项', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '第二个', CTX)
    expect(next.params.playlist).toBe('p2')
    expect(next.missing).toEqual([])
    expect(isPendingReady(next)).toBe(true)
  })

  it('「2」与「二」等价', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '2', CTX).params.playlist).toBe('p2')
    expect(mergeAnswer(pending, '二', CTX).params.playlist).toBe('p2')
  })

  it('序号越界时保持 missing 并给提示', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '第九个', CTX)
    expect(next.missing).toEqual(['playlist'])
    expect(next.params.playlist).toBeUndefined()
    expect(next.question).toContain('没听懂')
  })
})

describe('mergeAnswer · 名称回答', () => {
  const action = must('playlist.add-track')

  it('歌单全名精确命中', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '夜跑专用', CTX).params.playlist).toBe('p2')
  })

  it('部分名称模糊命中', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '我的跑步歌单', CTX).params.playlist).toBe('p1')
    expect(mergeAnswer(pending, '写作业', CTX).params.playlist).toBe('p3')
  })

  it('带引号的名称也能命中', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '「写作业」', CTX).params.playlist).toBe('p3')
  })

  it('匹配不到时 params 与 missing 都不变，question 加提示', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '完全不存在的歌单', CTX)
    expect(next.params).toEqual(pending.params)
    expect(next.missing).toEqual(pending.missing)
    expect(next.question).toContain('没听懂')
    expect(next.question).toContain(pending.question)
  })
})

describe('mergeAnswer · 新建意图', () => {
  const action = must('playlist.add-track')

  it('「新建一个叫夜跑的」写入名字并打上新建标记', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '新建一个叫夜跑的', CTX)
    expect(next.params.playlist).toBe('夜跑')
    expect(next.params[CREATE_PLAYLIST_KEY]).toBe(true)
    expect(next.missing).toEqual([])
  })

  it('「创建一个叫「睡前」的歌单」也能抽名字', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '创建一个叫「睡前」的歌单', CTX)
    expect(next.params.playlist).toBe('睡前')
    expect(next.params[CREATE_PLAYLIST_KEY]).toBe(true)
  })

  it('新建意图优先于已有歌单的模糊匹配', () => {
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    // 名字里含「写作业」，但用户明确说新建，就不该落到 p3
    const next = mergeAnswer(pending, '新建一个叫写作业二的', CTX)
    expect(next.params.playlist).toBe('写作业二')
    expect(next.params[CREATE_PLAYLIST_KEY]).toBe(true)
  })
})

describe('mergeAnswer · 其他参数类型', () => {
  it('boolean 参数：打开 / 关闭', () => {
    const pending = nextPendingAction(must('settings.set-lyricBilingual'), {}, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '打开', CTX).params.lyricBilingual).toBe(true)
    expect(mergeAnswer(pending, '关掉', CTX).params.lyricBilingual).toBe(false)
  })

  it('number 参数：从自然语言里取数字', () => {
    const pending = nextPendingAction(must('playback.volume'), {}, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '调到 65 吧', CTX)
    expect(next.params.volume).toBe(65)
    expect(next.missing).toEqual([])
  })

  it('enum 参数：按 label 与候选值都能命中', () => {
    const pending = nextPendingAction(must('playback.repeat'), {}, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '单曲循环', CTX).params.mode).toBe('one')
    expect(mergeAnswer(pending, 'one', CTX).params.mode).toBe('one')
    expect(mergeAnswer(pending, '第三个', CTX).params.mode).toBe('one')
  })

  it('enum 参数匹配不到时保持 missing', () => {
    const pending = nextPendingAction(must('playback.repeat'), {}, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '随便啦', CTX)
    expect(next.missing).toEqual(['mode'])
    expect(next.question).toContain('没听懂')
  })

  it('string 参数：原文收下并去掉引号', () => {
    const pending = nextPendingAction(must('playlist.create'), {}, CTX)
    if (!pending) throw new Error('pending expected')
    expect(mergeAnswer(pending, '「通勤」', CTX).params.name).toBe('通勤')
  })
})

describe('mergeAnswer · 边界与不变式', () => {
  it('空回答不改变任何东西', () => {
    const pending = nextPendingAction(must('playlist.add-track'), { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const next = mergeAnswer(pending, '   ', CTX)
    expect(next.params).toEqual(pending.params)
    expect(next.missing).toEqual(pending.missing)
  })

  it('已经齐了的 pending 原样返回', () => {
    const done: PendingAction = {
      actionId: 'playlist.add-track',
      params: { track: 't1', playlist: 'p1' },
      missing: [],
      question: '',
    }
    expect(mergeAnswer(done, '随便说点什么', CTX)).toBe(done)
  })

  it('未知 actionId 不崩溃，保持 missing', () => {
    const ghost: PendingAction = { actionId: 'nope.nope', params: {}, missing: ['x'], question: '?' }
    const next = mergeAnswer(ghost, '第二个', CTX)
    expect(next.missing).toEqual(['x'])
  })

  it('不修改传入的 pending 对象', () => {
    const pending = nextPendingAction(must('playlist.add-track'), { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    const snapshot = JSON.parse(JSON.stringify(pending))
    mergeAnswer(pending, '第二个', CTX)
    expect(pending).toEqual(snapshot)
  })

  it('多步：填完一个参数后继续问下一个', () => {
    const action = must('playlist.rename')
    let pending = nextPendingAction(action, {}, CTX)
    if (!pending) throw new Error('pending expected')
    expect(pending.missing).toEqual(['playlist', 'name'])

    pending = mergeAnswer(pending, '第二个', CTX)
    expect(pending.params.playlist).toBe('p2')
    expect(pending.missing).toEqual(['name'])
    expect(pending.question).toContain('新的名字')

    pending = mergeAnswer(pending, '晨跑', CTX)
    expect(pending.params).toEqual({ playlist: 'p2', name: '晨跑' })
    expect(isPendingReady(pending)).toBe(true)
  })

  it('isPendingReady 与 nextPendingAction 的 null 判定一致', () => {
    const action = must('playlist.add-track')
    const ready = nextPendingAction(action, { track: 't1', playlist: 'p1' }, CTX)
    expect(ready).toBeNull()
    const pending = nextPendingAction(action, { track: 't1' }, CTX)
    if (!pending) throw new Error('pending expected')
    expect(isPendingReady(pending)).toBe(false)
    expect(isPendingReady(mergeAnswer(pending, '第一个', CTX))).toBe(true)
  })
})

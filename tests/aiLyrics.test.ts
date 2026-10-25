// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { AI_LYRIC_BATCH, AI_LYRIC_MODE_LABELS, parseLyricLines, pickTranslatableIndexes } from '../src/services/aiLyrics'

// v1.4.11-pre6：AI 歌词增强的纯逻辑部分（解析 / 行号对齐 / 分批）。
// 真实 LLM 调用与渲染效果无法在 jsdom 里测。

describe('歌词增强 JSON 解析', () => {
  it('解析纯 JSON 数组', () => {
    const r = parseLyricLines('[{"index":0,"text":"你好"},{"index":2,"text":"再见"}]')
    expect(r).toEqual([{ index: 0, text: '你好' }, { index: 2, text: '再见' }])
  })

  it('容忍代码围栏与前后废话', () => {
    const r = parseLyricLines('好的：\n```json\n[{"index":1,"text":"x"}]\n```\n完成')
    expect(r).toEqual([{ index: 1, text: 'x' }])
  })

  it('丢弃非法项：负数/非数字索引、空文本', () => {
    const r = parseLyricLines('[{"index":-1,"text":"a"},{"index":"x","text":"b"},{"index":0,"text":"  "},{"index":3,"text":"ok"}]')
    expect(r).toEqual([{ index: 3, text: 'ok' }])
  })

  it('无 JSON 时返回空数组而不是抛错', () => {
    expect(parseLyricLines('抱歉做不到')).toEqual([])
    expect(parseLyricLines('')).toEqual([])
  })
})

describe('可处理行筛选', () => {
  it('跳过空白行，保留有文字的行（行号保持原索引）', () => {
    const lines = [
      { time: 0, text: '第一句' },
      { time: 1, text: '' },
      { time: 2, text: '   ' },
      { time: 3, text: '第四句' },
    ]
    expect(pickTranslatableIndexes(lines)).toEqual([0, 3])
  })

  it('全空行时返回空（调用方据此报「没有可处理的文字行」）', () => {
    expect(pickTranslatableIndexes([{ time: 0, text: '' }])).toEqual([])
  })
})

describe('分批与安全约束', () => {
  it('单批 40 行', () => {
    expect(AI_LYRIC_BATCH).toBe(40)
  })

  it('两种模式都有中文标签', () => {
    expect(AI_LYRIC_MODE_LABELS.translate).toBe('翻译')
    expect(AI_LYRIC_MODE_LABELS.interpret).toBe('逐句赏析')
  })

  it('只接受本批内的行号，防止模型改号串批', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiLyrics.ts'), 'utf8')
    expect(src).toContain('allowed.has(item.index)')
  })

  it('不写回歌词缓存（AI 结果只是叠加层）', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiLyrics.ts'), 'utf8')
    // 服务层不得触碰歌词缓存 API
    expect(src).not.toContain('clearLyricCache')
    expect(src).not.toContain('saveLyricOffsetMap')
  })
})

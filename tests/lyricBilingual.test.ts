import { describe, it, expect } from 'vitest'
import { mergeTranslation, parseLrc, type LyricLine } from '../src/services/lyrics'

// v1.4.9-pre2 歌词双语：mergeTranslation 的时间轴对齐规则。
// 只测纯函数，不触碰网络与缓存。

function lines(...pairs: [number, string][]): LyricLine[] {
  return pairs.map(([time, text]) => ({ time, text }))
}

const TRANSLATION_LRC = [
  '[00:12.00]I never thought I would find you',
  '[00:16.50]Somewhere in the crowd',
].join('\n')

describe('mergeTranslation 时间轴合并', () => {
  it('时间戳完全一致时逐行填上译文', () => {
    const src = lines([12, '我从没想过会找到你'], [16.5, '在人群之中'])
    const out = mergeTranslation(src, TRANSLATION_LRC)
    expect(out).toHaveLength(2)
    expect(out[0].translation).toBe('I never thought I would find you')
    expect(out[1].translation).toBe('Somewhere in the crowd')
  })

  it('原文行数与顺序绝不因译文改变', () => {
    const src = lines([12, '甲'], [14, '乙'], [16.5, '丙'])
    const out = mergeTranslation(src, TRANSLATION_LRC)
    expect(out.map((l) => l.text)).toEqual(['甲', '乙', '丙'])
    expect(out.map((l) => l.time)).toEqual([12, 14, 16.5])
  })

  it('容差内的微小抖动仍能匹配（0.35s 边界内）', () => {
    const src = lines([12.2, '我从没想过会找到你'])
    const out = mergeTranslation(src, TRANSLATION_LRC)
    expect(out[0].translation).toBe('I never thought I would find you')
  })

  it('超出容差的行不填译文（宁可单语也不串行）', () => {
    const src = lines([13.0, '这一行离任何译文都远'])
    const out = mergeTranslation(src, TRANSLATION_LRC)
    expect(out[0].translation).toBeUndefined()
  })

  it('一条译文最多被用一次，不会重复贴到相邻原文上', () => {
    // 两行原文都离 12.00 的译文在容差内，但译文只能被消费一次
    const src = lines([12.0, '甲'], [12.1, '乙'])
    const out = mergeTranslation(src, TRANSLATION_LRC)
    const used = out.filter((l) => l.translation === 'I never thought I would find you')
    expect(used).toHaveLength(1)
  })

  it('译文与原文相同（纯音乐/未翻译复制原句）时不重复显示', () => {
    const src = lines([12, 'Same line'])
    const same = '[00:12.00]Same line'
    const out = mergeTranslation(src, same)
    expect(out[0].translation).toBeUndefined()
  })

  it('纯文本歌词（time < 0）不参与匹配，原样返回', () => {
    const src = lines([-1, '无时间轴的普通歌词'])
    const out = mergeTranslation(src, TRANSLATION_LRC)
    expect(out[0].translation).toBeUndefined()
    expect(out[0].text).toBe('无时间轴的普通歌词')
  })

  it('译文 LRC 为空或解析不出时间行时等价于单语', () => {
    const src = lines([12, '甲'], [16.5, '乙'])
    expect(mergeTranslation(src, '')).toEqual(src)
    expect(mergeTranslation(src, '纯文本没有时间标签')).toEqual(src)
  })

  it('原文为空数组时直接返回，不报错', () => {
    expect(mergeTranslation([], TRANSLATION_LRC)).toEqual([])
  })

  it('不修改传入的原始行对象（纯函数）', () => {
    const src = lines([12, '甲'])
    const snapshot = JSON.stringify(src)
    mergeTranslation(src, TRANSLATION_LRC)
    expect(JSON.stringify(src)).toBe(snapshot)
  })

  it('译文行文本首尾空白被裁掉', () => {
    const src = lines([12, '甲'])
    const out = mergeTranslation(src, '[00:12.00]   padded translation   ')
    expect(out[0].translation).toBe('padded translation')
  })
})

describe('parseLrc 与双语共用同一套时间解析', () => {
  it('译文 LRC 的时间戳解析与主歌词一致', () => {
    const parsed = parseLrc(TRANSLATION_LRC)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].time).toBeCloseTo(12, 5)
    expect(parsed[1].time).toBeCloseTo(16.5, 5)
  })
})

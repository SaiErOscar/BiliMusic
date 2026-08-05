import { describe, it, expect } from 'vitest'
import { parseLrc, cleanTitle, dice } from '../src/services/lyrics'

describe('parseLrc', () => {
  it('应解析标准 LRC 时间标签', () => {
    const lrc = '[00:01.00]第一行\n[00:03.50]第二行\n[00:05.00]第三行'
    const lines = parseLrc(lrc)
    expect(lines).toHaveLength(3)
    expect(lines[0].time).toBe(1)
    expect(lines[0].text).toBe('第一行')
    expect(lines[1].time).toBe(3.5)
    expect(lines[2].time).toBe(5)
  })

  it('应处理多时间标签行', () => {
    const lrc = '[00:01.00][00:03.00]重复歌词'
    const lines = parseLrc(lrc)
    expect(lines).toHaveLength(2)
    expect(lines[0].time).toBe(1)
    expect(lines[1].time).toBe(3)
    expect(lines[0].text).toBe('重复歌词')
  })

  it('应跳过空行和元数据行', () => {
    const lrc = '[ti:歌曲名]\n[ar:歌手]\n[00:01.00]实际歌词\n\n[by:制作]'
    const lines = parseLrc(lrc)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('实际歌词')
  })

  it('应处理毫秒精度', () => {
    const lrc = '[00:01.123]毫秒测试'
    const lines = parseLrc(lrc)
    expect(lines[0].time).toBeCloseTo(1.123, 3)
  })

  it('空输入返回空数组', () => {
    expect(parseLrc('')).toEqual([])
  })
})

describe('cleanTitle', () => {
  it('应移除噪声关键词', () => {
    expect(cleanTitle('歌曲名 Official MV')).toBe('歌曲名')
    expect(cleanTitle('歌曲名 官方版')).toBe('歌曲名')
    expect(cleanTitle('歌曲名 [完整版]')).toBe('歌曲名')
  })

  it('应保留书名号内容', () => {
    const result = cleanTitle('《歌曲名》官方版')
    expect(result).toContain('歌曲名')
    expect(result).not.toContain('官方')
  })

  it('空输入返回空字符串', () => {
    expect(cleanTitle('')).toBe('')
  })

  it('移除 emoji', () => {
    const result = cleanTitle('歌曲名🎵MV')
    expect(result).not.toContain('🎵')
  })
})

describe('dice', () => {
  it('相同字符串返回1', () => {
    expect(dice('hello', 'hello')).toBe(1)
  })

  it('完全不同返回0', () => {
    expect(dice('abc', 'xyz')).toBe(0)
  })

  it('包含关系返回高分数', () => {
    const score = dice('歌曲名', '歌曲名 remix')
    expect(score).toBeGreaterThan(0.5)
  })

  it('空字符串返回0', () => {
    expect(dice('', 'test')).toBe(0)
    expect(dice('test', '')).toBe(0)
  })
})

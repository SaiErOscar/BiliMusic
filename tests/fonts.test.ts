import { describe, it, expect } from 'vitest'
import { parseRegFonts, parseMacFontFile } from '../electron/fontUtils'

describe('parseRegFonts (Windows 注册表字体输出解析)', () => {
  it('解析标准 TrueType/OpenType 项并去除后缀', () => {
    const stdout = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '    Arial (TrueType)    REG_SZ    Arial.ttf',
      '    Arial Bold (TrueType)    REG_SZ    aribtl.ttf',
      '    Times New Roman (TrueType)    REG_SZ    times.ttf',
      '    Comic Sans MS (TTF Locked)    REG_SZ    comic.ttf',
      '    Impact (TrueType)    REG_SZ    impact.ttf',
      '',
    ].join('\r\n')
    const set = new Set<string>()
    parseRegFonts(stdout, set)
    const got = Array.from(set)
    expect(got).toContain('Arial')
    expect(got).toContain('Arial Bold')
    expect(got).toContain('Times New Roman')
    expect(got).toContain('Impact')
    // 非 TrueType/OpenType 标记（TTF Locked）不匹配括号后缀，原样保留键名
    expect(got.some((n) => n.includes('Comic Sans MS'))).toBe(true)
  })

  it('去掉尾部 Regular 变体标记', () => {
    const stdout = '    Segoe UI Regular    REG_SZ    segoeui.ttf'
    const set = new Set<string>()
    parseRegFonts(stdout, set)
    expect(Array.from(set)).toEqual(['Segoe UI'])
  })

  it('跳过非字体文件行与表头/分隔行', () => {
    const stdout = [
      '    SomeFont    REG_SZ    notafont.fon', // .fon 不算
      '    Another    REG_DWORD    1', // 非 REG_SZ
      'HKEY_CURRENT_USER\\...', // 表头
      '',
    ].join('\r\n')
    const set = new Set<string>()
    parseRegFonts(stdout, set)
    expect(set.size).toBe(0)
  })

  it('去重', () => {
    const stdout = [
      '    Arial (TrueType)    REG_SZ    Arial.ttf',
      '    Arial (TrueType)    REG_SZ    Arial.ttf',
    ].join('\r\n')
    const set = new Set<string>()
    parseRegFonts(stdout, set)
    expect(Array.from(set)).toEqual(['Arial'])
  })
})

describe('parseMacFontFile (macOS 字体文件名解析)', () => {
  it('识别 ttf/otf/ttc 并去扩展名', () => {
    expect(parseMacFontFile('Helvetica.ttc')).toBe('Helvetica')
    expect(parseMacFontFile('AvenirNext-Regular.otf')).toBe('AvenirNext-Regular')
    expect(parseMacFontFile('Times New Roman.ttf')).toBe('Times New Roman')
  })

  it('非字体文件返回 null', () => {
    expect(parseMacFontFile('README.md')).toBeNull()
    expect(parseMacFontFile('AppleFontSubset.fon')).toBeNull()
  })
})

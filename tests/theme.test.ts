// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  THEME_TOKEN_KEYS,
  applyThemeTokens,
  clearThemeTokens,
  expandSeed,
  getPreset,
  luminance,
  mergeSeed,
  mix,
  readableOn,
  resolveThemeTokens,
} from '../src/theme/tokens'
import {
  MAX_LYRIC_PRESETS,
  applyPresetToPatch,
  findPreset,
  normalizePresetName,
  presetFromSettings,
  removePreset,
  upsertPreset,
} from '../src/theme/lyricPresets'

/**
 * v1.4.9-pre1 主题体系化：token 派生与歌词窗样式预设。
 * 目标——主题只声明三个基色即可派生完整品牌色；默认主题必须回落 CSS（零视觉变化）；
 * 预设库可保存 / 覆盖 / 应用 / 删除且不无限膨胀。
 */

const baseLyricStyle = {
  lyricTextColor: '#ffffff',
  lyricControlColor: '#ff375f',
  lyricFontSize: 30,
  lyricFontWeight: 820,
  lyricFontFamily: 'system-ui',
}

describe('内置主题表', () => {
  it('默认主题存在且 id 唯一', () => {
    const ids = BUILTIN_THEMES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_THEME_ID)
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(4)
  })

  it('未知 id 回退默认主题', () => {
    expect(getPreset('nope').id).toBe(DEFAULT_THEME_ID)
  })
})

describe('颜色工具', () => {
  it('亮度：白 1、黑 0', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 2)
    expect(luminance('#000000')).toBeCloseTo(0, 2)
  })

  it('混色取两端与中间', () => {
    expect(mix('#000000', '#FFFFFF', 0)).toBe('#000000')
    expect(mix('#000000', '#FFFFFF', 1)).toBe('#FFFFFF')
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080')
  })

  it('对比色：浅底黑字、深底白字', () => {
    expect(readableOn('#FFFFFF')).toBe('#18191C')
    expect(readableOn('#F5F5F5')).toBe('#18191C')
    // 品牌惯例：B 站粉底用白字（与 index.css 的 --color-on-primary 一致）
    expect(readableOn('#FB7299')).toBe('#FFFFFF')
    expect(readableOn('#1B1B1F')).toBe('#FFFFFF')
    // 阈值边界：亮度 > 0.62 才切黑字
    expect(readableOn('#A0A0A0')).toBe('#18191C')
    expect(readableOn('#8A8A8A')).toBe('#FFFFFF')
  })
})

describe('expandSeed（三基色派生完整 token）', () => {
  it('亮色：给出全部 token 且前缀正确', () => {
    const tokens = expandSeed({ primary: '#FB7299', secondary: '#7C5CFC', accent: '#00AEEC' }, 'light')
    for (const key of THEME_TOKEN_KEYS) expect(tokens[key]).toBeTruthy()
    expect(tokens['color-primary']).toBe('#FB7299')
    expect(tokens['color-on-primary']).toBe('#FFFFFF')
    // 亮色 hover 比主色暗（向黑混）
    expect(luminance(tokens['color-primary-hover']!)).toBeLessThan(luminance('#FB7299'))
    // 亮色 primary-light 接近白
    expect(luminance(tokens['color-primary-light']!)).toBeGreaterThan(0.9)
  })

  it('暗色：primary-light 变深、hover 变亮', () => {
    const tokens = expandSeed({ primary: '#FB7299', secondary: '#9B84FF', accent: '#33C1F2' }, 'dark')
    expect(luminance(tokens['color-primary-light']!)).toBeLessThan(luminance('#FB7299'))
    expect(luminance(tokens['color-primary-hover']!)).toBeGreaterThan(luminance('#FB7299'))
  })
})

describe('resolveThemeTokens（默认回落 CSS）', () => {
  it('默认主题且无自定义：返回空对象，交给 index.css', () => {
    expect(resolveThemeTokens({ themeId: DEFAULT_THEME_ID, mode: 'light' })).toEqual({})
    expect(resolveThemeTokens({ themeId: 'unknown-id', mode: 'dark' })).toEqual({})
  })

  it('选中内置主题：取该主题对应明暗的基色', () => {
    const light = resolveThemeTokens({ themeId: 'ocean', mode: 'light' })
    const dark = resolveThemeTokens({ themeId: 'ocean', mode: 'dark' })
    expect(light['color-primary']).toBe(getPreset('ocean').light.primary)
    expect(dark['color-primary']).toBe(getPreset('ocean').dark.primary)
  })

  it('自定义基色：在主题之上覆盖，未覆盖项保留主题值', () => {
    const tokens = resolveThemeTokens({
      themeId: 'forest',
      mode: 'light',
      custom: { primary: '#123456' },
    })
    expect(tokens['color-primary']).toBe('#123456')
    expect(tokens['color-accent']).toBe(getPreset('forest').light.accent)
  })

  it('默认主题 + 自定义基色：不再回落，返回派生结果', () => {
    const tokens = resolveThemeTokens({ themeId: DEFAULT_THEME_ID, mode: 'light', custom: { accent: '#123456' } })
    expect(tokens['color-accent']).toBe('#123456')
    expect(tokens['color-primary']).toBe(getPreset(DEFAULT_THEME_ID).light.primary)
  })

  it('mergeSeed 只在提供值时覆盖', () => {
    const base = { primary: '#111111', secondary: '#222222', accent: '#333333' }
    expect(mergeSeed(base, {})).toEqual(base)
    expect(mergeSeed(base, { secondary: '#999999' }).primary).toBe('#111111')
  })
})

describe('applyThemeTokens（DOM 写入）', () => {
  beforeEach(() => clearThemeTokens())

  it('写入后可从内联样式读到，清空后移除', () => {
    applyThemeTokens({ 'color-primary': '#00FF00' })
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#00FF00')
    clearThemeTokens()
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('')
  })

  it('只写有值的 key，其余保持被清除状态', () => {
    applyThemeTokens({ 'color-primary': '#000000' })
    applyThemeTokens({ 'color-accent': '#FFFFFF' })
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#FFFFFF')
  })
})

describe('歌词窗样式预设', () => {
  it('名称归一化：去空白、截断、空名兜底', () => {
    expect(normalizePresetName('  夜色  白字 ')).toBe('夜色 白字')
    expect(normalizePresetName('')).toBe('未命名')
    expect(normalizePresetName('一二三四五六七八九十十一十二十三').length).toBe(12)
  })

  it('从当前设置摘取预设，字段一一对应', () => {
    const preset = presetFromSettings(baseLyricStyle, '默认外观')
    expect(preset.name).toBe('默认外观')
    expect(preset.lyricTextColor).toBe('#ffffff')
    expect(preset.lyricFontWeight).toBe(820)
    expect(applyPresetToPatch(preset)).toEqual(baseLyricStyle)
  })

  it('同 id 覆盖、同名覆盖、超出上限丢最早', () => {
    const a = presetFromSettings(baseLyricStyle, 'A', 'id-a')
    const b = presetFromSettings({ ...baseLyricStyle, lyricTextColor: '#000000' }, 'B', 'id-b')
    let list = upsertPreset([], a)
    list = upsertPreset(list, b)
    expect(list).toHaveLength(2)
    expect(findPreset(list, 'id-b')?.lyricTextColor).toBe('#000000')

    // 同 id 再写：仍是两条，内容更新
    list = upsertPreset(list, { ...b, lyricTextColor: '#111111' })
    expect(list).toHaveLength(2)
    expect(findPreset(list, 'id-b')?.lyricTextColor).toBe('#111111')

    // 同名不同 id：按名覆盖
    list = upsertPreset(list, presetFromSettings(baseLyricStyle, 'B', 'id-c'))
    expect(list).toHaveLength(2)
    expect(findPreset(list, 'id-c')).toBeTruthy()
    expect(findPreset(list, 'id-b')).toBeUndefined()

    // 上限
    let many: ReturnType<typeof presetFromSettings>[] = []
    for (let i = 0; i < MAX_LYRIC_PRESETS + 3; i++) {
      many = upsertPreset(many, presetFromSettings(baseLyricStyle, `P${i}`, `id-${i}`))
    }
    expect(many).toHaveLength(MAX_LYRIC_PRESETS)
    expect(findPreset(many, 'id-0')).toBeUndefined()
    expect(findPreset(many, `id-${MAX_LYRIC_PRESETS + 2}`)).toBeTruthy()
  })

  it('删除按 id 精确移除', () => {
    const list = [
      presetFromSettings(baseLyricStyle, 'A', 'id-a'),
      presetFromSettings(baseLyricStyle, 'B', 'id-b'),
    ]
    expect(removePreset(list, 'id-a').map(p => p.id)).toEqual(['id-b'])
    expect(removePreset(list, 'missing')).toHaveLength(2)
  })
})

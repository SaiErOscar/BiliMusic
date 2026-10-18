/**
 * v1.4.9-pre1 主题体系化：品牌/语义色 token 层。
 *
 * 分层约定：
 * - 色板层（本文件）：主题预设只声明 primary / secondary / accent 三个基色（seed），
 *   其余 token（on-* 对比色、primary-hover、primary-light）由纯函数派生，避免每个主题手写十几项。
 * - 语义层：index.css 的 `:root` 仍是默认值（未选任何主题时不写内联变量，视觉零变化）。
 * - 组件层：各页面继续消费 `--color-*`，不感知主题实现。
 *
 * 只主题化品牌色。surface / glass / sidebar / player / queue 等与明暗强绑定的几十个变量
 * 仍由 `[data-theme="dark"]` 决定，不进主题包（改动面与回归风险都太大）。
 */

export const THEME_TOKEN_KEYS = [
  'color-primary',
  'color-on-primary',
  'color-primary-hover',
  'color-primary-light',
  'color-secondary',
  'color-on-secondary',
  'color-accent',
  'color-on-accent',
] as const

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number]
export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>

/** 主题基色：定义一个主题最少需要给出的三项 */
export interface ThemeSeed {
  primary: string
  secondary: string
  accent: string
}

export interface ThemePreset {
  id: string
  name: string
  description: string
  light: ThemeSeed
  dark: ThemeSeed
}

export type ResolvedMode = 'light' | 'dark'

/** 默认主题（BiliBili 粉）：不写内联变量，完全回落到 index.css 的 `:root` */
export const DEFAULT_THEME_ID = 'default'

export const BUILTIN_THEMES: ThemePreset[] = [
  {
    id: DEFAULT_THEME_ID,
    name: 'BiliBili 粉',
    description: '默认配色，粉主色 + B 站蓝点缀',
    light: { primary: '#FB7299', secondary: '#7C5CFC', accent: '#00AEEC' },
    dark: { primary: '#FB7299', secondary: '#9B84FF', accent: '#33C1F2' },
  },
  {
    id: 'ocean',
    name: '深海蓝',
    description: '青蓝主色，适合夜间长时间使用',
    light: { primary: '#1B84D6', secondary: '#0F7699', accent: '#22B8CF' },
    dark: { primary: '#3FA9F5', secondary: '#4FD1C5', accent: '#4DD0E1' },
  },
  {
    id: 'forest',
    name: '森野绿',
    description: '植物绿主色，配色柔和',
    light: { primary: '#2F9E44', secondary: '#0B7285', accent: '#37B24D' },
    dark: { primary: '#51CF66', secondary: '#38D9A9', accent: '#69DB7C' },
  },
  {
    id: 'violet',
    name: '暮色紫',
    description: '紫罗兰主色，偏冷调',
    light: { primary: '#7048E8', secondary: '#C2255C', accent: '#9775FA' },
    dark: { primary: '#9775FA', secondary: '#F783AC', accent: '#B197FC' },
  },
  {
    id: 'graphite',
    name: '石墨灰',
    description: '低饱和中性色，界面更克制',
    light: { primary: '#4C6EF5', secondary: '#495057', accent: '#5C7CFA' },
    dark: { primary: '#748FFC', secondary: '#ADB5BD', accent: '#91A7FF' },
  },
]

export function getPreset(themeId: string): ThemePreset {
  return BUILTIN_THEMES.find(t => t.id === themeId) ?? BUILTIN_THEMES[0]
}

/* ---------- 颜色工具（纯函数，便于单测） ---------- */

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(hex: string): Rgb {
  const v = hex.trim().replace('#', '')
  const full = v.length === 3 ? v.split('').map(c => c + c).join('') : v
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return { r: 0, g: 0, b: 0 }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

function toHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
  return `#${[r, g, b].map(n => clamp(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** 相对亮度（sRGB 加权，0~1） */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** 与另一色按比例混合，ratio = 0 返回 a，ratio = 1 返回 b */
export function mix(a: string, b: string, ratio: number): string {
  const x = parseHex(a)
  const y = parseHex(b)
  const t = Math.max(0, Math.min(1, ratio))
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  })
}

/** 前景色：深色底返回白字，浅色底返回近黑字，保证对比度 */
export function readableOn(background: string): string {
  return luminance(background) > 0.62 ? '#18191C' : '#FFFFFF'
}

/**
 * 由基色派生完整 token 集合。
 * - on-*：按基色亮度选黑/白
 * - primary-hover：亮色主题压暗 12%，暗色主题提亮 10%
 * - primary-light：亮色主题向白混 90%，暗色主题向黑混 72%
 */
export function expandSeed(seed: ThemeSeed, mode: ResolvedMode): ThemeTokens {
  const toward = mode === 'dark' ? '#FFFFFF' : '#000000'
  return {
    'color-primary': seed.primary,
    'color-on-primary': readableOn(seed.primary),
    'color-primary-hover': mix(seed.primary, toward, mode === 'dark' ? 0.1 : 0.12),
    'color-primary-light': mode === 'dark' ? mix(seed.primary, '#000000', 0.72) : mix(seed.primary, '#FFFFFF', 0.9),
    'color-secondary': seed.secondary,
    'color-on-secondary': readableOn(seed.secondary),
    'color-accent': seed.accent,
    'color-on-accent': readableOn(seed.accent),
  }
}

export type CustomSeed = Partial<ThemeSeed>

/** 自定义基色覆盖（用户在内置主题上只改想改的那几项） */
export function mergeSeed(base: ThemeSeed, custom?: CustomSeed): ThemeSeed {
  if (!custom) return base
  return {
    primary: custom.primary || base.primary,
    secondary: custom.secondary || base.secondary,
    accent: custom.accent || base.accent,
  }
}

export interface ResolveOptions {
  themeId: string
  mode: ResolvedMode
  custom?: CustomSeed
}

/**
 * 解析出最终要写入的 token 集合。
 * 默认主题且无自定义时返回空对象，调用方据此清除内联变量、回落到 index.css 默认值。
 */
export function resolveThemeTokens({ themeId, mode, custom }: ResolveOptions): ThemeTokens {
  const preset = getPreset(themeId)
  const seed = mergeSeed(mode === 'dark' ? preset.dark : preset.light, custom)
  const isPristineDefault =
    preset.id === DEFAULT_THEME_ID &&
    !custom?.primary && !custom?.secondary && !custom?.accent
  if (isPristineDefault) return {}
  return expandSeed(seed, mode)
}

/* ---------- DOM 应用（薄封装，便于单测） ---------- */

export function applyThemeTokens(tokens: ThemeTokens, root: HTMLElement = document.documentElement): void {
  for (const key of THEME_TOKEN_KEYS) {
    const value = tokens[key]
    if (value) root.style.setProperty(`--${key}`, value)
    else root.style.removeProperty(`--${key}`)
  }
}

export function clearThemeTokens(root: HTMLElement = document.documentElement): void {
  applyThemeTokens({}, root)
}

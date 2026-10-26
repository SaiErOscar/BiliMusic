/**
 * v1.4.9-pre1 主题应用层：把「明暗模式」与「主题配色 token」落到 document 上。
 *
 * 与 index.css 的分工：
 * - data-theme 决定明暗（surface / glass / sidebar / player / queue 等大批变量）；
 * - 本文件额外把所选主题的品牌色写成内联变量，覆盖 `:root` 的品牌色默认值，
 *   未选主题或无自定义时清除内联变量，回落 CSS（视觉零变化）。
 */

import type { ThemeMode } from '@/types'
import { readStoredItemSync, writeStoredItem } from '@/utils/persistentStorage'
import { loadAppSettings, SETTINGS_CHANGED_EVENT } from '@/utils/storage'
import { applyThemeTokens, clearThemeTokens, resolveThemeTokens } from '@/theme/tokens'
import type { ResolvedMode } from '@/theme/tokens'

export const THEME_MODE_KEY = 'theme-mode'

let listenerBound = false

export function getSystemTheme(): ResolvedMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveMode(mode: ThemeMode): ResolvedMode {
  return mode === 'system' ? getSystemTheme() : mode
}

export function readStoredMode(): ThemeMode {
  return (readStoredItemSync(THEME_MODE_KEY) as ThemeMode) || 'system'
}

export function currentResolvedMode(): ResolvedMode {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

/**
 * v1.4.13-pre3 主题化图标：把当前主题与明暗同步给主进程，换窗口与托盘图标。
 *
 * 自定义基色没有预生成图标，主进程会回落到默认图标——这是刻意的降级，
 * 不为了一个图标去运行时重新着色。
 */
function syncThemedIcon(themeId: string, mode: ResolvedMode): void {
  try {
    const api = window.electronAPI as { applyThemeIcon?: (id: string, m: string) => Promise<unknown> } | undefined
    void api?.applyThemeIcon?.(themeId || 'default', mode)
  } catch {
    /* 图标同步失败不影响主题本身 */
  }
}

/** 按当前设置重算品牌色 token（设置变更、备份导入后调用） */
export function refreshBrandTokens(mode?: ResolvedMode): void {
  const resolved = mode ?? currentResolvedMode()
  const settings = loadAppSettings()
  const tokens = resolveThemeTokens({
    themeId: settings.themeId,
    mode: resolved,
    custom: settings.themeSeedOverride,
  })
  if (Object.keys(tokens).length === 0) clearThemeTokens()
  else applyThemeTokens(tokens)
  syncThemedIcon(settings.themeId, resolved)
}

/** 应用明暗模式并重算品牌色 */
export function applyTheme(mode: ThemeMode): ResolvedMode {
  const resolved = resolveMode(mode)
  document.documentElement.setAttribute('data-theme', resolved)
  refreshBrandTokens(resolved)
  return resolved
}

/**
 * 启动初始化：同步应用一次，避免首屏闪默认配色；并挂全局监听，
 * 使设置页之外（如备份导入）也能立刻反映主题变化。重复调用无副作用。
 */
export function initTheme(): ThemeMode {
  const mode = readStoredMode()
  applyTheme(mode)
  if (!listenerBound) {
    listenerBound = true
    window.addEventListener(SETTINGS_CHANGED_EVENT, () => refreshBrandTokens())
  }
  return mode
}

export function writeStoredMode(mode: ThemeMode): void {
  void writeStoredItem(THEME_MODE_KEY, mode)
}

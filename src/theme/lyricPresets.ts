/**
 * v1.4.9-pre1 歌词窗样式预设库。
 *
 * 把 v1.3.6~v1.3.10 逐项散落的歌词窗外观项（文字色 / 按钮色 / 字号 / 粗细 / 字体）
 * 打包成可命名的预设，供保存、一键应用与删除。纯数据 + 纯函数，不碰 DOM。
 */

import type { AppSettings, LyricStylePreset } from '@/types'

// 类型声明统一放在 @/types，此处只做转出，避免两处定义漂移
export type { LyricStylePreset }

/** 预设数量上限，避免设置项无限膨胀 */
export const MAX_LYRIC_PRESETS = 20
export const MAX_PRESET_NAME_LENGTH = 12

/** 预设可写回设置的字段集合 */
export type LyricPresetPatch = Pick<
  AppSettings,
  'lyricTextColor' | 'lyricControlColor' | 'lyricFontSize' | 'lyricFontWeight' | 'lyricFontFamily'
>

export function createPresetId(): string {
  return `lp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 归一化名称：去空白、截断，空名回退为「未命名」 */
export function normalizePresetName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (!trimmed) return '未命名'
  return trimmed.slice(0, MAX_PRESET_NAME_LENGTH)
}

export function presetFromSettings(settings: LyricPresetPatch, name: string, id?: string): LyricStylePreset {
  return {
    id: id || createPresetId(),
    name: normalizePresetName(name),
    lyricTextColor: settings.lyricTextColor,
    lyricControlColor: settings.lyricControlColor,
    lyricFontSize: settings.lyricFontSize,
    lyricFontWeight: settings.lyricFontWeight,
    lyricFontFamily: settings.lyricFontFamily,
  }
}

export function applyPresetToPatch(preset: LyricStylePreset): LyricPresetPatch {
  return {
    lyricTextColor: preset.lyricTextColor,
    lyricControlColor: preset.lyricControlColor,
    lyricFontSize: preset.lyricFontSize,
    lyricFontWeight: preset.lyricFontWeight,
    lyricFontFamily: preset.lyricFontFamily,
  }
}

export function findPreset(list: LyricStylePreset[], id: string): LyricStylePreset | undefined {
  return list.find(p => p.id === id)
}

/**
 * 写入预设：同 id 覆盖，同名（不同 id）也覆盖，其余追加，超出上限时丢弃最早一条。
 */
export function upsertPreset(list: LyricStylePreset[], preset: LyricStylePreset): LyricStylePreset[] {
  const others = list.filter(p => p.id !== preset.id && p.name !== preset.name)
  const next = [...others, preset]
  return next.length > MAX_LYRIC_PRESETS ? next.slice(next.length - MAX_LYRIC_PRESETS) : next
}

export function removePreset(list: LyricStylePreset[], id: string): LyricStylePreset[] {
  return list.filter(p => p.id !== id)
}

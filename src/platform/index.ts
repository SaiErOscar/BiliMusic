/**
 * 平台适配层唯一入口。
 *
 * service / utils 层只 import 这里的 `platform`，不再直接读 window.electronAPI。
 * 运行时按当前环境选择实现：Electron（window.electronAPI）→ Capacitor 原生容器
 * （Android，v1.4.7-pre3 起 WebDAV 云同步）→ 其余环境空对象，使所有 `if (platform.xxx)`
 * 探测自然落到降级分支（与现状 `if (window.electronAPI?.xxx)` 行为一致）。
 */

import type { Platform } from './types'
import { electronPlatform } from './electron'
import { capacitorPlatform, isCapacitorNative } from './capacitor'

function hasElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI
}

/** 当前运行环境的平台能力集合。 */
export const platform: Platform = hasElectron()
  ? electronPlatform
  : isCapacitorNative()
    ? capacitorPlatform
    : {}

/**
 * v1.4.8-pre1 原生容器判定（Android WebView）。
 * 设置页按此隐藏桌面专属项（桌面歌词外观：文字色/按钮色/字号/粗细/字体）。
 * 口径取 Capacitor.isNativePlatform()：鸿蒙端（web_engine + electronAPI 适配层）支持桌面歌词窗，
 * 不能按「miniWindow 缺失」判定为原生；web 构建恒 false。
 */
export function isNativeApp(): boolean {
  return isCapacitorNative()
}

export type { Platform } from './types'

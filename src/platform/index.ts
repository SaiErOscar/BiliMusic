/**
 * 平台适配层唯一入口。
 *
 * service / utils 层只 import 这里的 `platform`，不再直接读 window.electronAPI。
 * 运行时按当前环境选择实现：检测到 window.electronAPI 即用 Electron 实现。
 *
 * 扩展点（本轮不实现）：未来 Capacitor（Android）/ 鸿蒙端在此按 isNative()/isHarmony()
 * 等条件返回各自 Platform 实现；非 Electron 环境返回空对象，使所有 `if (platform.xxx)`
 * 探测自然落到降级分支（与现状 `if (window.electronAPI?.xxx)` 行为一致）。
 */

import type { Platform } from './types'
import { electronPlatform } from './electron'

function hasElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI
}

/** 当前运行环境的平台能力集合。 */
export const platform: Platform = hasElectron() ? electronPlatform : {}

export type { Platform } from './types'

import type { BrowserWindow } from 'electron'

// 推给渲染层的统一更新事件（整包 electron-updater + 渲染热补丁共用 updater:event 通道）
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'up-to-date'; version: string }
  | { type: 'available'; version: string; notes?: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'manual'; url: string }
  | { type: 'renderer-available'; version: string }
  | { type: 'renderer-progress'; percent: number }
  | { type: 'renderer-ready-to-apply'; version: string }
  /**
   * v1.4.14-pre1：OTA 已套用、实际生效版本发生变化。
   * 界面据此刷新版本号显示——app.getVersion() 是外壳版本，OTA 不会改变它，
   * 若只听外壳版本，热重载后版本号看起来永远不会更新。
   */
  | { type: 'version-changed'; version: string }
  | { type: 'error'; message: string }

let getWindow: () => BrowserWindow | null = () => null

export function setUpdaterWindow(fn: () => BrowserWindow | null): void {
  getWindow = fn
}

export function emitUpdater(event: UpdaterEvent): void {
  getWindow()?.webContents.send('updater:event', event)
}

// 诊断日志：桌面进终端/DevTools，鸿蒙进 hilog（可用 keyword "BiliMusic-OTA" 过滤）
export function ulog(...args: unknown[]): void {
  console.log('[BiliMusic-OTA]', ...args)
}

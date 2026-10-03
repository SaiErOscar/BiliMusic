/**
 * Electron 平台实现：把 window.electronAPI 的对应方法逐字段包装成平台无关的 Platform。
 *
 * 无业务逻辑，纯转发。每个 capability 用 getter 在访问时动态读取 window.electronAPI，
 * 与现状 `if (window.electronAPI?.xxx)` 的运行时能力探测语义完全等价：
 * electronAPI 缺失（如 SSR）或某子能力不存在时，对应字段返回 undefined，调用方走降级分支。
 */

import type { Platform } from './types'

function api() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined
}

export const electronPlatform: Platform = {
  get download() {
    return api()?.biliApi
  },
  get auth() {
    return api()?.biliApi
  },
  get biliRequest() {
    return api()?.biliApi
  },
  get favorites() {
    return api()?.biliApi
  },
  get lyrics() {
    return api()?.lyricsApi
  },
  get storage() {
    const a = api()
    return a?.webdavGet || a?.webdavPut ? { webdavGet: a.webdavGet, webdavPut: a.webdavPut } : undefined
  },
  get runtime() {
    const a = api()
    return a ? { platform: a.platform, persistentStorage: a.persistentStorage } : undefined
  },
  /** v1.4.4-pre1：系统字体枚举（UI 层 FontSelect 用，非 Electron 走内置保底列表） */
  get fonts() {
    const a = api()
    return a ? { listSystemFonts: a.listSystemFonts } : undefined
  },
  /** v1.4.4-pre1：桌面壳（窗口控制/最大化/全屏/标题栏按钮/外部链接），手机端无此能力 */
  get shell() {
    const a = api()
    if (!a) return undefined
    return {
      minimize: a.minimize,
      maximize: a.maximize,
      close: a.close,
      isMaximized: a.isMaximized,
      onMaximizedChange: a.onMaximizedChange,
      toggleFullscreen: a.toggleFullscreen,
      isFullscreen: a.isFullscreen,
      onFullscreenChange: a.onFullscreenChange,
      setWindowButtonVisibility: a.setWindowButtonVisibility,
      openExternal: a.openExternal,
    }
  },
  /** v1.4.4-pre1：托盘（播放状态推送与菜单命令订阅），手机端无此能力 */
  get tray() {
    const a = api()
    return a ? { updateTrayPlayerState: a.updateTrayPlayerState, onTrayPlayerCommand: a.onTrayPlayerCommand } : undefined
  },
}

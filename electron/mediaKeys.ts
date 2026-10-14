/**
 * 桌面全局媒体键（Electron globalShortcut）
 *
 * 场景：应用窗口失焦、最小化到托盘或前台在其他程序时，键盘上的
 * Play/Pause/Next/Prev/Stop 媒体键仍然控制 BiliMusic 播放。
 *
 * 设计：
 * - 默认关闭。开启走 IPC handler 'mediaKeys:set-enabled'；主进程维护
 *   当前 enabled 状态，重复调 setEnabled 幂等。
 * - globalShortcut.register 是全局占用，同 accelerator 若被系统其他
 *   程序先占会失败（返回 false）。开启失败时向渲染层回报，避免 UI 上
 *   「开了但没生效」的迷惑态。
 * - 反注册按 accelerator 精确 unregister，不用 unregisterAll（后者会
 *   把可能存在的其他全局快捷键一并抹掉）。
 * - 非桌面（openharmony 等 Electron 适配层）globalShortcut 可能不存在，
 *   调用 try/catch 静默失败。
 */
import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron'

type MediaKeyCommand = 'toggle-play' | 'next' | 'prev' | 'stop'

// 键位与命令映射，顺序固定以便 unregister 精确回退。
const ACCELERATORS: Array<{ accelerator: string; command: MediaKeyCommand }> = [
  { accelerator: 'MediaPlayPause', command: 'toggle-play' },
  { accelerator: 'MediaNextTrack', command: 'next' },
  { accelerator: 'MediaPreviousTrack', command: 'prev' },
  { accelerator: 'MediaStop', command: 'stop' },
]

let registered = false
let getWindow: () => BrowserWindow | null = () => null

function sendCommand(command: MediaKeyCommand): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('mediaKeys:command', command)
  }
}

function doRegister(): boolean {
  if (registered) return true
  let allOk = true
  for (const { accelerator, command } of ACCELERATORS) {
    try {
      const ok = globalShortcut.register(accelerator, () => sendCommand(command))
      if (!ok) allOk = false
    } catch {
      allOk = false
    }
  }
  registered = allOk
  return allOk
}

function doUnregister(): void {
  if (!registered) return
  for (const { accelerator } of ACCELERATORS) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // 反注册失败静默
    }
  }
  registered = false
}

/**
 * 注册 IPC 通道并绑定主窗口 getter。
 * @param windowGetter 返回当前主窗口（渲染层命令的投递目标）
 */
export function registerMediaKeysIpc(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  ipcMain.handle('mediaKeys:set-enabled', (_event, enabled: boolean) => {
    try {
      if (enabled) {
        if (!app.isReady()) return { ok: false, reason: 'not-ready' }
        const ok = doRegister()
        return { ok, reason: ok ? undefined : 'occupied' }
      }
      doUnregister()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'unknown' }
    }
  })

  ipcMain.handle('mediaKeys:get-enabled', () => registered)
}

/** 应用退出时兜底反注册。will-quit 中调用。 */
export function unregisterAllMediaKeys(): void {
  try {
    doUnregister()
  } catch {
    // ignore
  }
}

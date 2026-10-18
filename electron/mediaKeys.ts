/**
 * 桌面全局媒体键（Electron globalShortcut）
 *
 * 场景：应用窗口失焦、最小化到托盘或前台在其他程序时，键盘上的
 * Play/Pause/Next/Prev/Stop 媒体键仍然控制 BiliMusic 播放。
 *
 * 设计：
 * - 默认关闭。开启走 IPC handler 'mediaKeys:set-enabled'；主进程维护
 *   当前实际注册成功的键位集合，重复调 setEnabled 幂等。
 * - globalShortcut.register 是全局占用，同 accelerator 若被系统其他
 *   程序先占会失败（返回 false）。开启失败时向渲染层回报失败键位，
 *   避免 UI 上「开了但没生效」的迷惑态。
 * - v1.4.8-pre5 修复：注册状态以「实际成功的键位集合」为准，不再用单一
 *   布尔。原实现四键中任一失败即把 registered 置 false，已成功的键位既
 *   不会被反注册（doUnregister 早退），再次开启又会因同键已占用而恒失败，
 *   形成「开关显示关闭但媒体键仍被本应用占用」的残留。现在反注册遍历实际
 *   注册集合，部分失败可重试恢复，关闭开关必定释放全部已注册键位。
 * - 反注册按 accelerator 精确 unregister，不用 unregisterAll（后者会
 *   把可能存在的其他全局快捷键一并抹掉）。
 * - 非桌面（openharmony 等 Electron 适配层）globalShortcut 可能不存在，
 *   调用 try/catch 静默失败。
 */
import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron'

type MediaKeyCommand = 'toggle-play' | 'next' | 'prev' | 'stop'

/**
 * setEnabled 的回报。
 * - ok=true：全部键位注册成功（关闭时恒 true）
 * - reason=partial：部分键位被占用，failedKeys 列出失败项，其余仍生效
 * - reason=occupied：一个都没注册成功
 * - reason=not-ready：应用尚未 ready
 * - reason=error：注册过程抛异常，error 附原文
 */
export interface MediaKeysSetResult {
  ok: boolean
  reason?: 'not-ready' | 'occupied' | 'partial' | 'error'
  failedKeys?: string[]
  error?: string
}

// 键位与命令映射，顺序固定以便 unregister 精确回退。
const ACCELERATORS: Array<{ accelerator: string; command: MediaKeyCommand }> = [
  { accelerator: 'MediaPlayPause', command: 'toggle-play' },
  { accelerator: 'MediaNextTrack', command: 'next' },
  { accelerator: 'MediaPreviousTrack', command: 'prev' },
  { accelerator: 'MediaStop', command: 'stop' },
]

/** 实际注册成功的 accelerator 集合（唯一权威态，反注册以此为准） */
const registeredKeys = new Set<string>()
let getWindow: () => BrowserWindow | null = () => null

function sendCommand(command: MediaKeyCommand): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('mediaKeys:command', command)
  }
}

/**
 * 注册尚未持有的键位，返回本次仍失败的键位。
 * 已注册的键位直接跳过，因此部分失败后再次调用只会重试失败项，可自愈。
 */
function doRegister(): string[] {
  const failed: string[] = []
  for (const { accelerator, command } of ACCELERATORS) {
    if (registeredKeys.has(accelerator)) continue
    try {
      const ok = globalShortcut.register(accelerator, () => sendCommand(command))
      if (ok) registeredKeys.add(accelerator)
      else failed.push(accelerator)
    } catch {
      failed.push(accelerator)
    }
  }
  return failed
}

/** 反注册全部已注册键位；无论此前是否部分失败都会清空集合 */
function doUnregister(): void {
  for (const accelerator of [...registeredKeys]) {
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // 反注册失败静默
    }
  }
  registeredKeys.clear()
}

/** 当前是否有任一媒体键处于注册态（主进程权威态） */
export function isMediaKeysRegistered(): boolean {
  return registeredKeys.size > 0
}

/**
 * 注册 IPC 通道并绑定主窗口 getter。
 * @param windowGetter 返回当前主窗口（渲染层命令的投递目标）
 */
export function registerMediaKeysIpc(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  ipcMain.handle('mediaKeys:set-enabled', (_event, enabled: boolean): MediaKeysSetResult => {
    try {
      if (!enabled) {
        doUnregister()
        return { ok: true, failedKeys: [] }
      }
      if (!app.isReady()) return { ok: false, reason: 'not-ready', failedKeys: [] }
      const failed = doRegister()
      if (!failed.length) return { ok: true, failedKeys: [] }
      return {
        ok: false,
        reason: registeredKeys.size > 0 ? 'partial' : 'occupied',
        failedKeys: failed,
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        failedKeys: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle('mediaKeys:get-enabled', () => isMediaKeysRegistered())
}

/** 应用退出时兜底反注册。will-quit 中调用。 */
export function unregisterAllMediaKeys(): void {
  try {
    doUnregister()
  } catch {
    // ignore
  }
}

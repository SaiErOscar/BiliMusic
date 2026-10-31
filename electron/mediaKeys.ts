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
import fs from 'fs'
import path from 'path'

type MediaKeyCommand = 'toggle-play' | 'next' | 'prev' | 'stop'

/**
 * setEnabled 的回报。
 * - ok=true：全部键位注册成功（关闭时恒 true）
 * - reason=partial：部分键位被占用，failedKeys 列出失败项，其余仍生效
 * - reason=occupied：一个都没注册成功
 * - reason=not-ready：应用尚未 ready
 * - reason=error：注册过程抛异常，error 附原文
 * - reason=requires-restart（v1.4.13-pre14）：本次启动的收键路径与请求相反，
 *   必须重启才能切换。此时**不会**注册或反注册任何键位——返回当前真实状态。
 *   渲染层据此把开关回退并提示重启，避免「显示已开启但实际无效」。
 *
 * feature（v1.4.13-pre14）：本次启动实际采用的收键路径。
 * - hardware-keys：globalShortcut 生效，系统媒体面板（SMTC）不会出现本应用
 * - media-session：系统媒体面板出现本应用且控件可用，globalShortcut 不生效
 */
export interface MediaKeysSetResult {
  ok: boolean
  reason?: 'not-ready' | 'occupied' | 'partial' | 'error' | 'requires-restart'
  failedKeys?: string[]
  error?: string
  feature?: MediaKeysFeature
}

/**
 * 与 HardwareMediaKeyHandling 的互斥方案（v1.4.13-pre14 新增）。
 *
 * 两种收媒体键的路径是互斥的：
 * - globalShortcut 路径：需要 disable-features=HardwareMediaKeyHandling，
 *   否则 Chromium 抢先消费硬件媒体键，注册成功但回调永不触发（v1.4.9-pre3 的根因）。
 * - MediaSession 路径：需要该 feature 保持开启，Chromium 才会把
 *   navigator.mediaSession 桥接到 Windows SMTC；关掉后系统面板里不会有本应用。
 *
 * 因此按用户的 globalMediaKeys 设置二选一，并把选择结果回报给渲染层，
 * 避免出现「开关显示已开启但实际无效」的假象。
 */
export type MediaKeysFeature = 'hardware-keys' | 'media-session'

/**
 * 主进程可读的开关镜像文件。
 *
 * 桌面端真正的设置存在渲染层 localStorage（Chromium LevelDB），主进程在
 * app ready 之前没有同步读取的途径——而 appendSwitch 恰恰必须在 ready 之前。
 * 因此在渲染层每次改动开关时（它会调 setEnabled），主进程把**意图**写进这个
 * 小文件；下次启动时读它来决定 appendSwitch。文件只是镜像，渲染层设置仍是权威源。
 */
const PREFERENCE_FILE = 'media-keys-preference.json'
/** 默认值与 storage.ts DEFAULT_APP_SETTINGS.globalMediaKeys 保持一致 */
const DEFAULT_GLOBAL_MEDIA_KEYS = false

function preferenceFilePath(): string {
  return path.join(app.getPath('userData'), PREFERENCE_FILE)
}

/** 读取上次记录的开关键位意图；读不到一律回落到默认关闭 */
function readGlobalMediaKeysPreference(): boolean {
  try {
    const file = preferenceFilePath()
    if (!fs.existsSync(file)) return DEFAULT_GLOBAL_MEDIA_KEYS
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return parsed?.globalMediaKeys === true
  } catch {
    return DEFAULT_GLOBAL_MEDIA_KEYS
  }
}

/** 记录开关键位意图，供下次启动决定收键路径 */
function writeGlobalMediaKeysPreference(enabled: boolean): void {
  try {
    const file = preferenceFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ globalMediaKeys: enabled }, null, 2))
  } catch {
    // 写盘失败不影响本次会话：最坏情况是下次启动仍按旧意图走
  }
}

/**
 * 解析本次启动该走哪条收键路径。纯函数，便于单测。
 * 仅 Windows 上 HardwareMediaKeyHandling 与 SMTC 桥存在互斥；其它平台
 * globalShortcut 与 MediaSession 可以并存，统一走 media-session 即可。
 */
export function resolveMediaKeysFeature(
  platform: NodeJS.Platform | string,
  globalMediaKeys: boolean,
): MediaKeysFeature {
  if (platform !== 'win32') return 'media-session'
  return globalMediaKeys ? 'hardware-keys' : 'media-session'
}

/** 本次启动实际采用的路径（appendSwitch 之后即固定，运行期不再改变） */
let activeFeature: MediaKeysFeature = 'media-session'

/**
 * 必须在 app ready 之前调用。
 * - media-session：不 disable 该 feature，Chromium 才能桥接 SMTC
 * - hardware-keys：disable 该 feature，让硬件媒体键回到 OS 全局热键路径
 */
export function setMediaKeysFeatureSwitch(): MediaKeysFeature {
  activeFeature = resolveMediaKeysFeature(process.platform, readGlobalMediaKeysPreference())
  if (activeFeature === 'hardware-keys') {
    app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling')
  }
  return activeFeature
}

/** 当前生效的路径，供 IPC 回报与调试用 */
export function getMediaKeysFeature(): MediaKeysFeature {
  return activeFeature
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
      const wantHardwareKeys = Boolean(enabled)
      // 先记下意图：下次启动时 setMediaKeysFeatureSwitch 靠它决定 appendSwitch
      writeGlobalMediaKeysPreference(wantHardwareKeys)
      // 路径在 app ready 之前就固定了（appendSwitch 只在那时有效）。
      // 请求与当前路径不符时如实回报，让渲染层回退开关并提示重启——
      // 绝不能假装注册成功，那样界面会停在「已开启」而按键毫无反应。
      if (wantHardwareKeys !== (activeFeature === 'hardware-keys')) {
        return {
          ok: false,
          reason: 'requires-restart',
          failedKeys: [],
          feature: activeFeature,
        }
      }
      if (!enabled) {
        doUnregister()
        return { ok: true, failedKeys: [], feature: activeFeature }
      }
      if (!app.isReady()) return { ok: false, reason: 'not-ready', failedKeys: [], feature: activeFeature }
      const failed = doRegister()
      if (!failed.length) return { ok: true, failedKeys: [], feature: activeFeature }
      return {
        ok: false,
        reason: registeredKeys.size > 0 ? 'partial' : 'occupied',
        failedKeys: failed,
        feature: activeFeature,
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        failedKeys: [],
        error: err instanceof Error ? err.message : String(err),
        feature: activeFeature,
      }
    }
  })

  ipcMain.handle('mediaKeys:get-enabled', () => isMediaKeysRegistered())
  ipcMain.handle('mediaKeys:get-feature', () => activeFeature)
}

/** 应用退出时兜底反注册。will-quit 中调用。 */
export function unregisterAllMediaKeys(): void {
  try {
    doUnregister()
  } catch {
    // ignore
  }
}

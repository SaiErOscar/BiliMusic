import { app, BrowserWindow, Tray, ipcMain, nativeImage, net, protocol, screen, session, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { registerBiliApiHandlers, killAllChildren } from './biliApi'
import { registerLyricsApiHandlers } from './lyricsApi'
import { initUpdates, getActiveRendererRoot } from './updater'
import { registerWebdavHandlers } from './webdav'
import { registerMiniWindowHandlers, onMainWindowActivityChanged, destroyLyricWindow, isLyricVisible, toggleLyricWindow } from './miniWindows'
import { registerSystemFontsHandlers } from './systemFonts'
import { registerColorPickerHandlers } from './colorPicker'
import { registerBackupHandlers } from './backup'
import { registerNativeDialogHandlers } from './nativeDialog'
import { registerAiHandlers } from './ai'
import { registerProfileHandlers } from './profile'
import { registerWorkBuddyHandlers } from './workbuddy'
import { registerMvExportHandlers, killMvExportChildren } from './mvExport'
import { registerMediaKeysIpc, setMediaKeysFeatureSwitch, unregisterAllMediaKeys } from './mediaKeys'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isHarmonyOS = (process.platform as string) === 'openharmony'

// 生产环境用自定义 app:// 协议加载渲染层：file:// 下 ESM(type=module) 脚本会被
// Chromium 的 CORS 策略拦截（file:// 为不透明源）导致页面空白。自定义标准安全协议
// 提供合法 origin，模块脚本与相对资源即可正常加载。须在 app ready 之前注册。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

// Chrome MCP 远程调试（仅开发环境启用，生产环境关闭以防远程代码执行攻击）
if (process.env.VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch('remote-debugging-port', '17689')
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

// v1.4.13-pre14 系统媒体控制：HardwareMediaKeyHandling 的去留由 mediaKeys 模块统一决定。
//
// 历史：v1.4.9-pre3 曾无条件 disable 这个 feature（见 mediaKeys.ts 顶部长注释）。
// 但该 feature 同时也是 Chromium 把渲染层 navigator.mediaSession 桥接到
// Windows SMTC 的开关——关掉之后系统音量浮层里永远不会出现 BiliMusic。
// 两者互斥，因此改为按用户的「全局媒体键」设置二选一，见 resolveMediaKeysFeature。
//
// 必须在 app ready 之前 appendSwitch，故仍在模块顶层执行（此时开关值已可读盘）。
setMediaKeysFeatureSwitch()

// B站请求头处理
//
// 注意：Electron 每个 session 的 webRequest 事件只允许注册一个监听器，
// 重复调用 onBeforeSendHeaders 会覆盖之前的。因此资源 CDN 与 API 的请求头
// 处理必须合并在同一个监听器内，否则后注册的会让前者失效（音频 CDN 拿不到
// Referer → 403）。
function setupBiliHeaders() {
  // 覆盖 B站所有资源/接口域名（图片、音频 CDN、API、登录）
  const biliUrls = [
    'https://*.hdslb.com/*',
    'https://*.bilivideo.com/*',
    'https://*.bilivideo.cn/*',
    'https://*.akamaized.net/*',
    'https://*.bilibili.com/*',
  ]

  // 记录每个 API 请求的渲染进程真实 Origin，供 onHeadersReceived 回显。
  // credentials:'include' 模式下浏览器要求 ACAO 必须是具体 origin，不能为 '*'，
  // 否则跨域响应被拦（dev 的 http://localhost:5173 会触发，file:// 不会）。
  const reqOrigin = new Map<number, string>()

  // 请求发出前：注入 Referer + Origin（改写到 bilibili.com 绕过反爬）。
  // 音频/图片 CDN（bilivideo/hdslb）缺少 Referer 会返回 403。
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: biliUrls }, (details, callback) => {
    const headers = details.requestHeaders
    const origin = headers['Origin'] || headers['origin']
    // 仅记录 API/passport 请求的真实 origin（这些请求才有对应的 onHeadersReceived 消费并清理）
    if (origin && /^(https?|app):\/\//.test(origin) && /\/\/(api|passport)\.bilibili\.com/.test(details.url)) {
      reqOrigin.set(details.id, origin)
    }
    headers['Referer'] = 'https://www.bilibili.com'
    headers['Origin'] = 'https://www.bilibili.com'
    callback({ requestHeaders: headers })
  })

  // API/passport 响应：写入 CORS 头，让渲染进程的浏览器 fetch 可跨域读取。
  //
  // v1.4.9-pre2 起把音频/图片 CDN 一并纳入：音频可视化需要把 CDN 直链取成同源 Blob
  // （Web Audio 的 createMediaElementSource 拿不到跨域音频的频谱数据），而渲染层
  // fetch CDN 会被 CORS 拦截——此处补上 ACAO，渲染层才能读到响应体。
  // 注意：媒体元素/图片走 no-cors 加载，不受此头影响，故对既有播放与封面零变化。
  const apiUrls = {
    urls: [
      'https://api.bilibili.com/*',
      'https://passport.bilibili.com/*',
      'https://*.bilivideo.com/*',
      'https://*.bilivideo.cn/*',
      'https://*.akamaized.net/*',
      'https://*.hdslb.com/*',
    ],
  }
  session.defaultSession.webRequest.onHeadersReceived(apiUrls, (details, callback) => {
    const respHeaders: Record<string, string[]> = {}
    if (details.responseHeaders) {
      for (const [key, value] of Object.entries(details.responseHeaders)) {
        if (!key.toLowerCase().startsWith('access-control-allow')) {
          respHeaders[key] = value as string[]
        }
      }
    }
    const origin = reqOrigin.get(details.id)
    reqOrigin.delete(details.id)
    // 回显渲染进程真实 origin（带 credentials 时不能用 '*'）；取不到时退回 '*'（file:// 场景）
    respHeaders['access-control-allow-origin'] = [origin || '*']
    respHeaders['access-control-allow-credentials'] = ['true']
    respHeaders['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS']
    respHeaders['access-control-allow-headers'] = ['*']
    callback({ responseHeaders: respHeaders })
  })
}

let mainWindow: BrowserWindow | null = null

/**
 * 当前主题，供启动阶段选图标用。
 *
 * v1.4.13-pre8：托盘与窗口在窗口创建时就需要图标，而主题要等渲染层起来才知道。
 * 先给默认值，applyThemedIcons 被调用时再更新——这样启动瞬间也不会拿错配色。
 */
let currentThemeId = 'default'
let currentThemeMode: 'light' | 'dark' = 'dark'
let tray: Tray | null = null
let trayWindow: BrowserWindow | null = null
let trayWindowReady = false
let pendingTrayShow: { x: number; y: number } | null = null
let isQuitting = false
let quitCleaned = false
let forceExitTimer: ReturnType<typeof setTimeout> | null = null

type TrayCommand = 'toggle-play' | 'next' | 'prev' | 'show-window' | 'quit' | 'toggle-lyric'

interface TrayPlayerState {
  hasTrack: boolean
  title: string
  artist: string
  coverUrl: string
  isPlaying: boolean
  queueLength: number
  theme: 'light' | 'dark'
  /** 桌面歌词窗当前是否实际可见（驱动托盘按钮文案/高亮） */
  lyricVisible: boolean
}

let trayPlayerState: TrayPlayerState = {
  hasTrack: false,
  title: '未在播放',
  artist: '搜索并播放音乐',
  coverUrl: '',
  isPlaying: false,
  queueLength: 0,
  theme: 'dark',
  lyricVisible: false,
}

// 应用图标：dev 时从 electron 源目录加载，打包后从 dist-electron 同级加载（由 copy 脚本随构建复制）
function loadAppIcon(fileName = 'icon.png') {
  const iconPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron', fileName)
    : path.join(__dirname, fileName)
  return nativeImage.createFromPath(iconPath)
}

/**
 * 任务栏/标题栏用的多尺寸图标。
 *
 * v1.4.13-pre8（用户第 1 项「任务栏显得很暗」的根因）：
 * 之前给 BrowserWindow 的是单张 1024px PNG。Windows 任务栏要的是 16/24/32px，
 * 它只能自己按面积平均去缩——浅粉底与近白字形缩完糊在一起，看着就发暗。
 * ico 里嵌了 16/24/32/48/64/128/256 七档，系统直接挑最合适的那一档，
 * 不做重采样，因此和桌面图标/资源管理器里看到的是同一张。
 */
function loadAppIco(): Electron.NativeImage {
  const icoPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron/app.ico')
    : path.join(process.resourcesPath || __dirname, 'app.ico')
  const ico = nativeImage.createFromPath(icoPath)
  return ico.isEmpty() ? loadAppIcon() : ico
}

/**
 * 启动时该用的图标。
 *
 * v1.4.13-pre8（用户第 1 项：任务栏显得很暗）：
 * 原来窗口与托盘在启动时都用 loadAppIcon()，也就是**未经主题化的 1024px 原图**。
 * 它本身是浅粉底，但 Windows 把 1024 缩到 16/24px 时按面积平均，
 * 字形与底色糊成一团，看起来就是「发暗」。这里改为：
 * - 默认主题直接用打包进 resources 的成品图标（1024 原图，与桌面图标完全一致）；
 * - 其它主题等 applyThemedIcons 换成对应配色的 256px 版本。
 * 关键是**不要**在启动阶段就拿未改色的原图去顶替主题图标。
 */
function startupIcon(): Electron.NativeImage {
  const img = loadAppIcon()
  return img.isEmpty() ? loadAppIcon() : img
}

/**
 * v1.4.13-pre3 主题化图标：按当前主题取对应配色的图标。
 *
 * 图标集由 scripts/make-theme-icons.cjs 预生成（同设计、不同主色），放在 electron/icons/。
 * 找不到对应文件时回落到默认图标——自定义基色没有预生成图标，就走这条回落。
 */
function loadThemedIcon(themeId: string, mode: 'light' | 'dark', kind: 'icon' | 'tray' = 'icon') {
  const name = kind + '-' + themeId + '-' + mode + '.png'
  // 打包后图标集放在 resources/icons（extraResources），**不能**放进 asar：
  // 实测 nativeImage.createFromPath 读 asar 内路径返回空图，会导致所有主题图标静默失效。
  const base = process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron')
    : path.join(process.resourcesPath || __dirname, 'icons')
  const themed = nativeImage.createFromPath(path.join(base, name))
  if (!themed.isEmpty()) return themed
  return loadAppIcon(kind === 'tray' ? 'tray.png' : 'icon.png')
}

/**
 * 把当前主题的图标应用到主窗口与托盘。
 *
 * v1.4.13-pre4 修两个实测问题：
 * 1. **标题栏/任务栏图标不刷新**：Windows 对已显示的窗口，单次 setIcon 常被系统缓存吞掉。
 *    改为「设置 + 延迟再设一次」的双写（延迟 60ms），实测能刷新任务栏与标题栏。
 * 2. **托盘图标发白**：原实现用 icon.png（彩色）给托盘，且重着色按亮度调制，
 *    纯白源图被拉到最亮。现在托盘用独立的 tray-*.png（单色语义，直接赋主题色）。
 */
function applyThemedIcons(themeId: string, mode: 'light' | 'dark') {
  currentThemeId = themeId || 'default'
  currentThemeMode = mode === 'dark' ? 'dark' : 'light'
  try {
    const apply = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const img = loadThemedIcon(themeId, mode, 'icon')
        /*
         * v1.4.13-pre4 三次修正：Windows 对已显示窗口的标题栏/任务栏图标有强缓存，
         * 单次或两次 setIcon 都可能被吞。这里改成三连写（0 / 80 / 300ms），
         * 并在每次之前把图标重新 createFromPath 一次——复用同一个 nativeImage
         * 对象时系统会认为「没变化」而跳过重绘。
         */
        const push = () => {
          try {
            if (!mainWindow || mainWindow.isDestroyed()) return
            mainWindow.setIcon(loadThemedIcon(themeId, mode, 'icon'))
          } catch { /* ignore */ }
        }
        mainWindow.setIcon(img)
        setTimeout(push, 80)
        setTimeout(push, 300)
      }
      if (tray) {
        /*
         * v1.4.13-pre7：托盘直接用 tray-*.png。
         * 这张图本身就是「与 icon.ico 同一套设计、只换主色」的成品
         * （浅色渐变底 + 明亮白字 + 光影），不需要再缩放桌面图标——
         * 那样做会把 256px 的立体图缩成一团，反而更糊。
         */
        tray.setImage(loadThemedIcon(themeId, mode, 'tray'))
      }
    }
    apply()
  } catch {
    /* 图标切换失败不影响主流程 */
  }
}

function createTrayIcon() {
  /*
   * v1.4.13-pre8：托盘启动图标也走主题化成品。
   * 之前用 loadAppIcon()（未改色的 1024 原图）缩到 32px，
   * 浅粉底 + 近白字形一缩就糊成一团，用户看到的就是「很暗」。
   * 现在先按当前主题取 tray-*.png（本身就是 256px 成品），
   * 主题未知时退回 ico 的 32px 档。
   */
  const themed = loadThemedIcon(currentThemeId, currentThemeMode, 'tray')
  if (!themed.isEmpty()) return themed.resize({ width: 32, height: 32 })
  const ico = loadAppIco()
  return ico.isEmpty() ? loadAppIcon().resize({ width: 32, height: 32 }) : ico.resize({ width: 32, height: 32 })
}

function persistentStoreFile() {
  return path.join(app.getPath('userData'), 'renderer-persistent-store.json')
}

function readPersistentStore(): Record<string, string> {
  try {
    const file = persistentStoreFile()
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

function writePersistentStore(store: Record<string, string>) {
  try {
    const file = persistentStoreFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(store, null, 2))
  } catch {
    // Persistence failures should not block the renderer.
  }
}

function showMainWindow() {
  if (!mainWindow) createWindow()
  if (process.platform === 'darwin') app.dock?.show()
  mainWindow?.show()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
}

function updateTrayState() {
  tray?.setToolTip(trayPlayerState.hasTrack
    ? `${trayPlayerState.isPlaying ? '正在播放' : '已暂停'}: ${trayPlayerState.title}`
    : 'BiliMusic')
  trayWindow?.webContents.send('tray:state', trayPlayerState)
}

function getTrayHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    /* 深色为默认，body.light 切换为浅色，跟随 app 主题 */
    :root {
      --tray-menu-bg: linear-gradient(180deg, rgba(38, 38, 42, .94), rgba(18, 18, 20, .96)), rgba(24, 24, 26, .96);
      --tray-menu-border: rgba(255, 255, 255, .12);
      --tray-menu-shadow: 0 28px 80px rgba(0, 0, 0, .44), inset 0 1px rgba(255, 255, 255, .12);
      --tray-text: #f7f7f8;
      --tray-now-bg: rgba(255, 255, 255, .075);
      --tray-now-border: rgba(255, 255, 255, .08);
      --tray-cover-fallback: rgba(255, 255, 255, .62);
      --tray-meta-sub: rgba(255, 255, 255, .48);
      --tray-status: rgba(255, 255, 255, .44);
      --tray-btn-bg: rgba(255, 255, 255, .1);
      --tray-btn-bg-hover: rgba(255, 255, 255, .16);
      --tray-btn-text: #fff;
      --tray-actions-border: rgba(255, 255, 255, .1);
      --tray-row-text: rgba(255, 255, 255, .82);
      --tray-row-hover: rgba(255, 255, 255, .1);
      --tray-count: rgba(255, 255, 255, .38);
    }
    body.light {
      --tray-menu-bg: linear-gradient(180deg, rgba(252, 252, 253, .95), rgba(244, 245, 248, .97)), rgba(255, 255, 255, .96);
      --tray-menu-border: rgba(24, 25, 28, .1);
      --tray-menu-shadow: 0 28px 80px rgba(24, 25, 28, .18), inset 0 1px rgba(255, 255, 255, .9);
      --tray-text: #18191C;
      --tray-now-bg: rgba(24, 25, 28, .04);
      --tray-now-border: rgba(24, 25, 28, .07);
      --tray-cover-fallback: rgba(24, 25, 28, .5);
      --tray-meta-sub: rgba(24, 25, 28, .5);
      --tray-status: rgba(24, 25, 28, .5);
      --tray-btn-bg: rgba(24, 25, 28, .06);
      --tray-btn-bg-hover: rgba(24, 25, 28, .1);
      --tray-btn-text: #18191C;
      --tray-actions-border: rgba(24, 25, 28, .08);
      --tray-row-text: rgba(24, 25, 28, .82);
      --tray-row-hover: rgba(24, 25, 28, .06);
      --tray-count: rgba(24, 25, 28, .4);
    }
    * { box-sizing: border-box; user-select: none; }
    body {
      width: 330px;
      height: 342px;
      margin: 0;
      overflow: hidden;
      color: var(--tray-text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: transparent;
    }
    .menu {
      width: 100%;
      height: 100%;
      padding: 14px;
      border-radius: 22px;
      background: var(--tray-menu-bg);
      border: 1px solid var(--tray-menu-border);
      box-shadow: var(--tray-menu-shadow);
      backdrop-filter: blur(30px) saturate(160%);
    }
    .now {
      display: flex;
      gap: 12px;
      align-items: center;
      min-height: 76px;
      padding: 10px;
      border-radius: 16px;
      background: var(--tray-now-bg);
      border: 1px solid var(--tray-now-border);
    }
    .cover {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      overflow: hidden;
      flex: 0 0 auto;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(255,55,95,.42), rgba(255,255,255,.08));
      box-shadow: 0 12px 30px rgba(0,0,0,.22);
    }
    .cover img { width: 100%; height: 100%; object-fit: cover; display: none; }
    .cover span { color: var(--tray-cover-fallback); font-size: 22px; }
    .meta { min-width: 0; flex: 1; }
    .meta strong, .meta small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta strong { font-size: 14px; line-height: 1.2; font-weight: 760; }
    .meta small { margin-top: 5px; color: var(--tray-meta-sub); font-size: 12px; font-weight: 560; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 12px 2px 10px;
      color: var(--tray-status);
      font-size: 11px;
      font-weight: 680;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #8e8e93;
      box-shadow: 0 0 0 transparent;
    }
    .status.is-playing .dot {
      background: #30d158;
      box-shadow: 0 0 14px rgba(48,209,88,.65);
    }
    .controls {
      display: grid;
      grid-template-columns: 1fr 1.25fr 1fr;
      gap: 10px;
      padding: 0 4px 12px;
    }
    button {
      height: 42px;
      border: 0;
      border-radius: 999px;
      color: var(--tray-btn-text);
      background: var(--tray-btn-bg);
      cursor: pointer;
      font: 780 13px/1 system-ui, sans-serif;
      transition: transform .16s ease, background .16s ease, opacity .16s ease;
    }
    button:hover { background: var(--tray-btn-bg-hover); transform: translateY(-1px); }
    button:active { transform: scale(.96); }
    button:disabled { opacity: .42; cursor: default; transform: none; }
    .play {
      background: #ff375f;
      color: #fff;
      box-shadow: 0 14px 30px rgba(255,55,95,.26);
      font-size: 16px;
    }
    .play:hover { background: #ff375f; }
    .actions {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--tray-actions-border);
      padding-top: 12px;
    }
    .row {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 13px;
      text-align: left;
      border-radius: 12px;
      background: transparent;
      color: var(--tray-row-text);
    }
    .row:hover { background: var(--tray-row-hover); }
    .row.danger { color: #ff6961; }
    .row.is-active { color: #ff375f; font-weight: 800; }
    .count { color: var(--tray-count); font-size: 12px; }
  </style>
</head>
<body>
  <div class="menu">
    <div class="now">
      <div class="cover"><img id="cover" /><span id="fallback">♪</span></div>
      <div class="meta">
        <strong id="title">未在播放</strong>
        <small id="artist">搜索并播放音乐</small>
      </div>
    </div>
    <div id="status" class="status"><span class="dot"></span><span id="statusText">空闲</span></div>
    <div class="controls">
      <button id="prev" title="上一首">⏮</button>
      <button id="play" class="play" title="播放/暂停">▶</button>
      <button id="next" title="下一首">⏭</button>
    </div>
    <div class="actions">
      <button class="row" id="show"><span>显示 BiliMusic</span><span class="count" id="queue">0 首</span></button>
      <button class="row" id="lyric"><span id="lyricLabel">打开桌面歌词</span><span class="count" id="lyricState">已关闭</span></button>
      <button class="row danger" id="quit"><span>退出应用</span><span>⌘Q</span></button>
    </div>
  </div>
  <script>
    const { onState, getState, sendCommand } = window.trayAPI
    const $ = (id) => document.getElementById(id)
    let state = { hasTrack: false, title: '未在播放', artist: '搜索并播放音乐', coverUrl: '', isPlaying: false, queueLength: 0, theme: 'dark', lyricVisible: false }
    function render(next) {
      state = next || state
      document.body.classList.toggle('light', (state.theme || 'dark') === 'light')
      $('title').textContent = state.title || '未在播放'
      $('artist').textContent = state.artist || '搜索并播放音乐'
      $('status').className = 'status' + (state.isPlaying ? ' is-playing' : '')
      $('statusText').textContent = state.hasTrack ? (state.isPlaying ? '正在播放' : '已暂停') : '空闲'
      $('play').textContent = state.isPlaying ? '⏸' : '▶'
      $('queue').textContent = (state.queueLength || 0) + ' 首'
      $('lyricLabel').textContent = state.lyricVisible ? '关闭桌面歌词' : '打开桌面歌词'
      $('lyricState').textContent = state.lyricVisible ? '显示中' : '已关闭'
      $('lyric').classList.toggle('is-active', Boolean(state.lyricVisible))
      $('prev').disabled = $('play').disabled = $('next').disabled = !state.hasTrack
      if (state.coverUrl) {
        $('cover').src = state.coverUrl
        $('cover').style.display = 'block'
        $('fallback').style.display = 'none'
      } else {
        $('cover').removeAttribute('src')
        $('cover').style.display = 'none'
        $('fallback').style.display = 'block'
      }
    }
    onState((next) => render(next))
    getState().then(render)
    $('prev').onclick = () => sendCommand('prev')
    $('play').onclick = () => sendCommand('toggle-play')
    $('next').onclick = () => sendCommand('next')
    $('show').onclick = () => sendCommand('show-window')
    $('lyric').onclick = () => sendCommand('toggle-lyric')
    $('quit').onclick = () => sendCommand('quit')
  </script>
</body>
</html>`
}

function createTrayWindow() {
  if (isHarmonyOS) return null
  if (trayWindow) return trayWindow
  trayWindowReady = false
  trayWindow = new BrowserWindow({
    width: 330,
    height: 342,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    opacity: 0,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: process.env.VITE_DEV_SERVER_URL
        ? path.join(__dirname, '../electron/tray-preload.cjs')
        : path.join(__dirname, 'tray-preload.cjs'),
    },
  })
  trayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getTrayHtml())}`)
  trayWindow.once('ready-to-show', () => {
    trayWindowReady = true
    if (pendingTrayShow) {
      const pos = pendingTrayShow
      pendingTrayShow = null
      showTrayWindowAt(pos.x, pos.y)
    }
  })
  trayWindow.on('blur', () => {
    trayWindow?.setOpacity(0)
    trayWindow?.hide()
  })
  trayWindow.on('closed', () => {
    trayWindow = null
    trayWindowReady = false
    pendingTrayShow = null
  })
  return trayWindow
}

function showTrayWindowAt(x: number, y: number) {
  const win = createTrayWindow()
  if (!win) return
  if (!trayWindowReady) {
    pendingTrayShow = { x, y }

  }
  win.setPosition(x, y, false)
  updateTrayState()
  win.setOpacity(0)
  win.showInactive()
  setTimeout(() => {
    if (!trayWindow?.isVisible()) return
    trayWindow.setOpacity(1)
    trayWindow.focus()
  }, 20)
}

function toggleTrayWindow() {
  if (isHarmonyOS) return
  if (!tray) return
  const win = createTrayWindow()
  if (!win) return
  if (win.isVisible()) {
    win.setOpacity(0)
    win.hide()

  }

  const bounds = tray.getBounds()
  const { workArea } = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
  const width = 330
  const height = 342
  const x = Math.round(Math.min(Math.max(bounds.x + bounds.width / 2 - width / 2, workArea.x + 8), workArea.x + workArea.width - width - 8))
  const aboveY = bounds.y - height - 10
  const belowY = bounds.y + bounds.height + 10
  const y = aboveY >= workArea.y ? aboveY : Math.min(belowY, workArea.y + workArea.height - height - 8)

  showTrayWindowAt(x, Math.round(y))
}

function createTray() {
  if (tray) return
  tray = new Tray(createTrayIcon())
  tray.setToolTip('BiliMusic')
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  if (!isHarmonyOS) {
    tray.on('right-click', toggleTrayWindow)
    createTrayWindow()
  }
}

function hideToTray() {
  mainWindow?.hide()
  if (process.platform === 'darwin') app.dock?.hide()
}

function sendTrayCommand(command: TrayCommand) {
  if (command === 'toggle-lyric') {
    // 直接走主进程切换桌面歌词意图（不转发渲染层，避免多余往返）
    toggleLyricWindow()
    trayWindow?.hide()
    return
  }
  if (command === 'show-window') {
    showMainWindow()
    trayWindow?.hide()

  }
  if (command === 'quit') {
    isQuitting = true
    trayWindow?.close()
    mainWindow?.destroy()
    app.quit()

  }
  mainWindow?.webContents.send('tray:player-command', command)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'BiliMusic',
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    minimizable: true,
    maximizable: true,
    closable: true,
    // 首帧绘制完成前不显示窗口，避免冷启动先弹出一个空白窗口。
    // 鸿蒙上窗口显隐与托盘强耦合（见 whenReady 内的创建顺序），保持原有「创建即可见」行为。
    ...(isHarmonyOS ? {} : { show: false }),
    ...(!isHarmonyOS ? { titleBarStyle: 'hidden' as const } : {}),
    backgroundColor: '#F6F7F9',
    // v1.4.13-pre8：用多尺寸 ico，让 Windows 挑合适档位而不是自己糊缩 1024 图
    icon: loadAppIco(),
    webPreferences: {
      preload: process.env.VITE_DEV_SERVER_URL
        ? path.join(__dirname, '../electron/preload.cjs')
        : path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadURL('app://local/index.html')
  }

  // 配合 show:false：首帧就绪（ready-to-show）后再显示，消除冷启动空白窗口。
  // 兜底 2.5s 强制显示：若加载异常导致事件不触发，应用不会「启动即隐形」。
  // showMainWindow() 也会提前 show()，故 revealed 保证只执行一次。
  if (!isHarmonyOS) {
    let revealed = false
    const reveal = () => {
      if (revealed) return
      revealed = true
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.show()
      mainWindow.focus()
    }
    mainWindow.once('ready-to-show', reveal)
    const revealFallback = setTimeout(reveal, 2500)
    mainWindow.once('closed', () => clearTimeout(revealFallback))
  }

  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideToTray()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const sendMaximizeState = () => {
    mainWindow?.webContents.send('window:maximized-change', Boolean(mainWindow?.isMaximized() || mainWindow?.isFullScreen()))
  }
  const sendFullscreenState = () => {
    mainWindow?.webContents.send('window:fullscreen-change', Boolean(mainWindow?.isFullScreen()))
  }
  mainWindow.on('maximize', sendMaximizeState)
  mainWindow.on('unmaximize', sendMaximizeState)

  // v1.3.1：主窗口焦点/显隐变化 → 重新计算桌面歌词可见性
  // （主窗口不在焦点即视为不在播放页，可正常显示桌面歌词）
  const notifyLyricActivity = () => onMainWindowActivityChanged()
  mainWindow.on('focus', notifyLyricActivity)
  mainWindow.on('blur', notifyLyricActivity)
  mainWindow.on('show', notifyLyricActivity)
  mainWindow.on('hide', notifyLyricActivity)
  mainWindow.on('restore', notifyLyricActivity)
  mainWindow.on('minimize', notifyLyricActivity)
  mainWindow.on('enter-full-screen', () => {
    sendMaximizeState()
    sendFullscreenState()
  })
  mainWindow.on('leave-full-screen', () => {
    sendMaximizeState()
    sendFullscreenState()
  })
}

// 窗口控制 IPC
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})
ipcMain.on('window:close', hideToTray)
ipcMain.handle('window:isMaximized', () => Boolean(mainWindow?.isMaximized() || mainWindow?.isFullScreen()))
ipcMain.on('window:toggle-fullscreen', () => {
  if (!mainWindow) return
  const next = !mainWindow.isFullScreen()
  mainWindow.setFullScreen(next)
  mainWindow.webContents.send('window:fullscreen-change', next)
  mainWindow.webContents.send('window:maximized-change', Boolean(mainWindow.isMaximized() || next))
})
ipcMain.on('window:set-button-visibility', (_event, visible: boolean) => {
  if (!isHarmonyOS) return
  const next = Boolean(visible)
  const setWindowButtonVisibility = (mainWindow as unknown as {
    setWindowButtonVisibility?: (visible: boolean) => void
  } | null)?.setWindowButtonVisibility
  if (typeof setWindowButtonVisibility === 'function') {
    setWindowButtonVisibility.call(mainWindow, next)
  }
  mainWindow?.setTitle(`__BILIMUSIC_WINDOW_BUTTONS__:${next ? 'show' : 'hide'}`)
})
ipcMain.handle('window:isFullscreen', () => Boolean(mainWindow?.isFullScreen()))
ipcMain.on('tray:player-state', (_event, state: TrayPlayerState) => {
  trayPlayerState = {
    hasTrack: Boolean(state?.hasTrack),
    title: String(state?.title || '未在播放'),
    artist: String(state?.artist || '搜索并播放音乐'),
    coverUrl: String(state?.coverUrl || ''),
    isPlaying: Boolean(state?.isPlaying),
    queueLength: Number(state?.queueLength || 0),
    theme: state?.theme === 'light' ? 'light' : 'dark',
    // lyricVisible 由主进程回调维护，不信任渲染层推送
    lyricVisible: trayPlayerState.lyricVisible,
  }
  updateTrayState()
})
ipcMain.on('tray:command', (_event, command: TrayCommand) => sendTrayCommand(command))
ipcMain.handle('tray:get-state', () => trayPlayerState)
ipcMain.handle('persistent-storage:get', (_event, key: string) => {
  if (typeof key !== 'string') {
    return null
  }
  return readPersistentStore()[key] ?? null
})
ipcMain.handle('persistent-storage:set', (_event, key: string, value: string) => {
  if (typeof key !== 'string' || typeof value !== 'string') return
  const store = readPersistentStore()
  store[key] = value
  writePersistentStore(store)
})
ipcMain.handle('persistent-storage:remove', (_event, key: string) => {
  if (typeof key !== 'string') return
  const store = readPersistentStore()
  delete store[key]
  writePersistentStore(store)
})
// 用系统默认浏览器打开外部链接（仅放行 http/https，避免任意协议执行）
ipcMain.handle('shell:open-external', (_event, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
})

app.whenReady().then(() => {
  // 生产环境注册 app:// 协议，映射到打包后的 dist 目录（asar 内 file:// 读取透明支持）
  if (!process.env.VITE_DEV_SERVER_URL) {
    protocol.handle('app', async (request) => {
      const { pathname } = new URL(request.url)
      // 渲染层根目录可能是包内 dist 或已生效的 OTA asar（net.fetch 透明读 asar 内部）
      const filePath = path.join(getActiveRendererRoot(), decodeURIComponent(pathname))
      try {
        return await net.fetch(pathToFileURL(filePath).toString())
      } catch (err) {
        // 关键诊断：鸿蒙上若读沙箱 asar 失败会在此命中（filePath 含 .asar）
        console.log('[BiliMusic-OTA] app:// fetch FAILED:', filePath, '—', err instanceof Error ? err.message : String(err))
        throw err
      }
    })
  }
  setupBiliHeaders()
  registerBiliApiHandlers()
  registerLyricsApiHandlers()
  registerWebdavHandlers()
  registerSystemFontsHandlers()
  registerColorPickerHandlers()
  registerBackupHandlers()
  // v1.4.13-pre14 原生确认框：渲染层不再用 window.confirm，改由主进程弹系统对话框
  registerNativeDialogHandlers()
  registerMvExportHandlers()
  // v1.4.11-pre3 AI 底座：Provider 配置（safeStorage 加密落盘）+ 代理下发
  registerAiHandlers()
  // v1.4.13-pre1 用户画像外部文件 + 学习记录
  registerProfileHandlers()
  // v1.4.13-pre4 WorkBuddy 国内/国际版（本地凭据 + 网页登录 + 模型列表 + chat）
  registerWorkBuddyHandlers()
  // v1.4.13-pre3 主题化图标：渲染层切换主题后通知主进程换图
  ipcMain.handle('theme:apply-icon', (_e, themeId: string, mode: 'light' | 'dark') => {
    applyThemedIcons(String(themeId || 'default'), mode === 'dark' ? 'dark' : 'light')
    return { ok: true }
  })
  registerMediaKeysIpc(() => mainWindow)
  registerMiniWindowHandlers({
    getMainWindow: () => mainWindow,
    // 歌词可见性变化 → 刷新托盘状态的 lyricVisible 并回推托盘窗口
    onLyricVisibleChange: () => {
      const visible = isLyricVisible()
      if (trayPlayerState.lyricVisible === visible) return
      trayPlayerState = { ...trayPlayerState, lyricVisible: visible }
      trayWindow?.webContents.send('tray:state', trayPlayerState)
    },
  })
  // 更新模块须在创建窗口前初始化：bootReconcile 先定下生效的渲染层根目录，供 app:// 加载
  initUpdates({
    window: () => mainWindow,
    bundledRendererRoot: path.join(__dirname, '../dist'),
    reload: () => {
      mainWindow?.loadURL('app://local/index.html')
    },
  })
  if (isHarmonyOS) {
    // OpenHarmony 上窗口显示/隐藏与托盘强相关，需先创建托盘再创建主窗口。
    createTray()
    createWindow()
  } else {
    createWindow()
    createTray()
  }
})

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
  else showMainWindow()
})

// 统一退出清理：无论从哪条路径退出（托盘 quit / app.quit / 系统关机），
// 都在此兜底销毁全部窗口，防止窗口/定时器持有事件循环导致进程挂死。
app.on('before-quit', () => {
  if (quitCleaned) return
  quitCleaned = true
  console.log('[quit] before-quit：开始清理')
  isQuitting = true
  try {
    destroyLyricWindow()
    if (trayWindow && !trayWindow.isDestroyed()) {
      trayWindow.destroy()
      trayWindow = null
      console.log('[quit] 托盘窗已销毁')
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      // destroy 绕过 close 拦截（主窗 close 默认进托盘），确保事件循环不再被窗口持有
      mainWindow.destroy()
      mainWindow = null
      console.log('[quit] 主窗口已销毁')
    }
  } catch (err) {
    console.log('[quit] 窗口清理异常：', err instanceof Error ? err.message : String(err))
  }
})

// will-quit：终止存活子进程（ffmpeg/attrib），并设兜底强退计时器。
// 正常情况下事件循环清空后进程自然退出；若 500ms 内仍未退出（挂死句柄），
// app.exit(0) 强制落盘退出，消除僵尸残留。
app.on('will-quit', (event) => {
  console.log('[quit] will-quit：终止子进程')
  try {
    killAllChildren()
    killMvExportChildren()
    unregisterAllMediaKeys()
  } catch (err) {
    console.log('[quit] 子进程清理异常：', err instanceof Error ? err.message : String(err))
  }
  if (forceExitTimer) return
  event.preventDefault()
  forceExitTimer = setTimeout(() => {
    console.log('[quit] 事件循环未自然退出，兜底 app.exit(0)')
    app.exit(0)
  }, 500)
  // 窗口/子进程已清理完，若事件循环已空则会先于计时器触发自然退出
})

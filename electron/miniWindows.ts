import { BrowserWindow, ipcMain, app, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ===== 迷你窗口（桌面歌词窗）状态桥接 =====
//
// 主窗口渲染层把完整播放状态（曲目/进度/音量/歌词行/配色）推送到这里，
// 主进程缓存后广播给桌面歌词窗；小窗的按钮/音量/进度命令回传主窗口执行。

export interface MiniLyricLine {
  time: number
  text: string
}

export interface MiniPlayerState {
  hasTrack: boolean
  title: string
  artist: string
  coverUrl: string
  isPlaying: boolean
  volume: number
  isMuted: boolean
  progress: number
  duration: number
  lyricLines: MiniLyricLine[]
  synced: boolean
  theme: 'light' | 'dark'
  lyricTextColor: string
  lyricControlColor: string
}

export type MiniCommand =
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'volume'; value: number }
  | { type: 'seek'; value: number }
  | { type: 'show-window' }
  | { type: 'show-lyric-window' }
  | { type: 'close-lyric-window' }

const defaultState: MiniPlayerState = {
  hasTrack: false,
  title: '',
  artist: '',
  coverUrl: '',
  isPlaying: false,
  volume: 80,
  isMuted: false,
  progress: 0,
  duration: 0,
  lyricLines: [],
  synced: false,
  theme: 'dark',
  lyricTextColor: '#ffffff',
  lyricControlColor: '#ff375f',
}

let miniState: MiniPlayerState = { ...defaultState }
let lyricWindow: BrowserWindow | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null

function miniPreloadPath(): string {
  return process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron/mini-preload.cjs')
    : path.join(__dirname, 'mini-preload.cjs')
}

function broadcast() {
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('mini:state', miniState)
  }
}

function sendMainCommand(cmd: MiniCommand) {
  const main = getMainWindow?.()
  if (!main || main.isDestroyed()) return
  if (cmd.type === 'toggle' || cmd.type === 'next' || cmd.type === 'prev') {
    // 播放控制复用 tray 通道（主窗口 PlayerContext 已监听）
    main.webContents.send('tray:player-command', cmd.type)
  } else if (cmd.type === 'volume' || cmd.type === 'seek') {
    main.webContents.send('mini:player-command', cmd)
  } else if (cmd.type === 'show-window') {
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  }
}

function handleCommand(cmd: MiniCommand) {
  if (!cmd || typeof cmd !== 'object') return
  switch (cmd.type) {
    case 'toggle':
    case 'next':
    case 'prev':
    case 'volume':
    case 'seek':
      sendMainCommand(cmd)
      break
    case 'show-window':
      sendMainCommand(cmd)
      break
    case 'show-lyric-window':
      showLyricWindow()
      break
    case 'close-lyric-window':
      hideLyricWindow()
      break
    default:
      break
  }
}

// ===== 桌面歌词窗 =====

function getLyricHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  :root {
    color-scheme: dark;
    --lyric-color: #ffffff;
    --ctrl-color: #ff375f;
  }
  body.light { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { display: flex; flex-direction: column; height: 100%; padding: 4px 14px; -webkit-app-region: drag; }
  .close {
    position: absolute; top: 6px; right: 8px; z-index: 10;
    width: 24px; height: 24px; border-radius: 50%;
    border: none; background: rgba(255,255,255,.1); color: var(--lyric-color);
    cursor: pointer; display: grid; place-items: center; font-size: 13px; line-height: 1;
    -webkit-app-region: no-drag; transition: background .18s, transform .12s; opacity: .7;
  }
  .close:hover { background: rgba(255,255,255,.22); opacity: 1; }
  .close:active { transform: scale(.9); }
  body.light .close { background: rgba(0,0,0,.08); }
  body.light .close:hover { background: rgba(0,0,0,.16); }
  .lyric { flex: 1; display: grid; place-items: center; position: relative; }
  .line { font-size: 30px; font-weight: 820; text-align: center; line-height: 1.35; color: var(--lyric-color); text-shadow: 0 2px 20px rgba(0,0,0,.5); opacity: 0; transform: translateY(8px); transition: opacity .45s ease, transform .45s ease; max-width: 100%; }
  .line.show { opacity: 1; transform: translateY(0); }
  .line.idle { opacity: .45; font-size: 22px; font-weight: 600; }
  .controls { display: flex; align-items: center; justify-content: center; gap: 14px; height: 44px; -webkit-app-region: no-drag; }
  .btn {
    width: 34px; height: 34px; border-radius: 50%; border: none;
    background: color-mix(in srgb, var(--ctrl-color) 18%, transparent);
    color: var(--ctrl-color); cursor: pointer; display: grid; place-items: center;
    font-size: 15px; transition: background .18s, transform .12s;
  }
  .btn:hover { background: color-mix(in srgb, var(--ctrl-color) 32%, transparent); }
  .btn:active { transform: scale(.92); }
  .btn.play { background: var(--ctrl-color); color: #fff; width: 40px; height: 40px; font-size: 17px; }
  .btn.play:hover { filter: brightness(1.08); }
  .vol { display: flex; align-items: center; gap: 6px; color: var(--lyric-color); opacity: .75; }
  .vol svg { width: 15px; height: 15px; }
  .vol input { width: 90px; accent-color: var(--ctrl-color); cursor: pointer; }
</style>
</head>
<body>
  <div class="wrap">
    <button class="close" id="closeBtn" title="关闭桌面歌词">✕</button>
    <div class="lyric">
      <div id="line" class="line idle">未在播放</div>
    </div>
    <div class="controls">
      <button class="btn" id="prev" title="上一首">⏮</button>
      <button class="btn play" id="play" title="播放/暂停">▶</button>
      <button class="btn" id="next" title="下一首">⏭</button>
      <span class="vol">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        <input type="range" id="volume" min="0" max="100" value="80" />
      </span>
    </div>
  </div>
  <script>
    const { onState, sendCommand } = window.miniAPI
    let state = { hasTrack:false, title:'', artist:'', coverUrl:'', isPlaying:false, volume:80, isMuted:false, progress:0, duration:0, lyricLines:[], synced:false, theme:'dark', lyricTextColor:'#ffffff', lyricControlColor:'#ff375f' }
    const $ = (id) => document.getElementById(id)
    const volInput = $('volume')
    let lyricTimer = null

    function activeIndex(t) {
      const lines = state.lyricLines || []
      let lo = 0, hi = lines.length - 1, res = -1
      while (lo <= hi) { const mid = (lo+hi)>>1; if (lines[mid].time <= t) { res = mid; lo = mid+1 } else { hi = mid-1 } }
      return res
    }

    function renderLyric() {
      const line = $('line')
      if (!state.hasTrack) {
        line.textContent = '未在播放'; line.className = 'line idle'; return
      }
      if (!state.synced || !state.lyricLines || state.lyricLines.length === 0) {
        line.textContent = state.title || state.artist || '暂无歌词'; line.className = 'line idle'; return
      }
      const idx = activeIndex(state.progress || 0)
      const text = idx >= 0 ? state.lyricLines[idx].text : (state.lyricLines[0] ? state.lyricLines[0].text : '')
      line.textContent = text || '♪'
      line.className = 'line show'
      if (lyricTimer) clearTimeout(lyricTimer)
      lyricTimer = setTimeout(() => { if (state.hasTrack && state.lyricLines && state.lyricLines.length) line.className = 'line show' }, 200)
    }

    function render() {
      if (!state) return
      document.body.classList.toggle('light', (state.theme || 'dark') === 'light')
      // 应用用户自定义配色
      const root = document.documentElement
      root.style.setProperty('--lyric-color', state.lyricTextColor || '#ffffff')
      root.style.setProperty('--ctrl-color', state.lyricControlColor || '#ff375f')
      $('play').textContent = state.isPlaying ? '⏸' : '▶'
      $('play').disabled = $('prev').disabled = $('next').disabled = !state.hasTrack
      if (volInput.value !== String(state.volume)) volInput.value = state.volume
      renderLyric()
    }

    onState((next) => { state = next || state; render() })
    $('play').onclick = () => sendCommand({ type: 'toggle' })
    $('next').onclick = () => sendCommand({ type: 'next' })
    $('prev').onclick = () => sendCommand({ type: 'prev' })
    $('closeBtn').onclick = () => sendCommand({ type: 'close-lyric-window' })
    volInput.addEventListener('input', () => sendCommand({ type: 'volume', value: Number(volInput.value) }))
    render()
  </script>
</body>
</html>`
}

function createLyricWindow() {
  if (lyricWindow && !lyricWindow.isDestroyed()) return lyricWindow
  lyricWindow = new BrowserWindow({
    width: 620,
    height: 150,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: miniPreloadPath(),
    },
  })
  lyricWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getLyricHtml())}`)
  lyricWindow.on('closed', () => { lyricWindow = null })
  return lyricWindow
}

export function showLyricWindow() {
  const win = createLyricWindow()
  if (!win) return
  win.setAlwaysOnTop(true, 'screen-saver')
  win.showInactive()
  broadcast()
  notifyLyricVisible()
}

export function hideLyricWindow() {
  lyricWindow?.hide()
  notifyLyricVisible()
}

export function isLyricVisible() {
  return Boolean(lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible())
}

function notifyLyricVisible() {
  const main = getMainWindow?.()
  if (!main || main.isDestroyed()) return
  main.webContents.send('mini:lyric-visible', isLyricVisible())
}

export function toggleLyricWindow() {
  if (lyricWindow && lyricWindow.isVisible()) {
    lyricWindow.hide()
  } else {
    showLyricWindow()
  }
}

export function registerMiniWindowHandlers(opts: { getMainWindow: () => BrowserWindow | null }) {
  getMainWindow = opts.getMainWindow

  // 主窗口渲染层 → 主进程：推送完整播放状态
  ipcMain.on('mini:state', (_event, state: MiniPlayerState) => {
    if (!state || typeof state !== 'object') return
    miniState = {
      hasTrack: Boolean(state.hasTrack),
      title: String(state.title || ''),
      artist: String(state.artist || ''),
      coverUrl: String(state.coverUrl || ''),
      isPlaying: Boolean(state.isPlaying),
      volume: Number.isFinite(state.volume) ? state.volume : miniState.volume,
      isMuted: Boolean(state.isMuted),
      progress: Number.isFinite(state.progress) ? state.progress : 0,
      duration: Number.isFinite(state.duration) ? state.duration : 0,
      lyricLines: Array.isArray(state.lyricLines) ? state.lyricLines : [],
      synced: Boolean(state.synced),
      theme: state.theme === 'light' ? 'light' : 'dark',
      lyricTextColor: typeof state.lyricTextColor === 'string' && state.lyricTextColor ? state.lyricTextColor : miniState.lyricTextColor,
      lyricControlColor: typeof state.lyricControlColor === 'string' && state.lyricControlColor ? state.lyricControlColor : miniState.lyricControlColor,
    }
    broadcast()
  })

  // 小窗 → 主进程：播放命令 / 音量 / 进度 / 显示控制
  ipcMain.on('mini:command', (_event, cmd: MiniCommand) => {
    handleCommand(cmd)
  })

  // 主窗口请求打开/关闭桌面歌词
  ipcMain.on('mini:toggle-lyric', () => toggleLyricWindow())

  // 主窗口查询桌面歌词当前可见状态（用于播放页按钮文字）
  ipcMain.handle('mini:get-lyric-visible', () => isLyricVisible())
}

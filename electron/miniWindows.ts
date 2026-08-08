import { BrowserWindow, ipcMain, app, screen } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ===== 迷你窗口（桌面歌词窗 + 悬浮窗）状态桥接 =====
//
// 主窗口渲染层把完整播放状态（曲目/进度/音量/歌词行）推送到这里，
// 主进程缓存后广播给两个小窗；小窗的按钮/音量/进度命令回传主窗口执行。

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
}

export type MiniCommand =
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'volume'; value: number }
  | { type: 'seek'; value: number }
  | { type: 'show-window' }
  | { type: 'show-lyric-window' }
  | { type: 'show-mini-window' }
  | { type: 'hide-mini-window' }

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
}

let miniState: MiniPlayerState = { ...defaultState }
let lyricWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
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
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini:state', miniState)
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
    case 'show-mini-window':
      showMiniWindow()
      break
    case 'hide-mini-window':
      hideMiniWindow()
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
  :root { color-scheme: dark; }
  body.light { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { display: flex; flex-direction: column; height: 100%; padding: 4px 14px; -webkit-app-region: drag; }
  .lyric { flex: 1; display: grid; place-items: center; position: relative; }
  .line { font-size: 30px; font-weight: 820; text-align: center; line-height: 1.35; color: #fff; text-shadow: 0 2px 20px rgba(0,0,0,.5); opacity: 0; transform: translateY(8px); transition: opacity .45s ease, transform .45s ease; max-width: 100%; }
  body.light .line { color: #111; text-shadow: 0 1px 12px rgba(255,255,255,.7); }
  .line.show { opacity: 1; transform: translateY(0); }
  .line.idle { opacity: .45; font-size: 22px; font-weight: 600; }
  .controls { display: flex; align-items: center; justify-content: center; gap: 14px; height: 44px; -webkit-app-region: no-drag; }
  .btn { width: 34px; height: 34px; border-radius: 50%; border: none; background: rgba(255,255,255,.14); color: #fff; cursor: pointer; display: grid; place-items: center; font-size: 15px; transition: background .18s, transform .12s; }
  body.light .btn { background: rgba(0,0,0,.08); color: #111; }
  .btn:hover { background: rgba(255,255,255,.24); }
  body.light .btn:hover { background: rgba(0,0,0,.14); }
  .btn:active { transform: scale(.92); }
  .btn.play { background: #ff375f; color: #fff; width: 40px; height: 40px; font-size: 17px; }
  .btn.play:hover { background: #ff4d70; }
  .vol { display: flex; align-items: center; gap: 6px; color: rgba(255,255,255,.75); }
  body.light .vol { color: rgba(0,0,0,.65); }
  .vol svg { width: 15px; height: 15px; }
  .vol input { width: 90px; accent-color: #ff375f; cursor: pointer; }
</style>
</head>
<body>
  <div class="wrap">
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
    let state = { hasTrack:false, title:'', artist:'', coverUrl:'', isPlaying:false, volume:80, isMuted:false, progress:0, duration:0, lyricLines:[], synced:false, theme:'dark' }
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
      $('play').textContent = state.isPlaying ? '⏸' : '▶'
      $('play').disabled = $('prev').disabled = $('next').disabled = !state.hasTrack
      if (volInput.value !== String(state.volume)) volInput.value = state.volume
      renderLyric()
    }

    onState((next) => { state = next || state; render() })
    $('play').onclick = () => sendCommand({ type: 'toggle' })
    $('next').onclick = () => sendCommand({ type: 'next' })
    $('prev').onclick = () => sendCommand({ type: 'prev' })
    volInput.addEventListener('input', () => sendCommand({ type: 'volume', value: Number(volInput.value) }))
    render()
  </script>
</body>
</html>`
}

function getMiniHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  :root {
    --bg: linear-gradient(160deg, rgba(40,40,46,.98), rgba(16,16,20,.99));
    --border: rgba(255,255,255,.12);
    --text: #f7f7f8;
    --muted: rgba(255,255,255,.5);
    --btn: rgba(255,255,255,.1);
    --btn-hover: rgba(255,255,255,.18);
    --accent: #ff375f;
    --track: rgba(255,255,255,.12);
  }
  body.light {
    --bg: linear-gradient(160deg, rgba(252,252,253,.98), rgba(242,243,246,.99));
    --border: rgba(24,25,28,.1);
    --text: #18191C;
    --muted: rgba(24,25,28,.5);
    --btn: rgba(24,25,28,.06);
    --btn-hover: rgba(24,25,28,.12);
    --track: rgba(24,25,28,.12);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: 100%; height: 100%; border-radius: 18px; background: var(--bg); border: 1px solid var(--border); box-shadow: 0 24px 70px rgba(0,0,0,.42); display: flex; flex-direction: column; overflow: hidden; }
  .topbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 8px 10px 0; -webkit-app-region: drag; }
  .topbtn { -webkit-app-region: no-drag; width: 22px; height: 22px; border: none; background: var(--btn); color: var(--muted); border-radius: 6px; cursor: pointer; display: grid; place-items: center; font-size: 11px; }
  .topbtn:hover { background: var(--btn-hover); }
  .body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 6px 16px 10px; -webkit-app-region: drag; }
  .title { font-size: 15px; font-weight: 740; color: var(--text); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .artist { font-size: 11px; color: var(--muted); font-weight: 540; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .mini-lyric { font-size: 14px; font-weight: 620; color: var(--text); text-align: center; line-height: 1.5; max-width: 100%; }
  .mini-lyric.idle { color: var(--muted); font-size: 12px; font-weight: 500; }
  .progress { width: 100%; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; margin-top: 4px; -webkit-app-region: no-drag; }
  .progress-fill { height: 100%; background: var(--accent); width: 0%; }
  .controls { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 4px 0 12px; -webkit-app-region: no-drag; }
  .cbtn { width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--btn); color: var(--text); cursor: pointer; display: grid; place-items: center; font-size: 13px; transition: background .16s, transform .12s; }
  .cbtn:hover { background: var(--btn-hover); }
  .cbtn:active { transform: scale(.9); }
  .cbtn.play { background: var(--accent); color: #fff; width: 38px; height: 38px; font-size: 15px; }
</style>
</head>
<body>
  <div class="card">
    <div class="topbar">
      <button class="topbtn" id="toggleView" title="切换歌词/播放">⟲</button>
      <button class="topbtn" id="closeBtn" title="关闭悬浮窗">✕</button>
    </div>
    <div class="body">
      <div id="titleView" style="display:none">
        <div class="title" id="title">未在播放</div>
        <div class="artist" id="artist"></div>
      </div>
      <div class="mini-lyric idle" id="lyricView" style="display:none">暂无歌词</div>
      <div class="progress"><div class="progress-fill" id="fill"></div></div>
    </div>
    <div class="controls">
      <button class="cbtn" id="prev" title="上一首">⏮</button>
      <button class="cbtn play" id="play" title="播放/暂停">▶</button>
      <button class="cbtn" id="next" title="下一首">⏭</button>
    </div>
  </div>
  <script>
    const { onState, sendCommand } = window.miniAPI
    let state = { hasTrack:false, title:'', artist:'', isPlaying:false, progress:0, duration:0, lyricLines:[], synced:false, theme:'dark' }
    let showLyric = false
    const $ = (id) => document.getElementById(id)

    function activeIndex(t) {
      const lines = state.lyricLines || []; let lo=0, hi=lines.length-1, res=-1
      while (lo<=hi){ const mid=(lo+hi)>>1; if(lines[mid].time<=t){res=mid;lo=mid+1}else{hi=mid-1} }
      return res
    }

    function render() {
      if (!state) return
      document.body.classList.toggle('light', (state.theme||'dark')==='light')
      $('title').textContent = state.title || '未在播放'
      $('artist').textContent = state.artist || ''
      const pct = state.duration > 0 ? Math.min(100, (state.progress/state.duration)*100) : 0
      $('fill').style.width = pct + '%'
      $('play').textContent = state.isPlaying ? '⏸' : '▶'
      $('play').disabled = $('prev').disabled = $('next').disabled = !state.hasTrack
      // 视图切换
      $('titleView').style.display = showLyric ? 'none' : 'block'
      $('lyricView').style.display = showLyric ? 'block' : 'none'
      if (showLyric) {
        const lv = $('lyricView')
        if (!state.hasTrack || !state.synced || !state.lyricLines || !state.lyricLines.length) {
          lv.textContent = state.hasTrack ? '暂无歌词' : '未在播放'; lv.className = 'mini-lyric idle'
        } else {
          const idx = activeIndex(state.progress||0)
          lv.textContent = idx>=0 ? state.lyricLines[idx].text : (state.lyricLines[0] ? state.lyricLines[0].text : '♪')
          lv.className = 'mini-lyric'
        }
      }
    }

    onState((next) => { state = next || state; render() })
    $('play').onclick = () => sendCommand({ type: 'toggle' })
    $('next').onclick = () => sendCommand({ type: 'next' })
    $('prev').onclick = () => sendCommand({ type: 'prev' })
    $('toggleView').onclick = () => { showLyric = !showLyric; render() }
    $('closeBtn').onclick = () => sendCommand({ type: 'hide-mini-window' })
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

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) return miniWindow
  miniWindow = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: miniPreloadPath(),
    },
  })
  miniWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getMiniHtml())}`)
  miniWindow.on('closed', () => { miniWindow = null })
  return miniWindow
}

export function showLyricWindow() {
  const win = createLyricWindow()
  if (!win) return
  win.setAlwaysOnTop(true, 'screen-saver')
  win.showInactive()
  broadcast()
}

export function showMiniWindow() {
  const win = createMiniWindow()
  if (!win) return
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  broadcast()
}

export function hideLyricWindow() {
  lyricWindow?.hide()
}

export function hideMiniWindow() {
  miniWindow?.hide()
}

export function toggleLyricWindow() {
  if (lyricWindow && lyricWindow.isVisible()) {
    lyricWindow.hide()
  } else {
    showLyricWindow()
  }
}

export function toggleMiniWindow() {
  if (miniWindow && miniWindow.isVisible()) {
    miniWindow.hide()
  } else {
    showMiniWindow()
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
    }
    broadcast()
  })

  // 小窗 → 主进程：播放命令 / 音量 / 进度 / 显示控制
  ipcMain.on('mini:command', (_event, cmd: MiniCommand) => {
    handleCommand(cmd)
  })

  // 主窗口请求打开/关闭迷你窗
  ipcMain.on('mini:toggle-lyric', () => toggleLyricWindow())
  ipcMain.on('mini:toggle-mini', () => toggleMiniWindow())
}

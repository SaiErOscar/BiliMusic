// v1.3.9 全局取色器（Windows 优先）：desktopCapturer 截鼠标所在屏 → 全屏放大镜取色窗 → 回传 hex
// 设计：openColorPicker() 在渲染层是一次 invoke，返回 Promise<string|null>。主进程抓屏后把截图与
// 取色页 HTML 一起写进临时目录，用 loadFile 打开全屏取色窗（同源 file://，无需关 webSecurity）；
// 用户在放大镜里点选颜色后，取色窗通过 preload send 'color-picker:submit'，主进程 resolve 并清理临时文件。
import { app, BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let pickerWindow: BrowserWindow | null = null
let pendingResolve: ((hex: string | null) => void) | null = null

function cpPreloadPath() {
  return process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron/cp-preload.cjs')
    : path.join(__dirname, 'cp-preload.cjs')
}

function tempDir() {
  return path.join(app.getPath('temp'), 'bilimusic-colorpicker')
}

function cleanupTemp(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时文件清理失败不影响功能，OS 会回收 temp */
  }
}

function settle(hex: string | null) {
  const resolve = pendingResolve
  pendingResolve = null
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close()
  pickerWindow = null
  cleanupTemp(tempDir())
  if (resolve) resolve(hex)
}

function getPickHtml(shotDataUrl: string) {
  // 放大镜取色页：背景为整屏截图，跟随鼠标的放大镜，点击采样像素 RGB 回传
  // 截图以 dataURL 内嵌（而非 file:// 图片）：file:// 图源画进 canvas 会被 Chromium 判跨源污染，
  // getImageData 抛 SecurityError 致取色失效；dataURL 图源允许回读像素。
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:100%; height:100%; overflow:hidden; cursor:crosshair; background:#000;
      font-family:'Microsoft YaHei',system-ui,sans-serif; user-select:none; -webkit-user-select:none; }
    #shot { position:fixed; inset:0; width:100%; height:100%; display:block; }
    #tip { position:fixed; left:50%; top:24px; transform:translateX(-50%);
      background:rgba(20,20,24,.9); color:#fff; padding:8px 16px; border-radius:20px; font-size:13px;
      border:1px solid rgba(255,255,255,.15); white-space:nowrap; pointer-events:none; }
    #lens { position:fixed; width:152px; height:152px; border:2px solid #ff375f; border-radius:8px;
      background:#000; box-shadow:0 4px 20px rgba(0,0,0,.5); display:none; pointer-events:none; z-index:5; }
    #lens canvas { width:100%; height:100%; image-rendering:pixelated; display:block; border-radius:6px; }
    #hex { position:fixed; margin-top:8px; width:152px; text-align:center; background:rgba(20,20,24,.92);
      color:#fff; font-size:13px; padding:5px 0; border-radius:6px; border:1px solid rgba(255,255,255,.15);
      display:none; pointer-events:none; z-index:5; font-family:Consolas,monospace; }
  </style></head><body>
    <img id="shot" src="${shotDataUrl}" alt="">
    <div id="tip">点击拾取颜色 · 按 Esc 或右键取消</div>
    <div id="lens"><canvas id="lc" width="150" height="150"></canvas></div>
    <div id="hex"></div>
    <script>
      const shot = document.getElementById('shot')
      const lens = document.getElementById('lens')
      const lc = document.getElementById('lc')
      const lctx = lc.getContext('2d')
      const hexEl = document.getElementById('hex')
      let full = document.createElement('canvas')
      let fctx = full.getContext('2d', { willReadFrequently: true })
      let ready = false

      function prepare() {
        // 用截图原始像素尺寸建 1:1 采样画布；显示按视口 CSS 宽高缩放，采样需乘以 factor
        full.width = shot.naturalWidth
        full.height = shot.naturalHeight
        fctx.drawImage(shot, 0, 0)
        ready = true
      }
      if (shot.complete && shot.naturalWidth) prepare()
      else shot.onload = prepare

      function factor() { return ready ? shot.naturalWidth / window.innerWidth : 1 }
      function sample(cx, cy) {
        const f = factor()
        const px = Math.min(full.width - 1, Math.max(0, Math.floor(cx * f)))
        const py = Math.min(full.height - 1, Math.max(0, Math.floor(cy * f)))
        return { px, py }
      }
      function rgbAt(px, py) {
        const d = fctx.getImageData(px, py, 1, 1).data
        return { r:d[0], g:d[1], b:d[2], hex:'#'+[d[0],d[1],d[2]].map(x=>x.toString(16).padStart(2,'0')).join('') }
      }
      function moveLens(cx, cy) {
        if (!ready) return
        const { px, py } = sample(cx, cy)
        const z = 10, src = 15
        lctx.imageSmoothingEnabled = false
        lctx.clearRect(0,0,150,150)
        lctx.drawImage(full, px - src/2, py - src/2, src, src, 0, 0, 150, 150)
        let lx = cx + 20, ly = cy + 20
        if (lx + 152 > window.innerWidth) lx = cx - 172
        if (ly + 180 > window.innerHeight) ly = cy - 180
        lens.style.left = lx + 'px'; lens.style.top = ly + 'px'
        lens.style.display = 'block'
        hexEl.style.left = lx + 'px'; hexEl.style.top = (ly + 152) + 'px'
        hexEl.textContent = rgbAt(px, py).hex.toUpperCase()
        hexEl.style.display = 'block'
      }
      window.addEventListener('mousemove', (e) => moveLens(e.clientX, e.clientY))
      window.addEventListener('click', (e) => {
        if (!ready) return
        const { px, py } = sample(e.clientX, e.clientY)
        window.cpAPI.submit(rgbAt(px, py).hex)
      })
      window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.cpAPI.cancel() })
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.cpAPI.cancel() })
    </script>
  </body></html>`
}

export async function openPicker(): Promise<string | null> {
  if (pendingResolve) settle(null) // 上一次未结束则取消

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const scale = display.scaleFactor || 1

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  })
  // 找到鼠标所在屏（display_id 匹配），兜底取第一个
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) return null

  const dir = tempDir()
  fs.mkdirSync(dir, { recursive: true })
  const b64 = source.thumbnail.toPNG().toString('base64')
  const htmlPath = path.join(dir, 'pick.html')
  fs.writeFileSync(htmlPath, getPickHtml('data:image/png;base64,' + b64), 'utf8')

  return new Promise<string | null>((resolve) => {
    pendingResolve = resolve
    pickerWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: cpPreloadPath(),
      },
    })
    pickerWindow.setAlwaysOnTop(true, 'screen-saver')
    pickerWindow.loadFile(htmlPath)
    pickerWindow.on('closed', () => {
      pickerWindow = null
      if (pendingResolve) {
        const r = pendingResolve
        pendingResolve = null
        cleanupTemp(dir)
        r(null) // 用户直接关窗视为取消
      }
    })
  })
}

export function registerColorPickerHandlers() {
  ipcMain.handle('color-picker:open', () => openPicker())
  ipcMain.on('color-picker:submit', (_e, hex: unknown) => {
    settle(typeof hex === 'string' && hex ? hex : null)
  })
  ipcMain.on('color-picker:cancel', () => settle(null))
}

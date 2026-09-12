// v1.3.9-pre2 全局取色器（Windows）：透明全屏"十字准星"覆盖层，桌面画面保持不变，点击处取色。
// 关键：openPicker() 打开瞬间抓一次屏缓存为位图（RGBA Buffer），之后弹一个全透明的置顶无边框窗，
// 窗里只画跟随鼠标的十字准星（纯 DOM），用户点哪 → 渲染层把点击坐标发回主进程 → 主进程从"打开时的缓存"
// 里读出该点 RGB 回传。因为读的是预抓缓存而非重新截屏，取色窗本身（透明、只画准星）不会被截进去，
// 用户看到的桌面画面从头到尾不变，只是多了一个可点到屏幕任意位置的十字标记。
import { app, BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let pickerWindow: BrowserWindow | null = null
let pendingResolve: ((hex: string | null) => void) | null = null
// 打开时缓存的屏幕位图：RGBA 物理像素 buffer + 物理宽 + 该屏 DIP→物理 的缩放系数 + 屏原点
let cachedShot: { data: Buffer; width: number; height: number; scale: number } | null = null

function cpPreloadPath() {
  return process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron/cp-preload.cjs')
    : path.join(__dirname, 'cp-preload.cjs')
}

function tempDir() {
  return path.join(app.getPath('temp'), 'bilimusic-colorpicker')
}

function cleanupTemp(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* OS 会回收 temp */ }
}

function settle(hex: string | null) {
  const resolve = pendingResolve
  pendingResolve = null
  cachedShot = null
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close()
  pickerWindow = null
  try { cleanupTemp(tempDir()) } catch { /* 忽略 */ }
  if (resolve) resolve(hex)
}

// 从缓存位图按"窗口内 CSS 坐标"取色：CSS(DIP) × scale → 物理像素，边界钳制后读 RGBA
function sampleAtWindowPoint(cssX: number, cssY: number): string | null {
  const shot = cachedShot
  if (!shot) return null
  const px = Math.min(shot.width - 1, Math.max(0, Math.floor(cssX * shot.scale)))
  const py = Math.min(shot.height - 1, Math.max(0, Math.floor(cssY * shot.scale)))
  const idx = (py * shot.width + px) * 4
  if (idx + 2 >= shot.data.length) return null
  const r = shot.data[idx], g = shot.data[idx + 1], b = shot.data[idx + 2]
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// 取色覆盖层：body 全透明，唯一可见元素是跟随鼠标的十字准星 + 中心高亮框。点击/右键/Esc 通过 cpAPI 回主进程。
function getPickHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; overflow:hidden; background:transparent;
      cursor:none; user-select:none; -webkit-user-select:none;
      font-family:'Microsoft YaHei',system-ui,sans-serif; }
    #cross { position:fixed; display:none; pointer-events:none; z-index:10; }
    #cross .h { position:absolute; left:-120px; top:0; width:240px; height:1px;
      background:#ff375f; box-shadow:0 0 1px rgba(0,0,0,.8); }
    #cross .v { position:absolute; top:-120px; left:0; width:1px; height:240px;
      background:#ff375f; box-shadow:0 0 1px rgba(0,0,0,.8); }
    #cross .box { position:absolute; left:-6px; top:-6px; width:11px; height:11px;
      border:1px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,.6), inset 0 0 0 1px rgba(0,0,0,.4); }
    #tip { position:fixed; left:50%; top:20px; transform:translateX(-50%);
      background:rgba(20,20,24,.9); color:#fff; padding:7px 14px; border-radius:18px; font-size:12.5px;
      border:1px solid rgba(255,255,255,.15); white-space:nowrap; pointer-events:none; z-index:10; }
  </style></head><body>
    <div id="tip">移动十字到目标颜色上，点击取色 · 右键 / Esc 取消</div>
    <div id="cross"><div class="h"></div><div class="v"></div><div class="box"></div></div>
    <script>
      var cross = document.getElementById('cross')
      window.addEventListener('mousemove', function (e) {
        cross.style.display = 'block'
        cross.style.left = e.clientX + 'px'
        cross.style.top = e.clientY + 'px'
      })
      window.addEventListener('mousedown', function (e) {
        // 左键取色（坐标为窗口内 CSS 像素，主进程乘该屏 scale 映射到物理像素采样）
        if (e.button === 0) window.cpAPI.pick(e.clientX, e.clientY)
        else window.cpAPI.cancel() // 右键取消
      })
      window.addEventListener('contextmenu', function (e) { e.preventDefault() })
      window.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.cpAPI.cancel() })
      window.focus()
    </script>
  </body></html>`
}

async function grabScreen(display: Electron.Display) {
  const scale = display.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  })
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) return null
  const bitmap = source.thumbnail.toBitmap() // RGBA Buffer，宽=bitmap/(4*height)
  return {
    data: bitmap,
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
    scale,
  }
}

export async function openPicker(): Promise<string | null> {
  // Windows 独占：其他平台屏幕取色需额外权限/能力受限，渲染层也不会走到这里（按钮隐藏），此处双保险。
  if (process.platform !== 'win32') return null
  if (pendingResolve) settle(null)

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)

  const shot = await grabScreen(display)
  if (!shot) return null
  cachedShot = shot

  return new Promise<string | null>((resolve) => {
    pendingResolve = resolve
    pickerWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: cpPreloadPath(),
      },
    })
    pickerWindow.setAlwaysOnTop(true, 'screen-saver')
    pickerWindow.setVisibleOnAllWorkspaces(true)
    pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getPickHtml())}`)
    pickerWindow.once('ready-to-show', () => {
      if (pickerWindow && !pickerWindow.isDestroyed()) {
        pickerWindow.show()
        pickerWindow.focus()
      }
    })
    pickerWindow.on('closed', () => {
      pickerWindow = null
      if (pendingResolve) {
        const r = pendingResolve
        pendingResolve = null
        cachedShot = null
        cleanupTemp(tempDir())
        r(null)
      }
    })
  })
}

export function registerColorPickerHandlers() {
  ipcMain.handle('color-picker:open', () => openPicker())
  // 渲染层点击：坐标是窗口内 CSS 像素；主进程从打开时缓存的位图采样并回传 hex。
  ipcMain.on('color-picker:pick', (_e, x: unknown, y: unknown) => {
    const hex =
      typeof x === 'number' && typeof y === 'number' ? sampleAtWindowPoint(x, y) : null
    settle(hex)
  })
  ipcMain.on('color-picker:cancel', () => settle(null))
}

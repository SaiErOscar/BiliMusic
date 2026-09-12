// v1.3.9-pre3 全局取色器（Windows）：自写"取色面板窗"复刻原生 input[type=color] UI（SV 色板 + 色相条 +
// 吸管 + RGB/HEX 输入 + 预览 + 确定/取消），设置页与桌面歌词面板点色块都弹同一个面板窗（天然一致、入口收进色块）。
// 面板里点"吸管"→ 隐藏面板、弹全屏透明十字准星覆盖层 → 用户在目标处点击 → 主进程"点击瞬间"抓该屏并按实测比例采样。
//
// 坐标修正（关键）：不再用 display.scaleFactor 估比例，改用 screen.getCursorScreenPoint()（虚拟 DIP，已含多屏原点）
// 减去该屏 display.bounds 原点得屏内 DIP，再乘"实际返回位图宽 / 该屏逻辑宽"的真实比例映射到物理像素，
// 规避 scaleFactor 与 desktopCapturer 实际尺寸不一致导致的整体偏移；覆盖层采样前先 hide，避免把准星截进去。
import { BrowserWindow, ipcMain, screen, desktopCapturer } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let panelWin: BrowserWindow | null = null
let overlayWin: BrowserWindow | null = null
let pendingResolve: ((hex: string | null) => void) | null = null

function cpPreloadPath() {
  return process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../electron/cp-preload.cjs')
    : path.join(__dirname, 'cp-preload.cjs')
}

function closeWindows() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close()
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
  panelWin = null
  overlayWin = null
}

function settle(hex: string | null) {
  const resolve = pendingResolve
  pendingResolve = null
  closeWindows()
  if (resolve) resolve(hex)
}

// 点击瞬间抓"光标所在屏"并按实测比例取该点 RGB（覆盖层/面板此时已隐藏，不会截进自身）
async function capturePointColor(): Promise<string | null> {
  const pt = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(pt)
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
  const img = source.thumbnail
  const { width: bw, height: bh } = img.getSize()
  const data = img.toBitmap()
  // 光标虚拟 DIP → 屏内 DIP（减 bounds 原点，已含多屏/任务栏所在屏偏移）→ 物理像素（乘实测比例）
  const localDipX = pt.x - display.bounds.x
  const localDipY = pt.y - display.bounds.y
  const ratioX = bw / display.size.width
  const ratioY = bh / display.size.height
  const px = Math.min(bw - 1, Math.max(0, Math.floor(localDipX * ratioX)))
  const py = Math.min(bh - 1, Math.max(0, Math.floor(localDipY * ratioY)))
  const idx = (py * bw + px) * 4
  if (idx + 2 >= data.length) return null
  const r = data[idx]
  const g = data[idx + 1]
  const b = data[idx + 2]
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// 全屏透明十字准星覆盖层：桌面画面不变，仅画跟随鼠标的准星；左键取色、右键/Esc 返回面板
function getOverlayHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; overflow:hidden; background:transparent;
      cursor:none; user-select:none; -webkit-user-select:none; font-family:'Microsoft YaHei',system-ui,sans-serif; }
    #cross { position:fixed; display:none; pointer-events:none; z-index:10; }
    #cross .h { position:absolute; left:-120px; top:0; width:240px; height:1px; background:#ff375f; box-shadow:0 0 1px rgba(0,0,0,.85); }
    #cross .v { position:absolute; top:-120px; left:0; width:1px; height:240px; background:#ff375f; box-shadow:0 0 1px rgba(0,0,0,.85); }
    #cross .box { position:absolute; left:-6px; top:-6px; width:11px; height:11px; border:1px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,.6), inset 0 0 0 1px rgba(0,0,0,.4); }
    #tip { position:fixed; left:50%; top:20px; transform:translateX(-50%); background:rgba(20,20,24,.9); color:#fff; padding:7px 14px; border-radius:18px; font-size:12.5px; border:1px solid rgba(255,255,255,.15); white-space:nowrap; pointer-events:none; z-index:10; }
  </style></head><body>
    <div id="tip">点击拾取该点颜色 · 右键 / Esc 返回调色板</div>
    <div id="cross"><div class="h"></div><div class="v"></div><div class="box"></div></div>
    <script>
      var cross = document.getElementById('cross');
      window.addEventListener('mousemove', function (e) {
        cross.style.display = 'block';
        cross.style.left = e.clientX + 'px';
        cross.style.top = e.clientY + 'px';
      });
      window.addEventListener('mousedown', function (e) {
        if (e.button === 0) { window.cpAPI.pickPoint(); }
        else { window.cpAPI.pickCancel(); }
      });
      window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      window.addEventListener('keydown', function (e) { if (e.key === 'Escape') window.cpAPI.pickCancel(); });
      window.focus();
    </script>
  </body></html>`
}

// 取色面板窗：复刻原生 UI。initialHex 烘焙进 HTML，面板内维护 h/s/v，确定→submit(hex)，吸管→pick()
function getPanelHtml(initialHex: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:100%; height:100%; overflow:hidden; background:#2b2b2b; color:#eee;
      font-family:'Microsoft YaHei',system-ui,sans-serif; user-select:none; -webkit-user-select:none; }
    .app { padding:12px; }
    #sv { position:relative; width:216px; height:150px; border-radius:4px; cursor:crosshair; touch-action:none; }
    #sv .sat { position:absolute; inset:0; background:linear-gradient(to right,#fff,rgb(255,0,0)); border-radius:4px; }
    #sv .val { position:absolute; inset:0; background:linear-gradient(to top,#000,transparent); border-radius:4px; }
    #sv .hd { position:absolute; width:14px; height:14px; border:2px solid #fff; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.5); transform:translate(-50%,-50%); pointer-events:none; }
    #hue { position:relative; width:216px; height:14px; margin-top:12px; border-radius:7px; cursor:pointer; touch-action:none;
      background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00); }
    #hue .hd { position:absolute; top:50%; width:14px; height:14px; border:2px solid #fff; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.5); transform:translate(-50%,-50%); pointer-events:none; }
    .row { display:flex; align-items:center; gap:8px; margin-top:12px; }
    .sw { width:34px; height:34px; border-radius:6px; border:1px solid rgba(255,255,255,.2); }
    .sw.new { flex:0 0 auto; }
    .field { display:flex; flex-direction:column; align-items:center; gap:2px; }
    .field input { width:46px; background:#1e1e1e; border:1px solid #444; border-radius:5px; color:#eee; padding:4px 0; text-align:center; font-size:12px; font-family:Consolas,monospace; }
    .field label { font-size:10px; color:#999; }
    #hex { width:96px; background:#1e1e1e; border:1px solid #444; border-radius:5px; color:#eee; padding:5px 8px; font-size:12px; font-family:Consolas,monospace; }
    .btns { display:flex; gap:8px; margin-top:14px; }
    .btn { flex:1; height:30px; border:none; border-radius:6px; cursor:pointer; font-size:13px; }
    .btn.ok { background:#ff375f; color:#fff; }
    .btn.cancel { background:#444; color:#eee; }
    .btn.pip { flex:0 0 34px; background:#3a3a3a; color:#eee; border:1px solid #555; font-size:15px; }
    .btn:hover { filter:brightness(1.1); }
  </style></head><body>
    <div class="app">
      <div id="sv"><div class="sat"></div><div class="val"></div><div class="hd"></div></div>
      <div id="hue"><div class="hd"></div></div>
      <div class="row">
        <div class="sw new" id="swNew"></div>
        <input id="hex" spellcheck="false" maxlength="7" />
        <button class="btn pip" id="pip" title="从屏幕取色">⌖</button>
      </div>
      <div class="row">
        <div class="field"><input id="r" type="number" min="0" max="255" /><label>R</label></div>
        <div class="field"><input id="g" type="number" min="0" max="255" /><label>G</label></div>
        <div class="field"><input id="b" type="number" min="0" max="255" /><label>B</label></div>
      </div>
      <div class="btns">
        <button class="btn ok" id="ok">确定</button>
        <button class="btn cancel" id="cancel">取消</button>
      </div>
    </div>
    <script>
      function clamp(v,a,b){ return Math.min(b,Math.max(a,v)); }
      function hsvToRgb(h,s,v){ h=h/360; var i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s),r,g,b;
        var m=i%6; if(m===0){r=v;g=t;b=p;}else if(m===1){r=q;g=v;b=p;}else if(m===2){r=p;g=v;b=t;}
        else if(m===3){r=p;g=q;b=v;}else if(m===4){r=t;g=p;b=v;}else{r=v;g=p;b=q;}
        return [Math.round(r*255),Math.round(g*255),Math.round(b*255)]; }
      function rgbToHsv(r,g,b){ r/=255;g/=255;b/=255; var mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn,h=0,s=mx?d/mx:0,v=mx;
        if(d){ if(mx===r)h=((g-b)/d)%6; else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; }
        return [h,s,v]; }
      function hexToRgb(hex){ hex=(hex||'').replace('#',''); if(hex.length===3)hex=hex.split('').map(function(c){return c+c;}).join('');
        if(!/^[0-9a-fA-F]{6}$/.test(hex)) return null; var n=parseInt(hex,16); return [(n>>16)&255,(n>>8)&255,n&255]; }
      function rgbToHex(r,g,b){ return '#'+[r,g,b].map(function(x){return clamp(x,0,255).toString(16).padStart(2,'0');}).join(''); }

      var sv=document.getElementById('sv'), hue=document.getElementById('hue'),
          svHd=sv.querySelector('.hd'), hueHd=hue.querySelector('.hd'),
          satLayer=sv.querySelector('.sat'),
          swNew=document.getElementById('swNew'), hexIn=document.getElementById('hex'),
          rIn=document.getElementById('r'), gIn=document.getElementById('g'), bIn=document.getElementById('b');
      var H=0,S=1,V=1;

      function currentHex(){ var c=hsvToRgb(H,S,V); return rgbToHex(c[0],c[1],c[2]); }
      // opts.skipHex / opts.skipRgb：跳过“用户正在输入的那一类输入框”，其余（色板、预览、另一类输入框）照常回写，
      // 实现 hex 与 RGB 双向同步（原生 input[type=color] 行为）。
      function render(opts){
        opts=opts||{};
        var c=hsvToRgb(H,S,V), hex=rgbToHex(c[0],c[1],c[2]);
        var hc=hsvToRgb(H,1,1);
        satLayer.style.background='linear-gradient(to right,#fff,rgb('+hc[0]+','+hc[1]+','+hc[2]+'))';
        svHd.style.left=(S*100)+'%'; svHd.style.top=((1-V)*100)+'%';
        hueHd.style.left=(H/360*100)+'%';
        swNew.style.background=hex;
        if(!opts.skipHex){ hexIn.value=hex.toUpperCase(); }
        if(!opts.skipRgb){ rIn.value=c[0]; gIn.value=c[1]; bIn.value=c[2]; }
      }
      function setFromRgb(r,g,b,opts){ var hsv=rgbToHsv(r,g,b); H=hsv[0]; S=hsv[1]; V=hsv[2]; render(opts); }

      function svFromEvent(e){ var r=sv.getBoundingClientRect(); S=clamp((e.clientX-r.left)/r.width,0,1); V=clamp(1-(e.clientY-r.top)/r.height,0,1); render({}); }
      function hueFromEvent(e){ var r=hue.getBoundingClientRect(); H=clamp((e.clientX-r.left)/r.width,0,1)*360; render({}); }
      function drag(el,fn){ var down=false; el.addEventListener('pointerdown',function(e){ down=true; el.setPointerCapture(e.pointerId); fn(e); });
        el.addEventListener('pointermove',function(e){ if(down) fn(e); });
        el.addEventListener('pointerup',function(){ down=false; }); }
      drag(sv,svFromEvent); drag(hue,hueFromEvent);

      hexIn.addEventListener('input',function(){ var rgb=hexToRgb(hexIn.value); if(rgb){ setFromRgb(rgb[0],rgb[1],rgb[2],{skipHex:true}); } });
      hexIn.addEventListener('blur',function(){ render({}); });
      function onRgbChange(){ var r=clamp(parseInt(rIn.value,10)||0,0,255),g=clamp(parseInt(gIn.value,10)||0,0,255),b=clamp(parseInt(bIn.value,10)||0,0,255); setFromRgb(r,g,b,{skipRgb:true}); }
      [rIn,gIn,bIn].forEach(function(el){ el.addEventListener('input',onRgbChange); });

      document.getElementById('ok').onclick=function(){ window.cpAPI.submit(currentHex()); };
      document.getElementById('cancel').onclick=function(){ window.cpAPI.cancel(); };
      document.getElementById('pip').onclick=function(){ window.cpAPI.pick(); };
      window.addEventListener('keydown',function(e){ if(e.key==='Enter'){ window.cpAPI.submit(currentHex()); } else if(e.key==='Escape'){ window.cpAPI.cancel(); } });

      var init=hexToRgb('${initialHex}') || [255,55,95];
      var hsv=rgbToHsv(init[0],init[1],init[2]); H=hsv[0]; S=hsv[1]; V=hsv[2]; render({});
    </script>
  </body></html>`
}

function positionNearCursor(win: BrowserWindow, w: number, h: number) {
  const cur = screen.getCursorScreenPoint()
  const disp = screen.getDisplayNearestPoint(cur)
  const wa = disp.workArea
  let x = cur.x + 14
  let y = cur.y + 14
  if (x + w > wa.x + wa.width) x = cur.x - w - 14
  if (y + h > wa.y + wa.height) y = wa.y + wa.height - h
  if (x < wa.x) x = wa.x + 4
  if (y < wa.y) y = wa.y + 4
  win.setBounds({ x, y, width: w, height: h })
}

function createOverlay(display: Electron.Display) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy()
  overlayWin = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: cpPreloadPath() },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true)
  overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getOverlayHtml())}`)
  overlayWin.once('ready-to-show', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.show()
      overlayWin.focus()
    }
  })
}

// 面板点吸管 → 隐藏面板、弹全屏准星；此后再点屏幕即"点击瞬间抓屏"取色
function startScreenPick() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide()
  const cur = screen.getCursorScreenPoint()
  createOverlay(screen.getDisplayNearestPoint(cur))
}

// 覆盖层左键：先隐藏覆盖层（避免把准星截进屏），稍等合成器去帧，再抓屏采样并直接返回最终色
async function onOverlayPick() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide()
  await new Promise((r) => setTimeout(r, 100))
  const hex = await capturePointColor()
  if (hex) settle(hex)
  else backToPanel()
}

// 覆盖层 Esc/右键：返回面板继续微调
function backToPanel() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
  overlayWin = null
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show()
    panelWin.focus()
  } else {
    settle(null)
  }
}

export async function openPicker(initialHex?: string): Promise<string | null> {
  if (process.platform !== 'win32') return null
  if (pendingResolve) settle(null)
  const hex = typeof initialHex === 'string' && initialHex ? initialHex : '#ff375f'

  return new Promise<string | null>((resolve) => {
    pendingResolve = resolve
    panelWin = new BrowserWindow({
      width: 240,
      height: 340,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: '#2b2b2b',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: cpPreloadPath() },
    })
    panelWin.setAlwaysOnTop(true, 'pop-up-menu')
    positionNearCursor(panelWin, 240, 340)
    panelWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getPanelHtml(hex))}`)
    panelWin.once('ready-to-show', () => {
      if (panelWin && !panelWin.isDestroyed()) {
        panelWin.show()
        panelWin.focus()
      }
    })
    panelWin.on('closed', () => {
      panelWin = null
      if (pendingResolve) {
        const r = pendingResolve
        pendingResolve = null
        if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close()
        overlayWin = null
        r(null)
      }
    })
  })
}

export function registerColorPickerHandlers() {
  ipcMain.handle('color-picker:open', (_e, hex?: unknown) =>
    openPicker(typeof hex === 'string' ? hex : undefined))
  ipcMain.on('color-picker:submit', (_e, hex: unknown) => {
    settle(typeof hex === 'string' && hex ? hex : null)
  })
  ipcMain.on('color-picker:cancel', () => settle(null))
  ipcMain.on('color-picker:pick', () => startScreenPick())
  ipcMain.on('color-picker:pick-point', () => void onOverlayPick())
  ipcMain.on('color-picker:pick-cancel', () => backToPanel())
}

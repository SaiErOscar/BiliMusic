/**
 * v1.4.6 播放页 MV 视频导出（桌面端专属）
 *
 * 技术路线：离屏渲染 + ffmpeg 稀疏合成（非录屏）。
 * 1. 隐藏 BrowserWindow 渲染一张「播放界面」布局（左侧封面+歌名+歌手、右侧歌词区），
 *    仅在歌词显示状态变化（换行/滚动窗口移动）时捕获整帧关键帧 JPEG，落盘临时目录。
 * 2. 进度条填充、当前时间数字、水印交给 ffmpeg drawbox/drawtext 的 t 时间表达式逐帧程序化绘制。
 * 3. 所有关键帧作为 -loop 1 图像输入，overlay enable=between(t,..) 切换，-r 45 封装层补齐 45fps。
 * 4. 编码优先 NVENC，未检出时回退 libx264 -preset veryfast；音频从播放 CDN 下载后重编码为 AAC。
 *
 * 内存约束：每帧 NativeImage 立即 JPEG 编码写盘，内存峰值恒定；临时目录用完即删。
 */

import { ipcMain, BrowserWindow, net, app, nativeImage } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const BILI_REFERER = 'https://www.bilibili.com'
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface MvExportPayload {
  title: string
  artist: string
  /** 音频 CDN 直链（渲染层经 getPlayUrl/getBestAudioUrl 解析） */
  audioUrl: string
  /** 封面 CDN 直链（可为空，空时用占位） */
  coverUrl: string
  /** 音频总时长（秒） */
  duration: number
  /** 歌词时间轴（秒，渲染层已应用偏移）；noLyric 时传空数组 */
  lyrics: { time: number; text: string }[]
  /** 是否添加 BiliMusic 角标水印（AppSettings.mvWatermark） */
  watermark: boolean
  /** 自定义输出目录（下载目录），MV 落在其下 MV/ 子目录 */
  outputDir?: string
}

export interface MvExportProgress {
  phase: 'audio' | 'render' | 'compose' | 'done'
  percent: number
  message?: string
  filePath?: string
}

const WIDTH = 1280
const HEIGHT = 720
const PROGRESS_X = 80
const PROGRESS_W = 1120
const PROGRESS_Y = 656

// ===== ffmpeg 路径解析（与 biliApi.ts 同策略：ffmpeg-static 优先，asar.unpacked 回退） =====

function resolveFfmpegPath(): string {
  try {
    const fixedPath = require('ffmpeg-static') as string
    if (fixedPath && fsSync.existsSync(fixedPath)) return fixedPath
    console.warn('[mvExport] ffmpeg-static path not exists:', fixedPath)
  } catch (e) {
    console.warn('[mvExport] ffmpeg-static require failed:', e)
  }
  const candidates = [
    path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'),
    path.join(__dirname, '../../node_modules/ffmpeg-static/ffmpeg.exe'),
  ]
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p
  }
  console.warn('[mvExport] ffmpeg not found, falling back to system PATH')
  return 'ffmpeg'
}

const ffmpegPath = resolveFfmpegPath()

/** 登记存活子进程，will-quit 时统一 kill（与 biliApi.killAllChildren 同一注册表） */
const childProcesses = new Set<ReturnType<typeof spawn>>()
function trackChild<T extends ReturnType<typeof spawn>>(proc: T): T {
  childProcesses.add(proc)
  proc.once('exit', () => childProcesses.delete(proc))
  return proc
}

/** will-quit 时由 main.ts 调用，终止存活的 ffmpeg 子进程 */
export function killMvExportChildren() {
  for (const proc of childProcesses) {
    try { proc.kill() } catch { /* 已退出 */ }
  }
}

// ===== 取消支持 =====

interface MvExportJob {
  cancelRequested: boolean
  proc?: ReturnType<typeof spawn>
  window?: BrowserWindow
  tempDir?: string
}
let currentJob: MvExportJob | null = null

export function isMvExportRunning(): boolean {
  return currentJob !== null
}

// ===== 渲染布局 =====

/**
 * 关键帧布局状态。窗口只负责画静态布局 + 歌词区窗口，
 * 进度条填充与时间数字由 ffmpeg 绘制（稀疏帧之间要连续移动）。
 */
interface FrameState {
  cover: string
  title: string
  artist: string
  windowStart: number
  currentIdx: number
  lines: { time: number; text: string }[]
  noLyric: boolean
}

function buildFrameHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #1a1b21 0%, #131418 60%, #191a20 100%);
    color: #f2f3f5;
  }
  .left { position: absolute; left: 80px; top: 96px; width: 400px; }
  .cover {
    width: 400px; height: 400px; border-radius: 20px; object-fit: cover;
    box-shadow: 0 24px 60px rgba(0, 0, 0, .5);
    background: linear-gradient(135deg, #2a2b33, #1e1f26);
  }
  .title { margin-top: 34px; font-size: 27px; font-weight: 760; line-height: 1.3;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .artist { margin-top: 10px; font-size: 18px; color: rgba(242, 243, 245, .55); font-weight: 560; }
  .brand { position: absolute; left: 80px; top: 48px; font-size: 17px; font-weight: 800; color: #ff375f; letter-spacing: .5px; }
  .lyrics { position: absolute; left: 620px; top: 0; width: 580px; height: ${HEIGHT}px; overflow: hidden; }
  .lyrics-inner { position: absolute; top: 50%; transform: translateY(-50%); width: 100%; }
  .line { height: 46px; line-height: 46px; font-size: 20px; color: rgba(242, 243, 245, .34);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 560; }
  .line.active { font-size: 25px; height: 52px; line-height: 52px; color: #f2f3f5; font-weight: 800; }
  .no-lyric { font-size: 20px; color: rgba(242, 243, 245, .34); }
  /* 进度条底槽（填充与时间数字由 ffmpeg 绘制） */
  .track { position: absolute; left: ${PROGRESS_X}px; top: ${PROGRESS_Y}px; width: ${PROGRESS_W}px; height: 5px;
    border-radius: 3px; background: rgba(255, 255, 255, .14); }
</style>
</head>
<body>
  <div class="brand">BiliMusic</div>
  <div class="left">
    <img class="cover" id="cover" />
    <div class="title" id="title"></div>
    <div class="artist" id="artist"></div>
  </div>
  <div class="lyrics"><div class="lyrics-inner" id="lyricsInner"></div></div>
  <div class="track"></div>
  <script>
    window.__mvSetState = function (state) {
      document.getElementById('cover').src = state.cover || ''
      document.getElementById('title').textContent = state.title || ''
      document.getElementById('artist').textContent = state.artist || ''
      var inner = document.getElementById('lyricsInner')
      inner.innerHTML = ''
      if (state.noLyric || !state.lines || !state.lines.length) {
        var d = document.createElement('div')
        d.className = 'no-lyric'
        d.textContent = '暂无歌词'
        inner.appendChild(d)
        return
      }
      var WINDOW = 9
      var start = Math.max(0, Math.min(state.windowStart, state.lines.length - 1))
      for (var i = start; i < Math.min(start + WINDOW, state.lines.length); i++) {
        var el = document.createElement('div')
        el.className = 'line' + (i === state.currentIdx ? ' active' : '')
        el.textContent = state.lines[i].text || ''
        inner.appendChild(el)
      }
    }
  </script>
</body>
</html>`
}

/** 歌词区可视窗口行数（与 buildFrameHtml 的 WINDOW 保持一致） */
const LYRIC_WINDOW = 9

/** 计算某时刻的歌词窗口起点：高亮行尽量居中，越界时贴边 */
function windowStartFor(currentIdx: number, total: number): number {
  return Math.max(0, Math.min(currentIdx - Math.floor(LYRIC_WINDOW / 2), Math.max(0, total - LYRIC_WINDOW)))
}

/** 生成关键帧计划：每个「歌词显示状态变化」一个时间点 */
interface KeyframePlan {
  time: number
  windowStart: number
  currentIdx: number
}

function buildKeyframePlan(lyrics: { time: number; text: string }[], duration: number): KeyframePlan[] {
  const lines = lyrics
    .filter((l) => Number.isFinite(l.time) && l.time >= 0 && l.time < duration && l.text.trim())
    .sort((a, b) => a.time - b.time)
  if (!lines.length) return [{ time: 0, windowStart: 0, currentIdx: -1 }]

  const times = [0, ...lines.map((l) => l.time)]
  const plans: KeyframePlan[] = []
  let lastSig = ''
  for (const t of times) {
    // 当前高亮行 = 最后一条 time <= t 的行
    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= t + 1e-6) idx = i
      else break
    }
    const ws = windowStartFor(idx, lines.length)
    const sig = `${idx}:${ws}`
    if (sig === lastSig) continue
    lastSig = sig
    plans.push({ time: t, windowStart: ws, currentIdx: idx })
  }
  return plans
}

// ===== ffmpeg 辅助 =====

function runFfmpeg(args: string[], onTime?: (seconds: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = trackChild(spawn(ffmpegPath, args, { windowsHide: true }))
    if (currentJob) currentJob.proc = proc
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
      if (onTime) {
        const matches = stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)
        for (const m of matches) {
          onTime(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
        }
      }
    })
    proc.on('error', (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}. ffmpegPath=${ffmpegPath}`)))
    proc.on('exit', (code) => {
      if (currentJob?.cancelRequested) reject(new Error('已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg 失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

/** 检测编码器可用性：优先 NVENC，未检出回退 libx264 */
async function pickVideoEncoderArgs(): Promise<string[]> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const proc = trackChild(spawn(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true }))
      let stdout = ''
      proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
      proc.on('error', reject)
      proc.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`))))
    })
    if (out.includes('h264_nvenc')) return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23']
  } catch { /* 检测失败走软编 */ }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']
}

/** 找一个可用的中文界面字体给 drawtext；找不到返回 null（跳过 drawtext，视频没有时间数字） */
function pickDrawtextFont(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/arial.ttf',
      ]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Helvetica.ttc']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
  for (const p of candidates) {
    if (fsSync.existsSync(p)) return p
  }
  return null
}

/** filtergraph 选项值内的转义：':' 与 ',' 在 filter 解析层有特殊含义 */
function fgEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,')
}

function formatMmSs(totalSeconds: number): { mm: number; ss: number } {
  const s = Math.max(0, Math.floor(totalSeconds))
  return { mm: Math.floor(s / 60), ss: s % 60 }
}

// ===== 主流程 =====

async function downloadToFile(url: string, filePath: string, label: string, onPercent?: (p: number) => void): Promise<void> {
  const response = await net.fetch(url, { headers: { Referer: BILI_REFERER, 'User-Agent': BILI_UA } })
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status} ${response.statusText}`)
  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body?.getReader()
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(filePath, buffer)
    onPercent?.(100)
    return
  }
  const writeStream = fsSync.createWriteStream(filePath)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.length
        if (!writeStream.write(value)) {
          await new Promise<void>((resolve, reject) => {
            writeStream.once('drain', resolve)
            writeStream.once('error', reject)
          })
        }
        if (total > 0) onPercent?.(Math.round((received / total) * 100))
        void label
      }
    }
    await new Promise<void>((resolve, reject) => writeStream.end((err) => (err ? reject(err) : resolve())))
  } finally {
    if (!writeStream.closed) writeStream.destroy()
  }
}

async function captureKeyframes(job: MvExportJob, payload: MvExportPayload, plans: KeyframePlan[], tempDir: string, sender: Electron.WebContents | null): Promise<string[]> {
  // 封面：主进程下载并降采样，转 data URL 嵌入（避免离屏页跨域加载 CDN 图）
  let coverDataUrl = ''
  if (payload.coverUrl) {
    try {
      const resp = await net.fetch(payload.coverUrl, { headers: { Referer: BILI_REFERER, 'User-Agent': BILI_UA } })
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer())
        const img = nativeImage.createFromBuffer(buf)
        const resized = img.isEmpty() ? null : img.resize({ width: 480, height: 480, quality: 'good' })
        const jpeg = (resized || img).toJPEG(88)
        coverDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
      }
    } catch (e) {
      console.warn('[mvExport] cover fetch failed, use placeholder:', e)
    }
  }

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  job.window = win
  win.webContents.setBackgroundThrottling(false)

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildFrameHtml())}`)

  const state: FrameState = {
    cover: coverDataUrl,
    title: payload.title,
    artist: payload.artist,
    windowStart: 0,
    currentIdx: -1,
    lines: payload.lyrics,
    noLyric: !payload.lyrics.length,
  }

  const frames: string[] = []
  try {
    for (let i = 0; i < plans.length; i++) {
      if (job.cancelRequested) throw new Error('已取消')
      const plan = plans[i]
      state.windowStart = plan.windowStart
      state.currentIdx = plan.currentIdx
      await win.webContents.executeJavaScript(`window.__mvSetState(${JSON.stringify(state)}); 'ok'`)
      // 强制重绘并等一帧 paint 再捕获：offscreen 窗口 capturePage 可能拿到旧帧
      const painted = new Promise<void>((resolve) => {
        const onPaint = () => { win.webContents.off('paint', onPaint); resolve() }
        win.webContents.on('paint', onPaint)
        setTimeout(() => { win.webContents.off('paint', onPaint); resolve() }, 150)
      })
      win.webContents.invalidate()
      await painted
      const img0 = await win.webContents.capturePage()
      // 高 DPI 屏幕离屏缓冲按 deviceScaleFactor 放大，统一缩回目标分辨率
      const size = img0.getSize()
      const img = size.width === WIDTH ? img0 : img0.resize({ width: WIDTH, height: HEIGHT, quality: 'good' })
      const filePath = path.join(tempDir, `kf_${String(i).padStart(4, '0')}.jpg`)
      await fs.writeFile(filePath, img.toJPEG(90))
      frames.push(filePath)
      if (i % 5 === 0 || i === plans.length - 1) {
        sendProgress(sender, {
          phase: 'render',
          percent: Math.round(((i + 1) / plans.length) * 100),
          message: `渲染关键帧 ${i + 1}/${plans.length}`,
        })
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    if (job.window === win) job.window = undefined
  }
  if (!frames.length) throw new Error('未捕获到任何关键帧')
  return frames
}

function sendProgress(sender: Electron.WebContents | null, progress: MvExportProgress) {
  try {
    sender?.send('mv:export-progress', progress)
  } catch { /* sender 已销毁 */ }
}

async function runExport(payload: MvExportPayload, sender: Electron.WebContents | null): Promise<{ filePath: string }> {
  const duration = Math.max(1, payload.duration || 0)
  const outDir = path.join(payload.outputDir || path.join(app.getPath('userData'), 'downloads'), 'MV')
  await fs.mkdir(outDir, { recursive: true })
  const safeName = (payload.title || 'mv').replace(/[\\/:*?"<>|]/g, '_').trim() || 'mv'
  const outputPath = path.join(outDir, `${safeName}.mp4`)

  const tempDir = path.join(os.tmpdir(), `bilimusic-mv-${Date.now()}`)
  await fs.mkdir(tempDir, { recursive: true })
  const job: MvExportJob = { cancelRequested: false, tempDir }
  currentJob = job

  try {
    // 1. 下载音频
    const audioPath = path.join(tempDir, 'audio.bin')
    let lastPercent = -1
    await downloadToFile(payload.audioUrl, audioPath, 'audio', (p) => {
      if (p !== lastPercent) {
        lastPercent = p
        sendProgress(sender, { phase: 'audio', percent: p, message: '下载音频' })
      }
    })

    // 2. 渲染关键帧
    const plans = buildKeyframePlan(payload.lyrics, duration)
    const frames = await captureKeyframes(job, payload, plans, tempDir, sender)

    // 3. ffmpeg 稀疏合成
    const encoderArgs = await pickVideoEncoderArgs()
    const fontPath = pickDrawtextFont()

    const args: string[] = ['-y', '-i', audioPath]
    for (const f of frames) args.push('-loop', '1', '-framerate', '45', '-i', f)

    // overlay 链：kf0 常驻，kf_i 在 [t_i, t_{i+1}) 显示
    const graphParts: string[] = []
    let cur = '[1:v]'
    for (let i = 1; i < frames.length; i++) {
      const nextT = i + 1 < frames.length ? plans[i + 1].time : duration + 1
      const out = `[ov${i}]`
      graphParts.push(`${cur}[${i + 1}:v]overlay=enable='between(t,${plans[i].time.toFixed(3)},${nextT.toFixed(3)})'${out}`)
      cur = out
    }
    // 进度条填充（drawbox w 表达式随 t 线性增长，超宽自动截断）
    let drawCur = cur
    const chain = (filter: string, tag: string) => {
      graphParts.push(`${drawCur}${filter}${tag}`)
      drawCur = tag
    }
    chain(`drawbox=x=${PROGRESS_X}:y=${PROGRESS_Y}:w='${PROGRESS_W}*t/${duration.toFixed(3)}':h=5:color=0xFF375F@0.88:t=fill`, `[db]`)

    if (fontPath) {
      // 当前时间 mm:ss（eif 表达式）；总时长静态文本
      const { mm, ss } = formatMmSs(duration)
      const timeExpr = `text='%{eif\\:trunc(t/60)\\:d\\:2}\\:%{eif\\:mod(trunc(t)\\,60)\\:d\\:2}'`
      chain(`drawtext=fontfile='${fgEscape(fontPath)}':${timeExpr}:x=${PROGRESS_X}:y=${PROGRESS_Y - 38}:fontsize=20:fontcolor=0xC9CDD6`, `[dt1]`)
      const totalText = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      chain(`drawtext=fontfile='${fgEscape(fontPath)}':text='${fgEscape(totalText)}':x=w-text_w-${PROGRESS_X}:y=${PROGRESS_Y - 38}:fontsize=20:fontcolor=0xC9CDD6`, `[dt2]`)
      if (payload.watermark) {
        chain(`drawtext=fontfile='${fgEscape(fontPath)}':text='${fgEscape('BiliMusic')}':x=w-text_w-40:y=32:fontsize=20:fontcolor=0xFFFFFF@0.32`, `[wm]`)
      }
    }
    graphParts.push(`${drawCur}format=yuv420p[vout]`)
    const filterComplex = graphParts.join(';')

    args.push(
      '-filter_complex', filterComplex,
      '-map', '[vout]', '-map', '0:a',
      ...encoderArgs,
      '-c:a', 'aac', '-b:a', '192k',
      '-r', '45',
      '-t', duration.toFixed(3),
      '-movflags', '+faststart',
      outputPath,
    )

    await runFfmpeg(args, (seconds) => {
      sendProgress(sender, { phase: 'compose', percent: Math.min(99, Math.round((seconds / duration) * 100)), message: '合成视频' })
    })

    sendProgress(sender, { phase: 'done', percent: 100, filePath: outputPath })
    return { filePath: outputPath }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    if (currentJob === job) currentJob = null
  }
}

export function registerMvExportHandlers() {
  ipcMain.handle('mv:exportSingle', async (event, payload: MvExportPayload) => {
    if (currentJob) {
      return { ok: false, message: '已有导出任务进行中' }
    }
    if (!payload || typeof payload.audioUrl !== 'string' || !payload.audioUrl) {
      return { ok: false, message: '缺少音频地址' }
    }
    try {
      const { filePath } = await runExport(payload, event.sender)
      return { ok: true, filePath }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn('[mvExport] export failed:', message)
      if (message !== '已取消') {
        sendProgress(event.sender, { phase: 'done', percent: 100, message })
      }
      return { ok: false, message }
    } finally {
      if (currentJob) {
        // runExport 的 finally 已清理 currentJob（正常路径）；异常路径兜底
        currentJob = null
      }
    }
  })

  ipcMain.handle('mv:cancel', () => {
    if (!currentJob) return { ok: false }
    currentJob.cancelRequested = true
    try { currentJob.proc?.kill() } catch { /* 已退出 */ }
    try { currentJob.window?.destroy() } catch { /* 已销毁 */ }
    return { ok: true }
  })
}

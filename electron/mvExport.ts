/**
 * v1.4.6 播放页 MV 视频导出（桌面端专属）—— pre3 方案 A 整改版
 *
 * 真实 UI 离屏渲染：隐藏窗口加载真实渲染层（打包 app://local / 开发 dev server），
 * 路由到 #/mv-export 导出态舞台（复用真实 NowPlaying 的 CSS 与 LyricsView/PlayerSlider
 * 组件与主题），主进程只按时间轴步进「当前播放时间」并逐帧捕获。进度条/时间数字/
 * 水印全部由真实组件画进帧内，ffmpeg 不再有任何 drawbox/drawtext 叠画。
 *
 * 合成（O(N)）：关键帧按时间点连成 concat demuxer 清单（每帧带 duration），
 * 单个 ffmpeg 进程一次编码完成，替代 pre2 的 N 层 overlay 链（O(总帧数×关键帧数)）。
 * 编码器探测链：NVENC → QSV → AMF → libx264，全部以真实试编退出码为准。
 *
 * 进度：合成阶段用 ffmpeg `-progress pipe:1` 结构化输出，每秒至少一次回调。
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
/** 捕获时间网格步长（秒）：进度条/时间数字的刷新粒度 */
const CAPTURE_STEP = 0.5
/** 最大关键帧数（超出自动放粗步长），控制渲染耗时上限 */
const MAX_FRAMES = 720
/** 封面降采样尺寸（CSS 显示 400px，高 DPI 留足余量） */
const COVER_SIZE = 800

// ===== ffmpeg 路径解析（与 biliApi.ts 同策略：ffmpeg-static 优先，asar.unpacked 回退） =====

function resolveFfmpegPath(): string {
  // 策略 1：通过 createRequire 解析 ffmpeg-static
  // 打包后二进制在 app.asar.unpacked（asarUnpack 配置），require 返回的路径还在 asar 内（虚拟路径，
  // spawn ENOENT），必须改写为 .unpacked 实体路径——与 biliApi.ts 同一策略
  try {
    const rawPath = require('ffmpeg-static') as string
    const fixedPath = rawPath.includes('app.asar')
      ? rawPath.replace('app.asar', 'app.asar.unpacked')
      : rawPath
    if (fixedPath && fsSync.existsSync(fixedPath)) {
      console.log('[mvExport] ffmpeg resolved (ffmpeg-static):', fixedPath)
      return fixedPath
    }
    console.warn('[mvExport] ffmpeg-static path not exists:', fixedPath)
  } catch (e) {
    console.warn('[mvExport] ffmpeg-static require failed:', e)
  }
  // 策略 2：直接检查常见路径（asar.unpacked 优先）
  const candidates = [
    path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'),
    path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe'),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ===== 捕获时间轴 =====

/**
 * 生成捕获时间点：固定网格（进度条/时间数字刷新）∪ 歌词行起点（高亮切换精确落位）。
 * 返回升序去重数组，首点恒为 0。
 */
function buildCaptureTimes(lyrics: { time: number; text: string }[], duration: number): number[] {
  const step = Math.max(CAPTURE_STEP, duration / MAX_FRAMES)
  const round = (t: number) => Math.round(t * 1000) / 1000
  const set = new Set<number>([0])
  for (let t = step; t < duration; t += step) set.add(round(t))
  for (const l of lyrics) {
    if (Number.isFinite(l.time) && l.time >= 0 && l.time < duration && l.text.trim()) set.add(round(l.time))
  }
  return [...set].sort((a, b) => a - b)
}

// ===== ffmpeg 辅助 =====

interface RunFfmpegOptions {
  /** stdout `-progress pipe:1` 的 out_time（秒）回调 */
  onOutTime?: (seconds: number) => void
}

function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = trackChild(spawn(ffmpegPath, args, { windowsHide: true }))
    if (currentJob) currentJob.proc = proc
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
    })
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (!options.onOutTime) return
      // -progress 输出形如 out_time_ms=1234567（实为微秒）
      const matches = chunk.toString().matchAll(/out_time_ms=(\d+)/g)
      for (const m of matches) options.onOutTime(Number(m[1]) / 1e6)
    })
    proc.on('error', (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}. ffmpegPath=${ffmpegPath}`)))
    proc.on('exit', (code) => {
      if (currentJob?.cancelRequested) reject(new Error('已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg 失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

interface EncoderCandidate {
  codec: string
  /** 编码质量参数（追加在 -c:v 之后） */
  qualityArgs: string[]
}

const ENCODER_CANDIDATES: EncoderCandidate[] = [
  { codec: 'h264_nvenc', qualityArgs: ['-preset', 'p4', '-cq', '23'] },
  { codec: 'h264_qsv', qualityArgs: ['-global_quality', '23'] },
  { codec: 'h264_amf', qualityArgs: ['-quality', 'balanced'] },
  { codec: 'libx264', qualityArgs: ['-preset', 'veryfast', '-crf', '20'] },
]

/**
 * 合成视频：编码器不做事前探测。真机实测（v1.4.6-pre3 harness）证明「探测通过 ≠ 能编完」——
 * NVENC 探测直接段错误尚可拦住，但 QSV 能通过 0.1s 试编却在真实任务里中途 device failed (-17)。
 * 所以直接用真实合成当探测：按 NVENC → QSV → AMF → libx264 逐个跑完整任务，失败回退下一个。
 */
async function composeVideo(listPath: string, audioPath: string, outputPath: string, duration: number, sender: Electron.WebContents | null): Promise<void> {
  let lastError = ''
  for (const candidate of ENCODER_CANDIDATES) {
    if (currentJob?.cancelRequested) throw new Error('已取消')
    const args: string[] = [
      '-y', '-hide_banner', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-i', audioPath,
      '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
      '-map', '0:v', '-map', '1:a',
      '-c:v', candidate.codec, ...candidate.qualityArgs,
      '-c:a', 'aac', '-b:a', '192k',
      '-r', '45',
      '-t', duration.toFixed(3),
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      outputPath,
    ]
    try {
      const label = candidate.codec === 'libx264' ? '合成视频' : `合成视频（${candidate.codec.replace('h264_', '').toUpperCase()}）`
      await runFfmpeg(args, {
        onOutTime: (seconds) => {
          sendProgress(sender, { phase: 'compose', percent: Math.min(99, Math.round((seconds / duration) * 100)), message: label })
        },
      })
      return
    } catch (e) {
      if (currentJob?.cancelRequested) throw e
      lastError = e instanceof Error ? e.message : String(e)
      console.warn(`[mvExport] encoder ${candidate.codec} failed on real task, falling back:`, lastError)
    }
  }
  throw new Error(`视频合成失败（已尝试全部编码器）：${lastError}`)
}

/** 用 ffmpeg 读媒体文件时长（秒）；失败返回 0 */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      const proc = trackChild(spawn(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { windowsHide: true }))
      let stderr = ''
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('error', () => resolve(0))
      // 退出码非 0 是预期的（无输出文件），从 stderr 的 Duration= 行解析
      proc.on('exit', () => {
        const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0)
      })
    } catch {
      resolve(0)
    }
  })
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
      if (currentJob?.cancelRequested) throw new Error('已取消')
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

/** 下载封面并降采样为 data URL（避免离屏页跨域加载 CDN 图与加载时序问题） */
async function fetchCoverDataUrl(coverUrl: string): Promise<string> {
  if (!coverUrl) return ''
  try {
    const resp = await net.fetch(coverUrl, { headers: { Referer: BILI_REFERER, 'User-Agent': BILI_UA } })
    if (!resp.ok) return ''
    const buf = Buffer.from(await resp.arrayBuffer())
    const img = nativeImage.createFromBuffer(buf)
    if (img.isEmpty()) return ''
    const resized = img.resize({ width: COVER_SIZE, height: COVER_SIZE, quality: 'good' })
    const jpeg = (img.getSize().width <= COVER_SIZE ? img : resized).toJPEG(90)
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch (e) {
    console.warn('[mvExport] cover fetch failed, use placeholder:', e)
    return ''
  }
}

/** 解析导出舞台页面地址：开发走 dev server，打包走 app://local 协议（与主窗口同源同 localStorage） */
function resolveStageUrl(): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) return `${devUrl.replace(/\/$/, '')}#/mv-export`
  return 'app://local/index.html#/mv-export'
}

/** 等待离屏 paint（兜底定时器先判 isDestroyed，防止「Object has been destroyed」） */
function waitForPaint(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      try {
        if (!win.isDestroyed()) win.webContents.off('paint', onPaint)
      } catch { /* 窗口已销毁 */ }
      resolve()
    }
    const timer = setTimeout(finish, 150)
    const onPaint = () => finish()
    win.webContents.on('paint', onPaint)
  })
}

/**
 * 驱动真实 UI 舞台逐帧捕获：加载 #/mv-export 舞台 → 注入曲目信息 → 等就绪 →
 * 按捕获时间轴步进「当前播放时间」，每步等一帧 paint 后 capturePage 落盘 JPEG。
 */
async function captureFrames(job: MvExportJob, payload: MvExportPayload, times: number[], duration: number, tempDir: string, sender: Electron.WebContents | null): Promise<string[]> {
  const coverDataUrl = await fetchCoverDataUrl(payload.coverUrl)

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  job.window = win
  win.webContents.setBackgroundThrottling(false)
  win.webContents.setFrameRate(60)

  const frames: string[] = []
  try {
    await win.loadURL(resolveStageUrl())

    // 注入曲目信息，等待字体/封面就绪（舞台置 window.__mvReady）
    await win.webContents.executeJavaScript(
      `window.__mvInit(${JSON.stringify(JSON.stringify({
        title: payload.title,
        artist: payload.artist,
        cover: coverDataUrl,
        duration,
        lyrics: payload.lyrics,
        watermark: payload.watermark,
      }))})`,
    )
    const readyDeadline = Date.now() + 20_000
    for (;;) {
      if (job.cancelRequested || win.isDestroyed()) throw new Error('已取消')
      if (await win.webContents.executeJavaScript('window.__mvReady === true')) break
      if (Date.now() > readyDeadline) throw new Error('导出页面加载超时')
      await sleep(120)
    }

    // 主题/布局入场是静态的，先空转一帧让首屏稳定
    win.webContents.invalidate()
    await waitForPaint(win)

    for (let i = 0; i < times.length; i++) {
      if (job.cancelRequested || win.isDestroyed()) throw new Error('已取消')
      await win.webContents.executeJavaScript(`window.__mvSetTime(${times[i].toFixed(3)})`)
      win.webContents.invalidate()
      await waitForPaint(win)
      if (win.isDestroyed()) throw new Error('已取消')
      const img = await win.webContents.capturePage()
      const filePath = path.join(tempDir, `kf_${String(i).padStart(4, '0')}.jpg`)
      // 离屏缓冲按显示器 DPI 放大（如 175% → 2242×1262），保留原分辨率落盘，
      // 合成阶段由 ffmpeg lanczos 高质量缩回 720p，比 NativeImage 缩放更锐
      await fs.writeFile(filePath, img.toJPEG(88))
      frames.push(filePath)
      if (i % 5 === 0 || i === times.length - 1) {
        sendProgress(sender, {
          phase: 'render',
          percent: Math.round(((i + 1) / times.length) * 100),
          message: `渲染播放页 ${i + 1}/${times.length} 帧`,
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

/** 生成 concat demuxer 清单：每帧一个条目 + duration（末帧补一次重复行，concat 规范要求） */
async function writeConcatList(frames: string[], times: number[], duration: number, listPath: string): Promise<void> {
  const escapeConcat = (p: string) => p.replace(/\\/g, '/').replace(/'/g, "'\\''")
  const lines: string[] = ['ffconcat version 1.0']
  for (let i = 0; i < frames.length; i++) {
    const segEnd = i + 1 < frames.length ? times[i + 1] : duration
    const segDuration = Math.max(0.04, segEnd - times[i])
    lines.push(`file '${escapeConcat(frames[i])}'`)
    lines.push(`duration ${segDuration.toFixed(3)}`)
  }
  lines.push(`file '${escapeConcat(frames[frames.length - 1])}'`)
  await fs.writeFile(listPath, lines.join('\n'), 'utf8')
}

function sendProgress(sender: Electron.WebContents | null, progress: MvExportProgress) {
  try {
    sender?.send('mv:export-progress', progress)
  } catch { /* sender 已销毁 */ }
}

async function runExport(payload: MvExportPayload, sender: Electron.WebContents | null): Promise<{ filePath: string }> {
  const outDir = path.join(payload.outputDir || path.join(app.getPath('userData'), 'downloads'), 'MV')
  await fs.mkdir(outDir, { recursive: true })
  const safeName = (payload.title || 'mv').replace(/[\\/:*?"<>|]/g, '_').trim() || 'mv'
  // 同名曲目防覆盖：已存在时追加序号（批量中同名曲目/重复导出不再互相吞文件）
  let outputPath = path.join(outDir, `${safeName}.mp4`)
  for (let n = 2; fsSync.existsSync(outputPath); n++) {
    outputPath = path.join(outDir, `${safeName} (${n}).mp4`)
  }

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

    // 时长兜底：渲染层 track.duration 可能为 0（如 avid/cid 回退源），以音频实测为准
    let duration = Math.max(1, payload.duration || 0)
    if (!payload.duration || payload.duration < 1) {
      const probed = await probeDuration(audioPath)
      if (probed > 0) duration = probed
    }

    // 2. 真实 UI 逐帧捕获
    const times = buildCaptureTimes(payload.lyrics, duration)
    const frames = await captureFrames(job, payload, times, duration, tempDir, sender)

    // 3. 单遍合成：concat demuxer 按 duration 拼帧 → 一次编码（O(N)，无 overlay 链）
    await writeConcatList(frames, times, duration, path.join(tempDir, 'list.txt'))
    await composeVideo(path.join(tempDir, 'list.txt'), audioPath, outputPath, duration, sender)

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
      // 取消路径下离屏窗口被 destroy，循环内调用会以「Object has been destroyed」冒泡，归一为「已取消」
      const raw = e instanceof Error ? e.message : String(e)
      const message = currentJob?.cancelRequested && raw.includes('Object has been destroyed') ? '已取消' : raw
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

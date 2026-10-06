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
import { resolveEncoderCandidates, type EncoderCandidate } from './encoders'

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
  /** 流畅度档位（快速/标准/流畅/极致），缺省取标准 */
  smoothness?: string
  /** 自定义输出目录（下载目录），MV 落在其下 MV/ 子目录 */
  outputDir?: string
}

export interface MvExportProgress {
  /** error：任务失败（与 done 分离，批量侧不会把失败当 100% 完成） */
  phase: 'audio' | 'render' | 'compose' | 'done' | 'error'
  percent: number
  message?: string
  filePath?: string
}

const WIDTH = 1280
const HEIGHT = 720
/**
 * 流畅度档位（v1.4.7-pre1，步长为用户定案值）：网格步长即进度条/歌词的视觉更新粒度，
 * 上限封顶控制渲染耗时与临时盘最坏占用（超出自动放粗步长）。
 * 快速=0.15s、标准=0.1s（默认）、流畅=0.05s、极致=0.03s（接近 45fps 满视觉流畅）。
 */
const SMOOTHNESS_PRESETS: Record<string, { step: number; maxFrames: number }> = {
  '快速': { step: 0.15, maxFrames: 3600 },
  '标准': { step: 0.1, maxFrames: 4800 },
  '流畅': { step: 0.05, maxFrames: 6000 },
  '极致': { step: 0.03, maxFrames: 9000 },
}
const DEFAULT_SMOOTHNESS = '标准'
/** 并行分段渲染：每窗最多捕获帧数，K 自适应 min(8, ceil(总帧数/400))，失败回退单窗 */
const FRAMES_PER_WORKER = 400
const MAX_PARALLEL_WINDOWS = 8
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
  // 策略 2：直接检查常见路径（asar.unpacked 优先；二进制名按平台区分，非 Windows 的 ffmpeg-static 无 .exe）
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    path.join(process.resourcesPath || '', `app.asar.unpacked/node_modules/ffmpeg-static/${exeName}`),
    path.join(__dirname, `../node_modules/ffmpeg-static/${exeName}`),
    path.join(__dirname, `../../node_modules/ffmpeg-static/${exeName}`),
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
  /** 发起方标签：批量下载传 'batch'，单曲导出为 null。取消按标签隔离（修复1） */
  ownerTag: string | null
  cancelRequested: boolean
  proc?: ReturnType<typeof spawn>
  /** 并行捕获的全部离屏窗口（v1.4.7-pre1 K 窗分段渲染） */
  windows: BrowserWindow[]
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
 * 步长与帧数上限来自流畅度档位；超出上限自动放粗步长（超长歌降档保护）。
 * 返回升序去重数组，首点恒为 0。
 */
function buildCaptureTimes(lyrics: { time: number; text: string }[], duration: number, step0: number, maxFrames: number): number[] {
  const step = Math.max(step0, duration / maxFrames)
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

/**
 * 合成视频：编码器不做事前探测。真机实测（v1.4.6-pre3 harness）证明「探测通过 ≠ 能编完」——
 * NVENC 探测直接段错误尚可拦住，但 QSV 能通过 0.1s 试编却在真实任务里中途 device failed (-17)。
 * 所以直接用真实合成当探测：候选由 GPU 厂商预判给出（encoders.ts，v1.4.7-pre2：厂商不符的
 * 白跑候选消除，macOS 直达 videotoolbox），按序跑完整合成，失败回退下一个，libx264 保底。
 */
async function composeVideo(listPath: string, audioPath: string, outputPath: string, duration: number, sender: Electron.WebContents | null): Promise<void> {
  const candidates: EncoderCandidate[] = await resolveEncoderCandidates(process.platform)
  let lastError = ''
  for (const candidate of candidates) {
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
      const proc = trackChild(spawn(ffmpegPath, ['-i', filePath, '-t', '0.2', '-f', 'null', '-'], { windowsHide: true }))
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
  // Referer 防盗链只对 https CDN 有意义；Chromium 对 http 目标注入 Referer 直接
  // ERR_BLOCKED_BY_CLIENT（harness 本地回环音源因此改走无 Referer 分支）
  const headers = url.startsWith('https://') ? { Referer: BILI_REFERER, 'User-Agent': BILI_UA } : { 'User-Agent': BILI_UA }
  const response = await net.fetch(url, { headers })
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
  // error 监听常驻（修复2）：只覆盖背压 await 期的话，write() 返回 true 后磁盘异步失败
  // （磁盘满/权限收回）无人监听，Node 会以 uncaught exception 崩溃主进程。
  let streamError: Error | null = null
  const onError = (err: Error) => { streamError = err }
  writeStream.on('error', onError)
  try {
    for (;;) {
      if (currentJob?.cancelRequested) throw new Error('已取消')
      if (streamError) throw streamError
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.length
        if (!writeStream.write(value)) {
          await new Promise<void>((resolve) => {
            writeStream.once('drain', resolve)
          })
        }
        if (total > 0) onPercent?.(Math.round((received / total) * 100))
        void label
      }
    }
    await new Promise<void>((resolve, reject) => writeStream.end((err) => (err ? reject(err) : resolve())))
  } finally {
    writeStream.off('error', onError)
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
 *
 * v1.4.7-pre1 并行分段渲染：times 按时间序切 K 片，K 个离屏窗口独立捕获后按序合并；
 * K = min(8, ceil(总帧数/400))。相邻帧视觉相同（密集采样下进度条亚像素位移不产生新画面）
 * 时跳过落盘，并入前一帧 duration（writeConcatList 按 keptTimes 计段），削减合成输入。
 */
function createCaptureWindow(job: MvExportJob): BrowserWindow {
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
  job.windows.push(win)
  win.webContents.setBackgroundThrottling(false)
  win.webContents.setFrameRate(60)
  return win
}

/** 单个离屏窗口捕获一个连续时间段：返回实际落盘的帧文件与其时间点（相同帧已合并） */
async function captureChunkWorker(
  job: MvExportJob,
  payload: MvExportPayload,
  duration: number,
  partIndex: number,
  chunk: number[],
  tempDir: string,
  coverDataUrl: string,
  sender: Electron.WebContents | null,
  doneCount: { value: number },
  totalFrames: number,
): Promise<{ files: string[]; times: number[] }> {
  const win = createCaptureWindow(job)
  const files: string[] = []
  const keptTimes: number[] = []
  try {
    await win.loadURL(resolveStageUrl())
    await win.webContents.executeJavaScript(
      `window.__mvInit(${JSON.stringify(JSON.stringify({
        title: payload.title,
        artist: payload.artist,
        cover: coverDataUrl,
        duration,
        // 并行分段渲染（v1.4.7-pre2）：每窗直接落位到自己片段起点，
        // 避免从 0 初始化后首个 __mvSetTime 触发歌词从开头滚动到对应位置的跳变入帧
        startTime: chunk[0] || 0,
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

    // 主题/布局入场是静态的，先空转一帧让首屏稳定（每窗各自稳定一次）
    win.webContents.invalidate()
    await waitForPaint(win)

    let prevJpeg: Buffer | null = null
    for (let i = 0; i < chunk.length; i++) {
      if (job.cancelRequested || win.isDestroyed()) throw new Error('已取消')
      await win.webContents.executeJavaScript(`window.__mvSetTime(${chunk[i].toFixed(3)})`)
      win.webContents.invalidate()
      await waitForPaint(win)
      if (win.isDestroyed()) throw new Error('已取消')
      const img = await win.webContents.capturePage()
      const jpeg = img.toJPEG(88)
      // 相同帧合并：密集采样下相邻帧常完全一致（仅进度条亚像素位移不足产生新像素），
      // 字节级相同则不落盘，合成段 duration 自动并入前一帧
      if (prevJpeg && jpeg.equals(prevJpeg)) {
        doneCount.value++
        continue
      }
      prevJpeg = jpeg
      const filePath = path.join(tempDir, `p${partIndex}_kf_${String(i).padStart(5, '0')}.jpg`)
      // 离屏缓冲按显示器 DPI 放大（如 175% → 2242×1262），保留原分辨率落盘，
      // 合成阶段由 ffmpeg lanczos 高质量缩回 720p，比 NativeImage 缩放更锐
      await fs.writeFile(filePath, jpeg)
      files.push(filePath)
      keptTimes.push(chunk[i])
      doneCount.value++
      if (doneCount.value % 5 === 0 || doneCount.value === totalFrames) {
        sendProgress(sender, {
          phase: 'render',
          percent: Math.round((doneCount.value / totalFrames) * 100),
          message: `渲染播放页 ${doneCount.value}/${totalFrames} 帧`,
        })
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    const idx = job.windows.indexOf(win)
    if (idx >= 0) job.windows.splice(idx, 1)
  }
  return { files, times: keptTimes }
}

async function captureWithParts(
  job: MvExportJob,
  payload: MvExportPayload,
  times: number[],
  duration: number,
  tempDir: string,
  coverDataUrl: string,
  parts: number,
  sender: Electron.WebContents | null,
): Promise<{ files: string[]; times: number[] }> {
  // 按时间序切连续片段，各窗负责一段；全局帧序 = 片段序拼接
  const chunkSize = Math.ceil(times.length / parts)
  const doneCount = { value: 0 }
  const workers: Promise<{ files: string[]; times: number[] }>[] = []
  for (let p = 0; p < parts; p++) {
    const chunk = times.slice(p * chunkSize, (p + 1) * chunkSize)
    if (chunk.length) workers.push(captureChunkWorker(job, payload, duration, p, chunk, tempDir, coverDataUrl, sender, doneCount, times.length))
  }
  const results = await Promise.all(workers)
  const files: string[] = []
  const keptTimes: number[] = []
  for (const r of results) {
    files.push(...r.files)
    keptTimes.push(...r.times)
  }
  if (!files.length) throw new Error('未捕获到任何关键帧')
  return { files, times: keptTimes }
}

async function captureFrames(
  job: MvExportJob,
  payload: MvExportPayload,
  times: number[],
  duration: number,
  tempDir: string,
  sender: Electron.WebContents | null,
): Promise<{ files: string[]; times: number[] }> {
  const coverDataUrl = await fetchCoverDataUrl(payload.coverUrl)
  const parts = Math.min(MAX_PARALLEL_WINDOWS, Math.max(1, Math.ceil(times.length / FRAMES_PER_WORKER)))
  try {
    try {
      return await captureWithParts(job, payload, times, duration, tempDir, coverDataUrl, parts, sender)
    } catch (e) {
      if (job.cancelRequested) throw new Error('已取消')
      if (parts === 1) throw e
      // 多窗异常（GPU 争用/资源不足等）回退单窗重试一次
      console.warn(`[mvExport] ${parts}-window capture failed, retry single window:`, e)
      return await captureWithParts(job, payload, times, duration, tempDir, coverDataUrl, 1, sender)
    }
  } finally {
    for (const w of job.windows.splice(0)) {
      try { if (!w.isDestroyed()) w.destroy() } catch { /* 已销毁 */ }
    }
  }
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

function validateExportPayload(payload: MvExportPayload): string | null {
  if (!payload || typeof payload.audioUrl !== 'string' || !payload.audioUrl) return '缺少音频地址'
  // 音频/封面直链只允许 http(s)（渲染层被攻破时不至于 spawn 任意协议）
  if (!/^https?:\/\//i.test(payload.audioUrl)) return '音频地址协议不合法'
  if (payload.coverUrl && !/^https?:\/\//i.test(payload.coverUrl)) return '封面地址协议不合法'
  // 输出目录：绝对路径且无空字节/回跳（与 markFolderPurpose 的加固同一防线思路）
  if (payload.outputDir != null) {
    if (typeof payload.outputDir !== 'string' || !path.isAbsolute(payload.outputDir)) return '输出目录不合法'
    if (payload.outputDir.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(payload.outputDir)) return '输出目录不合法'
  }
  return null
}

async function runExport(payload: MvExportPayload, sender: Electron.WebContents | null, job: MvExportJob): Promise<{ filePath: string }> {
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
  job.tempDir = tempDir

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

    // 时长确定：渲染层 track.duration 可能为 0（如 avid/cid 回退源），以音频实测为准。
    // 探测也拿不到时显式报错中止（修复6）：旧的 max(1,…) 静默兜底会把分钟级音频截成 1 秒成片
    let duration = payload.duration || 0
    if (duration < 1) {
      const probed = await probeDuration(audioPath)
      if (probed > 0) duration = probed
    }
    if (duration < 1) throw new Error('无法确定音频时长（入参缺失且探测失败），已中止导出')

    // 2. 真实 UI 逐帧捕获（按流畅度档位定步长，K 窗并行）
    const preset = SMOOTHNESS_PRESETS[payload.smoothness || ''] || SMOOTHNESS_PRESETS[DEFAULT_SMOOTHNESS]
    const times = buildCaptureTimes(payload.lyrics, duration, preset.step, preset.maxFrames)
    const { files: frames, times: keptTimes } = await captureFrames(job, payload, times, duration, tempDir, sender)

    // 3. 单遍合成：concat demuxer 按 duration 拼帧 → 一次编码（O(N)，无 overlay 链）
    await writeConcatList(frames, keptTimes, duration, path.join(tempDir, 'list.txt'))
    await composeVideo(path.join(tempDir, 'list.txt'), audioPath, outputPath, duration, sender)

    sendProgress(sender, { phase: 'done', percent: 100, filePath: outputPath })
    return { filePath: outputPath }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    if (currentJob === job) currentJob = null
  }
}

export function registerMvExportHandlers() {
  ipcMain.handle('mv:exportSingle', async (event, payload: MvExportPayload, ownerTag?: string) => {
    if (currentJob) {
      return { ok: false, message: '已有导出任务进行中' }
    }
    const invalid = validateExportPayload(payload)
    if (invalid) return { ok: false, message: invalid }
    // job 在任何 await 之前同步登记：原实现 currentJob 赋值落在 runExport 内两次 mkdir 之后，
    // 检查-赋值窗口期内第二个 invoke 可并发通过守卫（且 runFfmpeg 绑定全局 job 会杀错进程）
    const job: MvExportJob = { ownerTag: ownerTag || null, cancelRequested: false, windows: [] }
    currentJob = job
    try {
      const { filePath } = await runExport(payload, event.sender, job)
      return { ok: true, filePath }
    } catch (e) {
      // 取消路径下离屏窗口被 destroy，循环内调用会以「Object has been destroyed」冒泡，归一为「已取消」。
      // 用局部引用判断（修复3）：runExport 的 finally 先于本 catch 执行并把全局 currentJob 置 null，
      // 读全局恒 false，渲染阶段取消会把英文原文错误抛给用户
      const raw = e instanceof Error ? e.message : String(e)
      const message = job.cancelRequested && raw.includes('Object has been destroyed') ? '已取消' : raw
      console.warn('[mvExport] export failed:', message)
      if (message !== '已取消') {
        // 失败与完成分离（修复7）：不再发 phase:'done'/percent:100，批量侧不会把失败瞬间当 100%
        sendProgress(event.sender, { phase: 'error', percent: 0, message })
      }
      return { ok: false, message }
    } finally {
      if (currentJob === job) currentJob = null
    }
  })

  ipcMain.handle('mv:cancel', (_event, ownerTag?: string) => {
    if (!currentJob) return { ok: false }
    // ownerTag 隔离（修复1）：批量下载传 'batch'，只杀批量自己发起的任务，
    // 不再误杀并发中的无关单曲 MV 导出；无标签（单曲取消按钮）取消当前任务
    if (ownerTag != null && currentJob.ownerTag !== ownerTag) return { ok: false }
    currentJob.cancelRequested = true
    try { currentJob.proc?.kill() } catch { /* 已退出 */ }
    for (const w of currentJob.windows) {
      try { if (!w.isDestroyed()) w.destroy() } catch { /* 已销毁 */ }
    }
    return { ok: true }
  })
}

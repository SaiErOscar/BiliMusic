/**
 * 播放页 MV 视频导出（桌面端专属）
 *
 * 真实 UI 离屏渲染：隐藏窗口加载真实渲染层（打包 app://local / 开发 dev server），
 * 路由到 #/mv-export 导出态舞台（复用真实 NowPlaying 的 CSS 与 LyricsView/PlayerSlider
 * 组件与主题），主进程只按时间轴步进「当前播放时间」。进度条/时间数字/水印全部由
 * 真实组件画进帧内，ffmpeg 不做任何 drawbox/drawtext 叠画。
 *
 * v1.4.8-pre3 路径 A（帧获取与合成重写）：
 * - 帧源改为离屏窗口原生的 paint 事件。paint 触发即代表渲染器产出了一帧新画面，
 *   事件附带 NativeImage，因此不需要 capturePage 回读，也不需要「等双 rAF 再猜是否上屏」。
 * - 帧不再编 JPEG、不落盘，以 BGRA 直送 ffmpeg stdin，由 ffmpeg 一次完成缩放与编码，
 *   渲染与编码天然重叠。
 * - 时间轴按绝对时间量化到 60fps 输出帧（round(t*60)），同一张位图重复写入对应帧数；
 *   边界按绝对时间算，总帧数恒等于 round(duration*60)，不累积舍入误差。
 * - 未产生新画面（paint 超时）时该段帧数并入上一帧，语义等同旧的「相同帧合并」，
 *   但不再依赖字节比对，也就不存在把旧帧误判为静态帧的问题。
 * - 音频源是 AAC 时直接 -c:a copy，免二次编码并消掉编码器延迟。
 *
 * 编码器：候选按 GPU 厂商预判排序，仍以真实任务为探测（不做事前试编）；失败过的候选
 * 记入会话内缓存，同一进程内不再重试。libx264 保底。
 *
 * 进度：渲染按已写入帧数推进，编码按 ffmpeg `-progress pipe:1` 的 out_time 推进，
 * 两者取较大值，避免渲染先跑满而编码仍在追赶时进度虚高。
 */

import { ipcMain, BrowserWindow, net, app, nativeImage } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { resolveEncoderCandidates, classifyFfmpegFailure, type EncoderCandidate } from './encoders'
import { ANALYSIS_HZ, BAR_COUNT, SAMPLE_RATE, buildSpectrumTimelineAsync, encodeTimelineBase64 } from './spectrum'
import { COMPOSE_PERCENT, DONE_PERCENT, stagePercent } from './exportProgress'

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
  /**
   * v1.4.9-pre3 无控件导出（AppSettings.mvCleanExport）：true 时舞台隐藏进度条、
   * 时间、播放按钮、音量与循环控件，只留封面、歌曲信息、歌词与水印。
   */
  clean?: boolean
  /**
   * v1.4.10-pre1 音频可视化跟随（AppSettings.audioVisualizer）：true 时导出画面在封面下缘
   * 显示频谱柱状图。主进程会先对已下载音频做离线频谱分析，把整曲频谱时间线注入离屏舞台；
   * clean 为 true 时一律不显示（无控件导出不含可视化）。分析失败只降级为「无柱子」，不中断导出。
   */
  visualizer?: boolean
  /**
   * v1.4.11-pre2 封面取景（AppSettings.coverFit，与播放页共用）：
   * cover 裁切铺满 / contain 保持原比例 / fill 拉伸。缺省按 cover 处理，
   * 保证老版本渲染层或旧 payload 的取景行为不变。
   */
  coverFit?: string
  /** 流畅度档位（快速/标准/流畅/极致），缺省取标准 */
  smoothness?: string
  /** 自定义输出目录（下载目录），MV 落在其下 MV/ 子目录 */
  outputDir?: string
}

export interface MvExportProgress {
  /**
   * error：任务失败（与 done 分离，批量侧不会把失败当 100% 完成）；
   * analyze：v1.4.10-pre1 音频可视化的离线频谱分析（仅可视化开启时出现）。
   *
   * v1.4.10-pre2 起 percent 是全链路统一口径（见 electron/exportProgress.ts）：
   * 下载音频 0~9、分析音频 10~24、渲染播放页 25~98、合成视频 99、完成 100，
   * 任何阶段切换处都只前进不后退。
   */
  phase: 'audio' | 'analyze' | 'render' | 'compose' | 'done' | 'error'
  percent: number
  message?: string
  filePath?: string
}

const WIDTH = 1280
const HEIGHT = 720
/** 输出帧率（v1.4.8-pre1 定案 60） */
const FPS = 60
/**
 * 等 paint 的超时。超时代表该采样没有产生新画面（静态帧），按「并入上一帧」处理。
 * 取值兼顾慢机器：离屏软件渲染下单次绘制实测 13~16ms，250ms 足够覆盖抖动。
 */
const PAINT_TIMEOUT_MS = 250
/**
 * 流畅度档位（v1.4.7-pre1，步长为用户定案值）：网格步长即进度条/歌词的视觉更新粒度，
 * 上限封顶控制渲染耗时（超出自动放粗步长）。
 * 快速=0.15s、标准=0.1s（默认）、流畅=0.05s、极致=0.03s（v1.4.8-pre1 输出帧率提至 60fps，步长仍为最密网格）。
 */
const SMOOTHNESS_PRESETS: Record<string, { step: number; maxFrames: number }> = {
  '快速': { step: 0.15, maxFrames: 3600 },
  '标准': { step: 0.1, maxFrames: 4800 },
  '流畅': { step: 0.05, maxFrames: 6000 },
  '极致': { step: 0.03, maxFrames: 9000 },
}
const DEFAULT_SMOOTHNESS = '标准'
/**
 * v1.4.10-pre1：可视化开启时的采样网格步长上限（1/30 秒）。
 * 导出画面的柱子由时间索引预计算频谱，网格不加密就会以档位步长（标准档 0.1 秒、
 * 10Hz）跳变，与播放页的连续律动差得太远；加密到 1/30 后柱子约 33Hz 更新，观感接近。
 * 代价是采样点增多、导出耗时上升，因此只在可视化开启时生效。
 */
const VISUALIZER_STEP = 1 / ANALYSIS_HZ
/**
 * 可视化开启时的采样点上限（约 6.7 分钟曲目）。超长歌自动放粗步长，
 * 避免一份频谱把导出拖到不可接受的长度；此时柱子更新变慢但画面仍然正确。
 */
const VISUALIZER_MAX_FRAMES = 12000
/**
 * v1.4.10-pre2：PCM 解码上限（约 1 小时单声道 44100Hz 16bit，317MB）。
 * 异常输入不至于把主进程内存吃干；超限直接跳过可视化分析，导出照常完成。
 */
const PCM_MAX_BYTES = SAMPLE_RATE * 2 * 3600

/** 注入离屏舞台的频谱数据（主进程算好，渲染层只解码显示） */
interface StageSpectrum {
  base64: string
  hz: number
  bars: number
}
/** 封面降采样尺寸（CSS 显示 400px，高 DPI 留足余量） */
const COVER_SIZE = 800
/** 会话内失败的编码器：同一进程内不再重试，避免每次导出都白跑一遍捕获 */
const failedEncoders = new Set<string>()

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
  /** 当前存活的离屏窗口（编码器回退时会重建，取消时逐个销毁） */
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

interface EncoderPipe {
  stdin: NodeJS.WritableStream
  /** ffmpeg 退出即结算；非 0 退出以错误 reject */
  done: Promise<void>
  /** 管道写入错误（编码器中途失败时 EPIPE 会走这里，不能让它变成未捕获异常） */
  getError: () => Error | null
}

/**
 * 启动一个流式编码进程（rawvideo 从 stdin 进）。编码器仍以真实任务为探测，
 * 候选由 GPU 厂商预判给出（encoders.ts），失败回退下一个，libx264 保底。
 */
function spawnEncoder(args: string[], onOutTime?: (seconds: number) => void): EncoderPipe {
  const proc = trackChild(spawn(ffmpegPath, args, { windowsHide: true }))
  if (currentJob) currentJob.proc = proc
  let stderr = ''
  let pipeError: Error | null = null
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024)
  })
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (!onOutTime) return
    // -progress 输出形如 out_time_ms=1234567（实为微秒）
    for (const m of chunk.toString().matchAll(/out_time_ms=(\d+)/g)) onOutTime(Number(m[1]) / 1e6)
  })
  // 编码器中途失败时写入会 EPIPE；必须常驻监听，否则 Node 以未捕获异常崩主进程
  proc.stdin?.on('error', (err) => { pipeError = err })
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', (err) => reject(new Error(`ffmpeg 启动失败: ${err.message}. ffmpegPath=${ffmpegPath}`)))
    proc.on('exit', (code) => {
      if (currentJob?.cancelRequested) reject(new Error('已取消'))
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg 失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
  return { stdin: proc.stdin as NodeJS.WritableStream, done, getError: () => pipeError }
}

/** 读媒体时长与音频编码（秒/编码名）；失败返回 0 与空串 */
function probeMedia(filePath: string): Promise<{ duration: number; audioCodec: string }> {
  return new Promise((resolve) => {
    try {
      const proc = trackChild(spawn(ffmpegPath, ['-i', filePath, '-t', '0.2', '-f', 'null', '-'], { windowsHide: true }))
      let stderr = ''
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
      proc.on('error', () => resolve({ duration: 0, audioCodec: '' }))
      // 退出码非 0 是预期的（无输出文件），从 stderr 的 Duration= 与 Stream 行解析
      proc.on('exit', () => {
        const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
        const a = stderr.match(/Audio:\s*([a-z0-9_]+)/i)
        resolve({ duration, audioCodec: a ? a[1].toLowerCase() : '' })
      })
    } catch {
      resolve({ duration: 0, audioCodec: '' })
    }
  })
}

/**
 * v1.4.10-pre1：把已下载的音频解成 44100Hz 单声道 16bit PCM，供离线频谱分析。
 * ffmpeg 直出到 stdout，中途可用取消中断（与下载同一套取消语义）。
 *
 * v1.4.10-pre2 修正两点：
 * 1. 子进程登记到 `job.proc`。此前只进了 childProcesses 集合（仅 will-quit 统一清理），
 *    `mv:cancel` 杀不到它，在「分析音频」阶段点取消要等整曲解码完才生效。
 * 2. 去掉多余的一份缓冲区拷贝。原实现 Buffer.concat → ArrayBuffer.slice → Int16Array，
 *    峰值同时存在三份整曲 PCM；现在能直接对齐视图就复用 concat 的缓冲区，
 *    只有字节偏移为奇数（池化分配）时才退回拷贝。
 */
function decodePcm(audioPath: string, job: MvExportJob): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = trackChild(spawn(ffmpegPath, [
        '-hide_banner', '-nostats',
        '-i', audioPath,
        '-vn',
        '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-',
      ], { windowsHide: true }))
    } catch (e) {
      reject(new Error(`ffmpeg 解音频失败: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    // 取消要能中断解码：与 spawnEncoder 同一约定，mv:cancel 通过 job.proc 杀进程
    job.proc = proc
    const chunks: Buffer[] = []
    let stderr = ''
    let total = 0
    let tooLong = false
    proc.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      // 防御性上限（约 1 小时单声道 PCM）：异常输入不至于把内存吃干
      if (total > PCM_MAX_BYTES) {
        tooLong = true
        try { proc.kill() } catch { /* 已退出 */ }
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8192) stderr = stderr.slice(-4096)
    })
    proc.on('error', (err) => reject(new Error(`ffmpeg 解音频失败: ${err.message}`)))
    proc.on('exit', (code) => {
      if (job.cancelRequested) { reject(new Error('已取消')); return }
      // 超长音频是被我们主动 kill 的，报「ffmpeg 解音频失败」会误导排查方向
      if (tooLong) { reject(new Error('音频过长（超过 1 小时），已跳过可视化分析')); return }
      if (code !== 0) { reject(new Error(`ffmpeg 解音频失败 (exit ${code}): ${stderr.slice(-300)}`)); return }
      const buf = Buffer.concat(chunks, total)
      // 拷贝已经发生，及时放掉分块引用，避免整曲 PCM 在分析期间被多留一份
      chunks.length = 0
      // Int16Array 要求偶数长度与对齐的缓冲区，末尾奇数字节直接丢弃（不足一个样本）
      const usable = buf.length - (buf.length % 2)
      if (usable <= 0) { reject(new Error('ffmpeg 解音频未产出样本')); return }
      if (buf.byteOffset % 2 === 0) {
        // 对齐时直接开视图，不再复制
        resolve(new Int16Array(buf.buffer, buf.byteOffset, usable / 2))
        return
      }
      resolve(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable)))
    })
  })
}

/**
 * 生成频谱时间线（仅可视化开启时调用）。
 * 失败一律降级为 null：导出继续，成片没有柱子，绝不因为可视化把整条链路弄挂。
 */
async function buildStageSpectrum(
  audioPath: string,
  job: MvExportJob,
  sender: Electron.WebContents | null,
): Promise<StageSpectrum | null> {
  try {
    const pcm = await decodePcm(audioPath, job)
    if (job.cancelRequested) throw new Error('已取消')
    const timeline = await buildSpectrumTimelineAsync(pcm, {
      onProgress: (frames, totalFrames) => {
        // 分片让出期间检查取消：分析是 CPU 密集的同步段，靠这里把取消传进去
        if (job.cancelRequested) throw new Error('已取消')
        if (frames % 60 === 0 || frames === totalFrames) {
          sendProgress(sender, {
            phase: 'analyze',
            percent: stagePercent('analyze', frames / Math.max(1, totalFrames)),
            message: '分析音频',
          })
        }
      },
    })
    return { base64: encodeTimelineBase64(timeline), hz: ANALYSIS_HZ, bars: BAR_COUNT }
  } catch (e) {
    if (job.cancelRequested) throw e
    console.warn('[mvExport] 频谱分析失败，导出将不含音频可视化:', e instanceof Error ? e.message : e)
    return null
  }
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
          // v1.4.8-pre5 修复：等待 drain 必须与流错误/关闭赛跑。原实现只挂 once('drain')，
          // 磁盘满或权限被收回时 write() 返回 false 后 drain 永不触发，导出会无限挂起
          // （取消检查在循环顶部，而这里 await 不返回，取消也无法生效）。
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              writeStream.off('drain', onDrain)
              writeStream.off('error', onStreamError)
              writeStream.off('close', onClose)
            }
            const onDrain = () => { cleanup(); resolve() }
            const onStreamError = (err: Error) => { cleanup(); reject(err) }
            const onClose = () => { cleanup(); reject(streamError ?? new Error('音频写入流已关闭')) }
            writeStream.once('drain', onDrain)
            writeStream.once('error', onStreamError)
            writeStream.once('close', onClose)
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
    // 失败/取消时释放 HTTP 响应体，避免连接与缓冲区悬挂到 GC
    void reader.cancel().catch(() => {})
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
    const size = img.getSize()
    // v1.4.9-pre3 修复：原实现 resize({ width: COVER_SIZE, height: COVER_SIZE }) 把任意
    // 比例的封面强拉成正方形——B 站封面多为 16:9，导出画面里人物与文字明显被压扁。
    // 现在按原图长边等比缩放到 COVER_SIZE 上限，宽高各自按原比例换算，绝不改变宽高比；
    // 取景交给舞台的 object-fit: cover（v1.4.10-pre3 起，与播放页一致：1:1 裁切铺满），
    // 这里保持原比例即可，裁切是显示层的事。
    const scale = Math.min(1, COVER_SIZE / Math.max(size.width, size.height))
    const targetW = Math.max(1, Math.round(size.width * scale))
    const targetH = Math.max(1, Math.round(size.height * scale))
    const resized = scale < 1 ? img.resize({ width: targetW, height: targetH, quality: 'good' }) : img
    const jpeg = resized.toJPEG(90)
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

/**
 * 等待离屏窗口的下一次 paint。paint 触发即代表渲染器产出了一帧新画面，
 * 事件附带的图像就是该次状态对应的帧，不需要再比对版本号或字节。
 * 超时返回 null，调用方按「该采样没有产生新画面」处理。
 */
function waitNextPaint(win: BrowserWindow, timeoutMs: number): Promise<Electron.NativeImage | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (image: Electron.NativeImage | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        if (!win.isDestroyed()) win.webContents.off('paint', onPaint)
      } catch { /* 窗口已销毁 */ }
      resolve(image)
    }
    const onPaint = (_event: Electron.Event, _dirty: Electron.Rectangle, image: Electron.NativeImage) => finish(image)
    const timer = setTimeout(() => finish(null), timeoutMs)
    win.webContents.on('paint', onPaint)
  })
}

/** 步进时间并等待该次状态对应的 paint 帧；超时返回 null */
async function captureAt(win: BrowserWindow, t: number): Promise<Electron.NativeImage | null> {
  // 监听必须先挂上：paint 是同步回调，挂在 executeJavaScript 之后可能漏掉本次帧
  const pending = waitNextPaint(win, PAINT_TIMEOUT_MS)
  await win.webContents.executeJavaScript(`window.__mvSetTime(${t.toFixed(3)})`)
  return pending
}

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
  win.webContents.setFrameRate(FPS)
  return win
}

/** 加载导出舞台并等待字体/封面就绪；返回窗口与就绪时的稳定帧（即 t=0 的首帧） */
async function openStage(
  job: MvExportJob,
  payload: MvExportPayload,
  duration: number,
  coverDataUrl: string,
  spectrum: StageSpectrum | null,
): Promise<{ win: BrowserWindow; settledFrame: Electron.NativeImage | null }> {
  const win = createCaptureWindow(job)
  try {
    await win.loadURL(resolveStageUrl())
    await win.webContents.executeJavaScript(
      `window.__mvInit(${JSON.stringify(JSON.stringify({
        title: payload.title,
        artist: payload.artist,
        cover: coverDataUrl,
        duration,
        startTime: 0,
        lyrics: payload.lyrics,
        watermark: payload.watermark,
        // v1.4.9-pre3 无控件导出：舞台据此隐藏进度条/时间/播放按钮/音量/循环
        clean: payload.clean === true,
        // v1.4.10-pre1 音频可视化：舞台据此在封面下缘画频谱柱（clean 时不传，等于不显示）
        visualizer: payload.visualizer === true && payload.clean !== true,
        // v1.4.11-pre2 封面取景：归一成三个合法值之一，脏值退回 cover（= 已发布行为）
        coverFit: payload.coverFit === 'contain' || payload.coverFit === 'fill' ? payload.coverFit : 'cover',
        spectrum: spectrum?.base64,
        spectrumHz: spectrum?.hz,
        spectrumBars: spectrum?.bars,
      }))})`,
    )
    const readyDeadline = Date.now() + 20_000
    for (;;) {
      if (job.cancelRequested || win.isDestroyed()) throw new Error('已取消')
      if (await win.webContents.executeJavaScript('window.__mvReady === true')) break
      if (Date.now() > readyDeadline) throw new Error('导出页面加载超时')
      await sleep(120)
    }
    // 首屏入场是静态的，先强制重绘并等这一帧：它同时就是 t=0 的首帧
    // （舞台初始 time 为 0，再调 __mvSetTime(0) 不会触发重绘）。
    // 监听必须先挂上再 invalidate，否则同步触发的 paint 会被漏掉
    const pending = waitNextPaint(win, 500)
    win.webContents.invalidate()
    let settledFrame = await pending
    if (!settledFrame) {
      const retry = waitNextPaint(win, 500)
      win.webContents.invalidate()
      settledFrame = await retry
    }
    if (!settledFrame) {
      // 最后兜底：单次回读。仅首帧走这条路，逐帧路径仍全部走 paint
      const img = await win.webContents.capturePage()
      settledFrame = img && !img.isEmpty() ? img : null
    }
    return { win, settledFrame }
  } catch (e) {
    // v1.4.8-pre5 修复：窗口在 createCaptureWindow 时已登记进 job.windows。
    // 此处抛错（加载失败/就绪超时/取消）若不回收，runExport 结束后 currentJob 置 null，
    // 再没有任何路径能销毁它，隐藏的离屏渲染进程会泄漏到应用退出。
    try { if (!win.isDestroyed()) win.destroy() } catch { /* 已销毁 */ }
    const idx = job.windows.indexOf(win)
    if (idx >= 0) job.windows.splice(idx, 1)
    throw e
  }
}

/**
 * 捕获 + 流式编码：paint 事件取帧，BGRA 直送 ffmpeg stdin，渲染与编码重叠。
 * 时间轴按绝对时间量化到 60fps（round(t*60)），同一张位图重复写入对应帧数，
 * 总帧数恒等于 round(duration*60)，歌词切换落点误差不超过半帧。
 */
async function captureAndEncode(
  job: MvExportJob,
  payload: MvExportPayload,
  times: number[],
  duration: number,
  audioPath: string,
  audioArgs: string[],
  coverDataUrl: string,
  spectrum: StageSpectrum | null,
  outputPath: string,
  candidate: EncoderCandidate,
  sender: Electron.WebContents | null,
): Promise<void> {
  const { win, settledFrame } = await openStage(job, payload, duration, coverDataUrl, spectrum)
  let pipe: EncoderPipe | null = null
  try {
    const frameAt = (t: number) => Math.round(t * FPS)
    const totalFrames = Math.max(1, frameAt(duration))

    // 每个采样负责的输出帧数：边界按绝对时间量化，末段补到总帧数
    const plan: { time: number; copies: number }[] = []
    for (let i = 0; i < times.length; i++) {
      const start = frameAt(times[i])
      const end = i + 1 < times.length ? frameAt(times[i + 1]) : totalFrames
      const copies = end - start
      if (copies > 0) plan.push({ time: times[i], copies })
    }
    if (!plan.length) throw new Error('捕获时间轴为空')

    // 先取首帧：编码器的 -s 必须与实际离屏缓冲尺寸一致（DPI 缩放后常为 2242×1262）。
    // t=0 的首帧用就绪时的稳定帧，因为舞台本来就停在 0，重复步进不会触发重绘
    const firstImage = plan[0].time <= 0 && settledFrame && !settledFrame.isEmpty()
      ? settledFrame
      : await captureAt(win, plan[0].time)
    if (!firstImage || firstImage.isEmpty()) throw new Error('首帧未产生（舞台未渲染）')
    const { width, height } = firstImage.getSize()
    const expectBytes = width * height * 4

    const label = candidate.codec === 'libx264' ? '合成视频' : `合成视频（${candidate.codec.replace('h264_', '').toUpperCase()}）`
    const encoder = spawnEncoder([
      '-y', '-hide_banner', '-nostats',
      // 位图来自 NativeImage.toBitmap()，Skia 原生 N32 在小端平台即 BGRA
      '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-r', String(FPS), '-i', '-',
      '-i', audioPath,
      '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
      '-map', '0:v', '-map', '1:a',
      '-c:v', candidate.codec, ...candidate.qualityArgs,
      ...audioArgs,
      '-t', duration.toFixed(3),
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      outputPath,
    ])
    pipe = encoder

    // 编码器可能中途失败（QSV 实测 device failed -17）：必须接管 done 的拒绝，
    // 否则无人 await 会变成未捕获拒绝；同时让写循环能立刻感知失败退出
    let encoderError: Error | null = null
    encoder.done.catch((e) => { encoderError = e instanceof Error ? e : new Error(String(e)) })

    let written = 0
    let lastBitmap: Buffer | null = null
    for (let i = 0; i < plan.length; i++) {
      if (job.cancelRequested || win.isDestroyed()) throw new Error('已取消')
      if (encoderError) throw encoderError
      const pipeErr = encoder.getError()
      if (pipeErr) {
        // 管道已断（通常是编码器先退出），稍等退出事件以拿到真实错误再抛
        await Promise.race([encoder.done.catch(() => {}), sleep(2000)])
        throw encoderError ?? pipeErr
      }

      const item = plan[i]
      let bitmap: Buffer | null = null
      if (i === 0) {
        bitmap = firstImage.toBitmap()
      } else {
        const image = await captureAt(win, item.time)
        bitmap = image && !image.isEmpty() ? image.toBitmap() : null
      }

      if (bitmap) {
        if (bitmap.length !== expectBytes) {
          throw new Error(`帧尺寸不一致：位图 ${bitmap.length} 字节，期望 ${expectBytes}（${width}×${height}）`)
        }
        lastBitmap = bitmap
      } else {
        // 该采样没有产生新画面（paint 超时），沿用上一帧，帧数并入上一段
        if (!lastBitmap) throw new Error('未捕获到任何可用的帧')
        bitmap = lastBitmap
      }

      for (let c = 0; c < item.copies; c++) {
        if (!encoder.stdin.write(bitmap)) {
          // 背压等待必须与编码器退出赛跑：ffmpeg 退出后 stdin 被销毁，drain 永不触发，
          // 单纯 await drain 会把导出挂死（实测挂到超时）
          await Promise.race([
            new Promise<void>((resolve) => encoder.stdin.once('drain', resolve)),
            encoder.done.catch(() => {}),
          ])
        }
      }
      written += item.copies
      if (written % 5 === 0 || written >= totalFrames) {
        sendProgress(sender, {
          phase: 'render',
          percent: stagePercent('render', written / totalFrames),
          message: `渲染播放页 ${written}/${totalFrames} 帧`,
        })
      }
    }

    // v1.4.8-pre4 进度显示：编码与渲染是重叠进行的，若同时上报「合成视频」的百分比，
    // 界面会在两个阶段文案之间反复跳动。这里帧全部写完后才切到合成阶段，
    // 进度停在 99% 直到出片，文案与进度条都保持连贯。
    encoder.stdin.end()
    sendProgress(sender, { phase: 'compose', percent: COMPOSE_PERCENT, message: label })
    await encoder.done
  } finally {
    if (pipe) {
      try { pipe.stdin.end() } catch { /* 已结束 */ }
    }
    if (!win.isDestroyed()) win.destroy()
    const idx = job.windows.indexOf(win)
    if (idx >= 0) job.windows.splice(idx, 1)
  }
}

/**
 * 编码器候选循环：真实任务即探测，失败记入会话内缓存。
 * 流式管道的代价是候选失败要重新捕获，所以缓存比 JPEG 时代更重要。
 * 捕获阶段的错误与编码器无关，直接抛出，不再换候选重跑。
 */
async function encodeWithFallback(
  job: MvExportJob,
  payload: MvExportPayload,
  times: number[],
  duration: number,
  audioPath: string,
  audioArgs: string[],
  coverDataUrl: string,
  spectrum: StageSpectrum | null,
  outputPath: string,
  sender: Electron.WebContents | null,
): Promise<void> {
  const all = await resolveEncoderCandidates(process.platform)
  const candidates = all.filter((c) => !failedEncoders.has(c.codec))
  if (!candidates.length) throw new Error('没有可用编码器（本次会话内候选均已失败），请重启应用后重试')
  let lastError = ''
  for (const candidate of candidates) {
    if (job.cancelRequested) throw new Error('已取消')
    try {
      await captureAndEncode(job, payload, times, duration, audioPath, audioArgs, coverDataUrl, spectrum, outputPath, candidate, sender)
      return
    } catch (e) {
      if (job.cancelRequested) throw e
      lastError = e instanceof Error ? e.message : String(e)
      // v1.4.8-pre5：按失败性质决定「中止 / 换候选 / 换候选并拉黑」。
      // 原实现只看消息是否以 ffmpeg 开头就拉黑，磁盘满与坏音频也会被当成编码器不可用，
      // 一次即可把硬件编码器与 libx264 先后写进会话缓存，导致本次进程内导出全废。
      const kind = classifyFfmpegFailure(lastError)
      const fromEncoder = lastError.startsWith('ffmpeg') || kind === 'encoder'
      if (!fromEncoder) throw e
      if (kind === 'fatal') throw e
      if (kind === 'encoder') {
        failedEncoders.add(candidate.codec)
        console.warn(`[mvExport] encoder ${candidate.codec} unavailable, falling back:`, lastError)
      } else {
        // 无法归类：换候选再试一次，但不写会话缓存（可能只是一次性环境问题）
        console.warn(`[mvExport] encoder ${candidate.codec} failed (unclassified), retry next:`, lastError)
      }
    }
  }
  throw new Error(`视频合成失败（已尝试全部编码器）：${lastError}`)
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
  // v1.4.10-pre1：visualizer 只接受布尔/undefined，避免脏类型让「是否分析音频」的判断漂移
  if (payload.visualizer != null && typeof payload.visualizer !== 'boolean') return '可视化标志不合法'
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
      // v1.4.10-pre2：下载音频只占整条链路的前 10%，不再按 0~100 上报，
      // 否则紧接着的分析/渲染阶段从 0 起算会让进度条回退。
      const percent = stagePercent('audio', p / 100)
      if (percent !== lastPercent) {
        lastPercent = percent
        sendProgress(sender, { phase: 'audio', percent, message: '下载音频' })
      }
    })

    // 2. 时长与音频编码：时间尺统一以实测音频长度为准（B 站元数据与真实音频不一致时，
    //    网格、-t 与舞台进度条会各走一尺，歌词越往后偏得越多）。探测失败才回退入参，
    //    两者都拿不到仍显式报错中止（旧的 max(1,…) 静默兜底会把分钟级音频截成 1 秒成片）
    const media = await probeMedia(audioPath)
    const duration = media.duration > 0 ? media.duration : (payload.duration || 0)
    if (duration < 1) throw new Error('无法确定音频时长（探测失败且入参缺失），已中止导出')
    // 音频直通：源本身是 AAC 就 -c:a copy，免二次编码并消掉 AAC 编码器延迟
    const audioArgs = media.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']

    // 3. v1.4.10-pre1 音频可视化：开启且非无控件导出时，先对已下载音频做离线频谱分析。
    //    失败只降级为「成片无柱子」，不中断导出（buildStageSpectrum 内部吞错返回 null）。
    const visualizerOn = payload.visualizer === true && payload.clean !== true
    const spectrum = visualizerOn ? await buildStageSpectrum(audioPath, job, sender) : null

    // 4. 逐帧捕获 + 流式编码（渲染与编码重叠，编码器失败自动回退下一候选）
    const preset = SMOOTHNESS_PRESETS[payload.smoothness || ''] || SMOOTHNESS_PRESETS[DEFAULT_SMOOTHNESS]
    // 可视化开启时网格加密到 1/30：柱子由时间索引预计算频谱，网格不加密就退成档位步长的
    // 幻灯片（标准档 10Hz），与播放页的连续律动差太远。超长歌由 maxFrames 上限自动放粗步长。
    const step = spectrum ? Math.min(preset.step, VISUALIZER_STEP) : preset.step
    const maxFrames = spectrum ? Math.max(preset.maxFrames, VISUALIZER_MAX_FRAMES) : preset.maxFrames
    const times = buildCaptureTimes(payload.lyrics, duration, step, maxFrames)
    const coverDataUrl = await fetchCoverDataUrl(payload.coverUrl)
    await encodeWithFallback(job, payload, times, duration, audioPath, audioArgs, coverDataUrl, spectrum, outputPath, sender)

    sendProgress(sender, { phase: 'done', percent: DONE_PERCENT, filePath: outputPath })
    return { filePath: outputPath }
  } catch (e) {
    // v1.4.8-pre5 修复：失败或取消时清掉半成品 mp4。ffmpeg 以 -y 直接写目标文件，
    // 中途退出会留下不可播放的残片；下次同名导出会因 existsSync 改名为 (2)，
    // 残片永久留在 MV 目录且不被任何下载记录引用。
    await fs.rm(outputPath, { force: true }).catch(() => {})
    throw e
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

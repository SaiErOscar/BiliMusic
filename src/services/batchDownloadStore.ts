// 模块级批量下载任务管理
// 下载任务在模块作用域运行，不依赖组件生命周期：
// - 隐藏对话框后下载继续在后台进行
// - 重新打开对话框时恢复显示进度
// - 支持取消（当前文件下载完成后停止后续）
import { downloadTrack } from '@/services/api'
import { platform } from '@/platform'
import { cleanTitle, getLyricForTrack, formatLrc } from '@/services/lyrics'
import { exportTrackMv, cancelMvExport } from '@/services/mvExport'
import { loadAppSettings, saveDownloadRecord } from '@/utils/storage'
import type { Track, DownloadFormat } from '@/types'

export type NameMode = 'video' | 'song' | 'custom'

/** v1.4.6：批量任务格式在音频/视频之外新增 'mv'（导出播放界面 MP4，桌面端专属） */
export type BatchFormat = DownloadFormat | 'mv'

export interface BatchConfig {
  format: BatchFormat
  downloadDir: string
  includeLyric: boolean
  embedMeta: boolean
  nameMode: NameMode
  customName: string
}

export interface BatchProgress {
  current: number
  total: number
  trackTitle: string
  status: 'pending' | 'downloading' | 'done' | 'error'
  error?: string
  /** 当前文件下载字节进度（audio 格式经 onDownloadProgress 实时更新；mv 格式为分阶段进度百分比） */
  fileReceived?: number
  fileTotal?: number
  filePercent?: number
  /** v1.4.6 mv 格式：当前文件内阶段说明（下载音频/渲染关键帧/合成视频） */
  filePhase?: string
}

/** 单个失败曲目的错误信息，供 UI 展示具体失败原因 */
export interface BatchError {
  title: string
  message: string
}

interface BatchDownloadState {
  running: boolean
  visible: boolean
  started: boolean
  tracks: Track[]
  config: BatchConfig | null
  progress: BatchProgress | null
  completedCount: number
  errorCount: number
  errors: BatchError[]
}

let state: BatchDownloadState = {
  running: false,
  visible: false,
  started: false,
  tracks: [],
  config: null,
  progress: null,
  completedCount: 0,
  errorCount: 0,
  errors: [],
}

// 取消标志：置 true 后，当前文件下载完成后停止后续
let cancelled = false

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

export function batchSubscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getBatchState(): BatchDownloadState {
  return state
}

function setState(patch: Partial<BatchDownloadState>) {
  state = { ...state, ...patch }
  emit()
}

function getFilename(config: BatchConfig, track: Track, index: number): string {
  if (config.nameMode === 'song') {
    return cleanTitle(track.title) || track.title
  }
  if (config.nameMode === 'custom' && config.customName.trim()) {
    return config.customName
      .replace(/\{title\}/g, track.title)
      .replace(/\{artist\}/g, track.artist || '')
      .replace(/\{index\}/g, String(index).padStart(2, '0'))
      .trim()
  }
  return track.title
}

/** 开始批量下载 */
export function startBatchDownload(tracks: Track[], config: BatchConfig) {
  state = {
    ...state,
    tracks,
    config,
    running: true,
    visible: true,
    started: true,
    progress: null,
    completedCount: 0,
    errorCount: 0,
    errors: [],
  }
  cancelled = false
  emit()
  void run()
}

async function run() {
  const { tracks, config } = state
  if (!config) return
  const dir = config.downloadDir || undefined
  const qualityPref = 'lossless'
  const isMv = config.format === 'mv'
  const appSettings = loadAppSettings()

  // 订阅主进程单文件下载字节进度（audio 格式有实时回调），写回当前 progress；
  // mv 格式改为消费 exportTrackMv 的分阶段进度回调（订阅在导出调用内完成）
  const unsubProgress = isMv
    ? undefined
    : platform.download?.onDownloadProgress?.(
        ({ received, total, percent }) => {
          if (!state.running || !state.progress) return
          setState({
            progress: {
              ...state.progress,
              fileReceived: received,
              fileTotal: total,
              filePercent: percent,
            },
          })
        },
      )

  try {
    for (let i = 0; i < tracks.length; i++) {
      if (cancelled) break
      const track = tracks[i]
      setState({
        progress: {
          current: i + 1,
          total: tracks.length,
          trackTitle: track.title,
          status: 'downloading',
        },
      })

      try {
        let lyricContent: string | undefined
        let artist: string | undefined

        // mv 格式不需要歌词（画面内已按时间轴渲染）；跳过省一次匹配请求
        if (!isMv && (config.embedMeta || config.includeLyric)) {
          const lyricResult = await getLyricForTrack(track)
          // v1.4.5：用户选「不显示歌词」→ 命中 none 态，无论开关都不下载歌词、不写歌手
          if (lyricResult && !lyricResult.noLyric) {
            if (config.embedMeta && lyricResult.artistName) {
              artist = lyricResult.artistName
            }
            if (config.includeLyric && lyricResult.lines.length > 0) {
              lyricContent = formatLrc(lyricResult)
            }
          }
        }

        const filename = getFilename(config, track, i + 1)

        if (isMv) {
          // v1.4.6：批量导出播放界面 MV（桌面端专属；入口已在 UI 层按平台裁剪）
          const { filePath: mvPath } = await exportTrackMv(track, {
            quality: qualityPref,
            watermark: appSettings.mvWatermark,
            outputDir: dir,
            onProgress: (p) => {
              if (!state.running || !state.progress) return
              setState({
                progress: {
                  ...state.progress,
                  filePercent: p.phase === 'done' ? 100 : p.percent,
                  filePhase: p.message || '',
                },
              })
            },
          })
          // 记录与实际产物对齐：MV 落在 <dir>/MV/<名>.mp4，主进程同名防覆盖可能带序号
          const mvName = mvPath.split(/[\\/]/).pop() || filename
          const mvDir = mvPath.slice(0, mvPath.length - mvName.length - 1).replace(/\//g, '\\')
          saveDownloadRecord({
            id: crypto.randomUUID ? crypto.randomUUID() : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            title: filename,
            artist: artist || track.artist || '',
            bvid: track.bvid || track.id,
            format: config.format,
            quality: qualityPref,
            filename: mvName,
            downloadDir: mvDir,
            filePath: mvPath,
            downloadedAt: new Date().toISOString(),
          })
          setState({ completedCount: state.completedCount + 1 })
          continue
        }
          const { filePath: dlPath } = await downloadTrack(
            track.bvid || track.id,
            { aid: track.aid, cid: track.cid },
            filename,
            config.format as DownloadFormat,
            qualityPref,
            dir,
            { artist, title: filename, lyricContent },
          )
          // 记录真实落盘路径（主进程同名防覆盖可能带序号），供下载页定位文件
          const dlName = dlPath.split(/[\\/]/).pop() || filename

        saveDownloadRecord({
          id: crypto.randomUUID ? crypto.randomUUID() : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          title: filename,
          artist: artist || track.artist || '',
          bvid: track.bvid || track.id,
          format: config.format,
          quality: qualityPref,
          filename: dlName,
          downloadDir: dlPath.slice(0, dlPath.length - dlName.length - 1),
          filePath: dlPath,
          downloadedAt: new Date().toISOString(),
        })

        setState({ completedCount: state.completedCount + 1 })
      } catch (e) {
        // 记录失败原因，UI 可展示具体错误（此前静默吞掉，用户看不到失败原因）
        const message = e instanceof Error ? e.message : String(e)
        setState({
          errorCount: state.errorCount + 1,
          errors: [...state.errors, { title: track.title, message }],
        })
      }
    }
  } finally {
    unsubProgress?.()
  }

  setState({ running: false, progress: null })
}

/** 取消下载（当前文件完成后停止后续；MV 导出走主进程即时取消，不等它跑完） */
export function cancelBatchDownload() {
  cancelled = true
  // mv 格式的当前文件可能是分钟级的 MV 导出，只置标志要等整首跑完才停，直接同步取消
  cancelMvExport()
}

/** 隐藏对话框（后台继续下载） */
export function hideBatchDialog() {
  setState({ visible: false })
}

/** 重新显示对话框（恢复进度） */
export function showBatchDialog() {
  setState({ visible: true })
}

/** 关闭并重置对话框 */
export function closeBatchDialog() {
  if (state.running) return
  setState({
    visible: false,
    started: false,
    tracks: [],
    config: null,
    progress: null,
    completedCount: 0,
    errorCount: 0,
    errors: [],
  })
}
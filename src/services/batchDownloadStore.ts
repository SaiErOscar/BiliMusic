// 模块级批量下载任务管理
// 下载任务在模块作用域运行，不依赖组件生命周期：
// - 隐藏对话框后下载继续在后台进行
// - 重新打开对话框时恢复显示进度
// - 支持取消（当前文件下载完成后停止后续）
import { downloadTrack } from '@/services/api'
import { cleanTitle, getLyricForTrack, formatLrc } from '@/services/lyrics'
import { saveDownloadRecord } from '@/utils/storage'
import type { Track, DownloadFormat } from '@/types'

export type NameMode = 'video' | 'song' | 'custom'

export interface BatchConfig {
  format: DownloadFormat
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
  /** 当前文件下载字节进度（audio 格式经 onDownloadProgress 实时更新） */
  fileReceived?: number
  fileTotal?: number
  filePercent?: number
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

  // 订阅主进程单文件下载字节进度（audio 格式有实时回调），写回当前 progress
  const unsubProgress = window.electronAPI?.biliApi?.onDownloadProgress?.(
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

        if (config.embedMeta || config.includeLyric) {
          const lyricResult = await getLyricForTrack(track)
          if (lyricResult) {
            if (config.embedMeta && lyricResult.artistName) {
              artist = lyricResult.artistName
            }
            if (config.includeLyric && lyricResult.lines.length > 0) {
              lyricContent = formatLrc(lyricResult)
            }
          }
        }

        const filename = getFilename(config, track, i + 1)

        await downloadTrack(
          track.bvid || track.id,
          { aid: track.aid, cid: track.cid },
          filename,
          config.format,
          qualityPref,
          dir,
          { artist, title: filename, lyricContent },
        )

        saveDownloadRecord({
          id: crypto.randomUUID ? crypto.randomUUID() : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          title: filename,
          artist: artist || track.artist || '',
          bvid: track.bvid || track.id,
          format: config.format,
          quality: qualityPref,
          filename,
          downloadDir: dir || '',
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

/** 取消下载（当前文件完成后停止后续） */
export function cancelBatchDownload() {
  cancelled = true
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
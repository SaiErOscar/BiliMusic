/**
 * v1.4.6 播放页 MV 视频导出（桌面端专属）
 *
 * 渲染层职责：解析音源（getPlayUrl + getBestAudioUrl）、取歌词时间轴（含偏移），
 * 组装 MvExportPayload 交给主进程离屏渲染 + ffmpeg 合成。进度经 onMvExportProgress 回调上抛。
 * 手机端（platform.mvExport 缺失）调用方隐藏入口，本服务不暴露降级路径。
 */

import { platform } from '@/platform'
import { getVideoDetail, getPlayUrl, getBestAudioUrl, type AudioQualityPreference } from '@/services/bilibiliApi'
import { getLyricForTrack } from '@/services/lyrics'
import type { MvExportProgress } from '@/types/electron'
import type { Track } from '@/types'

export type { MvExportProgress }

export interface ExportMvOptions {
  quality?: AudioQualityPreference
  watermark: boolean
  outputDir?: string
  /** 进度回调（下载音频/渲染关键帧/合成视频） */
  onProgress?: (progress: MvExportProgress) => void
}

/** 该环境是否支持 MV 导出（桌面 Electron 专属） */
export function isMvExportSupported(): boolean {
  return !!platform.mvExport
}

export function subscribeMvExportProgress(callback: (progress: MvExportProgress) => void): () => void {
  const subscribe = platform.mvExport?.onMvExportProgress
  return subscribe ? subscribe(callback) : (() => {})
}

export function cancelMvExport(): void {
  platform.mvExport?.cancelMvExport?.()
}

/**
 * 导出当前曲目的播放界面 MV（封面+歌名+歌词滚动）为 MP4。
 * 返回输出文件路径（下载目录/MV/<标题>.mp4）。
 */
export async function exportTrackMv(
  track: Track,
  options: ExportMvOptions,
): Promise<{ filePath: string }> {
  const mvExport = platform.mvExport
  if (!mvExport) throw new Error('当前平台不支持 MV 导出')

  const bvid = track.bvid || track.id
  if (!bvid) throw new Error('缺少曲目 bvid')

  // 解析 cid 与音频直链
  let cid: number | undefined
  try {
    const detail = await getVideoDetail(bvid)
    cid = detail.cid
  } catch {
    cid = undefined
  }
  if (!cid && track.cid) cid = Number(track.cid)
  if (!cid) throw new Error('无法获取视频 cid')

  const playData = await getPlayUrl(bvid, cid)
  const audioUrl = getBestAudioUrl(playData, options.quality || 'high')
  if (!audioUrl) throw new Error('无法获取音频播放地址')

  // 歌词时间轴（getLyricForTrack 已应用偏移；无歌词/none 态传空数组 → 画面显示「暂无歌词」）
  let lines: { time: number; text: string }[] = []
  try {
    const lyric = await getLyricForTrack(track)
    if (lyric && !lyric.noLyric && lyric.synced) {
      lines = lyric.lines
        .filter((l) => l.text.trim())
        .map((l) => ({ time: l.time, text: l.text }))
    }
  } catch { /* 歌词失败不阻塞导出 */ }

  const unsubscribe = options.onProgress ? platform.mvExport?.onMvExportProgress?.(options.onProgress) : null
  try {
    const result = await platform.mvExport!.exportMvSingle!({
      title: track.title,
      artist: track.artist || '',
      audioUrl,
      coverUrl: track.coverUrl || '',
      duration: track.duration || 0,
      lyrics: lines,
      watermark: options.watermark,
      outputDir: options.outputDir,
    })
    if (!result.ok || !result.filePath) {
      throw new Error(result.message || 'MV 导出失败')
    }
    return { filePath: result.filePath }
  } finally {
    unsubscribe?.()
  }
}

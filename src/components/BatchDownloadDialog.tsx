import { useState, useCallback } from 'react'
import { Download, Loader2, Check, X, FolderOpen, Music, FileText, Edit3, FileMusic } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { downloadTrack, selectDownloadFolder } from '@/services/api'
import { useAppSettings } from '@/hooks/useAppSettings'
import { cleanTitle, getLyricForTrack, formatLrc } from '@/services/lyrics'
import type { Track, DownloadFormat } from '@/types'

type NameMode = 'video' | 'song' | 'custom'

interface BatchDownloadDialogProps {
  tracks: Track[]
  onClose: () => void
}

interface DownloadProgress {
  current: number
  total: number
  trackTitle: string
  status: 'pending' | 'downloading' | 'done' | 'error'
  error?: string
}

/**
 * 批量下载对话框
 * 支持选择下载格式、下载位置、文件名格式
 * 支持同时下载歌词和自动填充歌手属性
 */
export default function BatchDownloadDialog({ tracks, onClose }: BatchDownloadDialogProps) {
  const { settings } = useAppSettings()
  const [format, setFormat] = useState<DownloadFormat>('audio')
  const [downloadDir, setDownloadDir] = useState(settings.downloadDir || '')
  const [nameMode, setNameMode] = useState<NameMode>('video')
  const [customName, setCustomName] = useState('')
  const [includeLyric, setIncludeLyric] = useState(true)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [completedCount, setCompletedCount] = useState(0)
  const [errorCount, setErrorCount] = useState(0)

  const qualityPref = 'lossless'

  const handleSelectDir = useCallback(async () => {
    const dir = await selectDownloadFolder()
    if (dir) setDownloadDir(dir)
  }, [])

  const getFilename = useCallback((track: Track): string => {
    if (nameMode === 'song') {
      return cleanTitle(track.title) || track.title
    }
    if (nameMode === 'custom' && customName.trim()) {
      // Support template: {title}, {artist}, {index}
      const idx = tracks.indexOf(track) + 1
      return customName
        .replace(/\{title\}/g, track.title)
        .replace(/\{artist\}/g, track.artist || '')
        .replace(/\{index\}/g, String(idx).padStart(2, '0'))
        .trim()
    }
    return track.title
  }, [nameMode, customName, tracks])

  const handleBatchDownload = useCallback(async () => {
    if (tracks.length === 0) return
    setDownloading(true)
    setCompletedCount(0)
    setErrorCount(0)

    const dir = downloadDir || undefined

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      setProgress({
        current: i + 1,
        total: tracks.length,
        trackTitle: track.title,
        status: 'downloading',
      })

      try {
        // 获取歌词和歌手信息
        let lyricContent: string | undefined
        let artist: string | undefined

        const lyricResult = await getLyricForTrack(track)
        if (lyricResult) {
          if (lyricResult.artistName) {
            artist = lyricResult.artistName
          }
          if (includeLyric && lyricResult.lines.length > 0) {
            lyricContent = formatLrc(lyricResult)
          }
        }

        const filename = getFilename(track)

        await downloadTrack(
          track.bvid || track.id,
          { aid: track.aid, cid: track.cid },
          filename,
          format,
          qualityPref,
          dir,
          { artist, title: filename, lyricContent },
        )

        setCompletedCount(c => c + 1)
        setProgress({
          current: i + 1,
          total: tracks.length,
          trackTitle: track.title,
          status: 'done',
        })
      } catch (e) {
        setErrorCount(c => c + 1)
        setProgress({
          current: i + 1,
          total: tracks.length,
          trackTitle: track.title,
          status: 'error',
          error: e instanceof Error ? e.message : '下载失败',
        })
      }
    }

    setDownloading(false)
  }, [tracks, downloadDir, format, includeLyric, getFilename])

  return (
    <AnimatePresence>
      <motion.div
        className="playlist-dialog-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === e.currentTarget && !downloading) onClose() }}
        style={{ zIndex: 200 }}
      >
        <motion.div
          className="playlist-dialog"
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={{ duration: 0.2 }}
          style={{ maxWidth: 440, width: '90vw' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
              批量下载
              <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--color-muted)', marginLeft: 8 }}>
                共 {tracks.length} 首
              </span>
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={downloading}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: downloading ? 'not-allowed' : 'pointer',
                color: 'var(--color-muted)',
                padding: 4,
                display: 'flex',
                opacity: downloading ? 0.4 : 1,
              }}
            >
              <X size={18} />
            </button>
          </div>

          {/* 下载格式 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 }}>
              下载格式
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setFormat('audio')}
                disabled={downloading}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  border: `1px solid ${format === 'audio' ? 'var(--color-accent)' : 'var(--glass-border)'}`,
                  borderRadius: 10,
                  background: format === 'audio' ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  justifyContent: 'center',
                }}
              >
                <Music size={15} />
                音频
              </button>
              <button
                type="button"
                onClick={() => setFormat('video')}
                disabled={downloading}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  border: `1px solid ${format === 'video' ? 'var(--color-accent)' : 'var(--glass-border)'}`,
                  borderRadius: 10,
                  background: format === 'video' ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  justifyContent: 'center',
                }}
              >
                <Download size={15} />
                视频
              </button>
            </div>
          </div>

          {/* 下载位置 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 }}>
              下载位置
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={downloadDir}
                onChange={(e) => setDownloadDir(e.target.value)}
                placeholder="留空使用默认目录"
                disabled={downloading}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  border: '1px solid var(--glass-border)',
                  borderRadius: 10,
                  background: 'var(--glass-bg)',
                  color: 'var(--color-foreground)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              />
              <button
                type="button"
                onClick={handleSelectDir}
                disabled={downloading}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--glass-border)',
                  borderRadius: 10,
                  background: 'var(--glass-bg)',
                  color: 'var(--color-foreground)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                }}
              >
                <FolderOpen size={14} />
                选择
              </button>
            </div>
          </div>

          {/* 文件名格式 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 }}>
              文件名格式
            </div>
            {([
              { mode: 'video' as NameMode, label: '视频标题', icon: <FileText size={13} /> },
              { mode: 'song' as NameMode, label: '过滤歌名', icon: <Music size={13} /> },
              { mode: 'custom' as NameMode, label: '自定义模板', icon: <Edit3 size={13} /> },
            ]).map(({ mode, label, icon }) => (
              <button
                key={mode}
                type="button"
                onClick={() => setNameMode(mode)}
                disabled={downloading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '7px 10px',
                  border: 'none',
                  borderRadius: 8,
                  background: nameMode === mode ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                {icon}
                {label}
                {nameMode === mode && <Check size={12} style={{ marginLeft: 'auto' }} />}
              </button>
            ))}
            {nameMode === 'custom' && (
              <>
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="{title} - {artist}"
                  disabled={downloading}
                  autoFocus
                  style={{
                    width: 'calc(100% - 16px)',
                    margin: '4px 8px',
                    padding: '6px 8px',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 8,
                    background: 'var(--glass-bg)',
                    color: 'var(--color-foreground)',
                    fontSize: 12,
                    fontFamily: 'inherit',
                  }}
                />
                <div style={{ fontSize: 10, color: 'var(--color-muted)', padding: '0 10px', fontStyle: 'italic' }}>
                  支持: {'{title}'} 标题, {'{artist}'} 歌手, {'{index}'} 序号
                </div>
              </>
            )}
          </div>

          {/* 歌词选项 */}
          <div style={{ marginBottom: 16 }}>
            <button
              type="button"
              onClick={() => setIncludeLyric(v => !v)}
              disabled={downloading}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 10px',
                border: 'none',
                borderRadius: 8,
                background: 'transparent',
                color: 'var(--color-foreground)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <FileMusic size={14} />
              同时下载歌词(.lrc) + 自动填充歌手属性
              {includeLyric && <Check size={12} style={{ marginLeft: 'auto' }} />}
            </button>
          </div>

          {/* 下载进度 */}
          {progress && (
            <div style={{
              marginBottom: 16,
              padding: 12,
              borderRadius: 10,
              background: 'var(--glass-bg)',
              border: '1px solid var(--glass-border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {downloading ? <Loader2 size={13} className="spin" style={{ display: 'inline', marginRight: 6 }} /> : null}
                  {progress.current} / {progress.total}
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>
                  成功 {completedCount} · 失败 {errorCount}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {progress.trackTitle}
              </div>
              {progress.status === 'error' && progress.error && (
                <div style={{ fontSize: 11, color: '#ff375f' }}>
                  {progress.error}
                </div>
              )}
              {/* 进度条 */}
              <div style={{
                height: 4,
                borderRadius: 2,
                background: 'var(--glass-border)',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${(progress.current / progress.total) * 100}%`,
                  background: 'var(--color-accent)',
                  borderRadius: 2,
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {!downloading && progress && completedCount + errorCount === tracks.length ? (
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '8px 20px',
                  border: 'none',
                  borderRadius: 10,
                  background: 'var(--color-accent)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                完成
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={downloading}
                  style={{
                    padding: '8px 16px',
                    border: '1px solid var(--glass-border)',
                    borderRadius: 10,
                    background: 'transparent',
                    color: 'var(--color-foreground)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: downloading ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    opacity: downloading ? 0.5 : 1,
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleBatchDownload}
                  disabled={downloading}
                  style={{
                    padding: '8px 20px',
                    border: 'none',
                    borderRadius: 10,
                    background: 'var(--color-accent)',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: downloading ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    opacity: downloading ? 0.5 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                  {downloading ? '下载中...' : '开始下载'}
                </button>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

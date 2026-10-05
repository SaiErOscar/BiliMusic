import { useState, useCallback } from 'react'
import { Download, Loader2, Check, Music, FileText, Edit3, FileMusic, Tag, Clapperboard } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePlayer } from '@/contexts/PlayerContext'
import { useAppSettings } from '@/hooks/useAppSettings'
import { downloadTrack } from '@/services/api'
import { cleanTitle, getLyricForTrack, formatLrc } from '@/services/lyrics'
import { exportTrackMv, isMvExportSupported } from '@/services/mvExport'
import { saveDownloadRecord } from '@/utils/storage'

import type { DownloadFormat } from '@/types'

type NameMode = 'video' | 'song' | 'custom'

interface DownloadButtonProps {
  trackId?: string
  bvid?: string
  aid?: string | number
  cid?: string | number
  title?: string
  size?: number
  variant?: 'icon' | 'full'
}

/**
 * 下载按钮：支持选择下载音频或视频
 * 文件名可选：① 视频标题 ② 过滤后的歌名 ③ 自定义输入
 * 音频下载可同时保存歌词(.lrc)，并自动将歌手信息写入文件属性
 */
export default function DownloadButton({
  trackId,
  bvid,
  aid,
  cid,
  title,
  size = 16,
  variant = 'icon',
}: DownloadButtonProps) {
  const player = usePlayer()
  const { settings } = useAppSettings()
  const [downloading, setDownloading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [nameMode, setNameMode] = useState<NameMode>('video')
  const [customName, setCustomName] = useState('')
  const [includeLyric, setIncludeLyric] = useState(true)
  const [embedMeta, setEmbedMeta] = useState(true)
  // v1.4.6 MV 导出状态（桌面端专属）
  const [mvExporting, setMvExporting] = useState(false)
  const [mvStatus, setMvStatus] = useState('')

  const actualTrack = player.currentTrack
  const actualBvid = bvid || actualTrack?.bvid || actualTrack?.id
  const actualAid = aid || actualTrack?.aid
  const actualCid = cid || actualTrack?.cid
  const actualTitle = title || actualTrack?.title || '未知曲目'
  const actualId = trackId || actualTrack?.id

  const qualityPref = settings.downloadQuality === '标准' ? 'standard' :
    settings.downloadQuality === '高品质' ? 'high' : 'lossless'

  // 切换到自定义模式时，预设原视频名
  const handleNameModeChange = useCallback((mode: NameMode) => {
    setNameMode(mode)
    if (mode === 'custom' && !customName) {
      setCustomName(actualTitle)
    }
  }, [customName, actualTitle])

  const getFilename = useCallback((): string => {
    if (nameMode === 'song') {
      return cleanTitle(actualTitle) || actualTitle
    }
    if (nameMode === 'custom' && customName.trim()) {
      return customName.trim()
    }
    return actualTitle
  }, [nameMode, customName, actualTitle])

  const doDownload = useCallback(async (format: DownloadFormat) => {
    if (!actualBvid) return
    setMenuOpen(false)
    setDownloading(true)
    setError('')
    setDone(false)
    try {
      // 获取歌词和歌手信息（拆分为两个独立选项：修改属性 / 下载歌词）
      let lyricContent: string | undefined
      let artist: string | undefined

      const trackForLyric = actualTrack || {
        id: actualId!,
        title: actualTitle,
        artist: '',
        coverUrl: '',
        duration: 0,
        videoUrl: '',
        bvid: actualBvid,
        aid: actualAid,
        cid: actualCid,
        playCount: 0,
        isLiked: false,
      }

      if (embedMeta || includeLyric) {
        const lyricResult = await getLyricForTrack(trackForLyric)
        // v1.4.5：用户选「不显示歌词」→ 命中 none 态，无论开关都不下载歌词、不写歌手
        if (lyricResult && !lyricResult.noLyric) {
          if (embedMeta && lyricResult.artistName) {
            artist = lyricResult.artistName
          }
          if (includeLyric && lyricResult.lines.length > 0) {
            lyricContent = formatLrc(lyricResult)
          }
        }
      }

      const { filePath } = await downloadTrack(
        actualBvid,
        { aid: actualAid, cid: actualCid },
        getFilename(),
        format,
        qualityPref,
        settings.downloadDir,
        { artist, title: getFilename(), lyricContent },
      )
      // 记录真实落盘路径（主进程同名防覆盖可能带序号），供下载页定位文件
      const actualName = filePath.split(/[\\/]/).pop() || getFilename()
      saveDownloadRecord({
        id: crypto.randomUUID ? crypto.randomUUID() : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        title: getFilename(),
        artist: artist || actualTrack?.artist || '',
        bvid: actualBvid,
        format,
        quality: qualityPref,
        filename: actualName,
        downloadDir: filePath.slice(0, filePath.length - actualName.length - 1),
        filePath,
        downloadedAt: new Date().toISOString(),
      })
      setDone(true)
      setTimeout(() => setDone(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败')
      setTimeout(() => setError(''), 4000)
    } finally {
      setDownloading(false)
    }
  }, [actualBvid, actualAid, actualCid, actualId, actualTrack, actualTitle, getFilename, qualityPref, settings.downloadDir, includeLyric, embedMeta])

  // v1.4.6 导出播放界面 MV（离屏渲染 + ffmpeg 合成，主进程完成）
  const doExportMv = useCallback(async () => {
    if (!actualBvid) return
    setMenuOpen(false)
    setMvExporting(true)
    setError('')
    setDone(false)
    setMvStatus('准备中...')
    const trackForMv = actualTrack || {
      id: actualId!,
      title: actualTitle,
      artist: '',
      coverUrl: '',
      duration: 0,
      videoUrl: '',
      bvid: actualBvid,
      aid: actualAid,
      cid: actualCid,
      playCount: 0,
      isLiked: false,
    }
    try {
      const { filePath } = await exportTrackMv(trackForMv, {
        quality: qualityPref,
        watermark: settings.mvWatermark,
        outputDir: settings.downloadDir || undefined,
        onProgress: (p) => {
          setMvStatus(p.message ? `${p.message} ${p.percent}%` : `${p.percent}%`)
        },
      })
      // 单首 MV 导出同样写入下载记录（此前只有批量写，记录里查不到单首产物）
      const mvName = filePath.split(/[\\/]/).pop() || trackForMv.title
      saveDownloadRecord({
        id: crypto.randomUUID ? crypto.randomUUID() : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        title: trackForMv.title,
        artist: trackForMv.artist || '',
        bvid: actualBvid,
        format: 'mv',
        quality: qualityPref,
        filename: mvName,
        downloadDir: filePath.slice(0, filePath.length - mvName.length - 1),
        filePath,
        downloadedAt: new Date().toISOString(),
      })
      setDone(true)
      setTimeout(() => setDone(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'MV 导出失败')
      setTimeout(() => setError(''), 5000)
    } finally {
      setMvExporting(false)
      setMvStatus('')
    }
  }, [actualBvid, actualAid, actualCid, actualId, actualTrack, actualTitle, qualityPref, settings.downloadDir, settings.mvWatermark])

  if (!actualBvid || !actualId) return null

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      {variant === 'icon' ? (
        <button
          className="track-action-button"
          title={error || (done ? '下载完成' : mvExporting ? `导出 MV 中：${mvStatus}` : downloading ? '下载中...' : '下载')}
          onClick={() => setMenuOpen(o => !o)}
          disabled={downloading || mvExporting}
          style={{ color: error ? '#ff375f' : done ? '#30d158' : undefined }}
        >
          {downloading || mvExporting ? <Loader2 size={size} className="spin" /> :
           done ? <Check size={size} /> :
           <Download size={size} />}
        </button>
      ) : (
        <button
          className="now-playing-round"
          title={error || (done ? '下载完成' : mvExporting ? `导出 MV 中：${mvStatus}` : downloading ? '下载中...' : '下载')}
          onClick={() => setMenuOpen(o => !o)}
          disabled={downloading || mvExporting}
          style={{ color: error ? '#ff375f' : done ? '#30d158' : undefined }}
        >
          {downloading || mvExporting ? <Loader2 size={size} className="spin" /> :
           done ? <Check size={size} /> :
           <Download size={size} />}
        </button>
      )}

      <AnimatePresence>
        {menuOpen && !downloading && (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
              onClick={() => setMenuOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.96 }}
              transition={{ duration: 0.15 }}
              style={{
                position: 'absolute',
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: 6,
                padding: '8px',
                borderRadius: 12,
                background: 'var(--glass-bg-heavy)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 100,
                whiteSpace: 'nowrap',
                minWidth: 200,
              }}
            >
              {/* 文件名选择区 */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--color-muted)', fontWeight: 600, marginBottom: 4, padding: '0 4px' }}>
                  文件名
                </div>
                {([
                  { mode: 'video' as NameMode, label: '视频标题', icon: <FileText size={13} /> },
                  { mode: 'song' as NameMode, label: '过滤歌名', icon: <Music size={13} /> },
                  { mode: 'custom' as NameMode, label: '自定义', icon: <Edit3 size={13} /> },
                ]).map(({ mode, label, icon }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleNameModeChange(mode)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 10px',
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
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="输入文件名..."
                    autoFocus
                    style={{
                      width: 'calc(100% - 8px)',
                      margin: '4px',
                      padding: '6px 8px',
                      border: '1px solid var(--glass-border)',
                      borderRadius: 8,
                      background: 'var(--glass-bg)',
                      color: 'var(--color-foreground)',
                      fontSize: 12,
                      fontFamily: 'inherit',
                    }}
                  />
                )}
                {nameMode === 'song' && (
                  <div style={{ fontSize: 11, color: 'var(--color-muted)', padding: '2px 10px 4px', fontStyle: 'italic' }}>
                    {cleanTitle(actualTitle) || '(无法过滤)'}
                  </div>
                )}
              </div>

              {/* 分隔线 */}
              <div style={{ height: 1, background: 'var(--glass-border)', margin: '4px 0' }} />

              {/* 歌词选项（拆分为两个独立选项） */}
              <div style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  onClick={() => setIncludeLyric(v => !v)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 10px',
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
                  <FileMusic size={13} />
                  同时下载歌词(.lrc)
                  {includeLyric && <Check size={12} style={{ marginLeft: 'auto' }} />}
                </button>
                <button
                  type="button"
                  onClick={() => setEmbedMeta(v => !v)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 10px',
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
                  <Tag size={13} />
                  修改文件属性(写入歌手)
                  {embedMeta && <Check size={12} style={{ marginLeft: 'auto' }} />}
                </button>
              </div>

              {/* 分隔线 */}
              <div style={{ height: 1, background: 'var(--glass-border)', margin: '4px 0' }} />

              {/* 下载格式选择 */}
              <div style={{ fontSize: 11, color: 'var(--color-muted)', fontWeight: 600, marginBottom: 4, padding: '0 4px' }}>
                下载格式
              </div>
              <button
                type="button"
                onClick={() => doDownload('audio')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 8,
                  background: settings.downloadFormat === 'audio' ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                <Download size={14} />
                下载音频
                <span style={{ marginLeft: 'auto', color: 'var(--color-muted)', fontSize: 11 }}>
                  {settings.downloadQuality}
                </span>
              </button>
              <button
                type="button"
                onClick={() => doDownload('video')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 8,
                  background: settings.downloadFormat === 'video' ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                <Download size={14} />
                下载视频
                <span style={{ marginLeft: 'auto', color: 'var(--color-muted)', fontSize: 11 }}>
                  含画面+声音
                </span>
              </button>

              {/* v1.4.6 导出播放界面 MV（仅桌面端显示） */}
              {isMvExportSupported() && (
                <>
                  <div style={{ height: 1, background: 'var(--glass-border)', margin: '4px 0' }} />
                  <button
                    type="button"
                    onClick={doExportMv}
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
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <Clapperboard size={14} />
                    导出 MV
                    <span style={{ marginLeft: 'auto', color: 'var(--color-muted)', fontSize: 11 }}>
                      播放界面视频
                    </span>
                  </button>
                </>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {mvExporting && mvStatus && (
        <span style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 4,
          padding: '4px 10px',
          borderRadius: 8,
          background: 'rgba(30, 30, 34, 0.92)',
          color: '#fff',
          fontSize: 11,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 101,
        }}>
          导出 MV：{mvStatus}
        </span>
      )}

      {error && (
        <span style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 4,
          padding: '4px 10px',
          borderRadius: 8,
          background: 'rgba(255, 55, 95, 0.9)',
          color: '#fff',
          fontSize: 11,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}>
          {error}
        </span>
      )}
    </div>
  )
}

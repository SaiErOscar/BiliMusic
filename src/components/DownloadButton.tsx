import { useState, useCallback } from 'react'
import { Download, Loader2, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePlayer } from '@/contexts/PlayerContext'
import { useAppSettings } from '@/hooks/useAppSettings'
import { downloadTrack } from '@/services/api'
import type { DownloadFormat } from '@/types'

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
 * B站视频下载需合并画面+声音流（ffmpeg）
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

  const actualTrack = player.currentTrack
  const actualBvid = bvid || actualTrack?.bvid || actualTrack?.id
  const actualAid = aid || actualTrack?.aid
  const actualCid = cid || actualTrack?.cid
  const actualTitle = title || actualTrack?.title || '未知曲目'
  const actualId = trackId || actualTrack?.id

  const qualityPref = settings.downloadQuality === '标准' ? 'standard' :
    settings.downloadQuality === '高品质' ? 'high' : 'lossless'

  const doDownload = useCallback(async (format: DownloadFormat) => {
    if (!actualBvid) return
    setMenuOpen(false)
    setDownloading(true)
    setError('')
    setDone(false)
    try {
      await downloadTrack(
        actualBvid,
        { aid: actualAid, cid: actualCid },
        actualTitle,
        format,
        qualityPref,
        settings.downloadDir,
      )
      setDone(true)
      setTimeout(() => setDone(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败')
      setTimeout(() => setError(''), 4000)
    } finally {
      setDownloading(false)
    }
  }, [actualBvid, actualAid, actualCid, actualTitle, qualityPref, settings.downloadDir])

  if (!actualBvid || !actualId) return null

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      {variant === 'icon' ? (
        <button
          className="track-action-button"
          title={error || (done ? '下载完成' : downloading ? '下载中...' : '下载')}
          onClick={() => setMenuOpen(o => !o)}
          disabled={downloading}
          style={{ color: error ? '#ff375f' : done ? '#30d158' : undefined }}
        >
          {downloading ? <Loader2 size={size} className="spin" /> :
           done ? <Check size={size} /> :
           <Download size={size} />}
        </button>
      ) : (
        <button
          className="now-playing-round"
          title={error || (done ? '下载完成' : downloading ? '下载中...' : '下载')}
          onClick={() => setMenuOpen(o => !o)}
          disabled={downloading}
          style={{ color: error ? '#ff375f' : done ? '#30d158' : undefined }}
        >
          {downloading ? <Loader2 size={size} className="spin" /> :
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
                padding: '6px',
                borderRadius: 12,
                background: 'var(--glass-bg-heavy)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 100,
                whiteSpace: 'nowrap',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <button
                className="download-menu-item"
                onClick={() => doDownload('audio')}
                style={{
                  padding: '8px 14px',
                  border: 'none',
                  borderRadius: 8,
                  background: settings.downloadFormat === 'audio' ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
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
                className="download-menu-item"
                onClick={() => doDownload('video')}
                style={{
                  padding: '8px 14px',
                  border: 'none',
                  borderRadius: 8,
                  background: settings.downloadFormat === 'video' ? 'var(--sidebar-active-bg)' : 'transparent',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
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
            </motion.div>
          </>
        )}
      </AnimatePresence>

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

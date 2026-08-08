import { useState, useCallback, useEffect, useSyncExternalStore } from 'react'
import { Download, Loader2, Check, X, FolderOpen, Music, FileText, Edit3, FileMusic, Tag } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { selectDownloadFolder } from '@/services/api'
import { useAppSettings } from '@/hooks/useAppSettings'
import {
  batchSubscribe,
  getBatchState,
  startBatchDownload,
  cancelBatchDownload,
  hideBatchDialog,
  closeBatchDialog,
} from '@/services/batchDownloadStore'
import type { Track, DownloadFormat } from '@/types'
import type { NameMode } from '@/services/batchDownloadStore'

interface BatchDownloadDialogProps {
  tracks: Track[]
  onClose: () => void
}

/**
 * 批量下载对话框
 * 支持选择下载格式、下载位置、文件名格式
 * 支持同时下载歌词和自动填充歌手属性（两个独立选项）
 * 下载任务在模块级 store 运行：
 * - 点「下载中...」可隐藏窗口后台下载
 * - 点「取消」终止下载
 * - 重新打开对话框可恢复进度
 */
export default function BatchDownloadDialog({ tracks, onClose }: BatchDownloadDialogProps) {
  const { settings } = useAppSettings()
  // 订阅模块级下载状态（后台任务）
  const store = useSyncExternalStore(batchSubscribe, getBatchState)

  // 首次打开的配置
  const [format, setFormat] = useState<DownloadFormat>('audio')
  const [downloadDir, setDownloadDir] = useState(settings.downloadDir || '')
  const [nameMode, setNameMode] = useState<NameMode>('video')
  const [customName, setCustomName] = useState('')
  const [includeLyric, setIncludeLyric] = useState(true)
  const [embedMeta, setEmbedMeta] = useState(true)

  const isRunning = store.running
  const isStarted = store.started
  const visible = store.visible
  const progress = store.progress
  const completedCount = store.completedCount
  const errorCount = store.errorCount
  const errors = store.errors

  // 新开对话框时确保可见
  useEffect(() => {
    if (!getBatchState().started) {
      // 尚未开始任务，此实例作为新配置对话框
    }
  }, [])

  const handleSelectDir = useCallback(async () => {
    const dir = await selectDownloadFolder()
    if (dir) setDownloadDir(dir)
  }, [])

  const handleStart = useCallback(() => {
    if (tracks.length === 0) return
    startBatchDownload(tracks, {
      format,
      downloadDir,
      nameMode,
      customName,
      includeLyric,
      embedMeta,
    })
  }, [tracks, format, downloadDir, nameMode, customName, includeLyric, embedMeta])

  const handleToggleShow = useCallback(() => {
    // 隐藏到后台 / 恢复显示
    if (visible) hideBatchDialog()
    else showDialog()
  }, [visible])

  const showDialog = useCallback(() => {
    // 通过 store 重新显示
    import('@/services/batchDownloadStore').then((m) => m.showBatchDialog())
  }, [])

  const handleCancel = useCallback(() => {
    cancelBatchDownload()
    if (!isRunning) {
      // 未运行时的「取消」= 关闭对话框
      closeBatchDialog()
      onClose()
    }
  }, [isRunning, onClose])

  const handleClose = useCallback(() => {
    closeBatchDialog()
    onClose()
  }, [onClose])

  // 使用中的轨道列表：进行中任务用 store 的，否则用 props
  const activeTracks = isStarted ? store.tracks : tracks
  const total = activeTracks.length

  const renderProgress = () => (
    <div style={{
      marginBottom: 16,
      padding: 12,
      borderRadius: 10,
      background: 'var(--glass-bg)',
      border: '1px solid var(--glass-border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {isRunning ? <Loader2 size={13} className="spin" style={{ display: 'inline', marginRight: 6 }} /> : null}
          {progress ? `${progress.current} / ${progress.total}` : `${completedCount} / ${total}`}
        </span>
        <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>
          成功 {completedCount} · 失败 {errorCount}
        </span>
      </div>
      {progress && (
        <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {progress.trackTitle}
        </div>
      )}
      {!isRunning && (
        <div style={{ fontSize: 11, color: '#30d158', marginBottom: 4 }}>
          {errorCount > 0 ? `下载结束，${completedCount} 成功 / ${errorCount} 失败` : '全部下载完成 ✓'}
        </div>
      )}
      {/* 进度条 */}
      <div style={{ height: 4, borderRadius: 2, background: 'var(--glass-border)', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${total > 0 ? Math.min(100, ((completedCount + (progress?.current ?? 0) - 1) / total) * 100) : 0}%`,
          background: 'var(--color-accent)',
          borderRadius: 2,
          transition: 'width 0.3s ease',
        }} />
      </div>
      {/* 当前文件字节进度（audio 格式实时更新） */}
      {isRunning && progress?.filePercent != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--color-muted)', flexShrink: 0 }}>当前文件</span>
          <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--glass-border)', overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min(100, Math.max(0, progress.filePercent))}%`,
              background: 'var(--color-accent)',
              opacity: 0.7,
              borderRadius: 2,
              transition: 'width 0.25s ease',
            }} />
          </div>
          <span style={{ fontSize: 10, color: 'var(--color-muted)', flexShrink: 0 }}>
            {Math.round(Math.min(100, Math.max(0, progress.filePercent)))}%
          </span>
        </div>
      )}
      {/* 失败原因列表 */}
      {!isRunning && errors.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--glass-border)', maxHeight: 110, overflowY: 'auto', fontSize: 11 }}>
          <div style={{ color: '#ff6961', fontWeight: 600, marginBottom: 4 }}>失败 {errors.length} 项：</div>
          {errors.map((e, i) => (
            <div key={i} style={{ color: 'var(--color-muted)', marginBottom: 2, wordBreak: 'break-all' }}>
              <span style={{ color: 'var(--color-foreground)' }}>{e.title}</span> · {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="playlist-dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => { if (e.target === e.currentTarget && !isRunning) onClose() }}
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
                  {isStarted ? `共 ${total} 首` : `共 ${tracks.length} 首`}
                </span>
              </h2>
              <button
                type="button"
                onClick={handleClose}
                disabled={isRunning}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  color: 'var(--color-muted)',
                  padding: 4,
                  display: 'flex',
                  opacity: isRunning ? 0.4 : 1,
                }}
              >
                <X size={18} />
              </button>
            </div>

            {isStarted ? (
              /* === 进行中 / 已完成：显示进度与操作 === */
              <>
                {renderProgress()}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  {isRunning ? (
                    <>
                      <button
                        type="button"
                        onClick={handleCancel}
                        style={{
                          padding: '8px 16px',
                          border: '1px solid var(--glass-border)',
                          borderRadius: 10,
                          background: 'transparent',
                          color: 'var(--color-foreground)',
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={handleToggleShow}
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
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <Loader2 size={14} className="spin" />
                        下载中...
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleClose}
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
                  )}
                </div>
              </>
            ) : (
              /* === 首次配置 === */
              <>
                {/* 下载格式 */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 6 }}>
                    下载格式
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setFormat('audio')}
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

                {/* 歌词与属性选项（独立） */}
                <div style={{ marginBottom: 16 }}>
                  <button
                    type="button"
                    onClick={() => setIncludeLyric(v => !v)}
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
                    <Tag size={14} />
                    修改文件属性(写入歌手)
                    {embedMeta && <Check size={12} style={{ marginLeft: 'auto' }} />}
                  </button>
                </div>

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={handleClose}
                    style={{
                      padding: '8px 16px',
                      border: '1px solid var(--glass-border)',
                      borderRadius: 10,
                      background: 'transparent',
                      color: 'var(--color-foreground)',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleStart}
                    disabled={tracks.length === 0}
                    style={{
                      padding: '8px 20px',
                      border: 'none',
                      borderRadius: 10,
                      background: 'var(--color-accent)',
                      color: '#fff',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: tracks.length === 0 ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                      opacity: tracks.length === 0 ? 0.5 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Download size={14} />
                    开始下载
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
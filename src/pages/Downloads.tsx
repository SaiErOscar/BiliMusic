import { useState, useEffect } from 'react'
import { Download, FolderOpen, HardDrive, Music, ExternalLink, FileAudio, FileVideo, Clock, Trash2, Clapperboard, SquarePlay } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
} from '@/components/AppleMusicPage'
import { useAppSettings } from '@/hooks/useAppSettings'
import { loadDownloadRecords, clearDownloadRecords, DOWNLOADS_CHANGED_EVENT } from '@/utils/storage'
import type { DownloadRecord } from '@/types'
import { platform } from '@/platform'

export default function Downloads() {
  const { settings } = useAppSettings()
  const [records, setRecords] = useState<DownloadRecord[]>([])
  // ①记录文件存在性：存在的记录才显示「打开文件/所在文件夹」
  const [existsMap, setExistsMap] = useState<Record<string, boolean>>({})

  const refresh = () => setRecords(loadDownloadRecords())

  useEffect(() => {
    refresh()
    const handler = () => refresh()
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(DOWNLOADS_CHANGED_EVENT, handler)
  }, [])

  // 记录变化后逐一检测产物是否还在磁盘上（旧记录无 filePath 时以 downloadDir+filename 推算）
  useEffect(() => {
    let cancelled = false
    const download = platform.download
    if (!download?.pathExists) return
    const check = async () => {
      const next: Record<string, boolean> = {}
      for (const record of records) {
        const p = record.filePath || joinPath(record.downloadDir, record.filename)
        if (!p) continue
        try {
          next[record.id] = await download.pathExists(p)
        } catch { next[record.id] = false }
      }
      if (!cancelled) setExistsMap(next)
    }
    void check()
    return () => { cancelled = true }
  }, [records])

  const openDir = () => {
    platform.download?.openDownloadDir?.(settings.downloadDir)
  }

  const openLink = (bvid: string) => {
    // 用系统默认浏览器在外部打开，而非 Electron 内部新窗口
    platform.shell?.openExternal?.(`https://www.bilibili.com/video/${bvid}`)
  }

  const recordPath = (record: DownloadRecord) =>
    record.filePath || joinPath(record.downloadDir, record.filename)

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Downloads"
        title="本地下载"
        subtitle="离线音乐会整齐地收在这里，下载时可在音频和视频之间自由选择。"
        tone="blue"
        action={(
          <>
            {records.length > 0 && (
              <ActionButton tone="subtle" onClick={() => { clearDownloadRecords(); refresh() }}>
                <Trash2 size={16} />
                清空记录
              </ActionButton>
            )}
            <ActionButton tone="subtle" onClick={openDir}>
              <FolderOpen size={16} />
              打开下载目录
            </ActionButton>
          </>
        )}
      />

      <div className="download-dashboard">
        <DownloadMetric
          icon={<Download size={19} />}
          label="下载格式"
          value={settings.downloadFormat === 'video' ? '视频（画面+声音）' : '音频'}
        />
        <DownloadMetric
          icon={<Music size={19} />}
          label="下载音质"
          value={settings.downloadQuality}
        />
        <DownloadMetric
          icon={<HardDrive size={19} />}
          label="下载目录"
          value={settings.downloadDir}
          onClick={openDir}
        />
      </div>

      <MusicSection title="下载列表" icon={<Download size={22} />}>
        {records.length === 0 ? (
          <div className="download-empty-shell">
            <EmptyLibrary
              icon={<Download size={40} />}
              title="下载的音乐会保存在下载目录"
              subtitle="在播放页或控制栏点击下载按钮，选择下载音频或视频。"
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {records.map((record) => (
              <div
                key={record.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 16px',
                  borderRadius: 10,
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--sidebar-active-bg)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                {/* 格式图标 */}
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: record.format === 'video' ? 'rgba(0, 122, 255, 0.12)' : record.format === 'mv' ? 'rgba(48, 209, 88, 0.12)' : 'rgba(255, 45, 85, 0.12)',
                  color: record.format === 'video' ? '#007aff' : record.format === 'mv' ? '#30d158' : '#ff2d55',
                  flexShrink: 0,
                }}>
                  {record.format === 'video' ? <FileVideo size={18} /> : record.format === 'mv' ? <Clapperboard size={18} /> : <FileAudio size={18} />}
                </div>

                {/* 歌曲信息 */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--color-foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{record.title}</span>
                    {/* ②格式标签 */}
                    <FormatBadge format={record.format} />
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: 'var(--color-muted)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 2,
                  }}>
                    {record.artist && <span>{record.artist}</span>}
                    {record.artist && <span style={{ opacity: 0.3 }}>·</span>}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Clock size={11} />
                      {new Date(record.downloadedAt).toLocaleString()}
                    </span>
                    <span style={{ opacity: 0.3 }}>·</span>
                    <span>{record.format === 'video' ? '视频' : record.format === 'mv' ? 'MV' : '音频'}</span>
                    {record.quality && (
                      <>
                        <span style={{ opacity: 0.3 }}>·</span>
                        <span>{record.quality}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* 操作按钮 */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {/* ①产物仍存在才显示打开文件/所在文件夹 */}
                  {existsMap[record.id] && recordPath(record) && (
                    <>
                      <button
                        type="button"
                        title="打开文件"
                        onClick={() => { const p = recordPath(record); if (p) void platform.download?.openRecordFile?.(p) }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--color-muted)',
                          cursor: 'pointer',
                          padding: 6,
                          borderRadius: 6,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--glass-bg)' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                      >
                        <SquarePlay size={14} />
                      </button>
                      <button
                        type="button"
                        title="打开所在文件夹"
                        onClick={() => { const p = recordPath(record); if (p) void platform.download?.showRecordInFolder?.(p) }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--color-muted)',
                          cursor: 'pointer',
                          padding: 6,
                          borderRadius: 6,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--glass-bg)' }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                      >
                        <FolderOpen size={14} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    title="打开原链接"
                    onClick={() => openLink(record.bvid)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--color-muted)',
                      cursor: 'pointer',
                      padding: 6,
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--glass-bg)' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    <ExternalLink size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </MusicSection>
    </MusicPageShell>
  )
}

function DownloadMetric({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode
  label: string
  value: string
  /** 可点击的指标框（如「下载目录」点击即打开目录） */
  onClick?: () => void
}) {
  const body = (
    <>
      <span>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </>
  )
  if (!onClick) {
    return (
      <article className="download-metric">
        {body}
      </article>
    )
  }
  return (
    <article
      className="download-metric"
      onClick={onClick}
      title={`打开${label}`}
      style={{ cursor: 'pointer', transition: 'background 0.2s' }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--sidebar-active-bg)' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      {body}
    </article>
  )
}

/** 路径拼接（记录层无 path 模块，统一斜杠风格交给系统处理） */
function joinPath(dir: string, name: string): string {
  if (!dir) return name
  return `${dir.replace(/[\\/]+$/, '')}\\${name}`
}

/** 格式标签（音频/视频/MV），与行首图标同色系 */
function FormatBadge({ format }: { format: DownloadRecord['format'] }) {
  const conf = format === 'video'
    ? { label: '视频', color: '#007aff', bg: 'rgba(0, 122, 255, 0.12)' }
    : format === 'mv'
      ? { label: 'MV', color: '#30d158', bg: 'rgba(48, 209, 88, 0.12)' }
      : { label: '音频', color: '#ff2d55', bg: 'rgba(255, 45, 85, 0.12)' }
  return (
    <span style={{
      fontSize: 10,
      fontWeight: 600,
      lineHeight: 1,
      padding: '3px 7px',
      borderRadius: 999,
      color: conf.color,
      background: conf.bg,
      flexShrink: 0,
    }}>
      {conf.label}
    </span>
  )
}
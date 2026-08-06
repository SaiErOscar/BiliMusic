import { useState, useEffect } from 'react'
import { Download, FolderOpen, HardDrive, Music, ExternalLink, FileAudio, FileVideo, Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
} from '@/components/AppleMusicPage'
import { useAppSettings } from '@/hooks/useAppSettings'
import { loadDownloadRecords, DOWNLOADS_CHANGED_EVENT } from '@/utils/storage'
import type { DownloadRecord } from '@/types'

export default function Downloads() {
  const { settings } = useAppSettings()
  const [records, setRecords] = useState<DownloadRecord[]>([])

  const refresh = () => setRecords(loadDownloadRecords())

  useEffect(() => {
    refresh()
    const handler = () => refresh()
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(DOWNLOADS_CHANGED_EVENT, handler)
  }, [])

  const openDir = () => {
    window.electronAPI?.biliApi?.openDownloadDir?.(settings.downloadDir)
  }

  const openLink = (bvid: string) => {
    // 用系统默认浏览器在外部打开，而非 Electron 内部新窗口
    window.electronAPI?.openExternal?.(`https://www.bilibili.com/video/${bvid}`)
  }

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Downloads"
        title="本地下载"
        subtitle="离线音乐会整齐地收在这里，下载时可在音频和视频之间自由选择。"
        tone="blue"
        action={(
          <ActionButton tone="subtle" onClick={openDir}>
            <FolderOpen size={16} />
            打开下载目录
          </ActionButton>
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
                  background: record.format === 'video' ? 'rgba(0, 122, 255, 0.12)' : 'rgba(255, 45, 85, 0.12)',
                  color: record.format === 'video' ? '#007aff' : '#ff2d55',
                  flexShrink: 0,
                }}>
                  {record.format === 'video' ? <FileVideo size={18} /> : <FileAudio size={18} />}
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
                  }}>
                    {record.title}
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
                    <span>{record.format === 'video' ? '视频' : '音频'}</span>
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
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <article className="download-metric">
      <span>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </article>
  )
}
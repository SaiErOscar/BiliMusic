import { Download, FolderOpen, HardDrive, Music } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
} from '@/components/AppleMusicPage'
import { useAppSettings } from '@/hooks/useAppSettings'

export default function Downloads() {
  const { settings } = useAppSettings()

  const openDir = () => {
    window.electronAPI?.biliApi?.openDownloadDir?.(settings.downloadDir)
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

      <MusicSection title="下载列表" icon={<Music size={22} />}>
        <div className="download-empty-shell">
          <EmptyLibrary
            icon={<Download size={40} />}
            title="下载的音乐会保存在下载目录"
            subtitle="在播放页或控制栏点击下载按钮，选择下载音频或视频。"
          />
        </div>
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

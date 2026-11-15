/**
 * v1.4.15-pre5 本地音乐页：选目录 → 扫描（带进度与取消）→ 建索引 → 浏览。
 *
 * 分层：本页只管界面与状态流转。扫描在 electron/localMusic.ts（主进程读盘），
 * 标签解析在 src/services/audioTags.ts（纯函数），合并/排序/失效判定在
 * src/services/localMusic.ts（纯函数）——这里不复制任何一条业务规则。
 *
 * 能力探测沿用项目口径：platform.localMusic 缺失（非桌面端）时整块入口隐藏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, HardDriveDownload, RefreshCw, Trash2, X } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import {
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
  TrackListRow,
} from '@/components/AppleMusicPage'
import VirtualList from '@/components/VirtualList'
import { platform } from '@/platform'
import { parseAudioTags } from '@/services/audioTags'
import {
  buildLocalTrack,
  mergeLocalTracks,
  scanNotice,
  sortLocalTracks,
} from '@/services/localMusic'
import { loadLocalDirs, loadLocalTracks, saveLocalDirs, saveLocalTracks } from '@/utils/storage'
import type { Track } from '@/types'
import type { LocalScanProgress } from '@/types/electron'

const canUseLocalMusic = Boolean(platform.localMusic?.localMusicScan && platform.localMusic?.localMusicPickDir)

export default function LocalMusic() {
  const player = usePlayer()
  const [tracks, setTracks] = useState<Track[]>(() => sortLocalTracks(loadLocalTracks()))
  const [dirs, setDirs] = useState<string[]>(() => loadLocalDirs())
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<LocalScanProgress | null>(null)
  const [notice, setNotice] = useState('')
  const [missingCount, setMissingCount] = useState(0)
  /** 卸载后不再 setState：扫描可能比页面存活更久 */
  const aliveRef = useRef(true)
  /** 供 effect 读取最新曲目而不必把它放进依赖（否则每加一首就重跑一轮 IO） */
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 订阅主进程扫描进度
  useEffect(() => {
    const cap = platform.localMusic
    if (!cap?.localMusicOnProgress) return
    return cap.localMusicOnProgress((p) => {
      if (aliveRef.current) setProgress(p)
    })
  }, [])

  // 进页面时检查一次文件是否还在，只做标记不删（外接盘没插时不能误删）
  useEffect(() => {
    const cap = platform.localMusic
    const current = tracksRef.current
    if (!cap?.localMusicCheckExists || current.length === 0) return
    let canceled = false
    void cap.localMusicCheckExists(current.map(t => t.localPath || '')).then((res) => {
      if (canceled || !aliveRef.current || !res?.ok) return
      const missing = new Set((res.missing || []).map(p => p.toLowerCase()))
      const count = current.filter(t => t.localPath && missing.has(t.localPath.toLowerCase())).length
      setMissingCount(count)
    })
    return () => {
      canceled = true
    }
    // 只在曲目数量变化时检查一次：用 ref 读最新列表，避免把 tracks 放进依赖后每首歌都触发一轮 IO
  }, [tracks.length])

  /** 扫描一个目录并把结果并进索引 */
  const scanDir = useCallback(async (dir: string) => {
    const cap = platform.localMusic
    if (!cap?.localMusicScan) return
    setScanning(true)
    setNotice('')
    setProgress({ scanned: 0, found: 0, current: dir, skipped: 0 })
    try {
      const res = await cap.localMusicScan(dir)
      if (!aliveRef.current) return
      const text = scanNotice(res)
      if (text) setNotice(text)
      if (!res.ok || !res.files?.length) return

      // 逐首读标签：先走纯 JS 解析（毫秒级），读不出再走 ffmpeg 兜底（约 92ms/首）
      const built: Track[] = []
      for (let i = 0; i < res.files.length; i++) {
        const f = res.files[i]
        if (!aliveRef.current) return
        let tags = null as ReturnType<typeof parseAudioTags>
        const raw = await cap.localMusicReadTags?.(f.filePath)
        if (raw?.ok && raw.head) {
          tags = parseAudioTags(Uint8Array.from(raw.head), raw.tail ? Uint8Array.from(raw.tail) : undefined)
        }
        if (!tags && cap.localMusicReadTagsFallback) {
          const fb = await cap.localMusicReadTagsFallback(f.filePath)
          if (fb?.ok && fb.tags) {
            tags = {
              source: 'none',
              title: fb.tags.title,
              artist: fb.tags.artist,
              album: fb.tags.album,
              duration: fb.tags.duration,
            }
          }
        }
        built.push(buildLocalTrack(f.filePath, tags))
        if (i % 20 === 0) {
          setProgress({ scanned: i + 1, found: res.files.length, current: f.filePath, skipped: res.skipped || 0 })
        }
      }

      const merged = sortLocalTracks(mergeLocalTracks(loadLocalTracks(), built))
      saveLocalTracks(merged)
      setTracks(merged)
      const nextDirs = dirs.includes(dir) ? dirs : [...dirs, dir]
      saveLocalDirs(nextDirs)
      setDirs(nextDirs)
      if (!text) setNotice('已导入 ' + built.length + ' 首本地音乐')
    } catch (err) {
      if (aliveRef.current) setNotice(err instanceof Error ? err.message : '扫描失败')
    } finally {
      if (aliveRef.current) {
        setScanning(false)
        setProgress(null)
      }
    }
  }, [dirs])

  const handlePickDir = useCallback(async () => {
    const cap = platform.localMusic
    if (!cap?.localMusicPickDir) return
    const picked = await cap.localMusicPickDir()
    if (!picked?.ok || !picked.path) return
    await scanDir(picked.path)
  }, [scanDir])

  const handleCancel = useCallback(() => {
    void platform.localMusic?.localMusicCancel?.()
  }, [])

  /** 一键清理失效条目：用户显式点击才删 */
  const handleCleanMissing = useCallback(async () => {
    const cap = platform.localMusic
    if (!cap?.localMusicCheckExists || tracks.length === 0) return
    const res = await cap.localMusicCheckExists(tracks.map(t => t.localPath || ''))
    if (!res?.ok) return
    const missing = new Set((res.missing || []).map(p => p.toLowerCase()))
    const kept = tracks.filter(t => !t.localPath || !missing.has(t.localPath.toLowerCase()))
    const removed = tracks.length - kept.length
    saveLocalTracks(kept)
    setTracks(kept)
    setMissingCount(0)
    setNotice('已清理 ' + removed + ' 条失效条目')
  }, [tracks])

  if (!canUseLocalMusic) {
    return (
      <MusicPageShell>
        <MusicHero eyebrow="资料库" title="本地音乐" subtitle="导入你电脑里的音乐文件" />
        <EmptyLibrary
          icon={<HardDriveDownload size={38} />}
          title="当前平台不支持本地音乐"
          subtitle="本地音乐需要桌面版的目录访问能力"
        />
      </MusicPageShell>
    )
  }

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="资料库"
        title="本地音乐"
        subtitle={tracks.length > 0 ? `${tracks.length} 首本地曲目` : '导入你电脑里的音乐文件'}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {scanning ? (
              <button className="am-action am-action--subtle" onClick={handleCancel}>
                <X size={16} />
                取消扫描
              </button>
            ) : (
              <button className="am-action" onClick={() => { void handlePickDir() }}>
                <FolderOpen size={16} />
                选择目录
              </button>
            )}
            {tracks.length > 0 && (
              <button
                className="am-action am-action--subtle"
                onClick={() => { void handleCleanMissing() }}
                title="检查文件是否还在，清理已删除的条目"
              >
                <Trash2 size={16} />
                清理失效{missingCount > 0 ? `（${missingCount}）` : ''}
              </button>
            )}
          </div>
        }
      />

      {scanning && (
        <div className="local-scan-bar" role="status">
          <RefreshCw size={15} className="local-scan-bar__spin" />
          <span>
            正在扫描…
            {progress ? ` 已发现 ${progress.found} 个音频文件` : ''}
          </span>
          <span className="local-scan-bar__path">{progress?.current || ''}</span>
        </div>
      )}

      {notice && (
        <div className="local-scan-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} title="关闭" aria-label="关闭">
            <X size={14} />
          </button>
        </div>
      )}

      {dirs.length > 0 && (
        <MusicSection title="已导入的目录">
          <div className="local-dir-list">
            {dirs.map((d) => (
              <div key={d} className="local-dir-item">
                <span title={d}>{d}</span>
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => { void scanDir(d) }}
                  title="重新扫描这个目录"
                >
                  <RefreshCw size={13} />
                  重新扫描
                </button>
              </div>
            ))}
          </div>
        </MusicSection>
      )}

      {tracks.length === 0 ? (
        <EmptyLibrary
          icon={<HardDriveDownload size={38} />}
          title="还没有本地音乐"
          subtitle="选择一个目录，扫描其中的 MP3 / FLAC / M4A / WAV / OGG 文件"
        />
      ) : (
        <MusicSection title="本地曲目" icon={<HardDriveDownload size={18} />}>
          <VirtualList
            items={tracks}
            rowHeight={56}
            renderRow={(track, i) => (
              <TrackListRow
                key={track.id}
                track={track}
                index={i + 1}
                isCurrent={player.currentTrack?.id === track.id}
                isPlaying={player.isPlaying}
                onPlay={() => player.playNow(track)}
              />
            )}
          />
        </MusicSection>
      )}
    </MusicPageShell>
  )
}

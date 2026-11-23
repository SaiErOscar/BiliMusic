/**
 * v1.4.15-pre5 本地音乐页：选目录 → 扫描（带进度与取消）→ 建索引 → 浏览。
 *
 * 分层：本页只管界面与状态流转。扫描在 electron/localMusic.ts（主进程读盘），
 * 标签解析在 src/services/audioTags.ts（纯函数），合并/排序/失效判定在
 * src/services/localMusic.ts（纯函数）——这里不复制任何一条业务规则。
 *
 * 能力探测沿用项目口径：platform.localMusic 缺失（非桌面端）时整块入口隐藏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, HardDriveDownload, Heart, RefreshCw, Search, Trash2, X } from 'lucide-react'
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
  LOCAL_SORT_LABELS,
  buildLocalTrack,
  createCoverUrl,
  filterLocalTracks,
  mergeLocalTracks,
  needsRescan,
  scanNotice,
  sortLocalTracks,
  sortLocalTracksBy,
} from '@/services/localMusic'
import type { LocalSortMode } from '@/services/localMusic'
import {
  FAVORITES_CHANGED_EVENT,
  loadFavoriteTracks,
  loadLocalDirs,
  loadLocalTracks,
  saveLocalDirs,
  saveLocalTracks,
} from '@/utils/storage'
import type { Track } from '@/types'
import type { LocalScanProgress } from '@/types/electron'

const canUseLocalMusic = Boolean(platform.localMusic?.localMusicScan && platform.localMusic?.localMusicPickDir)

export default function LocalMusic() {
  const player = usePlayer()
  /** 把收藏库里的 isLiked 标注到本地曲目上（收藏页与本地页共用同一份 id） */
  const withLiked = useCallback((list: Track[]): Track[] => {
    const liked = new Set(loadFavoriteTracks().map(t => t.id))
    return list.map(t => (Boolean(t.isLiked) === liked.has(t.id) ? t : { ...t, isLiked: liked.has(t.id) }))
  }, [])
  const [tracks, setTracks] = useState<Track[]>(() => sortLocalTracks(withLiked(loadLocalTracks())))
  const [dirs, setDirs] = useState<string[]>(() => loadLocalDirs())
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<LocalScanProgress | null>(null)
  const [notice, setNotice] = useState('')
  /** 已确认丢失的文件路径集合（小写）；只用于界面标记，不参与删除判断 */
  const [missingPaths, setMissingPaths] = useState<Set<string>>(() => new Set())
  const missingCount = missingPaths.size
  // v1.4.16-pre1 搜索与排序
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<LocalSortMode>('artist')
  /** 过滤 + 排序后的展示列表（原 tracks 保持完整，用于存盘与失效检查） */
  const visibleTracks = useMemo(
    () => sortLocalTracksBy(filterLocalTracks(tracks, query), sortMode),
    [tracks, query, sortMode],
  )
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

  /*
   * 收藏状态同步（v1.4.16-pre3）：行内收藏按钮改的是收藏库，不是本页 tracks。
   * 监听 FAVORITES_CHANGED_EVENT 把最新 isLiked 贴回列表，否则按钮点亮后
   * 图标不会变（本页是唯一一处收藏入口不在收藏页内的列表）。
   */
  useEffect(() => {
    const refresh = () => {
      if (!aliveRef.current) return
      setTracks(prev => withLiked(prev))
    }
    window.addEventListener(FAVORITES_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(FAVORITES_CHANGED_EVENT, refresh)
  }, [withLiked])

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
      setMissingPaths(missing)
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

      /*
       * v1.4.16-pre2 增量扫描：
       * 先用现有索引建「路径 → 曲目」表，文件 mtime 与 size 都没变就**跳过读标签**，
       * 直接复用已有条目。上千首的曲库重扫时，这一步能把绝大多数文件省掉。
       */
      const existingList = loadLocalTracks()
      const existingByPath = new Map<string, Track>()
      for (const t of existingList) {
        if (t.localPath) existingByPath.set(t.localPath.toLowerCase(), t)
      }

      const built: Track[] = []
      let reused = 0
      for (let i = 0; i < res.files.length; i++) {
        const f = res.files[i]
        if (!aliveRef.current) return

        const meta = { mtime: f.mtime, size: f.size }
        const existing = existingByPath.get(f.filePath.toLowerCase())
        if (!needsRescan(existing, meta) && existing) {
          // 文件没变：沿用旧条目（保留收藏状态、加入时间），只刷新指纹
          built.push({ ...existing, localMtime: meta.mtime, localSize: meta.size })
          reused += 1
          if (i % 20 === 0) {
            setProgress({ scanned: i + 1, found: res.files.length, current: f.filePath, skipped: res.skipped || 0 })
          }
          continue
        }

        // 逐首读标签：先走纯 JS 解析（毫秒级），读不出再走 ffmpeg 兜底（约 92ms/首）
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
        // v1.4.16-pre1：把内嵌封面转成 Blob URL（没有封面则留空走占位图）
        // v1.4.16-pre2：同时记录文件指纹，供下次增量判断
        built.push(buildLocalTrack(f.filePath, tags, createCoverUrl, meta))
        if (i % 20 === 0) {
          setProgress({ scanned: i + 1, found: res.files.length, current: f.filePath, skipped: res.skipped || 0 })
        }
      }

      const merged = sortLocalTracks(mergeLocalTracks(existingList, built))
      saveLocalTracks(merged)
      setTracks(merged)
      const nextDirs = dirs.includes(dir) ? dirs : [...dirs, dir]
      saveLocalDirs(nextDirs)
      setDirs(nextDirs)
      if (!text) {
        setNotice(
          reused > 0
            ? `已导入 ${built.length} 首本地音乐（${reused} 首未变化，已跳过重读）`
            : '已导入 ' + built.length + ' 首本地音乐',
        )
      }
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

  /**
   * v1.4.16-pre1 移除一个已导入的目录。
   *
   * 只从「已导入目录」列表里移除，**不删曲目**——曲目可能来自多个目录，
   * 也可能用户只是不想再看到这个目录的重新扫描入口。要清曲目用「清理失效」。
   */
  const handleRemoveDir = useCallback((dir: string) => {
    const next = dirs.filter((d) => d !== dir)
    saveLocalDirs(next)
    setDirs(next)
    setNotice('已移除目录：' + dir + '（曲目仍保留）')
  }, [dirs])

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
    setMissingPaths(new Set())
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
                <button
                  type="button"
                  className="local-dir-remove"
                  onClick={() => handleRemoveDir(d)}
                  title="从这个列表移除（不删除曲目）"
                >
                  <Trash2 size={13} />
                  移除
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
          {/* v1.4.16-pre1 搜索与排序 */}
          <div className="local-toolbar">
            <div className="local-search">
              <Search size={14} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题或歌手"
                aria-label="搜索本地曲目"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} title="清空" aria-label="清空搜索">
                  <X size={13} />
                </button>
              )}
            </div>
            <select
              className="local-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as LocalSortMode)}
              aria-label="排序方式"
            >
              {(Object.keys(LOCAL_SORT_LABELS) as LocalSortMode[]).map((m) => (
                <option key={m} value={m}>{LOCAL_SORT_LABELS[m]}</option>
              ))}
            </select>
            {query && (
              <span className="local-filter-count">
                {visibleTracks.length} / {tracks.length}
              </span>
            )}
          </div>
          {visibleTracks.length === 0 ? (
            <p className="local-empty-filter">没有匹配「{query}」的曲目</p>
          ) : (
          <VirtualList
            items={visibleTracks}
            rowHeight={56}
            renderRow={(track, i) => (
              <TrackListRow
                key={track.id}
                track={track}
                index={i + 1}
                isCurrent={player.currentTrack?.id === track.id}
                isPlaying={player.isPlaying}
                onPlay={() => player.playNow(track)}
                extra={
                  <div className="am-extra-actions">
                    {track.localPath && missingPaths.has(track.localPath.toLowerCase()) && (
                      <span className="local-track-missing" title="文件已丢失，可能被移动或删除">已丢失</span>
                    )}
                    <button
                      className="am-icon-button"
                      onClick={(e) => { e.stopPropagation(); player.toggleLike(track.id, track) }}
                      title={track.isLiked ? '取消收藏' : '收藏'}
                      aria-label={track.isLiked ? '取消收藏' : '收藏'}
                      aria-pressed={Boolean(track.isLiked)}
                    >
                      <Heart size={16} fill={track.isLiked ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                }
              />
            )}
          />
          )}
        </MusicSection>
      )}
    </MusicPageShell>
  )
}

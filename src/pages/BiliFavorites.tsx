import { useState, useEffect, useCallback } from 'react'
import { Play, Loader2, FolderHeart, Check, ChevronDown, Download, ListPlus, X } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useAuth } from '@/contexts/AuthContext'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
  TrackList,
  TrackListRow,
} from '@/components/AppleMusicPage'
import TrackActions from '@/components/TrackActions'
import type { Track } from '@/types'
import type { FavoriteFolder, FavoriteItem } from '@/services/bilibiliApi'
import BatchDownloadDialog from '@/components/BatchDownloadDialog'
import { showBatchDialog } from '@/services/batchDownloadStore'
import { createPlaylist, addTrackToPlaylist, PLAYLISTS_CHANGED_EVENT } from '@/utils/storage'
import { listBiliFavoriteFolders } from '@/services/biliFavorites'
import {
  getFavoriteFolderContent,
  toHttpsUrl,
  dealFavorite,
} from '@/services/bilibiliApi'

const SYNCED_FOLDER_KEY = 'bilimusic_synced_folder'

function favoriteItemToTrack(item: FavoriteItem): Track {
  return {
    id: item.bvid,
    title: item.title?.replace(/<[^>]+>/g, '') || item.bvid,
    artist: item.upper?.name || '未知UP主',
    coverUrl: toHttpsUrl(item.cover || item.pic),
    duration: item.duration || 0,
    videoUrl: `https://www.bilibili.com/video/${item.bvid}`,
    bvid: item.bvid,
    aid: item.aid || item.id,
    cid: item.cid,
    playCount: item.cnt_info?.play || 0,
    isLiked: false,
  }
}

export default function BiliFavorites() {
  const player = usePlayer()
  const { isLoggedIn } = useAuth()
  const [folders, setFolders] = useState<FavoriteFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState<number | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false)
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [exportMessage, setExportMessage] = useState('')

  // Load folders on mount
  const loadFolders = useCallback(async () => {
    if (!isLoggedIn) return
    setLoadingFolders(true)
    try {
      const data = await listBiliFavoriteFolders()
      setFolders(data.list || [])
      // Default to the synced folder or first folder
      const savedFolderId = localStorage.getItem(SYNCED_FOLDER_KEY)
      const defaultFolder = savedFolderId
        ? data.list?.find(f => f.id === Number(savedFolderId))
        : null
      const targetFolder = defaultFolder || data.list?.[0]
      if (targetFolder) {
        setSelectedFolder(targetFolder.id)
        loadFolderContent(targetFolder.id)
      }
      // 打开收藏夹页面时请求立即同步
      window.dispatchEvent(new CustomEvent('bilimusic:bili-favorites-sync-request'))
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : '获取收藏夹列表失败')
    } finally {
      setLoadingFolders(false)
    }
  }, [isLoggedIn])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  // Load folder content
  const loadFolderContent = useCallback(async (folderId: number) => {
    setLoadingContent(true)
    setTracks([])
    try {
      let page = 1
      const all: Track[] = []
      while (true) {
        const data = await getFavoriteFolderContent(folderId, page, 20)
        if (data.medias?.length) {
          all.push(...data.medias.map(favoriteItemToTrack))
        }
        if (!data.has_more) break
        page++
        if (page > 50) break
      }
      setTracks(all)
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : '加载收藏夹内容失败')
    } finally {
      setLoadingContent(false)
    }
  }, [])

  const handleFolderChange = (folderId: number) => {
    setSelectedFolder(folderId)
    localStorage.setItem(SYNCED_FOLDER_KEY, String(folderId))
    setFolderDropdownOpen(false)
    loadFolderContent(folderId)
    // 切换收藏夹时请求立即同步
    window.dispatchEvent(new CustomEvent('bilimusic:bili-favorites-sync-request'))
  }

  const handleRemoveTrack = async (track: Track) => {
    if (!selectedFolder) return
    // deal 接口 rid 支持 aid 或 bvid：优先 aid，缺失则用 bvid 兜底
    const rid: number | string = track.aid ? Number(track.aid) : (track.bvid || track.id)
    if (!rid) return
    try {
      await dealFavorite(rid, [], [selectedFolder])
      setSyncMessage(`已从收藏夹移除「${track.title}」`)
      await loadFolderContent(selectedFolder)
      // 触发收藏变更自动同步
      window.dispatchEvent(new CustomEvent('bilimusic:bili-favorites-changed'))
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : '移除失败')
    }
  }

  const handleExportToPlaylist = () => {
    if (!tracks.length || !selectedFolderInfo) return
    const playlist = createPlaylist({
      name: selectedFolderInfo.title,
      description: `从 B站收藏夹导入 · ${new Date().toLocaleDateString()}`,
      coverUrl: tracks[0]?.coverUrl || '',
    })
    for (const track of tracks) {
      addTrackToPlaylist(playlist.id, track)
    }
    window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT))
    setExportMessage(`已导出 ${tracks.length} 首到歌单「${selectedFolderInfo.title}」`)
    setTimeout(() => setExportMessage(''), 4000)
  }

  const handleBatchDownload = () => {
    setBatchDownloading(true)
    // 确保对话框可见：首次打开时 store.visible 为 false，需手动置为 true；
    // 已有后台任务时则恢复显示进度
    showBatchDialog()
  }

  const handlePlayAll = () => {
    if (tracks.length > 0) player.playAll(tracks)
  }

  const selectedFolderInfo = folders.find(f => f.id === selectedFolder)

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Bilibili Favorites"
        title="B站收藏夹"
        subtitle={
          selectedFolderInfo
            ? `${selectedFolderInfo.title} · ${selectedFolderInfo.media_count} 个内容`
            : '登录后同步你的 Bilibili 收藏夹'
        }
        tone="pink"
        action={isLoggedIn && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* 收藏夹选择器 */}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setFolderDropdownOpen(o => !o)}
                disabled={loadingFolders}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 14px',
                  borderRadius: 999,
                  border: '1px solid var(--glass-border)',
                  background: 'var(--glass-bg)',
                  color: 'var(--color-foreground)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <FolderHeart size={15} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
                  {selectedFolderInfo?.title || '选择收藏夹'}
                </span>
                <ChevronDown size={14} />
              </button>
              {folderDropdownOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onClick={() => setFolderDropdownOpen(false)} />
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    marginTop: 6,
                    minWidth: 200,
                    maxHeight: 300,
                    overflowY: 'auto',
                    padding: 6,
                    borderRadius: 12,
                    background: 'var(--glass-bg-heavy)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    border: '1px solid var(--glass-border)',
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 9999,
                  }}>
                    {folders.map(f => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => handleFolderChange(f.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          width: '100%',
                          padding: '8px 12px',
                          border: 'none',
                          borderRadius: 8,
                          background: selectedFolder === f.id ? 'var(--sidebar-active-bg)' : 'transparent',
                          color: 'var(--color-foreground)',
                          fontSize: 13,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {f.title}
                        </span>
                        <span style={{ color: 'var(--color-muted)', fontSize: 11, flexShrink: 0, marginLeft: 8 }}>
                          {f.media_count}
                        </span>
                        {selectedFolder === f.id && <Check size={14} style={{ marginLeft: 4 }} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {tracks.length > 0 && (
              <>
                <ActionButton tone="subtle" onClick={handleBatchDownload}>
                  <Download size={15} />
                  下载全部
                </ActionButton>
                <ActionButton tone="subtle" onClick={handleExportToPlaylist}>
                  <ListPlus size={15} />
                  导出为歌单
                </ActionButton>
                <ActionButton onClick={handlePlayAll}>
                  <Play size={16} fill="currentColor" />
                  播放全部
                </ActionButton>
              </>
            )}
          </div>
        )}
      />

      {syncMessage && (
        <div style={{
          margin: '0 24px 12px',
          padding: '10px 16px',
          borderRadius: 12,
          background: 'var(--glass-bg)',
          color: 'var(--color-foreground)',
          fontSize: 13,
        }}>
          {syncMessage}
        </div>
      )}

      {exportMessage && (
        <div style={{
          margin: '0 24px 12px',
          padding: '10px 16px',
          borderRadius: 12,
          background: 'rgba(48, 209, 88, 0.12)',
          color: '#30d158',
          fontSize: 13,
        }}>
          {exportMessage}
        </div>
      )}

      {!isLoggedIn ? (
        <EmptyLibrary
          icon={<FolderHeart size={40} />}
          title="请先登录 Bilibili 账号"
          subtitle="在设置页面扫码登录后即可查看和同步收藏夹"
        />
      ) : loadingContent ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Loader2 size={28} className="spin" style={{ margin: '0 auto 8px' }} />
          <p style={{ color: 'var(--color-muted)', fontSize: 13 }}>正在加载收藏夹内容...</p>
        </div>
      ) : tracks.length === 0 ? (
        <EmptyLibrary
          icon={<FolderHeart size={40} />}
          title="收藏夹为空"
          subtitle="选择一个收藏夹来查看内容"
        />
      ) : (
        <MusicSection title="收藏内容" icon={<FolderHeart size={22} />}>
          <TrackList>
            {tracks.map((track, index) => (
              <TrackListRow
                key={track.id + String(index)}
                track={track}
                index={index + 1}
                isCurrent={player.currentTrack?.id === track.id}
                isPlaying={player.isPlaying}
                onPlay={() => player.playNow(track)}
                extra={(
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <TrackActions track={track} size={15} />
                    <button
                      title="从收藏夹移除"
                      onClick={(e) => { e.stopPropagation(); void handleRemoveTrack(track) }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 28, height: 28, borderRadius: 8, border: 'none',
                        background: 'transparent', color: 'var(--color-muted)', cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )}
              />
            ))}
          </TrackList>
        </MusicSection>
      )}
      {batchDownloading && (
        <BatchDownloadDialog
          tracks={tracks}
          onClose={() => setBatchDownloading(false)}
        />
      )}
    </MusicPageShell>
  )
}

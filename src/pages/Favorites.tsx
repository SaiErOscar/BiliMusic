import { useState, useCallback, useEffect } from 'react'
import { Heart, Play, X, RefreshCw, Download as DownloadIcon, Loader2, FolderSync } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useAuth } from '@/contexts/AuthContext'
import AddToPlaylistButton from '@/components/AddToPlaylistButton'
import { loadFavoriteTracks, removeFavoriteTrack, FAVORITES_CHANGED_EVENT } from '@/utils/storage'
import { listBiliFavoriteFolders, importBiliFavorites, syncBiliFavorites, type BiliSyncResult } from '@/services/biliFavorites'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
  TrackList,
  TrackListRow,
  defaultIconFor,
} from '@/components/AppleMusicPage'
import type { Track } from '@/types'
import type { FavoriteFolder } from '@/services/bilibiliApi'

export default function Favorites() {
  const [tracks, setTracks] = useState<Track[]>(() => loadFavoriteTracks())
  const player = usePlayer()
  const { isLoggedIn } = useAuth()

  // B站收藏夹同步状态
  const [syncOpen, setSyncOpen] = useState(false)
  const [folders, setFolders] = useState<FavoriteFolder[]>([])
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')

  useEffect(() => {
    const refresh = () => setTracks(loadFavoriteTracks())
    window.addEventListener(FAVORITES_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(FAVORITES_CHANGED_EVENT, refresh)
  }, [])

  const handleRemove = useCallback((trackId: string) => {
    setTracks(removeFavoriteTrack(trackId)) // 记墓碑，确保同步不复活
  }, [])

  const handlePlayAll = useCallback(() => {
    if (tracks.length > 0) player.playAll(tracks)
  }, [tracks, player])

  const heroImage = tracks[0]?.coverUrl

  const openSync = async () => {
    setSyncOpen(true)
    setSyncMessage('')
    if (isLoggedIn) {
      setLoadingFolders(true)
      try {
        const data = await listBiliFavoriteFolders()
        setFolders(data.list || [])
      } catch (e) {
        setSyncMessage(e instanceof Error ? e.message : '获取收藏夹失败')
      } finally {
        setLoadingFolders(false)
      }
    }
  }

  const handleImport = async (folderId: number) => {
    setSyncing(true)
    setSyncMessage('正在导入...')
    try {
      const result: BiliSyncResult = await importBiliFavorites(folderId)
      setSyncMessage(result.message)
      setTracks(loadFavoriteTracks())
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : '导入失败')
    } finally {
      setSyncing(false)
    }
  }

  const handleSync = async (folderId: number) => {
    setSyncing(true)
    setSyncMessage('正在双向同步...')
    try {
      const result: BiliSyncResult = await syncBiliFavorites(folderId)
      setSyncMessage(result.message)
      setTracks(loadFavoriteTracks())
    } catch (e) {
      setSyncMessage(e instanceof Error ? e.message : '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Favorites"
        title="我喜欢"
        subtitle={tracks.length ? `收藏的 ${tracks.length} 首歌曲都在这里。` : '点击歌曲旁的心形按钮收藏喜欢的音乐。'}
        image={heroImage}
        tone="red"
        action={(
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionButton tone="subtle" onClick={openSync}>
              <FolderSync size={16} />
              B站收藏同步
            </ActionButton>
            {tracks.length > 0 && (
              <ActionButton onClick={handlePlayAll}>
                <Play size={17} fill="currentColor" />
                播放全部
              </ActionButton>
            )}
          </div>
        )}
      />

      {tracks.length === 0 ? (
        <EmptyLibrary icon={defaultIconFor('favorites')} title="暂无收藏" subtitle="喜欢的歌曲会以更精致的列表在这里出现。" />
      ) : (
        <MusicSection title="收藏曲目" icon={<Heart size={22} />}>
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
                  <div className="am-extra-actions">
                    <AddToPlaylistButton track={track} size={15} />
                    <button className="am-icon-danger" onClick={(e) => { e.stopPropagation(); handleRemove(track.id) }} title="取消收藏">
                      <X size={16} />
                    </button>
                  </div>
                )}
              />
            ))}
          </TrackList>
        </MusicSection>
      )}

      {/* B站收藏夹同步弹窗 */}
      {syncOpen && (
        <div
          className="playlist-dialog-backdrop"
          onClick={() => !syncing && setSyncOpen(false)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            className="playlist-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 480, width: '90vw' }}
          >
            <div className="playlist-dialog__head">
              <div>
                <p>Bilibili Favorites</p>
                <h2>B站收藏夹同步</h2>
              </div>
              <button type="button" onClick={() => !syncing && setSyncOpen(false)} disabled={syncing}>
                <X size={18} />
              </button>
            </div>

            {!isLoggedIn ? (
              <div style={{ padding: '24px 0', textAlign: 'center' }}>
                <p style={{ color: 'var(--color-muted)', marginBottom: 12 }}>请先在设置中扫码登录 Bilibili 账号</p>
              </div>
            ) : loadingFolders ? (
              <div style={{ padding: '24px 0', textAlign: 'center' }}>
                <Loader2 size={24} className="spin" style={{ margin: '0 auto 8px' }} />
                <p style={{ color: 'var(--color-muted)' }}>正在获取收藏夹列表...</p>
              </div>
            ) : (
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {folders.length === 0 ? (
                  <p style={{ color: 'var(--color-muted)', textAlign: 'center', padding: '16px 0' }}>
                    未找到收藏夹
                  </p>
                ) : (
                  folders.map((folder) => (
                    <div
                      key={folder.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px 14px',
                        borderRadius: 10,
                        border: '1px solid var(--glass-border)',
                        marginBottom: 8,
                        background: 'var(--glass-bg)',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <strong style={{ display: 'block', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {folder.title}
                        </strong>
                        <small style={{ color: 'var(--color-muted)' }}>{folder.media_count} 个内容</small>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => handleImport(folder.id)}
                          disabled={syncing}
                          style={{
                            padding: '6px 12px',
                            borderRadius: 8,
                            border: '1px solid var(--glass-border)',
                            background: 'transparent',
                            color: 'var(--color-foreground)',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: syncing ? 'wait' : 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          <DownloadIcon size={13} style={{ display: 'inline', marginRight: 4 }} />
                          导入
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSync(folder.id)}
                          disabled={syncing}
                          style={{
                            padding: '6px 12px',
                            borderRadius: 8,
                            border: 'none',
                            background: 'var(--color-primary)',
                            color: '#fff',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: syncing ? 'wait' : 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          <RefreshCw size={13} style={{ display: 'inline', marginRight: 4 }} />
                          同步
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {syncMessage && (
              <p style={{
                marginTop: 12,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'var(--glass-bg)',
                color: 'var(--color-foreground)',
                fontSize: 13,
                textAlign: 'center',
              }}>
                {syncMessage}
              </p>
            )}

            <div className="playlist-dialog__actions">
              <button type="button" onClick={() => !syncing && setSyncOpen(false)} disabled={syncing}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </MusicPageShell>
  )
}

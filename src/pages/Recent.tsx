import { useState, useCallback, useEffect } from 'react'
import { Clock, Play, Trash2, X } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { loadRecentTracks, saveRecentTracks } from '@/utils/storage'
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

export default function Recent() {
  const [tracks, setTracks] = useState<Track[]>(() => loadRecentTracks())
  const player = usePlayer()

  // 监听播放记录变化（跨页面同步）
  useEffect(() => {
    const sync = () => setTracks(loadRecentTracks())
    window.addEventListener('storage', sync)
    window.addEventListener('bilimusic:recent-changed', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('bilimusic:recent-changed', sync)
    }
  }, [])

  const handleClear = useCallback(() => {
    saveRecentTracks([])
    setTracks([])
  }, [])

  // 单条记录删除（pre3）：按 id 从最近播放移除
  const handleRemoveOne = useCallback((trackId: string) => {
    const next = loadRecentTracks().filter((t) => t.id !== trackId)
    saveRecentTracks(next)
    setTracks(next)
  }, [])

  const handlePlayAll = useCallback(() => {
    if (tracks.length > 0) player.playAll(tracks)
  }, [tracks, player])

  const heroImage = tracks[0]?.coverUrl

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Recently Played"
        title="最近播放"
        subtitle={tracks.length ? `继续回到刚刚听过的 ${tracks.length} 首音乐。` : '播放歌曲后，最近听过的内容会在这里聚合。'}
        image={heroImage}
        tone="blue"
        action={tracks.length > 0 && (
          <>
            <ActionButton onClick={handlePlayAll}>
              <Play size={17} fill="currentColor" />
              播放全部
            </ActionButton>
            <ActionButton onClick={handleClear} tone="subtle">
              <Trash2 size={16} />
              清空
            </ActionButton>
          </>
        )}
      />

      {tracks.length === 0 ? (
        <EmptyLibrary icon={defaultIconFor('recent')} title="暂无播放记录" subtitle="播放歌曲后将在此显示。" />
      ) : (
        <MusicSection title="播放记录" icon={<Clock size={22} />}>
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
                  <button
                    className="am-icon-danger"
                    onClick={(e) => { e.stopPropagation(); handleRemoveOne(track.id) }}
                    title="删除这条播放记录"
                  >
                    <X size={16} />
                  </button>
                )}
              />
            ))}
          </TrackList>
        </MusicSection>
      )}
    </MusicPageShell>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Clock, Download, FolderHeart, Heart } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import { useAuth } from '@/contexts/AuthContext'
import {
  getFavoriteFolderContent,
  toHttpsUrl,
  type FavoriteItem,
} from '@/services/bilibiliApi'
import {
  DOWNLOADS_CHANGED_EVENT,
  FAVORITES_CHANGED_EVENT,
  loadBiliFolderCache,
  loadDownloadRecords,
  loadFavoriteTracks,
  loadRecentTracks,
  getSyncedBiliFolderId,
  saveBiliFolderCache,
} from '@/utils/storage'
import { MusicHero, MusicPageShell, LibraryCard, type LibraryItem } from '@/components/AppleMusicPage'
import type { DownloadRecord, Track } from '@/types'

/** 每张卡片横向展示的最大条数 */
const PREVIEW_COUNT = 6

/** 最近播放 / 我喜欢条目已是 Track，直接映射为卡片单元 */
function trackToItem(track: Track): LibraryItem {
  return {
    id: track.id,
    title: track.title,
    subtitle: track.artist,
    coverUrl: track.coverUrl,
  }
}

/** 下载记录无封面，映射为卡片单元（封面位显示占位图标） */
function downloadToItem(record: DownloadRecord): LibraryItem {
  return {
    id: record.id,
    title: record.title,
    subtitle: record.artist || (record.format === 'video' ? '视频' : '音频'),
  }
}

/** B 站收藏夹条目转 Track（与 BiliFavorites 页保持一致的清洗规则） */
function favoriteToTrack(item: FavoriteItem): Track {
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

export default function Discover() {
  const player = usePlayer()
  const { isLoggedIn, setShowLogin } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const [recent, setRecent] = useState<Track[]>([])
  const [favorites, setFavorites] = useState<Track[]>([])
  const [downloads, setDownloads] = useState<DownloadRecord[]>([])
  const [biliFolderTracks, setBiliFolderTracks] = useState<Track[]>([])
  const [biliFolderId, setBiliFolderId] = useState<number | null>(null)
  const [biliLoading, setBiliLoading] = useState(false)

  // 读取本地三张卡片数据（同步，无网络）
  const refreshLocal = useCallback(() => {
    setRecent(loadRecentTracks())
    setFavorites(loadFavoriteTracks())
    setDownloads(loadDownloadRecords())
  }, [])

  // 读取 B 站收藏夹卡片：跟随「当前打开的夹」，优先本地缓存，无缓存异步拉取
  const refreshBiliFolder = useCallback(async () => {
    const folderId = getSyncedBiliFolderId()
    setBiliFolderId(folderId)
    if (!folderId || !isLoggedIn) {
      setBiliFolderTracks(folderId ? loadBiliFolderCache(folderId) : [])
      return
    }
    const cached = loadBiliFolderCache(folderId)
    if (cached.length > 0) {
      setBiliFolderTracks(cached)
      // 有缓存先展示，后台静默刷新最新
    } else {
      setBiliLoading(true)
    }
    try {
      const all: Track[] = []
      let page = 1
      while (true) {
        const data = await getFavoriteFolderContent(folderId, page, 20)
        if (data.medias?.length) all.push(...data.medias.map(favoriteToTrack))
        if (!data.has_more) break
        page++
        if (page > 50) break
      }
      all.sort((a, b) => {
        const at = a.likedAt ? new Date(a.likedAt).getTime() : 0
        const bt = b.likedAt ? new Date(b.likedAt).getTime() : 0
        return bt - at
      })
      setBiliFolderTracks(all)
      saveBiliFolderCache(folderId, all)
    } catch {
      // 拉取失败：保留已有缓存展示（无缓存则维持空态），不报错
      if (cached.length === 0) setBiliFolderTracks([])
    } finally {
      setBiliLoading(false)
    }
  }, [isLoggedIn])

  // 首次挂载 + 每次切回本页时重新拉取，保证四卡内容跟随最新
  useEffect(() => {
    refreshLocal()
    void refreshBiliFolder()
  }, [location.pathname, refreshLocal, refreshBiliFolder])

  // 本地数据变更事件驱动刷新（收藏 / 最近播放 / 下载）
  useEffect(() => {
    const onFav = () => refreshLocal()
    const onRecent = () => refreshLocal()
    const onDownload = () => refreshLocal()
    window.addEventListener(FAVORITES_CHANGED_EVENT, onFav)
    window.addEventListener('bilimusic:recent-changed', onRecent)
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, onDownload)
    return () => {
      window.removeEventListener(FAVORITES_CHANGED_EVENT, onFav)
      window.removeEventListener('bilimusic:recent-changed', onRecent)
      window.removeEventListener(DOWNLOADS_CHANGED_EVENT, onDownload)
    }
  }, [refreshLocal])

  // 条目播放：三张曲目型卡片按 id 回查 Track 后 playNow
  const playItemByTrack = useCallback((items: Track[]) => (item: LibraryItem) => {
    const track = items.find((t) => t.id === item.id)
    if (track) player.playNow(track)
  }, [player])

  // 下载条目：与下载页一致，用系统默认浏览器打开原链接（无本地文件播放能力）
  const openDownload = useCallback((item: LibraryItem) => {
    const record = downloads.find((d) => d.id === item.id)
    if (record) window.electronAPI?.openExternal?.(`https://www.bilibili.com/video/${record.bvid}`)
  }, [downloads])

  const biliItems = biliFolderTracks.map(trackToItem)

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="你的音乐库"
        title="发现页"
        subtitle="最近播放、收藏、B 站收藏夹和本地下载，都收在一处，点开即可继续听。"
        tone="pink"
      />

      <LibraryCard
        icon={<Clock size={20} />}
        title="最近播放"
        count={recent.length}
        items={recent.slice(0, PREVIEW_COUNT).map(trackToItem)}
        emptyText="还没有播放记录，随便听一首就会出现在这里。"
        onMore={() => navigate('/recent')}
        onItemPlay={playItemByTrack(recent)}
      />

      <LibraryCard
        icon={<Heart size={20} />}
        title="我喜欢"
        count={favorites.length}
        items={favorites.slice(0, PREVIEW_COUNT).map(trackToItem)}
        emptyText="还没有收藏，在播放页或列表点❤即可收藏。"
        onMore={() => navigate('/favorites')}
        onItemPlay={playItemByTrack(favorites)}
      />

      <LibraryCard
        icon={<FolderHeart size={20} />}
        title="B 站收藏夹"
        count={biliFolderTracks.length}
        loading={biliLoading}
        items={biliItems.slice(0, PREVIEW_COUNT)}
        emptyText={
          isLoggedIn
            ? (biliFolderId ? '这个收藏夹暂时是空的，去收藏夹页添加一些内容吧。' : '还没有选择过收藏夹，先去收藏夹页打开一个。')
            : '登录后可同步你的收藏夹。'
        }
        action={
          !isLoggedIn ? (
            <button type="button" className="am-library-login" onClick={() => setShowLogin(true)}>
              登录
            </button>
          ) : undefined
        }
        onMore={() => navigate('/bili-favorites')}
        onItemPlay={playItemByTrack(biliFolderTracks)}
      />

      <LibraryCard
        icon={<Download size={20} />}
        title="本地下载"
        count={downloads.length}
        unit="个"
        items={downloads.slice(0, PREVIEW_COUNT).map(downloadToItem)}
        emptyText="还没有下载，在播放页或控制栏点击下载按钮。"
        onMore={() => navigate('/downloads')}
        onItemPlay={openDownload}
      />
    </MusicPageShell>
  )
}

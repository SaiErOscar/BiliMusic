/**
 * biliMusic API 适配层
 *
 * 渲染层直接通过浏览器 fetch 调用 B站 API（主进程已通过 webRequest 绕过 CORS）。
 * 主进程仅保留下载、扫码登录、Cookie 管理等无法在渲染层完成的 IPC。
 */

import {
  searchVideo as rendererSearch,
  getVideoDetail as rendererDetail,
  getVideoComments as rendererComments,
  extractAudioFromVideo,
  getMusicRanking as rendererRanking,
  getMusicComprehensiveRank,
  getNewMusic,
  searchUser,
  getUserVideos as rendererUserVideos,
  getRecommendedVideos as rendererRec,
  getPopularVideos as rendererPopular,
  getNavInfo,
  generateQrCode as rendererGen,
  pollQrCode as rendererPoll,
  getPlayUrl,
  getBestAudioUrl,
  getBestVideoUrl,
  type TrackSource,
} from '@/services/bilibiliApi'
import { clearBilibiliAuthCookies } from '@/services/http'

// ===== 搜索 =====

export interface SearchItem {
  bvid: string
  aid: number
  title: string
  author: string
  play: number
  duration: string
  pic: string
}

function normalizePic(pic: string): string {
  if (!pic) return ''
  if (pic.startsWith('https://')) return pic
  if (pic.startsWith('http://')) return pic.replace('http://', 'https://')
  if (pic.startsWith('//')) return `https:${pic}`
  return `https:${pic}`
}

export async function searchVideo(keyword: string, page = 1, pageSize = 20): Promise<{ items: SearchItem[]; totalPages: number; totalResults: number }> {
  const mapItem = (item: any): SearchItem => ({
    bvid: item.bvid,
    aid: item.aid,
    title: item.title?.replace(/<[^>]+>/g, ''),
    author: item.author,
    play: item.play,
    duration: item.duration,
    pic: normalizePic(item.pic),
  })
  const data = await rendererSearch(keyword, page, pageSize)
  const totalResults = data.numResults || 0
  return {
    items: data.result?.map(mapItem) || [],
    totalPages: data.numPages || Math.ceil(totalResults / pageSize),
    totalResults,
  }
}

// ===== 视频详情 =====

export interface VideoInfo {
  bvid: string
  aid: number
  title: string
  desc: string
  pic: string
  ownerName: string
  ownerMid: number
  duration: number
  cid: number
  stat: {
    view: number
    like: number
    favorite: number
  }
}

export async function getVideoDetail(bvid: string): Promise<VideoInfo> {
  const data = await rendererDetail(bvid)
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    desc: data.desc?.substring(0, 100),
    pic: data.pic,
    ownerName: data.owner?.name,
    ownerMid: data.owner?.mid,
    duration: data.duration,
    cid: data.cid,
    stat: {
      view: data.stat?.view,
      like: data.stat?.like,
      favorite: data.stat?.favorite,
    },
  }
}

// ===== 评论 =====

export interface VideoComment {
  id: number
  author: string
  avatar: string
  message: string
  like: number
  replyCount: number
  createdAt: number
}

export async function getVideoComments(
  target: { bvid?: string; aid?: string | number },
  page = 1,
  pageSize = 20,
): Promise<{ items: VideoComment[]; total: number }> {
  let oid = 0

  if (target.bvid) {
    try {
      const detail = await rendererDetail(target.bvid)
      oid = Number(detail.aid) || 0
    } catch {
      oid = 0
    }
  }

  if (!oid) {
    oid = Number(target.aid) || 0
  }

  if (!oid) {
    throw new Error('无法获取当前视频的评论区 ID')
  }

  const data = await rendererComments(oid, page, pageSize)
  const replies = data.replies || []
  return {
    items: replies.map((reply) => ({
      id: reply.rpid,
      author: reply.member?.uname || 'Bilibili 用户',
      avatar: normalizePic(reply.member?.avatar || ''),
      message: reply.content?.message || '',
      like: reply.like || 0,
      replyCount: reply.rcount || 0,
      createdAt: reply.ctime || 0,
    })),
    total: data.page?.count || replies.length,
  }
}

// ===== 提取音频 =====

export async function extractAudio(
  bvid: string,
  fallback?: { aid?: string | number; cid?: string | number },
  quality?: import('@/services/bilibiliApi').AudioQualityPreference,
): Promise<TrackSource> {
  return extractAudioFromVideo(bvid, fallback, quality)
}

// ===== 下载 =====

export async function downloadAudio(
  audioUrl: string,
  filename: string,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.downloadAudio(audioUrl, filename, customDir, options)
  }

  throw new Error('Audio download requires Electron environment')
}

export async function downloadVideo(
  videoUrl: string,
  audioUrl: string,
  filename: string,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.downloadVideo(videoUrl, audioUrl, filename, customDir, options)
  }

  throw new Error('Video download requires Electron environment')
}

export async function openDownloadDir(dirPath?: string): Promise<void> {
  if (window.electronAPI?.biliApi) {
    await window.electronAPI.biliApi.openDownloadDir(dirPath)
  }
}

export async function selectDownloadFolder(): Promise<string | null> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.selectDownloadFolder()
  }
  return null
}

export async function saveLyricFile(content: string, filePath: string): Promise<void> {
  if (window.electronAPI?.biliApi) {
    await window.electronAPI.biliApi.saveLyricFile(content, filePath)
  }
}

/**
 * 下载当前播放曲目（音频或视频）
 * 需要先获取播放地址，再根据格式选择下载方式
 */
export async function downloadTrack(
  bvid: string,
  fallback: { aid?: string | number; cid?: string | number },
  title: string,
  format: 'audio' | 'video',
  quality: import('@/services/bilibiliApi').AudioQualityPreference,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {
  
  // 获取播放地址
  let cid: number | undefined
  try {
    const detail = await getVideoDetail(bvid)
    cid = detail.cid
  } catch {
    cid = undefined
  }

  if (!cid && fallback.cid) {
    cid = Number(fallback.cid)
  }
  if (!cid) throw new Error('无法获取视频 cid')

  const playData = await getPlayUrl(bvid, cid)
  const audioUrl = getBestAudioUrl(playData, quality)
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').trim()

  if (format === 'audio') {
    const ext = audioUrl.includes('.flac') ? '.flac' : '.m4a'
    return downloadAudio(audioUrl, `${safeTitle}${ext}`, customDir, options)
  } else {
    const videoUrl = getBestVideoUrl(playData)
    return downloadVideo(videoUrl, audioUrl, `${safeTitle}.mp4`, customDir, options)
  }
}

// ===== 用户信息 =====

export async function getUserInfo(): Promise<{ isLogin: boolean; mid: number; uname: string; face: string }> {
  const data = await getNavInfo()
  return {
    isLogin: data.isLogin,
    mid: data.mid,
    uname: data.uname,
    face: data.face || '',
  }
}

// ===== 音乐排行榜 =====

export async function getMusicRanking(): Promise<VideoInfo[]> {
  const parseItem = (v: any): VideoInfo => {
    const dur = typeof v.duration === 'string'
      ? v.duration.split(':').reduce((acc: number, t: string) => acc * 60 + parseInt(t), 0)
      : (v.duration || 0)
    return {
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      desc: v.description || v.desc || '',
      pic: normalizePic(v.pic),
      ownerName: v.author || v.owner?.name || '',
      ownerMid: v.mid || v.owner?.mid || 0,
      duration: dur,
      cid: v.cid || 0,
      stat: {
        view: v.play || v.stat?.view || 0,
        like: v.stat?.like || 0,
        favorite: v.favorites || v.stat?.favorite || 0,
      },
    }
  }
  const data = await rendererRanking()
  return (Array.isArray(data) ? data : (data as any).list || (data as any).data || []).map(parseItem)
}

// ===== 音乐中心（music.bilibili.com/pc/music-center 同源数据） =====

export interface MusicSong {
  bvid: string
  aid: string
  cid: string
  title: string
  artist: string
  coverUrl: string
  album: string
  publishTime?: string
}

// 综合榜顶层 bvid 是 music-metadata 伪 id（/x/web-interface/view 返回 -404），
// 实际可播放稿件在 related_archive.bvid；新歌无 related_archive，用顶层 bvid。
function playableBvid(x: import('@/services/bilibiliApi').MusicCenterItem): string {
  return x.related_archive?.bvid || x.bvid
}

function mapMusicSong(x: import('@/services/bilibiliApi').MusicCenterItem): MusicSong {
  return {
    bvid: playableBvid(x),
    // 顶层 avid+cid：bvid 稿件 -404 时的回退音源（related_archive.cid 不可靠）
    aid: String(x.aid || ''),
    cid: String(x.cid || ''),
    title: x.music_title,
    artist: x.author,
    coverUrl: normalizePic(x.cover),
    album: x.album || '',
    publishTime: x.publish_time,
  }
}

// 综合热歌榜
export async function getMusicCenterRank(ps = 30): Promise<MusicSong[]> {
  const list = await getMusicComprehensiveRank(ps)
  return list.filter((x) => playableBvid(x)).map(mapMusicSong)
}

// 新歌速递
export async function getNewSongs(): Promise<MusicSong[]> {
  const list = await getNewMusic()
  return list.filter((x) => x.bvid).map(mapMusicSong)
}

// ===== 搜索 UP主 =====

export interface UserResult {
  mid: number
  name: string
  avatar: string
  sign: string
  fans: number
  videoCount: number
  level: number
}

export async function searchUsers(keyword: string, page = 1, pageSize = 20): Promise<{ items: UserResult[]; totalPages: number; totalResults: number }> {
  const data = await searchUser(keyword, page, pageSize)
  const items = (data.result || []).map((u) => ({
    mid: u.mid,
    name: u.uname?.replace(/<[^>]+>/g, '') || '',
    avatar: normalizePic(u.upic),
    sign: u.usign || '',
    fans: u.fans || 0,
    videoCount: u.videos || 0,
    level: u.level || 0,
  }))
  const totalResults = data.numResults || 0
  return { items, totalPages: data.numPages || Math.ceil(totalResults / pageSize), totalResults }
}

// ===== UP主 投稿视频 =====

export interface UpVideo {
  bvid: string
  title: string
  coverUrl: string
  duration: number
  play: number
  created: number
}

// "mm:ss" / "hh:mm:ss" → 秒
function parseLength(len: string): number {
  if (!len) return 0
  const parts = len.split(':').map(Number)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

export async function getUserVideos(mid: number, page = 1, pageSize = 30): Promise<{ items: UpVideo[]; total: number }> {
  const data = await rendererUserVideos(mid, page, pageSize)
  const items = (data.list?.vlist || []).map((v) => ({
    bvid: v.bvid,
    title: v.title?.replace(/<[^>]+>/g, '') || '',
    coverUrl: normalizePic(v.pic),
    duration: parseLength(v.length),
    play: v.play || 0,
    created: v.created || 0,
  }))
  return { items, total: data.page?.count || 0 }
}

// ===== 个性化推荐 =====

export async function getRecommendVideos(ps = 20): Promise<VideoInfo[]> {
  const parseItem = (v: any): VideoInfo => ({
    bvid: v.bvid,
    aid: v.id || v.aid,
    title: v.title,
    desc: v.desc || '',
    pic: normalizePic(v.pic),
    ownerName: v.owner?.name || v.author || '',
    ownerMid: v.owner?.mid || v.mid || 0,
    duration: v.duration || 0,
    cid: v.cid || 0,
    stat: {
      view: v.stat?.view || v.play || 0,
      like: v.stat?.like || 0,
      favorite: v.stat?.favorite || v.favorites || 0,
    },
  })
  const data = await rendererRec(ps)
  return (data.item || []).map(parseItem)
}

// ===== 热门/推荐 =====

export async function getPopularVideos(ps = 10, pn = 1): Promise<VideoInfo[]> {
  const data = await rendererPopular(ps, pn)
  return data.list?.map((v) => ({
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    desc: '',
    pic: normalizePic(v.pic),
    ownerName: v.owner?.name,
    ownerMid: v.owner?.mid,
    duration: v.duration,
    cid: v.cid,
    stat: {
      view: v.stat?.view,
      like: v.stat?.like,
      favorite: v.stat?.favorite,
    },
  })) || []
}

// ===== 扫码登录 =====

export interface QrCodeData {
  url: string
  qrcodeKey: string
}

export interface QrPollResult {
  code: number
  status: number
  message: string
  url: string
}

export async function generateQrCode(): Promise<QrCodeData> {
  if (window.electronAPI?.biliApi) {
    const data = await window.electronAPI.biliApi.qrGenerate()
    return { url: data.url, qrcodeKey: data.qrcodeKey }
  }
  return rendererGen()
}

export async function pollQrCode(qrcodeKey: string): Promise<QrPollResult> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.qrPoll(qrcodeKey)
  }
  return rendererPoll(qrcodeKey)
}

export async function getLoginStatus(): Promise<{ isLoggedIn: boolean; sessdata?: string }> {
  if (window.electronAPI?.biliApi) {
    const cookies = await window.electronAPI.biliApi.getCookies()
    return { isLoggedIn: cookies.isLoggedIn, sessdata: cookies.sessdata }
  }

  // 浏览器环境：通过 nav API 检测
  const info = await getUserInfo()
  return { isLoggedIn: info.isLogin }
}

export async function logout(): Promise<void> {
  if (window.electronAPI?.biliApi) {
    await window.electronAPI.biliApi.logout()
    return
  }

  // 移动端：清除 WebView 中的 B 站登录 Cookie
  await clearBilibiliAuthCookies()
}

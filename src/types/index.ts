export interface Track {
  id: string
  title: string
  artist: string
  coverUrl: string
  duration: number
  videoUrl: string
  bvid: string
  // 音乐中心曲目的顶层 avid+cid：当 bvid 稿件不存在（-404）时回退直取音乐流
  aid?: string | number
  cid?: string | number
  playCount: number
  isLiked: boolean
  likedAt?: string // 收藏时间，供云同步按 like/unlike 时间合并
  addedAt?: string // 加入歌单时间，供歌单内按加入时间排序
}

export interface Playlist {
  id: string
  name: string
  description?: string
  coverUrl: string
  tracks: Track[]
  createdAt: string
  updatedAt: string
}

// 删除墓碑：双向同步时区分「在此端删除」与「此端从未有过」，避免删除项被对端复活
export interface Tombstone {
  id: string
  deletedAt: string
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type RepeatMode = 'none' | 'all' | 'one' | 'shuffle'
export type SidebarState = 'expanded' | 'collapsed' | 'auto'
export type DownloadFormat = 'audio' | 'video'

export interface DownloadRecord {
  id: string
  title: string
  artist: string
  bvid: string
  format: DownloadFormat
  quality: string
  filename: string
  downloadDir: string
  downloadedAt: string
}

export interface AppSettings {
  sidebarState: SidebarState
  playQuality: '标准' | '高品质' | '无损'
  downloadQuality: '标准' | '高品质' | '无损'
  downloadFormat: DownloadFormat
  downloadDir: string
  autoPlay: boolean
  showLyrics: boolean
  // 桌面歌词配色（hex，如 #ffffff / #ff375f）
  lyricTextColor: string
  lyricControlColor: string
  // 桌面歌词字号/粗细（v1.3.6 外观小面板）
  lyricFontSize: number
  lyricFontWeight: number
  // v1.3.8 字体选项（三面板独立）：桌面歌词 / 标题栏+播放条 / 播放页歌词
  lyricFontFamily: string
  titleFontFamily: string
  playerLyricFontFamily: string
  // v1.3.10 自动颜色开关：歌词文字色（封面提色）/ 控件色（窗周围背景采样），独立生效
  autoTextColor: boolean
  autoControlColor: boolean
  // v1.3.10 自动色算出的实际颜色（与手动色 lyricTextColor/lyricControlColor 分离）：
  // 手动色永不被自动色覆盖，关闭开关即回到开启前的手动色；歌词窗按「开关开且自动色就绪」时显示自动色。
  autoLyricTextColor: string
  autoLyricControlColor: string
}

export type NavItem = {
  icon: string
  label: string
  path: string
}

export interface UserInfo {
  isLogin: boolean
  mid: number
  uname: string
  face: string
  vipType: number
  vipStatus: number
}

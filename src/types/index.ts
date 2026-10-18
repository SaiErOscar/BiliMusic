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
  /** 音频/视频下载；v1.4.6 新增 'mv'（导出播放界面视频） */
  format: DownloadFormat | 'mv'
  quality: string
  filename: string
  downloadDir: string
  /** v1.4.6-pre4：实际产物绝对路径（同名防覆盖改写后的真实位置）；旧记录可能缺失，UI 以 downloadDir+filename 兜底推算 */
  filePath?: string
  /** v1.4.8-pre4：B 站视频封面；旧记录可能缺失，列表按 bvid 懒加载补齐 */
  coverUrl?: string
  downloadedAt: string
}

/** v1.4.9-pre1 主题体系化：用户在内置主题上覆盖的基色，只存改过的项 */
export interface ThemeSeedOverride {
  primary?: string
  secondary?: string
  accent?: string
}

/** v1.4.9-pre1 歌词窗样式预设：一组可命名的歌词窗外观项 */
export interface LyricStylePreset {
  id: string
  name: string
  lyricTextColor: string
  lyricControlColor: string
  lyricFontSize: number
  lyricFontWeight: number
  lyricFontFamily: string
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
  // v1.4.6 MV 导出：画面角落 BiliMusic 水印开关（默认开）
  mvWatermark: boolean
  // v1.4.7-pre1 MV 导出：流畅度档位（快速 0.15s/标准 0.1s/流畅 0.05s/极致 0.03s 关键帧步长）
  mvSmoothness: '快速' | '标准' | '流畅' | '极致'
  // v1.4.8-pre1 播放三件套：倍速播放档位（0.5/0.75/1/1.25/1.5/1.75/2.0）
  playbackRate: number
  // v1.4.8-pre1 桌面全局媒体键开关（Electron globalShortcut，失焦也生效）
  // 默认关闭，避免抢占其他播放器的系统媒体键
  globalMediaKeys: boolean
  // v1.4.9-pre1 主题体系化：所选内置主题 id（default = BiliBili 粉，即 index.css 默认值）
  themeId: string
  // v1.4.9-pre1：在所选主题基色上的覆盖项（空对象表示用主题原色）
  themeSeedOverride: ThemeSeedOverride
  // v1.4.9-pre1：歌词窗样式预设库
  lyricPresets: LyricStylePreset[]
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

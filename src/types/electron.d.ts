export interface DesktopLyricState {
  /** 桌面歌词窗当前是否实际可见 */
  visible: boolean
  /** 用户意图：是否想显示桌面歌词（播放页按钮文字以此为准） */
  intent: boolean
  /** 播放页抑制中（播放页打开且主窗口聚焦，此时即使 intent=true 也不显示） */
  suppressed: boolean
}

export interface DownloadOptions {
  artist?: string
  title?: string
  lyricContent?: string
}

interface BiliApi {
  downloadAudio: (audioUrl: string, filename: string, customDir?: string, options?: DownloadOptions) => Promise<{
    filePath: string
    size: number
  }>
  downloadVideo: (videoUrl: string, audioUrl: string, filename: string, customDir?: string, options?: DownloadOptions) => Promise<{
    filePath: string
    size: number
  }>
  openDownloadDir: (dirPath?: string) => Promise<{ success: boolean }>
  getDefaultDownloadDir: () => Promise<string>
  selectDownloadFolder: () => Promise<string | null>
  saveLyricFile: (content: string, filePath: string) => Promise<{ success: boolean; filePath: string }>
  onDownloadProgress: (callback: (data: { filename: string; received: number; total: number; percent: number }) => void) => () => void
  qrGenerate: () => Promise<{
    url: string
    qrcodeKey: string
  }>
  qrPoll: (qrcodeKey: string) => Promise<{
    code: number
    status: number
    message: string
    url: string
  }>
  getCookies: () => Promise<{
    isLoggedIn: boolean
    sessdata: string
    biliJct: string
    dedeUserId: string
  }>
  logout: () => Promise<{ success: boolean }>
  dealFavorite: (rid: number | string, addMediaIds: number[], delMediaIds?: number[]) => Promise<{ code: number; message: string }>
  fetchBiliJson: (path: string, params?: Record<string, string | number | boolean>) => Promise<unknown>
  openLoginWindow: () => Promise<{ success: boolean }>
}

export interface OiapiSong {
  name: string
  singer: string[]
  album: string
  mid: string
  id: string | number
  album_mid: string
  duration: number
  image: string
}

export interface OiapiLyricData {
  content?: string
  conteng?: string
  base64?: string
  cache?: boolean
}

interface LyricsApi {
  search: (keyword: string, page?: number, limit?: number) => Promise<OiapiSong[]>
  get: (id: string | number, format?: 'lrc' | 'qrc' | 'ksc') => Promise<OiapiLyricData | null>
}

interface PersistentStorageApi {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}






export interface TrayPlayerState {
  hasTrack: boolean
  title: string
  artist: string
  coverUrl: string
  isPlaying: boolean
  queueLength: number
  theme: 'light' | 'dark'
}

export type TrayPlayerCommand = 'toggle-play' | 'next' | 'prev'

export interface MiniLyricLine {
  time: number
  text: string
}

export interface MiniPlayerState {
  hasTrack: boolean
  title: string
  artist: string
  coverUrl: string
  isPlaying: boolean
  volume: number
  isMuted: boolean
  progress: number
  duration: number
  lyricLines: MiniLyricLine[]
  synced: boolean
  theme: 'light' | 'dark'
  lyricTextColor: string
  lyricControlColor: string
  /** 桌面歌词字号/粗细（v1.3.6） */
  lyricFontSize: number
  lyricFontWeight: number
  /** 播放顺序（v1.3.2）：供桌面歌词窗播放顺序按钮展示当前模式 */
  repeatMode: 'none' | 'all' | 'one' | 'shuffle'
}

export type MiniCommand =
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'volume'; value: number }
  | { type: 'seek'; value: number }
  | { type: 'show-window' }
  | { type: 'cycle-repeat-mode' }
  | { type: 'show-lyric-window' }
  | { type: 'close-lyric-window' }
  | { type: 'show-player' }
  | { type: 'update-lyric-appearance'; lyricTextColor?: string; lyricControlColor?: string; lyricFontSize?: number; lyricFontWeight?: number }

export interface WebdavConfigInput {
  url: string
  username: string
  password: string
}
export interface WebdavConfigInfo {
  url: string
  username: string
  configured: boolean
}
export interface WebdavResult {
  ok: boolean
  status: number
  etag: string | null
  content: string | null
  message?: string
}

// 统一更新事件（整包 electron-updater + 渲染热补丁共用此通道）
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'up-to-date'; version: string }
  | { type: 'available'; version: string; notes?: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'manual'; url: string }
  | { type: 'renderer-available'; version: string }
  | { type: 'renderer-progress'; percent: number }
  | { type: 'renderer-ready-to-apply'; version: string }
  | { type: 'error'; message: string }

declare global {
  interface Window {
    electronAPI: {
      minimize: () => void
      maximize: () => void
      close: () => void
      isMaximized?: () => Promise<boolean>
      toggleFullscreen?: () => void
      isFullscreen?: () => Promise<boolean>
      setWindowButtonVisibility?: (visible: boolean) => void
      onMaximizedChange?: (callback: (isMaximized: boolean) => void) => () => void
      onFullscreenChange?: (callback: (isFullscreen: boolean) => void) => () => void
      updateTrayPlayerState?: (state: TrayPlayerState) => void
      onTrayPlayerCommand?: (callback: (command: TrayPlayerCommand) => void) => () => void
      updateMiniPlayerState?: (state: MiniPlayerState) => void
      onMiniPlayerCommand?: (callback: (command: MiniCommand) => void) => () => void
      toggleDesktopLyric?: () => void
      /** 桌面歌词状态：visible=实际可见 / intent=用户意图（按钮文字跟随它）/ suppressed=播放页抑制中 */
      getDesktopLyricVisible?: () => Promise<DesktopLyricState>
      onDesktopLyricVisible?: (callback: (state: DesktopLyricState) => void) => () => void
      showDesktopLyric?: () => void
      hideDesktopLyric?: () => void
      /** 上报播放页（NowPlaying）开关状态，主进程据此计算桌面歌词抑制 */
      setNowPlayingOpen?: (open: boolean) => void
      onOpenNowPlaying?: (callback: () => void) => () => void
      openExternal: (url: string) => Promise<void>
      getAppVersion?: () => Promise<string>
      checkForUpdate?: () => Promise<void>
      quitAndInstall?: () => void
      applyRendererUpdate?: () => void
      notifyRendererReady?: () => void
      onUpdaterEvent?: (callback: (event: UpdaterEvent) => void) => () => void
      configureWebdav?: (cfg: WebdavConfigInput) => Promise<{ ok: boolean }>
      getWebdavConfig?: () => Promise<WebdavConfigInfo>
      testWebdav?: () => Promise<{ ok: boolean; message: string }>
      webdavGet?: (relPath: string) => Promise<WebdavResult>
      webdavPut?: (relPath: string, content: string, etag?: string) => Promise<WebdavResult>
      clearWebdav?: () => Promise<{ ok: boolean }>
      platform: string
      persistentStorage?: PersistentStorageApi
      biliApi: BiliApi
      lyricsApi: LyricsApi
    }
  }
}

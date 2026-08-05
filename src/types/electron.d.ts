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
  dealFavorite: (rid: number, addMediaIds: number[], delMediaIds?: number[]) => Promise<{ code: number; message: string }>
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

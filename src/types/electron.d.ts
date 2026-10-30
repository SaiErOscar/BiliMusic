export interface DesktopLyricState {
  /** 桌面歌词窗当前是否实际可见 */
  visible: boolean
  /** 用户意图：是否想显示桌面歌词（播放页按钮文字以此为准） */
  intent: boolean
  /** 播放页抑制中（播放页打开且主窗口聚焦，此时即使 intent=true 也不显示） */
  suppressed: boolean
}

/** v1.4.8-pre1 主进程投递给渲染层的媒体键命令名 */
export type MediaKeyCommand = 'toggle-play' | 'next' | 'prev' | 'stop'

export interface DownloadOptions {
  artist?: string
  title?: string
  lyricContent?: string
}

/** v1.4.6 MV 导出请求载荷（渲染层解析好音源/歌词后交给主进程） */
export interface MvExportPayload {
  title: string
  artist: string
  audioUrl: string
  coverUrl: string
  duration: number
  lyrics: { time: number; text: string }[]
  watermark: boolean
  /**
   * v1.4.9-pre3 无控件导出：true 时舞台隐藏进度条/时间/播放按钮/音量/循环，
   * 只留封面、歌曲信息、歌词与水印。缺省/false 保持既有画面（含控件）。
   */
  clean?: boolean
  /**
   * v1.4.10-pre1 音频可视化跟随（AppSettings.audioVisualizer）：true 时导出画面在封面下缘
   * 显示频谱柱状图（主进程先离线分析音频，把整曲频谱时间线注入离屏舞台）。
   * clean 为 true 时不显示（无控件导出不含可视化）。
   * 注：频谱数据本身（spectrum/spectrumHz/spectrumBars）由主进程注入离屏舞台，渲染层不传。
   */
  visualizer?: boolean
  /** 流畅度档位（快速/标准/流畅/极致），缺省标准 */
  smoothness?: string
  outputDir?: string
}

export interface MvExportProgress {
  /**
   * error：任务失败（与 done 分离，批量侧不会把失败当 100% 完成）；
   * analyze：v1.4.10-pre1 音频可视化的离线频谱分析（仅可视化开启时出现）
   */
  phase: 'audio' | 'analyze' | 'render' | 'compose' | 'done' | 'error'
  percent: number
  message?: string
  filePath?: string
}

/** v1.4.6 MV 导出能力（桌面端专属，electronAPI 平铺暴露） */
export interface MvExportApi {
  exportMvSingle: (payload: MvExportPayload, ownerTag?: string) => Promise<{ ok: boolean; filePath?: string; message?: string }>
  /** ownerTag：批量下载传 'batch'，取消按发起方隔离，不误杀并发中的单曲导出 */
  cancelMvExport: (ownerTag?: string) => Promise<{ ok: boolean }>
  onMvExportProgress: (callback: (progress: MvExportProgress) => void) => () => void
}

export interface BiliApi {
  downloadAudio: (audioUrl: string, filename: string, customDir?: string, options?: DownloadOptions) => Promise<{
    filePath: string
    size: number
  }>
  downloadVideo: (videoUrl: string, audioUrl: string, filename: string, customDir?: string, options?: DownloadOptions) => Promise<{
    filePath: string
    size: number
  }>
  openDownloadDir: (dirPath?: string) => Promise<{ success: boolean }>
  /** 下载记录：检测记录文件是否仍存在于磁盘 */
  pathExists: (filePath: string) => Promise<boolean>
  /** 下载记录：用系统默认程序打开文件（message 非空为错误信息） */
  openRecordFile: (filePath: string) => Promise<{ success: boolean; message?: string }>
  /** 下载记录：在文件管理器中定位文件 */
  showRecordInFolder: (filePath: string) => Promise<{ success: boolean }>
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
    dedeCkMd5?: string
  }>
  logout: () => Promise<{ success: boolean }>
  setCookies?: (payload: { sessdata: string; biliJct: string; dedeUserId: string; dedeCkMd5?: string }) => Promise<{ success: boolean; message?: string }>
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
  /**
   * v1.4.9-pre2 歌词双语：网易云 tlyric 翻译 LRC。
   * 可选字段，仅网易云源可能返回；QQ / LRCLIB 及旧版主进程不返回，读取方按缺省处理。
   */
  translation?: string
}

/** v1.3.7 网易云搜索行（duration 为毫秒） */
export interface NeteaseSong {
  name: string
  id: string | number
  artists?: { name?: string }[]
  album?: { name?: string }
  duration?: number
}

/** v1.3.7 LRCLIB 搜索行（列表接口不带歌词正文） */
export interface LrclibSong {
  id: string | number
  trackName: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
}

export interface LyricsApi {
  search: (keyword: string, page?: number, limit?: number) => Promise<OiapiSong[]>
  get: (id: string | number, format?: 'lrc' | 'qrc' | 'ksc') => Promise<OiapiLyricData | null>
  /** v1.3.7 手动匹配多源：网易云（offset 翻页） */
  searchNetease: (keyword: string, offset?: number, limit?: number) => Promise<NeteaseSong[]>
  getNetease: (id: string | number) => Promise<OiapiLyricData | null>
  /** v1.3.7 手动匹配多源：LRCLIB（不支持翻页，失败返回空数组） */
  searchLrclib: (keyword: string) => Promise<LrclibSong[]>
  getLrclib: (id: string | number) => Promise<OiapiLyricData | null>
}

export interface PersistentStorageApi {
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
  /** v1.4.13-pre11 次级文本（译文 / AI 增强），显示在主行下方 */
  sub?: string
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
  lyricFontFamily: string
  /** 播放顺序（v1.3.2）：供桌面歌词窗播放顺序按钮展示当前模式 */
  repeatMode: 'none' | 'all' | 'one' | 'shuffle'
  /** v1.3.10 自动颜色开关：歌词文字色（封面提色）/ 控件色（窗周围背景采样） */
  autoTextColor?: boolean
  autoControlColor?: boolean
  /** v1.3.10 自动算出的实际颜色（与手动色分离，歌词窗据此显示） */
  autoLyricTextColor?: string
  autoLyricControlColor?: string
  /** v1.4.5 用户主动选「不显示歌词」：歌词窗显示「无歌词」，区别于自动匹配失败 */
  noLyric?: boolean
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
  | { type: 'update-lyric-appearance'; lyricTextColor?: string; lyricControlColor?: string; lyricFontSize?: number; lyricFontWeight?: number; lyricFontFamily?: string; autoLyricTextColor?: string; autoLyricControlColor?: string; autoTextColor?: boolean; autoControlColor?: boolean }

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
      listSystemFonts: () => Promise<string[]>
      openColorPicker?: (initialHex?: string) => Promise<string | null>
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
      webdavDelete?: (relPath: string) => Promise<WebdavResult>
      clearWebdav?: () => Promise<{ ok: boolean }>
      saveBackupFile?: (content: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }>
      openBackupFile?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; content?: string; message?: string }>
      deleteBackupFile?: (filePath: string) => Promise<{ ok: boolean; message?: string }>
      platform: string
      persistentStorage?: PersistentStorageApi
      /** v1.4.13-pre4 WorkBuddy 国内/国际版 */
      workbuddy?: {
        localCredentials: () => Promise<{ accessToken: string; region: 'cn' | 'global'; account?: string; expiresAt?: number }[]>
        savedCredential: () => Promise<{ accessToken: string; region: 'cn' | 'global'; account?: string; expiresAt?: number } | null>
        startLogin: (region: 'cn' | 'global') => Promise<{ ok: boolean; key?: string; message?: string }>
        pollLogin: (key: string) => Promise<{ status: 'pending' } | { status: 'ok'; credential: { accessToken: string; region: 'cn' | 'global'; account?: string; expiresAt?: number } } | { status: 'expired' }>
        saveCredential: (cred: unknown) => Promise<{ ok: boolean; message?: string }>
        models: (region: 'cn' | 'global', token: string) => Promise<{ id: string; name: string }[]>
        chat: (cred: unknown, model: string, messages: unknown[], temperature?: number) => Promise<string>
        /** v1.4.13-pre11 账号池 */
        accounts: () => Promise<{ id: string; region: 'cn' | 'global'; account: string; expiresAt: number; origin: 'local' | 'saved'; active: boolean }[]>
        /** v1.4.13-pre11 积分；上游不提供时为 null */
        credits: (cred: unknown) => Promise<{ remaining: number; used: number } | null>
        lastCredits: () => Promise<number>
      }
      /** v1.4.13-pre1 用户画像：外部文件编辑 + 学习记录 */
      userProfile?: {
        read: () => Promise<{ text: string; path: string }>
        open: () => Promise<{ ok: boolean; path?: string; message?: string }>
        reveal: () => Promise<{ ok: boolean; path?: string; message?: string }>
        getLearned: () => Promise<unknown>
        applyLearned: () => Promise<{ ok: boolean; message: string }>
        clearLearned: () => Promise<{ ok: boolean }>
        record: (kind: 'played' | 'skipped' | 'lyricReverted', key?: string) => Promise<{ ok: boolean }>
        recordPlaylist: (tracks: number) => Promise<{ ok: boolean }>
        writeText?: (text: string) => Promise<{ ok: boolean; message?: string }>
        setLearned?: (signals: unknown) => Promise<{ ok: boolean; message?: string }>
      }
      /** v1.4.11-pre3 AI 底座：Provider 配置读写（密钥在主进程经 safeStorage 加密落盘） */
      aiConfig?: {
        get: () => Promise<import('./index').AiSettings>
        set: (config: import('./index').AiSettings) => Promise<{ ok: boolean }>
      }
      biliApi: BiliApi
      lyricsApi: LyricsApi
      /** v1.4.8-pre1 全局媒体键（globalShortcut，桌面专属）；pre5 起回报失败键位 */
      setMediaKeysEnabled?: (enabled: boolean) => Promise<{
        ok: boolean
        reason?: 'not-ready' | 'occupied' | 'partial' | 'error'
        failedKeys?: string[]
        error?: string
      }>
      getMediaKeysEnabled?: () => Promise<boolean>
      onMediaKeyCommand?: (callback: (command: MediaKeyCommand) => void) => () => void
      exportMvSingle?: MvExportApi['exportMvSingle']
      cancelMvExport?: MvExportApi['cancelMvExport']
      onMvExportProgress?: MvExportApi['onMvExportProgress']
    }
  }
}

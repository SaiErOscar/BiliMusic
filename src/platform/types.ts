/**
 * 平台适配层（Platform Abstraction Layer）类型定义
 *
 * 目的：把业务逻辑（src/services、src/utils）对 window.electronAPI 的直接依赖，
 * 收口到一组平台无关的 capability 接口，使同一套业务代码未来可复用于
 * Electron（桌面）/ Capacitor（Android）/ 鸿蒙等多端。
 *
 * 设计约束（v1.4.2-pre3 初步解耦，v1.4.4-pre1 续增 fonts/shell/tray，pre2 续增 miniWindow/colorPicker/updater）：
 * - 行为零变化：现有代码已是 `if (window.electronAPI?.xxx) {桌面分支} else {降级}` 模式，
 *   收口只是把「读 electronAPI」换成「读 platform 接口」，降级分支原样保留。
 * - 可空表达可用性：每个 capability 字段设为可选，保留 `if (platform.xxx)` 的运行时能力探测语义，
 *   与现状 `if (window.electronAPI?.biliApi)` 等价。
 * - 方法签名一律从 electron.d.ts 的 BiliApi/LyricsApi 用 Pick 复用，避免类型漂移。
 * - 本轮只提供 Electron 一个实现，留好扩展点，不实现 Capacitor/鸿蒙。
 */

import type {
  BiliApi,
  LyricsApi,
  PersistentStorageApi,
  WebdavResult,
} from '@/types/electron'
import type { AiSettings } from '@/types'

/** 下载能力：音频/视频下载、下载目录、歌词文件、字节进度订阅；v1.4.6-pre4 增下载记录文件定位三方法 */
export type PlatformDownload = Pick<
  BiliApi,
  | 'downloadAudio'
  | 'downloadVideo'
  | 'openDownloadDir'
  | 'pathExists'
  | 'openRecordFile'
  | 'showRecordInFolder'
  | 'getDefaultDownloadDir'
  | 'selectDownloadFolder'
  | 'saveLyricFile'
  | 'onDownloadProgress'
>

/** 登录鉴权能力：扫码登录、Cookie 读取、登出、登录窗 */
export type PlatformAuth = Pick<
  BiliApi,
  'qrGenerate' | 'qrPoll' | 'getCookies' | 'setCookies' | 'logout' | 'openLoginWindow'
>

/** B 站请求能力：主进程 net.fetch 代理（渲染层跨域/风控受限的接口走此通道） */
export type PlatformBiliRequest = Pick<BiliApi, 'fetchBiliJson'>

/** 收藏夹能力：收藏/取消收藏媒体 */
export type PlatformFavorites = Pick<BiliApi, 'dealFavorite'>

/** 歌词能力：QQ / 网易云 / LRCLIB 多源搜索与取词 */
export type PlatformLyrics = LyricsApi

/** 云同步存储能力：WebDAV GET/PUT（ETag 乐观并发）。字段可选，保留调用方分别探测 webdavGet/webdavPut 的语义 */
export interface PlatformStorage {
  webdavGet?: (relPath: string) => Promise<WebdavResult>
  webdavPut?: (relPath: string, content: string, etag?: string) => Promise<WebdavResult>
  webdavDelete?: (relPath: string) => Promise<WebdavResult>
}

/** 运行时能力：平台标识 + 鸿蒙持久化存储 */
export interface PlatformRuntime {
  /** 平台标识，如 'openharmony'；非桌面/未知环境可能为 undefined */
  platform?: string
  /** 鸿蒙等平台的主进程文件持久化存储，其他平台为 undefined */
  persistentStorage?: PersistentStorageApi
  /** 渲染层挂载成功后回报主进程（确认 OTA 热补丁渲染包可用，避免下次启动误回滚）；非桌面环境缺失即静默跳过 */
  notifyRendererReady?: Window['electronAPI']['notifyRendererReady']
}

/**
 * v1.4.11-pre3 AI 底座能力：Provider 配置读写。
 * 密钥在主进程经 safeStorage 加密落盘，渲染层只做透传；非桌面平台缺失即视为不支持 AI。
 */
/**
 * v1.4.13-pre1 用户画像外部文件：读取 / 打开 / 学习记录。
 * 画像存 userData/user-profile.md，用系统编辑器改；应用只在显式「应用学习结果」时追加。
 */
export interface PlatformUserProfile {
  read: () => Promise<{ text: string; path: string }>
  open: () => Promise<{ ok: boolean; path?: string; message?: string }>
  reveal: () => Promise<{ ok: boolean; path?: string; message?: string }>
  getLearned: () => Promise<unknown>
  applyLearned: () => Promise<{ ok: boolean; message: string }>
  clearLearned: () => Promise<{ ok: boolean }>
  record: (kind: 'played' | 'skipped' | 'lyricReverted', key?: string) => Promise<{ ok: boolean }>
  recordPlaylist: (tracks: number) => Promise<{ ok: boolean }>
  /** v1.4.13-pre4 备份恢复：写回画像正文 */
  writeText?: (text: string) => Promise<{ ok: boolean; message?: string }>
  /** v1.4.13-pre4 备份恢复：写回学习信号 */
  setLearned?: (signals: unknown) => Promise<{ ok: boolean; message?: string }>
}

/** v1.4.13-pre4 WorkBuddy：本地凭据 / 网页登录 / 模型列表 / chat */
export interface PlatformWorkBuddy {
  localCredentials: () => Promise<
    { accessToken: string; region: 'cn' | 'global'; account?: string; expiresAt?: number }[]
  >
  savedCredential: () => Promise<
    { accessToken: string; region: 'cn' | 'global'; account?: string; expiresAt?: number } | null
  >
  startLogin: (region: 'cn' | 'global') => Promise<{ ok: boolean; key?: string; message?: string }>
  pollLogin: (
    key: string,
  ) => Promise<
    | { status: 'pending' }
    | { status: 'ok'; credential: { accessToken: string; region: 'cn' | 'global'; account?: string; expiresAt?: number } }
    | { status: 'expired' }
  >
  saveCredential: (cred: unknown) => Promise<{ ok: boolean; message?: string }>
  models: (region: 'cn' | 'global', token: string) => Promise<{ id: string; name: string }[]>
  chat: (cred: unknown, model: string, messages: unknown[], temperature?: number) => Promise<string>
}

export interface PlatformAiConfig {
  get: () => Promise<AiSettings>
  set: (config: AiSettings) => Promise<{ ok: boolean }>
}

/** 字体能力：枚举系统字体。字段可选，缺失时调用方回退内置保底列表（非桌面平台） */
export interface PlatformFonts {
  listSystemFonts?: Window['electronAPI']['listSystemFonts']
}

/**
 * 桌面壳能力：窗口最小化/最大化/关闭、最大化与全屏状态订阅、标题栏按钮显隐、外部链接打开。
 * 手机端（Capacitor/鸿蒙）无此 capability，调用方以 `if (platform.shell)` 探测后降级。
 * 签名用 Pick 复用 electron.d.ts 的 Window.electronAPI，可选字段（isMaximized 等）保持可选。
 */
export type PlatformShell = Pick<
  Window['electronAPI'],
  | 'minimize'
  | 'maximize'
  | 'close'
  | 'isMaximized'
  | 'onMaximizedChange'
  | 'toggleFullscreen'
  | 'isFullscreen'
  | 'onFullscreenChange'
  | 'setWindowButtonVisibility'
  | 'openExternal'
>

/** 托盘能力：推送播放状态给托盘、订阅托盘菜单命令（非桌面平台无托盘） */
export type PlatformTray = Pick<
  Window['electronAPI'],
  'updateTrayPlayerState' | 'onTrayPlayerCommand'
>

/**
 * 桌面歌词/迷你窗能力：播放状态推送、小窗命令订阅、桌面歌词可见态查询/订阅/开关、
 * 播放页开关上报与「打开播放器」命令订阅。手机端（Capacitor/鸿蒙）无此能力。
 */
export type PlatformMiniWindow = Pick<
  Window['electronAPI'],
  | 'updateMiniPlayerState'
  | 'onMiniPlayerCommand'
  | 'toggleDesktopLyric'
  | 'getDesktopLyricVisible'
  | 'onDesktopLyricVisible'
  | 'setNowPlayingOpen'
  | 'onOpenNowPlaying'
>

/**
 * 全局取色器能力（Windows 专属桌面能力：desktopCapturer 全屏准星取色）。
 * 字段可选，缺失时 ColorField 回退原生 `input[type=color]`，功能不缺失。
 * 平台判定复用 `platform.runtime?.platform`，此处不重复暴露 platform 字段。
 */
export interface PlatformColorPicker {
  openColorPicker?: Window['electronAPI']['openColorPicker']
}

/**
 * 更新能力：版本号、主动检查更新、更新事件订阅、下载完成后重启安装 / 应用界面（OTA）更新。
 * 鸿蒙端不提供更新能力（Settings 内 `platform.runtime?.platform === 'openharmony'` 时隐藏入口），
 * 字段可选，缺失时调用方静默降级。
 */
export type PlatformUpdater = Pick<
  Window['electronAPI'],
  | 'getAppVersion'
  | 'checkForUpdate'
  | 'quitAndInstall'
  | 'applyRendererUpdate'
  | 'onUpdaterEvent'
>

/**
 * 本地备份文件能力：导出/读取/删除 .bmback 备份文件的系统文件对话框（桌面专属）。
 * 手机端无此能力，BackupModal 以 `hasFileApi`（saveBackupFile && openBackupFile）探测后隐藏文件导入/导出入口。
 */
export type PlatformBackup = Pick<
  Window['electronAPI'],
  'saveBackupFile' | 'openBackupFile' | 'deleteBackupFile'
>

/**
 * WebDAV 连接配置能力：读取/保存连接配置、测试连通性（桌面专属；云同步数据读写走 storage）。
 * 字段可选，缺失时 Settings 的 WebDAV 段自然降级（无配置即不显示已同步态）。
 */
export type PlatformWebdavConfig = Pick<
  Window['electronAPI'],
  'getWebdavConfig' | 'configureWebdav' | 'testWebdav'
>


/**
 * MV 导出能力（v1.4.6，桌面专属）：单首播放界面 MP4 导出、取消与进度订阅。
 * 手机端无 ffmpeg/离屏渲染链路，缺失时调用方隐藏「导出 MV」入口。
 */
export type PlatformMvExport = Pick<
  Window['electronAPI'],
  'exportMvSingle' | 'cancelMvExport' | 'onMvExportProgress'
>

/**
 * 通知栏媒体控制能力（v1.4.7-pre4，Android 专属）。
 * JS 把播放状态推给原生前台服务（MediaSession + 通知），系统媒体控件的用户
 * 指令经 onCommand 回抛；WebView 内 audio 仍是真正播放器。
 * 桌面端走 navigator.mediaSession（PlayerContext 已有），不实现此能力。
 */
export interface PlatformMediaNotify {
  updateSession: (meta: {
    title: string
    artist: string
    coverUrl?: string
    isPlaying: boolean
    positionSec: number
    durationSec: number
  }) => Promise<void>
  stopSession: () => Promise<void>
  /** 返回取消订阅函数；action ∈ play/pause/next/previous/seek（seek 的 value 为秒） */
  onCommand: (cb: (action: 'play' | 'pause' | 'next' | 'previous' | 'seek', value?: number) => void) => () => void
}

/**
 * 平台能力聚合。每个 capability 可选，缺失即代表当前平台不支持该能力，
 * 调用方按现有 `if (platform.xxx)` 模式做能力探测与降级。
 */
/** v1.4.8-pre1 桌面全局媒体键（仅 Electron，移动端无） */
export interface MediaKeysSetResult {
  /** 全部键位注册成功为 true；关闭时恒 true */
  ok: boolean
  /** partial：部分键位被占用；occupied：全部失败；not-ready：应用未就绪；error：异常 */
  reason?: 'not-ready' | 'occupied' | 'partial' | 'error'
  /** 本次注册失败的键位（partial/occupied 时非空） */
  failedKeys?: string[]
  /** reason=error 时的原始错误文本 */
  error?: string
}

export interface PlatformMediaKeys {
  /** 开启/关闭全局媒体键注册，返回真实注册结果 */
  setEnabled: (enabled: boolean) => Promise<MediaKeysSetResult>
  /** 当前是否有任一媒体键已注册（主进程权威态） */
  getEnabled: () => Promise<boolean>
  /** 订阅来自主进程的媒体键命令，返回取消订阅函数 */
  onCommand: (cb: (command: 'toggle-play' | 'next' | 'prev' | 'stop') => void) => () => void
}

export interface Platform {
  download?: PlatformDownload
  auth?: PlatformAuth
  biliRequest?: PlatformBiliRequest
  favorites?: PlatformFavorites
  lyrics?: PlatformLyrics
  storage?: PlatformStorage
  runtime?: PlatformRuntime
  fonts?: PlatformFonts
  shell?: PlatformShell
  tray?: PlatformTray
  miniWindow?: PlatformMiniWindow
  colorPicker?: PlatformColorPicker
  updater?: PlatformUpdater
  backup?: PlatformBackup
  webdavConfig?: PlatformWebdavConfig
  mvExport?: PlatformMvExport
  mediaNotify?: PlatformMediaNotify
  /** v1.4.8-pre1 桌面全局媒体键 */
  mediaKeys?: PlatformMediaKeys
  /** v1.4.11-pre3 AI 底座：Provider 配置（密钥经 safeStorage 加密，桌面端专属） */
  aiConfig?: PlatformAiConfig
  /** v1.4.13-pre1 用户画像外部文件 + 学习记录 */
  userProfile?: PlatformUserProfile
  /** v1.4.13-pre4 WorkBuddy 国内/国际版 */
  workbuddy?: PlatformWorkBuddy
}

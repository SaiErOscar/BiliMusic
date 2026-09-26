/**
 * 平台适配层（Platform Abstraction Layer）类型定义
 *
 * 目的：把业务逻辑（src/services、src/utils）对 window.electronAPI 的直接依赖，
 * 收口到一组平台无关的 capability 接口，使同一套业务代码未来可复用于
 * Electron（桌面）/ Capacitor（Android）/ 鸿蒙等多端。
 *
 * 设计约束（v1.4.2-pre3 初步解耦）：
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

/** 下载能力：音频/视频下载、下载目录、歌词文件、字节进度订阅 */
export type PlatformDownload = Pick<
  BiliApi,
  | 'downloadAudio'
  | 'downloadVideo'
  | 'openDownloadDir'
  | 'getDefaultDownloadDir'
  | 'selectDownloadFolder'
  | 'saveLyricFile'
  | 'onDownloadProgress'
>

/** 登录鉴权能力：扫码登录、Cookie 读取、登出、登录窗 */
export type PlatformAuth = Pick<
  BiliApi,
  'qrGenerate' | 'qrPoll' | 'getCookies' | 'logout' | 'openLoginWindow'
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
}

/** 运行时能力：平台标识 + 鸿蒙持久化存储 */
export interface PlatformRuntime {
  /** 平台标识，如 'openharmony'；非桌面/未知环境可能为 undefined */
  platform?: string
  /** 鸿蒙等平台的主进程文件持久化存储，其他平台为 undefined */
  persistentStorage?: PersistentStorageApi
}

/**
 * 平台能力聚合。每个 capability 可选，缺失即代表当前平台不支持该能力，
 * 调用方按现有 `if (platform.xxx)` 模式做能力探测与降级。
 */
export interface Platform {
  download?: PlatformDownload
  auth?: PlatformAuth
  biliRequest?: PlatformBiliRequest
  favorites?: PlatformFavorites
  lyrics?: PlatformLyrics
  storage?: PlatformStorage
  runtime?: PlatformRuntime
}

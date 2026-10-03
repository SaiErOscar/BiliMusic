// v1.4.3-pre6 一键全量数据备份：负载收集 / .bmback 加密封装 / 合并恢复
//
// 文件格式（文本，便于走 WebDAV 字符串通道与文件对话框）：
//   第一行魔数  BiliMusic-Backup/v1
//   第二行      base64( 信封 JSON )
// 信封明文只含不含隐私的 meta（版本/导出时间/是否含账号），实际负载（含登录凭证、
// 用户名、各类数据）经 PBKDF2-SHA256 派生密钥后用 AES-256-GCM 加密为 ct。
// 口令不落盘、不存储：忘记即无法解密。

import type { AppSettings, DownloadRecord, Playlist, ThemeMode, Tombstone, Track } from '@/types'
import { platform } from '@/platform'
import {
  DEFAULT_APP_SETTINGS,
  DOWNLOADS_CHANGED_EVENT,
  FAVORITES_CHANGED_EVENT,
  PLAYLISTS_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
  loadAppSettings,
  loadDownloadRecords,
  loadFavoriteTombstones,
  loadFavoriteTracks,
  loadPlaylistTombstones,
  loadPlaylists,
  loadRecentTracks,
  saveAppSettings,
  saveDownloadRecords,
  saveFavoriteTombstones,
  saveFavoriteTracks,
  savePlaylistTombstones,
  savePlaylists,
  saveRecentTracks,
} from '@/utils/storage'
import { loadLyricOffsetMap, saveLyricOffsetMap } from '@/services/lyrics'
import { getNavInfo } from '@/services/bilibiliApi'
import { readStoredItemSync, writeStoredItem } from '@/utils/persistentStorage'
import { mergeItems } from '@/utils/sync'

// 歌词偏移合并：本地优先（与 sync.ts 内部逻辑一致，就近定义避免额外导出）
function mergeLyricOffsets(localMap: Record<string, number>, remoteMap?: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...(remoteMap || {}) }
  for (const [k, v] of Object.entries(localMap)) merged[k] = v
  return merged
}

const MAGIC = 'BiliMusic-Backup/v1'
const FORMAT_VERSION = 1
const RECENT_EVENT = 'bilimusic:recent-changed'
const THEME_MODE_KEY = 'theme-mode'
export const THEME_CHANGED_EVENT = 'bilimusic:theme-changed'

// 与 useTheme 的 system 解析保持一致：system 取当前系统偏好
function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const PBKDF2_ITERATIONS = 150000
const KEY_LENGTH = 256

export interface BackupAccount {
  dedeUserId: string
  sessdata: string
  biliJct: string
  ckMd5?: string
  username: string
  avatar: string
}

export interface BackupPayload {
  app: 'biliMusic'
  type: 'backup'
  formatVersion: number
  exportedAt: string
  account: BackupAccount | null
  playlists: Playlist[]
  playlistTombstones: Tombstone[]
  favorites: Track[]
  favoriteTombstones: Tombstone[]
  recent: Track[]
  downloads: DownloadRecord[]
  lyricOffsets: Record<string, number>
  settings: AppSettings
  theme: ThemeMode
}

// 信封（base64 文件里编码的对象）；meta 明文，密文负载在 ct
interface Envelope {
  v: number
  meta: { formatVersion: number; exportedAt: string; hasAccount: boolean }
  salt: string // base64
  iv: string // base64
  iterations: number
  ct: string // base64（AES-GCM 密文，内含完整 BackupPayload JSON）
}

export interface BackupMeta {
  formatVersion: number
  exportedAt: string
  hasAccount: boolean
}

// ===== base64 工具（Uint8Array <-> 字符串，UTF-8 安全）=====
function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
// UTF-8 安全的 base64（信封 JSON 可能含非 ASCII 时间戳等）
function strToB64(str: string): string {
  return bytesToB64(new TextEncoder().encode(str))
}
function b64ToStr(b64: string): string {
  return new TextDecoder().decode(b64ToBytes(b64))
}

function subtle(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前环境不支持加密（Web Crypto 不可用）')
  }
  return crypto.subtle
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const baseKey = await subtle().importKey('raw', enc.encode(password) as unknown as BufferSource, 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ===== 负载收集 =====
export async function collectBackup(): Promise<BackupPayload> {
  let account: BackupAccount | null = null
  try {
    const cookies = await platform.auth?.getCookies?.()
    let cachedUser: { username?: string; avatar?: string } = {}
    try {
      const raw = localStorage.getItem('bilimusic_user')
      if (raw) cachedUser = JSON.parse(raw)
    } catch { /* ignore */ }
    if (cookies?.isLoggedIn && cookies.dedeUserId) {
      account = {
        dedeUserId: cookies.dedeUserId,
        sessdata: cookies.sessdata || '',
        biliJct: cookies.biliJct || '',
        ckMd5: cookies.dedeCkMd5 || '',
        username: cachedUser.username || '',
        avatar: cachedUser.avatar || '',
      }
    }
  } catch { /* 无主进程 Cookie 能力时，账号项留空 */ }

  return {
    app: 'biliMusic',
    type: 'backup',
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    account,
    playlists: loadPlaylists(),
    playlistTombstones: loadPlaylistTombstones(),
    favorites: loadFavoriteTracks(),
    favoriteTombstones: loadFavoriteTombstones(),
    recent: loadRecentTracks(),
    downloads: loadDownloadRecords(),
    lyricOffsets: loadLyricOffsetMap(),
    settings: loadAppSettings(),
    theme: (readStoredItemSync(THEME_MODE_KEY) as ThemeMode) || 'system',
  }
}

// ===== 加密封装：负载 -> .bmback 文本 =====
export async function buildBackupFile(payload: BackupPayload, password: string): Promise<string> {
  if (!password) throw new Error('请设置备份口令')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS)
  const plain = new TextEncoder().encode(JSON.stringify(payload))
  const ctBuf = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plain as unknown as BufferSource,
  )

  const envelope: Envelope = {
    v: FORMAT_VERSION,
    meta: { formatVersion: payload.formatVersion, exportedAt: payload.exportedAt, hasAccount: !!payload.account },
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    iterations: PBKDF2_ITERATIONS,
    ct: bytesToB64(new Uint8Array(ctBuf)),
  }
  return `${MAGIC}\n${strToB64(JSON.stringify(envelope))}`
}

function parseEnvelope(fileText: string): Envelope {
  const lines = fileText.trim().split('\n')
  if (lines.length < 2 || lines[0].trim() !== MAGIC) {
    throw new Error('文件格式不正确，不是有效的 BiliMusic 备份文件')
  }
  let env: Envelope
  try {
    env = JSON.parse(b64ToStr(lines[1].trim())) as Envelope
  } catch {
    throw new Error('文件已损坏，无法解析')
  }
  if (!env || env.v !== FORMAT_VERSION || !env.ct || !env.salt || !env.iv) {
    throw new Error('备份文件版本不受支持或已损坏')
  }
  return env
}

// ===== 解析信封（不解密，仅取明文 meta 供 UI 展示）=====
export function readBackupMeta(fileText: string): BackupMeta {
  return parseEnvelope(fileText).meta
}

// ===== 解密：.bmback 文本 -> 负载 =====
export async function decryptBackup(fileText: string, password: string): Promise<BackupPayload> {
  const env = parseEnvelope(fileText)
  const salt = b64ToBytes(env.salt)
  const iv = b64ToBytes(env.iv)
  const key = await deriveKey(password, salt, env.iterations || PBKDF2_ITERATIONS)
  let plainBuf: ArrayBuffer
  try {
    plainBuf = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      b64ToBytes(env.ct) as unknown as BufferSource,
    )
  } catch {
    throw new Error('口令错误或文件已损坏')
  }
  const payload = JSON.parse(new TextDecoder().decode(plainBuf)) as BackupPayload
  if (payload?.type !== 'backup' || !Array.isArray(payload.playlists)) {
    throw new Error('备份内容不完整或版本不受支持')
  }
  return payload
}

// ===== 合并恢复：负载 -> 本地存储（账号交由调用方按策略处理）=====
export interface ApplyResult {
  playlists: number
  favorites: number
  recent: number
  downloads: number
}

export function applyBackup(payload: BackupPayload): ApplyResult {
  // 歌单：mergeItems 处理增删（updatedAt 为版本，墓碑防复活）→ 再对存留歌单做曲项目录级合并
  const localPl = loadPlaylists()
  const plMerge = mergeItems<Playlist>(
    localPl, payload.playlists || [],
    loadPlaylistTombstones(), payload.playlistTombstones || [],
    (p) => p.id, (p) => p.updatedAt,
  )
  const playlists = mergePlaylistTracks(plMerge.items, localPl, payload.playlists || [])
  savePlaylists(playlists)
  savePlaylistTombstones(plMerge.tombstones)

  // 我喜欢：mergeItems（likedAt 为版本，墓碑防复活）
  const localFav = loadFavoriteTracks()
  const favMerge = mergeItems<Track>(
    localFav, payload.favorites || [],
    loadFavoriteTombstones(), payload.favoriteTombstones || [],
    (t) => t.id, (t) => t.likedAt || t.addedAt || '',
  )
  const favorites = favMerge.items.slice(0, 2000)
  saveFavoriteTracks(favorites)
  saveFavoriteTombstones(favMerge.tombstones)

  // 最近播放：按 id 并集去重（备份在前，保留更近语义），截断 50
  const recent = dedupeById([...(payload.recent || []), ...loadRecentTracks()], 50)
  saveRecentTracks(recent)

  // 下载记录：按 id 并集、downloadedAt 倒序、截断 200
  const downloads = dedupeById([...(payload.downloads || []), ...loadDownloadRecords()], 200)
    .sort((a, b) => ((b.downloadedAt || '') > (a.downloadedAt || '') ? 1 : -1))
  saveDownloadRecords(downloads)

  // 歌词偏移：本地优先合并
  saveLyricOffsetMap(mergeLyricOffsets(loadLyricOffsetMap(), payload.lyricOffsets))

  // 设置：整份覆盖（导入确认框已明示），与默认值合并防字段缺失
  saveAppSettings({ ...DEFAULT_APP_SETTINGS, ...(payload.settings || {}) } as AppSettings)

  // 深浅色模式：写回存储并即时应用到 DOM（v1.4.3-pre7 修复：主题此前未纳入备份）
  if (payload.theme) {
    const mode: ThemeMode = payload.theme
    localStorage.setItem(THEME_MODE_KEY, mode)
    void writeStoredItem(THEME_MODE_KEY, mode)
    document.documentElement.setAttribute('data-theme', resolveTheme(mode))
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT))
  }

  // 触发各页刷新事件
  window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT))
  window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT))
  window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT))
  window.dispatchEvent(new CustomEvent(RECENT_EVENT))

  return { playlists: playlists.length, favorites: favorites.length, recent: recent.length, downloads: downloads.length }
}

// ===== 账号恢复（v1.4.3-pre7）=====
// 把备份里的 B 站登录凭证写回 defaultSession，并主动跑一遍正常登录链路的验证
// （调 nav 接口，与收藏夹/用户信息同一渲染层 fetch，credentials:include）。只有
// Cookie 以 SameSite=None 正确写入才能验证通过，因此这一步能真实反映设备间衔接。
export interface RestoreAccountResult {
  ok: boolean
  loginVerified: boolean
  message?: string
  uname?: string
  face?: string
}

export async function restoreBackupAccount(account: BackupAccount | null): Promise<RestoreAccountResult> {
  if (!account || !account.sessdata || !account.dedeUserId) {
    return { ok: false, loginVerified: false, message: '备份中不含可用的登录凭证' }
  }
  const setCookies = platform.auth?.setCookies
  if (!setCookies) {
    return { ok: false, loginVerified: false, message: '当前环境不支持写入登录凭证' }
  }
  const res = await setCookies({
    sessdata: account.sessdata,
    biliJct: account.biliJct,
    dedeUserId: account.dedeUserId,
    dedeCkMd5: account.ckMd5 || '',
  })
  if (!res?.success) {
    return { ok: false, loginVerified: false, message: res?.message || '写入登录凭证失败' }
  }
  // 写入成功≠登录生效，用 nav 接口实际验证（未登录/失效时 biliFetch 会抛错）
  try {
    const nav = await getNavInfo()
    if (nav?.isLogin) {
      try {
        localStorage.setItem('bilimusic_user', JSON.stringify({ username: nav.uname, avatar: nav.face }))
      } catch { /* ignore */ }
      return { ok: true, loginVerified: true, uname: nav.uname, face: nav.face }
    }
    return { ok: true, loginVerified: false, message: '凭证已写入，但 B 站未确认登录（Cookie 可能已失效，需重新登录）' }
  } catch {
    return { ok: true, loginVerified: false, message: '凭证已写入，验证登录态时请求未通过（网络/风控或 Cookie 失效），若异常请重新登录' }
  }
}

// mergeItems 已决定存留哪些歌单 id；这里对这些存留歌单把本地与备份的同 id 曲项目录做并集合并
function mergePlaylistTracks(survivors: Playlist[], local: Playlist[], remote: Playlist[]): Playlist[] {
  const map = new Map<string, Playlist>()
  for (const p of [...local, ...remote]) {
    const ex = map.get(p.id)
    if (!ex) { map.set(p.id, { ...p, tracks: [...(p.tracks || [])] }); continue }
    const tracks = dedupeTracksById([...ex.tracks, ...(p.tracks || [])])
    const newer = new Date(p.updatedAt) > new Date(ex.updatedAt) ? p : ex
    map.set(p.id, { ...newer, tracks })
  }
  return survivors.map((s) => map.get(s.id) || s)
}

function dedupeTracksById(tracks: Track[]): Track[] {
  const byId = new Map<string, Track>()
  for (const t of tracks) {
    if (!t || !t.id) continue
    const cur = byId.get(t.id)
    if (!cur || (t.addedAt || '') >= (cur.addedAt || '')) byId.set(t.id, t)
  }
  return [...byId.values()].sort((a, b) => ((b.addedAt || '') > (a.addedAt || '') ? 1 : -1))
}

function dedupeById<T extends { id?: string }>(list: T[], limit: number): T[] {
  const byId = new Map<string, T>()
  for (const item of list) {
    if (!item || !item.id || byId.has(item.id)) continue
    byId.set(item.id, item)
  }
  return [...byId.values()].slice(0, limit)
}

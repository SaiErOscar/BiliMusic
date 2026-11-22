import type { AppSettings, DownloadRecord, EqualizerSettings, Playlist, Tombstone, Track } from '@/types'
import { readStoredItemSync, writeStoredItem } from '@/utils/persistentStorage'
import { safeSetItem } from '@/utils/safeStorage'

const RECENT_KEY = 'bilimusic_recent'
const FAVORITES_KEY = 'bilimusic_favorites'
const PLAYLISTS_KEY = 'bilimusic_playlists'
const PLAYLIST_TOMBSTONES_KEY = 'bilimusic_playlists_deleted'
const FAVORITE_TOMBSTONES_KEY = 'bilimusic_favorites_deleted'
const SETTINGS_KEY = 'bilimusic_settings'
export const PLAYLISTS_CHANGED_EVENT = 'bilimusic:playlists-changed'
export const FAVORITES_CHANGED_EVENT = 'bilimusic:favorites-changed'
export const SETTINGS_CHANGED_EVENT = 'bilimusic:settings-changed'
export const DOWNLOADS_CHANGED_EVENT = 'bilimusic:downloads-changed'

/**
 * v1.4.15-pre8 存储写入失败事件（修 R-05）。
 *
 * safeSetItem 一直正确返回 boolean，但 13 处调用方全部忽略了它——
 * 配额满时拖排序、加歌、收藏、导入备份**全部"成功"但不落盘**，重启即回退，
 * 用户对此毫无感知。这里把失败暴露成一个可订阅事件，由界面统一提示，
 * 不必改动每个 save 函数的签名（那会波及几十个调用点，风险大于收益）。
 */
export const STORAGE_FAILED_EVENT = 'bilimusic:storage-failed'

export interface StorageFailedDetail {
  /** 失败的键名，便于排查 */
  key: string
}

/** 写入失败时广播；UI 订阅后提示「存储空间不足，本次改动未保存」 */
function notifyStorageFailed(key: string): void {
  try {
    window.dispatchEvent(new CustomEvent<StorageFailedDetail>(STORAGE_FAILED_EVENT, { detail: { key } }))
  } catch {
    // 非浏览器环境（测试）没有 window，忽略
  }
}

/** 统一的落盘入口：返回是否真的写成功，失败时广播 */
function persist(key: string, value: string): boolean {
  const ok = safeSetItem(key, value)
  if (!ok) notifyStorageFailed(key)
  return ok
}

const DOWNLOADS_KEY = 'bilimusic_downloads'

/**
 * v1.4.15-pre1 均衡器默认值：关闭 + flat 全零。
 *
 * 与 src/services/equalizer.ts 的 EQ_PRESETS.flat.gains 必须一致；
 * 那边有测试断言两者相等，改一处漏另一处会直接变红。
 */
export const DEFAULT_EQUALIZER: EqualizerSettings = {
  enabled: false,
  preset: 'flat',
  gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  sidebarState: 'auto',
  playQuality: '高品质',
  downloadQuality: '高品质',
  downloadFormat: 'audio',
  downloadDir: '',
  autoPlay: true,
  showLyrics: true,
  lyricTextColor: '#ffffff',
  lyricControlColor: '#ff375f',
  lyricFontSize: 30,
  lyricFontWeight: 820,
  // v1.3.8 三面板字体默认 system-ui（与原样式一致）
  lyricFontFamily: 'system-ui',
  titleFontFamily: 'system-ui',
  playerLyricFontFamily: 'system-ui',
  // v1.3.10 自动颜色默认关闭（手动取色保持原行为）
  autoTextColor: false,
  autoControlColor: false,
  // 空串 = 尚未算出自动色，歌词窗兜底用手动色；避免初次开开关时闪一下默认色
  autoLyricTextColor: '',
  autoLyricControlColor: '',
  // v1.4.13-pre11 桌面歌词：外文自动 AI 增强默认关闭（会消耗 API 额度）
  autoAiLyricForeign: false,
  // 副行默认开启：有译文就显示，没有就自然不显示
  desktopLyricSubline: true,
  // v1.4.6 MV 导出：是否在画面角落加 BiliMusic 水印
  mvWatermark: true,
  // v1.4.7-pre1 MV 导出：流畅度档位（默认标准 0.1s 关键帧步长）
  mvSmoothness: '标准',
  // v1.4.8-pre1 播放三件套：倍速默认 1x，全局媒体键默认关（避抢占其他播放器）
  playbackRate: 1,
  globalMediaKeys: false,
  // v1.4.9-pre1 主题体系化：默认主题（BiliBili 粉，回落 index.css 默认值）、无自定义覆盖、无预设
  themeId: 'default',
  themeSeedOverride: {},
  lyricPresets: [],
  // v1.4.9-pre2 音频可视化默认关（保默认起播延迟）；歌词双语默认关（不改变既有单语观感）
  audioVisualizer: false,
  lyricBilingual: false,
  // v1.4.9-pre3 MV 无控件导出默认关：保持既有导出画面（含控件）不变
  mvCleanExport: false,
  // v1.4.11-pre2 封面取景默认 cover：与 v1.4.10/pre1 已发布行为一致，
  // 升级用户观感零变化；contain / fill 作为显式可选项。
  coverFit: 'cover',
  // v1.4.14-pre4 曲目标题清洗默认「程序清洗」：免费且确定性，
  // AI 清洗要消耗额度，必须由用户显式选择。
  titleCleanMode: 'rule',
  // v1.4.14-pre6 池外推荐默认关闭：它会在池内推荐之外多发一次请求，
  // 还要逐条查接口 + 一次 AI 核对，额度消耗明显更高，必须由用户显式打开。
  aiExternalRecommend: false,
  // v1.4.15-pre1 均衡器默认关闭：关闭时不接管播放链路，升级用户听感零变化。
  equalizer: DEFAULT_EQUALIZER,
  // v1.4.15-pre2 淡入淡出切歌默认关闭：关闭即零延迟硬切，升级用户听感零变化。
  // 时长默认 3 秒（淡出 1.5s + 淡入 1.5s），合法范围 1~10 秒。
  crossfadeEnabled: false,
  crossfadeSeconds: 3,
}

function notifySettingsChanged() {
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT))
}

export function loadRecentTracks(): Track[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveRecentTracks(tracks: Track[]) {
  try {
    safeSetItem(RECENT_KEY, JSON.stringify(tracks.slice(0, 50)))
  } catch { /* ignore */ }
}

export function loadDownloadRecords(): DownloadRecord[] {
  try {
    const raw = localStorage.getItem(DOWNLOADS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

// v1.4.3-pre6 备份导入：批量覆盖下载记录（合并后整体写回）
export function saveDownloadRecords(records: DownloadRecord[]) {
  try {
    safeSetItem(DOWNLOADS_KEY, JSON.stringify(records.slice(0, 200)))
    window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  } catch { /* ignore */ }
}

export function saveDownloadRecord(record: DownloadRecord) {
  try {
    const records = loadDownloadRecords()
    records.unshift(record)
    safeSetItem(DOWNLOADS_KEY, JSON.stringify(records.slice(0, 200)))
    window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  } catch { /* ignore */ }
}

export function clearDownloadRecords() {
  try {
    localStorage.removeItem(DOWNLOADS_KEY)
    window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  } catch { /* ignore */ }
}

/** 删除单条下载记录（pre3）：仅移除记录本身，不触碰磁盘文件 */
export function deleteDownloadRecord(id: string) {
  try {
    const records = loadDownloadRecords().filter((r) => r.id !== id)
    safeSetItem(DOWNLOADS_KEY, JSON.stringify(records))
    window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  } catch { /* ignore */ }
}

export function addRecentTrack(track: Track) {
  const recent = loadRecentTracks().filter(t => t.id !== track.id)
  recent.unshift({ ...track, isLiked: track.isLiked })
  saveRecentTracks(recent)
  // 通知最近播放页面实时刷新
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bilimusic:recent-changed'))
  }
}


// ===== v1.4.12-pre1 播放行为埋点（AI 听歌画像的数据基础） =====
//
// 与「最近播放」分开：最近播放是给用户看的列表（只留 50 条、无统计），
// 这里是给画像用的聚合数据，需要累计次数与时长、且不能被列表截断。
// 存 localStorage 单键，按 id 索引；只记本地、不上传。

const PLAY_STATS_KEY = 'bilimusic_play_stats'

export interface PlayStat {
  id: string
  title: string
  artist: string
  /** 起播次数（含未听完） */
  plays: number
  /** 累计实际播放秒数 */
  seconds: number
  /** 完整听完的次数（听到结尾 90% 以上） */
  completions: number
  /** 首次播放时间（ISO） */
  firstAt: string
  /** 最近播放时间（ISO） */
  lastAt: string
}

/** 最多保留多少首的统计，防止无限增长 */
export const PLAY_STATS_LIMIT = 500

export function loadPlayStats(): Record<string, PlayStat> {
  try {
    const raw = localStorage.getItem(PLAY_STATS_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as Record<string, PlayStat>
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function savePlayStats(stats: Record<string, PlayStat>): void {
  // 超出上限时按最近播放时间裁剪，保留最近听过的
  const entries = Object.entries(stats)
  if (entries.length > PLAY_STATS_LIMIT) {
    entries.sort((a, b) => (b[1].lastAt || '').localeCompare(a[1].lastAt || ''))
    stats = Object.fromEntries(entries.slice(0, PLAY_STATS_LIMIT))
  }
  safeSetItem(PLAY_STATS_KEY, JSON.stringify(stats))
}

/** 记录一次起播（在真正开始播放时调用，切歌时先结算上一首） */
export function recordPlayStart(track: Track): void {
  try {
    const stats = loadPlayStats()
    const now = new Date().toISOString()
    const prev = stats[track.id]
    stats[track.id] = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      plays: (prev?.plays || 0) + 1,
      seconds: prev?.seconds || 0,
      completions: prev?.completions || 0,
      firstAt: prev?.firstAt || now,
      lastAt: now,
    }
    savePlayStats(stats)
  } catch { /* 埋点失败不影响播放 */ }
}

/**
 * 结算一段实际播放时长。
 *
 * @param seconds 本段播放了多少秒（调用方按实际推进量给，不是墙钟时间）
 * @param completed 是否听到结尾（>=90% 视为听完）
 */
export function recordPlayProgress(trackId: string, seconds: number, completed = false): void {
  if (!trackId || !Number.isFinite(seconds) || seconds <= 0) return
  try {
    const stats = loadPlayStats()
    const cur = stats[trackId]
    if (!cur) return // 没有起播记录就不凭空造一条
    cur.seconds = Math.round((cur.seconds + seconds) * 10) / 10
    if (completed) cur.completions += 1
    stats[trackId] = cur
    savePlayStats(stats)
  } catch { /* ignore */ }
}

/** v1.4.13-pre4 备份恢复用：整份写回播放统计 */
export function savePlayStatsRaw(stats: Record<string, PlayStat>): void {
  try {
    safeSetItem(PLAY_STATS_KEY, JSON.stringify(stats || {}))
  } catch {
    /* ignore */
  }
}

/** 清空播放统计（隐私入口，设置页提供） */
export function clearPlayStats(): void {
  try {
    localStorage.removeItem(PLAY_STATS_KEY)
    window.dispatchEvent(new CustomEvent('bilimusic:play-stats-changed'))
  } catch { /* ignore */ }
}
export function loadFavoriteTracks(): Track[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

/** 保存收藏。返回是否真的落盘（v1.4.15-pre8 修 R-05） */
export function saveFavoriteTracks(tracks: Track[]): boolean {
  try {
    const ok = persist(FAVORITES_KEY, JSON.stringify(tracks))
    if (ok) window.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT))
    return ok
  } catch {
    return false
  }
}

// ===== B站收藏夹本地缓存（按收藏夹 ID 保存，供离线回退显示）=====
const BILI_FOLDER_CACHE_KEY = 'bilimusic_bili_folder_cache'

/** 读取指定收藏夹的本地缓存（无则返回空数组） */
export function loadBiliFolderCache(folderId: number | string): Track[] {
  try {
    const raw = localStorage.getItem(BILI_FOLDER_CACHE_KEY)
    if (!raw) return []
    const map = JSON.parse(raw) as Record<string, Track[]>
    return map[String(folderId)] || []
  } catch {
    return []
  }
}

/** 保存指定收藏夹的本地缓存 */
export function saveBiliFolderCache(folderId: number | string, tracks: Track[]): void {
  try {
    const raw = localStorage.getItem(BILI_FOLDER_CACHE_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, Track[]>) : {}
    map[String(folderId)] = tracks
    safeSetItem(BILI_FOLDER_CACHE_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

/**
 * 「当前打开的收藏夹」持久化键（v1.4.1 从 BiliFavorites 提取到此处，
 * 供发现页等跨页面读取选中夹，避免键名漂移）。
 */
export const SYNCED_FOLDER_KEY = 'bilimusic_synced_folder'

/** 读取当前选中的收藏夹 ID；未选中/非法返回 null。 */
export function getSyncedBiliFolderId(): number | null {
  try {
    const raw = localStorage.getItem(SYNCED_FOLDER_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/** 写入当前选中的收藏夹 ID。 */
export function setSyncedBiliFolderId(folderId: number | string): void {
  try {
    localStorage.setItem(SYNCED_FOLDER_KEY, String(folderId))
  } catch { /* ignore */ }
}

export function toggleFavoriteTrack(track: Track): Track[] {
  const favs = loadFavoriteTracks()
  const idx = favs.findIndex(t => t.id === track.id)
  if (idx >= 0) {
    favs.splice(idx, 1)
    addTombstone(FAVORITE_TOMBSTONES_KEY, track.id) // 取消收藏 → 记墓碑
  } else {
    favs.unshift({ ...track, isLiked: true, likedAt: new Date().toISOString() })
    removeTombstone(FAVORITE_TOMBSTONES_KEY, track.id) // 重新收藏 → 清墓碑
  }
  saveFavoriteTracks(favs)
  return favs
}

// 从收藏移除并记墓碑（供收藏页删除使用，确保同步不复活）
export function removeFavoriteTrack(id: string): Track[] {
  const favs = loadFavoriteTracks().filter(t => t.id !== id)
  addTombstone(FAVORITE_TOMBSTONES_KEY, id)
  saveFavoriteTracks(favs)
  return favs
}

function notifyPlaylistsChanged() {
  window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT))
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `playlist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// ===== 删除墓碑（云同步用）=====
function loadTombstones(key: string): Tombstone[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
function saveTombstones(key: string, list: Tombstone[]): void {
  try {
    safeSetItem(key, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}
function addTombstone(key: string, id: string): void {
  const list = loadTombstones(key).filter((t) => t.id !== id)
  list.push({ id, deletedAt: new Date().toISOString() })
  saveTombstones(key, list)
}
function removeTombstone(key: string, id: string): void {
  saveTombstones(key, loadTombstones(key).filter((t) => t.id !== id))
}
export function loadPlaylistTombstones(): Tombstone[] {
  return loadTombstones(PLAYLIST_TOMBSTONES_KEY)
}
export function savePlaylistTombstones(list: Tombstone[]): void {
  saveTombstones(PLAYLIST_TOMBSTONES_KEY, list)
}
export function loadFavoriteTombstones(): Tombstone[] {
  return loadTombstones(FAVORITE_TOMBSTONES_KEY)
}
export function saveFavoriteTombstones(list: Tombstone[]): void {
  saveTombstones(FAVORITE_TOMBSTONES_KEY, list)
}

export function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/**
 * 保存歌单。**返回是否真的落盘**（v1.4.15-pre8 修 R-05）。
 * 调用方拿 false 时应当回滚界面状态并提示，而不是当作成功。
 */
export function savePlaylists(playlists: Playlist[]): boolean {
  try {
    const ok = persist(PLAYLISTS_KEY, JSON.stringify(playlists))
    // 写入失败就不广播「已变更」，否则各订阅方会拿内存里的新值渲染，看起来像保存成功了
    if (ok) notifyPlaylistsChanged()
    return ok
  } catch {
    return false
  }
}

export function sortPlaylists(order: 'updatedAt' | 'name'): void {
  const list = loadPlaylists()
  if (order === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name))
  } else {
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }
  savePlaylists(list)
}

export function createPlaylist(input: { name: string; description?: string; coverUrl?: string }): Playlist {
  const now = new Date().toISOString()
  const playlist: Playlist = {
    id: createId(),
    name: input.name.trim(),
    description: input.description?.trim() || '',
    coverUrl: input.coverUrl?.trim() || '',
    tracks: [],
    createdAt: now,
    updatedAt: now,
  }
  savePlaylists([playlist, ...loadPlaylists()])
  return playlist
}

export function getPlaylist(id: string): Playlist | null {
  return loadPlaylists().find(p => p.id === id) || null
}

export function updatePlaylist(updated: Playlist): void {
  const playlists = loadPlaylists()
  savePlaylists(playlists.map(p => p.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : p))
}

export function deletePlaylist(id: string): void {
  addTombstone(PLAYLIST_TOMBSTONES_KEY, id) // 记墓碑，避免同步后被对端复活
  savePlaylists(loadPlaylists().filter(p => p.id !== id))
}

export function addTrackToPlaylist(playlistId: string, track: Track): Playlist | null {
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    const exists = playlist.tracks.some(t => t.id === track.id)
    updatedPlaylist = {
      ...playlist,
      coverUrl: playlist.coverUrl || track.coverUrl,
      tracks: exists
        ? playlist.tracks
        : [...playlist.tracks, { ...track, addedAt: track.addedAt || new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    }
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return updatedPlaylist
}

export function loadAppSettings(): AppSettings {
  try {
    const raw = readStoredItemSync(SETTINGS_KEY)
    if (!raw) return DEFAULT_APP_SETTINGS
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_APP_SETTINGS
  }
}

export function saveAppSettings(settings: AppSettings) {
  try {
    void writeStoredItem(SETTINGS_KEY, JSON.stringify(settings))
    notifySettingsChanged()
  } catch {
    // ignore
  }
}

export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadAppSettings(), ...patch }
  saveAppSettings(next)
  return next
}

export function createPlaylistsExport() {
  return {
    app: 'biliMusic',
    type: 'playlists',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists: loadPlaylists(),
  }
}

function isPlainPlaylist(value: unknown): value is Playlist {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Playlist>
  return typeof item.name === 'string' && Array.isArray(item.tracks)
}

export function importPlaylistsFromText(text: string): { imported: number; skipped: number } {
  const parsed = JSON.parse(text)
  const incoming = Array.isArray(parsed) ? parsed : parsed?.playlists
  if (!Array.isArray(incoming)) {
    throw new Error('文件中没有找到歌单列表')
  }

  const now = new Date().toISOString()
  const existing = loadPlaylists()
  const existingIds = new Set(existing.map(playlist => playlist.id))
  const existingNames = new Set(existing.map(playlist => playlist.name.trim()))
  const imported: Playlist[] = []
  let skipped = 0

  for (const item of incoming) {
    if (!isPlainPlaylist(item)) {
      skipped += 1
      continue
    }

    const name = item.name.trim()
    if (!name) {
      skipped += 1
      continue
    }

    const id = item.id && !existingIds.has(item.id) ? item.id : createId()
    existingIds.add(id)
    const finalName = existingNames.has(name) ? `${name} 导入` : name
    existingNames.add(finalName)

    imported.push({
      id,
      name: finalName,
      description: item.description || '',
      coverUrl: item.coverUrl || item.tracks[0]?.coverUrl || '',
      tracks: item.tracks,
      createdAt: item.createdAt || now,
      updatedAt: now,
    })
  }

  if (imported.length > 0) {
    savePlaylists([...imported, ...existing])
  }

  return { imported: imported.length, skipped }
}

export function reorderPlaylistTracks(playlistId: string, orderedTrackIds: string[]): Playlist | null {
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    const byId = new Map(playlist.tracks.map(t => [t.id, t]))
    const ordered: Track[] = []
    for (const id of orderedTrackIds) {
      const t = byId.get(id)
      if (t) ordered.push(t)
    }
    // 保留不在有序列表中的轨道（防御性追加）
    for (const t of playlist.tracks) {
      if (!orderedTrackIds.includes(t.id)) ordered.push(t)
    }
    updatedPlaylist = { ...playlist, tracks: ordered, updatedAt: new Date().toISOString() }
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return updatedPlaylist
}

export function sortPlaylistTracks(playlistId: string, order: 'name' | 'addedAt'): Playlist | null {
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    const sorted = [...playlist.tracks]
    if (order === 'name') {
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    } else {
      // 按加入歌单时间排序（旧的在前），缺失时间排最后
      sorted.sort((a, b) => {
        const at = a.addedAt ? new Date(a.addedAt).getTime() : 0
        const bt = b.addedAt ? new Date(b.addedAt).getTime() : 0
        return at - bt
      })
    }
    updatedPlaylist = { ...playlist, tracks: sorted, updatedAt: new Date().toISOString() }
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return updatedPlaylist
}

// ===== v1.4.15-pre5 本地音乐索引 =====
// 单独一个键，不进 AppSettings：曲库体积随文件数增长，塞进设置会让每次读写设置
// 都拖着几千条记录走，也会让云同步把整库曲目当设置上传。
const LOCAL_TRACKS_KEY = 'bilimusic_local_tracks'
const LOCAL_DIRS_KEY = 'bilimusic_local_dirs'

/** 读取本地曲库；损坏或结构不对时返回空数组而不是抛错 */
export function loadLocalTracks(): Track[] {
  try {
    const raw = readStoredItemSync(LOCAL_TRACKS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 只认真正带 localPath 的条目：没有路径的本地曲目无法播放，留着只会制造死条目
    return parsed.filter((t: Track) => t && typeof t.id === 'string' && typeof t.localPath === 'string' && t.localPath)
  } catch {
    return []
  }
}

export function saveLocalTracks(tracks: Track[]): void {
  /*
   * v1.4.16-pre1：落盘前剥掉 blob: 封面 URL。
   *
   * 封面是扫描时用 URL.createObjectURL 生成的，**只在当前页面生命周期内有效**，
   * 刷新后全部失效。原样存进 localStorage 会让下次启动读到一堆死链，
   * 界面上表现为「封面加载失败」而不是「没有封面」，比空着更糟。
   * 这里只存元数据，封面下次扫描时重新生成。
   */
  const persistable = tracks.map((t) =>
    t.coverUrl && t.coverUrl.startsWith('blob:') ? { ...t, coverUrl: '' } : t,
  )
  safeSetItem(LOCAL_TRACKS_KEY, JSON.stringify(persistable))
}

/** 已导入过的目录列表，供界面回显与「重新扫描」 */
export function loadLocalDirs(): string[] {
  try {
    const raw = readStoredItemSync(LOCAL_DIRS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d: unknown) => typeof d === 'string' && d)
  } catch {
    return []
  }
}

export function saveLocalDirs(dirs: string[]): void {
  safeSetItem(LOCAL_DIRS_KEY, JSON.stringify(dirs))
}

export function removeTracksFromPlaylist(playlistId: string, trackIds: string[]): Playlist | null {
  const ids = new Set(trackIds)
  if (ids.size === 0) return getPlaylist(playlistId)
  const playlists = loadPlaylists()
  let updatedPlaylist: Playlist | null = null
  const updated = playlists.map((playlist) => {
    if (playlist.id !== playlistId) return playlist
    updatedPlaylist = {
      ...playlist,
      tracks: playlist.tracks.filter(track => !ids.has(track.id)),
      updatedAt: new Date().toISOString(),
    }
    return updatedPlaylist
  })
  if (updatedPlaylist) savePlaylists(updated)
  return updatedPlaylist
}

/**
 * v1.4.14-pre9 对话助手 · 动作执行器
 *
 * 分工：assistantActions.ts 只声明「有哪些动作」，assistantSession.ts 只把自然语言收敛成
 * 参数，真正产生副作用的地方只有本模块。
 *
 * 设计要点：
 * - **与 React 解耦**：player 以结构类型传入（等价 usePlayer() 的返回值），本模块不 import hook，
 *   测试传一个只实现两三个方法的假 player 就能跑。
 * - **不抛裸 Error**：所有分支外层统一 try/catch，失败一律转成可读中文放进 message/error，
 *   调用方永远拿到 ExecuteResult。
 * - **风险分级在这里落地**：risk==='confirm' 的动作在 confirmed !== true 时直接返回 needsConfirm，
 *   不产生任何副作用——「先问清楚再动手」不依赖 UI 自觉。
 * - **settings 33 条走前缀分发**：settings.set-<field> 读后缀 → 按注册表里的 param 类型校验 →
 *   updateAppSettings。注册表将来加字段，这里自动支持，不需要改执行器。
 * - **网络/平台副作用可注入**：searchVideo / downloadTrack / exportTrackMv / 版本读取都走
 *   ExecutorDeps，默认指向真实实现，测试传桩即可完全离线。
 */

import type { AppSettings, Playlist, RepeatMode, Track } from '@/types'
import type { usePlayer } from '@/contexts/PlayerContext'
import type { AssistantAction, ActionParam } from '@/services/assistantActions'
import type { AudioQualityPreference } from '@/services/bilibiliApi'
import type { SearchItem } from '@/services/api'
import { getAssistantAction } from '@/services/assistantActions'
import { CREATE_PLAYLIST_KEY } from '@/services/assistantSession'
import { downloadTrack, searchVideo } from '@/services/api'
import { cleanFilenameForDownload, cleanFilenamesForDownload } from '@/services/titleClean'
import { exportTrackMv } from '@/services/mvExport'
import { platform } from '@/platform'
import { semverGt } from '@/utils/semver'
import {
  DEFAULT_APP_SETTINGS,
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  loadAppSettings,
  loadFavoriteTracks,
  loadPlaylists,
  removeFavoriteTrack,
  toggleFavoriteTrack,
  updateAppSettings,
  updatePlaylist,
} from '@/utils/storage'

/* ---------- 对外接口 ---------- */

/**
 * 执行器需要的播放器能力。
 *
 * 刻意全部可选：真实调用方传 usePlayer() 的返回值（成员齐全），测试传最小桩对象即可。
 * 缺哪一项就只影响依赖它的那个动作，其余动作照常工作。
 */
export interface AssistantPlayer {
  play?: (track: Track) => void
  pause?: () => void
  togglePlay?: () => void
  next?: () => void
  prev?: () => void
  setVolume?: (v: number) => void
  setRepeatMode?: (m: RepeatMode) => void
  setPlaybackRate?: (r: number) => void
  /**
   * 注意：进度控制在 usePlayerProgress() 里，usePlayer() **不含** setProgress。
   * 调用方若同时拿到 progress context，把它一并传进来即可启用「跳转进度」。
   */
  setProgress?: (p: number) => void
  currentTrack?: Track | null
  isPlaying?: boolean
  volume?: number
  queue?: Track[]
}

/** 当前曲目的轻量描述（真实 Track 在结构上满足它，可直接传） */
export interface CurrentTrackHint {
  title: string
  artist: string
  bvid?: string
}

export interface ExecuteContext {
  player: AssistantPlayer
  playlists: { id: string; name: string }[]
  currentTrack?: CurrentTrackHint | null
}

export interface ExecuteResult {
  ok: boolean
  /** 给用户看的反馈，如「已添加到歌单「夜跑」」 */
  message: string
  /** 需要二次确认时，把动作挂起等用户确认 */
  needsConfirm?: boolean
  /** 失败原因（ok=false 时） */
  error?: string
}

/** 可注入的副作用（默认指向真实实现；测试传桩即可离线） */
export interface ExecutorDeps {
  searchVideo: typeof searchVideo
  downloadTrack: typeof downloadTrack
  exportTrackMv: typeof exportTrackMv
  /** 当前应用版本；拿不到返回 null（非桌面端没有 updater 能力） */
  getAppVersion: () => Promise<string | null>
  /** 读远端 ota.json 的版本号；失败返回 null，绝不抛 */
  fetchRemoteVersion: (url: string) => Promise<string | null>
}

export interface ExecuteOptions {
  confirmed?: boolean
  /** 仅供测试注入；生产调用不要传 */
  deps?: Partial<ExecutorDeps>
}

/**
 * 编译期契约：usePlayer() 的返回值必须能直接当 ExecuteContext.player 用。
 * 只做类型断言，运行时零开销（import type 会被完全擦除）。
 * PlayerContextValue 的签名一旦漂移，这里先红，而不是等到 UI 层才炸。
 */
export function assertPlayerContract(player: ReturnType<typeof usePlayer>): AssistantPlayer {
  return player
}

/* ---------- 常量与内部类型 ---------- */

const SETTINGS_PREFIX = 'settings.set-'

/** 数值型设置项的合理区间；未列出的数值项不限 */
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  lyricFontSize: { min: 8, max: 120 },
  lyricFontWeight: { min: 100, max: 900 },
  playbackRate: { min: 0.5, max: 2 },
}

/** 必须是 #rrggbb 的颜色类设置项 */
const HEX_FIELDS = new Set(['lyricTextColor', 'lyricControlColor'])

const REPEAT_LABELS: Record<RepeatMode, string> = {
  none: '不循环',
  all: '列表循环',
  one: '单曲循环',
  shuffle: '随机播放',
}

interface HandlerContext {
  action: AssistantAction
  params: Record<string, unknown>
  context: ExecuteContext
  deps: ExecutorDeps
}

type Handler = (ctx: HandlerContext) => Promise<ExecuteResult>
type Validated = { ok: true; value: unknown } | { ok: false; error: string }
type TrackResolution = { track: Track } | { error: string }
type PlaylistResolution = { playlist: Playlist; created: boolean } | { error: string }

/* ---------- 小工具 ---------- */

function ok(message: string): ExecuteResult {
  return { ok: true, message }
}

function fail(error: string): ExecuteResult {
  return { ok: false, message: error, error }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return '未知错误'
}

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim()) {
    const value = Number(raw.trim())
    return Number.isFinite(value) ? value : null
  }
  return null
}

const TRUE_WORDS = ['true', '1', '开', '开启', '是', '启用', '打开', 'yes', 'on']
const FALSE_WORDS = ['false', '0', '关', '关闭', '否', '停用', '不要', 'no', 'off']

function coerceBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase()
    if (!text) return null
    if (FALSE_WORDS.includes(text)) return false
    if (TRUE_WORDS.includes(text)) return true
  }
  return null
}

function isTrackLike(value: unknown): value is Track {
  if (!value || typeof value !== 'object') return false
  const track = value as Partial<Track>
  return typeof track.id === 'string' && typeof track.title === 'string' && typeof track.bvid === 'string'
}

function isRepeatMode(value: unknown): value is RepeatMode {
  return value === 'none' || value === 'all' || value === 'one' || value === 'shuffle'
}

/** 搜索结果转 Track（与 Search.tsx 的 searchItemToTrack 同构；边界内不能 import 页面，故此处独立实现） */
function parseDuration(duration: string): number {
  if (!duration) return 0
  const parts = duration.split(':').map(Number)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

function searchItemToTrack(item: SearchItem): Track {
  return {
    id: item.bvid,
    title: item.title,
    artist: item.author,
    coverUrl: item.pic,
    duration: parseDuration(item.duration),
    videoUrl: `https://www.bilibili.com/video/${item.bvid}`,
    bvid: item.bvid,
    playCount: item.play,
    isLiked: false,
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function qualityPreference(value: AppSettings['downloadQuality']): AudioQualityPreference {
  if (value === '标准') return 'standard'
  if (value === '无损') return 'lossless'
  return 'high'
}

/** 当前曲目：优先播放器里的完整 Track，其次 context 里传的完整 Track */
function currentTrackFor(context: ExecuteContext): Track | null {
  if (isTrackLike(context.player.currentTrack)) return context.player.currentTrack
  if (isTrackLike(context.currentTrack)) return context.currentTrack
  return null
}

function currentTitleFor(context: ExecuteContext): string | null {
  const track = currentTrackFor(context)
  if (track) return track.title
  return context.currentTrack?.title ?? null
}

/* ---------- 曲目 / 歌单解析 ---------- */

function matchTrack(tracks: Track[], keyword: string): Track | null {
  const q = keyword.trim().toLowerCase()
  if (!q) return null
  const exact = tracks.find(
    t => t.id.toLowerCase() === q || t.bvid.toLowerCase() === q || t.title.toLowerCase() === q,
  )
  if (exact) return exact
  return tracks.find(t => t.title.toLowerCase().includes(q)) ?? null
}

function findLocalTrack(keyword: string, context: ExecuteContext): Track | null {
  const pools: Track[] = [
    ...(context.player.queue ?? []),
    ...(isTrackLike(context.player.currentTrack) ? [context.player.currentTrack] : []),
    ...loadFavoriteTracks(),
    ...loadPlaylists().flatMap(p => p.tracks),
  ]
  return matchTrack(pools, keyword)
}

/**
 * 把参数里的 track 收敛成真实 Track：
 * 1. 已经是 Track 对象 → 直接用；
 * 2. 是字符串 → 先在本地点播队列/收藏/歌单里找，找不到再搜 B站取第一条；
 * 3. 空 → 当前播放曲目。
 */
async function resolveTrack(raw: unknown, ctx: HandlerContext): Promise<TrackResolution> {
  if (isTrackLike(raw)) return { track: raw }

  const keyword = typeof raw === 'string' ? raw.trim() : ''
  if (!keyword) {
    const current = currentTrackFor(ctx.context)
    if (current) return { track: current }
    return { error: '没有正在播放的歌曲，说一首歌名我帮你找。' }
  }

  const local = findLocalTrack(keyword, ctx.context)
  if (local) return { track: local }

  try {
    const result = await ctx.deps.searchVideo(keyword, 1, 5)
    const first = result.items[0]
    if (first) return { track: searchItemToTrack(first) }
  } catch (error) {
    return { error: `搜索《${keyword}》失败：${describeError(error)}` }
  }
  return { error: `没找到《${keyword}》，换个说法试试。` }
}

function resolvePlaylistTarget(raw: unknown, ctx: HandlerContext, allowCreate: boolean): PlaylistResolution {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!key) return { error: '没说是哪个歌单。' }

  // CREATE_PLAYLIST_KEY：此时 params.playlist 是「名字」而不是已存在的 id
  if (ctx.params[CREATE_PLAYLIST_KEY] === true) {
    if (!allowCreate) return { error: `歌单「${key}」还不存在，先新建它再做这一步吧。` }
    return { playlist: createPlaylist({ name: key }), created: true }
  }

  const byId = getPlaylist(key)
  if (byId) return { playlist: byId, created: false }

  const all = loadPlaylists()
  const byName = all.find(p => p.name === key) ?? all.find(p => p.name.toLowerCase().includes(key.toLowerCase()))
  if (byName) return { playlist: byName, created: false }

  const hint = ctx.context.playlists.find(p => p.id === key || p.name === key)
  if (hint) {
    const fromHint = getPlaylist(hint.id)
    if (fromHint) return { playlist: fromHint, created: false }
  }

  return { error: `没找到歌单「${key}」。` }
}

/* ---------- 设置项 ---------- */

function validateSettingValue(field: string, spec: ActionParam, raw: unknown): Validated {
  switch (spec.type) {
    case 'boolean': {
      const value = coerceBoolean(raw)
      if (value === null) return { ok: false, error: `${spec.desc}。请回答「开」或「关」。` }
      return { ok: true, value }
    }
    case 'number': {
      const value = coerceNumber(raw)
      if (value === null) return { ok: false, error: `${spec.desc}。请给我一个数字。` }
      const range = NUMBER_RANGES[field]
      if (range && (value < range.min || value > range.max)) {
        return { ok: false, error: `${spec.desc}。取值要在 ${range.min}–${range.max} 之间。` }
      }
      return { ok: true, value }
    }
    case 'enum': {
      const options = spec.options ?? []
      const text = typeof raw === 'string' ? raw.trim() : ''
      const hit = options.find(o => o.value === text || o.label === text)
      if (!hit) {
        return { ok: false, error: `可选：${options.map(o => o.label).join(' / ')}。` }
      }
      return { ok: true, value: hit.value }
    }
    default: {
      if (typeof raw !== 'string' || !raw.trim()) {
        return { ok: false, error: `${spec.desc}。请给我一段文字。` }
      }
      const value = raw.trim()
      if (HEX_FIELDS.has(field) && !/^#[0-9a-fA-F]{6}$/.test(value)) {
        return { ok: false, error: '颜色要写成 #rrggbb 这样的六位十六进制，比如 #ff375f。' }
      }
      return { ok: true, value }
    }
  }
}

function describeSettingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '开' : '关'
  return String(value)
}

/** settings.set-<field>：读后缀 → 校验 → 落盘 */
function applySetting(action: AssistantAction, params: Record<string, unknown>): ExecuteResult {
  const field = action.id.slice(SETTINGS_PREFIX.length)
  const spec = action.params[0]

  // 注册表里 4 个字段没有 param：派生色 / 结构体，天然不可在对话里设置
  if (!spec) {
    return fail(`${action.label} 不能在对话里设置，请在设置页查看。`)
  }
  if (!(field in DEFAULT_APP_SETTINGS)) {
    return fail(`未知设置项「${field}」。`)
  }

  const parsed = validateSettingValue(field, spec, params[field])
  if (!parsed.ok) return fail(parsed.error)

  // 动态键写 Partial<AppSettings>：索引签名不在 interface 上，需要一次显式断言
  const patch = { [field]: parsed.value } as unknown as Partial<AppSettings>
  updateAppSettings(patch)
  return ok(`已把${action.label}设为 ${describeSettingValue(parsed.value)}。`)
}

/* ---------- 各动作的执行分支 ---------- */

const HANDLERS: Record<string, Handler> = {
  'playback.play': async ({ context }) => {
    const track = currentTrackFor(context)
    if (!track) return fail('还没有可播放的歌曲，先搜一首吧。')
    if (context.player.isPlaying === true) return ok(`正在播放《${track.title}》。`)
    if (!context.player.togglePlay) return fail('播放器还没准备好，稍后再试。')
    context.player.togglePlay()
    return ok(`继续播放《${track.title}》。`)
  },

  'playback.pause': async ({ context }) => {
    if (context.player.isPlaying === false) return ok('现在本来就没有在播放。')
    if (!context.player.pause) return fail('播放器还没准备好，稍后再试。')
    context.player.pause()
    return ok('已暂停。')
  },

  'playback.next': async ({ context }) => {
    if (!context.player.next) return fail('播放器还没准备好，稍后再试。')
    context.player.next()
    return ok('已切到下一首。')
  },

  'playback.prev': async ({ context }) => {
    if (!context.player.prev) return fail('播放器还没准备好，稍后再试。')
    context.player.prev()
    return ok('已回到上一首。')
  },

  'playback.volume': async ({ params, context }) => {
    const value = coerceNumber(params.volume)
    if (value === null) return fail('音量要给我一个 0–100 的数字。')
    if (value < 0 || value > 100) return fail('音量只能在 0–100 之间。')
    if (!context.player.setVolume) return fail('播放器还没准备好，稍后再试。')
    context.player.setVolume(Math.round(value))
    return ok(`音量已调到 ${Math.round(value)}%。`)
  },

  'playback.rate': async ({ params, context }) => {
    const value = coerceNumber(params.rate)
    if (value === null) return fail('倍速要给我一个 0.5–2.0 之间的数字。')
    if (value < 0.5 || value > 2) return fail('倍速只能在 0.5–2.0 之间。')
    if (!context.player.setPlaybackRate) return fail('播放器还没准备好，稍后再试。')
    context.player.setPlaybackRate(value)
    return ok(`倍速已调到 ${value}x。`)
  },

  'playback.repeat': async ({ params, context }) => {
    const mode = params.mode
    if (!isRepeatMode(mode)) return fail('循环模式只有：不循环 / 列表循环 / 单曲循环 / 随机播放。')
    if (!context.player.setRepeatMode) return fail('播放器还没准备好，稍后再试。')
    context.player.setRepeatMode(mode)
    return ok(`已设为${REPEAT_LABELS[mode]}。`)
  },

  'playback.shuffle': async ({ context }) => {
    if (!context.player.setRepeatMode) return fail('播放器还没准备好，稍后再试。')
    context.player.setRepeatMode('shuffle')
    return ok('已开始随机播放。')
  },

  'playback.seek': async ({ params, context }) => {
    const raw = typeof params.position === 'string' ? params.position.trim() : String(params.position ?? '')
    if (!raw) return fail('要跳到哪个位置？可以说 1:30 或 50%。')

    const duration = currentTrackFor(context)?.duration ?? 0
    const target = parsePosition(raw, duration)
    if (target === null) return fail('没看懂这个位置，可以说 1:30、90 或 50%。')
    if (!context.player.setProgress) return fail('现在还不能跳转进度，请在播放页拖动进度条。')

    context.player.setProgress(target)
    return ok(`已跳到 ${formatSeconds(target)}。`)
  },

  'playlist.create': async ({ params }) => {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    if (!name) return fail('新歌单叫什么名字？')
    const created = createPlaylist({ name })
    return ok(`已新建歌单「${created.name}」。`)
  },

  'playlist.rename': async (ctx) => {
    const name = typeof ctx.params.name === 'string' ? ctx.params.name.trim() : ''
    if (!name) return fail('新的名字叫什么？')
    const target = resolvePlaylistTarget(ctx.params.playlist, ctx, false)
    if ('error' in target) return fail(target.error)
    updatePlaylist({ ...target.playlist, name })
    return ok(`已把歌单「${target.playlist.name}」改名为「${name}」。`)
  },

  'playlist.delete': async (ctx) => {
    const target = resolvePlaylistTarget(ctx.params.playlist, ctx, false)
    if ('error' in target) return fail(target.error)
    deletePlaylist(target.playlist.id)
    return ok(`已删除歌单「${target.playlist.name}」。`)
  },

  'playlist.add-track': async (ctx) => {
    const resolved = await resolveTrack(ctx.params.track, ctx)
    if ('error' in resolved) return fail(resolved.error)
    // 只有「加到歌单」允许顺手新建：其余动作用到不存在的歌单会明确报错
    const target = resolvePlaylistTarget(ctx.params.playlist, ctx, true)
    if ('error' in target) return fail(target.error)

    const updated = addTrackToPlaylist(target.playlist.id, resolved.track)
    if (!updated) return fail(`添加到歌单「${target.playlist.name}」失败。`)
    return target.created
      ? ok(`已新建歌单「${updated.name}」，并把《${resolved.track.title}》放了进去。`)
      : ok(`已把《${resolved.track.title}》添加到歌单「${updated.name}」。`)
  },

  'playlist.remove-track': async (ctx) => {
    const target = resolvePlaylistTarget(ctx.params.playlist, ctx, false)
    if ('error' in target) return fail(target.error)

    const keyword = typeof ctx.params.track === 'string'
      ? ctx.params.track.trim()
      : (isTrackLike(ctx.params.track) ? ctx.params.track.title : '')
    if (!keyword) return fail('要移除哪首歌？')

    const found = matchTrack(target.playlist.tracks, keyword)
    if (!found) return fail(`歌单「${target.playlist.name}」里没有《${keyword}》。`)

    updatePlaylist({ ...target.playlist, tracks: target.playlist.tracks.filter(t => t.id !== found.id) })
    return ok(`已从歌单「${target.playlist.name}」移除《${found.title}》。`)
  },

  'playlist.list': async () => {
    const playlists = loadPlaylists()
    if (!playlists.length) return ok('你还没有歌单，说「新建一个叫 XX 的歌单」就能建。')
    const shown = playlists.slice(0, 8).map(p => `${p.name}（${p.tracks.length} 首）`)
    const tail = playlists.length > shown.length ? ` 等 ${playlists.length} 个` : ''
    return ok(`你有 ${playlists.length} 个歌单：${shown.join('、')}${tail}。`)
  },

  'favorite.add': async (ctx) => {
    const resolved = await resolveTrack(ctx.params.track, ctx)
    if ('error' in resolved) return fail(resolved.error)
    if (loadFavoriteTracks().some(t => t.id === resolved.track.id)) {
      return ok(`《${resolved.track.title}》已经在收藏里了。`)
    }
    toggleFavoriteTrack(resolved.track)
    return ok(`已收藏《${resolved.track.title}》。`)
  },

  'favorite.remove': async (ctx) => {
    const resolved = await resolveTrack(ctx.params.track, ctx)
    if ('error' in resolved) return fail(resolved.error)
    if (!loadFavoriteTracks().some(t => t.id === resolved.track.id)) {
      return ok(`《${resolved.track.title}》本来就不在收藏里。`)
    }
    removeFavoriteTrack(resolved.track.id)
    return ok(`已取消收藏《${resolved.track.title}》。`)
  },

  'favorite.list': async () => {
    const favorites = loadFavoriteTracks()
    if (!favorites.length) return ok('收藏还是空的，说「收藏这首」就能加。')
    const titles = favorites.slice(0, 5).map(t => `《${t.title}》`)
    return ok(`你收藏了 ${favorites.length} 首歌：${titles.join('、')}${favorites.length > titles.length ? ' 等' : ''}。`)
  },

  'download.track': async (ctx) => {
    const resolved = await resolveTrack(ctx.params.track, ctx)
    if ('error' in resolved) return fail(resolved.error)
    const track = resolved.track
    if (!track.bvid && !track.id) return fail('这首歌没有 bvid，下载不了。')

    const settings = loadAppSettings()
    /*
     * v1.4.14-pre9：语音下载也要走标题清洗，与 DownloadButton「过滤歌名」同一口径。
     * 此前只有 UI 两个入口接了清洗，语音说「下载这首歌」时文件名仍是原始 B 站标题。
     * 清洗失败不阻断下载（内部已兜底成规则清洗，最差是名字没被 AI 优化过）。
     */
    const filename = await cleanFilenameForDownload(track.title, { settings })
    const result = await ctx.deps.downloadTrack(
      track.bvid || track.id,
      { aid: track.aid, cid: track.cid },
      filename,
      settings.downloadFormat,
      qualityPreference(settings.downloadQuality),
      settings.downloadDir || undefined,
      { artist: track.artist, title: filename },
    )
    const size = formatSize(result.size)
    return ok(size
      ? `已下载《${track.title}》（${size}）。`
      : `已下载《${track.title}》。`)
  },

  'download.playlist': async (ctx) => {
    const target = resolvePlaylistTarget(ctx.params.playlist, ctx, false)
    if ('error' in target) return fail(target.error)
    const { playlist } = target
    if (!playlist.tracks.length) return fail(`歌单「${playlist.name}」里还没有歌。`)

    const settings = loadAppSettings()
    const quality = qualityPreference(settings.downloadQuality)
    /*
     * v1.4.14-pre9：批量下载先整批洗一次文件名，不是每首一次请求。
     * cleanFilenamesForDownload 内部去重 + 切批，20 首以内只发 1 次 AI 请求；
     * 返回顺序与入参一一对应，失败项退回规则清洗，不会错位。
     */
    const cleaned = await cleanFilenamesForDownload(
      playlist.tracks.map((t) => t.title),
      { settings },
    )
    let done = 0
    const failed: string[] = []
    for (let i = 0; i < playlist.tracks.length; i += 1) {
      const track = playlist.tracks[i]
      const filename = cleaned[i] || track.title
      try {
        await ctx.deps.downloadTrack(
          track.bvid || track.id,
          { aid: track.aid, cid: track.cid },
          filename,
          settings.downloadFormat,
          quality,
          settings.downloadDir || undefined,
          { artist: track.artist, title: filename },
        )
        done += 1
      } catch {
        failed.push(track.title)
      }
    }

    if (done === 0) return fail(`歌单「${playlist.name}」里的 ${playlist.tracks.length} 首都下载失败了。`)
    return failed.length
      ? ok(`已下载 ${done} 首，${failed.length} 首失败（${failed.slice(0, 3).join('、')}）。`)
      : ok(`歌单「${playlist.name}」的 ${done} 首已全部下载完成。`)
  },

  'search.video': async ({ params, deps }) => {
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (!query) return fail('想搜什么？给我几个关键词。')
    const result = await deps.searchVideo(query, 1, 5)
    if (!result.items.length) return ok(`没搜到「${query}」相关的视频。`)
    const top = result.items.slice(0, 3).map((item, i) => `${i + 1}.《${item.title}》- ${item.author}`)
    return ok(`搜到 ${result.totalResults || result.items.length} 个结果：${top.join('；')}。`)
  },

  'export.mv-single': async (ctx) => {
    const resolved = await resolveTrack(ctx.params.track, ctx)
    if ('error' in resolved) return fail(resolved.error)
    const track = resolved.track

    const settings = loadAppSettings()
    const watermark = typeof ctx.params.watermark === 'boolean' ? ctx.params.watermark : settings.mvWatermark
    const clean = typeof ctx.params.cleanExport === 'boolean' ? ctx.params.cleanExport : settings.mvCleanExport

    const result = await ctx.deps.exportTrackMv(track, {
      quality: qualityPreference(settings.downloadQuality),
      watermark,
      clean,
      visualizer: settings.audioVisualizer,
      coverFit: settings.coverFit,
      smoothness: settings.mvSmoothness,
      outputDir: settings.downloadDir || undefined,
    })
    return ok(`MV 已导出：${result.filePath}`)
  },

  'system.check-version': async ({ deps }) => {
    // 只读：不调用任何会下载/安装更新的接口（checkForUpdate 一律不碰）
    const current = await deps.getAppVersion()
    if (!current) return fail('拿不到当前版本号，无法确认是不是最新版。')

    const remote = await deps.fetchRemoteVersion(otaManifestUrl(current))
    if (!remote) return fail('连不上更新服务器，无法确认是不是最新版。')

    if (semverGt(remote, current)) {
      return ok(`有新版本 ${remote}（当前 ${current}）。我只查不升，需要更新请到设置页手动操作。`)
    }
    return ok(`已是最新版（${current}）。`)
  },
}

/* ---------- 版本比对（只读） ---------- */

// v1.4.14-pre9：规则抽到 src/utils/releaseChannel.ts，与主进程 otaUpdater 共用一份。
// 此前两边各写一份，改分流规则时必须记得同时改两个文件，漏一个就会出现
// 「主进程从 A 拉、渲染层查 B」的错位。import 后重新导出，保持既有调用与测试不变。
import { otaManifestUrl, releaseBaseFor } from '@/utils/releaseChannel'
export { releaseBaseFor, otaManifestUrl }

function readManifestVersion(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  for (const key of ['rendererVersion', 'shellVersion']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

async function fetchOtaVersion(url: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return null
    const data: unknown = await response.json()
    return readManifestVersion(data)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const defaultDeps: ExecutorDeps = {
  searchVideo,
  downloadTrack,
  exportTrackMv,
  getAppVersion: async () => {
    try {
      const version = await platform.updater?.getAppVersion?.()
      return version || null
    } catch {
      return null
    }
  },
  fetchRemoteVersion: fetchOtaVersion,
}

/* ---------- 进度解析 ---------- */

/** 「1:30」/「90」/「50%」→ 秒；认不出返回 null */
function parsePosition(raw: string, duration: number): number | null {
  const text = raw.trim()
  const percent = text.match(/^(\d+(?:\.\d+)?)\s*%$/)
  if (percent) {
    if (duration <= 0) return null
    return Math.max(0, Math.round((Number(percent[1]) / 100) * duration))
  }
  if (/^\d+(?::\d{1,2}){1,2}$/.test(text)) {
    const parts = text.split(':').map(Number)
    return parts.reduce((total, part) => total * 60 + part, 0)
  }
  const seconds = coerceNumber(text)
  if (seconds === null || seconds < 0) return null
  return Math.round(seconds)
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60)
  const seconds = Math.round(total % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/* ---------- confirm 提示 ---------- */

function playlistNameHint(params: Record<string, unknown>, context: ExecuteContext): string | null {
  const raw = params.playlist
  if (typeof raw === 'string' && raw.trim()) {
    const key = raw.trim()
    const known = context.playlists.find(p => p.id === key)
    return known ? known.name : key
  }
  return null
}

function confirmPrompt(action: AssistantAction, params: Record<string, unknown>, context: ExecuteContext): string {
  if (action.id === 'playlist.delete') {
    const name = playlistNameHint(params, context)
    return name
      ? `确定要删除歌单「${name}」吗？歌单删掉就找不回来了，里面的歌不会丢。`
      : '确定要删除这个歌单吗？删掉就找不回来了。'
  }
  if (action.id === 'export.mv-single') {
    const title = typeof params.track === 'string' && params.track.trim()
      ? params.track.trim()
      : currentTitleFor(context)
    return title
      ? `导出《${title}》的 MV 要花不少时间，现在开始吗？`
      : '导出 MV 要花不少时间，现在开始吗？'
  }
  return `确定要执行「${action.label}」吗？`
}

/* ---------- 入口 ---------- */

/**
 * 执行一个动作。
 *
 * @param actionId 注册表里的动作 id（assistantActions.ts 的 ASSISTANT_ACTIONS）
 * @param params   已收集到的参数
 * @param context  播放器 + 歌单 + 当前曲目（由 UI 层提供，执行器不碰 React）
 * @param options  confirmed=true 才允许执行 confirm 级动作
 */
export async function executeAssistantAction(
  actionId: string,
  params: Record<string, unknown>,
  context: ExecuteContext,
  options?: ExecuteOptions,
): Promise<ExecuteResult> {
  const action = getAssistantAction(actionId)
  if (!action) return fail(`我不认识「${actionId}」这个动作。`)

  const deps: ExecutorDeps = { ...defaultDeps, ...options?.deps }

  try {
    // 风险分级：confirm 级动作未确认时只回话，不产生任何副作用
    if (action.risk === 'confirm' && options?.confirmed !== true) {
      return { ok: false, needsConfirm: true, message: confirmPrompt(action, params, context) }
    }

    if (actionId.startsWith(SETTINGS_PREFIX)) return applySetting(action, params)

    const handler = HANDLERS[actionId]
    if (!handler) return fail(`「${action.label}」还没有接上执行逻辑。`)
    return await handler({ action, params, context, deps })
  } catch (error) {
    return fail(`「${action.label}」执行失败：${describeError(error)}`)
  }
}

import { BrowserWindow, dialog, ipcMain, net } from 'electron'
import fs from 'fs'

/**
 * 歌词服务层（QQ 音乐 OIAPI + 网易云 + LRCLIB）
 *
 * 主进程负责跨域请求，渲染层负责标题清洗、候选排序、LRC 解析与缓存。
 * QQ 音乐接口文档：https://www.oiapi.net/doc/id/121.html
 *
 * v1.3.7：新增网易云与 LRCLIB 搜索/取词 handler，仅供手动匹配面板使用；
 * 自动匹配仍走 QQ 音乐单源（lyrics:search / lyrics:get 不变）。
 * 网易云 web 接口无 CORS 头且裸请求易触发风控，必须经主进程 net.fetch 并伪装 UA/Referer；
 * LRCLIB 开放 CORS（ACAO:*）但偶发 503，失败静默降级为空结果。
 */

const OIAPI_QQ_LYRIC = 'https://www.oiapi.net/api/QQMusicLyric'
const NETEASE_SEARCH = 'https://music.163.com/api/search/get'
const NETEASE_LYRIC = 'https://music.163.com/api/song/lyric'
const LRCLIB_SEARCH = 'https://lrclib.net/api/search'
const LRCLIB_GET = 'https://lrclib.net/api/get'

/** 本地歌词文件：只认这两种扩展名，且拒绝超大文件（歌词文本不会这么大） */
const MAX_LYRIC_BYTES = 2 * 1024 * 1024
const LYRIC_FILE_FILTERS = [
  { name: '歌词文件', extensions: ['lrc', 'txt'] },
  { name: '全部文件', extensions: ['*'] },
]

export interface LocalLyricFile {
  content: string
  /** 实际命中的文件路径，供界面回显「已使用 xxx.lrc」 */
  path: string
}

/**
 * 由音频路径推导「同目录同名」的歌词候选路径。
 *
 * 与渲染层 src/services/localLyrics.ts 的 siblingLyricPaths 同一口径：
 * 文件名除扩展名外完全相同，且必须同目录。两边各有一份是因为
 * 主进程不能 import 渲染层模块（构建产物分离），改动需同步。
 */
function siblingLyricCandidates(audioPath: string): string[] {
  const normalized = audioPath.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const dir = slash >= 0 ? normalized.slice(0, slash) : ''
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  if (!stem) return []
  return ['.lrc', '.txt'].map((ext) => (dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`))
}

/** 网易云 web 接口对裸请求（Electron 默认 UA）可能触发风控，统一伪装浏览器 */
const NETEASE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
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
  /** v1.4.9-pre2 歌词双语：网易云 tlyric 翻译 LRC（可选，无翻译/无此能力的源不返回） */
  translation?: string
}

/** 网易云搜索结果行（仅保留用到的字段，duration 为毫秒） */
export interface NeteaseSong {
  name: string
  id: string | number
  artists?: { name?: string }[]
  album?: { name?: string }
  duration?: number
}

/** LRCLIB 搜索结果行；列表接口实测不带歌词正文，取词另调 get */
export interface LrclibSong {
  id: string | number
  trackName: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 9000)
  try {
    const resp = await net.fetch(url, { signal: ctrl.signal, headers })
    if (!resp.ok) return null
    return await resp.json()
  } catch (e) {
    console.warn("[lyricsApi] fetchJson failed:", url, e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function registerLyricsApiHandlers() {
  ipcMain.handle('lyrics:search', async (_event, keyword: string, page = 1, limit = 10): Promise<OiapiSong[]> => {
    const q = String(keyword || '').trim()
    if (!q) return []

    const url = new URL(OIAPI_QQ_LYRIC)
    url.searchParams.set('keyword', q)
    url.searchParams.set('page', String(page))
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('type', 'json')

    const json = await fetchJson(url.toString())
    const data = json?.data
    if (!Array.isArray(data)) return []
    return data.filter((item): item is OiapiSong => isObject(item) && typeof item.name === 'string')
  })

  ipcMain.handle('lyrics:get', async (_event, id: string | number, format = 'lrc'): Promise<OiapiLyricData | null> => {
    const songId = String(id || '').trim()
    if (!songId) return null

    const url = new URL(OIAPI_QQ_LYRIC)
    url.searchParams.set('id', songId)
    url.searchParams.set('format', format)
    url.searchParams.set('type', 'json')

    const json = await fetchJson(url.toString())
    if (!json || json.code !== 1) return null
    if (typeof json.data === 'string') return { content: json.data }
    if (isObject(json.data)) return json.data as OiapiLyricData
    if (typeof json.message === 'string' && json.message.includes('[')) return { content: json.message }
    return null
  })

  // ===== v1.3.7 手动匹配多源：网易云 =====

  ipcMain.handle('lyrics:search-netease', async (_event, keyword: string, offset = 0, limit = 20): Promise<NeteaseSong[]> => {
    const q = String(keyword || '').trim()
    if (!q) return []

    const url = new URL(NETEASE_SEARCH)
    url.searchParams.set('s', q)
    url.searchParams.set('type', '1') // 1 = 歌曲
    url.searchParams.set('offset', String(Math.max(0, offset)))
    url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))))

    const json = await fetchJson(url.toString(), NETEASE_HEADERS)
    const rows = json?.result?.songs
    if (!Array.isArray(rows)) return []
    return rows.filter(
      (item): item is NeteaseSong =>
        isObject(item) && typeof item.name === 'string' && item.id != null,
    )
  })

  ipcMain.handle('lyrics:get-netease', async (_event, id: string | number): Promise<OiapiLyricData | null> => {
    const songId = String(id || '').trim()
    if (!songId) return null

    const url = new URL(NETEASE_LYRIC)
    url.searchParams.set('id', songId)
    url.searchParams.set('lv', '-1') // 原文歌词
    url.searchParams.set('kv', '-1') // 翻译
    url.searchParams.set('tv', '-1') // 罗马音

    const json = await fetchJson(url.toString(), NETEASE_HEADERS)
    const lyric = json?.lrc?.lyric
    if (!(typeof lyric === 'string' && lyric.trim())) return null
    // v1.4.9-pre2 歌词双语：kv=-1 早已请求到翻译，此前被丢弃；这里一并带回渲染层。
    // translation 只在非空时挂上，保持返回结构向后兼容（渲染层按可选字段读取）。
    const tlyric = json?.tlyric?.lyric
    return typeof tlyric === 'string' && tlyric.trim()
      ? { content: lyric, translation: tlyric }
      : { content: lyric }
  })

  // ===== v1.3.7 手动匹配多源：LRCLIB =====

  ipcMain.handle('lyrics:search-lrclib', async (_event, keyword: string): Promise<LrclibSong[]> => {
    const q = String(keyword || '').trim()
    if (!q) return []

    const url = new URL(LRCLIB_SEARCH)
    url.searchParams.set('q', q)
    // 注意：LRCLIB /api/search 实测忽略 limit/offset，恒定返回最多 20 条（不支持翻页）

    const json = await fetchJson(url.toString())
    if (!Array.isArray(json)) return [] // 含 503 过载等失败场景，静默降级
    return json.filter(
      (item): item is LrclibSong =>
        isObject(item) && typeof item.trackName === 'string' && item.id != null,
    )
  })

  ipcMain.handle('lyrics:get-lrclib', async (_event, id: string | number): Promise<OiapiLyricData | null> => {
    const songId = String(id || '').trim()
    if (!songId) return null

    const json = await fetchJson(`${LRCLIB_GET}/${encodeURIComponent(songId)}`)
    if (!isObject(json)) return null
    // 有时间轴优先，退而求其次取纯文本（渲染层按 unsynced 展示）
    const lyric =
      typeof json.syncedLyrics === 'string' && json.syncedLyrics.trim()
        ? (json.syncedLyrics as string)
        : typeof json.plainLyrics === 'string'
          ? (json.plainLyrics as string)
          : ''
    return lyric.trim() ? { content: lyric } : null
  })

  /*
   * v1.4.17-pre1 本地歌词文件。
   *
   * 两条能力，都只读用户自己指定的文件，不做任何目录遍历：
   * - `lyrics:read-local`：按「同目录同名」推导出的候选路径逐个尝试，命中即返回；
   * - `lyrics:pick-local`：弹系统文件选择框，用户手动挑一个 .lrc/.txt。
   *
   * 安全口径：read-local 只允许 .lrc/.txt，且拒绝 NUL 与大文件——
   * 渲染层传进来的路径来自本地曲目的 localPath，但仍做一次扩展名与体积校验，
   * 避免「导入一个 .mp3 当歌词」这类误用把几十 MB 读进内存。
   */
  ipcMain.handle('lyrics:read-local', async (_event, audioPath: string): Promise<LocalLyricFile | null> => {
    if (typeof audioPath !== 'string' || !audioPath.trim()) return null
    const candidates = siblingLyricCandidates(audioPath)
    for (const candidate of candidates) {
      try {
        const stat = await fs.promises.stat(candidate)
        if (!stat.isFile() || stat.size > MAX_LYRIC_BYTES) continue
        const raw = await fs.promises.readFile(candidate, 'utf8')
        if (raw.trim()) return { content: raw, path: candidate }
      } catch {
        // 该候选不存在或无权限：换下一个
      }
    }
    return null
  })

  ipcMain.handle('lyrics:pick-local', async (event): Promise<LocalLyricFile | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: LYRIC_FILE_FILTERS })
      : await dialog.showOpenDialog({ properties: ['openFile'], filters: LYRIC_FILE_FILTERS })
    if (result.canceled || !result.filePaths.length) return null
    const filePath = result.filePaths[0]
    try {
      const stat = await fs.promises.stat(filePath)
      if (!stat.isFile() || stat.size > MAX_LYRIC_BYTES) return null
      const raw = await fs.promises.readFile(filePath, 'utf8')
      return raw.trim() ? { content: raw, path: filePath } : null
    } catch {
      return null
    }
  })
}

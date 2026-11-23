// v1.4.15-pre5 本地音乐扫描：目录递归、标签读取、进度与取消
//
// 分层与 electron/playlistFile.ts 一致：主进程只做「对话框 + 磁盘」，业务口径
// （去重、排序、失效判定）留在渲染层 src/services/localMusic.ts，便于单测覆盖。
//
// 三条必须守住的约束（见 docs/v1.4.15-剩余规划.md 四·B）：
// 1. 扫描是长操作：必须可取消、有进度、不阻塞 UI —— 用 setImmediate 让出事件循环，
//    每 N 个文件回报一次进度，取消标志在每批开头检查。
// 2. 路径平台相关：只处理 Electron 桌面端，其余平台在 platform 层就返回 undefined，
//    入口整块隐藏。
// 3. 文件会消失：本模块不删任何索引，只回报「这次扫到了什么」，失效清理是渲染层的显式动作。
import { BrowserWindow, app, dialog, ipcMain, protocol, safeStorage } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import ffmpegPath from 'ffmpeg-static'

/** 支持的音频扩展名（小写比较） */
export const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.wav', '.ogg'] as const

/** 扫描保护上限：用户可能误选 C:\ 或整个数据盘 */
export const SCAN_LIMITS = {
  /** 目录递归深度上限 */
  maxDepth: 8,
  /** 单次扫描收集的文件数上限 */
  maxFiles: 20000,
  /** 单文件大小上限（字节），超过的跳过并计数 */
  maxFileSize: 500 * 1024 * 1024,
} as const

/** 读取文件头部/尾部的字节数，与 src/services/audioTags.ts 的 HEAD_BYTES 对齐 */
const HEAD_BYTES = 256 * 1024
const ID3V1_BYTES = 128

export interface ScannedFile {
  /** 绝对路径 */
  filePath: string
  /** 文件字节数 */
  size: number
  /** 最后修改时间（ISO），用于渲染层判断是否需要重读标签 */
  mtime: string
}

export interface ScanProgress {
  /** 已处理的文件数 */
  scanned: number
  /** 已发现的音频文件总数（扫描过程中会增长） */
  found: number
  /** 当前处理的文件路径 */
  current: string
  /** 跳过的文件数（超大、无权限等） */
  skipped: number
}

export interface ScanResult {
  ok: boolean
  canceled?: boolean
  message?: string
  files?: ScannedFile[]
  /** 是否因为触到上限而提前停止 */
  truncated?: boolean
  truncatedReason?: string
  skipped?: number
}

/** 正在进行的扫描的取消标志；同一时间只允许一个扫描 */
let activeCancel: (() => void) | null = null

/**
 * v1.4.16-pre2 已授权的音乐目录集合（绝对路径，小写）。
 *
 * 由用户通过系统对话框选定的目录登记而来。lm:// 只放行这些目录内的文件——
 * 否则渲染层一旦出现注入面，这个协议就是「任意音频路径读取」通道
 * （审计 R-30 指出的问题）。只校验扩展名是不够的。
 */
const authorizedDirs = new Set<string>()

/** 授权集合落盘文件（userData 下） */
const AUTH_FILE = 'local-music-dirs.json'

/**
 * v1.4.16-pre3 授权集合的加密持久化。
 *
 * **为什么加密**：这份文件决定 lm:// 能读哪些目录。若以明文存盘，
 * 任何能改 userData 的程序都能往里塞一个 "C:\\" 从而绕过白名单——
 * 那样这个白名单就是装饰品。沿用项目已验证的 enc: 约定
 * （与 electron/webdav.ts、electron/ai.ts 同一套 safeStorage）。
 *
 * **加密不可用时怎么办**：不落盘、明确告警，退回「仅本次运行有效」。
 * 绝不降级成明文——那等于把安全边界换成纸糊的。
 * 注意这与 webdav.ts 的 plain: 降级不同：那里存的是网盘密码（用户自己的凭据），
 * 这里存的是**权限边界**，性质不一样。
 */
function authFilePath(): string {
  return path.join(app.getPath('userData'), AUTH_FILE)
}

function persistAuthorizedDirs(): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[localMusic] safeStorage 不可用，目录授权只在本次运行内有效（不落盘）')
      return
    }
    const payload = JSON.stringify([...authorizedDirs])
    const stored = 'enc:' + safeStorage.encryptString(payload).toString('base64')
    fs.writeFileSync(authFilePath(), JSON.stringify({ dirs: stored }, null, 2), 'utf8')
  } catch (err) {
    // 落盘失败不影响本次运行：内存里的授权照常生效
    console.warn('[localMusic] 目录授权落盘失败：', err instanceof Error ? err.message : String(err))
  }
}

/** 启动时读回授权集合。解不开就当空集合（用户重选一次即可），不抛错。 */
export function loadAuthorizedDirs(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(authFilePath(), 'utf8')) as { dirs?: string }
    if (!raw?.dirs || !raw.dirs.startsWith('enc:')) return
    if (!safeStorage.isEncryptionAvailable()) return
    const json = safeStorage.decryptString(Buffer.from(raw.dirs.slice(4), 'base64'))
    const list = JSON.parse(json)
    if (!Array.isArray(list)) return
    for (const d of list) {
      if (typeof d === 'string' && d) authorizedDirs.add(d)
    }
  } catch {
    // 文件不存在/换机器解不开：当作没有授权，不阻塞启动
  }
}

/** 登记一个已授权目录（用户通过对话框选定后调用），并加密落盘 */
export function authorizeMusicDir(dir: string): void {
  if (!dir) return
  try {
    const key = path.resolve(dir).toLowerCase()
    if (authorizedDirs.has(key)) return
    authorizedDirs.add(key)
    persistAuthorizedDirs()
  } catch {
    // 路径非法则忽略，不放宽任何权限
  }
}

/**
 * v1.4.16-pre2 为一个具体文件授权（用于 M3U 导入的本地路径条目）。
 *
 * 只授权该文件所在目录——用户从 M3U 引入的路径同样是他自己的文件，
 * 但不应因此放开整个盘符。
 */
export function authorizeMusicFile(filePath: string): void {
  try {
    authorizeMusicDir(path.dirname(path.resolve(filePath)))
  } catch {
    // 忽略非法路径
  }
}

/** 判断目标文件是否落在某个已授权目录内 */
export function isAuthorizedMusicFile(filePath: string): boolean {
  let target: string
  try {
    target = path.resolve(filePath).toLowerCase()
  } catch {
    return false
  }
  for (const dir of authorizedDirs) {
    // 前缀断言带分隔符，避免 /music 放行 /music-evil
    const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep
    if (target.startsWith(withSep)) return true
  }
  return false
}

function hostWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
}

function isAudioFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return (AUDIO_EXTS as readonly string[]).includes(ext)
}

/** 让出事件循环：递归扫描是同步密集的，不让出会让进度条和取消按钮全部失效 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * 递归收集音频文件。
 *
 * 用显式栈而不是递归函数调用：深度上限虽然只有 8，但目录树很宽时
 * 同步递归会长时间占住事件循环，栈式写法能在每层之间插入 yield。
 */
async function collectFiles(
  root: string,
  shouldStop: () => boolean,
  onProgress: (p: ScanProgress) => void,
): Promise<{ files: ScannedFile[]; truncated: boolean; truncatedReason: string; skipped: number }> {
  const files: ScannedFile[] = []
  let skipped = 0
  let truncated = false
  let truncatedReason = ''
  // 栈里存 [目录, 深度]
  const stack: Array<[string, number]> = [[root, 0]]

  while (stack.length > 0) {
    if (shouldStop()) break
    const [dir, depth] = stack.pop() as [string, number]

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // 无权限 / 目录已被删除：跳过这一个目录，不中断整次扫描
      skipped += 1
      continue
    }

    for (const entry of entries) {
      if (shouldStop()) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 > SCAN_LIMITS.maxDepth) {
          skipped += 1
          continue
        }
        // 跳过常见的大而无用目录，避免误选根目录时爬进系统目录
        if (entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') {
          skipped += 1
          continue
        }
        stack.push([full, depth + 1])
        continue
      }
      if (!entry.isFile() || !isAudioFile(entry.name)) continue

      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        skipped += 1
        continue
      }
      if (stat.size > SCAN_LIMITS.maxFileSize) {
        skipped += 1
        continue
      }
      if (files.length >= SCAN_LIMITS.maxFiles) {
        truncated = true
        truncatedReason = '文件数已达上限 ' + SCAN_LIMITS.maxFiles + ' 个'
        break
      }
      files.push({ filePath: full, size: stat.size, mtime: stat.mtime.toISOString() })
    }

    if (truncated) break
    onProgress({ scanned: files.length, found: files.length, current: dir, skipped })
    // 每处理完一个目录让出一次事件循环，取消按钮才有响应
    await yieldToEventLoop()
  }

  return { files, truncated, truncatedReason, skipped }
}

/**
 * 用 ffmpeg 读标签（兜底路径）。
 *
 * 只在纯 JS 解析不出任何字段时调用。实测单文件约 92ms 且要起进程，
 * 所以这里限制并发为 2，并支持取消；拿不到就返回 null，让渲染层退回文件名。
 */
function readTagsWithFfmpeg(filePath: string): Promise<{ title?: string; artist?: string; album?: string; duration?: number } | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(null)
      return
    }
    // ffmpeg 把信息打到 stderr，退出码非 0 也照常解析（它本来就没有「只读信息」模式）
    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', filePath],
      { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (_err, _stdout, stderr) => {
        try {
          const text = String(stderr ?? '')
          const pick = (key: string): string | undefined => {
            const m = new RegExp('^\\s*' + key + '\\s*:\\s*(.+)$', 'mi').exec(text)
            return m ? m[1].trim() : undefined
          }
          const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
          const out: { title?: string; artist?: string; album?: string; duration?: number } = {}
          const title = pick('title')
          const artist = pick('artist')
          const album = pick('album')
          if (title) out.title = title
          if (artist) out.artist = artist
          if (album) out.album = album
          if (durMatch) {
            out.duration = Math.round(
              Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]),
            )
          }
          resolve(out.title || out.artist || out.album || out.duration ? out : null)
        } catch {
          resolve(null)
        }
      },
    )
  })
}

/**
 * v1.4.15-pre6 本地音乐播放：自定义协议 lm:// 提供本地音频文件流。
 *
 * **为什么不用 file://（实测结论，不是推测）**：
 * 渲染层跑在自定义 app:// 标准安全源上，Chromium 直接拒绝 file:// 资源
 * （控制台报 "Not allowed to load local resource"），audio 连元数据都加载不出来。
 * 实测对比：file:// → load FAIL；lm:// → load OK、时长正确、可 seek、
 * createMediaElementSource 成功且 analyser 能拿到真实频谱（均衡器与可视化照常工作）。
 *
 * 协议需注册为 standard + secure + supportFetchAPI + stream（见 main.ts 的
 * registerSchemesAsPrivileged），否则拿不到合法 origin，Web Audio 图会退化。
 */
export const LOCAL_AUDIO_SCHEME = 'lm'

/** 把本地绝对路径转成渲染层可用的 lm:// URL */
export function toLocalAudioUrl(filePath: string): string {
  return LOCAL_AUDIO_SCHEME + '://local/' + encodeURIComponent(filePath)
}

/** 从 lm:// URL 还原本地绝对路径；不是本地音频 URL 时返回 null */
export function fromLocalAudioUrl(url: string): string | null {
  const prefix = LOCAL_AUDIO_SCHEME + '://local/'
  if (!url || !url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
}

/** 扩展名 -> MIME，交给 <audio> 判断容器格式 */
const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

/** 解析 Range 请求头（只支持单区间，够 <audio> 用） */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return null
  let start: number
  let end: number
  if (!hasStart) {
    // bytes=-N：最后 N 字节
    const suffix = Number(m[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = hasEnd ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

/**
 * 注册 lm:// 的协议处理器。必须在 app ready 之后调用。
 *
 * 只放行音频扩展名：这个协议只服务于播放，不该变成任意文件读取通道。
 *
 * **为什么手工实现 Range 而不用 net.fetch 转发（实测结论）**：
 * 早先版本直接 return await net.fetch(pathToFileURL(target))，虽然能出声，
 * 但实测发现两个硬伤：
 *   1. 响应没有 Content-Length —— <audio>.duration 恒为 Infinity，
 *      进度条算不出总长、拖动进度条不可靠；
 *   2. Range 请求返回 200 而非 206，等于每次都从头传整段。
 * 现在显式读文件并正确回 Content-Length / Content-Range / Accept-Ranges，
 * 长音频的 seek 才真正可用。
 */
export function registerLocalAudioProtocol(): void {
  protocol.handle(LOCAL_AUDIO_SCHEME, async (request) => {
    try {
      const target = fromLocalAudioUrl(request.url)
      if (!target) return new Response('bad request', { status: 400 })
      const ext = path.extname(target).toLowerCase()
      const mime = AUDIO_MIME[ext]
      if (!mime || !(AUDIO_EXTS as readonly string[]).includes(ext)) {
        return new Response('forbidden', { status: 403 })
      }
      // v1.4.16-pre2：只放行用户已导入目录内的文件。
      // 光校验扩展名不够——那样任何 .mp3 都能读，等于「任意音频路径读取」通道。
      if (!isAuthorizedMusicFile(target)) {
        console.warn('[BiliMusic] lm:// 拒绝未授权路径:', target)
        return new Response('forbidden', { status: 403 })
      }

      let stat: fs.Stats
      try {
        stat = fs.statSync(target)
      } catch {
        return new Response('not found', { status: 404 })
      }
      const size = stat.size
      const range = parseRange(request.headers.get('range'), size)

      if (!range) {
        // 无 Range：整段返回，但必须带 Content-Length，否则时长算不出来
        const data = fs.readFileSync(target)
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
          },
        })
      }

      // 有 Range：只回请求的那一段，206 + Content-Range
      const length = range.end - range.start + 1
      const fd = fs.openSync(target, 'r')
      try {
        const buf = Buffer.alloc(length)
        fs.readSync(fd, buf, 0, length, range.start)
        return new Response(buf, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(length),
            'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + size,
            'Accept-Ranges': 'bytes',
          },
        })
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      return new Response('error: ' + (err instanceof Error ? err.message : String(err)), { status: 500 })
    }
  })
}

export function registerLocalMusicHandlers(): void {
  // v1.4.16-pre3：启动时读回上次的目录授权，否则重启后本地音乐播不了
  loadAuthorizedDirs()

  // 选目录：返回用户选中的绝对路径，取消则 canceled
  ipcMain.handle('localMusic:pickDir', async () => {
    const win = hostWindow()
    // Electron 的 dialog 是双重重载：有窗口走 (window, options)，没有就走 (options)
    const openOptions = {
      title: '选择本地音乐目录',
      properties: ['openDirectory'] as const,
    }
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, { ...openOptions, properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ ...openOptions, properties: ['openDirectory'] })
    if (canceled || !filePaths.length) return { ok: false, canceled: true }
    // 用户显式选定的目录即视为授权，登记后 lm:// 才允许读它下面的文件
    authorizeMusicDir(filePaths[0])
    return { ok: true, path: filePaths[0] }
  })

  // 扫描：递归收集音频文件，边扫边回报进度
  ipcMain.handle('localMusic:scan', async (e, dirPath: string) => {
    const dir = typeof dirPath === 'string' ? dirPath.trim() : ''
    if (!dir) return { ok: false, message: '没有指定目录' } satisfies ScanResult
    let isDir = false
    try {
      isDir = fs.statSync(dir).isDirectory()
    } catch {
      return { ok: false, message: '目录不存在或无法访问：' + dir } satisfies ScanResult
    }
    if (!isDir) return { ok: false, message: '这不是一个目录：' + dir } satisfies ScanResult

    // 同一时间只允许一个扫描：新的直接取代旧的（旧的在下一个检查点退出）
    activeCancel?.()
    let canceled = false
    activeCancel = () => {
      canceled = true
    }

    const sender = e.sender
    const onProgress = (p: ScanProgress) => {
      if (sender.isDestroyed()) return
      sender.send('localMusic:scanProgress', p)
    }

    try {
      const { files, truncated, truncatedReason, skipped } = await collectFiles(dir, () => canceled, onProgress)
      if (canceled) return { ok: false, canceled: true } satisfies ScanResult
      return { ok: true, files, truncated, truncatedReason, skipped } satisfies ScanResult
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '扫描失败' } satisfies ScanResult
    } finally {
      activeCancel = null
    }
  })

  // 取消当前扫描
  ipcMain.handle('localMusic:cancel', () => {
    activeCancel?.()
    return { ok: true }
  })

  // 读标签：主进程读文件头尾，解析交给渲染层（纯函数在 src/services/audioTags.ts）
  ipcMain.handle('localMusic:readTags', async (_e, filePath: string) => {
    const target = typeof filePath === 'string' ? filePath : ''
    if (!target) return { ok: false, message: '没有指定文件' }
    try {
      const stat = fs.statSync(target)
      if (stat.size > SCAN_LIMITS.maxFileSize) return { ok: false, message: '文件超过大小上限' }
      const fd = fs.openSync(target, 'r')
      try {
        const headLen = Math.min(HEAD_BYTES, stat.size)
        const head = Buffer.alloc(headLen)
        fs.readSync(fd, head, 0, headLen, 0)
        const tailLen = Math.min(ID3V1_BYTES, stat.size)
        const tail = Buffer.alloc(tailLen)
        fs.readSync(fd, tail, 0, tailLen, Math.max(0, stat.size - ID3V1_BYTES))
        // 交给渲染层解析：这里只搬字节，不引第二份解析逻辑
        return { ok: true, head: Array.from(head), tail: Array.from(tail), size: stat.size }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '读取文件失败' }
    }
  })

  // ffmpeg 兜底读标签
  ipcMain.handle('localMusic:readTagsFallback', async (_e, filePath: string) => {
    const target = typeof filePath === 'string' ? filePath : ''
    if (!target) return { ok: false, message: '没有指定文件' }
    const tags = await readTagsWithFfmpeg(target)
    return tags ? { ok: true, tags } : { ok: false, message: '无法读取标签' }
  })

  // v1.4.16-pre2：为一批本地文件授权（M3U 导入的本地路径条目走这里）
  ipcMain.handle('localMusic:authorizePaths', (_e, paths: string[]) => {
    const list = Array.isArray(paths) ? paths : []
    for (const p of list) {
      if (typeof p === 'string' && p) authorizeMusicFile(p)
    }
    return { ok: true }
  })

  // 检查文件是否还存在（渲染层用来标记失效条目，不自动删）
  ipcMain.handle('localMusic:checkExists', async (_e, paths: string[]) => {
    const list = Array.isArray(paths) ? paths : []
    const missing: string[] = []
    for (const p of list) {
      if (typeof p !== 'string' || !p) continue
      try {
        if (!fs.existsSync(p)) missing.push(p)
      } catch {
        missing.push(p)
      }
    }
    return { ok: true, missing }
  })
}

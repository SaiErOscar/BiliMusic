import { ipcMain, net, app, session, shell, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'
import { spawn } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const BILI_API = 'https://api.bilibili.com'
const BILI_PASSPORT = 'https://passport.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com'
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ===== ffmpeg 路径解析 =====
// ffmpeg-static 提供跨平台静态 ffmpeg 二进制
// ESM 中无 require，通过 createRequire 桥接
// 打包后 ffmpeg.exe 位于 app.asar.unpacked 内，需修正路径
function resolveFfmpegPath(): string {
  // 策略 1：通过 createRequire 解析 ffmpeg-static
  try {
    const rawPath = require('ffmpeg-static') as string
    const fixedPath = rawPath.includes('app.asar')
      ? rawPath.replace('app.asar', 'app.asar.unpacked')
      : rawPath
    if (fsSync.existsSync(fixedPath)) {
      console.log('[biliApi] ffmpeg resolved (ffmpeg-static):', fixedPath)
      return fixedPath
    }
    console.warn('[biliApi] ffmpeg-static path not exists:', fixedPath)
  } catch (e) {
    console.warn('[biliApi] ffmpeg-static require failed:', e)
  }

  // 策略 2：直接检查常见路径
  const candidates: string[] = [
    path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'),
    path.join(__dirname, '../../node_modules/ffmpeg-static/ffmpeg.exe'),
  ]
  for (const p of candidates) {
    if (fsSync.existsSync(p)) {
      console.log('[biliApi] ffmpeg resolved (fallback):', p)
      return p
    }
  }

  console.warn('[biliApi] ffmpeg not found, falling back to system PATH')
  return 'ffmpeg'
}

const ffmpegPath = resolveFfmpegPath()

// ===== 文件名安全过滤 =====
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/\.\./g, '_')           // 防路径遍历
    .replace(/[\\/:*?"<>|]/g, '_')   // 过滤 Windows 非法字符（保留 . 用于扩展名）
    .replace(/\s+/g, ' ')
    .trim()
}

// ===== 下载目录辅助 =====

/** 默认下载目录 */
function defaultDownloadDir(): string {
  return path.join(app.getPath('music'), 'BiliMusic')
}

/** 设置 Windows 隐藏属性（attrib +h） */
function setHiddenWindows(p: string): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('attrib', ['+h', p], { windowsHide: true })
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

/**
 * 标记下载文件夹用途：
 * 若目标文件夹为默认下载目录，或非空（排除 .tmp 与已有标记），或已有标记，则不操作。
 * 否则在空文件夹中创建隐藏标记文件（视频/音频），持久化其用途。
 */
async function markFolderPurpose(downloadDir: string, kind: 'video' | 'audio') {
  try {
    if (path.resolve(downloadDir) === path.resolve(defaultDownloadDir())) return
    const entries = await fs.readdir(downloadDir)
    const markers = entries.filter((e) => e === '.bilimusic-video' || e === '.bilimusic-audio')
    if (markers.length > 0) return // 已有用途标记，不重复
    const meaningful = entries.filter((e) => e !== '.tmp' && !e.startsWith('.bilimusic-'))
    if (meaningful.length > 0) return // 非空文件夹，不标记
    const marker = path.join(downloadDir, kind === 'video' ? '.bilimusic-video' : '.bilimusic-audio')
    await fs.writeFile(marker, '', 'utf-8')
    await setHiddenWindows(marker)
    console.log(`[biliApi] Marked folder as ${kind}:`, downloadDir)
  } catch (e) {
    console.warn('[biliApi] markFolderPurpose failed:', e)
  }
}

// ===== ffmpeg 辅 =====

/** 运行 ffmpeg 命令，返回 Promise */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (err: Error) => {
      reject(new Error(`ffmpeg 启动失败: ${err.message}. ffmpegPath=${ffmpegPath}`))
    })
    proc.on('close', (code: number) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

type DownloadOptions = { artist?: string; title?: string; lyricContent?: string }

/** 构建元数据参数 */
function buildMetaArgs(options?: DownloadOptions): string[] {
  const args: string[] = []
  if (options?.artist) args.push('-metadata', `artist=${options.artist}`)
  if (options?.title) args.push('-metadata', `title=${options.title}`)
  return args
}

// ===== ffmpeg 合并 =====
/**
 * 用 ffmpeg 合并视频流和音频流（带元数据）
 */
function mergeWithFfmpegMeta(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  options?: DownloadOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      ...buildMetaArgs(options),
      '-y',
      outputPath,
    ]
    const proc = spawn(ffmpegPath, args, {
      windowsHide: true,
    })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (err: Error) => {
      reject(new Error(`ffmpeg 启动失败: ${err.message}. ffmpegPath=${ffmpegPath}`))
    })
    proc.on('close', (code: number) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 合并失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

/**
 * 备用方案：ffmpeg 直接从 URL 拉取并合并
 * 通过 -headers 参数传入 Referer 和 User-Agent，绕过 B站 CDN 来源校验
 */
function mergeWithFfmpegDirectUrlMeta(
  videoUrl: string,
  audioUrl: string,
  outputPath: string,
  referer: string,
  options?: DownloadOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = `Referer: ${referer}\r\nUser-Agent: ${BILI_UA}\r\n`
    const args = [
      '-headers', headers,
      '-i', videoUrl,
      '-i', audioUrl,
      '-c:v', 'copy',
      '-c:a', 'copy',
      ...buildMetaArgs(options),
      '-y',
      outputPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (err: Error) => {
      reject(new Error(`ffmpeg direct URL 启动失败: ${err.message}`))
    })
    proc.on('close', (code: number) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg direct URL 合并失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

// ===== 流下载辅助 =====

/**
 * 流式下载 URL 内容到文件，避免大文件内存峰值
 * 使用 Electron net.fetch 确保携带 Cookie 和 Referer
 */
async function downloadStreamToFile(
  url: string,
  filePath: string,
  progressLabel?: string,
): Promise<number> {
  const response = await net.fetch(url, {
    headers: {
      Referer: BILI_REFERER,
      'User-Agent': BILI_UA,
    },
  })
  if (!response.ok) {
    throw new Error(`下载流失败: HTTP ${response.status} ${response.statusText}`)
  }

  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body?.getReader()

  if (!reader) {
    // 回退：不支持流式读取时用整体缓冲
    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(filePath, buffer)
    return buffer.length
  }

  const fileHandle = await fs.open(filePath, 'w')
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        await fileHandle.write(value)
        received += value.length
        if (total > 0 && progressLabel) {
          console.log(`[biliApi] ${progressLabel}: ${Math.round((received / total) * 100)}% (${received}/${total})`)
        }
      }
    }
  } finally {
    await fileHandle.close()
  }
  return received
}

// ===== IPC Handlers =====

// ===== 官方登录页窗口（支持账号密码 / 手机短信 / 扫码，人机验证由官方页处理） =====
let loginWindow: BrowserWindow | null = null
let loginResolveFn: ((ok: boolean) => void) | null = null

function closeLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.destroy()
  }
  loginWindow = null
  loginResolveFn = null
}

export function registerBiliApiHandlers() {
  // 下载音频文件到本地
  // 渲染层已通过 fetch 获取到 CDN URL，主进程负责下载文件
  ipcMain.handle('bili:downloadAudio', async (
    _event,
    audioUrl: string,
    filename: string,
    customDir?: string,
    options?: { artist?: string; title?: string; lyricContent?: string },
  ) => {
    const safeName = sanitizeFilename(filename)
    const downloadDir = customDir || path.join(app.getPath('userData'), 'downloads')
    await fs.mkdir(downloadDir, { recursive: true })
    const filePath = path.join(downloadDir, safeName)

    // 若目标文件夹为空且非默认目录，标记为音频文件夹
    await markFolderPurpose(downloadDir, 'audio')

    // 使用 session 的 fetch 确保带 Cookie
    const response = await net.fetch(audioUrl, {
      headers: {
        Referer: BILI_REFERER,
        'User-Agent': BILI_UA,
      },
    })
    if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)

    // 流式写入：避免大文件一次性加载到内存
    const total = Number(response.headers.get('content-length') || 0)
    const reader = response.body?.getReader()
    if (!reader) {
      // 回退：不支持流式读取时仍用整体缓冲
      const buffer = Buffer.from(await response.arrayBuffer())
      await fs.writeFile(filePath, buffer)
      return { filePath, size: buffer.length }
    }

    const fileHandle = await fs.open(filePath, 'w')
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          await fileHandle.write(value)
          received += value.length
          if (total > 0) {
            _event.sender.send('bili:download-progress', {
              filename: safeName,
              received,
              total,
              percent: Math.round((received / total) * 100),
            })
          }
        }
      }
    } finally {
      await fileHandle.close()
    }
    // 如果有元数据，用 ffmpeg 嵌入
    if (options?.artist || options?.title) {
      const tmpPath = filePath + '.tmp_meta'
      await fs.rename(filePath, tmpPath)
      const metaArgs = [
        '-i', tmpPath,
        '-c:a', 'copy',
      ]
      if (options.artist) metaArgs.push('-metadata', `artist=${options.artist}`)
      if (options.title) metaArgs.push('-metadata', `title=${options.title}`)
      metaArgs.push('-y', filePath)
      try {
        await runFfmpeg(metaArgs)
        await fs.rm(tmpPath, { force: true }).catch(() => {})
      } catch (e) {
        // 元数据嵌入失败不影响下载结果
        console.warn('[biliApi] Failed to embed metadata:', e)
        await fs.rename(tmpPath, filePath).catch(() => {})
      }
    }

    // 保存歌词文件
    if (options?.lyricContent) {
      const lyricPath = filePath.replace(/\.[^.]+$/, '.lrc')
      try {
        await fs.writeFile(lyricPath, options.lyricContent, 'utf-8')
        console.log('[biliApi] Lyric saved:', lyricPath)
      } catch (e) {
        console.warn('[biliApi] Failed to save lyric:', e)
      }
    }

    return { filePath, size: received }
  })

  // 下载视频（合并画面+声音）到本地
  // 重构方案：
  // 1. 渲染层获取 video/audio CDN URL 后传入主进程
  // 2. 主进程流式下载到临时文件（带 Referer + User-Agent 头）
  // 3. ffmpeg 合并为 mp4
  // 4. 如果主方案失败，备用方案用 ffmpeg 直接从 URL 拉取
  ipcMain.handle('bili:downloadVideo', async (
    _event,
    videoUrl: string,
    audioUrl: string,
    filename: string,
    customDir?: string,
    options?: { artist?: string; title?: string; lyricContent?: string },
  ) => {
    console.log('[biliApi] downloadVideo called, ffmpegPath:', ffmpegPath)
    console.log('[biliApi] videoUrl:', videoUrl?.substring(0, 80))
    console.log('[biliApi] audioUrl:', audioUrl?.substring(0, 80))

    const safeName = sanitizeFilename(filename)
    const downloadDir = customDir || path.join(app.getPath('userData'), 'downloads')
    await fs.mkdir(downloadDir, { recursive: true })
    const outputPath = path.join(
      downloadDir,
      safeName.endsWith('.mp4') ? safeName : `${safeName}.mp4`,
    )

    // 临时文件（隐藏辅助文件夹 .tmp）
    const tmpDir = path.join(downloadDir, '.tmp')
    await fs.mkdir(tmpDir, { recursive: true })
    await setHiddenWindows(tmpDir)
    const ts = Date.now()
    const tmpVideo = path.join(tmpDir, `${ts}_video.m4s`)
    const tmpAudio = path.join(tmpDir, `${ts}_audio.m4s`)

    // 若目标文件夹为空且非默认目录，标记为视频文件夹
    await markFolderPurpose(downloadDir, 'video')

    try {
      // 方案 A：主进程 net.fetch 流式下载到临时文件
      // net.fetch 使用 Electron session，自动携带 Cookie 和 CORS 头
      console.log('[biliApi] Downloading video stream to file...')
      const [videoSize, audioSize] = await Promise.all([
        downloadStreamToFile(videoUrl, tmpVideo, 'video'),
        downloadStreamToFile(audioUrl, tmpAudio, 'audio'),
      ])
      console.log(`[biliApi] Downloaded: video=${videoSize} bytes, audio=${audioSize} bytes`)

      console.log('[biliApi] Merging with ffmpeg...')
      await mergeWithFfmpegMeta(tmpVideo, tmpAudio, outputPath, options)
      console.log('[biliApi] Merge complete:', outputPath)

      // 保存歌词文件
      if (options?.lyricContent) {
        const lyricPath = outputPath.replace(/\.[^.]+$/, '.lrc')
        try {
          await fs.writeFile(lyricPath, options.lyricContent, 'utf-8')
          console.log('[biliApi] Lyric saved:', lyricPath)
        } catch (e) {
          console.warn('[biliApi] Failed to save lyric:', e)
        }
      }

      const stat = await fs.stat(outputPath)
      return { filePath: outputPath, size: stat.size }
    } catch (err) {
      console.error('[biliApi] downloadVideo plan A failed:', err)

      // 方案 B 备用：如果方案 A 失败，尝试用 ffmpeg 直接从 URL 拉取
      // ffmpeg 可以通过 -headers 参数传入 Referer 和 User-Agent
      try {
        console.log('[biliApi] Trying fallback: ffmpeg direct URL fetch...')
        await mergeWithFfmpegDirectUrlMeta(videoUrl, audioUrl, outputPath, BILI_REFERER, options)
        const stat = await fs.stat(outputPath)
        return { filePath: outputPath, size: stat.size }
      } catch (err2) {
        console.error('[biliApi] Fallback also failed:', err2)
        throw new Error(
          `视频下载失败。主方案: ${err instanceof Error ? err.message : err}; ` +
          `备用方案: ${err2 instanceof Error ? err2.message : err2}`
        )
      }
    } finally {
      // 清理临时文件夹（下载完后删除 .tmp）
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // 打开下载目录
  ipcMain.handle('bili:openDownloadDir', async (_event, dirPath?: string) => {
    const target = dirPath || path.join(app.getPath('userData'), 'downloads')
    await shell.openPath(target)
    return { success: true }
  })

  // 返回系统默认音乐目录，供渲染层作为下载路径初始值
  ipcMain.handle('bili:getDefaultDownloadDir', async () => {
    return path.join(app.getPath('music'), 'BiliMusic')
  })

  // 选择下载目录（弹出系统文件夹选择对话框）
  ipcMain.handle('bili:selectDownloadFolder', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载位置',
      defaultPath: await (async () => {
        try {
          const dir = path.join(app.getPath('music'), 'BiliMusic')
          await fs.mkdir(dir, { recursive: true })
          return dir
        } catch {
          return app.getPath('music')
        }
      })(),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 保存歌词文件到指定路径
  ipcMain.handle('bili:saveLyricFile', async (_event, content: string, filePath: string) => {
    await fs.writeFile(filePath, content, 'utf-8')
    return { success: true, filePath }
  })

  // ===== 扫码登录 =====

  ipcMain.handle('bili:qrGenerate', async () => {
    const url = `${BILI_PASSPORT}/x/passport-login/web/qrcode/generate`
    const response = await net.fetch(url, {
      headers: { Referer: `${BILI_PASSPORT}/login` },
    })
    const data = await response.json()

    if (data.code !== 0) {
      const err = new Error(`Bilibili API Error [${data.code}]: ${data.message}`)
      ;(err as any).code = data.code
      throw err
    }

    return {
      url: data.data.url,
      qrcodeKey: data.data.qrcode_key,
    }
  })

  ipcMain.handle('bili:qrPoll', async (_event, qrcodeKey: string) => {
    const url = `${BILI_PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}`
    const response = await net.fetch(url, {
      headers: { Referer: `${BILI_PASSPORT}/login` },
      redirect: 'manual',
    })

    const httpStatus = response.status
    const setCookieHeaders = response.headers.getSetCookie?.() || []
    const isRedirect = httpStatus === 302 || httpStatus === 301

    if (isRedirect && setCookieHeaders.length > 0) {
      for (const cookieStr of setCookieHeaders) {
        try {
          await session.defaultSession.cookies.set({
            url: BILI_API,
            name: parseCookieName(cookieStr),
            value: parseCookieValue(cookieStr),
            domain: '.bilibili.com',
            path: '/',
            secure: true,
            httpOnly: true,
          })
        } catch (e) {
          console.warn('[biliApi] Cookie set failed:', e)
        }
      }
      return {
        code: 0,
        status: 0,
        message: '登录成功',
        url: response.headers.get('Location') || '',
      }
    }

    const text = await response.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch (e) {
      console.warn('[biliApi] QR poll JSON parse failed:', e)
      return { code: -1, status: -1, message: 'unknown', url: '' }
    }

    return {
      code: data.data?.code ?? data.code,
      status: data.data?.code ?? data.code,
      message: data.data?.message || data.message,
      url: data.data?.url || '',
    }
  })

  ipcMain.handle('bili:getCookies', async () => {
    const cookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' })
    const sessdata = cookies.find(c => c.name === 'SESSDATA')
    const biliJct = cookies.find(c => c.name === 'bili_jct')
    const dedeUserId = cookies.find(c => c.name === 'DedeUserID')

    return {
      isLoggedIn: !!(sessdata && biliJct && dedeUserId),
      sessdata: sessdata?.value || '',
      biliJct: biliJct?.value || '',
      dedeUserId: dedeUserId?.value || '',
    }
  })

  // 收藏/取消收藏 B站收藏夹（主进程 net.fetch，自动带 Cookie 且无 CORS 限制）
  // rid 支持 aid（数字）或 bvid（字符串），B站 deal 接口两者均可
  ipcMain.handle('bili:dealFavorite', async (_e, rid: number | string, addMediaIds: number[], delMediaIds: number[] = []) => {
    const cookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' })
    const biliJct = cookies.find((c) => c.name === 'bili_jct')?.value || ''
    if (!biliJct) {
      throw new Error('未检测到 B站登录态（bili_jct 为空），请重新登录后再收藏')
    }
    const body = new URLSearchParams({
      rid: String(rid),
      type: '2',
      add_media_ids: addMediaIds.join(','),
      del_media_ids: delMediaIds.join(','),
      csrf: biliJct,
      platform: 'web',
      // 以下为 B站 web 端风控/来源字段，取消收藏（del）缺失时会返回风控错误（-412 等）
      eab_x: '2',
      ga: '1',
      gaia_source: 'web_normal',
    }).toString()
    const resp = await net.fetch(`${BILI_API}/x/v3/fav/resource/deal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://www.bilibili.com',
        'User-Agent': BILI_UA,
      },
      body,
    })
    const data = await resp.json()
    if (data.code !== 0) {
      throw new Error(`收藏失败（${data.code}）：${data.message || '未知错误'}`)
    }
    return { code: data.code, message: data.message }
  })

  // 通用 B站 JSON GET（主进程 net.fetch，自动带 Cookie + Referer + UA）
  // 解决渲染层 fetch 跨域/风控导致返回 HTML（如 HTTP 412 验证页）而无法解析 JSON 的问题
  ipcMain.handle('bili:fetchBiliJson', async (_e, path: string, params?: Record<string, string | number | boolean>) => {
    const url = new URL(`${BILI_API}${path}`)
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)))
    }
    const resp = await net.fetch(url.toString(), {
      headers: {
        Referer: 'https://www.bilibili.com',
        'User-Agent': BILI_UA,
      },
    })
    const text = await resp.text()
    // 风控/登录页等返回 HTML，而非 JSON，需先判断再解析，避免 raw SyntaxError 暴露给 UI
    const ct = resp.headers.get('content-type') || ''
    if (resp.status !== 200 || (ct && !ct.includes('application/json') && !ct.includes('text/json'))) {
      throw new Error(`B站接口返回异常（HTTP ${resp.status}），可能触发风控或登录失效，请重新登录后重试`)
    }
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`B站接口返回非 JSON 数据，可能触发风控或登录失效，请重新登录后重试`)
    }
    const body = data as { code?: number; message?: string; data?: unknown }
    if (body.code !== 0) {
      throw new Error(`B站接口错误（${body.code}）：${body.message || '未知错误'}`)
    }
    return body.data
  })

  // 打开 B站官方登录页窗口，登录成功后自动捕获 Cookie（官方页原生处理极验人机验证）
  ipcMain.handle('bili:openLoginWindow', async () => {
    // 已有登录窗口则聚焦并等待
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus()
      return new Promise((resolve) => { loginResolveFn = resolve })
    }
    return new Promise((resolve) => {
      loginResolveFn = resolve
      const win = new BrowserWindow({
        width: 420,
        height: 648,
        minWidth: 380,
        minHeight: 560,
        autoHideMenuBar: true,
        title: 'B站登录',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          // 不设 partition，使用默认 session，登录 Cookie 写入 defaultSession（与主窗口共享）
        },
      })
      loginWindow = win

      // 监听 Cookie，检测登录成功（SESSDATA 出现即为已登录）
      let loggedIn = false
      const onCookieChanged = async (_e: never, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
        if (removed || loggedIn) return
        if (cookie.name === 'SESSDATA' && cookie.value) {
          loggedIn = true
          session.defaultSession.cookies.removeListener('changed', onCookieChanged)
          const r = loginResolveFn
          loginResolveFn = null
          if (r) r(true)
          closeLoginWindow()
        }
      }
      session.defaultSession.cookies.on('changed', onCookieChanged)

      win.webContents.setUserAgent(BILI_UA)
      win.loadURL(`${BILI_PASSPORT}/login`, { userAgent: BILI_UA })
      win.on('closed', () => {
        session.defaultSession.cookies.removeListener('changed', onCookieChanged)
        closeLoginWindow()
      })
      // 5 分钟未登录则判定失败
      setTimeout(() => {
        if (!loggedIn) {
          const r = loginResolveFn
          loginResolveFn = null
          closeLoginWindow()
          if (r) r(false)
        }
      }, 5 * 60 * 1000)
    })
  })

  ipcMain.handle('bili:logout', async () => {
    await session.defaultSession.cookies.remove(BILI_API, 'SESSDATA')
    await session.defaultSession.cookies.remove(BILI_API, 'bili_jct')
    await session.defaultSession.cookies.remove(BILI_API, 'DedeUserID')
    await session.defaultSession.cookies.remove(BILI_API, 'DedeUserID__ckMd5')
    return { success: true }
  })
}

// ===== Cookie 解析辅助 =====

function parseCookieName(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  return pair.split('=')[0].trim()
}

function parseCookieValue(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  return pair.split('=').slice(1).join('=').trim()
}

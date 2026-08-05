import { ipcMain, net, app, session, shell } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import { spawn } from 'child_process'

const BILI_API = 'https://api.bilibili.com'
const BILI_PASSPORT = 'https://passport.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com'

// ffmpeg-static 提供跨平台静态 ffmpeg 二进制
// 打包后 ffmpeg.exe 位于 app.asar.unpacked 内，需修正路径
let ffmpegPath: string
try {
  const rawPath = require('ffmpeg-static') as string
  // 打包后 require 返回 app.asar/node_modules/... 路径，
  // 但 asarUnpack 将二进制解压到 app.asar.unpacked/node_modules/...
  ffmpegPath = rawPath.replace('app.asar', 'app.asar.unpacked')
} catch {
  ffmpegPath = 'ffmpeg' // fallback to system PATH
}

// ===== 流下载辅助 =====

async function downloadStream(url: string): Promise<Buffer> {
  const response = await net.fetch(url, {
    headers: { Referer: BILI_REFERER },
  })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 用 ffmpeg 合并视频流和音频流
 * - 视频流直接复制 (-c:v copy)，不重新编码
 * - 音频流直接复制 (-c:a copy)
 * B站 DASH 的 m4s 格式可直接被 ffmpeg 合并为 mp4
 */
function mergeWithFfmpeg(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-y', // 覆盖已有文件
      outputPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (err: Error) => {
      reject(new Error(`ffmpeg 启动失败: ${err.message}. 请确保 ffmpeg 可用。`))
    })
    proc.on('close', (code: number) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 合并失败 (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

// ===== IPC Handlers =====
//
// 注意：搜索、视频详情、播放地址、推荐、热门、排行榜等接口已迁移至渲染层
// 直接 fetch（src/services/bilibiliApi.ts），因主进程 net.fetch 会被 B站反爬
// 拦截（-352）。此处仅保留渲染层无法自行处理的 IPC：下载、扫码登录、Cookie 管理。

export function registerBiliApiHandlers() {
  // 下载音频文件到本地
  ipcMain.handle('bili:downloadAudio', async (_event, audioUrl: string, filename: string, customDir?: string) => {
    // 过滤文件名中的危险字符，防止路径遍历
    const safeName = filename.replace(/\.\./g, '_').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
    const downloadDir = customDir || path.join(app.getPath('userData'), 'downloads')
    await fs.mkdir(downloadDir, { recursive: true })
    const filePath = path.join(downloadDir, safeName)

    const response = await net.fetch(audioUrl, {
      headers: { Referer: BILI_REFERER },
    })

    if (!response.ok) throw new Error(`Download failed: ${response.status}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(filePath, buffer)

    return { filePath, size: buffer.length }
  })

  // 下载视频（合并画面+声音）到本地
  // 分别下载视频流和音频流，用 ffmpeg 合并为 mp4
  ipcMain.handle('bili:downloadVideo', async (
    _event,
    videoUrl: string,
    audioUrl: string,
    filename: string,
    customDir?: string,
  ) => {
    const safeName = filename.replace(/\.\./g, '_').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
    const downloadDir = customDir || path.join(app.getPath('userData'), 'downloads')
    await fs.mkdir(downloadDir, { recursive: true })
    const outputPath = path.join(downloadDir, safeName.endsWith('.mp4') ? safeName : `${safeName}.mp4`)

    // 临时文件用于存放原始流
    const tmpDir = path.join(downloadDir, '.tmp')
    await fs.mkdir(tmpDir, { recursive: true })
    const tmpVideo = path.join(tmpDir, `${Date.now()}_video.m4s`)
    const tmpAudio = path.join(tmpDir, `${Date.now()}_audio.m4s`)

    try {
      // 并行下载视频流和音频流
      const [videoBuf, audioBuf] = await Promise.all([
        downloadStream(videoUrl),
        downloadStream(audioUrl),
      ])

      await fs.writeFile(tmpVideo, videoBuf)
      await fs.writeFile(tmpAudio, audioBuf)

      // 用 ffmpeg 合并：视频流和音频流直接复制
      await mergeWithFfmpeg(tmpVideo, tmpAudio, outputPath)

      const stat = await fs.stat(outputPath)
      return { filePath: outputPath, size: stat.size }
    } finally {
      // 清理临时文件
      await fs.rm(tmpVideo, { force: true }).catch(() => {})
      await fs.rm(tmpAudio, { force: true }).catch(() => {})
    }
  })

  // 打开下载目录
  ipcMain.handle('bili:openDownloadDir', async (_event, dirPath?: string) => {
    const target = dirPath || path.join(app.getPath('userData'), 'downloads')
    await shell.openPath(target)
    return { success: true }
  })

  // ===== 扫码登录 =====

  // 生成二维码
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

  // 轮询二维码状态
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

    // B站 poll 响应：外层 code 表示 API 调用结果，
    // 内层 data.code 才是扫码状态（86101=未扫码, 86090=已扫码, 0=成功）
    return {
      code: data.data?.code ?? data.code,
      status: data.data?.code ?? data.code,
      message: data.data?.message || data.message,
      url: data.data?.url || '',
    }
  })

  // 获取当前 Cookie 中的登录状态
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

  // 退出登录（清除 Cookie）
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

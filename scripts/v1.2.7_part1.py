#!/usr/bin/env python3
"""
v1.2.7 comprehensive update script.
Handles all file modifications with CRLF preservation.
"""

import os, re

LF = '\n'
CRLF = '\r\n'

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file_crlf(path, content):
    """Write file with CRLF line endings."""
    # Normalize to CRLF
    content = content.replace(CRLF, LF).replace(LF, CRLF)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(content)

def write_file_lf(path, content):
    """Write file with LF line endings."""
    content = content.replace(CRLF, LF)
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(content)

def replace_in_file(path, old, new):
    """Replace text in file, handling CRLF."""
    content = read_file(path)
    # Try CRLF first
    old_crlf = old.replace(LF, CRLF)
    new_crlf = new.replace(LF, CRLF)
    if old_crlf in content:
        content = content.replace(old_crlf, new_crlf)
        write_file_crlf(path, content)
        return True
    elif old in content:
        content = content.replace(old, new)
        # Detect original line ending
        if CRLF in read_file(path):
            write_file_crlf(path, content)
        else:
            write_file_lf(path, content)
        return True
    return False

# ============================================================
# 1. Sidebar.tsx — Remove "B站个人主页" and "哔哩哔后官网" menu items
# ============================================================
print("=== 1. Sidebar.tsx: removing menu items ===")

sidebar_path = r'N:\播放器\BiliMusic\src\components\layout\Sidebar.tsx'
content = read_file(sidebar_path)

# Find and remove the two menu buttons, keeping only "退出登录"
# The pattern: from the first <button> with "B站个人主页" to just before the "退出登录" <button>
# We need to remove everything from the first button to the start of the logout button

# Find the "B站个人主页" button start
old_block = """                <button
                  type="button"
                  onClick={() => {
                    const mid = localStorage.getItem('bili_mid')
                    if (mid) {
                      window.electronAPI?.openExternal(`https://space.bilibili.com/${mid}`)
                    }
                    setUserMenuOpen(false)
                  }}
                  style={{
                    padding: '8px 12px',
                    border: 'none',
                    borderRadius: 8,
                    background: 'transparent',
                    color: 'var(--sidebar-text)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontFamily: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <User size={15} />
                  B站个人主页
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.electronAPI?.openExternal('https://www.bilibili.com')
                    setUserMenuOpen(false)
                  }}
                  style={{
                    padding: '8px 12px',
                    border: 'none',
                    borderRadius: 8,
                    background: 'transparent',
                    color: 'var(--sidebar-text)',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontFamily: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <ExternalLink size={15} />
                  哔哩哔后官网
                </button>
                <button"""

new_block = """                <button"""

if replace_in_file(sidebar_path, old_block, new_block):
    print("[OK] Removed 'B站个人主页' and '哔哩哔后官网' menu items")
else:
    print("[FAIL] Could not find menu items to remove")

# Check if User and ExternalLink imports are still used elsewhere
content = read_file(sidebar_path)
# Remove unused imports if needed
if 'User ' not in content.split('B站个人主页')[0] if 'B站个人主页' in content else True:
    # Check if User is used elsewhere
    user_uses = len(re.findall(r'\bUser\b', content))
    external_uses = len(re.findall(r'\bExternalLink\b', content))
    # Only remove if the only use was in the deleted menu
    # We'll check after the replacement
    pass

# ============================================================
# 2. lyrics.ts — Add formatLrc function
# ============================================================
print("\n=== 2. lyrics.ts: adding formatLrc function ===")

lyrics_path = r'N:\播放器\BiliMusic\src\services\lyrics.ts'
old_tail = """export async function chooseLyricCandidate(trackId: string, record: LyricCandidate): Promise<LyricResult | null> {
  const content = await oiGetLyric(record.songId)
  const result = lyricToResult(record, content)
  if (result) cacheOk(trackId, result)
  return result ? applyLyricOffset(result, trackId) : null
}"""

new_tail = """export async function chooseLyricCandidate(trackId: string, record: LyricCandidate): Promise<LyricResult | null> {
  const content = await oiGetLyric(record.songId)
  const result = lyricToResult(record, content)
  if (result) cacheOk(trackId, result)
  return result ? applyLyricOffset(result, trackId) : null
}

/**
 * 将 LyricResult 格式化为 LRC 文本（含偏移）
 * 用于下载歌词文件
 */
export function formatLrc(result: LyricResult): string {
  const lines: string[] = []
  if (result.trackName) lines.push(`[ti:${result.trackName}]`)
  if (result.artistName) lines.push(`[ar:${result.artistName}]`)
  lines.push('[al:]')
  lines.push('[by:BiliMusic]')
  for (const line of result.lines) {
    if (line.time >= 0) {
      const min = Math.floor(line.time / 60)
      const sec = Math.floor(line.time % 60)
      const ms = Math.floor((line.time % 1) * 1000)
      lines.push(`[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}]${line.text}`)
    } else {
      lines.push(line.text)
    }
  }
  return lines.join('\\n')
}"""

if replace_in_file(lyrics_path, old_tail, new_tail):
    print("[OK] Added formatLrc function")
else:
    print("[FAIL] Could not add formatLrc function")

# ============================================================
# 3. electron/biliApi.ts — Update download handlers with metadata + lyric support
# ============================================================
print("\n=== 3. biliApi.ts: updating download handlers ===")

bili_path = r'N:\播放器\BiliMusic\electron\biliApi.ts'
content = read_file(bili_path)

# Add dialog import to main.ts is separate step
# Add selectDownloadFolder IPC handler + saveLyricFile + update downloadAudio/downloadVideo

# 3a. Add selectDownloadFolder handler after getDefaultDownloadDir
old_get_default = """  // 返回系统默认音乐目录，供渲染层作为下载路径初始值
  ipcMain.handle('bili:getDefaultDownloadDir', async () => {
    return path.join(app.getPath('music'), 'BiliMusic')
  })"""

new_get_default = """  // 返回系统默认音乐目录，供渲染层作为下载路径初始值
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
  })"""

if replace_in_file(bili_path, old_get_default, new_get_default):
    print("[OK] Added selectDownloadFolder and saveLyricFile handlers")
else:
    print("[FAIL] Could not add new IPC handlers")

# 3b. Update downloadAudio to accept options (artist, title, lyricContent)
old_dl_audio_sig = """  ipcMain.handle('bili:downloadAudio', async (
    _event,
    audioUrl: string,
    filename: string,
    customDir?: string,
  ) => {"""

new_dl_audio_sig = """  ipcMain.handle('bili:downloadAudio', async (
    _event,
    audioUrl: string,
    filename: string,
    customDir?: string,
    options?: { artist?: string; title?: string; lyricContent?: string },
  ) => {"""

if replace_in_file(bili_path, old_dl_audio_sig, new_dl_audio_sig):
    print("[OK] Updated downloadAudio signature")
else:
    print("[FAIL] Could not update downloadAudio signature")

# 3c. In downloadAudio, after writing the file, add metadata + lyric saving
# Find the return statement in downloadAudio and add metadata processing before it
old_audio_return = """    return { filePath, size: received }
  })

  // 下载视频（合并画面+声音）到本地"""

new_audio_return = """    // 如果有元数据，用 ffmpeg 嵌入
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
      const lyricPath = filePath.replace(/\\.[^.]+$/, '.lrc')
      try {
        await fs.writeFile(lyricPath, options.lyricContent, 'utf-8')
        console.log('[biliApi] Lyric saved:', lyricPath)
      } catch (e) {
        console.warn('[biliApi] Failed to save lyric:', e)
      }
    }

    return { filePath, size: received }
  })

  // 下载视频（合并画面+声音）到本地"""

if replace_in_file(bili_path, old_audio_return, new_audio_return):
    print("[OK] Added metadata + lyric saving to downloadAudio")
else:
    print("[FAIL] Could not update downloadAudio return")

# 3d. Update downloadVideo signature
old_dl_video_sig = """  ipcMain.handle('bili:downloadVideo', async (
    _event,
    videoUrl: string,
    audioUrl: string,
    filename: string,
    customDir?: string,
  ) => {"""

new_dl_video_sig = """  ipcMain.handle('bili:downloadVideo', async (
    _event,
    videoUrl: string,
    audioUrl: string,
    filename: string,
    customDir?: string,
    options?: { artist?: string; title?: string; lyricContent?: string },
  ) => {"""

if replace_in_file(bili_path, old_dl_video_sig, new_dl_video_sig):
    print("[OK] Updated downloadVideo signature")
else:
    print("[FAIL] Could not update downloadVideo signature")

# 3e. Update mergeWithFfmpeg call in downloadVideo to include metadata
old_merge_call = """      console.log('[biliApi] Merging with ffmpeg...')
      await mergeWithFfmpeg(tmpVideo, tmpAudio, outputPath)
      console.log('[biliApi] Merge complete:', outputPath)"""

new_merge_call = """      console.log('[biliApi] Merging with ffmpeg...')
      await mergeWithFfmpegMeta(tmpVideo, tmpAudio, outputPath, options)
      console.log('[biliApi] Merge complete:', outputPath)"""

if replace_in_file(bili_path, old_merge_call, new_merge_call):
    print("[OK] Updated merge call to use metadata version")
else:
    print("[FAIL] Could not update merge call")

# 3f. Update the fallback direct URL call too
old_fallback_call = """        console.log('[biliApi] Trying fallback: ffmpeg direct URL fetch...')
        await mergeWithFfmpegDirectUrl(videoUrl, audioUrl, outputPath, BILI_REFERER)"""

new_fallback_call = """        console.log('[biliApi] Trying fallback: ffmpeg direct URL fetch...')
        await mergeWithFfmpegDirectUrlMeta(videoUrl, audioUrl, outputPath, BILI_REFERER, options)"""

if replace_in_file(bili_path, old_fallback_call, new_fallback_call):
    print("[OK] Updated fallback call to use metadata version")
else:
    print("[FAIL] Could not update fallback call")

# 3g. Add lyric saving after video download success
old_video_stat = """      const stat = await fs.stat(outputPath)
      return { filePath: outputPath, size: stat.size }
    } catch (err) {
      console.error('[biliApi] downloadVideo plan A failed:', err)"""

new_video_stat = """      // 保存歌词文件
      if (options?.lyricContent) {
        const lyricPath = outputPath.replace(/\\.[^.]+$/, '.lrc')
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
      console.error('[biliApi] downloadVideo plan A failed:', err)"""

if replace_in_file(bili_path, old_video_stat, new_video_stat):
    print("[OK] Added lyric saving to downloadVideo")
else:
    print("[FAIL] Could not add lyric saving to downloadVideo")

# 3h. Add runFfmpeg, mergeWithFfmpegMeta, mergeWithFfmpegDirectUrlMeta functions
# Insert before the existing mergeWithFfmpeg function
old_merge_start = """// ===== ffmpeg 合并 =====
/**
 * 用 ffmpeg 合并视频流和音频流
 * 方案：直接通过 -i 本地文件方式让 ffmpeg 合并
 */
function mergeWithFfmpeg(""";

new_merge_start = """// ===== ffmpeg 辅 =====

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
function mergeWithFfmpegMeta(""";

if replace_in_file(bili_path, old_merge_start, new_merge_start):
    print("[OK] Added runFfmpeg and mergeWithFfmpegMeta")
else:
    print("[FAIL] Could not add helper functions")

# 3i. Update mergeWithFfmpeg to mergeWithFfmpegMeta with options param
old_merge_body = """function mergeWithFfmpegMeta(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
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
}"""

new_merge_body = """function mergeWithFfmpegMeta(
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
}"""

if replace_in_file(bili_path, old_merge_body, new_merge_body):
    print("[OK] Updated mergeWithFfmpegMeta body")
else:
    print("[FAIL] Could not update mergeWithFfmpegMeta body")

# 3j. Update mergeWithFfmpegDirectUrl to mergeWithFfmpegDirectUrlMeta
old_direct_url = """function mergeWithFfmpegDirectUrl(
  videoUrl: string,
  audioUrl: string,
  outputPath: string,
  referer: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = `Referer: ${referer}\\r\\nUser-Agent: ${BILI_UA}\\r\\n`
    const args = [
      '-headers', headers,
      '-i', videoUrl,
      '-i', audioUrl,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-y',
      outputPath,
    ]"""

new_direct_url = """function mergeWithFfmpegDirectUrlMeta(
  videoUrl: string,
  audioUrl: string,
  outputPath: string,
  referer: string,
  options?: DownloadOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = `Referer: ${referer}\\r\\nUser-Agent: ${BILI_UA}\\r\\n`
    const args = [
      '-headers', headers,
      '-i', videoUrl,
      '-i', audioUrl,
      '-c:v', 'copy',
      '-c:a', 'copy',
      ...buildMetaArgs(options),
      '-y',
      outputPath,
    ]"""

if replace_in_file(bili_path, old_direct_url, new_direct_url):
    print("[OK] Updated mergeWithFfmpegDirectUrl to Meta version")
else:
    print("[FAIL] Could not update direct URL function")

print("\n=== All biliApi.ts changes done ===")

# ============================================================
# 4. preload.cjs — Add new IPC methods
# ============================================================
print("\n=== 4. preload.cjs: adding new IPC methods ===")

preload_path = r'N:\播放器\BiliMusic\electron\preload.cjs'
old_preload = """  // 获取系统默认下载目录
  getDefaultDownloadDir: () =>
    ipcRenderer.invoke('bili:getDefaultDownloadDir'),"""

new_preload = """  // 获取系统默认下载目录
  getDefaultDownloadDir: () =>
    ipcRenderer.invoke('bili:getDefaultDownloadDir'),
  // 选择下载目录
  selectDownloadFolder: () =>
    ipcRenderer.invoke('bili:selectDownloadFolder'),
  // 保存歌词文件
  saveLyricFile: (content, filePath) =>
    ipcRenderer.invoke('bili:saveLyricFile', content, filePath),"""

if replace_in_file(preload_path, old_preload, new_preload):
    print("[OK] Added selectDownloadFolder and saveLyricFile to preload")
else:
    print("[FAIL] Could not update preload.cjs")

# ============================================================
# 5. electron.d.ts — Update type declarations
# ============================================================
print("\n=== 5. electron.d.ts: updating types ===")

types_path = r'N:\播放器\BiliMusic\src\types\electron.d.ts'

old_types = """  downloadAudio: (audioUrl: string, filename: string, customDir?: string) => Promise<{
    filePath: string
    size: number
  }>
  downloadVideo: (videoUrl: string, audioUrl: string, filename: string, customDir?: string) => Promise<{
    filePath: string
    size: number
  }>
  openDownloadDir: (dirPath?: string) => Promise<{ success: boolean }>
  getDefaultDownloadDir: () => Promise<string>"""

new_types = """  downloadAudio: (audioUrl: string, filename: string, customDir?: string, options?: DownloadOptions) => Promise<{
    filePath: string
    size: number
  }>
  downloadVideo: (videoUrl: string, audioUrl: string, filename: string, customDir?: string, options?: DownloadOptions) => Promise<{
    filePath: string
    size: number
  }>
  openDownloadDir: (dirPath?: string) => Promise<{ success: boolean }>
  getDefaultDownloadDir: () => Promise<string>
  selectDownloadFolder: () => Promise<string | null>
  saveLyricFile: (content: string, filePath: string) => Promise<{ success: boolean; filePath: string }>"""

if replace_in_file(types_path, old_types, new_types):
    print("[OK] Updated BiliApi type declarations")
else:
    print("[FAIL] Could not update type declarations")

# Add DownloadOptions interface
old_interface_start = """interface BiliApi {"""

new_interface_start = """export interface DownloadOptions {
  artist?: string
  title?: string
  lyricContent?: string
}

interface BiliApi {"""

if replace_in_file(types_path, old_interface_start, new_interface_start):
    print("[OK] Added DownloadOptions interface")
else:
    print("[FAIL] Could not add DownloadOptions interface")

# ============================================================
# 6. api.ts — Update downloadTrack to accept and pass options
# ============================================================
print("\n=== 6. api.ts: updating downloadTrack ===")

api_path = r'N:\播放器\BiliMusic\src\services\api.ts'

old_dl_track = """export async function downloadTrack(
  bvid: string,
  fallback: { aid?: string | number; cid?: string | number },
  title: string,
  format: 'audio' | 'video',
  quality: import('@/services/bilibiliApi').AudioQualityPreference,
  customDir?: string,
): Promise<{ filePath: string; size: number }> {
  
  // 获取播放地址
  let cid: number | undefined
  try {
    const detail = await getVideoDetail(bvid)
    cid = detail.cid
  } catch {
    cid = undefined
  }

  if (!cid && fallback.cid) {
    cid = Number(fallback.cid)
  }
  if (!cid) throw new Error('无法获取视频 cid')

  const playData = await getPlayUrl(bvid, cid)
  const audioUrl = getBestAudioUrl(playData, quality)
  const safeTitle = title.replace(/[/\\\\/:*?"<>|]/g, '_').trim()

  if (format === 'audio') {
    const ext = audioUrl.includes('.flac') ? '.flac' : '.m4a'
    return downloadAudio(audioUrl, `${safeTitle}${ext}`, customDir)
  } else {
    const videoUrl = getBestVideoUrl(playData)
    return downloadVideo(videoUrl, audioUrl, `${safeTitle}.mp4`, customDir)
  }
}"""

new_dl_track = """export async function downloadTrack(
  bvid: string,
  fallback: { aid?: string | number; cid?: string | number },
  title: string,
  format: 'audio' | 'video',
  quality: import('@/services/bilibiliApi').AudioQualityPreference,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {

  // 获取播放地址
  let cid: number | undefined
  try {
    const detail = await getVideoDetail(bvid)
    cid = detail.cid
  } catch {
    cid = undefined
  }

  if (!cid && fallback.cid) {
    cid = Number(fallback.cid)
  }
  if (!cid) throw new Error('无法获取视频 cid')

  const playData = await getPlayUrl(bvid, cid)
  const audioUrl = getBestAudioUrl(playData, quality)
  const safeTitle = title.replace(/[\\\\/:*?"<>|]/g, '_').trim()

  if (format === 'audio') {
    const ext = audioUrl.includes('.flac') ? '.flac' : '.m4a'
    return downloadAudio(audioUrl, `${safeTitle}${ext}`, customDir, options)
  } else {
    const videoUrl = getBestVideoUrl(playData)
    return downloadVideo(videoUrl, audioUrl, `${safeTitle}.mp4`, customDir, options)
  }
}"""

if replace_in_file(api_path, old_dl_track, new_dl_track):
    print("[OK] Updated downloadTrack with options param")
else:
    print("[FAIL] Could not update downloadTrack")

# Also update downloadAudio and downloadVideo function signatures in api.ts
old_api_dl_audio = """export async function downloadAudio(audioUrl: string, filename: string, customDir?: string): Promise<{ filePath: string; size: number }> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.downloadAudio(audioUrl, filename, customDir)
  }

  throw new Error('Audio download requires Electron environment')
}"""

new_api_dl_audio = """export async function downloadAudio(
  audioUrl: string,
  filename: string,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.downloadAudio(audioUrl, filename, customDir, options)
  }

  throw new Error('Audio download requires Electron environment')
}"""

if replace_in_file(api_path, old_api_dl_audio, new_api_dl_audio):
    print("[OK] Updated downloadAudio in api.ts")
else:
    print("[FAIL] Could not update downloadAudio in api.ts")

old_api_dl_video = """export async function downloadVideo(videoUrl: string, audioUrl: string, filename: string, customDir?: string): Promise<{ filePath: string; size: number }> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.downloadVideo(videoUrl, audioUrl, filename, customDir)
  }

  throw new Error('Video download requires Electron environment')
}"""

new_api_dl_video = """export async function downloadVideo(
  videoUrl: string,
  audioUrl: string,
  filename: string,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.downloadVideo(videoUrl, audioUrl, filename, customDir, options)
  }

  throw new Error('Video download requires Electron environment')
}"""

if replace_in_file(api_path, old_api_dl_video, new_api_dl_video):
    print("[OK] Updated downloadVideo in api.ts")
else:
    print("[FAIL] Could not update downloadVideo in api.ts")

# Add selectDownloadFolder and saveLyricFile wrapper functions
old_open_dir = """export async function openDownloadDir(dirPath?: string): Promise<void> {
  if (window.electronAPI?.biliApi) {
    await window.electronAPI.biliApi.openDownloadDir(dirPath)
  }
}"""

new_open_dir = """export async function openDownloadDir(dirPath?: string): Promise<void> {
  if (window.electronAPI?.biliApi) {
    await window.electronAPI.biliApi.openDownloadDir(dirPath)
  }
}

export async function selectDownloadFolder(): Promise<string | null> {
  if (window.electronAPI?.biliApi) {
    return window.electronAPI.biliApi.selectDownloadFolder()
  }
  return null
}

export async function saveLyricFile(content: string, filePath: string): Promise<void> {
  if (window.electronAPI?.biliApi) {
    await window.electronAPI.biliApi.saveLyricFile(content, filePath)
  }
}"""

if replace_in_file(api_path, old_open_dir, new_open_dir):
    print("[OK] Added selectDownloadFolder and saveLyricFile to api.ts")
else:
    print("[FAIL] Could not add wrapper functions to api.ts")

print("\n=== All script changes done! ===")

path = r'N:\播放器\BiliMusic\electron\biliApi.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: Add createRequire and fsSync import
old_imports = (
    "import { ipcMain, net, app, session, shell } from 'electron'\r\n"
    "import path from 'path'\r\n"
    "import fs from 'fs/promises'\r\n"
    "import { spawn } from 'child_process'\r\n"
)
new_imports = (
    "import { ipcMain, net, app, session, shell } from 'electron'\r\n"
    "import path from 'path'\r\n"
    "import fs from 'fs/promises'\r\n"
    "import fsSync from 'fs'\r\n"
    "import { spawn } from 'child_process'\r\n"
    "import { createRequire } from 'module'\r\n"
    "\r\n"
    "const require = createRequire(import.meta.url)\r\n"
)

if old_imports in content:
    content = content.replace(old_imports, new_imports)
    print("Imports fixed")
else:
    print("ERROR: imports not found")
    exit(1)

# Fix 2: Replace the ffmpeg path resolution block
old_ffmpeg = (
    "// ===== ffmpeg \u8def\u5f84\u89e3\u6790 =====\r\n"
    "// ffmpeg-static \u63d0\u4f9b\u8de8\u5e73\u53f0\u9759\u6001 ffmpeg \u4e8c\u8fdb\u5236\r\n"
    "// \u6253\u5305\u540e ffmpeg.exe \u4f4d\u4e8e app.asar.unpacked \u5185\uff0c\u9700\u4fee\u6b63\u8def\u5f84\r\n"
    "let ffmpegPath: string\r\n"
    "try {\r\n"
    "  const rawPath = require('ffmpeg-static') as string\r\n"
    "  const fixedPath = rawPath.includes('app.asar')\r\n"
    "    ? rawPath.replace('app.asar', 'app.asar.unpacked')\r\n"
    "    : rawPath\r\n"
    "  const fsSync = require('fs')\r\n"
    "  if (fsSync.existsSync(fixedPath)) {\r\n"
    "    ffmpegPath = fixedPath\r\n"
    "  } else {\r\n"
    "    console.warn('[biliApi] ffmpeg not found at:', fixedPath, ', falling back to system PATH')\r\n"
    "    ffmpegPath = 'ffmpeg'\r\n"
    "  }\r\n"
    "} catch (e) {\r\n"
    "  console.warn('[biliApi] ffmpeg-static require failed:', e)\r\n"
    "  ffmpegPath = 'ffmpeg'\r\n"
    "}\r\n"
)

new_ffmpeg = (
    "// ===== ffmpeg \u8def\u5f84\u89e3\u6790 =====\r\n"
    "// ffmpeg-static \u63d0\u4f9b\u8de8\u5e73\u53f0\u9759\u6001 ffmpeg \u4e8c\u8fdb\u5236\r\n"
    "// \u6253\u5305\u540e ffmpeg.exe \u4f4d\u4e8e app.asar.unpacked \u5185\uff0c\u9700\u4fee\u6b63\u8def\u5f84\r\n"
    "// ESM \u4e2d\u65e0\u6cd5\u76f4\u63a5\u4f7f\u7528 require\uff0c\u901a\u8fc7 createRequire \u6865\u63a5\r\n"
    "function resolveFfmpegPath(): string {\r\n"
    "  // \u7b56\u7565 1\uff1a\u901a\u8fc7 createRequire \u89e3\u6790 ffmpeg-static \u6a21\u5757\r\n"
    "  try {\r\n"
    "    const rawPath = require('ffmpeg-static') as string\r\n"
    "    const fixedPath = rawPath.includes('app.asar')\r\n"
    "      ? rawPath.replace('app.asar', 'app.asar.unpacked')\r\n"
    "      : rawPath\r\n"
    "    if (fsSync.existsSync(fixedPath)) {\r\n"
    "      console.log('[biliApi] ffmpeg resolved (ffmpeg-static):', fixedPath)\r\n"
    "      return fixedPath\r\n"
    "    }\r\n"
    "    console.warn('[biliApi] ffmpeg-static path not exists:', fixedPath)\r\n"
    "  } catch (e) {\r\n"
    "    console.warn('[biliApi] ffmpeg-static require failed:', e)\r\n"
    "  }\r\n"
    "\r\n"
    "  // \u7b56\u7565 2\uff1a\u76f4\u63a5\u68c0\u67e5\u5e38\u89c1\u8def\u5f84\uff08\u5f00\u53d1\u73af\u5883\u548c\u6253\u5305\u73af\u5883\uff09\r\n"
    "  const candidates: string[] = [\r\n"
    "    // \u5f00\u53d1\u73af\u5883\uff1a\u76f8\u5bf9\u4e8e electron \u6e90\u76ee\u5f55\r\n"
    "    path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe'),\r\n"
    "    // \u6253\u5305\u73af\u5883\uff1aapp.asar.unpacked \u5185\r\n"
    "    path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'),\r\n"
    "    // \u6253\u5305\u73af\u5883\uff1adist-electron \u540c\u7ea7\r\n"
    "    path.join(__dirname, '../../node_modules/ffmpeg-static/ffmpeg.exe'),\r\n"
    "  ]\r\n"
    "  for (const p of candidates) {\r\n"
    "    if (fsSync.existsSync(p)) {\r\n"
    "      console.log('[biliApi] ffmpeg resolved (fallback path):', p)\r\n"
    "      return p\r\n"
    "    }\r\n"
    "  }\r\n"
    "\r\n"
    "  // \u7b56\u7565 3\uff1a\u56de\u9000\u5230\u7cfb\u7edf PATH\r\n"
    "  console.warn('[biliApi] ffmpeg not found in any location, falling back to system PATH')\r\n"
    "  return 'ffmpeg'\r\n"
    "}\r\n"
    "\r\n"
    "let ffmpegPath = resolveFfmpegPath()\r\n"
)

if old_ffmpeg in content:
    content = content.replace(old_ffmpeg, new_ffmpeg)
    print("FFmpeg path resolution fixed")
else:
    print("ERROR: ffmpeg block not found")
    exit(1)

# Fix 3: Replace downloadStream to use streaming instead of buffer
old_download = (
    "async function downloadStream(url: string): Promise<Buffer> {\r\n"
    "  const response = await net.fetch(url, {\r\n"
    "    headers: { Referer: BILI_REFERER },\r\n"
    "  })\r\n"
    "  if (!response.ok) throw new Error(`\u4e0b\u8f7d\u6d41\u5931\u8d25: HTTP ${response.status}`)\r\n"
    "  return Buffer.from(await response.arrayBuffer())\r\n"
    "}\r\n"
)

new_download = (
    "async function downloadStream(url: string, filePath: string): Promise<number> {\r\n"
    "  const response = await net.fetch(url, {\r\n"
    "    headers: { Referer: BILI_REFERER },\r\n"
    "  })\r\n"
    "  if (!response.ok) throw new Error(`\u4e0b\u8f7d\u6d41\u5931\u8d25: HTTP ${response.status}`)\r\n"
    "  // \u6d41\u5f0f\u5199\u5165\u6587\u4ef6\uff0c\u907f\u514d\u5927\u6587\u4ef6\u5360\u636e\u5185\u5b58\r\n"
    "  const reader = response.body?.getReader()\r\n"
    "  if (!reader) {\r\n"
    "    const buffer = Buffer.from(await response.arrayBuffer())\r\n"
    "    await fs.writeFile(filePath, buffer)\r\n"
    "    return buffer.length\r\n"
    "  }\r\n"
    "  const fileHandle = await fs.open(filePath, 'w')\r\n"
    "  let received = 0\r\n"
    "  try {\r\n"
    "    for (;;) {\r\n"
    "      const { done, value } = await reader.read()\r\n"
    "      if (done) break\r\n"
    "      if (value) {\r\n"
    "        await fileHandle.write(value)\r\n"
    "        received += value.length\r\n"
    "      }\r\n"
    "    }\r\n"
    "  } finally {\r\n"
    "    await fileHandle.close()\r\n"
    "  }\r\n"
    "  return received\r\n"
    "}\r\n"
)

if old_download in content:
    content = content.replace(old_download, new_download)
    print("downloadStream fixed (streaming)")
else:
    print("ERROR: downloadStream not found")
    exit(1)

# Fix 4: Update downloadVideo to use new streaming downloadStream + progress
old_video_download = (
    "      console.log('[biliApi] Downloading video stream...')\r\n"
    "      const [videoBuf, audioBuf] = await Promise.all([\r\n"
    "        downloadStream(videoUrl),\r\n"
    "        downloadStream(audioUrl),\r\n"
    "      ])\r\n"
    "      console.log(`[biliApi] Downloaded: video=${videoBuf.length} bytes, audio=${audioBuf.length} bytes`)\r\n"
    "\r\n"
    "      await fs.writeFile(tmpVideo, videoBuf)\r\n"
    "      await fs.writeFile(tmpAudio, audioBuf)\r\n"
)

new_video_download = (
    "      console.log('[biliApi] Downloading video & audio streams...')\r\n"
    "      const [videoSize, audioSize] = await Promise.all([\r\n"
    "        downloadStream(videoUrl, tmpVideo),\r\n"
    "        downloadStream(audioUrl, tmpAudio),\r\n"
    "      ])\r\n"
    "      console.log(`[biliApi] Downloaded: video=${videoSize} bytes, audio=${audioSize} bytes`)\r\n"
    "      _event.sender.send('bili:download-progress', { filename: safeName, received: videoSize + audioSize, total: videoSize + audioSize, percent: 100 })\r\n"
)

if old_video_download in content:
    content = content.replace(old_video_download, new_video_download)
    print("downloadVideo fixed (streaming + progress)")
else:
    print("ERROR: video download block not found")
    exit(1)

# Fix 5: Add User-Agent header to ffmpeg direct URL method for better compatibility
old_direct = (
    "    const args = [\r\n"
    "      '-headers', `Referer: ${referer}\\r\\n`,\r\n"
    "      '-i', videoUrl,\r\n"
    "      '-i', audioUrl,\r\n"
    "      '-c:v', 'copy',\r\n"
    "      '-c:a', 'copy',\r\n"
    "      '-y',\r\n"
    "      outputPath,\r\n"
    "    ]\r\n"
)

new_direct = (
    "    const args = [\r\n"
    "      '-headers', `Referer: ${referer}\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\n`,\r\n"
    "      '-i', videoUrl,\r\n"
    "      '-i', audioUrl,\r\n"
    "      '-c:v', 'copy',\r\n"
    "      '-c:a', 'copy',\r\n"
    "      '-y',\r\n"
    "      outputPath,\r\n"
    "    ]\r\n"
)

if old_direct in content:
    content = content.replace(old_direct, new_direct)
    print("ffmpeg direct URL: added User-Agent header")
else:
    print("WARNING: ffmpeg direct URL args not found (non-critical)")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print("\nAll biliApi.ts fixes applied successfully!")

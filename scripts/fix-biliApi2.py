import re

path = r'N:\播放器\BiliMusic\electron\biliApi.ts'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    
    # Fix imports: after "import { spawn } from 'child_process'" add fsSync and createRequire
    if line.strip() == "import { spawn } from 'child_process'":
        new_lines.append(line)
        new_lines.append("import fsSync from 'fs'\n")
        new_lines.append("import { createRequire } from 'module'\n")
        new_lines.append("\n")
        new_lines.append("const require = createRequire(import.meta.url)\n")
        i += 1
        # Skip the following empty line if present
        if i < len(lines) and lines[i].strip() == "":
            i += 1
        continue
    
    # Replace ffmpeg path resolution block
    if "// ===== ffmpeg" in line:
        # Skip the entire old block until the closing "}"
        # Find the block end: it ends before "// ===== \u6587\u4ef6\u540d\u5b89\u5168\u8fc7\u6ee4"
        while i < len(lines) and "// ===== \u6587\u4ef6\u540d\u5b89\u5168\u8fc7\u6ee4" not in lines[i]:
            i += 1
        
        # Insert new ffmpeg resolution
        new_lines.append("// ===== ffmpeg \u8def\u5f84\u89e3\u6790 =====\n")
        new_lines.append("// ffmpeg-static \u63d0\u4f9b\u8de8\u5e73\u53f0\u9759\u6001 ffmpeg \u4e8c\u8fdb\u5236\n")
        new_lines.append("// ESM \u4e2d\u65e0 require\uff0c\u901a\u8fc7 createRequire \u6865\u63a5\n")
        new_lines.append("function resolveFfmpegPath(): string {\n")
        new_lines.append("  // \u7b56\u7565 1\uff1a\u901a\u8fc7 createRequire \u89e3\u6790 ffmpeg-static\n")
        new_lines.append("  try {\n")
        new_lines.append("    const rawPath = require('ffmpeg-static') as string\n")
        new_lines.append("    const fixedPath = rawPath.includes('app.asar')\n")
        new_lines.append("      ? rawPath.replace('app.asar', 'app.asar.unpacked')\n")
        new_lines.append("      : rawPath\n")
        new_lines.append("    if (fsSync.existsSync(fixedPath)) {\n")
        new_lines.append("      console.log('[biliApi] ffmpeg resolved (ffmpeg-static):', fixedPath)\n")
        new_lines.append("      return fixedPath\n")
        new_lines.append("    }\n")
        new_lines.append("    console.warn('[biliApi] ffmpeg-static path not exists:', fixedPath)\n")
        new_lines.append("  } catch (e) {\n")
        new_lines.append("    console.warn('[biliApi] ffmpeg-static require failed:', e)\n")
        new_lines.append("  }\n")
        new_lines.append("\n")
        new_lines.append("  // \u7b56\u7565 2\uff1a\u76f4\u63a5\u68c0\u67e5\u5e38\u89c1\u8def\u5f84\n")
        new_lines.append("  const candidates: string[] = [\n")
        new_lines.append("    path.join(__dirname, '../node_modules/ffmpeg-static/ffmpeg.exe'),\n")
        new_lines.append("    path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe'),\n")
        new_lines.append("    path.join(__dirname, '../../node_modules/ffmpeg-static/ffmpeg.exe'),\n")
        new_lines.append("  ]\n")
        new_lines.append("  for (const p of candidates) {\n")
        new_lines.append("    if (fsSync.existsSync(p)) {\n")
        new_lines.append("      console.log('[biliApi] ffmpeg resolved (fallback):', p)\n")
        new_lines.append("      return p\n")
        new_lines.append("    }\n")
        new_lines.append("  }\n")
        new_lines.append("\n")
        new_lines.append("  console.warn('[biliApi] ffmpeg not found, falling back to system PATH')\n")
        new_lines.append("  return 'ffmpeg'\n")
        new_lines.append("}\n")
        new_lines.append("\n")
        new_lines.append("let ffmpegPath = resolveFfmpegPath()\n")
        new_lines.append("\n")
        continue
    
    # Replace downloadStream function
    if line.strip().startswith("async function downloadStream"):
        # Skip entire function until closing "}"
        brace_count = 0
        started = False
        while i < len(lines):
            if '{' in lines[i]:
                brace_count += lines[i].count('{')
                started = True
            if '}' in lines[i]:
                brace_count -= lines[i].count('}')
            if started and brace_count == 0:
                i += 1
                break
            i += 1
        
        # Insert new streaming downloadStream
        new_lines.append("async function downloadStream(url: string, filePath: string): Promise<number> {\n")
        new_lines.append("  const response = await net.fetch(url, {\n")
        new_lines.append("    headers: { Referer: BILI_REFERER },\n")
        new_lines.append("  })\n")
        new_lines.append("  if (!response.ok) throw new Error(`\u4e0b\u8f7d\u6d41\u5931\u8d25: HTTP ${response.status}`)\n")
        new_lines.append("  const reader = response.body?.getReader()\n")
        new_lines.append("  if (!reader) {\n")
        new_lines.append("    const buffer = Buffer.from(await response.arrayBuffer())\n")
        new_lines.append("    await fs.writeFile(filePath, buffer)\n")
        new_lines.append("    return buffer.length\n")
        new_lines.append("  }\n")
        new_lines.append("  const fileHandle = await fs.open(filePath, 'w')\n")
        new_lines.append("  let received = 0\n")
        new_lines.append("  try {\n")
        new_lines.append("    for (;;) {\n")
        new_lines.append("      const { done, value } = await reader.read()\n")
        new_lines.append("      if (done) break\n")
        new_lines.append("      if (value) {\n")
        new_lines.append("        await fileHandle.write(value)\n")
        new_lines.append("        received += value.length\n")
        new_lines.append("      }\n")
        new_lines.append("    }\n")
        new_lines.append("  } finally {\n")
        new_lines.append("    await fileHandle.close()\n")
        new_lines.append("  }\n")
        new_lines.append("  return received\n")
        new_lines.append("}\n")
        new_lines.append("\n")
        continue
    
    # Replace video download stream calls
    if "const [videoBuf, audioBuf] = await Promise.all([" in line:
        # Skip the entire block until the line after "await fs.writeFile(tmpAudio"
        while i < len(lines) and "await fs.writeFile(tmpAudio" not in lines[i]:
            i += 1
        if i < len(lines):
            i += 1  # skip the writeFile(tmpAudio line
        
        new_lines.append("      const [videoSize, audioSize] = await Promise.all([\n")
        new_lines.append("        downloadStream(videoUrl, tmpVideo),\n")
        new_lines.append("        downloadStream(audioUrl, tmpAudio),\n")
        new_lines.append("      ])\n")
        new_lines.append("      console.log(`[biliApi] Downloaded: video=${videoSize} bytes, audio=${audioSize} bytes`)\n")
        new_lines.append("      _event.sender.send('bili:download-progress', { filename: safeName, received: videoSize + audioSize, total: videoSize + audioSize, percent: 100 })\n")
        new_lines.append("\n")
        continue
    
    # Add User-Agent to ffmpeg direct URL headers
    if "'-headers', `Referer:" in line and "referer" in line.lower():
        new_lines.append("      '-headers', `Referer: ${referer}\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\n`,\n")
        i += 1
        continue
    
    new_lines.append(line)
    i += 1

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("biliApi.ts fixed successfully!")

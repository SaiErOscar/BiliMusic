#!/usr/bin/env python3
"""Fix downloadTrack in api.ts"""

path = r'N:\播放器\BiliMusic\src\services\api.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# The issue is the backslash in the regex. Let's find the exact text.
old = """export async function downloadTrack(
  bvid: string,
  fallback: { aid?: string | number; cid?: string | number },
  title: string,
  format: 'audio' | 'video',
  quality: import('@/services/bilibiliApi').AudioQualityPreference,
  customDir?: string,
): Promise<{ filePath: string; size: number }> {"""

new = """export async function downloadTrack(
  bvid: string,
  fallback: { aid?: string | number; cid?: string | number },
  title: string,
  format: 'audio' | 'video',
  quality: import('@/services/bilibiliApi').AudioQualityPreference,
  customDir?: string,
  options?: { artist?: string; title?: string; lyricContent?: string },
): Promise<{ filePath: string; size: number }> {"""

# Try both CRLF and LF
old_crlf = old.replace('\n', '\r\n')
new_crlf = new.replace('\n', '\r\n')

if old_crlf in content:
    content = content.replace(old_crlf, new_crlf)
    print("[OK] Found with CRLF")
elif old in content:
    content = content.replace(old, new)
    print("[OK] Found with LF")
else:
    print("[FAIL] Not found")
    exit(1)

# Also update the return statements to pass options
old2 = "    return downloadAudio(audioUrl, `${safeTitle}${ext}`, customDir)"
new2 = "    return downloadAudio(audioUrl, `${safeTitle}${ext}`, customDir, options)"

old2_crlf = old2
new2_crlf = new2

if old2_crlf in content:
    content = content.replace(old2_crlf, new2_crlf, 1)
    print("[OK] Updated audio return")
else:
    print("[FAIL] audio return not found")

old3 = "    return downloadVideo(videoUrl, audioUrl, `${safeTitle}.mp4`, customDir)"
new3 = "    return downloadVideo(videoUrl, audioUrl, `${safeTitle}.mp4`, customDir, options)"

if old3 in content:
    content = content.replace(old3, new3, 1)
    print("[OK] Updated video return")
else:
    print("[FAIL] video return not found")

# Write back
if '\r\n' in content:
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
else:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

print("Done!")

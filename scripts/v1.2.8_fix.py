#!/usr/bin/env python3
"""
v1.2.8 fix script:
1. Fix preload.cjs: pass options parameter to downloadAudio/downloadVideo
2. Fix DownloadButton.tsx: remove lyricResult.synced check
3. Fix BatchDownloadDialog.tsx: initialize downloadDir from settings
4. Add batch download + export to playlist in BiliFavorites.tsx
"""

import re

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
    # Detect original line ending
    with open(path, 'r', encoding='utf-8') as f:
        orig = f.read()
    if '\r\n' in orig:
        content = content.replace('\r\n', '\n').replace('\n', '\r\n')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
    else:
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)

def replace_text(path, old, new):
    content = read_file(path)
    old_crlf = old.replace('\n', '\r\n')
    new_crlf = new.replace('\n', '\r\n')
    if old_crlf in content:
        content = content.replace(old_crlf, new_crlf)
        write_file(path, content)
        return True
    elif old in content:
        content = content.replace(old, new)
        write_file(path, content)
        return True
    return False

# ============================================================
# Fix 1: preload.cjs — pass options parameter
# ============================================================
print("=== Fix 1: preload.cjs — pass options ===")

preload_path = r'N:\播放器\BiliMusic\electron\preload.cjs'

old_preload_audio = """  downloadAudio: (audioUrl, filename, customDir) =>
    ipcRenderer.invoke('bili:downloadAudio', audioUrl, filename, customDir),"""
new_preload_audio = """  downloadAudio: (audioUrl, filename, customDir, options) =>
    ipcRenderer.invoke('bili:downloadAudio', audioUrl, filename, customDir, options),"""

if replace_text(preload_path, old_preload_audio, new_preload_audio):
    print("[OK] Fixed downloadAudio in preload.cjs")
else:
    print("[FAIL] downloadAudio in preload.cjs")

old_preload_video = """  downloadVideo: (videoUrl, audioUrl, filename, customDir) =>
    ipcRenderer.invoke('bili:downloadVideo', videoUrl, audioUrl, filename, customDir),"""
new_preload_video = """  downloadVideo: (videoUrl, audioUrl, filename, customDir, options) =>
    ipcRenderer.invoke('bili:downloadVideo', videoUrl, audioUrl, filename, customDir, options),"""

if replace_text(preload_path, old_preload_video, new_preload_video):
    print("[OK] Fixed downloadVideo in preload.cjs")
else:
    print("[FAIL] downloadVideo in preload.cjs")

# ============================================================
# Fix 2: DownloadButton.tsx — remove synced check
# ============================================================
print("\n=== Fix 2: DownloadButton.tsx — remove synced check ===")

dl_btn_path = r'N:\播放器\BiliMusic\src\components\DownloadButton.tsx'

old_lyric_check = """        if (includeLyric && lyricResult.synced) {
          lyricContent = formatLrc(lyricResult)
        }"""
new_lyric_check = """        if (includeLyric && lyricResult.lines.length > 0) {
          lyricContent = formatLrc(lyricResult)
        }"""

if replace_text(dl_btn_path, old_lyric_check, new_lyric_check):
    print("[OK] Removed synced check in DownloadButton.tsx")
else:
    print("[FAIL] DownloadButton.tsx lyric check")

# ============================================================
# Fix 3: BatchDownloadDialog.tsx — initialize downloadDir from settings
# ============================================================
print("\n=== Fix 3: BatchDownloadDialog.tsx — init downloadDir ===")

batch_path = r'N:\播放器\BiliMusic\src\components\BatchDownloadDialog.tsx'

# Add useAppSettings import
old_import = "import { downloadTrack, selectDownloadFolder } from '@/services/api'"
new_import = "import { downloadTrack, selectDownloadFolder } from '@/services/api'\nimport { useAppSettings } from '@/hooks/useAppSettings'"

if replace_text(batch_path, old_import, new_import):
    print("[OK] Added useAppSettings import")
else:
    print("[FAIL] useAppSettings import")

# Add settings hook and initialize downloadDir
old_state = """  const [format, setFormat] = useState<DownloadFormat>('audio')
  const [downloadDir, setDownloadDir] = useState('')"""
new_state = """  const { settings } = useAppSettings()
  const [format, setFormat] = useState<DownloadFormat>('audio')
  const [downloadDir, setDownloadDir] = useState(settings.downloadDir || '')"""

if replace_text(batch_path, old_state, new_state):
    print("[OK] Initialized downloadDir from settings")
else:
    print("[FAIL] downloadDir init")

# Also fix the same synced check in BatchDownloadDialog
old_batch_lyric = """          if (includeLyric && lyricResult.synced) {
            lyricContent = formatLrc(lyricResult)
          }"""
new_batch_lyric = """          if (includeLyric && lyricResult.lines.length > 0) {
            lyricContent = formatLrc(lyricResult)
          }"""

if replace_text(batch_path, old_batch_lyric, new_batch_lyric):
    print("[OK] Removed synced check in BatchDownloadDialog")
else:
    print("[FAIL] BatchDownloadDialog lyric check")

print("\n=== Part 1 done ===")

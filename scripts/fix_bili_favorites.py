#!/usr/bin/env python3
"""
Add batch download + export to playlist in BiliFavorites.tsx
"""

def read_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def write_file(path, content):
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

path = r'N:\播放器\BiliMusic\src\pages\BiliFavorites.tsx'

# 1. Add Download and ListPlus icons to lucide import
old_icons = "import { Play, RefreshCw, Loader2, FolderHeart, Check, ChevronDown } from 'lucide-react'"
new_icons = "import { Play, RefreshCw, Loader2, FolderHeart, Check, ChevronDown, Download, ListPlus } from 'lucide-react'"
if replace_text(path, old_icons, new_icons):
    print("[OK] Added Download and ListPlus icons")
else:
    print("[FAIL] icons import")

# 2. Add imports for BatchDownloadDialog, createPlaylist, addTrackToPlaylist
old_import_block = """import type { Track } from '@/types'
import type { FavoriteFolder, FavoriteItem } from '@/services/bilibiliApi'"""

new_import_block = """import type { Track } from '@/types'
import type { FavoriteFolder, FavoriteItem } from '@/services/bilibiliApi'
import BatchDownloadDialog from '@/components/BatchDownloadDialog'
import { createPlaylist, addTrackToPlaylist, PLAYLISTS_CHANGED_EVENT } from '@/utils/storage'"""

if replace_text(path, old_import_block, new_import_block):
    print("[OK] Added BatchDownloadDialog and playlist imports")
else:
    print("[FAIL] imports")

# 3. Add state for batch download and export
old_state = """  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false)"""
new_state = """  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false)
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [exportMessage, setExportMessage] = useState('')"""

if replace_text(path, old_state, new_state):
    print("[OK] Added batch download and export state")
else:
    print("[FAIL] state")

# 4. Add export to playlist handler after handleImport
old_handle_import_end = """  const handlePlayAll = () => {
    if (tracks.length > 0) player.playAll(tracks)
  }"""

new_handle_import_end = """  const handleExportToPlaylist = () => {
    if (!tracks.length || !selectedFolderInfo) return
    const playlist = createPlaylist({
      name: selectedFolderInfo.title,
      description: `从 B站收藏夹导入 · ${new Date().toLocaleDateString()}`,
      coverUrl: tracks[0]?.coverUrl || '',
    })
    for (const track of tracks) {
      addTrackToPlaylist(playlist.id, track)
    }
    window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED_EVENT))
    setExportMessage(`已导出 ${tracks.length} 首到歌单「${selectedFolderInfo.title}」`)
    setTimeout(() => setExportMessage(''), 4000)
  }

  const handlePlayAll = () => {
    if (tracks.length > 0) player.playAll(tracks)
  }"""

if replace_text(path, old_handle_import_end, new_handle_import_end):
    print("[OK] Added export to playlist handler")
else:
    print("[FAIL] export handler")

# 5. Add batch download + export buttons in the action area
# Find the play all button and add batch download + export before it
old_play_all = """            {tracks.length > 0 && (
              <ActionButton onClick={handlePlayAll}>
                <Play size={16} fill="currentColor" />
                播放全部
              </ActionButton>
            )}"""

new_play_all = """            {tracks.length > 0 && (
              <>
                <ActionButton tone="subtle" onClick={() => setBatchDownloading(true)}>
                  <Download size={15} />
                  下载全部
                </ActionButton>
                <ActionButton tone="subtle" onClick={handleExportToPlaylist}>
                  <ListPlus size={15} />
                  导出为歌单
                </ActionButton>
                <ActionButton onClick={handlePlayAll}>
                  <Play size={16} fill="currentColor" />
                  播放全部
                </ActionButton>
              </>
            )}"""

if replace_text(path, old_play_all, new_play_all):
    print("[OK] Added batch download and export buttons")
else:
    print("[FAIL] action buttons")

# 6. Add export message display after syncMessage
old_sync_msg = """      {syncMessage && (
        <div style={{
          margin: '0 24px 12px',
          padding: '10px 16px',
          borderRadius: 12,
          background: 'var(--glass-bg)',
          color: 'var(--color-foreground)',
          fontSize: 13,
        }}>
          {syncMessage}
        </div>
      )}"""

new_sync_msg = """      {syncMessage && (
        <div style={{
          margin: '0 24px 12px',
          padding: '10px 16px',
          borderRadius: 12,
          background: 'var(--glass-bg)',
          color: 'var(--color-foreground)',
          fontSize: 13,
        }}>
          {syncMessage}
        </div>
      )}

      {exportMessage && (
        <div style={{
          margin: '0 24px 12px',
          padding: '10px 16px',
          borderRadius: 12,
          background: 'rgba(48, 209, 88, 0.12)',
          color: '#30d158',
          fontSize: 13,
        }}>
          {exportMessage}
        </div>
      )}"""

if replace_text(path, old_sync_msg, new_sync_msg):
    print("[OK] Added export message display")
else:
    print("[FAIL] export message")

# 7. Add BatchDownloadDialog before closing MusicPageShell
# Find the last </MusicPageShell> in the file
content = read_file(path)
old_close = "    </MusicPageShell>\n  )\n}"
old_close_crlf = old_close.replace('\n', '\r\n')

# Find last occurrence
if old_close_crlf in content:
    matches = list(re.finditer(re.escape(old_close_crlf), content))
elif old_close in content:
    matches = list(re.finditer(re.escape(old_close), content))
    old_close_crlf = old_close
else:
    matches = []
    print("[FAIL] Could not find closing tag")

if matches:
    last_match = matches[-1]
    new_close = """      {batchDownloading && (
        <BatchDownloadDialog
          tracks={tracks}
          onClose={() => setBatchDownloading(false)}
        />
      )}
    </MusicPageShell>
  )
}"""
    new_close_crlf = new_close.replace('\n', '\r\n')
    content = content[:last_match.start()] + new_close_crlf + content[last_match.end():]
    write_file(path, content)
    print("[OK] Added BatchDownloadDialog before closing tag")

print("\nDone!")

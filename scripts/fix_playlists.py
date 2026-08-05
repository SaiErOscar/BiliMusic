#!/usr/bin/env python3
"""Add batch download button to Playlists.tsx PlaylistDetail"""

path = r'N:\播放器\BiliMusic\src\pages\Playlists.tsx'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add import for BatchDownloadDialog and Download icon
old_import = """import { CheckSquare, ListMusic, Music, Play, Square, Trash2, X, FolderHeart } from 'lucide-react'"""
new_import = """import { CheckSquare, ListMusic, Music, Play, Square, Trash2, X, FolderHeart, Download } from 'lucide-react'"""

old_crlf = old_import.replace('\n', '\r\n')
new_crlf = new_import.replace('\n', '\r\n')
if old_crlf in content:
    content = content.replace(old_crlf, new_crlf)
    print("[OK] Updated lucide import")
elif old_import in content:
    content = content.replace(old_import, new_import)
    print("[OK] Updated lucide import (LF)")
else:
    print("[FAIL] Could not find lucide import")

# 2. Add import for BatchDownloadDialog after AddToPlaylistButton import
old_import2 = "import AddToPlaylistButton from '@/components/AddToPlaylistButton'"
new_import2 = "import AddToPlaylistButton from '@/components/AddToPlaylistButton'\nimport BatchDownloadDialog from '@/components/BatchDownloadDialog'"

old2_crlf = old_import2.replace('\n', '\r\n')
new2_crlf = new_import2.replace('\n', '\r\n')
if old2_crlf in content:
    content = content.replace(old2_crlf, new2_crlf, 1)
    print("[OK] Added BatchDownloadDialog import")
elif old_import2 in content:
    content = content.replace(old_import2, new_import2, 1)
    print("[OK] Added BatchDownloadDialog import (LF)")
else:
    print("[FAIL] Could not find AddToPlaylistButton import")

# 3. Add state for batch download dialog in PlaylistDetail
old_state = """  const [editing, setEditing] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())"""

new_state = """  const [editing, setEditing] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchDownloading, setBatchDownloading] = useState(false)"""

old3_crlf = old_state.replace('\n', '\r\n')
new3_crlf = new_state.replace('\n', '\r\n')
if old3_crlf in content:
    content = content.replace(old3_crlf, new3_crlf, 1)
    print("[OK] Added batchDownloading state")
elif old_state in content:
    content = content.replace(old_state, new_state, 1)
    print("[OK] Added batchDownloading state (LF)")
else:
    print("[FAIL] Could not find state declarations")

# 4. Add batch download button in the action area (after 播放全部 button)
old_action = """            {tracks.length > 0 && (
              <button className="am-action am-action--primary" onClick={() => player.playAll(tracks)}>
                <Play size={17} fill="currentColor" />
                播放全部
              </button>
            )}"""

new_action = """            {tracks.length > 0 && (
              <>
                <button className="am-action am-action--primary" onClick={() => player.playAll(tracks)}>
                  <Play size={17} fill="currentColor" />
                  播放全部
                </button>
                <button className="am-action am-action--subtle" onClick={() => setBatchDownloading(true)}>
                  <Download size={16} />
                  下载全部
                </button>
              </>
            )}"""

old4_crlf = old_action.replace('\n', '\r\n')
new4_crlf = new_action.replace('\n', '\r\n')
if old4_crlf in content:
    content = content.replace(old4_crlf, new4_crlf, 1)
    print("[OK] Added download all button")
elif old_action in content:
    content = content.replace(old_action, new_action, 1)
    print("[OK] Added download all button (LF)")
else:
    print("[FAIL] Could not find action area")

# 5. Add BatchDownloadDialog before closing MusicPageShell in PlaylistDetail
# Find the closing </MusicPageShell> in PlaylistDetail (not PlaylistOverview)
# We'll add it right before the last </MusicPageShell> in the file
old_close = """    </MusicPageShell>
  )
}"""

new_close = """      {batchDownloading && (
        <BatchDownloadDialog
          tracks={tracks}
          onClose={() => setBatchDownloading(false)}
        />
      )}
    </MusicPageShell>
  )
}"""

old5_crlf = old_close.replace('\n', '\r\n')
new5_crlf = new_close.replace('\n', '\r\n')
# This pattern might appear multiple times, so we need to replace the LAST occurrence
# Find all occurrences
import re
matches = list(re.finditer(re.escape(old5_crlf), content))
if not matches:
    matches = list(re.finditer(re.escape(old_close), content))
    if matches:
        old5_crlf = old_close
        new5_crlf = new_close

if matches:
    # Replace the last occurrence
    last_match = matches[-1]
    content = content[:last_match.start()] + new5_crlf + content[last_match.end():]
    print("[OK] Added BatchDownloadDialog before closing tag")
else:
    print("[FAIL] Could not find closing tag")

# Write back
if '\r\n' in content:
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
else:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

print("\nDone!")

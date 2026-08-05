#!/usr/bin/env python3
"""Fix control alignment in NowPlaying.tsx and index.css"""

import re

# === 1. Fix NowPlaying.tsx: move repeat/shuffle button from center cluster to right side ===

tsx_path = r'N:\播放器\BiliMusic\src\components\NowPlaying.tsx'
with open(tsx_path, 'r', encoding='utf-8') as f:
    tsx = f.read()

# Replace the control cluster section
old_cluster = """                {/* 中间：上一首 + 播放 + 下一首 + 循环/随机 */}
                <div className="now-playing-control-cluster">
                  <RoundIcon onClick={player.prev} title="上一首">
                    <SkipBack size={27} />
                  </RoundIcon>
                  <motion.button
                    type="button"
                    className="now-playing-play"
                    onClick={player.togglePlay}
                    disabled={player.loadingAudio}
                    whileHover={{ scale: player.loadingAudio ? 1 : 1.045 }}
                    whileTap={{ scale: player.loadingAudio ? 1 : 0.94 }}
                  >
                    {player.loadingAudio
                      ? <Loader2 size={27} className="spin" />
                      : player.isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" style={{ marginLeft: 3 }} />}
                  </motion.button>
                  <RoundIcon onClick={player.next} title="下一首">
                    <SkipForward size={27} />
                  </RoundIcon>
                  <RoundIcon
                    active={player.repeatMode !== 'none'}
                    onClick={() => {
                      const modes = ['none', 'all', 'one', 'shuffle'] as const
                      player.setRepeatMode(modes[(modes.indexOf(player.repeatMode) + 1) % 4])
                    }}
                    title={
                      player.repeatMode === 'none' ? '顺序播放' :
                      player.repeatMode === 'all' ? '列表循环' :
                      player.repeatMode === 'one' ? '单曲循环' : '随机播放'
                    }
                  >
                    <span className="now-playing-repeat">
                      {player.repeatMode === 'shuffle' ? <Shuffle size={20} /> : <Repeat size={20} />}
                      {player.repeatMode === 'one' && <span>1</span>}
                    </span>
                  </RoundIcon>
                </div>

                {/* 右侧：评论按钮 */}
                <div className="now-playing-controls-right">
                  <RoundIcon active={commentsOpen} onClick={toggleComments} title="查看评论">
                    <MessageCircle size={20} />
                  </RoundIcon>
                </div>"""

new_cluster = """                {/* 中间：上一首 + 播放 + 下一首（对称布局） */}
                <div className="now-playing-control-cluster">
                  <RoundIcon onClick={player.prev} title="上一首">
                    <SkipBack size={27} />
                  </RoundIcon>
                  <motion.button
                    type="button"
                    className="now-playing-play"
                    onClick={player.togglePlay}
                    disabled={player.loadingAudio}
                    whileHover={{ scale: player.loadingAudio ? 1 : 1.045 }}
                    whileTap={{ scale: player.loadingAudio ? 1 : 0.94 }}
                  >
                    {player.loadingAudio
                      ? <Loader2 size={27} className="spin" />
                      : player.isPlaying ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" style={{ marginLeft: 3 }} />}
                  </motion.button>
                  <RoundIcon onClick={player.next} title="下一首">
                    <SkipForward size={27} />
                  </RoundIcon>
                </div>

                {/* 右侧：循环/随机 + 评论按钮 */}
                <div className="now-playing-controls-right">
                  <RoundIcon
                    active={player.repeatMode !== 'none'}
                    onClick={() => {
                      const modes = ['none', 'all', 'one', 'shuffle'] as const
                      player.setRepeatMode(modes[(modes.indexOf(player.repeatMode) + 1) % 4])
                    }}
                    title={
                      player.repeatMode === 'none' ? '顺序播放' :
                      player.repeatMode === 'all' ? '列表循环' :
                      player.repeatMode === 'one' ? '单曲循环' : '随机播放'
                    }
                  >
                    <span className="now-playing-repeat">
                      {player.repeatMode === 'shuffle' ? <Shuffle size={20} /> : <Repeat size={20} />}
                      {player.repeatMode === 'one' && <span>1</span>}
                    </span>
                  </RoundIcon>
                  <RoundIcon active={commentsOpen} onClick={toggleComments} title="查看评论">
                    <MessageCircle size={20} />
                  </RoundIcon>
                </div>"""

# Normalize line endings for matching
old_cluster_crlf = old_cluster.replace('\n', '\r\n')
new_cluster_crlf = new_cluster.replace('\n', '\r\n')

if old_cluster_crlf in tsx:
    tsx = tsx.replace(old_cluster_crlf, new_cluster_crlf)
    print("[OK] NowPlaying.tsx: control cluster restructured")
elif old_cluster in tsx:
    tsx = tsx.replace(old_cluster, new_cluster)
    print("[OK] NowPlaying.tsx: control cluster restructured (LF match)")
else:
    print("[FAIL] NowPlaying.tsx: could not find old cluster text")
    # Try to find a subset to debug
    test = "上一首 + 播放 + 下一首 + 循环/随机"
    if test in tsx:
        print(f"  Found comment at index {tsx.index(test)}")
    else:
        print("  Comment not found either")

with open(tsx_path, 'w', encoding='utf-8', newline='\r\n') as f:
    f.write(tsx)

# === 2. Fix index.css: symmetric grid columns ===

css_path = r'N:\播放器\BiliMusic\src\styles\index.css'
with open(css_path, 'r', encoding='utf-8') as f:
    css = f.read()

# Fix grid-template-columns: 4 columns -> 3 columns (symmetric)
old_grid = "grid-template-columns: 54px 78px 54px 46px;"
new_grid = "grid-template-columns: 46px 70px 46px;"

old_grid_crlf = old_grid
new_grid_crlf = new_grid

if old_grid_crlf in css:
    css = css.replace(old_grid_crlf, new_grid_crlf)
    print("[OK] index.css: grid-template-columns fixed to 3-column symmetric layout")
else:
    print("[FAIL] index.css: could not find old grid-template-columns")

with open(css_path, 'w', encoding='utf-8', newline='\r\n') as f:
    f.write(css)

print("\nDone!")

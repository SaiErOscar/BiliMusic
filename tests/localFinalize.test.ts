// v1.4.16-pre3 本地音乐收口（三）：收藏入口 / 备份含本地索引 / 淡出中止
//
// 三处改动都落在既有模块里，且各自有一个「看起来对、实际会坏」的反向场景，
// 所以这里逐条给出正向与反向断言——只验正向的话，退回旧实现仍然会绿。
import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { applyBackup, collectBackup, type BackupPayload } from '../src/utils/backup'
import { loadFavoriteTracks, loadLocalDirs, loadLocalTracks, saveFavoriteTracks, saveLocalDirs, saveLocalTracks } from '../src/utils/storage'
import type { Track } from '../src/types'

function track(id: string, localPath?: string): Track {
  return {
    id,
    title: id,
    artist: 'x',
    coverUrl: '',
    duration: 1,
    videoUrl: '',
    bvid: '',
    playCount: 0,
    ...(localPath ? { localPath } : {}),
  }
}

function payload(over: Partial<BackupPayload> = {}): BackupPayload {
  return {
    app: 'biliMusic',
    type: 'backup',
    formatVersion: 1,
    exportedAt: '2026-11-20T00:00:00.000Z',
    account: null,
    playlists: [],
    playlistTombstones: [],
    favorites: [],
    favoriteTombstones: [],
    recent: [],
    downloads: [],
    lyricOffsets: {},
    settings: {} as BackupPayload['settings'],
    theme: 'dark',
    ...over,
  }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

beforeEach(() => localStorage.clear())

/*
 * 一、收藏入口
 *
 * 本地页此前没有收藏入口。补入口的同时发现 PlayerContext.toggleLike 的
 * 取曲目逻辑是 `queue.find(...) || currentTrack`——队列里找不到就落到
 * **正在播的另一首歌**上，于是「收藏这首」实际收藏了那首。
 */
describe('收藏：能定位到目标曲目，且不误伤正在播放的曲目', () => {
  const player = read('src/contexts/PlayerContext.tsx')

  it('toggleLike 不再把 currentTrack 当作无条件兜底', () => {
    // 旧写法：queue.find(...) || currentTrack
    expect(player).not.toMatch(/queue\.find\(t => t\.id === trackId\) \|\| currentTrack\b(?!\s*&&)/)
  })

  it('toggleLike 接受可选的 track 参数，供列表页直接传入', () => {
    expect(player).toMatch(/toggleLike: \(trackId: string, track\?: Track\) => void/)
    expect(player).toMatch(/const toggleLike = useCallback\(\(trackId: string, track\?: Track\)/)
  })

  it('解析不到队列/当前曲目时回落到收藏库，而不是静默不落盘', () => {
    expect(player).toMatch(/loadFavoriteTracks\(\)\.find\(t => t\.id === trackId\)/)
  })

  it('本地页行内确实渲染了收藏按钮并传入 track', () => {
    const page = read('src/pages/LocalMusic.tsx')
    expect(page).toMatch(/player\.toggleLike\(track\.id, track\)/)
    // 必须 stopPropagation，否则点收藏会同时触发行点击播放
    expect(page).toMatch(/e\.stopPropagation\(\); player\.toggleLike/)
  })

  it('本地页监听收藏变更事件，按钮点亮后图标会跟着变', () => {
    const page = read('src/pages/LocalMusic.tsx')
    expect(page).toMatch(/FAVORITES_CHANGED_EVENT/)
    expect(page).toMatch(/addEventListener\(FAVORITES_CHANGED_EVENT/)
  })

  it('反向：本地页的收藏按钮不依赖 extra 里的「已丢失」分支存在', () => {
    // 旧实现里 extra 只在文件丢失时才有值，收藏按钮若挂在那个三元里就只在丢失时出现
    const page = read('src/pages/LocalMusic.tsx')
    expect(page).not.toMatch(/extra=\{\s*track\.localPath && missingPaths\.has/)
  })
})

/*
 * 二、备份包含本地索引
 *
 * 备份此前不含 bilimusic_local_tracks / local_dirs。跨机恢复后歌单与我喜欢
 * 里带 localPath 的条目指向不存在的路径，本地页整块是空的。
 */
describe('备份：本地音乐索引随备份往返', () => {
  it('collectBackup 收集了本地曲库与目录', async () => {
    saveLocalTracks([track('local_a', 'D:/m/a.mp3')])
    saveLocalDirs(['D:/m'])
    const p = await collectBackup()
    expect(p.localTracks).toHaveLength(1)
    expect(p.localTracks?.[0].localPath).toBe('D:/m/a.mp3')
    expect(p.localDirs).toEqual(['D:/m'])
  })

  it('applyBackup 把本地索引按 localPath 并集合并进来', () => {
    saveLocalTracks([track('local_a', 'D:/m/a.mp3')])
    saveLocalDirs(['D:/m'])
    const r = applyBackup(payload({
      localTracks: [track('local_a', 'D:/m/a.mp3'), track('local_b', 'E:/m/b.flac')],
      localDirs: ['E:/m'],
    }))
    const merged = loadLocalTracks()
    expect(merged.map(t => t.localPath).sort()).toEqual(['D:/m/a.mp3', 'E:/m/b.flac'])
    expect(loadLocalDirs().sort()).toEqual(['D:/m', 'E:/m'])
    expect(r.localTracks).toBe(2)
  })

  it('反向：旧备份（无 localTracks 字段）不会清空本机已有的本地曲库', () => {
    saveLocalTracks([track('local_a', 'D:/m/a.mp3')])
    const r = applyBackup(payload())
    expect(loadLocalTracks()).toHaveLength(1)
    // 没有本地索引的备份不应把计数报成 0 而让界面显示「本地曲库 0」
    expect(r.localTracks).toBe(0)
  })

  it('反向：同路径条目以本机为准，不被备份里的旧元数据覆盖', () => {
    saveLocalTracks([{ ...track('local_a', 'D:/m/a.mp3'), title: '本机标题' }])
    applyBackup(payload({ localTracks: [{ ...track('local_a', 'D:/m/a.mp3'), title: '备份标题' }] }))
    expect(loadLocalTracks()[0].title).toBe('本机标题')
  })

  it('反向：路径大小写不同视为同一首（Windows 下同一文件）', () => {
    saveLocalTracks([track('local_a', 'D:/Music/A.mp3')])
    applyBackup(payload({ localTracks: [track('local_a2', 'd:/music/a.mp3')] }))
    expect(loadLocalTracks()).toHaveLength(1)
  })
})

/*
 * 三、cancelCrossfade 接线
 *
 * 该函数导出后无人调用。它不是纯死代码：runCrossfade 在
 * 「淡出 → delay → swap」之间没有任何外部取消入口，清空队列时
 * 进行中的 swap 仍会执行，把 src 写回一个已被清空的播放器。
 */
describe('淡出中止：清空队列与卸载时作废进行中的淡出', () => {
  const player = read('src/contexts/PlayerContext.tsx')

  it('cancelCrossfade 已被导入并真的被调用', () => {
    expect(player).toMatch(/cancelCrossfade,/)
    const calls = player.match(/^\s*cancelCrossfade\(\)$/gm) || []
    // 清空队列 + 卸载清理，两处
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('clearQueue 里先作废淡出再清空队列', () => {
    const idx = player.indexOf('const clearQueue = useCallback')
    expect(idx).toBeGreaterThan(-1)
    const body = player.slice(idx, idx + 900)
    expect(body).toMatch(/cancelCrossfade\(\)/)
    // 顺序：必须早于 setQueue([])
    expect(body.indexOf('cancelCrossfade()')).toBeLessThan(body.indexOf('setQueue([])'))
  })

  it('卸载清理里在 disposeAudioGraph 之前作废淡出', () => {
    const idx = player.indexOf('disposeAudioGraph()\n      audioGraphAttachedRef.current = false')
    expect(idx).toBeGreaterThan(-1)
    const before = player.slice(Math.max(0, idx - 300), idx)
    expect(before).toMatch(/cancelCrossfade\(\)/)
  })
})

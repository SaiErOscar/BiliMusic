// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  executeAssistantAction,
  otaManifestUrl,
  releaseBaseFor,
} from '../src/services/assistantExecutor'
import type { ExecuteContext, ExecutorDeps } from '../src/services/assistantExecutor'
import { ASSISTANT_ACTIONS, getAssistantAction } from '../src/services/assistantActions'
import { CREATE_PLAYLIST_KEY } from '../src/services/assistantSession'
import {
  DEFAULT_APP_SETTINGS,
  createPlaylist,
  loadAppSettings,
  loadFavoriteTracks,
  loadPlaylists,
} from '../src/utils/storage'
import type { Track } from '../src/types'

/**
 * v1.4.14-pre9 动作执行器。
 *
 * 全部离线：搜索 / 下载 / MV 导出 / 版本读取都通过 deps 注入桩，
 * 因此测试断言的是「执行器的分发与副作用」，不是网络行为。
 */

const TRACK: Track = {
  id: 'BV1aa411c7mD',
  title: '夜跑',
  artist: '某UP主',
  coverUrl: 'https://example.com/a.jpg',
  duration: 180,
  videoUrl: 'https://www.bilibili.com/video/BV1aa411c7mD',
  bvid: 'BV1aa411c7mD',
  playCount: 1,
  isLiked: false,
}

const OTHER_TRACK: Track = {
  ...TRACK,
  id: 'BV1bb411c7mE',
  title: '写作业',
  bvid: 'BV1bb411c7mE',
  videoUrl: 'https://www.bilibili.com/video/BV1bb411c7mE',
}

/** 数值型设置项各自落在合法区间内的样例值（遍历覆盖测试用） */
const NUMBER_SAMPLE: Record<string, number> = {
  lyricFontSize: 30,
  lyricFontWeight: 700,
  playbackRate: 1.5,
}

/** 最小播放器桩：只记录被调了什么 */
function makePlayer() {
  return {
    calls: [] as string[],
    currentTrack: null as Track | null,
    isPlaying: false,
    queue: [] as Track[],
    play(track: Track) { this.calls.push('play:' + track.id) },
    pause() { this.calls.push('pause') },
    togglePlay() { this.calls.push('togglePlay') },
    next() { this.calls.push('next') },
    prev() { this.calls.push('prev') },
    setVolume(v: number) { this.calls.push('setVolume:' + v) },
    setRepeatMode(m: string) { this.calls.push('setRepeatMode:' + m) },
    setPlaybackRate(r: number) { this.calls.push('setPlaybackRate:' + r) },
    setProgress(p: number) { this.calls.push('setProgress:' + p) },
  }
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): Partial<ExecutorDeps> {
  return {
    searchVideo: vi.fn(async () => ({
      items: [{ bvid: TRACK.bvid, aid: 1, title: TRACK.title, author: TRACK.artist, play: 1, duration: '3:00', pic: TRACK.coverUrl }],
      totalPages: 1,
      totalResults: 1,
    })),
    downloadTrack: vi.fn(async () => ({ filePath: 'I:/dl/a.m4a', size: 1024 * 1024 })),
    exportTrackMv: vi.fn(async () => ({ filePath: 'I:/dl/mv.mp4' })),
    getAppVersion: vi.fn(async () => '1.4.14-pre9'),
    fetchRemoteVersion: vi.fn(async () => '1.4.14-pre9'),
    ...overrides,
  }
}

function ctx(player: ReturnType<typeof makePlayer>, overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    player,
    playlists: loadPlaylists().map(p => ({ id: p.id, name: p.name })),
    currentTrack: player.currentTrack
      ? { title: player.currentTrack.title, artist: player.currentTrack.artist, bvid: player.currentTrack.bvid }
      : null,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
})

/* ================= 1. 全覆盖：59 个动作都有执行分支 ================= */

describe('动作覆盖：注册表里每个动作都能被执行', () => {
  it('注册表确实是 59 条，confirm 恰好 2 条', () => {
    expect(ASSISTANT_ACTIONS.length).toBe(59)
    const confirmIds = ASSISTANT_ACTIONS.filter(a => a.risk === 'confirm').map(a => a.id)
    expect(confirmIds.sort()).toEqual(['export.mv-single', 'playlist.delete'])
  })

  /**
   * 给每个动作造一份「足够齐」的参数：按注册表里的 param 类型填合法值。
   * 这样遍历不依赖手写 56 份参数，将来加动作也自动被覆盖。
   */
  function paramsFor(actionId: string): Record<string, unknown> {
    const action = getAssistantAction(actionId)
    if (!action) throw new Error('missing action ' + actionId)
    const params: Record<string, unknown> = {}
    for (const spec of action.params) {
      if (spec.type === 'boolean') params[spec.name] = true
      else if (spec.type === 'number') params[spec.name] = NUMBER_SAMPLE[spec.name] ?? 50
      else if (spec.type === 'enum') params[spec.name] = spec.options?.[0].value ?? ''
      else if (spec.type === 'playlist') params[spec.name] = 'p-test'
      else if (spec.type === 'track') params[spec.name] = TRACK.title
      else params[spec.name] = spec.name === 'position' ? '1:30' : '1'
    }
    // 颜色/目录/倍速这类有格式或区间要求的，用合法值覆盖
    if (actionId === 'settings.set-lyricTextColor') params.lyricTextColor = '#ffffff'
    if (actionId === 'settings.set-lyricControlColor') params.lyricControlColor = '#ff375f'
    if (actionId === 'settings.set-downloadDir') params.downloadDir = 'I:/dl'
    if (actionId === 'settings.set-playbackRate') params.playbackRate = 1.5
    return params
  }

  it('每个 id 都返回 ExecuteResult，且不抛异常', async () => {
    createPlaylist({ name: '测试歌单' })
    const player = makePlayer()
    player.currentTrack = TRACK
    player.queue = [TRACK]
    const base = ctx(player)
    const playlistId = loadPlaylists()[0].id

    for (const action of ASSISTANT_ACTIONS) {
      const params = paramsFor(action.id)
      // 歌单参数用真实存在的 id，避免「没找到歌单」把覆盖测试变成误报
      if (params.playlist !== undefined) params.playlist = playlistId

      const result = await executeAssistantAction(action.id, params, base, {
        confirmed: true,
        deps: makeDeps(),
      })

      expect(result, action.id).toBeTypeOf('object')
      expect(typeof result.ok, action.id).toBe('boolean')
      expect(typeof result.message, action.id).toBe('string')
      expect(result.message.length, action.id).toBeGreaterThan(0)
      // 每个分支都必须有执行逻辑：不能落进「还没有接上执行逻辑」
      expect(result.message, action.id).not.toContain('还没有接上执行逻辑')
      expect(result.message, action.id).not.toContain('不认识')
    }
  })

  it('settings 的 36 个字段全部命中：可设置的 31 条成功，5 条只读字段给出可读拒绝', async () => {
    const settingsActions = ASSISTANT_ACTIONS.filter(a => a.group === 'settings')
    expect(settingsActions.length).toBe(36)

    const base = ctx(makePlayer())
    const writable: string[] = []
    const readonly: string[] = []

    for (const action of settingsActions) {
      const params = paramsFor(action.id)
      const result = await executeAssistantAction(action.id, params, base, { deps: makeDeps() })
      if (action.params.length === 0) {
        readonly.push(action.id)
        expect(result.ok, action.id).toBe(false)
        expect(result.message, action.id).toContain('不能在对话里设置')
      } else {
        writable.push(action.id)
        expect(result.ok, action.id + ': ' + result.message).toBe(true)
      }
    }

    expect(writable.length).toBe(31)
    expect(readonly.sort()).toEqual([
      'settings.set-autoLyricControlColor',
      'settings.set-autoLyricTextColor',
      'settings.set-equalizer',
      'settings.set-lyricPresets',
      'settings.set-themeSeedOverride',
    ])
  })
})

/* ================= 2. confirm 动作 ================= */

describe('风险分级：confirm 动作未确认时不执行', () => {
  it('playlist.delete 未确认：返回 needsConfirm，歌单原封不动', async () => {
    const created = createPlaylist({ name: '别删我' })
    const deps = makeDeps()

    const result = await executeAssistantAction('playlist.delete', { playlist: created.id }, ctx(makePlayer()), { deps })

    expect(result.ok).toBe(false)
    expect(result.needsConfirm).toBe(true)
    expect(result.message).toContain('别删我')
    expect(loadPlaylists().some(p => p.id === created.id)).toBe(true)
  })

  it('playlist.delete 确认后真的删除', async () => {
    const created = createPlaylist({ name: '删掉吧' })
    const result = await executeAssistantAction(
      'playlist.delete',
      { playlist: created.id },
      ctx(makePlayer()),
      { confirmed: true, deps: makeDeps() },
    )
    expect(result.ok).toBe(true)
    expect(loadPlaylists().some(p => p.id === created.id)).toBe(false)
  })

  it('export.mv-single 未确认：不调用导出，返回 needsConfirm', async () => {
    const deps = makeDeps()
    const player = makePlayer()
    player.currentTrack = TRACK

    const result = await executeAssistantAction('export.mv-single', {}, ctx(player), { deps })

    expect(result.ok).toBe(false)
    expect(result.needsConfirm).toBe(true)
    expect(result.message).toContain('夜跑')
    expect(deps.exportTrackMv).not.toHaveBeenCalled()
  })

  it('export.mv-single 确认后调用导出并回报文件路径', async () => {
    const deps = makeDeps()
    const player = makePlayer()
    player.currentTrack = TRACK

    const result = await executeAssistantAction('export.mv-single', {}, ctx(player), { confirmed: true, deps })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('mv.mp4')
    expect(deps.exportTrackMv).toHaveBeenCalledTimes(1)
  })

  it('confirmed=false 与不传等价，都不执行', async () => {
    const created = createPlaylist({ name: '还是别删' })
    const result = await executeAssistantAction(
      'playlist.delete',
      { playlist: created.id },
      ctx(makePlayer()),
      { confirmed: false, deps: makeDeps() },
    )
    expect(result.needsConfirm).toBe(true)
    expect(loadPlaylists().some(p => p.id === created.id)).toBe(true)
  })

  it('safe 动作不因为缺 confirmed 而被拦下', async () => {
    const player = makePlayer()
    const result = await executeAssistantAction('playback.next', {}, ctx(player), { deps: makeDeps() })
    expect(result.ok).toBe(true)
    expect(player.calls).toContain('next')
  })
})

/* ================= 3. CREATE_PLAYLIST_KEY ================= */

describe('CREATE_PLAYLIST_KEY：先建歌单再放歌', () => {
  it('标记为 true 时把 params.playlist 当名字新建，再把歌放进去', async () => {
    const player = makePlayer()
    expect(loadPlaylists()).toHaveLength(0)

    const result = await executeAssistantAction(
      'playlist.add-track',
      { track: TRACK.title, playlist: '夜跑专用', [CREATE_PLAYLIST_KEY]: true },
      ctx(player),
      { deps: makeDeps() },
    )

    expect(result.ok).toBe(true)
    expect(result.message).toContain('夜跑专用')

    const playlists = loadPlaylists()
    expect(playlists).toHaveLength(1)
    expect(playlists[0].name).toBe('夜跑专用')
    expect(playlists[0].tracks.map(t => t.id)).toEqual([TRACK.id])
  })

  it('没有标记时不会新建，歌单名不存在就报错', async () => {
    const result = await executeAssistantAction(
      'playlist.add-track',
      { track: TRACK.title, playlist: '根本不存在的歌单' },
      ctx(makePlayer()),
      { deps: makeDeps() },
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('没找到歌单')
    expect(loadPlaylists()).toHaveLength(0)
  })

  it('标记为 true 但歌单名已存在时，新建一个同名歌单（不静默复用）', async () => {
    const existing = createPlaylist({ name: '夜跑专用' })
    const result = await executeAssistantAction(
      'playlist.add-track',
      { track: TRACK.title, playlist: '夜跑专用', [CREATE_PLAYLIST_KEY]: true },
      ctx(makePlayer()),
      { deps: makeDeps() },
    )

    expect(result.ok).toBe(true)
    const playlists = loadPlaylists()
    expect(playlists).toHaveLength(2)
    expect(playlists[0].id).not.toBe(existing.id)
  })

  it('rename / delete 不接受 CREATE_PLAYLIST_KEY，避免误建空歌单', async () => {
    const result = await executeAssistantAction(
      'playlist.rename',
      { playlist: '临时', name: '新名字', [CREATE_PLAYLIST_KEY]: true },
      ctx(makePlayer()),
      { deps: makeDeps() },
    )

    expect(result.ok).toBe(false)
    expect(result.message).toContain('还不存在')
    expect(loadPlaylists()).toHaveLength(0)
  })
})

/* ================= 4. check-version 只读 ================= */

describe('system.check-version：只读，绝不触发更新', () => {
  it('远端更高时回报有新版本，但不调用任何更新接口', async () => {
    const getAppVersion = vi.fn(async () => '1.4.14-pre9')
    const fetchRemoteVersion = vi.fn(async () => '1.4.14-pre10')

    const result = await executeAssistantAction('system.check-version', {}, ctx(makePlayer()), {
      deps: makeDeps({ getAppVersion, fetchRemoteVersion }),
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('1.4.14-pre10')
    expect(result.message).toContain('只查不升')
    // 只读：只发一次清单查询，不下载、不安装、不重启
    expect(fetchRemoteVersion).toHaveBeenCalledTimes(1)
    expect(result.message).not.toContain('已开始下载')
  })

  it('版本相同报告已是最新', async () => {
    const result = await executeAssistantAction('system.check-version', {}, ctx(makePlayer()), {
      deps: makeDeps({ getAppVersion: async () => '1.4.14-pre9', fetchRemoteVersion: async () => '1.4.14-pre9' }),
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('已是最新版')
  })

  it('拿不到远端时返回「无法确认」，不误报为最新', async () => {
    const result = await executeAssistantAction('system.check-version', {}, ctx(makePlayer()), {
      deps: makeDeps({ fetchRemoteVersion: async () => null }),
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法确认')
    expect(result.message).not.toContain('已是最新版')
  })

  it('拿不到当前版本时同样返回「无法确认」', async () => {
    const result = await executeAssistantAction('system.check-version', {}, ctx(makePlayer()), {
      deps: makeDeps({ getAppVersion: async () => null }),
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法确认')
  })

  it('清单地址与主进程同规则：预览版锁 tag，正式版走 latest', () => {
    expect(releaseBaseFor('1.4.14-pre9')).toBe(
      'https://github.com/SaiErOscar/BiliMusic/releases/download/v1.4.14-pre9',
    )
    expect(releaseBaseFor('1.4.13')).toBe(
      'https://github.com/SaiErOscar/BiliMusic/releases/latest/download',
    )
    expect(otaManifestUrl('1.4.13')).toBe(
      'https://github.com/SaiErOscar/BiliMusic/releases/latest/download/ota.json',
    )
  })
})

/* ================= 5. 失败可读，不抛裸 Error ================= */

describe('失败路径：返回可读中文而不是抛异常', () => {
  it('未知动作 id 返回可读提示', async () => {
    const result = await executeAssistantAction('nope.nothing', {}, ctx(makePlayer()), { deps: makeDeps() })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.message).toContain('不认识')
  })

  it('下载抛错时被收成可读中文，而不是冒泡', async () => {
    const player = makePlayer()
    player.currentTrack = TRACK
    const deps = makeDeps({
      downloadTrack: vi.fn(async () => { throw new Error('磁盘满了') }),
    })

    const result = await executeAssistantAction('download.track', {}, ctx(player), { deps })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('磁盘满了')
    expect(result.message).toContain('下载歌曲')
    expect(result.message).toContain('磁盘满了')
  })

  it('搜索抛错时给出可读中文', async () => {
    const deps = makeDeps({
      searchVideo: vi.fn(async () => { throw new Error('网络不通') }),
    })
    const result = await executeAssistantAction('search.video', { query: '夜跑' }, ctx(makePlayer()), { deps })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('网络不通')
  })

  it('音量越界、倍速越界、颜色格式错都返回可读中文', async () => {
    const base = ctx(makePlayer())
    const cases: [string, Record<string, unknown>, string][] = [
      ['playback.volume', { volume: 150 }, '0–100'],
      ['playback.volume', { volume: '大声点' }, '0–100'],
      ['playback.rate', { rate: 5 }, '0.5–2.0'],
      ['playback.repeat', { mode: '乱来' }, '循环模式'],
      ['playback.seek', { position: '天知道' }, '位置'],
      ['settings.set-lyricTextColor', { lyricTextColor: '红色' }, '#rrggbb'],
      ['settings.set-lyricFontSize', { lyricFontSize: 9999 }, '8–120'],
      ['playlist.create', { name: '   ' }, '名字'],
    ]
    for (const [id, params, keyword] of cases) {
      const result = await executeAssistantAction(id, params, base, { confirmed: true, deps: makeDeps() })
      expect(result.ok, id).toBe(false)
      expect(result.message, id).toContain(keyword)
    }
  })

  it('没有当前曲目时播放类动作给可读提示而不是崩', async () => {
    const result = await executeAssistantAction('playback.play', {}, ctx(makePlayer()), { deps: makeDeps() })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('还没有可播放的歌曲')
  })

  it('播放器缺能力时给出可读提示而不是 TypeError', async () => {
    const bare = { currentTrack: TRACK, isPlaying: false }
    const result = await executeAssistantAction(
      'playback.play',
      {},
      { player: bare, playlists: [], currentTrack: null },
      { deps: makeDeps() },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('播放器还没准备好')
  })
})

/* ================= 6. settings 33 个字段 ================= */

describe('settings：33 个字段都能设置', () => {
  it('AppSettings 的每个字段都有对应动作', () => {
    for (const field of Object.keys(DEFAULT_APP_SETTINGS)) {
      expect(getAssistantAction('settings.set-' + field), field).toBeDefined()
    }
  })

  it('布尔 / 数值 / 枚举 / 字符串四类都真的写进设置', async () => {
    const base = ctx(makePlayer())
    const deps = makeDeps()

    await executeAssistantAction('settings.set-autoPlay', { autoPlay: false }, base, { deps })
    expect(loadAppSettings().autoPlay).toBe(false)

    await executeAssistantAction('settings.set-lyricFontSize', { lyricFontSize: 44 }, base, { deps })
    expect(loadAppSettings().lyricFontSize).toBe(44)

    await executeAssistantAction('settings.set-playQuality', { playQuality: '无损' }, base, { deps })
    expect(loadAppSettings().playQuality).toBe('无损')

    await executeAssistantAction('settings.set-downloadDir', { downloadDir: 'D:/音乐' }, base, { deps })
    expect(loadAppSettings().downloadDir).toBe('D:/音乐')

    await executeAssistantAction('settings.set-lyricTextColor', { lyricTextColor: '#00ff88' }, base, { deps })
    expect(loadAppSettings().lyricTextColor).toBe('#00ff88')
  })

  it('枚举接受 label 也接受 value，并归一成 value', async () => {
    const base = ctx(makePlayer())
    const deps = makeDeps()
    await executeAssistantAction('settings.set-coverFit', { coverFit: '铺满裁切' }, base, { deps })
    expect(loadAppSettings().coverFit).toBe('cover')
  })

  it('布尔接受「开 / 关」这类自然语言', async () => {
    const base = ctx(makePlayer())
    const deps = makeDeps()
    await executeAssistantAction('settings.set-showLyrics', { showLyrics: '关' }, base, { deps })
    expect(loadAppSettings().showLyrics).toBe(false)
    await executeAssistantAction('settings.set-showLyrics', { showLyrics: '开' }, base, { deps })
    expect(loadAppSettings().showLyrics).toBe(true)
  })

  it('非法值不落盘：设置保持原样', async () => {
    const base = ctx(makePlayer())
    const before = loadAppSettings().playQuality
    const result = await executeAssistantAction('settings.set-playQuality', { playQuality: '超清' }, base, {
      deps: makeDeps(),
    })
    expect(result.ok).toBe(false)
    expect(loadAppSettings().playQuality).toBe(before)
  })

  it('写设置会持久化（重新读取仍是新值）', async () => {
    const base = ctx(makePlayer())
    await executeAssistantAction('settings.set-mvWatermark', { mvWatermark: false }, base, { deps: makeDeps() })
    expect(loadAppSettings().mvWatermark).toBe(false)
  })
})

/* ================= 7. 其余动作的真实副作用 ================= */

describe('播放 / 歌单 / 收藏的实际副作用', () => {
  it('playback 系列调到播放器的对应方法', async () => {
    const player = makePlayer()
    player.currentTrack = TRACK
    player.isPlaying = true
    const base = ctx(player)
    const deps = makeDeps()

    await executeAssistantAction('playback.pause', {}, base, { deps })
    await executeAssistantAction('playback.next', {}, base, { deps })
    await executeAssistantAction('playback.prev', {}, base, { deps })
    await executeAssistantAction('playback.volume', { volume: 30 }, base, { deps })
    await executeAssistantAction('playback.rate', { rate: 1.25 }, base, { deps })
    await executeAssistantAction('playback.repeat', { mode: 'one' }, base, { deps })
    await executeAssistantAction('playback.shuffle', {}, base, { deps })
    await executeAssistantAction('playback.seek', { position: '1:30' }, base, { deps })

    expect(player.calls).toEqual([
      'pause',
      'next',
      'prev',
      'setVolume:30',
      'setPlaybackRate:1.25',
      'setRepeatMode:one',
      'setRepeatMode:shuffle',
      'setProgress:90',
    ])
  })

  it('seek 支持百分比（按当前曲目时长换算）', async () => {
    const player = makePlayer()
    player.currentTrack = TRACK
    await executeAssistantAction('playback.seek', { position: '50%' }, ctx(player), { deps: makeDeps() })
    expect(player.calls).toContain('setProgress:90')
  })

  it('收藏 / 取消收藏 / 查看收藏', async () => {
    const player = makePlayer()
    player.currentTrack = TRACK
    const base = ctx(player)
    const deps = makeDeps()

    const added = await executeAssistantAction('favorite.add', {}, base, { deps })
    expect(added.ok).toBe(true)
    expect(loadFavoriteTracks().map(t => t.id)).toEqual([TRACK.id])

    const listed = await executeAssistantAction('favorite.list', {}, base, { deps })
    expect(listed.message).toContain('夜跑')

    const removed = await executeAssistantAction('favorite.remove', {}, base, { deps })
    expect(removed.ok).toBe(true)
    expect(loadFavoriteTracks()).toHaveLength(0)
  })

  it('重复收藏不产生第二条记录', async () => {
    const player = makePlayer()
    player.currentTrack = TRACK
    const base = ctx(player)
    const deps = makeDeps()
    await executeAssistantAction('favorite.add', {}, base, { deps })
    const again = await executeAssistantAction('favorite.add', {}, base, { deps })
    expect(again.ok).toBe(true)
    expect(loadFavoriteTracks()).toHaveLength(1)
  })

  it('歌单重命名 / 移除曲目 / 查看歌单', async () => {
    const created = createPlaylist({ name: '旧名' })
    const base = ctx(makePlayer())
    const deps = makeDeps()

    await executeAssistantAction('playlist.add-track', { track: TRACK, playlist: created.id }, base, { deps })
    expect(loadPlaylists()[0].tracks).toHaveLength(1)

    const renamed = await executeAssistantAction(
      'playlist.rename',
      { playlist: created.id, name: '新名' },
      base,
      { deps },
    )
    expect(renamed.ok).toBe(true)
    expect(loadPlaylists()[0].name).toBe('新名')

    const removed = await executeAssistantAction(
      'playlist.remove-track',
      { playlist: created.id, track: '夜跑' },
      base,
      { deps },
    )
    expect(removed.ok).toBe(true)
    expect(loadPlaylists()[0].tracks).toHaveLength(0)

    const listed = await executeAssistantAction('playlist.list', {}, base, { deps })
    expect(listed.message).toContain('新名')
  })

  it('下载单曲把设置里的格式/音质/目录透传下去', async () => {
    const player = makePlayer()
    player.currentTrack = TRACK
    const base = ctx(player)
    await executeAssistantAction('settings.set-downloadQuality', { downloadQuality: '无损' }, base, { deps: makeDeps() })
    await executeAssistantAction('settings.set-downloadFormat', { downloadFormat: 'video' }, base, { deps: makeDeps() })
    await executeAssistantAction('settings.set-downloadDir', { downloadDir: 'D:/音乐' }, base, { deps: makeDeps() })

    const downloadTrack = vi.fn(async () => ({ filePath: 'I:/dl/a.mp4', size: 2 * 1024 * 1024 }))
    const result = await executeAssistantAction('download.track', {}, base, { deps: makeDeps({ downloadTrack }) })

    expect(result.ok).toBe(true)
    expect(downloadTrack).toHaveBeenCalledWith(
      TRACK.bvid,
      { aid: TRACK.aid, cid: TRACK.cid },
      TRACK.title,
      'video',
      'lossless',
      'D:/音乐',
      { artist: TRACK.artist, title: TRACK.title },
    )
    expect(result.message).toContain('2.0 MB')
  })

  it('批量下载歌单逐首调用，并统计失败数', async () => {
    const created = createPlaylist({ name: '批量' })
    const base = ctx(makePlayer())
    const deps = makeDeps()
    await executeAssistantAction('playlist.add-track', { track: TRACK, playlist: created.id }, base, { deps })
    await executeAssistantAction('playlist.add-track', { track: OTHER_TRACK, playlist: created.id }, base, { deps })

    const downloadTrack = vi.fn(async (bvid: string) => {
      if (bvid === OTHER_TRACK.bvid) throw new Error('失败')
      return { filePath: 'I:/dl/a.m4a', size: 1024 }
    })
    const result = await executeAssistantAction(
      'download.playlist',
      { playlist: created.id },
      base,
      { deps: makeDeps({ downloadTrack }) },
    )

    expect(downloadTrack).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('1 首')
    expect(result.message).toContain('1 首失败')
  })

  it('空歌单批量下载给可读提示', async () => {
    const created = createPlaylist({ name: '空歌单' })
    const result = await executeAssistantAction(
      'download.playlist',
      { playlist: created.id },
      ctx(makePlayer()),
      { deps: makeDeps() },
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('还没有歌')
  })

  it('track 参数给歌名时先搜本地队列，命中就不发搜索请求', async () => {
    const player = makePlayer()
    player.queue = [TRACK]
    const searchVideo = vi.fn(async () => ({ items: [], totalPages: 0, totalResults: 0 }))
    const created = createPlaylist({ name: '本地命中' })

    const result = await executeAssistantAction(
      'playlist.add-track',
      { track: '夜跑', playlist: created.id },
      ctx(player),
      { deps: makeDeps({ searchVideo }) },
    )

    expect(result.ok).toBe(true)
    expect(searchVideo).not.toHaveBeenCalled()
    expect(loadPlaylists()[0].tracks[0].id).toBe(TRACK.id)
  })

  it('本地找不到时才搜 B站，取第一条', async () => {
    const created = createPlaylist({ name: '远端搜索' })
    const searchVideo = vi.fn(async () => ({
      items: [{ bvid: OTHER_TRACK.bvid, aid: 2, title: OTHER_TRACK.title, author: 'UP', play: 1, duration: '2:00', pic: '' }],
      totalPages: 1,
      totalResults: 1,
    }))

    const result = await executeAssistantAction(
      'playlist.add-track',
      { track: '写作业', playlist: created.id },
      ctx(makePlayer()),
      { deps: makeDeps({ searchVideo }) },
    )

    expect(result.ok).toBe(true)
    expect(searchVideo).toHaveBeenCalledTimes(1)
    expect(loadPlaylists()[0].tracks[0].bvid).toBe(OTHER_TRACK.bvid)
  })
})

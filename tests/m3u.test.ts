import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  buildImportedPlaylist,
  buildM3u,
  entryToTrack,
  extractBvid,
  parseM3u,
} from '../src/services/m3u'
import type { Playlist, Track } from '../src/types'

// electron/playlistFile.ts 用真实 electron / fs，测试里换成可控替身。
// 目的不是模拟 Electron，而是让模块能被真的 import 并跑到导出/导入的路径计算：
// electron/ 不在 tsconfig include 内，tsc 绿并不能证明主进程代码正确。
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const savedFiles: { path: string; content: string }[] = []
let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: false, filePath: 'C:/out.m3u8' }
let openDialogResult: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: ['C:/in.m3u8'] }
let readFileContent = '#EXTM3U\n'
let lastSaveOptions: { defaultPath?: string } | undefined

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  dialog: {
    showSaveDialog: async (_win: unknown, opts: { defaultPath?: string }) => {
      lastSaveOptions = opts
      return saveDialogResult
    },
    showOpenDialog: async () => openDialogResult,
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
  },
}))

vi.mock('fs', () => ({
  default: {
    writeFileSync: (target: string, content: string) => { savedFiles.push({ path: target, content }) },
    readFileSync: () => readFileContent,
  },
}))

const { registerPlaylistFileHandlers, sanitizeM3uFileName, ensureM3uExt } = await import('../electron/playlistFile')

function track(over: Partial<Track> = {}): Track {
  return {
    id: 'BV1xx411c7mD',
    title: '晴天',
    artist: '周杰伦',
    coverUrl: '',
    duration: 269,
    videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    bvid: 'BV1xx411c7mD',
    playCount: 0,
    isLiked: false,
    ...over,
  }
}

function playlist(tracks: Track[], name = '我的歌单'): Playlist {
  return { id: 'p1', name, coverUrl: '', tracks, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
}

describe('parseM3u 边界（CRLF / 裸地址 / 时长非数字 / ?p=2 / 注释 / 空行）', () => {
  it('CRLF 与 LF 混用都能解析', () => {
    const text = ['#EXTM3U', '#EXTINF:213,周杰伦 - 晴天', 'https://www.bilibili.com/video/BV1xx411c7mD', '#EXTINF:180,李荣浩 - 模特', 'https://www.bilibili.com/video/BV1yy411c7mE'].join('\r\n') + '\n#EXTINF:100,某歌手 - 某歌\r\nhttps://www.bilibili.com/video/BV1zz411c7mF\n'
    const parsed = parseM3u(text)
    expect(parsed.entries).toHaveLength(3)
    expect(parsed.entries.map(e => e.bvid)).toEqual(['BV1xx411c7mD', 'BV1yy411c7mE', 'BV1zz411c7mF'])
    expect(parsed.skipped).toBe(0)
  })

  it('没有 #EXTINF 的裸地址行也能收，字段留空', () => {
    const parsed = parseM3u('#EXTM3U\nhttps://www.bilibili.com/video/BV1xx411c7mD\n')
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({ bvid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' })
    expect(parsed.entries[0].title).toBeUndefined()
    expect(parsed.entries[0].duration).toBeUndefined()
  })

  it('#EXTINF 时长缺失或非数字时不丢条目，duration 为 undefined', () => {
    const missing = parseM3u('#EXTM3U\n#EXTINF:,周杰伦 - 晴天\nhttps://www.bilibili.com/video/BV1xx411c7mD\n')
    expect(missing.entries).toHaveLength(1)
    expect(missing.entries[0].duration).toBeUndefined()
    expect(missing.entries[0].title).toBe('晴天')
    expect(missing.entries[0].artist).toBe('周杰伦')

    const nan = parseM3u('#EXTM3U\n#EXTINF:abc,周杰伦 - 晴天\nhttps://www.bilibili.com/video/BV1xx411c7mD\n')
    expect(nan.entries[0].duration).toBeUndefined()
    expect(nan.entries[0].title).toBe('晴天')

    // 完全没有逗号（只有时长）也不炸
    const noComma = parseM3u('#EXTM3U\n#EXTINF:213\nhttps://www.bilibili.com/video/BV1xx411c7mD\n')
    expect(noComma.entries[0].duration).toBe(213)
    expect(noComma.entries[0].title).toBeUndefined()
  })

  it('带 ?p=2 后缀的地址仍能取到 bvid', () => {
    const parsed = parseM3u('#EXTM3U\n#EXTINF:213,周杰伦 - 晴天\nhttps://www.bilibili.com/video/BV1xx411c7mD?p=2\n')
    expect(parsed.entries[0].bvid).toBe('BV1xx411c7mD')
    expect(parsed.entries[0].url).toBe('https://www.bilibili.com/video/BV1xx411c7mD?p=2')
  })

  it('注释行（#EXTM3U / #EXT-X-* / # 备注）与空行被忽略，不产生条目', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '# 这是我自己写的备注',
      '',
      '   ',
      '#EXTINF:213,周杰伦 - 晴天',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      '',
    ].join('\n')
    const parsed = parseM3u(text)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.skipped).toBe(0)
  })

  it('无法识别的行只计数（skipped），不中断整次导入', () => {
    const text = '#EXTM3U\n随便一行不是地址\n#EXTINF:10,A - B\nhttps://www.bilibili.com/video/BV1xx411c7mD\n'
    const parsed = parseM3u(text)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.skipped).toBe(1)
  })

  it('#PLAYLIST: 声明被读出；没有时为空串', () => {
    expect(parseM3u('#EXTM3U\n#PLAYLIST:我的歌单\nhttps://www.bilibili.com/video/BV1xx411c7mD\n').name).toBe('我的歌单')
    expect(parseM3u('#EXTM3U\nhttps://www.bilibili.com/video/BV1xx411c7mD\n').name).toBe('')
  })

  it('BOM 与空文本不抛错', () => {
    expect(parseM3u('\uFEFF#EXTM3U\nhttps://www.bilibili.com/video/BV1xx411c7mD\n').entries).toHaveLength(1)
    expect(parseM3u('')).toEqual({ name: '', entries: [], skipped: 0 })
  })
})

describe('extractBvid', () => {
  it('从各种 B 站地址取 bvid', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD')
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD?p=2')).toBe('BV1xx411c7mD')
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333')).toBe('BV1xx411c7mD')
    expect(extractBvid('https://m.bilibili.com/video/BV1xx411c7mD#reply')).toBe('BV1xx411c7mD')
    expect(extractBvid('BV1xx411c7mD')).toBe('BV1xx411c7mD')
  })

  it('非 B 站地址取不到，返回 undefined', () => {
    expect(extractBvid('https://example.com/song.mp3')).toBeUndefined()
    expect(extractBvid('')).toBeUndefined()
  })
})

describe('buildM3u 往返', () => {
  it('三首歌的歌单生成标准 M3U8 文本', () => {
    const text = buildM3u(playlist([
      track({ id: 'BV1xx411c7mD', bvid: 'BV1xx411c7mD', title: '晴天', artist: '周杰伦', duration: 269, videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }),
      track({ id: 'BV1yy411c7mE', bvid: 'BV1yy411c7mE', title: '模特', artist: '李荣浩', duration: 180, videoUrl: 'https://www.bilibili.com/video/BV1yy411c7mE' }),
      track({ id: 'BV1zz411c7mF', bvid: 'BV1zz411c7mF', title: '起风了', artist: '买辣椒也用券', duration: 325, videoUrl: 'https://www.bilibili.com/video/BV1zz411c7mF' }),
    ], '通勤'))
    expect(text.split('\n').slice(0, 5)).toEqual([
      '#EXTM3U',
      '#PLAYLIST:通勤',
      '#EXTINF:269,周杰伦 - 晴天',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      '',
    ])
    expect(text.endsWith('https://www.bilibili.com/video/BV1zz411c7mF\n')).toBe(true)
  })

  it('buildM3u 后再 parseM3u：曲目数与 bvid 一致', () => {
    const src = playlist([
      track({ id: 'BV1xx411c7mD', bvid: 'BV1xx411c7mD', duration: 269, videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }),
      track({ id: 'BV1yy411c7mE', bvid: 'BV1yy411c7mE', duration: 180, videoUrl: 'https://www.bilibili.com/video/BV1yy411c7mE' }),
      track({ id: 'BV1zz411c7mF', bvid: 'BV1zz411c7mF', duration: 325, videoUrl: 'https://www.bilibili.com/video/BV1zz411c7mF' }),
    ])
    const parsed = parseM3u(buildM3u(src))
    expect(parsed.entries).toHaveLength(src.tracks.length)
    expect(parsed.entries.map(e => e.bvid)).toEqual(src.tracks.map(t => t.bvid))
    expect(parsed.entries.map(e => e.duration)).toEqual([269, 180, 325])
    expect(parsed.name).toBe(src.name)
    expect(parsed.skipped).toBe(0)
  })

  it('标题/歌手里的换行被压平，不会把 #EXTINF 行撑成两行', () => {
    const text = buildM3u(playlist([track({ title: '晴天\nLive', artist: '周杰伦\r\n周杰伦' })]))
    const infLine = text.split('\n').find(l => l.startsWith('#EXTINF:'))!
    expect(infLine).toBe('#EXTINF:269,周杰伦 周杰伦 - 晴天 Live')
  })

  it('老数据没有 videoUrl 时用 bvid 拼规范地址；两者都没有则跳过该曲', () => {
    const text = buildM3u(playlist([
      track({ videoUrl: '', bvid: 'BV1xx411c7mD' }),
      track({ videoUrl: '', bvid: '', title: '无地址' }),
    ]))
    expect(text).toContain('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(text).not.toContain('无地址')
    expect(parseM3u(text).entries).toHaveLength(1)
  })

  it('空歌单也产出合法的 #EXTM3U 头', () => {
    expect(buildM3u(playlist([])).split('\n')[0]).toBe('#EXTM3U')
  })
})

describe('entryToTrack / buildImportedPlaylist', () => {
  it('bvid 作 id；取不到 bvid 时用地址兜底', () => {
    const withBvid = entryToTrack({ url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2', bvid: 'BV1xx411c7mD', title: '晴天', artist: '周杰伦', duration: 269 })
    expect(withBvid.id).toBe('BV1xx411c7mD')
    expect(withBvid.bvid).toBe('BV1xx411c7mD')
    expect(withBvid.videoUrl).toBe('https://www.bilibili.com/video/BV1xx411c7mD?p=2')
    expect(withBvid.duration).toBe(269)

    const noBvid = entryToTrack({ url: 'https://example.com/a.mp3' })
    expect(noBvid.id).toBe('https://example.com/a.mp3')
    expect(noBvid.bvid).toBe('')
    expect(noBvid.title).toBe('https://example.com/a.mp3')
    expect(noBvid.artist).toBe('')
  })

  it('时长缺失给安全默认值 0，不发网络请求补元数据', () => {
    const t = entryToTrack({ url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD' })
    expect(t.duration).toBe(0)
    expect(t.coverUrl).toBe('')
    expect(t.playCount).toBe(0)
    expect(t.isLiked).toBe(false)
  })

  it('歌单名优先级：#PLAYLIST: > 文件名 > 「导入的歌单」', () => {
    const entries = [{ url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD' }]
    expect(buildImportedPlaylist({ name: '文件里的名字', entries, skipped: 0 }, 'C:/a/文件名.m3u8').name).toBe('文件里的名字')
    expect(buildImportedPlaylist({ name: '', entries, skipped: 0 }, 'C:/a/文件名.m3u8').name).toBe('文件名')
    expect(buildImportedPlaylist({ name: '', entries, skipped: 0 }).name).toBe('导入的歌单')
  })
})

describe('electron/playlistFile 文件名净化（非法字符不产生非法路径）', () => {
  it('把 / \\ : * ? " < > | 与控制字符换成下划线', () => {
    expect(sanitizeM3uFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitizeM3uFileName('正常歌单名')).toBe('正常歌单名')
    expect(sanitizeM3uFileName('tab\there')).toBe('tab_here')
  })

  it('空名 / 纯非法名给兜底，不产出空文件名', () => {
    expect(sanitizeM3uFileName('')).toBe('playlist')
    expect(sanitizeM3uFileName('   ')).toBe('playlist')
    expect(sanitizeM3uFileName('///')).toBe('___')
  })

  it('Windows 保留设备名与结尾点/空格被处理', () => {
    expect(sanitizeM3uFileName('CON')).toBe('CON_')
    expect(sanitizeM3uFileName('com1')).toBe('com1_')
    expect(sanitizeM3uFileName('歌单...')).toBe('歌单')
    expect(sanitizeM3uFileName('歌单   ')).toBe('歌单')
  })

  it('超长名被截断到安全长度', () => {
    expect(sanitizeM3uFileName('长'.repeat(200)).length).toBeLessThanOrEqual(80)
  })

  it('ensureM3uExt 只补不重复扩展名', () => {
    expect(ensureM3uExt('C:/a')).toBe('C:/a.m3u8')
    expect(ensureM3uExt('C:/a.m3u')).toBe('C:/a.m3u')
    expect(ensureM3uExt('C:/a.M3U8')).toBe('C:/a.M3U8')
  })
})

describe('electron/playlistFile 模块可加载并注册 IPC', () => {
  beforeEach(() => {
    handlers.clear()
    savedFiles.length = 0
    lastSaveOptions = undefined
    saveDialogResult = { canceled: false, filePath: 'C:/out.m3u8' }
    openDialogResult = { canceled: false, filePaths: ['C:/in.m3u8'] }
    readFileContent = '#EXTM3U\n'
    registerPlaylistFileHandlers()
  })

  afterEach(() => { handlers.clear() })

  it('注册 playlist:exportM3u / playlist:importM3u 两个通道', () => {
    expect([...handlers.keys()].sort()).toEqual(['playlist:exportM3u', 'playlist:importM3u'])
  })

  it('导出：默认文件名用净化后的歌单名，写入文本', async () => {
    const res = await handlers.get('playlist:exportM3u')!({}, { name: 'a/b:c*?', content: '#EXTM3U\n' }) as { ok: boolean; path?: string }
    expect(lastSaveOptions?.defaultPath).toBe('a_b_c__.m3u8')
    expect(savedFiles).toEqual([{ path: 'C:/out.m3u8', content: '#EXTM3U\n' }])
    expect(res).toEqual({ ok: true, path: 'C:/out.m3u8' })
  })

  it('导出：用户取消返回 canceled，不写文件', async () => {
    saveDialogResult = { canceled: true }
    const res = await handlers.get('playlist:exportM3u')!({}, { name: 'x', content: '#EXTM3U\n' }) as { ok: boolean; canceled?: boolean }
    expect(res).toEqual({ ok: false, canceled: true })
    expect(savedFiles).toHaveLength(0)
  })

  it('导出：内容为空时直接拒绝，不弹对话框', async () => {
    const res = await handlers.get('playlist:exportM3u')!({}, { name: 'x', content: '' }) as { ok: boolean; message?: string }
    expect(res.ok).toBe(false)
    expect(res.message).toContain('没有可导出')
    expect(savedFiles).toHaveLength(0)
  })

  it('导入：读回文本与路径交渲染层解析', async () => {
    readFileContent = '#EXTM3U\n#EXTINF:1,A - B\nhttps://www.bilibili.com/video/BV1xx411c7mD\n'
    const res = await handlers.get('playlist:importM3u')!() as { ok: boolean; path?: string; content?: string }
    expect(res.ok).toBe(true)
    expect(res.path).toBe('C:/in.m3u8')
    expect(parseM3u(res.content!).entries).toHaveLength(1)
  })

  it('导入：用户取消返回 canceled', async () => {
    openDialogResult = { canceled: true, filePaths: [] }
    const res = await handlers.get('playlist:importM3u')!() as { ok: boolean; canceled?: boolean }
    expect(res).toEqual({ ok: false, canceled: true })
  })
})

describe('M3U 渲染层代码经 platform 层触达主进程，不直调 window.electronAPI', () => {
  const ROOT = path.resolve(__dirname, '../src')

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(full)
    }
    return out
  }

  it('src/services/m3u.ts 与 src/pages/Playlists.tsx 不出现 window.electronAPI', () => {
    for (const file of ['services/m3u.ts', 'pages/Playlists.tsx']) {
      const src = readFileSync(path.join(ROOT, file), 'utf8')
      expect(src.includes('window.electronAPI'), file).toBe(false)
    }
  })

  it('M3U 相关代码只经 platform 层触达主进程', () => {
    const m3uSrc = readFileSync(path.join(ROOT, 'services/m3u.ts'), 'utf8')
    const pageSrc = readFileSync(path.join(ROOT, 'pages/Playlists.tsx'), 'utf8')
    // m3u.ts 是纯逻辑，不 import 平台层也不碰 IPC
    expect(m3uSrc.includes('@/platform')).toBe(false)
    expect(pageSrc.includes("from '@/platform'")).toBe(true)
    expect(pageSrc.includes('playlistFile')).toBe(true)
  })

  it('src 下所有文件都不直调 window.electronAPI 之外的 M3U 通道', () => {
    const offenders = walk(ROOT).filter(f => readFileSync(f, 'utf8').includes("invoke('playlist:"))
    expect(offenders).toEqual([])
  })
})

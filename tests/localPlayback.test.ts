import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// electron/localMusic.ts 不在 tsconfig include 内（只含 src），这里真的 import 它来验证
// 「渲染层 toLocalAudioUrl」与「主进程 toLocalAudioUrl」是同一套编码规则 —— 这是跨进程契约，
// 写歪了 lm:// 请求会在主进程侧解析出错误路径（404 / 403），而且只在真机播放时才暴露。
// mock 只替换 electron 的窗口/对话框/IPC/协议对象，fs/path 用真实实现。
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: () => {},
  },
  net: {},
  protocol: { handle: () => {} },
}))

import {
  LOCAL_AUDIO_SCHEME as RENDERER_SCHEME,
  toLocalAudioUrl as rendererToLocalAudioUrl,
  isLocalAudioUrl,
  localTrackId,
  buildLocalTrack,
} from '../src/services/localMusic'
import {
  LOCAL_AUDIO_SCHEME as MAIN_SCHEME,
  toLocalAudioUrl as mainToLocalAudioUrl,
  fromLocalAudioUrl,
} from '../electron/localMusic'
import {
  isLocalFilePathLine,
  localPathFromLine,
  entryToTrack,
  parseM3u,
  buildImportedPlaylist,
} from '../src/services/m3u'

/**
 * 一组代表性路径：盘符 / 反斜杠 / 中文 / 空格 / POSIX / 字面量百分号。
 *
 * 最后一条（100% Hits）是编码契约的探针：路径里带字面量 % 时，
 * 不编码就会让 decodeURIComponent 在还原时抛错，往返直接断掉。
 */
const PATHS = [
  'C:\\Music\\a.mp3',
  'C:\\音乐库\\周杰伦 - 稻香.flac',
  'D:\\My Music\\Track 01.wav',
  '/home/u/Music/song.m4a',
  'C:\\音 乐\\a b.ogg',
  'C:\\Music\\100% Hits\\a.mp3',
]

describe('协议 URL 转换：渲染层 toLocalAudioUrl', () => {
  it('scheme 常量为 lm', () => {
    expect(RENDERER_SCHEME).toBe('lm')
  })

  it('简单 Windows 路径产出确定的 lm:// URL', () => {
    expect(rendererToLocalAudioUrl('C:\\Music\\a.mp3')).toBe(
      'lm://local/C%3A%5CMusic%5Ca.mp3',
    )
  })

  it('反斜杠被编码，URL 里不残留裸反斜杠', () => {
    const url = rendererToLocalAudioUrl('C:\\Music\\sub\\a.mp3')
    expect(url).not.toContain('\\')
    expect(url.startsWith('lm://local/')).toBe(true)
  })

  it('中文与空格被百分号编码（具体字面量）', () => {
    expect(rendererToLocalAudioUrl('C:\\音 乐\\a b.mp3')).toBe(
      'lm://local/C%3A%5C%E9%9F%B3%20%E4%B9%90%5Ca%20b.mp3',
    )
  })

  it('编码结果里不出现未转义的 CJK / 空格 / 冒号', () => {
    const url = rendererToLocalAudioUrl('C:\\音乐库\\周杰伦 - 稻香.flac')
    expect(url).not.toMatch(/[\u4e00-\u9fff]/)
    expect(url).not.toContain(' ')
    expect(url.slice('lm://local/'.length)).not.toContain(':')
  })

  it('任意路径编码后都能无损解码回原路径', () => {
    for (const p of PATHS) {
      const url = rendererToLocalAudioUrl(p)
      expect(decodeURIComponent(url.slice('lm://local/'.length))).toBe(p)
    }
  })

  it('产出的 URL 都能被 isLocalAudioUrl 认出', () => {
    for (const p of PATHS) {
      expect(isLocalAudioUrl(rendererToLocalAudioUrl(p))).toBe(true)
    }
  })
})

describe('跨进程契约：渲染层与主进程 toLocalAudioUrl 完全一致', () => {
  it('两边 scheme 常量相同', () => {
    expect(MAIN_SCHEME).toBe(RENDERER_SCHEME)
    expect(MAIN_SCHEME).toBe('lm')
  })

  it('同一路径两边产出逐字符相同的字符串', () => {
    for (const p of PATHS) {
      expect(rendererToLocalAudioUrl(p)).toBe(mainToLocalAudioUrl(p))
    }
  })
})

describe('主进程 fromLocalAudioUrl', () => {
  it('还原渲染层产出的 URL（往返恒等）', () => {
    for (const p of PATHS) {
      expect(fromLocalAudioUrl(rendererToLocalAudioUrl(p))).toBe(p)
    }
  })

  it('还原自己产出的 URL（往返恒等）', () => {
    for (const p of PATHS) {
      expect(fromLocalAudioUrl(mainToLocalAudioUrl(p))).toBe(p)
    }
  })

  it('非 lm:// 输入返回 null', () => {
    expect(fromLocalAudioUrl('http://example.com/a.mp3')).toBeNull()
    expect(fromLocalAudioUrl('file:///C:/a.mp3')).toBeNull()
    expect(fromLocalAudioUrl('')).toBeNull()
    expect(fromLocalAudioUrl('lm://other/x')).toBeNull()
  })

  it('坏掉的百分号编码返回 null 而不是抛错', () => {
    expect(fromLocalAudioUrl('lm://local/%E4%B8')).toBeNull()
  })
})

describe('isLocalAudioUrl', () => {
  it('认得 lm://local/ 开头的 URL', () => {
    expect(isLocalAudioUrl('lm://local/C%3A%5Ca.mp3')).toBe(true)
  })

  it('不认其它来源', () => {
    expect(isLocalAudioUrl('http://example.com/a.mp3')).toBe(false)
    expect(isLocalAudioUrl('file:///C:/a.mp3')).toBe(false)
    expect(isLocalAudioUrl('blob:app://x')).toBe(false)
    expect(isLocalAudioUrl('lm://other/x')).toBe(false)
    expect(isLocalAudioUrl('')).toBe(false)
  })
})

describe('m3u isLocalFilePathLine', () => {
  it('三种常见写法都认', () => {
    expect(isLocalFilePathLine('file:///C:/a.mp3')).toBe(true)
    expect(isLocalFilePathLine('C:\\Music\\a.mp3')).toBe(true)
    expect(isLocalFilePathLine('/home/u/a.mp3')).toBe(true)
  })

  it('扩展名不是音频的不认', () => {
    expect(isLocalFilePathLine('file:///C:/a.txt')).toBe(false)
    expect(isLocalFilePathLine('C:\\Music\\a.txt')).toBe(false)
  })

  it('B 站地址与空串不认', () => {
    expect(isLocalFilePathLine('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(false)
    expect(isLocalFilePathLine('')).toBe(false)
    expect(isLocalFilePathLine('   ')).toBe(false)
  })

  it('含百分号编码中文的 file URL 认（按解码后的扩展名判断）', () => {
    expect(isLocalFilePathLine('file:///C:/%E9%9F%B3%E4%B9%90/a.mp3')).toBe(true)
  })
})

describe('m3u localPathFromLine', () => {
  it('file:///C:/a.mp3 -> C:/a.mp3', () => {
    expect(localPathFromLine('file:///C:/a.mp3')).toBe('C:/a.mp3')
  })

  it('裸 Windows 路径原样返回', () => {
    expect(localPathFromLine('C:\\Music\\a.mp3')).toBe('C:\\Music\\a.mp3')
  })

  it('裸 POSIX 路径原样返回', () => {
    expect(localPathFromLine('/home/u/a.mp3')).toBe('/home/u/a.mp3')
  })

  it('file:///home/u/a.mp3 -> /home/u/a.mp3', () => {
    expect(localPathFromLine('file:///home/u/a.mp3')).toBe('/home/u/a.mp3')
  })

  it('百分号编码的路径被解码', () => {
    expect(localPathFromLine('file:///C:/%E9%9F%B3%E4%B9%90/a.mp3')).toBe('C:/音乐/a.mp3')
  })

  it('非本地行返回 null', () => {
    expect(localPathFromLine('https://www.bilibili.com/video/BV1xx411c7mD')).toBeNull()
    expect(localPathFromLine('')).toBeNull()
    expect(localPathFromLine('file:///C:/a.txt')).toBeNull()
  })
})

describe('m3u entryToTrack 本地路径分支', () => {
  it('转成本地曲目：localPath 有值、bvid/videoUrl 为空', () => {
    const track = entryToTrack({ url: 'file:///C:/Music/a.mp3' })
    expect(track.localPath).toBe('C:/Music/a.mp3')
    expect(track.bvid).toBe('')
    expect(track.videoUrl).toBe('')
  })

  it('id 以 local_ 开头且与 localTrackId(路径) 完全一致', () => {
    const track = entryToTrack({ url: 'file:///C:/Music/a.mp3' })
    expect(track.id.startsWith('local_')).toBe(true)
    expect(track.id).toBe(localTrackId('C:/Music/a.mp3'))
  })

  it('与本地音乐页扫同一文件得到同一条曲目（两个入口 id 相同）', () => {
    const imported = entryToTrack({ url: 'C:\\Music\\a.mp3' })
    const scanned = buildLocalTrack('C:\\Music\\a.mp3', null)
    expect(imported.id).toBe(scanned.id)
    expect(imported.localPath).toBe(scanned.localPath)
  })

  it('有 EXTINF 标题时用标题', () => {
    const track = entryToTrack({
      url: 'file:///C:/Music/a.mp3',
      title: '稻香',
      artist: '周杰伦',
    })
    expect(track.title).toBe('稻香')
    expect(track.artist).toBe('周杰伦')
  })

  it('没有 EXTINF 标题时用文件名主体', () => {
    const track = entryToTrack({ url: 'C:\\Music\\周杰伦 - 稻香.flac' })
    expect(track.title).toBe('周杰伦 - 稻香')
    expect(track.artist).toBe('')
  })
})

describe('m3u entryToTrack B 站条目行为不变', () => {
  it('bvid 有值、localPath 为 undefined', () => {
    const track = entryToTrack({ url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD' })
    expect(track.bvid).toBe('BV1xx411c7mD')
    expect(track.localPath).toBeUndefined()
    expect(track.videoUrl).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(track.id).toBe('BV1xx411c7mD')
  })

  it('只有 bvid 时拼出规范地址', () => {
    const track = entryToTrack({ bvid: 'BV1xx411c7mD', url: '' })
    expect(track.localPath).toBeUndefined()
    expect(track.videoUrl).toBe('https://www.bilibili.com/video/BV1xx411c7mD')
  })
})

describe('m3u 端到端：含本地路径的 M3U 导入', () => {
  const TEXT = [
    '#EXTM3U',
    '#PLAYLIST:混合歌单',
    '#EXTINF:213,周杰伦 - 稻香',
    'file:///C:/Music/a.mp3',
    '',
    '#EXTINF:180,某UP - 某曲',
    'https://www.bilibili.com/video/BV1xx411c7mD',
    '',
  ].join('\n')

  it('本地行与 B 站行各自落到正确的曲目形态', () => {
    const parsed = parseM3u(TEXT)
    expect(parsed.entries).toHaveLength(2)
    const result = buildImportedPlaylist(parsed)
    const [local, remote] = result.tracks
    expect(local.localPath).toBe('C:/Music/a.mp3')
    expect(local.bvid).toBe('')
    expect(local.id).toBe(localTrackId('C:/Music/a.mp3'))
    expect(local.title).toBe('稻香')
    expect(local.artist).toBe('周杰伦')
    expect(remote.bvid).toBe('BV1xx411c7mD')
    expect(remote.localPath).toBeUndefined()
    expect(result.skipped).toBe(0)
  })
})

describe('resolveAudioPlayableUrl 的本地分支', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, blob: async () => new Blob([]) }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lm:// URL 原样返回且不发起任何网络请求', async () => {
    const { resolveAudioPlayableUrl } = await import('../src/services/http')
    const url = rendererToLocalAudioUrl('C:\\Music\\a.mp3')
    await expect(resolveAudioPlayableUrl(url)).resolves.toBe(url)
    await expect(resolveAudioPlayableUrl(url, true)).resolves.toBe(url)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非 lm:// 的桌面直链行为不变（原样返回、不发请求）', async () => {
    const { resolveAudioPlayableUrl } = await import('../src/services/http')
    const direct = 'https://cdn.example.com/audio.m4s'
    await expect(resolveAudioPlayableUrl(direct)).resolves.toBe(direct)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('对照：forceBlob 的桌面直链确实会发请求（证明上面的断言有区分力）', async () => {
    // 这条路径失败时会 warn 并回退直链，噪音与断言无关，压掉
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { resolveAudioPlayableUrl } = await import('../src/services/http')
      const direct = 'https://cdn.example.com/audio.m4s'
      await expect(resolveAudioPlayableUrl(direct, true)).resolves.toBe(direct)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

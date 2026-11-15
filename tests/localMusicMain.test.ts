import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// electron/localMusic.ts 不在 tsconfig include 内（只含 src），tsc 绿并不能证明主进程代码正确。
// 这里真的 import 它、真的跑一次磁盘扫描：mock 'electron' 只替换 ipcMain/dialog/BrowserWindow，
// fs/path 用真实实现，扫描路径完整跑到磁盘上。
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const handleCalls: string[] = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handleCalls.push(channel)
      handlers.set(channel, fn)
    },
  },
}))

const { AUDIO_EXTS, SCAN_LIMITS, registerLocalMusicHandlers } = await import('../electron/localMusic')
// 平台层不依赖 electron 模块（只读 window.electronAPI），可与上面的 mock 共存
const { electronPlatform } = await import('../src/platform/electron')

/** 带 sender 的假 event：isDestroyed() 恒 true，进度发送整条跳过（扫描逻辑不受影响） */
function fakeEvent() {
  return { sender: { isDestroyed: () => true, send: () => {} } }
}

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('handler 未注册：' + channel)
  return Promise.resolve(fn(fakeEvent(), ...args)) as Promise<any>
}

const EXPECTED_CHANNELS = [
  'localMusic:pickDir',
  'localMusic:scan',
  'localMusic:cancel',
  'localMusic:readTags',
  'localMusic:readTagsFallback',
  'localMusic:checkExists',
]

let tmpRoot = ''
let nestedDir = ''

beforeAll(() => {
  registerLocalMusicHandlers()

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bilimusic-localmusic-'))
  fs.writeFileSync(path.join(tmpRoot, 'a.mp3'), Buffer.alloc(16))
  fs.writeFileSync(path.join(tmpRoot, 'b.flac'), Buffer.alloc(32))
  fs.writeFileSync(path.join(tmpRoot, 'c.m4a'), Buffer.alloc(48))
  fs.writeFileSync(path.join(tmpRoot, 'd.wav'), Buffer.alloc(64))
  fs.writeFileSync(path.join(tmpRoot, 'e.ogg'), Buffer.alloc(80))
  fs.writeFileSync(path.join(tmpRoot, 'readme.txt'), 'not audio')
  nestedDir = path.join(tmpRoot, 'sub', 'deep')
  fs.mkdirSync(nestedDir, { recursive: true })
  fs.writeFileSync(path.join(nestedDir, 'f.mp3'), Buffer.alloc(24))
})

afterAll(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('electron/localMusic 导出常量', () => {
  it('AUDIO_EXTS 覆盖 mp3/flac/m4a/wav/ogg', () => {
    for (const ext of ['.mp3', '.flac', '.m4a', '.wav', '.ogg']) {
      expect(AUDIO_EXTS).toContain(ext)
    }
  })

  it('SCAN_LIMITS 上限与规划一致', () => {
    expect(SCAN_LIMITS.maxDepth).toBe(8)
    expect(SCAN_LIMITS.maxFiles).toBe(20000)
    expect(SCAN_LIMITS.maxFileSize).toBe(500 * 1024 * 1024)
  })
})

describe('registerLocalMusicHandlers 注册的 channel', () => {
  it('注册了 6 个 channel，且名字与 preload 一致', () => {
    expect(handleCalls).toHaveLength(6)
    expect(handleCalls.slice().sort()).toEqual(EXPECTED_CHANNELS.slice().sort())
  })

  it('每个 channel 都有可调用的 handler', () => {
    for (const channel of EXPECTED_CHANNELS) {
      expect(typeof handlers.get(channel)).toBe('function')
    }
  })
})

describe('localMusic:scan 真实扫描临时目录', () => {
  it('只返回音频文件，递归到子目录，每项带 filePath/size/mtime', async () => {
    const res = await invoke('localMusic:scan', tmpRoot)

    expect(res.ok).toBe(true)
    expect(res.canceled).toBeFalsy()
    expect(Array.isArray(res.files)).toBe(true)

    const names = (res.files as { filePath: string }[]).map((f) => path.basename(f.filePath)).sort()
    expect(names).toEqual(['a.mp3', 'b.flac', 'c.m4a', 'd.wav', 'e.ogg', 'f.mp3'])
    expect(names).not.toContain('readme.txt')

    // 子目录里的 f.mp3 被递归扫到
    const nested = (res.files as { filePath: string }[]).find((f) => path.basename(f.filePath) === 'f.mp3')
    expect(nested?.filePath).toBe(path.join(nestedDir, 'f.mp3'))

    for (const file of res.files as { filePath: string; size: number; mtime: string }[]) {
      expect(typeof file.filePath).toBe('string')
      expect(path.isAbsolute(file.filePath)).toBe(true)
      expect(typeof file.size).toBe('number')
      expect(file.size).toBeGreaterThan(0)
      expect(typeof file.mtime).toBe('string')
      expect(Number.isNaN(Date.parse(file.mtime))).toBe(false)
    }

    // size 是真实磁盘字节数
    const a = (res.files as { filePath: string; size: number }[]).find((f) => path.basename(f.filePath) === 'a.mp3')
    expect(a?.size).toBe(16)
  })

  it('目录不存在时返回 ok:false 且 message 非空', async () => {
    const res = await invoke('localMusic:scan', path.join(tmpRoot, '不存在的目录'))
    expect(res.ok).toBe(false)
    expect(typeof res.message).toBe('string')
    expect((res.message as string).length).toBeGreaterThan(0)
  })

  it('空目录路径返回 ok:false', async () => {
    const res = await invoke('localMusic:scan', '   ')
    expect(res.ok).toBe(false)
    expect((res.message as string).length).toBeGreaterThan(0)
  })
})

describe('platform.localMusic capability', () => {
  const win = window as Window & { electronAPI?: unknown }
  afterEach(() => {
    delete win.electronAPI
  })

  it('无 electronAPI 时整块缺失，调用方走降级', () => {
    expect(electronPlatform.localMusic).toBeUndefined()
  })

  it('只有部分方法时也整块缺失（老 preload 不会半残可用）', () => {
    win.electronAPI = { localMusicPickDir: () => Promise.resolve({ ok: false }) } as unknown as Window['electronAPI']
    expect(electronPlatform.localMusic).toBeUndefined()
  })

  it('getter 动态读取：注入后能力立即可用且方法直通', () => {
    const scan = vi.fn(async () => ({ ok: true, files: [] }))
    const pickDir = vi.fn(async () => ({ ok: true, path: 'C:/music' }))
    const checkExists = vi.fn(async () => ({ ok: true, missing: [] }))
    win.electronAPI = {
      localMusicScan: scan,
      localMusicPickDir: pickDir,
      localMusicCheckExists: checkExists,
    } as unknown as Window['electronAPI']

    const cap = electronPlatform.localMusic
    expect(cap).toBeDefined()
    expect(cap?.localMusicScan).toBe(scan)
    expect(cap?.localMusicCheckExists).toBe(checkExists)
    // 未注入的可选方法保持 undefined，不伪造
    expect(cap?.localMusicCancel).toBeUndefined()
    expect(cap?.localMusicOnProgress).toBeUndefined()
  })
})

describe('localMusic:checkExists 存在性分类', () => {
  it('存在的不进 missing，不存在的进 missing', async () => {
    const existing = path.join(tmpRoot, 'a.mp3')
    const missing = path.join(tmpRoot, 'gone.mp3')
    const res = await invoke('localMusic:checkExists', [existing, missing])
    expect(res.ok).toBe(true)
    expect(res.missing).toEqual([missing])
  })

  it('全部存在时 missing 为空数组', async () => {
    const res = await invoke('localMusic:checkExists', [path.join(tmpRoot, 'a.mp3'), path.join(tmpRoot, 'b.flac')])
    expect(res.ok).toBe(true)
    expect(res.missing).toEqual([])
  })
})

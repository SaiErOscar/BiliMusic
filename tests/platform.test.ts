import { describe, it, expect, afterEach } from 'vitest'
import { electronPlatform } from '../src/platform/electron'
import type { MiniPlayerState } from '../src/types/electron'

type WinWithApi = Window & { electronAPI?: unknown }

const miniState: MiniPlayerState = {
  hasTrack: false,
  title: '',
  artist: '',
  coverUrl: '',
  isPlaying: false,
  volume: 1,
  isMuted: false,
  progress: 0,
  duration: 0,
  lyricLines: [],
  synced: false,
  theme: 'dark',
  lyricTextColor: '#ffffff',
  lyricControlColor: '#ffffff',
  lyricFontSize: 28,
  lyricFontWeight: 600,
  lyricFontFamily: 'system-ui',
  repeatMode: 'none',
}

function setElectronApi(api: unknown) {
  ;(window as WinWithApi).electronAPI = api
}

afterEach(() => {
  delete (window as WinWithApi).electronAPI
})

describe('platform/electron 能力包装（v1.4.4-pre1 新增 fonts/shell/tray）', () => {
  it('无 electronAPI 时各 capability 均不可用，调用方自然走降级分支', () => {
    expect(electronPlatform.fonts).toBeUndefined()
    expect(electronPlatform.shell).toBeUndefined()
    expect(electronPlatform.tray).toBeUndefined()
    expect(electronPlatform.download).toBeUndefined()
    expect(electronPlatform.storage).toBeUndefined()
    expect(electronPlatform.runtime).toBeUndefined()
  })

  it('getter 动态读取：注入 electronAPI 后 capability 立即可用', () => {
    expect(electronPlatform.shell).toBeUndefined()
    setElectronApi({ platform: 'win32' })
    expect(electronPlatform.shell).toBeDefined()
    expect(electronPlatform.runtime?.platform).toBe('win32')
  })

  it('shell 直通窗口控制、全屏与外部链接', async () => {
    const calls: string[] = []
    setElectronApi({
      platform: 'win32',
      minimize: () => calls.push('minimize'),
      maximize: () => calls.push('maximize'),
      close: () => calls.push('close'),
      isMaximized: () => Promise.resolve(true),
      onMaximizedChange: (cb: (v: boolean) => void) => {
        calls.push('sub-max')
        cb(true)
        return () => calls.push('unsub-max')
      },
      toggleFullscreen: () => calls.push('fullscreen'),
      isFullscreen: () => Promise.resolve(false),
      onFullscreenChange: (cb: (v: boolean) => void) => {
        calls.push('sub-full')
        cb(false)
        return () => calls.push('unsub-full')
      },
      setWindowButtonVisibility: () => calls.push('btn'),
      openExternal: (url: string) => {
        calls.push(`open:${url}`)
        return Promise.resolve()
      },
    })

    const shell = electronPlatform.shell
    expect(shell).toBeDefined()
    shell!.minimize()
    shell!.maximize()
    shell!.close()
    shell!.toggleFullscreen?.()
    shell!.openExternal('https://example.com')
    shell!.setWindowButtonVisibility?.(false)

    const offMax = shell!.onMaximizedChange?.(() => {})
    const offFull = shell!.onFullscreenChange?.(() => {})
    offMax?.()
    offFull?.()

    await expect(shell!.isMaximized?.()).resolves.toBe(true)
    await expect(shell!.isFullscreen?.()).resolves.toBe(false)

    expect(calls).toEqual([
      'minimize',
      'maximize',
      'close',
      'fullscreen',
      'open:https://example.com',
      'btn',
      'sub-max',
      'sub-full',
      'unsub-max',
      'unsub-full',
    ])
  })

  it('fonts 直通系统字体枚举，缺失时不报错', async () => {
    setElectronApi({
      platform: 'win32',
      listSystemFonts: () => Promise.resolve(['Arial', 'Microsoft YaHei']),
    })
    await expect(electronPlatform.fonts?.listSystemFonts?.()).resolves.toEqual(['Arial', 'Microsoft YaHei'])

    // 老 preload 未暴露 listSystemFonts 时返回 undefined，调用方回退内置保底列表
    setElectronApi({ platform: 'win32' })
    expect(electronPlatform.fonts?.listSystemFonts).toBeUndefined()
  })

  it('tray 推送播放状态并订阅托盘命令', () => {
    const pushed: unknown[] = []
    let received: string | null = null
    setElectronApi({
      platform: 'win32',
      updateTrayPlayerState: (state: unknown) => pushed.push(state),
      onTrayPlayerCommand: (cb: (command: string) => void) => {
        cb('next')
        received = 'subscribed'
        return () => {
          received = 'unsubscribed'
        }
      },
    })

    const tray = electronPlatform.tray
    tray!.updateTrayPlayerState?.({
      hasTrack: true,
      title: 't',
      artist: 'a',
      coverUrl: '',
      isPlaying: true,
      queueLength: 3,
      theme: 'dark',
    })
    const off = tray!.onTrayPlayerCommand?.(() => {})
    expect(received).toBe('subscribed')
    off?.()
    expect(received).toBe('unsubscribed')
    expect(pushed).toHaveLength(1)
  })
})

describe('platform/electron 能力包装（v1.4.4-pre2 新增 miniWindow/colorPicker/updater）', () => {
  it('无 electronAPI 时三组新 capability 均不可用，调用方自然走降级分支', () => {
    expect(electronPlatform.miniWindow).toBeUndefined()
    expect(electronPlatform.colorPicker).toBeUndefined()
    expect(electronPlatform.updater).toBeUndefined()
  })

  it('miniWindow 推送播放状态、订阅小窗命令与桌面歌词可见态', () => {
    const pushed: unknown[] = []
    const events: string[] = []
    setElectronApi({
      platform: 'win32',
      updateMiniPlayerState: (state: unknown) => pushed.push(state),
      onMiniPlayerCommand: (cb: (command: string) => void) => {
        cb('seek')
        events.push('mini-sub')
        return () => events.push('mini-unsub')
      },
      toggleDesktopLyric: () => events.push('toggle'),
      getDesktopLyricVisible: () => Promise.resolve({ visible: true, intent: true, suppressed: false }),
      onDesktopLyricVisible: (cb: (state: { visible: boolean }) => void) => {
        cb({ visible: true })
        events.push('lyric-sub')
        return () => events.push('lyric-unsub')
      },
      setNowPlayingOpen: (open: boolean) => events.push(`now-playing:${open}`),
      onOpenNowPlaying: (cb: () => void) => {
        cb()
        events.push('open-sub')
        return () => events.push('open-unsub')
      },
    })

    const mini = electronPlatform.miniWindow
    expect(mini).toBeDefined()
    mini!.updateMiniPlayerState?.(miniState)
    const offMini = mini!.onMiniPlayerCommand?.(() => {})
    mini!.toggleDesktopLyric?.()
    mini!.setNowPlayingOpen?.(true)
    const offLyric = mini!.onDesktopLyricVisible?.(() => {})
    const offOpen = mini!.onOpenNowPlaying?.(() => {})
    offMini?.()
    offLyric?.()
    offOpen?.()

    expect(pushed).toHaveLength(1)
    expect(events).toEqual([
      'mini-sub',
      'toggle',
      'now-playing:true',
      'lyric-sub',
      'open-sub',
      'mini-unsub',
      'lyric-unsub',
      'open-unsub',
    ])
  })

  it('miniWindow 老 preload 缺方法时对应字段为 undefined，不抛错', () => {
    setElectronApi({ platform: 'win32' })
    expect(electronPlatform.miniWindow?.getDesktopLyricVisible).toBeUndefined()
    expect(electronPlatform.miniWindow?.toggleDesktopLyric).toBeUndefined()
    // 可选链调用缺失方法应静默返回 undefined（调用方降级语义）
    expect(electronPlatform.miniWindow?.updateMiniPlayerState?.(miniState)).toBeUndefined()
  })

  it('colorPicker 直通取色面板，缺失时不报错（调用方回退原生 input[type=color]）', async () => {
    setElectronApi({
      platform: 'win32',
      openColorPicker: (initialHex?: string) => Promise.resolve(`${initialHex}-picked`),
    })
    await expect(electronPlatform.colorPicker?.openColorPicker?.('#112233')).resolves.toBe('#112233-picked')

    setElectronApi({ platform: 'darwin' })
    expect(electronPlatform.colorPicker?.openColorPicker).toBeUndefined()
  })

  it('updater 直通版本号、检查更新、重启/应用界面更新与事件订阅', async () => {
    const calls: string[] = []
    setElectronApi({
      platform: 'win32',
      getAppVersion: () => Promise.resolve('1.4.4-pre2'),
      checkForUpdate: () => {
        calls.push('check')
        return Promise.resolve()
      },
      quitAndInstall: () => calls.push('quit'),
      applyRendererUpdate: () => calls.push('reload'),
      onUpdaterEvent: (cb: (event: { type: string }) => void) => {
        cb({ type: 'checking' })
        calls.push('sub')
        return () => calls.push('unsub')
      },
    })

    const updater = electronPlatform.updater
    expect(updater).toBeDefined()
    await expect(updater!.getAppVersion?.()).resolves.toBe('1.4.4-pre2')
    await updater!.checkForUpdate?.()
    updater!.quitAndInstall?.()
    updater!.applyRendererUpdate?.()
    const off = updater!.onUpdaterEvent?.(() => {})
    off?.()

    expect(calls).toEqual(['check', 'quit', 'reload', 'sub', 'unsub'])
  })
})

describe('platform/electron 能力包装（v1.4.4-pre3 新增 backup/webdavConfig 及 auth/storage/runtime 扩展）', () => {
  it('无 electronAPI 时 backup/webdavConfig 不可用，调用方自然走降级分支', () => {
    expect(electronPlatform.backup).toBeUndefined()
    expect(electronPlatform.webdavConfig).toBeUndefined()
    expect(electronPlatform.storage).toBeUndefined()
    expect(electronPlatform.auth).toBeUndefined()
  })

  it('backup 直通本地备份文件对话框（导出/读取/删除 .bmback）', async () => {
    const calls: string[] = []
    setElectronApi({
      platform: 'win32',
      saveBackupFile: (content: string) => { calls.push(`save:${content}`); return Promise.resolve({ ok: true, path: 'C:/x.bmback' }) },
      openBackupFile: () => { calls.push('open'); return Promise.resolve({ ok: true, content: 'RAW' }) },
      deleteBackupFile: (fp: string) => { calls.push(`del:${fp}`); return Promise.resolve({ ok: true }) },
    })
    const backup = electronPlatform.backup
    expect(backup).toBeDefined()
    await expect(backup!.saveBackupFile('DATA')).resolves.toMatchObject({ ok: true })
    await expect(backup!.openBackupFile()).resolves.toMatchObject({ content: 'RAW' })
    await expect(backup!.deleteBackupFile('C:/x.bmback')).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual(['save:DATA', 'open', 'del:C:/x.bmback'])
  })

  it('webdavConfig 直通读取/保存连接配置与测试连通性', async () => {
    const calls: string[] = []
    setElectronApi({
      platform: 'win32',
      getWebdavConfig: () => Promise.resolve({ configured: true, url: 'https://dav', username: 'u' }),
      configureWebdav: (cfg: unknown) => { calls.push('cfg'); return Promise.resolve({ ok: true }) },
      testWebdav: () => { calls.push('test'); return Promise.resolve({ ok: true, message: '连接成功' }) },
    })
    const wc = electronPlatform.webdavConfig
    expect(wc).toBeDefined()
    await expect(wc!.getWebdavConfig?.()).resolves.toMatchObject({ configured: true })
    await wc!.configureWebdav?.({ url: 'https://dav', username: 'u', password: 'p' })
    await expect(wc!.testWebdav?.()).resolves.toMatchObject({ ok: true })
    expect(calls).toEqual(['cfg', 'test'])
  })

  it('storage 现含 webdavDelete，runtime 现含 notifyRendererReady，auth 现含 setCookies', async () => {
    const calls: string[] = []
    setElectronApi({
      platform: 'win32',
      webdavGet: (r: string) => Promise.resolve({ ok: true }),
      webdavDelete: (r: string) => { calls.push(`deldav:${r}`); return Promise.resolve({ ok: true }) },
      notifyRendererReady: () => calls.push('ready'),
      biliApi: { setCookies: (p: unknown) => { calls.push('setck'); return Promise.resolve({ success: true }) } },
    })
    await expect(electronPlatform.storage?.webdavDelete?.('b.bmback')).resolves.toMatchObject({ ok: true })
    expect(electronPlatform.runtime?.notifyRendererReady).toBeTypeOf('function')
    electronPlatform.runtime?.notifyRendererReady?.()
    await expect(electronPlatform.auth?.setCookies?.({ sessdata: 's', biliJct: 'j', dedeUserId: 'd' })).resolves.toMatchObject({ success: true })
    expect(calls).toEqual(['deldav:b.bmback', 'ready', 'setck'])

    // 老 preload 未暴露 webdavDelete/notifyRendererReady 时对应字段 undefined，可选链静默降级
    setElectronApi({ platform: 'win32', webdavGet: () => Promise.resolve({ ok: true }) })
    expect(electronPlatform.storage?.webdavDelete).toBeUndefined()
    expect(electronPlatform.runtime?.notifyRendererReady).toBeUndefined()
    expect(electronPlatform.runtime?.notifyRendererReady?.()).toBeUndefined()
  })

  it('mvExport 直通导出/取消/进度订阅（v1.4.6），缺失时 undefined 降级', async () => {
    const calls: string[] = []
    setElectronApi({
      platform: 'win32',
      exportMvSingle: (payload: unknown) => { calls.push(`export:${JSON.stringify(payload)}`); return Promise.resolve({ ok: true, filePath: 'D:/MV/a.mp4' }) },
      cancelMvExport: () => { calls.push('cancel'); return Promise.resolve({ ok: true }) },
      onMvExportProgress: (cb: (p: unknown) => void) => { cb({ phase: 'render', percent: 50 }); return () => calls.push('unsub') },
    })
    const mv = electronPlatform.mvExport
    expect(mv).toBeDefined()
    await expect(mv!.exportMvSingle({ title: 'a', artist: '', audioUrl: 'https://x', coverUrl: '', duration: 10, lyrics: [], watermark: true }))
      .resolves.toMatchObject({ ok: true, filePath: 'D:/MV/a.mp4' })
    await mv!.cancelMvExport()
    mv!.onMvExportProgress(() => {})
    expect(calls[0]).toContain('"title":"a"')
    expect(calls).toContain('cancel')

    // 老 preload 无 mvExport 命名空间时 capability 为 undefined，调用方隐藏入口
    setElectronApi({ platform: 'win32' })
    expect(electronPlatform.mvExport).toBeUndefined()
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { electronPlatform } from '../src/platform/electron'

type WinWithApi = Window & { electronAPI?: unknown }

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

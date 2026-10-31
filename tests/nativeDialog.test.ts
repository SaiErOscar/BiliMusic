import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { electronPlatform } from '../src/platform/electron'

type WinWithApi = Window & { electronAPI?: unknown }

function setElectronApi(api: unknown) {
  ;(window as WinWithApi).electronAPI = api
}

afterEach(() => {
  delete (window as WinWithApi).electronAPI
  vi.restoreAllMocks()
})

describe('platform.nativeDialog（v1.4.13-pre14 原生确认框能力）', () => {
  it('无 electronAPI 时 capability 为 undefined，调用方自然走 window.confirm 降级', () => {
    expect(electronPlatform.nativeDialog).toBeUndefined()
    // 降级路径可用：capability 缺失时确认框仍能通过 window.confirm 得到答案
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(window.confirm('这是中文歌曲')).toBe(true)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })

  it('老 preload 未暴露 nativeDialog 时同样为 undefined（不抛错）', () => {
    setElectronApi({ platform: 'win32' })
    expect(electronPlatform.nativeDialog).toBeUndefined()
    expect(electronPlatform.nativeDialog?.confirm).toBeUndefined()
  })

  it('注入后直通主进程 confirm，原样透传 message/detail 并回传布尔结果', async () => {
    const calls: { message: string; detail?: string }[] = []
    setElectronApi({
      platform: 'win32',
      nativeDialog: {
        confirm: (options: { message: string; detail?: string }) => {
          calls.push(options)
          return Promise.resolve(options.message === '这是中文歌曲')
        },
      },
    })

    const nativeDialog = electronPlatform.nativeDialog
    expect(nativeDialog).toBeDefined()
    await expect(
      nativeDialog!.confirm({ message: '这是中文歌曲', detail: '翻译对中文歌通常没有意义' }),
    ).resolves.toBe(true)
    await expect(nativeDialog!.confirm({ message: '别的标题' })).resolves.toBe(false)
    expect(calls).toEqual([
      { message: '这是中文歌曲', detail: '翻译对中文歌通常没有意义' },
      { message: '别的标题' },
    ])
  })
})

describe('electron/nativeDialog 主进程处理器', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const showMessageBox = vi.fn()

  beforeEach(() => {
    handlers.clear()
    showMessageBox.mockReset()
    vi.resetModules()
    vi.doMock('electron', () => ({
      BrowserWindow: {
        getFocusedWindow: () => ({ id: 1 }),
        getAllWindows: () => [{ id: 1 }],
      },
      dialog: { showMessageBox },
      ipcMain: {
        handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
      },
    }))
  })

  afterEach(() => {
    vi.doUnmock('electron')
  })

  async function register() {
    const mod = await import('../electron/nativeDialog')
    mod.registerNativeDialogHandlers()
    const handler = handlers.get('dialog:confirm')
    expect(handler).toBeTypeOf('function')
    return handler!
  }

  it('注册 dialog:confirm 通道，用系统原生 question 对话框并模态于宿主窗口', async () => {
    const handler = await register()
    showMessageBox.mockResolvedValue({ response: 0 })

    await expect(handler({}, { message: '这是中文歌曲', detail: '仍要做 AI 增强吗？' })).resolves.toBe(true)

    const [parent, options] = showMessageBox.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(parent).toEqual({ id: 1 })
    expect(options).toMatchObject({
      type: 'question',
      buttons: ['确定', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: '这是中文歌曲',
      detail: '仍要做 AI 增强吗？',
    })
  })

  it('点「取消」返回 false，语义与 window.confirm 一致', async () => {
    const handler = await register()
    showMessageBox.mockResolvedValue({ response: 1 })
    await expect(handler({}, { message: '这是中文歌曲' })).resolves.toBe(false)
    // 无 detail 时不传该字段，避免对话框出现空正文
    expect(showMessageBox.mock.calls[0][1]).not.toHaveProperty('detail')
  })

  it('载荷非法（缺 message）时不弹框，直接返回 false', async () => {
    const handler = await register()
    await expect(handler({}, {})).resolves.toBe(false)
    await expect(handler({}, undefined)).resolves.toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

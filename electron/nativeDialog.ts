// v1.4.13-pre14 原生对话框：把渲染层的确认框交给系统 dialog.showMessageBox。
// 渲染层不再用 window.confirm（Chromium 自绘弹窗，样式与产品 UI 完全不符），
// 改由主进程在宿主窗口上模态弹出，Windows 下即为系统原生对话框。
import { BrowserWindow, dialog, ipcMain } from 'electron'

/** 渲染层传入的确认框载荷；缺省值由主进程兜底，避免旧渲染包传空对象时崩 */
export interface NativeConfirmOptions {
  /** 标题一句（对话框主文本） */
  message: string
  /** 正文说明（对话框次级文本，显示在标题下方） */
  detail?: string
}

/** 确认框按钮文案：index 0 = 确定，1 = 取消，与返回值语义绑定 */
const CONFIRM_BUTTONS = ['确定', '取消'] as const

function hostWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
}

export function registerNativeDialogHandlers(): void {
  // 返回 true = 用户点「确定」；false = 点「取消」/关闭对话框/载荷非法。
  // 语义与原 window.confirm 一致：任何非确定路径都不放行后续操作。
  ipcMain.handle('dialog:confirm', async (_e, options: NativeConfirmOptions) => {
    const message = typeof options?.message === 'string' ? options.message : ''
    if (!message) return false
    const detail = typeof options?.detail === 'string' ? options.detail : undefined
    const win = hostWindow()
    // parent + 非空则模态于当前窗口；无窗口时（如极早期调用）退回无 parent 的独立框
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'question',
      buttons: [...CONFIRM_BUTTONS],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message,
      ...(detail ? { detail } : {}),
    })
    return response === 0
  })
}

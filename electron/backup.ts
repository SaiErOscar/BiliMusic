// v1.4.3-pre6 一键数据备份：主进程文件对话框读写（.bmback 文本）
// 渲染层负责收集负载与加解密，本模块只在系统「另存为 / 打开」对话框与磁盘之间搬运文本。
import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'fs'

const FILTERS = [{ name: 'BiliMusic 备份', extensions: ['bmback'] }]

function hostWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
}

export function registerBackupHandlers(): void {
  // 另存为：把已加密好的 .bmback 文本写到用户选择的路径
  ipcMain.handle('backup:saveFile', async (_e, content: string) => {
    const win = hostWindow()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-').replace(/-\d\d$/, '')
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined, {
      title: '导出备份文件',
      defaultPath: `bilimusic-backup-${stamp}.bmback`,
      filters: FILTERS,
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const target = filePath.toLowerCase().endsWith('.bmback') ? filePath : `${filePath}.bmback`
      fs.writeFileSync(target, content, 'utf8')
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '写入文件失败' }
    }
  })

  // 打开：选择 .bmback 文件，读回文本内容交渲染层解密
  ipcMain.handle('backup:openFile', async () => {
    const win = hostWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      title: '选择备份文件',
      filters: FILTERS,
      properties: ['openFile'],
    })
    if (canceled || !filePaths.length) return { ok: false, canceled: true }
    try {
      const content = fs.readFileSync(filePaths[0], 'utf8')
      return { ok: true, path: filePaths[0], content }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '读取文件失败' }
    }
  })
}

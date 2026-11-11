// v1.4.15 歌单 M3U 导出/导入：主进程文件对话框读写（.m3u/.m3u8 文本）
// 渲染层负责生成与解析 M3U（src/services/m3u.ts），本模块只在系统「另存为 / 打开」
// 对话框与磁盘之间搬运文本，与 electron/backup.ts 同一分层。
import { BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'fs'

const FILTERS = [{ name: 'M3U 播放列表', extensions: ['m3u', 'm3u8'] }]

/** 歌单名里可能出现的非法文件名字符（Windows 保留字符） */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/g
/** 控制字符单列出来：写成 \x00-\x1f 的正则会触发 no-control-regex */
const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20
/** Windows 设备名，直接当文件名会创建失败 */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** 文件名主体上限，给扩展名与上层路径留余量 */
const MAX_BASE_LENGTH = 80

function hostWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
}

/**
 * 歌单名 -> 安全的默认文件名主体（不含扩展名）。
 * 默认文件名由歌单名拼出，必须先去净非法字符，否则拼出来的路径本身非法。
 */
export function sanitizeM3uFileName(name: string): string {
  let base = Array.from(String(name ?? ''))
    .map(ch => (isControlChar(ch) ? '_' : ch))
    .join('')
    .replace(ILLEGAL_NAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 会静默丢弃结尾的点与空格，留着会让「名字对不上」
    .replace(/[. ]+$/, '')
  if (!base) base = 'playlist'
  if (RESERVED_DEVICE_NAMES.test(base)) base = `${base}_`
  if (base.length > MAX_BASE_LENGTH) base = base.slice(0, MAX_BASE_LENGTH).replace(/[. ]+$/, '')
  return base || 'playlist'
}

/** 确保导出路径带 m3u/m3u8 扩展名（用户可能手动删掉） */
export function ensureM3uExt(filePath: string): string {
  return /\.m3u8?$/i.test(filePath) ? filePath : `${filePath}.m3u8`
}

export function registerPlaylistFileHandlers(): void {
  // 另存为：把渲染层生成好的 M3U 文本写到用户选择的路径
  ipcMain.handle('playlist:exportM3u', async (_e, payload: { name?: string; content?: string }) => {
    const name = typeof payload?.name === 'string' ? payload.name : ''
    const content = typeof payload?.content === 'string' ? payload.content : ''
    if (!content) return { ok: false, message: '歌单内容为空，没有可导出的曲目' }
    const win = hostWindow()
    const { canceled, filePath } = await dialog.showSaveDialog(win ?? undefined, {
      title: '导出歌单为 M3U',
      defaultPath: `${sanitizeM3uFileName(name)}.m3u8`,
      filters: FILTERS,
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const target = ensureM3uExt(filePath)
      fs.writeFileSync(target, content, 'utf8')
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '写入文件失败' }
    }
  })

  // 打开：选择 .m3u/.m3u8 文件，读回文本内容交渲染层解析成歌单
  ipcMain.handle('playlist:importM3u', async () => {
    const win = hostWindow()
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      title: '导入 M3U 歌单',
      filters: [...FILTERS, { name: '所有文件', extensions: ['*'] }],
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

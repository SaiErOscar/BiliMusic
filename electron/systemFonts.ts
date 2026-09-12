import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { parseRegFonts, parseMacFontFile, pushUnique } from './fontUtils'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * v1.3.8 系统字体枚举
 *
 * Electron 无原生字体枚举 API，这里按平台分发一个统一的 `system-fonts:list` IPC，
 * 渲染层调用方式完全一致（始终附带一组内置保底字体，防止枚举为空）。
 *
 * - Windows：读注册表字体键（HKLM + HKCU）。1.3.6-beta 已明确规避 PowerShell/CIM，
 *   `reg query` 为系统原生、无执行策略干扰、无第三方依赖，且瞬时返回，不产生长驻子进程。
 * - macOS：扫描系统字体目录内的 .ttf/.otf/.ttc 文件名解析为候选（不引入 CoreText 原生模块）。
 * - 鸿蒙 PC（Electron-on-HarmonyOS）/ 其他：Node 子进程能力受限，降级为内置字体白名单。
 */

// 内置保底字体：即使枚举失败也能提供常见中文字体可选，且作为 CSS font-family 的 fallback
const BUILTIN_FONTS = [
  'system-ui',
  'Microsoft YaHei',
  'SimHei',
  'SimSun',
  'KaiTi',
  'FangSong',
  'PingFang SC',
  'Hiragino Sans GB',
  'Heiti SC',
  'Arial',
  'Segoe UI',
  'Consolas',
]

function listWindowsFonts(): Promise<string[]> {
  const set = new Set<string>()
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ]
  // v1.3.9-beta8 修复中文乱码：reg.exe 输出是系统 ANSI 代码页(简体中文 GBK/CP936)，
  // 而 execFile 默认按 UTF-8 解码 stdout，中文字体名(隶书/幼圆/华文彩云…)全成乱码。
  // 实测：同一输出 GBK 解出 14 行中文、UTF-8 解出 0 行。改为取 buffer 后按 GBK 解码。
  const decodeAnsi = (buf: Buffer): string => {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('utf8')  // 极端环境不支持 gbk 时退回，至少英文字体名可用
    }
  }
  const one = (root: string) =>
    new Promise<void>((resolve) => {
      execFile('reg', ['query', root], { windowsHide: true, encoding: 'buffer' }, (err, stdout) => {
        if (!err && stdout) parseRegFonts(decodeAnsi(stdout as unknown as Buffer), set)
        resolve()
      })
    })
  return Promise.all(roots.map(one)).then(() => Array.from(set))
}

async function listMacFonts(): Promise<string[]> {
  const set = new Set<string>()
  const dirs = [
    '/System/Library/Fonts',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library', 'Fonts'),
  ]
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir)
      for (const e of entries) {
        const name = parseMacFontFile(e)
        if (name) pushUnique(set, name)
      }
    } catch {
      // 目录不存在/无权限，跳过
    }
  }
  return Array.from(set)
}

let cache: string[] | null = null

export async function collectSystemFonts(): Promise<string[]> {
  if (cache) return cache
  const set = new Set<string>(BUILTIN_FONTS)
  let detected: string[] = []
  try {
    if (process.platform === 'win32') detected = await listWindowsFonts()
    else if (process.platform === 'darwin') detected = await listMacFonts()
    // 其他平台（含鸿蒙）走降级：仅内置白名单
  } catch {
    detected = []
  }
  for (const name of detected) pushUnique(set, name)
  // 排序：字母在前、中文按本地顺序稳定置于其后（简单 localeCompare）
  cache = Array.from(set).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return cache
}

export function registerSystemFontsHandlers() {
  ipcMain.handle('system-fonts:list', async () => collectSystemFonts())
}

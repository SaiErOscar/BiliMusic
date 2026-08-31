// 鸿蒙端构建脚本：先同步资源（复用 harmony-prepare），再尝试用 hvigor 构建 HAP。
//
// hvigorw 由 DevEco Studio 生成（.gitignore 已忽略，仓库不提交），且命令行 hvigor 与
// DevEco 6.1 SDK 存在元数据格式差异（sdk-pkg.json vs uni-package.json）。故本脚本对
// hvigor 构建做「尽力而为」：检测到 hvigorw 就尝试，否则提示改用 DevEco Studio 手动构建。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const harmonyRoot = path.join(root, 'platform', 'HarmonyOS')

console.log('[harmony-build] 同步资源...')
const prepare = spawnSync(`node "${path.join(root, 'scripts', 'harmony-prepare.mjs')}"`, {
  stdio: 'inherit',
  shell: true,
})
if (prepare.status !== 0) {
  console.error('[harmony-build] 资源同步失败，退出')
  process.exit(prepare.status ?? 1)
}

const isWin = process.platform === 'win32'
const hvigorw = path.join(harmonyRoot, isWin ? 'hvigorw.bat' : 'hvigorw')
if (!fs.existsSync(hvigorw)) {
  console.warn('[harmony-build] 未找到 hvigorw，跳过命令行构建。')
  console.warn('[harmony-build] 请用 DevEco Studio 打开 platform/HarmonyOS 手动构建 HAP（IDE 内 hvigor 与 SDK 版本匹配）。')
  process.exit(0)
}

console.log('[harmony-build] 调用 hvigor 构建 HAP...')
const result = spawnSync(`"${hvigorw}" assembleHap`, {
  cwd: harmonyRoot,
  stdio: 'inherit',
  shell: true,
})
if (result.status !== 0) {
  console.warn('[harmony-build] hvigor 构建未成功（常见于命令行 hvigor 与 DevEco 6.1 SDK 元数据格式不匹配）。')
  console.warn('[harmony-build] 请改用 DevEco Studio 打开 platform/HarmonyOS 手动构建。')
  process.exit(result.status ?? 1)
}

console.log('[harmony-build] HAP 构建完成，产物位于 electron/build/ 下。')

// 鸿蒙端资源同步脚本。
// 链路：主构建产出 dist/（渲染层）与 dist-electron/（Electron 主进程）→
//       同步到 platform/HarmonyOS/web_engine 的资源目录，供 DevEco/hvigor 打包进 HAP。
//
// 资源目录约定（.gitignore 已忽略这两个目录，属构建产物）：
//   rawfile  ← dist/          渲染层（index.html + assets/），libadapter 运行时加载 Web 页面
//   resfile  ← dist-electron/ 主进程（main.js + preload.cjs + 图标）
//
// 注意：libadapter.so 为二进制，其加载 main.js / index.html 的确切路径（含 main.ts 里
// `path.join(__dirname, '../dist')` 的相对定位）需在 DevEco 实际构建并运行时核验；
// 若布局不匹配，调整下方 rawfileDir / resfileDir 即可，不必改动构建逻辑。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const harmonyRoot = path.join(root, 'platform', 'HarmonyOS')
const rawfileDir = path.join(harmonyRoot, 'web_engine', 'src', 'main', 'resources', 'rawfile')
const resfileDir = path.join(harmonyRoot, 'web_engine', 'src', 'main', 'resources', 'resfile')

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, { recursive: true })
}

console.log('[harmony] 主构建（vite build + copy-preload）...')
const build = spawnSync('npm run build', { stdio: 'inherit', shell: true })
if (build.status !== 0) {
  console.error('[harmony] 主构建失败，退出')
  process.exit(build.status ?? 1)
}

console.log(`[harmony] 同步渲染层 dist -> ${path.relative(root, rawfileDir)}`)
copyDir(path.join(root, 'dist'), rawfileDir)

console.log(`[harmony] 同步主进程 dist-electron -> ${path.relative(root, resfileDir)}`)
copyDir(path.join(root, 'dist-electron'), resfileDir)

console.log('[harmony] 资源同步完成，可用 DevEco Studio 打开 platform/HarmonyOS 构建 HAP')

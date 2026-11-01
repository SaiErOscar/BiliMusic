import { app, ipcMain, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { emitUpdater, ulog } from './updaterBus'

// 渲染热补丁：从 GitHub Releases 下发 renderer-<version>.asar，校验后由 app:// 从可写沙箱加载。
// 单文件 asar（桌面端 net.fetch 读 asar 内部已被现有打包路径证明可用），无需解压、原子可回滚。
// 鸿蒙：原生移植层能力（沙箱可写 / net.fetch 读 asar / 外网下载）未知 —— 全程防御化，
// 任一能力缺失即优雅降级到包内 dist，绝不崩；坏包经 ready 心跳缺失自动回滚并加入黑名单。
const REPO = 'SaiErOscar/BiliMusic'

/**
 * OTA 清单与渲染包的下载基址（v1.4.14-pre2）。
 *
 * 预览版发布被标记为 prerelease 后，GitHub 的 releases/latest 不再指向它
 * （latest 只指向非 prerelease 的正式版）。若预览版仍从 latest 拉清单，
 * 拿到的会是上一个正式版的清单，预览版永远收不到自己的更新。
 *
 * 因此按当前外壳版本分流：
 * - 预览版（含 -pre/-alpha/-beta/-rc）：锁定到自己 tag 的 release 直链，
 *   只在同 tag 的后续构建内更新，不跨预览版本自动升级。
 * - 正式版：跟随 releases/latest，正常自动更新。
 *
 * 清单地址与渲染包下载地址必须由同一个基址派生——否则会出现
 * 「从正式版清单读到文件名、却去预览版 release 下载」的错位。
 */
export function isPrereleaseVersion(version: string): boolean {
  return /-(pre|alpha|beta|rc)/.test(version)
}

export function releaseBaseFor(version: string): string {
  const tag = 'v' + version
  return isPrereleaseVersion(version)
    ? `https://github.com/${REPO}/releases/download/${tag}`
    : `https://github.com/${REPO}/releases/latest/download`
}

/** 当前外壳版本对应的下载基址；OTA 清单与渲染包都由它派生 */
function currentReleaseBase(): string {
  return releaseBaseFor(app.getVersion())
}

export function getOtaManifestUrl(): string {
  return `${currentReleaseBase()}/ota.json`
}

export interface OtaManifest {
  rendererVersion: string
  shellVersion: string
  minShellVersion: string
  file: string
  sha512: string
  size?: number
  notes?: string
}

interface OtaState {
  activeVersion: string | null // 当前生效的 OTA 渲染版本（null = 用包内 dist）
  activeFile: string | null
  verified: boolean // active 版本是否已通过渲染层 ready 心跳（未通过则下次启动回滚）
  pendingVersion: string | null // 已下载、待下次启动或手动重载生效
  pendingFile: string | null
  failedVersions: string[] // 套用后未通过验证被回滚的版本，不再重复下发
}

let state: OtaState = {
  activeVersion: null,
  activeFile: null,
  verified: false,
  pendingVersion: null,
  pendingFile: null,
  failedVersions: [],
}
let otaRoot: string | null = null // 可写 OTA 目录；null = 当前环境不支持 OTA（降级到包内 dist）
let bundledRoot = ''
let reloadWindow: () => void = () => {}
let staging = false

function statePath(): string {
  return path.join(otaRoot as string, 'state.json')
}
function readState(): void {
  if (!otaRoot) return
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) }
  } catch {
    /* 首次无状态文件，用默认值 */
  }
}
function writeState(): void {
  if (!otaRoot) return
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2))
  } catch {
    /* 持久化失败不致命 */
  }
}

import { semverGt } from '../src/utils/semver'
export { semverGt }

// 当前生效的渲染层根：OTA asar（存在）否则包内 dist。app:// 处理器据此 join 资源路径。
export function getActiveRendererRoot(): string {
  if (otaRoot && state.activeVersion && state.activeFile) {
    const p = path.join(otaRoot, state.activeFile)
    if (fs.existsSync(p)) return p
  }
  return bundledRoot
}

function currentRendererVersion(): string {
  return state.activeVersion || app.getVersion()
}

/**
 * 当前实际生效的版本号（v1.4.14-pre1 修复「OTA 热重载后版本号不更新」）。
 *
 * app.getVersion() 读的是安装包外壳的 package.json 版本，OTA 只替换渲染层 asar、
 * 不动外壳，所以热重载后外壳版本恒为装的那个包。界面若直接显示 app.getVersion()，
 * 用户会看到「更新已应用但版本号没变」，误以为更新失败。
 *
 * 这里按实际生效的渲染层回报：有已套用的 OTA 包时返回它的版本，否则回落外壳版本。
 * 与 currentRendererVersion() 同源，保证「显示的版本」与「更新判定的基准」永远一致。
 */
export function getEffectiveVersion(): string {
  return currentRendererVersion()
}

// 该 manifest 的渲染补丁是否可下发：环境支持 OTA + 非黑名单 + 版本更新 + 外壳满足 minShell
export function rendererUpdateAvailable(manifest: OtaManifest, appVersion: string): boolean {
  if (!otaRoot) return false
  if (state.failedVersions.includes(manifest.rendererVersion)) return false
  if (!semverGt(manifest.rendererVersion, currentRendererVersion())) return false
  if (semverGt(manifest.minShellVersion || '0.0.0', appVersion)) return false
  return true
}

export async function fetchManifest(): Promise<OtaManifest | null> {
  const res = await net.fetch(getOtaManifestUrl(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`获取更新信息失败 HTTP ${res.status}`)
  const manifest = (await res.json()) as OtaManifest
  if (!manifest?.rendererVersion || !manifest?.file || !manifest?.sha512) return null
  return manifest
}

async function downloadBuffer(url: string, onProgress: (pct: number) => void): Promise<Buffer> {
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  const reader = res.body?.getReader()
  if (!reader) return Buffer.from(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.length
      if (total > 0) onProgress(Math.round((received / total) * 100))
    }
  }
  return Buffer.concat(chunks)
}

// 下载 + 校验 + 原子暂存为 pending（不立即套用，等下次启动或手动重载）
export async function stageRendererUpdate(manifest: OtaManifest): Promise<void> {
  if (!otaRoot || staging) return
  staging = true
  try {
    emitUpdater({ type: 'renderer-available', version: manifest.rendererVersion })
    // 必须与清单同源：从哪个 release 读到的清单，就去同一个 release 下载渲染包
    const buf = await downloadBuffer(`${currentReleaseBase()}/${manifest.file}`, (pct) =>
      emitUpdater({ type: 'renderer-progress', percent: pct }),
    )
    const digest = crypto.createHash('sha512').update(buf).digest('base64')
    if (digest !== manifest.sha512) throw new Error('校验失败：渲染包指纹不匹配')
    ulog('renderer downloaded & sha512 ok:', manifest.file, `${(buf.length / 1048576).toFixed(2)}MB`)

    const tmp = path.join(otaRoot, `${manifest.file}.tmp`)
    const dest = path.join(otaRoot, manifest.file)
    await fsp.writeFile(tmp, buf)
    await fsp.rename(tmp, dest)

    state.pendingVersion = manifest.rendererVersion
    state.pendingFile = manifest.file
    writeState()
    emitUpdater({ type: 'renderer-ready-to-apply', version: manifest.rendererVersion })
  } finally {
    staging = false
  }
}

// 启动时对账：回滚未验证的坏包（加入黑名单）；套用上次已下载的 pending
function bootReconcile(): void {
  if (!otaRoot) return
  readState()
  // 0) OTA 缓存版本落后于当前应用版本（全量安装包升级后残留）→ 丢弃缓存，回退包内 dist
  //    否则旧 OTA asar 会持续覆盖新版包内渲染层，新功能永远不生效（v1.3.2 踩坑）
  if (state.activeVersion && semverGt(app.getVersion(), state.activeVersion)) {
    ulog('drop stale OTA renderer (older than app):', state.activeVersion, '<', app.getVersion())
    if (state.activeFile) {
      try {
        fs.rmSync(path.join(otaRoot, state.activeFile), { force: true })
      } catch {
        /* ignore */
      }
    }
    state.activeVersion = null
    state.activeFile = null
    state.verified = false
    // 落后的 pending 一并丢弃
    if (state.pendingVersion && semverGt(app.getVersion(), state.pendingVersion)) {
      if (state.pendingFile) {
        try {
          fs.rmSync(path.join(otaRoot, state.pendingFile), { force: true })
        } catch {
          /* ignore */
        }
      }
      state.pendingVersion = null
      state.pendingFile = null
    }
    writeState()
  }
  // 1) 上次 active 未确认 ready → 视为坏包，删除、加入黑名单、回退包内 dist
  if (state.activeVersion && !state.verified) {
    ulog('rollback unverified renderer (asar serving may have failed):', state.activeVersion)
    if (!state.failedVersions.includes(state.activeVersion)) {
      state.failedVersions = [...state.failedVersions, state.activeVersion]
    }
    if (state.activeFile) {
      try {
        fs.rmSync(path.join(otaRoot, state.activeFile), { force: true })
      } catch {
        /* ignore */
      }
    }
    state.activeVersion = null
    state.activeFile = null
    state.verified = false
    writeState()
  }
  // 2) 有已下载 pending → 本次启动套用为 active（待 ready 心跳确认）
  if (state.pendingVersion && state.pendingFile) {
    if (!state.failedVersions.includes(state.pendingVersion) && fs.existsSync(path.join(otaRoot, state.pendingFile))) {
      state.activeVersion = state.pendingVersion
      state.activeFile = state.pendingFile
      state.verified = false
    }
    state.pendingVersion = null
    state.pendingFile = null
    writeState()
  }
}

// 渲染层挂载成功后回报：标记当前 active 为已验证，避免下次启动误回滚
export function markRendererVerified(): void {
  if (otaRoot && state.activeVersion && !state.verified) {
    state.verified = true
    writeState()
  }
  // v1.4.14-pre1：bootReconcile 可能在本轮启动时才把 pending 提升为 active，
  // 那一刻界面已经加载完，拿到的仍是外壳版本。渲染层就绪时补推一次真实生效版本。
  if (state.activeVersion) {
    emitUpdater({ type: 'version-changed', version: state.activeVersion })
  }
}

// 手动「立即重载」：把 pending 提升为 active 并重载窗口
function applyNow(): void {
  if (!otaRoot || !state.pendingVersion || !state.pendingFile) return
  if (!fs.existsSync(path.join(otaRoot, state.pendingFile))) return
  state.activeVersion = state.pendingVersion
  state.activeFile = state.pendingFile
  state.verified = false
  state.pendingVersion = null
  state.pendingFile = null
  writeState()
  // v1.4.14-pre1：先把新版本号推给界面再重载。重载后渲染层重新挂载也会拉一次，
  // 但若重载失败或用户正停在设置页，这条事件能保证版本号当场就变。
  emitUpdater({ type: 'version-changed', version: state.activeVersion })
  reloadWindow()
}

export function initOtaUpdater(opts: { bundledRendererRoot: string; reload: () => void }): void {
  bundledRoot = opts.bundledRendererRoot
  reloadWindow = opts.reload
  // 安全探测可写 OTA 目录：app.getPath / fs 在当前运行时（尤其鸿蒙 shim）可能不可用
  try {
    const dir = path.join(app.getPath('userData'), 'ota')
    fs.mkdirSync(dir, { recursive: true })
    otaRoot = dir
  } catch (err) {
    otaRoot = null // OTA 不可用 → 始终用包内 dist
    ulog('OTA disabled: userData/fs unavailable —', err instanceof Error ? err.message : String(err))
  }
  bootReconcile()
  ulog('init done. otaRoot=', otaRoot ?? 'DISABLED', '| activeRenderer=', state.activeVersion ?? 'bundled')
  ulog('activeRendererRoot=', getActiveRendererRoot())
  ipcMain.on('updater:renderer-ready', () => markRendererVerified())
  ipcMain.on('updater:apply-now', () => applyNow())
}

/**
 * v1.4.13-pre4 WorkBuddy 接入（国内版 / 国际版）。
 *
 * 实现参考 github.com/dingminhua/dsh-connect-workbuddy（MIT，作者 dingminhua）：
 * - 区域基址：国内 https://www.codebuddy.cn，国际 https://www.workbuddy.ai
 * - 插件 API 前缀 /v2/plugin，chat 端点 {base}/v2/chat/completions
 * - 网页登录：auth/state 申请 state → 浏览器授权 → auth/token 轮询换凭据
 * - 本地凭据：桌面端把登录态写在 CodeBuddyExtension/Data/Public/auth 下的
 *   workbuddy-desktop*.info（同目录可能有多份带时间戳的备份，各持不同账号）
 *
 * 本文件只实现「取凭据 + 列模型 + 发一次 chat」三件事，不搬插件的账号池、
 * 计费、图片/视频等能力——BiliMusic 只需要把 WorkBuddy 当成一个模型来源。
 */

import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

export type WorkBuddyRegion = 'cn' | 'global'

/** 区域基址（与插件 upstream.ts 一致） */
const REGION_BASE: Record<WorkBuddyRegion, string> = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

const API_PREFIX = '/v2/plugin'

/** 模型静态回落表（取自插件 catalog.ts 的实测快照；线上会刷新覆盖） */
const FALLBACK_MODELS: Record<WorkBuddyRegion, { id: string; name: string }[]> = {
  cn: [
    { id: 'hy3', name: 'Hy3' },
    { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'minimax-m3', name: 'MiniMax-M3' },
    { id: 'kimi-k3-1', name: 'Kimi-K3' },
    { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
    { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' },
  ],
  global: [
    { id: 'fast-model', name: 'Fast' },
    { id: 'balanced-model', name: 'Balanced' },
    { id: 'primary-model', name: 'Primary' },
    { id: 'deep-model', name: 'Deep' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
    { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'kimi-k3', name: 'Kimi-K3' },
  ],
}

export interface WorkBuddyCredential {
  accessToken: string
  /** 凭据归属区域 */
  region: WorkBuddyRegion
  /** 账号标识（uin 或昵称），仅用于展示 */
  account?: string
  /** 过期时间（epoch ms），0 表示未知 */
  expiresAt?: number
}

/** 本地桌面端的 auth 目录（Windows / macOS / Linux） */
function desktopAuthDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return [
      path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return [path.join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
}

/** 凭据文件里可能出现的字段拼写（camelCase / snake_case 都要容错） */
function pickToken(obj: Record<string, unknown>): string {
  const keys = ['access_token', 'accessToken', 'token', 'accessTokenValue']
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function pickExpiry(obj: Record<string, unknown>): number {
  const keys = ['expires_at', 'expiresAt', 'expireAt', 'exp']
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && v > 0) return v > 1e12 ? v : v * 1000
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      const n = Number(v)
      return n > 1e12 ? n : n * 1000
    }
  }
  return 0
}

function regionOfDomain(domain: string): WorkBuddyRegion {
  const d = (domain || '').toLowerCase()
  if (d.includes('workbuddy.ai') || d.includes('codebuddy.ai')) return 'global'
  return 'cn'
}

/**
 * 扫描本地桌面端凭据。
 *
 * 插件实测：同一目录下会留下多份 workbuddy-desktop.<stamp>.info，各持不同账号。
 * 这里全部扫出来，取「过期时间最晚且未过期」的一份——用户既然在桌面端登录了，
 * 就应该直接能用，不必再来一次网页登录。
 */
export async function readLocalCredentials(): Promise<WorkBuddyCredential[]> {
  const found: WorkBuddyCredential[] = []
  for (const dir of desktopAuthDirs()) {
    let names: string[] = []
    try {
      names = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('workbuddy-desktop') || !name.endsWith('.info')) continue
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8')
        const obj = JSON.parse(raw) as Record<string, unknown>
        const token = pickToken(obj)
        if (!token) continue
        const domain = String(obj['domain'] || obj['site'] || '')
        found.push({
          accessToken: token,
          region: regionOfDomain(domain),
          account: String(obj['uin'] || obj['nickname'] || obj['name'] || '') || undefined,
          expiresAt: pickExpiry(obj),
        })
      } catch {
        /* 单份坏文件不影响其它 */
      }
    }
  }
  // 未过期的优先，其次过期时间晚的
  const now = Date.now()
  return found.sort((a, b) => {
    const av = (a.expiresAt || 0) > now ? 1 : 0
    const bv = (b.expiresAt || 0) > now ? 1 : 0
    if (av !== bv) return bv - av
    return (b.expiresAt || 0) - (a.expiresAt || 0)
  })
}

// ===== 网页登录（OAuth 轮询）=====

interface LoginSession {
  region: WorkBuddyRegion
  state: string
  expiresAt: number
  /** 已完成时填入 */
  credential?: WorkBuddyCredential
}

const sessions = new Map<string, LoginSession>()

/** 申请 state 并返回授权地址，交给系统浏览器打开 */
/**
 * 从响应里取业务数据。
 *
 * 插件的 readJson + envelopeData：服务端把数据包在 `{code, data}` 里，
 * 部分端点直接返回裸对象，两种都要兼容。
 */
function envelopeData(doc: Record<string, unknown>): Record<string, unknown> {
  const d = doc['data']
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : doc
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 申请登录态。
 *
 * v1.4.13-pre4 修 404：插件用的是 **POST + body '{}'**，我用 GET 直接被网关拒。
 * 这是实测出来的差异（用户报「申请登录态失败」），不是猜的。
 */
export async function startWebLogin(region: WorkBuddyRegion): Promise<{ key: string; url: string }> {
  const base = REGION_BASE[region]
  const resp = await fetch(`${base}${API_PREFIX}/auth/state?platform=workbuddy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  })
  const text = await resp.text().catch(() => '')
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`登录服务返回非 JSON（HTTP ${resp.status}）`)
  }
  const data = envelopeData(doc)
  const state = firstString(data, ['state', 'State'])
  if (!state) {
    const msg = firstString(doc, ['message', 'msg', 'error_msg'])
    throw new Error(`申请登录态失败（HTTP ${resp.status}）${msg ? '：' + msg : ''}`)
  }
  const url = firstString(data, ['authUrl', 'auth_url', 'url', 'Url']) || `${base}/login?state=${encodeURIComponent(state)}`
  const key = Math.random().toString(36).slice(2)
  sessions.set(key, { region, state, expiresAt: Date.now() + 10 * 60 * 1000 })
  return { key, url }
}

/** 轮询换取凭据；未完成时返回 pending */
export async function pollWebLogin(key: string): Promise<
  | { status: 'pending' }
  | { status: 'ok'; credential: WorkBuddyCredential }
  | { status: 'expired' }
> {
  const s = sessions.get(key)
  if (!s) return { status: 'expired' }
  if (s.credential) return { status: 'ok', credential: s.credential }
  if (Date.now() > s.expiresAt) {
    sessions.delete(key)
    return { status: 'expired' }
  }
  const base = REGION_BASE[s.region]
  const resp = await fetch(`${base}${API_PREFIX}/auth/token?state=${encodeURIComponent(s.state)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  const text = await resp.text().catch(() => '')
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { status: 'pending' }
  }
  // 插件口径：pending 时返回业务错误码，只有 code 0 / 200 才带数据
  const code = typeof doc['code'] === 'number' ? (doc['code'] as number) : -1
  if (code !== 0 && code !== 200) return { status: 'pending' }
  const data = envelopeData(doc)
  const token = pickToken(data)
  if (!token) return { status: 'pending' }
  const credential: WorkBuddyCredential = {
    accessToken: token,
    region: s.region,
    account: firstString(data, ['uin', 'nickname', 'NickName']) || undefined,
    expiresAt: pickExpiry(data),
  }
  s.credential = credential
  sessions.delete(key)
  return { status: 'ok', credential }
}

// ===== 凭据持久化（与 AI 密钥同级：safeStorage 加密）=====

const CRED_FILE = 'workbuddy.json'

function credPath(): string {
  return path.join(app.getPath('userData'), CRED_FILE)
}

export async function loadSavedCredential(): Promise<WorkBuddyCredential | null> {
  try {
    const { safeStorage } = await import('electron')
    const raw = JSON.parse(await fs.readFile(credPath(), 'utf8')) as { enc?: string; region?: string; account?: string; expiresAt?: number }
    if (!raw.enc) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const token = safeStorage.decryptString(Buffer.from(raw.enc, 'base64'))
    return {
      accessToken: token,
      region: raw.region === 'global' ? 'global' : 'cn',
      account: raw.account,
      expiresAt: raw.expiresAt,
    }
  } catch {
    return null
  }
}

export async function saveCredential(cred: WorkBuddyCredential): Promise<void> {
  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，拒绝以明文保存 WorkBuddy 凭据')
  const payload = {
    enc: safeStorage.encryptString(cred.accessToken).toString('base64'),
    region: cred.region,
    account: cred.account || '',
    expiresAt: cred.expiresAt || 0,
  }
  await fs.mkdir(path.dirname(credPath()), { recursive: true })
  await fs.writeFile(credPath(), JSON.stringify(payload, null, 2), 'utf8')
}

// ===== 模型与对话 =====

/** 拉取区域模型列表；失败回落静态表 */
export async function listModels(region: WorkBuddyRegion, token: string): Promise<{ id: string; name: string }[]> {
  try {
    const resp = await fetch(`${REGION_BASE[region]}/v3/config`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>
      const list = (data['models'] || data['modelList']) as unknown
      if (Array.isArray(list) && list.length) {
        const models = list
          .map((m) => {
            const o = m as Record<string, unknown>
            const id = String(o['id'] || o['model'] || '')
            const name = String(o['name'] || o['displayName'] || id)
            return id ? { id, name } : null
          })
          .filter((m): m is { id: string; name: string } => !!m)
        if (models.length) return models
      }
    }
  } catch {
    /* 回落 */
  }
  return FALLBACK_MODELS[region]
}

/** 发一次 chat；返回首个 choice 的文本 */
export async function chat(cred: WorkBuddyCredential, model: string, messages: unknown[], temperature = 0.7): Promise<string> {
  const resp = await fetch(`${REGION_BASE[cred.region]}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.accessToken}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`WorkBuddy 请求失败（${resp.status}）${body ? '：' + body.slice(0, 160) : ''}`)
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('WorkBuddy 返回内容为空')
  return text
}

export function registerWorkBuddyHandlers(): void {
  ipcMain.handle('wb:local-credentials', async () => readLocalCredentials())
  ipcMain.handle('wb:saved-credential', async () => loadSavedCredential())
  ipcMain.handle('wb:start-login', async (_e, region: WorkBuddyRegion) => {
    try {
      const r = await startWebLogin(region === 'global' ? 'global' : 'cn')
      await shell.openExternal(r.url)
      return { ok: true, key: r.key }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('wb:poll-login', async (_e, key: string) => pollWebLogin(key))
  ipcMain.handle('wb:save-credential', async (_e, cred: WorkBuddyCredential) => {
    try {
      await saveCredential(cred)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('wb:models', async (_e, region: WorkBuddyRegion, token: string) => listModels(region, token))
  ipcMain.handle('wb:chat', async (_e, cred: WorkBuddyCredential, model: string, messages: unknown[], temperature?: number) =>
    chat(cred, model, messages, temperature),
  )
}

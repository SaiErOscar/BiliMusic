/**
 * v1.4.13-pre5 WorkBuddy 接入（国内版 / 国际版）。
 *
 * 实现参考 github.com/dingminhua/dsh-connect-workbuddy（MIT，作者 dingminhua）：
 * - 区域基址：国内 https://www.codebuddy.cn（聊天走 copilot.tencent.com），
 *   国际 https://www.workbuddy.ai
 * - 登录：auth/state（POST + ?platform=workbuddy）→ auth/token 轮询换凭据，
 *   这两个挂在 /v2/plugin 下；模型目录与对话**不在**这个前缀里
 * - 模型目录：裸 /v3/config，必须以 App 的 UA 读
 * - 本地凭据：桌面端把登录态写在 CodeBuddyExtension/Data/Public/auth 下的
 *   workbuddy-desktop*.info；Windows 版把 accessToken 存成
 *   {$wbEncrypted:1, envelope} 的加密字段，必须借桌面端自己的原生模块取密钥解密
 *
 * 本文件只实现「取凭据 + 列模型 + 发一次 chat」三件事，不搬插件的账号池、
 * 计费、图片/视频等能力——BiliMusic 只需要把 WorkBuddy 当成一个模型来源。
 */

import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import { createDecipheriv, createHash } from 'crypto'
import { execFile, execFileSync } from 'child_process'
import path from 'path'
import os from 'os'

export type WorkBuddyRegion = 'cn' | 'global'

/** 区域基址（与插件 upstream.ts 一致） */
const REGION_BASE: Record<WorkBuddyRegion, string> = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

/**
 * 网页登录（auth/state、auth/token）挂在 /v2/plugin 下；模型目录与对话**不在**这个前缀里。
 * 实测：/v2/plugin/v3/config → 404 Route Not Found，裸 /v3/config → 200。
 */
const API_PREFIX = '/v2/plugin'

/** 对话网关。国内版聊天走 copilot.tencent.com，不是 codebuddy.cn（实测 401 vs 200） */
const CHAT_BASE: Record<WorkBuddyRegion, string> = {
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
}

/**
 * 读模型目录必须用 App 自己的客户端身份。
 * /v3/config 按 UA 里的客户端通道裁剪答案：CLI 通道不发布 modelPromotions / modelTiers，
 * 且模型名册是 App 通道的子集。
 */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'

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

// ===== 桌面端加密字段（Windows 版把 token 存成 {$wbEncrypted:1, envelope}）=====

/**
 * 加密字段的 AAD 转录。
 *
 * 逐字节照抄插件 at-rest.ts 的 fieldAad()：这不是可选项，AAD 差一个字节
 * GCM 校验就会失败。字段框架是 2，格式标识 WBEV1，方案名 sym-v1。
 */
function fieldAad(keyId: string, suite: number): Buffer {
  const u32 = (v: number) => {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32BE(v)
    return b
  }
  const lp = (s: string) => {
    const b = Buffer.from(s, 'utf8')
    return Buffer.concat([u32(b.length), b])
  }
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    u32(suite),
    lp(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

interface EncryptedField {
  $wbEncrypted: 1
  envelope: string
}

function isEncryptedField(v: unknown): v is EncryptedField {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return o['$wbEncrypted'] === 1 && typeof o['envelope'] === 'string'
}

/**
 * 桌面端可执行文件候选。
 *
 * 注意真实安装名是 WorkBuddyAI.exe（实测 D:\...\Programs\WorkBuddyAI\），
 * 插件文档里写的 WorkBuddy.exe 在这台机器上不存在——两个都要试。
 */
function appExecutableCandidates(): string[] {
  const home = os.homedir()
  const env = process.env.WORKBUDDY_APP_EXECUTABLE
  const out: string[] = []
  if (env) out.push(env)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const dirs = [local + '\\Programs', pf, pf86]
    const names = ['WorkBuddyAI', 'WorkBuddy', 'CodeBuddy']
    for (const base of dirs) {
      for (const name of names) {
        out.push(path.join(base, name, name + '.exe'))
        out.push(path.join(base, name, 'WorkBuddy.exe'))
      }
    }
    /*
     * v1.4.13-pre7：安装位置不一定在系统盘。
     * 本机实测 WorkBuddy 装在 D:\\Users\\...\\Programs\\WorkBuddyAI\\，
     * 而 LOCALAPPDATA 指向 C 盘——只按环境变量拼路径永远找不到，
     * 表现就是「网页登录正常，但读不到本地桌面端凭据」。
     * 所以再从注册表的卸载项里读 DisplayIcon（安装器一定会写它）。
     */
    for (const exe of registryInstalledExecutables()) out.push(exe)
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy')
    out.push('/Applications/WorkBuddyAI.app/Contents/MacOS/WorkBuddyAI')
  }
  return out
}

/**
 * 从注册表卸载项里取 WorkBuddy 的可执行文件路径。
 *
 * 同步读（execFileSync）是刻意的：候选列表是纯函数、被 readAtRestKey 同步消费，
 * 而这条路径只在真的需要取密钥时走一次，且结果有进程级缓存。
 * 读不到就返回空数组——不猜路径。
 */
function registryInstalledExecutables(): string[] {
  const found: string[] = []
  const hives = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const hive of hives) {
    try {
      const out = execFileSync('reg', ['query', hive, '/s', '/f', 'WorkBuddy', '/t', 'REG_SZ'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      for (const line of out.split(/\r?\n/)) {
        // DisplayIcon 形如 "D:\...\WorkBuddyAI.exe,0"
        const m = /DisplayIcon\s+REG_SZ\s+(.+)$/i.exec(line.trim())
        if (!m) continue
        const raw = m[1].trim().replace(/^"|"$/g, '').replace(/,-?\d+$/, '')
        if (/\.exe$/i.test(raw)) found.push(raw)
      }
    } catch {
      /* 该 hive 读不到就跳过 */
    }
  }
  return found
}

let cachedAtRestKey: Buffer | undefined
let atRestKeyTried = false

/**
 * 取桌面端的 at-rest 密钥。
 *
 * 做法与插件一致：把桌面端当成纯 Node 跑一行代码，调它自己的原生模块
 * electron_browser_workbuddy_storage.loggerGet() 拿 key payload——这样本仓库
 * 不必携带任何与具体构建绑定的常量。失败返回 undefined（不抛），
 * 让上层退化成「读不到凭据」而不是崩溃。
 */
async function readAtRestKey(): Promise<Buffer | undefined> {
  if (atRestKeyTried) return cachedAtRestKey
  atRestKeyTried = true
  const source =
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
    'catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}'
  for (const exe of appExecutableCandidates()) {
    try {
      await fs.access(exe)
    } catch {
      continue
    }
    const payload = await new Promise<string | undefined>((resolve) => {
      execFile(
        exe,
        ['-e', source],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined),
      )
    })
    if (!payload) continue
    try {
      const secret = (JSON.parse(payload) as Record<string, unknown>)['atRestSecretKey']
      if (typeof secret !== 'string' || !secret) continue
      cachedAtRestKey = createHash('sha256').update(secret, 'utf8').digest()
      return cachedAtRestKey
    } catch {
      /* 换下一个候选 */
    }
  }
  return undefined
}

/** 打开一个加密字段；打不开返回空串（GCM 校验失败绝不当成截断的 token） */
function openEncryptedField(field: EncryptedField, key: Buffer): string {
  try {
    const env = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')) as Record<string, unknown>
    const suite = env['suite']
    const keyId = env['keyId']
    const nonce = env['nonce']
    const authTag = env['authTag']
    const ciphertext = env['ciphertext']
    if (typeof suite !== 'number' || typeof keyId !== 'string') return ''
    if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') return ''
    if (keyId !== createHash('sha256').update(key).digest('hex').slice(0, 16)) return ''
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
    d.setAAD(fieldAad(keyId, suite))
    d.setAuthTag(Buffer.from(authTag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8')
  } catch {
    return ''
  }
}

/** 取字符串字段，遇到加密包装就解密 */
async function credentialField(v: unknown, key: Buffer | undefined): Promise<string> {
  if (typeof v === 'string') return v
  if (!isEncryptedField(v)) return ''
  if (!key) return ''
  return openEncryptedField(v, key)
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
  // 密钥只在真的遇到加密字段时才去取（要 spawn 桌面端，有成本）
  let atRestKey: Buffer | undefined | null = null
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
        // 桌面端把登录态嵌在 auth 下（实测键：auth.accessToken / auth.domain /
        // auth.expiresAt / account.uid），不在顶层；两层都要看，否则扫描永远落空。
        const auth = (obj['auth'] && typeof obj['auth'] === 'object' ? obj['auth'] : {}) as Record<string, unknown>
        const account = (obj['account'] && typeof obj['account'] === 'object' ? obj['account'] : {}) as Record<string, unknown>
        const rawToken = auth['accessToken'] ?? obj['accessToken']
        if (!rawToken) continue
        if (isEncryptedField(rawToken) && atRestKey === null) {
          atRestKey = await readAtRestKey()
        }
        const token = isEncryptedField(rawToken)
          ? await credentialField(rawToken, atRestKey ?? undefined)
          : pickToken(auth) || pickToken(obj)
        // 解不开就跳过这一份：宁可不显示账号，也不能拿半个 token 去请求
        if (!token) continue
        const domain = await credentialField(auth['domain'] ?? obj['domain'] ?? obj['site'], atRestKey ?? undefined)
        found.push({
          accessToken: token,
          region: regionOfDomain(domain),
          account:
            (await credentialField(account['nickname'] ?? account['uin'] ?? obj['nickname'] ?? obj['uin'], atRestKey ?? undefined))
            || undefined,
          expiresAt: pickExpiry(auth) || pickExpiry(obj),
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

/**
 * 拉取区域模型列表；失败回落静态表。
 *
 * 三点与插件对齐（v1.4.13-pre5 实测校正）：
 * 1. 裸 /v3/config，**不带** /v2/plugin 前缀（带前缀是 404 Route Not Found）；
 * 2. 必须用 App 的 UA —— 否则 CLI 通道只给子集名册；
 * 3. 名册优先取 `data.agents` 里 name === 'cli' 的 models 数组，
 *    它是「当前账号可用」的口径；data.models 是全量目录。
 */
export async function listModels(region: WorkBuddyRegion, token: string): Promise<{ id: string; name: string }[]> {
  try {
    const resp = await fetch(`${REGION_BASE[region]}/v3/config`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': PRODUCT_UA,
        'X-Product': 'SaaS',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    if (resp.ok) {
      const doc = (await resp.json()) as Record<string, unknown>
      const data = envelopeData(doc)
      const catalog = new Map<string, string>()
      for (const m of Array.isArray(data['models']) ? (data['models'] as unknown[]) : []) {
        if (!m || typeof m !== 'object') continue
        const o = m as Record<string, unknown>
        const id = String(o['id'] || o['model'] || '')
        if (!id) continue
        catalog.set(id, String(o['name'] || o['displayName'] || id))
      }
      let ids: string[] = []
      for (const a of Array.isArray(data['agents']) ? (data['agents'] as unknown[]) : []) {
        if (!a || typeof a !== 'object') continue
        const o = a as Record<string, unknown>
        if (o['name'] === 'cli' && Array.isArray(o['models'])) {
          ids = (o['models'] as unknown[]).filter((x): x is string => typeof x === 'string')
          break
        }
      }
      if (!ids.length) ids = [...catalog.keys()]
      const models = ids
        .filter((id) => !/^(auto|default-model)$/.test(id))
        .map((id) => ({ id, name: catalog.get(id) || id }))
      if (models.length) return models
    }
  } catch {
    /* 回落 */
  }
  return FALLBACK_MODELS[region]
}

// ===== v1.4.13-pre11 账号池与积分 =====

/**
 * 账号池：本机桌面端可能同时登录多个 WorkBuddy 账号，
 * 网页登录也会不断累积。这里把它们统一维护成一份列表。
 *
 * 与插件的差别：插件做完整的池化轮换/冷却/换号重试，BiliMusic 只需要
 * 「能看见有几个号、能选一个用、能看各自的积分」，所以不搬那套调度。
 */
export interface WorkBuddyAccount {
  /** 稳定 id：region + 账号标识的哈希，用于选中与删除 */
  id: string
  region: WorkBuddyRegion
  account: string
  expiresAt: number
  /** 来源：本机桌面端扫描 / 网页登录保存 */
  origin: 'local' | 'saved'
  /** 是否当前使用中 */
  active: boolean
}

function accountId(region: WorkBuddyRegion, account: string): string {
  let hash = 0
  const seed = region + '|' + account
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return 'wb_' + Math.abs(hash).toString(36)
}

/**
 * 列出全部可用账号（本机桌面端 + 已保存的网页登录）。
 *
 * 同一账号在多处出现时以「本机桌面端」为准——它的 token 是活的，
 * 网页登录保存的那份可能已经过期。
 */
export async function listAccounts(): Promise<WorkBuddyAccount[]> {
  const [local, saved] = await Promise.all([readLocalCredentials(), loadSavedCredential()])
  const out: WorkBuddyAccount[] = []
  const seen = new Set<string>()
  for (const cred of local) {
    const key = cred.region + '|' + (cred.account || '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: accountId(cred.region, cred.account || ''),
      region: cred.region,
      account: cred.account || '(未命名)',
      expiresAt: cred.expiresAt || 0,
      origin: 'local',
      active: false,
    })
  }
  if (saved) {
    const key = saved.region + '|' + (saved.account || '')
    if (!seen.has(key)) {
      out.push({
        id: accountId(saved.region, saved.account || ''),
        region: saved.region,
        account: saved.account || '(未命名)',
        expiresAt: saved.expiresAt || 0,
        origin: 'saved',
        active: false,
      })
    }
  }
  return out
}

/**
 * 查账号积分。
 *
 * 走上游的 credits 接口；路径与插件一致（国内版 codebuddy.cn，国际版对应品牌域名）。
 * 上游不提供时返回 null——不猜、不用本地统计冒充。
 */
export async function fetchCredits(cred: WorkBuddyCredential): Promise<{ remaining: number; used: number } | null> {
  try {
    const base = REGION_BASE[cred.region]
    const resp = await fetch(base + '/v2/billing/meter/get-user-resource', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cred.accessToken,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': PRODUCT_UA,
        'X-Product': 'SaaS',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: '{}',
    })
    if (!resp.ok) return null
    const doc = (await resp.json()) as Record<string, unknown>
    const data = envelopeData(doc)
    // 上游字段名不稳定，按已知的几个候选取；取不到就当没有
    const num = (keys: string[]): number | null => {
      for (const k of keys) {
        const v = data[k]
        if (typeof v === 'number' && Number.isFinite(v)) return v
      }
      return null
    }
    const remaining = num(['remainCredit', 'remainingCredit', 'credit', 'balance', 'remain'])
    const used = num(['usedCredit', 'used', 'consume', 'usedCredits'])
    if (remaining === null && used === null) return null
    return { remaining: remaining ?? 0, used: used ?? 0 }
  } catch {
    return null
  }
}

/** 随机 id（对话身份三元组用；网关只校验形状，不校验来源） */
function randomId(): string {
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${h()}${h()}${h()}${h()}-${h()}-${h()}-${h()}-${h()}${h()}${h()}`
}

/**
 * 发一次 chat；返回首个 choice 的文本。
 *
 * 网关有两道门，缺一即 400 / code 11128：
 * 1. messages[0] 必须是 system（ensureSystemHead）；
 * 2. 必须带官方客户端的对话身份三元组 X-Conversation-ID / -Request-ID / -Message-ID。
 *    只带第一个仍然失败，三个都要，且每个请求都重新生成。
 * 国内版还要带 X-Product: SaaS 和 copilot.tencent.com 这个网关（codebuddy.cn 是 401）。
 */
export async function chat(cred: WorkBuddyCredential, model: string, messages: unknown[], temperature = 0.7): Promise<string> {
  const wire = Array.isArray(messages) ? [...messages] : []
  const head = wire[0] as Record<string, unknown> | undefined
  if (!head || head['role'] !== 'system') {
    wire.unshift({ role: 'system', content: 'You are a helpful assistant.' })
  }
  const messageId = randomId()
  // 这个网关**只支持流式**：非流式（stream:false / 不带 stream）会被拒。
  // 所以固定 stream:true，按 SSE 逐块拼内容。
  const resp = await fetch(`${CHAT_BASE[cred.region]}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${cred.accessToken}`,
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
      'X-Product': 'SaaS',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: REGION_BASE[cred.region],
      Referer: `${REGION_BASE[cred.region]}/`,
      'X-Conversation-ID': randomId(),
      'X-Conversation-Request-ID': randomId(),
      'X-Conversation-Message-ID': messageId,
    },
    body: JSON.stringify({ model, messages: wire, temperature, stream: true }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`WorkBuddy 请求失败（${resp.status}）${body ? '：' + body.slice(0, 160) : ''}`)
  }
  const raw = await resp.text()
  let text = ''
  /** v1.4.13-pre11：本次对话消耗的积分（上游 SSE 里按块给） */
  let creditsUsed = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const chunk = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[]
        code?: number
        msg?: string
        /** v1.4.13-pre11：上游按块回传积分消耗 */
        usage?: { credit?: number; credits?: number }
      }
      // 业务错误也可能以 SSE 块的形式回来
      if (typeof chunk.code === 'number' && chunk.code !== 0) {
        throw new Error(`WorkBuddy 返回错误 ${chunk.code}${chunk.msg ? '：' + chunk.msg : ''}`)
      }
      if (chunk.usage) {
        const c = chunk.usage.credit ?? chunk.usage.credits
        if (typeof c === 'number' && c > 0) creditsUsed += c
      }
      text += chunk.choices?.[0]?.delta?.content || ''
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('WorkBuddy 返回错误')) throw e
      /* 单块解析失败不致命 */
    }
  }
  if (!text.trim()) throw new Error('WorkBuddy 返回内容为空')
  // 积分随最后一次调用累积到进程内，由 wb:last-credits 取走（不污染返回值）
  lastCredits = creditsUsed
  return text
}

/** v1.4.13-pre11：最近一次对话消耗的积分，供渲染层记录用量 */
let lastCredits = 0

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
  // v1.4.13-pre11：账号池 + 积分
  ipcMain.handle('wb:accounts', async () => listAccounts())
  ipcMain.handle('wb:credits', async (_e, cred: WorkBuddyCredential) => fetchCredits(cred))
  ipcMain.handle('wb:last-credits', async () => lastCredits)
  ipcMain.handle('wb:chat', async (_e, cred: WorkBuddyCredential, model: string, messages: unknown[], temperature?: number) =>
    chat(cred, model, messages, temperature),
  )
}

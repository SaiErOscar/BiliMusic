// v1.4.11-pre3 AI 底座：Provider 配置持久化 + 主进程代理下发
//
// 密钥安全约束（用户明确要求）：
// 1. 绝不写注册表——落盘位置固定为 userData/ai.json（普通文件，随用户数据目录迁移/卸载清理）
// 2. 必须加密——密钥经 Electron safeStorage（Windows DPAPI）加密后以 enc: 前缀 base64 存盘，
//    明文只在内存中短暂存在；加密不可用时拒绝落盘明文并明确报错，不做静默降级
// 3. 导出全部数据时必须一并导出——密钥以密文形式进入 .bmback（见 src/utils/backup.ts）
//
// 复用 electron/webdav.ts 已验证的 enc: 格式，避免同一项目里出现两套加密约定。

import { app, ipcMain, safeStorage, session } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'

/** 落盘文件名（userData 下）。不写注册表，也不用 localStorage。 */
const CONFIG_FILE = 'ai.json'

/** 代理模式：system = 跟随系统（默认）；manual = 用下面配置的地址 */
export type AiProxyMode = 'system' | 'manual'

export interface AiProviderConfig {
  /** OpenAI 兼容 baseURL，如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 模型名，如 deepseek-chat */
  model: string
  /** 内存明文；落盘时经 safeStorage 加密 */
  apiKey: string
  /** 代理模式，缺省 system */
  proxyMode: AiProxyMode
  /** 手动代理地址，如 http://127.0.0.1:7890；proxyMode=system 时忽略 */
  proxyUrl: string
}

const DEFAULT_CONFIG: AiProviderConfig = {
  baseUrl: '',
  model: '',
  apiKey: '',
  proxyMode: 'system',
  proxyUrl: '',
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE)
}

/**
 * 读取配置。密文解不开（换机器/DPAPI 失效）时返回空密钥而非抛错，
 * 让用户能在设置页重新填一次，不至于整个 AI 功能不可用。
 */
async function readConfig(): Promise<AiProviderConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8')) as Partial<AiProviderConfig> & { apiKey?: string }
    let apiKey = ''
    if (raw.apiKey?.startsWith('enc:')) {
      if (safeStorage.isEncryptionAvailable()) {
        try {
          apiKey = safeStorage.decryptString(Buffer.from(raw.apiKey.slice(4), 'base64'))
        } catch {
          apiKey = ''
        }
      }
    } else if (raw.apiKey) {
      // 兼容历史明文（理论上不会出现）：读出来后立刻按加密路径回写
      apiKey = raw.apiKey
    }
    return {
      baseUrl: raw.baseUrl || '',
      model: raw.model || '',
      apiKey,
      proxyMode: raw.proxyMode === 'manual' ? 'manual' : 'system',
      proxyUrl: raw.proxyUrl || '',
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * 写配置。加密不可用时直接抛错——宁可存不进去，也不落明文。
 * 用户会在设置页看到明确提示，而不是密钥悄悄以明文躺在磁盘上。
 */
async function writeConfig(cfg: AiProviderConfig): Promise<void> {
  const payload = {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: '',
    proxyMode: cfg.proxyMode === 'manual' ? 'manual' : 'system',
    proxyUrl: cfg.proxyUrl,
  }
  if (cfg.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统加密不可用，已拒绝以明文保存 API 密钥')
    }
    payload.apiKey = `enc:${safeStorage.encryptString(cfg.apiKey).toString('base64')}`
  }
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(payload, null, 2), 'utf8')
}

/**
 * 把代理设置应用到指定 session。
 *
 * 默认 system = 跟随系统代理（pac/环境变量/系统设置都由 Chromium 自行处理）；
 * 一旦用户填了 manual，就独占使用该地址，不再回退系统代理——这是用户明确要求的口径。
 */
async function applyProxy(cfg: AiProviderConfig): Promise<void> {
  const target = session.defaultSession
  if (cfg.proxyMode === 'manual' && cfg.proxyUrl.trim()) {
    await target.setProxy({ mode: 'fixed_servers', proxyRules: cfg.proxyUrl.trim() })
    return
  }
  await target.setProxy({ mode: 'system' })
}

export function registerAiHandlers(): void {
  // 读配置：密钥以明文回给渲染层用于输入框回显（本机内存内，不出网）
  ipcMain.handle('ai:get-config', async () => readConfig())

  // 写配置 + 立即下发代理
  ipcMain.handle('ai:set-config', async (_e, cfg: AiProviderConfig) => {
    const next: AiProviderConfig = {
      baseUrl: String(cfg?.baseUrl || '').trim(),
      model: String(cfg?.model || '').trim(),
      apiKey: String(cfg?.apiKey || ''),
      proxyMode: cfg?.proxyMode === 'manual' ? 'manual' : 'system',
      proxyUrl: String(cfg?.proxyUrl || '').trim(),
    }
    await writeConfig(next)
    await applyProxy(next)
    return { ok: true }
  })

  // 启动时按已存配置恢复代理（应用重启后 session 是全新的，必须重设）
  void readConfig().then(applyProxy).catch(() => {})
}

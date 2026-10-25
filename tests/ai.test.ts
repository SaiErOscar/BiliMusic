// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { AI_PRESETS, resolveChatUrl } from '../src/services/ai'

// v1.4.11-pre3 AI 底座：URL 归一化与预设。
//
// 纯逻辑部分（URL 拼接、预设表）在这里守；密钥加密、代理下发、备份导出属于
// 主进程与 IPC 行为，jsdom 测不到，靠 Electron 探针实测（见 CHANGELOG）。

const aiSrc = readFileSync(path.resolve(__dirname, '../electron/ai.ts'), 'utf8').replace(/\r\n/g, '\n')
const backupSrc = readFileSync(path.resolve(__dirname, '../src/utils/backup.ts'), 'utf8').replace(/\r\n/g, '\n')
const preloadSrc = readFileSync(path.resolve(__dirname, '../electron/preload.cjs'), 'utf8').replace(/\r\n/g, '\n')

describe('AI 接口地址归一化（v1.4.11-pre3）', () => {
  it('补全缺失的 /chat/completions（DeepSeek 规范地址不带 /v1）', () => {
    // v1.4.11-pre5：DeepSeek 官方 base URL 是 https://api.deepseek.com，
    // 其 chat 端点在 /chat/completions 而非 /v1/chat/completions
    expect(resolveChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions')
    expect(resolveChatUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('已写全的地址原样返回，不重复拼接', () => {
    const full = 'https://api.openai.com/v1/chat/completions'
    expect(resolveChatUrl(full)).toBe(full)
  })

  it('容忍结尾多余斜杠', () => {
    expect(resolveChatUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('空地址返回空串（调用方据此报「未配置」）', () => {
    expect(resolveChatUrl('')).toBe('')
    expect(resolveChatUrl('   ')).toBe('')
  })
})

describe('AI 预设（OpenAI 兼容 + DeepSeek）', () => {
  it('预设都符合 OpenAI 兼容格式，且必含 OpenAI 与 DeepSeek', () => {
    const ids = AI_PRESETS.map((p) => p.id)
    expect(ids).toContain('openai')
    expect(ids).toContain('deepseek')
    // v1.4.13-pre1 扩充了国内常见服务，这里只约束格式不锁数量
    expect(ids.length).toBeGreaterThanOrEqual(2)
    for (const p of AI_PRESETS) {
      expect(p.baseUrl.startsWith('https://')).toBe(true)
      expect(p.model.length).toBeGreaterThan(0)
      expect(p.label.length).toBeGreaterThan(0)
    }
  })

  it('DeepSeek 预设指向 deepseek-chat，地址不带 /v1', () => {
    const ds = AI_PRESETS.find((p) => p.id === 'deepseek')
    expect(ds?.baseUrl).toBe('https://api.deepseek.com')
    expect(ds?.model).toBe('deepseek-chat')
  })
})

describe('密钥安全硬约束（用户明确要求）', () => {
  it('主进程用 safeStorage 加密，且绝不写注册表', () => {
    expect(aiSrc).toContain('safeStorage.encryptString')
    expect(aiSrc).toContain('enc:')
    // 落盘只允许写 userData 下的普通文件
    expect(aiSrc).toContain("app.getPath('userData')")
    // 硬约束：不得出现任何注册表写入
    expect(aiSrc).not.toMatch(/regedit|winreg|Registry|\.reg\b/)
    // 加密不可用时必须拒绝落明文，而不是静默降级
    expect(aiSrc).toContain('isEncryptionAvailable')
    expect(aiSrc).toContain('拒绝以明文保存')
  })

  it('代理默认跟随系统，配置后独占使用手动地址', () => {
    expect(aiSrc).toContain("mode: 'system'")
    expect(aiSrc).toContain("mode: 'fixed_servers'")
    // 默认值必须是 system
    expect(aiSrc).toMatch(/proxyMode:\s*'system'/)
  })

  it('导出全部数据时一并导出 AI 配置（含密钥），导入时写回', () => {
    expect(backupSrc).toContain('aiConfig')
    expect(backupSrc).toContain('loadAiConfigForBackup')
    // 恢复侧必须写回主进程
    expect(backupSrc).toContain('platform.aiConfig.set')
  })

  it('preload 暴露 aiConfig 桥，且只暴露 get/set', () => {
    expect(preloadSrc).toContain("ipcRenderer.invoke('ai:get-config')")
    expect(preloadSrc).toContain("ipcRenderer.invoke('ai:set-config'")
    expect(preloadSrc).toContain('aiConfig,')
  })
})

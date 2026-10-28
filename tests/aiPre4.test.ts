// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { FALLBACK_MODELS, hostOf, toProductName } from '../src/services/aiModels'
import { loadRecentlyRecommended, rememberRecommended } from '../src/services/aiRecommend'

// v1.4.13-pre4：模型下拉、推荐去重、WorkBuddy 接入、备份完整性。

describe('模型下拉', () => {
  it('DeepSeek 内置表含 flash / pro 两条线', () => {
    const ids = (FALLBACK_MODELS['api.deepseek.com'] || []).map((m) => m.id)
    expect(ids).toContain('deepseek-flash')
    expect(ids).toContain('deepseek-pro')
  })

  it('展示产品名而非接口名', () => {
    expect(toProductName('deepseek-flash')).toBe('DeepSeek Flash')
    expect(toProductName('deepseek-pro')).toBe('DeepSeek Pro')
  })

  it('主机名解析用于匹配回落表', () => {
    expect(hostOf('https://api.deepseek.com')).toBe('api.deepseek.com')
    expect(hostOf('not a url')).toBe('')
  })
})

describe('推荐去重', () => {
  it('记住推荐过的曲目并读回', () => {
    rememberRecommended([{ id: 'a' }, { id: 'b' }])
    expect(loadRecentlyRecommended()).toContain('a')
    expect(loadRecentlyRecommended()).toContain('b')
  })

  it('重复推荐不产生重复条目', () => {
    rememberRecommended([{ id: 'a' }])
    rememberRecommended([{ id: 'a' }])
    expect(loadRecentlyRecommended().filter((x) => x === 'a')).toHaveLength(1)
  })

  it('候选池优先剔除最近推过的', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiRecommend.ts'), 'utf8')
    expect(src).toContain('loadRecentlyRecommended')
    expect(src).toContain('freshPool')
  })
})

describe('WorkBuddy 接入（参考 dsh-connect-workbuddy，MIT）', () => {
  const src = readFileSync(path.resolve(__dirname, '../electron/workbuddy.ts'), 'utf8')

  it('两个区域基址正确', () => {
    expect(src).toContain('https://www.codebuddy.cn')
    expect(src).toContain('https://www.workbuddy.ai')
  })

  it('走插件的 v2/plugin 与 v2/chat/completions 端点', () => {
    expect(src).toContain("'/v2/plugin'")
    expect(src).toContain('/v2/chat/completions')
  })

  it('支持本地凭据与网页登录两条路径', () => {
    expect(src).toContain('workbuddy-desktop')
    expect(src).toContain('auth/state')
    expect(src).toContain('auth/token')
  })

  // 回归锚点：pre5 实测 /v2/plugin/v3/config → 404 Route Not Found，裸 /v3/config → 200。
  // 前缀只能挂在 auth 两处，模型目录与对话都不在它下面。
  it('/v3/config 与 chat 不带 /v2/plugin 前缀', () => {
    expect(src).not.toContain('${API_PREFIX}/v3/config')
    expect(src).not.toContain('${API_PREFIX}/v2/chat')
    expect(src).toContain('/v3/config')
    expect(src).toContain('/v2/chat/completions')
  })

  // 回归锚点：auth/state 少了 platform 参数，上游回 10001 platform is empty。
  it('auth/state 带 platform=workbuddy', () => {
    expect(src).toContain('auth/state?platform=workbuddy')
  })

  // 回归锚点：国内版聊天网关是 copilot.tencent.com，codebuddy.cn 上打 chat 是 401。
  it('国内版聊天走 copilot.tencent.com', () => {
    expect(src).toContain('https://copilot.tencent.com')
    expect(src).toContain('CHAT_BASE')
  })

  // 回归锚点：网关 11128 两道门，system 头 + 对话身份三元组缺一不可。
  it('chat 带 system 头与对话身份三元组', () => {
    expect(src).toContain('X-Conversation-ID')
    expect(src).toContain('X-Conversation-Request-ID')
    expect(src).toContain('X-Conversation-Message-ID')
    expect(src).toContain("role: 'system'")
  })

  // 回归锚点：这个网关只吃流式。非流式请求会被拒，所以必须 stream:true + 解析 SSE。
  it('chat 走 SSE 流式，不走非流式', () => {
    // 只断言 chat 函数体：listModels 用 resp.json() 读目录是正当的，
    // 不该被这条回归连坐。
    const chatBody = src.slice(src.indexOf('export async function chat'), src.indexOf('export function registerWorkBuddyHandlers'))
    expect(chatBody).toContain('stream: true')
    expect(chatBody).toContain("Accept: 'text/event-stream'")
    expect(chatBody).toContain("startsWith('data:')")
    expect(chatBody).not.toContain('resp.json()')
  })

  // 回归锚点：Windows 版把 accessToken 存成 {$wbEncrypted:1, envelope}。
  // 只认字符串的读取器会静默失败（曾经发出 Bearer [object Object] 被网关 401）。
  it('能解开桌面端的加密 token 字段', () => {
    expect(src).toContain('$wbEncrypted')
    expect(src).toContain('electron_browser_workbuddy_storage')
    expect(src).toContain('aes-256-gcm')
    expect(src).toContain('WB-AAD')
    expect(src).toContain('WBEV1')
  })

  // 回归锚点：本机真实安装名是 WorkBuddyAI.exe，不是插件文档里的 WorkBuddy.exe。
  it('桌面端可执行文件候选含 WorkBuddyAI', () => {
    expect(src).toContain('WorkBuddyAI')
  })

  it('凭据经 safeStorage 加密落盘，不写明文', () => {
    expect(src).toContain('safeStorage.encryptString')
    expect(src).toContain('拒绝以明文保存')
  })
})

// v1.4.13-pre6：AiSettings 里的 source / wbRegion / wbModel 此前只在渲染层存在，
// 主进程读写两端都没有落盘，于是「选完 WorkBuddy 就丢」「预设活不过一次重启」。
describe('AI 配置持久化完整性', () => {
  const src = readFileSync(path.resolve(__dirname, '../electron/ai.ts'), 'utf8')

  it('WorkBuddy 来源与模型写进配置文件', () => {
    const write = src.slice(src.indexOf('async function writeConfig'), src.indexOf('export', src.indexOf('async function writeConfig')))
    expect(write).toContain('source:')
    expect(write).toContain('wbRegion:')
    expect(write).toContain('wbModel:')
  })

  it('读配置时也把这三项读回来', () => {
    const read = src.slice(src.indexOf('async function readConfig'), src.indexOf('async function writeConfig'))
    expect(read).toContain('source:')
    expect(read).toContain('wbRegion:')
    expect(read).toContain('wbModel:')
  })

  it('推荐方式与 WorkBuddy 都在同一条持久化路径上', () => {
    expect(src).toContain('recommendMode:')
    expect(src).toContain("cfg.source === 'workbuddy'")
  })
})

// v1.4.13-pre6：地址框的显隐条件原本写成 !baseUrl（地址为空才显示），逻辑正好相反。
describe('地址框只在「自定义」预设时出现', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8')

  it('用 isCustomPreset 判定，而不是「地址为空」', () => {
    expect(src).toContain('isCustomPreset')
    expect(src).toContain('{isCustomPreset && (')
    expect(src).not.toContain('{!aiConfig.baseUrl && (')
  })

  it('判定与预设下拉同源（baseUrl 匹配不到任何预设）', () => {
    const gate = src.slice(src.indexOf('const isCustomPreset'), src.indexOf('const patchAiConfig'))
    expect(gate).toContain('AI_PRESETS.some')
    expect(gate).toContain('baseUrl')
  })

  it('WorkBuddy 也出现在模型下拉里，选中即开面板', () => {
    expect(src).toContain('__workbuddy__')
    expect(src).toContain('setWbOpen(true)')
  })
})

describe('备份导出完整性', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/utils/backup.ts'), 'utf8')
  it('画像正文、播放统计、学习信号都进备份', () => {
    expect(src).toContain('userProfileText')
    expect(src).toContain('playStats')
    expect(src).toContain('aiLearned')
  })
  it('恢复时写回这三项', () => {
    expect(src).toContain('savePlayStatsRaw')
    expect(src).toContain('writeText')
    expect(src).toContain('setLearned')
  })
})

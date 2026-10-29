// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { FALLBACK_MODELS, hostOf, toProductName } from '../src/services/aiModels'
import { loadRecentlyRecommended, rememberRecommended } from '../src/services/aiRecommend'

// v1.4.13-pre4：模型下拉、推荐去重、WorkBuddy 接入、备份完整性。

describe('模型下拉', () => {
  // v1.4.13-pre7：内置表只保留官方真实模型名（臆造名照着调只会 400/404）
  it('DeepSeek 内置表用官方真实模型名', () => {
    const ids = (FALLBACK_MODELS['api.deepseek.com'] || []).map((m) => m.id)
    expect(ids).toContain('deepseek-chat')
    expect(ids).toContain('deepseek-reasoner')
  })

  // 回归锚点：臆造名（deepseek-v4-pro / deepseek-v4.1-flash）不该再出现在回落表里，
  // 用户反馈「访问不到接口时不要把这两个当默认预设」。
  it('不再内置臆造的 v4 系列模型名', () => {
    const ids = (FALLBACK_MODELS['api.deepseek.com'] || []).map((m) => m.id)
    expect(ids.some((id) => id.includes('v4'))).toBe(false)
  })

  it('展示产品名而非接口名', () => {
    // 这两个是 DeepSeek 的旧接口名，映射里刻意标了「（旧名）」
    expect(toProductName('deepseek-chat')).toBe('DeepSeek Chat（旧名）')
    expect(toProductName('deepseek-reasoner')).toBe('DeepSeek Reasoner（旧名）')
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

  // v1.4.13-pre7：模型下拉里不再出现 WorkBuddy（用户要求），入口只在「服务预设」
  it('模型下拉里不再有 WorkBuddy 选项', () => {
    expect(src).not.toContain('__workbuddy__')
  })
})

// v1.4.13-pre7：用户反馈的 12 项。这里把其中可静态验证的钉住。
describe('WorkBuddy 作为预设的完整性（pre7）', () => {
  const wb = readFileSync(path.resolve(__dirname, '../electron/workbuddy.ts'), 'utf8')
  const aiSvc = readFileSync(path.resolve(__dirname, '../src/services/ai.ts'), 'utf8')
  const settings = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8')

  // 用户第 1 项：网页登录正常但读不到本地桌面端。
  // 根因是安装位置不在系统盘，只按 LOCALAPPDATA 拼路径永远找不到。
  it('桌面端可执行文件从注册表兜底发现', () => {
    expect(wb).toContain('registryInstalledExecutables')
    expect(wb).toContain('DisplayIcon')
    expect(wb).toContain('execFileSync')
  })

  // 用户第 3 项：所有调用仍走 API、没有 API 就无法测试。
  // 根因是 WorkBuddy 分支排在 baseUrl/apiKey/model 三项检查之后。
  it('WorkBuddy 分支排在 API 三项检查之前', () => {
    const start = aiSvc.indexOf('export async function aiChat')
    const body = aiSvc.slice(start, aiSvc.indexOf('export async function testAiConnection'))
    const wbAt = body.indexOf("config.source === 'workbuddy'")
    const urlAt = body.indexOf('未配置 API 地址')
    expect(wbAt).toBeGreaterThan(-1)
    expect(urlAt).toBeGreaterThan(-1)
    expect(wbAt).toBeLessThan(urlAt)
  })

  // 用户第 5、6 项：无法选「自定义」、选完 WorkBuddy 回显成别的。
  // 根因是下拉只按 baseUrl 反查，而 WorkBuddy 的 baseUrl 是空串。
  it('预设下拉按 source 回显 WorkBuddy，且「自定义」可选中', () => {
    expect(settings).toContain('currentPresetId')
    expect(settings).toContain("? 'workbuddy'")
    expect(settings).toContain('<option value="">自定义</option>')
  })

  // 用户第 9 项：切换预设自动刷新模型
  it('切换预设即自动刷新模型列表', () => {
    expect(settings).toContain('void refreshModels(preset.baseUrl, preset.model)')
  })

  // 用户第 12 项：WorkBuddy 时 API 输入框禁用并清空
  it('WorkBuddy 时 API 密钥框禁用且清空', () => {
    expect(settings).toContain("disabled={aiConfig.source === 'workbuddy'}")
    expect(settings).toContain("patchAiConfig({ source: 'workbuddy', apiKey: '' })")
  })

  // 用户第 7 项：模型行里那个 WorkBuddy 按钮要删掉
  it('地址与模型行不再有 WorkBuddy 按钮', () => {
    expect(settings).not.toContain('>WorkBuddy…</ActionButton>')
  })
})

describe('推荐方式与歌单按钮（pre7）', () => {
  const settings = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8')
  const panel = readFileSync(path.resolve(__dirname, '../src/components/AiPlaylistPanel.tsx'), 'utf8')

  // 用户第 8 项：推荐方式改了不持久。根因之一是防抖 300ms 内切页，
  // 卸载时 cleanup 只 clearTimeout，那一次改动永远没落盘。
  it('卸载时把未落盘的配置补写掉', () => {
    expect(settings).toContain('aiPendingRef')
    expect(settings).toContain('saveAiConfig(pending)')
  })

  // 用户第 8 项：生成歌单按钮显示不全 → 放到第二行
  it('生成歌单按钮独占第二行', () => {
    expect(panel).toContain('flexDirection: \'column\'')
  })
})

// v1.4.13-pre8：用户 7 项反馈。核心是「配置在主进程被削成半份」这个真根因。
describe('配置持久化不再丢字段（pre8 真根因）', () => {
  const src = readFileSync(path.resolve(__dirname, '../electron/ai.ts'), 'utf8')

  /*
   * 这条是 pre6/pre7 两版都没修好的原因：渲染层发的是完整 AiSettings，
   * 但 ai:set-config 把它当 AiProviderConfig，只挑 5 个字段重建对象落盘。
   * source / recommendMode / wbModel 因此在主进程这一层就被丢掉。
   */
  it('ai:set-config 保留全部 AiSettings 字段', () => {
    const handler = src.slice(src.indexOf("ipcMain.handle('ai:set-config'"), src.indexOf('// 启动时按已存配置恢复代理'))
    expect(handler).toContain('recommendMode:')
    expect(handler).toContain('source:')
    expect(handler).toContain('wbRegion:')
    expect(handler).toContain('wbModel:')
    expect(handler).toContain('userProfile:')
    expect(handler).toContain('persona:')
  })

  it('入参类型是 AiSettings 而不是 AiProviderConfig', () => {
    expect(src).toContain("ipcMain.handle('ai:set-config', async (_e, cfg: AiSettings)")
  })
})

describe('WorkBuddy 预设的显示与可用性（pre8）', () => {
  const settings = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8')
  const panel = readFileSync(path.resolve(__dirname, '../src/components/WorkBuddyPanel.tsx'), 'utf8')

  // 用户第 5 项：WorkBuddy 时「地址与模型」要显示它自己的模型
  it('WorkBuddy 时显示 wbModel 而不是别的预设模型', () => {
    expect(settings).toContain('aiConfig.wbModel ||')
    expect(settings).toContain('更换模型')
  })

  // 用户第 6 项：选「自定义」要出现网址输入框与模型接口输入框
  it('自定义预设提供地址输入框与模型接口输入框', () => {
    expect(settings).toContain('自定义 API 地址')
    expect(settings).toContain('填写模型接口名')
    expect(settings).toContain('{isCustomPreset && (')
    expect(settings).toContain('{customModel && (')
  })

  // 用户第 6 项根因：WorkBuddy 预设 baseUrl 是空串，会与「自定义」撞车
  it('预设反查排除 WorkBuddy，避免自定义被认成 WorkBuddy', () => {
    expect(settings).toContain("p.id !== 'workbuddy' && p.baseUrl")
  })

  // 用户第 3 项：绑定账号后要能持久显示 —— 打开面板就拉模型并回显
  it('打开面板时恢复已存凭据并回显上次模型', () => {
    expect(panel).toContain('initialModel')
    expect(panel).toContain('cap.models(s.region, s.accessToken)')
  })

  // 用户第 4 项：推荐方式要持久 —— 去掉防抖，改完立即落盘
  it('配置改动立即落盘，不留防抖窗口', () => {
    expect(settings).not.toContain('}, 300)')
  })
})

describe('图标与桌面一致（pre8）', () => {
  const main = readFileSync(path.resolve(__dirname, '../electron/main.ts'), 'utf8')
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
    build: { extraResources: { from: string; to: string }[] }
  }

  // 用户第 1 项：任务栏很暗 —— 单张 1024 PNG 被系统糊缩
  it('窗口图标用多尺寸 ico，不用单张 PNG', () => {
    expect(main).toContain('loadAppIco')
    expect(main).toContain('icon: loadAppIco()')
  })

  it('ico 随安装包一起分发（asar 内读不到）', () => {
    expect(pkg.build.extraResources.some((r) => r.to === 'app.ico')).toBe(true)
  })

  // 用户第 2 项：标题栏必须用新版图标
  it('标题栏按主题取图标且能回落到默认图', () => {
    const tb = readFileSync(path.resolve(__dirname, '../src/components/layout/TitleBar.tsx'), 'utf8')
    expect(tb).toContain('THEME_ICONS')
    expect(tb).toContain('data-app-theme')
  })
})

// v1.4.13-pre9：标题栏/托盘图标发暗、首页推荐误判「未配置 AI」。
describe('图标亮度与桌面一致（pre9）', () => {
  const gen = readFileSync(path.resolve(__dirname, '../scripts/make-theme-icons.cjs'), 'utf8')

  /*
   * 回归锚点：pre7/pre8 的 icon-*.png 用 a = 主题色 × (0.55 + 0.45×亮度)，
   * 整张图被压到 55%~100% 亮度，标题栏里就是一枚灰蒙蒙的图。
   * 现在改成「保留亮度关系、只替换色相」，浅档向白提亮。
   */
  it('不再用乘法压暗整张图', () => {
    expect(gen).not.toContain('0.55+0.45*lum')
  })

  it('浅档向白提亮，而不是压暗', () => {
    expect(gen).toContain('mixToward(tr,tg,tb,255,0.42)')
  })

  it('标题栏与托盘用同一套算法', () => {
    const smooth = (gen.match(/m\*m\*\(3-2\*m\)/g) || []).length
    expect(smooth).toBeGreaterThanOrEqual(2)
  })
})

describe('首页推荐识别 WorkBuddy（pre9）', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/components/DiscoverAiRecommend.tsx'), 'utf8')

  /*
   * 回归锚点：configured 原先只认 baseUrl+apiKey+model 三件套。
   * WorkBuddy 走账号凭据，这三项本来就是空的，于是其它 AI 功能都能用，
   * 唯独首页推荐一直显示「还没有配置 AI」。
   */
  it('WorkBuddy 按 wbModel 判定已配置', () => {
    expect(src).toContain("settings?.source === 'workbuddy'")
    expect(src).toContain('settings.wbModel')
  })

  it('未配置提示区分 WorkBuddy 与普通服务商', () => {
    expect(src).toContain('已选择 WorkBuddy，但还没有选模型')
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

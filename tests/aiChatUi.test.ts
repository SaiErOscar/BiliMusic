/**
 * v1.4.14-pre5 对话式音乐助手 · 对话 UI 契约测试。
 *
 * 与 tests/aiChatAssistant.test.ts（意图引擎的纯逻辑测试）分工不同：
 * 那边测「听不听得懂」，这边测「听懂之后 UI 有没有真的去做」。
 *
 * 组件依赖 PlayerProvider（usePlayer 在 Provider 外会抛错），整棵渲染成本高、
 * 且这里要守的是「分支有没有漏、危险调用有没有混进来」这类结构契约，
 * 所以沿用本项目主流的源码契约断言（见 aiPlaylist / aiRecommend / settingsSplit）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

const read = (rel: string) =>
  readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

const chatSrc = read('../src/components/AiChatAssistant.tsx')
const discoverSrc = read('../src/pages/Discover.tsx')
const css = read('../src/styles/index.css')
const engineSrc = read('../src/services/aiChatAssistant.ts')

describe('对话 UI · 与意图引擎的接口契约', () => {
  it('引擎侧确实导出了 UI 依赖的那几个名字', () => {
    expect(engineSrc).toContain('export async function planAssistantRequest(')
    expect(engineSrc).toContain('export function renderPlanHint(')
    expect(engineSrc).toContain('export const UNKNOWN_REPLY')
  })

  it('planAssistantRequest 按 (AssistantRequest, AiSettings) 两参调用', () => {
    const at = chatSrc.indexOf('planAssistantRequest(')
    expect(at).toBeGreaterThan(-1)
    const slice = chatSrc.slice(at, at + 800)
    expect(slice).toContain('text')
    expect(slice).toContain('currentTrack')
    expect(slice).toContain('timeLabel')
    expect(slice).toContain('config')
  })

  it('currentTrack 只传引擎声明的 title / artist 两个字段', () => {
    expect(chatSrc).toContain('title: player.currentTrack.title')
    expect(chatSrc).toContain('artist: player.currentTrack.artist')
  })

  it('偏好交给 renderPlanHint 转写，不自己拼提示词', () => {
    expect(chatSrc).toContain('renderPlanHint(plan)')
    // 从 @/services/ai 只取配置能力，不直接发模型请求（见下一条）
    expect(chatSrc).toContain("import { getAiConfig, isAiSupported } from '@/services/ai'")
  })

  it('不 import aiChat：所有模型请求都经引擎', () => {
    expect(chatSrc).not.toContain('aiChat(')
  })
})

describe('对话 UI · 六种 intent 都有对应分支', () => {
  it('五个可执行意图各有 case，unknown 走 default 兜底', () => {
    for (const intent of ['recommend', 'playlist', 'search', 'explain', 'control']) {
      expect(chatSrc).toContain("case '" + intent + "':")
    }
    expect(chatSrc).toContain('default:')
  })

  it('recommend 复用 generateRecommendation', () => {
    expect(chatSrc).toContain('generateRecommendation(')
  })

  it('playlist 复用 generateAiPlaylist 与 saveAiPlaylist', () => {
    expect(chatSrc).toContain('generateAiPlaylist(')
    expect(chatSrc).toContain('saveAiPlaylist(')
  })

  it('search 复用既有 searchVideo，并把结果转成可播放 Track', () => {
    expect(chatSrc).toContain('searchVideo(')
    expect(chatSrc).toContain('searchItemToTrack(')
  })

  it('explain 复用 generateTrackInsight，无当前曲目时说清楚而不是瞎编', () => {
    expect(chatSrc).toContain('generateTrackInsight(')
    expect(chatSrc).toContain('现在没有在放的歌')
  })

  it('control 直接调 usePlayer 的动作', () => {
    expect(chatSrc).toContain('player.togglePlay()')
    expect(chatSrc).toContain('player.next()')
    expect(chatSrc).toContain('player.prev()')
  })
})

describe('对话 UI · 没听懂要引导改选', () => {
  it('置信度阈值 0.5，unknown 与低置信同等待遇', () => {
    expect(chatSrc).toContain('CONFIDENCE_FLOOR = 0.5')
    expect(chatSrc).toContain("plan.intent === 'unknown' || plan.confidence < CONFIDENCE_FLOOR")
  })

  it('五个意图候选都在，且是可点击按钮', () => {
    for (const label of ['推荐几首', '做个歌单', '搜 B 站', '解释这首歌', '播放控制']) {
      expect(chatSrc).toContain(label)
    }
    expect(chatSrc).toContain('ai-chat__candidates')
  })

  it('改选之后真的执行，而不是只回一句话', () => {
    expect(chatSrc).toContain('pickIntent')
    expect(chatSrc).toContain('runPlan(plan, seq, turnId, config)')
  })
})

describe('对话 UI · 未配置 AI 的降级', () => {
  it('未配置时给去设置指引', () => {
    expect(chatSrc).toContain('isAiConfigured(config)')
    expect(chatSrc).toContain('去设置')
  })

  it('入口不因未配置而整块消失', () => {
    /*
     * v1.4.14-pre8：对话本体搬进抽屉后，组件里合法的 return null 变成两处——
     * loadConfig 里（取不到配置交给调用方给指引）与 AiChatSheet 里（抽屉关着不挂载）。
     * 要守的语义没变：**入口按钮**无论如何都渲染，不在 render 里被藏掉。
     */
    const bodyAt = chatSrc.indexOf('function AiChatBody()')
    expect(bodyAt).toBeGreaterThan(-1)
    // loadConfig 的 return null 在对话本体内部（取不到配置就交给调用方给指引），
    // 而不是在 render 里把整块藏掉
    const nullAt = chatSrc.indexOf('return null', bodyAt)
    expect(nullAt).toBeGreaterThan(bodyAt)
    expect(nullAt).toBeLessThan(chatSrc.indexOf('className="ai-chat ai-chat--body"'))

    // 入口按钮无条件渲染，不受 open 状态影响
    const btnAt = chatSrc.indexOf('export function AiChatSheetButton')
    expect(btnAt).toBeGreaterThan(-1)
    const btnSrc = chatSrc.slice(btnAt, chatSrc.indexOf('export function AiChatSheet('))
    expect(btnSrc).toContain('和助手说句话')
    expect(btnSrc).not.toContain('return null')
  })

  it('环境不支持时说明是环境原因', () => {
    expect(chatSrc).toContain('isAiSupported()')
    expect(chatSrc).toContain('桌面桥')
  })
})

describe('对话 UI · 不打断播放 / 请求可取消', () => {
  it('用序号作废在途请求（NowPlaying 的 insightSeqRef 范式）', () => {
    expect(chatSrc).toContain('seqRef')
    const guards = chatSrc.split('seq !== seqRef.current').length - 1
    expect(guards).toBeGreaterThanOrEqual(8)
  })

  it('没有会硬停播放的调用', () => {
    expect(chatSrc).not.toContain('player.pause()')
  })

  it('提供取消按钮，取消即自增序号作废', () => {
    expect(chatSrc).toContain('const cancel = useCallback')
    expect(chatSrc).toContain('aria-label="取消这次请求"')
  })
})

describe('对话 UI · 确认框与可访问性', () => {
  it('不使用 window.confirm', () => {
    expect(chatSrc).not.toContain('window.confirm')
  })

  it('保存歌单走 platform.nativeDialog.confirm', () => {
    expect(chatSrc).toContain('platform.nativeDialog?.confirm')
  })

  it('交互控件都有 aria-label', () => {
    const labels = chatSrc.match(/aria-label=/g) || []
    expect(labels.length).toBeGreaterThanOrEqual(6)
    expect(chatSrc).toContain('aria-label="用一句话告诉助手你想听什么"')
    expect(chatSrc).toContain('aria-label="发送这句话"')
  })

  it('状态变化有文字，不只靠颜色', () => {
    expect(chatSrc).toContain('正在理解…')
    expect(chatSrc).toContain('处理中…')
    expect(chatSrc).toContain('role="status"')
  })
})

/*
 * v1.4.14-pre8（用户第 4 项）：入口从「页面顶部常驻」改成「为你推荐旁的按钮 + 抽屉」。
 *
 * 用户原话：做成「为你推荐」旁的按钮，需要时在抽屉中打开，
 * 避免占用启动后「为你推荐」的推荐位、占据焦点，应将焦点还给推荐。
 *
 * 所以原来的「必须排在推荐板块之前」断言被反过来了：
 * 现在要守的是「发现页里根本不出现常驻的助手板块」。
 */
describe('对话 UI · 入口是「为你推荐」旁的按钮，抽屉里打开', () => {
  const recommendSrc = read('../src/components/DiscoverAiRecommend.tsx')

  it('发现页不再常驻渲染助手板块', () => {
    expect(discoverSrc).not.toContain('<AiChatAssistant />')
    expect(discoverSrc).not.toContain("from '@/components/AiChatAssistant'")
    // 助手入口搬进了推荐板块组件
    expect(recommendSrc).toContain("from '@/components/AiChatAssistant'")
  })

  it('入口按钮挂在「为你推荐」标题行里（与「换一批」同一容器）', () => {
    const headAt = recommendSrc.indexOf('className="discover-ai__head"')
    expect(headAt).toBeGreaterThan(-1)
    // 按钮容器在标题行内部；从容器位置往后找按钮，避开 off 分支里的那一处
    const actsAt = recommendSrc.indexOf('className="discover-ai__acts"', headAt)
    expect(actsAt).toBeGreaterThan(headAt)
    const btnAt = recommendSrc.indexOf('<AiChatSheetButton', actsAt)
    expect(btnAt).toBeGreaterThan(actsAt)
    // 按钮仍在标题行闭合之前（标题行之后紧跟的是「未配置」提示块），即真的在那一行里
    // v1.4.14-pre10：提示块的渲染条件加了 settingsReady 前置，锚点随之更新
    expect(btnAt).toBeLessThan(recommendSrc.indexOf('{settingsReady && !configured && (', btnAt))
  })

  it('抽屉用既有的 ai-sheet__* 范式，不另起一套外壳', () => {
    expect(chatSrc).toContain('ai-sheet-overlay')
    expect(chatSrc).toContain('ai-sheet__head')
    expect(chatSrc).toContain('ai-sheet__close')
    expect(chatSrc).toContain('ai-sheet__body')
    expect(chatSrc).toContain('role="dialog"')
    expect(chatSrc).toContain('aria-modal="true"')
  })

  it('关闭时对话本体不挂载：初始加载不占推荐位、不抢焦点', () => {
    // 抽屉未打开直接 return null —— DOM 里没有输入框，自然无从抢焦点
    const sheetAt = chatSrc.indexOf('export function AiChatSheet(')
    expect(sheetAt).toBeGreaterThan(-1)
    const sheetSrc = chatSrc.slice(sheetAt)
    const guardAt = sheetSrc.indexOf('if (!open) return null')
    expect(guardAt).toBeGreaterThan(-1)
    // 守卫必须在渲染对话本体之前
    expect(guardAt).toBeLessThan(sheetSrc.indexOf('<AiChatBody />'))
  })

  it('打开后焦点交给输入框，且可 Esc / 点遮罩关闭', () => {
    expect(chatSrc).toContain("querySelector<HTMLInputElement>('.ai-chat__input')")
    expect(chatSrc).toContain("e.key === 'Escape'")
    expect(chatSrc).toContain('onClick={onClose}')
    expect(chatSrc).toContain('aria-label="关闭对话助手"')
  })
})

describe('对话 UI · 样式只追加且只用既有 token', () => {
  it('新增样式全部用 ai-chat 前缀，不撞既有类名', () => {
    const blocks = css.match(/^\.ai-chat[\w-]*/gm) || []
    expect(blocks.length).toBeGreaterThan(10)
  })

  it('引用的 CSS 变量都真实存在（不存在的变量会静默失效）', () => {
    const start = css.indexOf('/* ===== v1.4.14-pre5 对话式音乐助手')
    expect(start).toBeGreaterThan(-1)
    const section = css.slice(start)
    const vars = Array.from(new Set(section.match(/var\((--[\w-]+)\)/g) || []))
    expect(vars.length).toBeGreaterThan(0)
    for (const v of vars) {
      const name = v.slice(4, -1)
      expect(css).toContain(name + ':')
    }
  })

  it('index.css 没有被整体重写（远大于历史事故的 2125 行）', () => {
    expect(css.split('\n').length).toBeGreaterThan(6000)
  })
})

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
    // 组件永远渲染入口：唯一的 return null 在 loadConfig 里（取不到配置就交给调用方给指引），
    // 而不是在 render 里把整块藏掉——藏起来等于没有入口。
    const sectionAt = chatSrc.indexOf('<section className="ai-chat"')
    expect(sectionAt).toBeGreaterThan(-1)
    const nullAt = chatSrc.indexOf('return null')
    expect(nullAt).toBeGreaterThan(-1)
    expect(nullAt).toBeLessThan(sectionAt)
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

describe('对话 UI · 入口可发现', () => {
  it('挂在发现页且排在推荐板块之前', () => {
    expect(discoverSrc).toContain("import AiChatAssistant from '@/components/AiChatAssistant'")
    const chatAt = discoverSrc.indexOf('<AiChatAssistant />')
    const recAt = discoverSrc.indexOf('<DiscoverAiRecommend')
    expect(chatAt).toBeGreaterThan(-1)
    expect(recAt).toBeGreaterThan(-1)
    expect(chatAt).toBeLessThan(recAt)
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

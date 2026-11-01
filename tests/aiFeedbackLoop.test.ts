// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { renderExplicitFeedback, renderLearnedSummary, renderProfileContext } from '../src/services/aiProfileContext'
import { buildRecommendPrompt, excludeDisliked } from '../src/services/aiRecommend'
import type { AiPlaylistCandidate } from '../src/services/aiPlaylist'
import type { AiSettings } from '../src/types'

// v1.4.14-pre3：AI 推荐反馈闭环（喜欢 / 不感兴趣）。
//
// 主进程 profile.ts 的 IPC 与 Electron 依赖无法在 jsdom 里直接跑，
// 所以互斥逻辑用「读源码断言实现方式」+ 纯函数断言两头守住：
// 前者防止实现被换成不互斥的写法，后者锁住渲染与提示词口径。

const profileSrc = readFileSync(path.resolve(__dirname, '../electron/profile.ts'), 'utf8')
const componentSrc = readFileSync(
  path.resolve(__dirname, '../src/components/DiscoverAiRecommend.tsx'),
  'utf8',
)
const cssSrc = readFileSync(path.resolve(__dirname, '../src/styles/index.css'), 'utf8')

function settings(): AiSettings {
  return {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: 'k',
    proxyMode: 'system',
    proxyUrl: '',
    recommendMode: 'click',
    userProfile: { text: '', updatedAt: '' },
    persona: '',
  }
}

function cand(idx: number, id: string, artist: string, title: string): AiPlaylistCandidate {
  return {
    index: idx,
    track: {
      id,
      title,
      artist,
      coverUrl: '',
      duration: 0,
      videoUrl: '',
      bvid: '',
      playCount: 0,
      isLiked: false,
    },
  }
}

describe('学习信号字段扩展（数据向后兼容）', () => {
  it('接口含 liked / disliked，且与 played / skipped 同构', () => {
    expect(profileSrc).toContain('liked: Record<string, number>')
    expect(profileSrc).toContain('disliked: Record<string, number>')
  })

  it('读取时按空对象兜底：老文件缺字段不丢历史数据', () => {
    // 逐字段 || {} 兜底，而不是整体判空后重置
    expect(profileSrc).toContain('liked: raw.liked || {}')
    expect(profileSrc).toContain('disliked: raw.disliked || {}')
    // 老字段仍原样读回
    expect(profileSrc).toContain('played: raw.played || {}')
    expect(profileSrc).toContain('skipped: raw.skipped || {}')
  })

  it('备份恢复路径也带上新字段（否则恢复后反馈丢失）', () => {
    expect(profileSrc).toContain('liked: s?.liked || {}')
    expect(profileSrc).toContain('disliked: s?.disliked || {}')
  })

  it('渲染摘要里显式表态与隐式行为分开陈述', () => {
    const signals = {
      played: { 'A|a': 2 },
      skipped: {},
      liked: { 'B|b': 3 },
      disliked: { 'C|c': 1 },
      playlistSaved: { times: 0, tracks: 0 },
      lyricReverted: 0,
      updatedAt: '',
    }
    // renderLearned 与 renderLearnedSummary 同口径，这里用渲染侧验证措辞
    const text = renderLearnedSummary(signals)
    expect(text).toContain('明确喜欢：B|b ×3')
    expect(text).toContain('明确不感兴趣：C|c ×1')
    // 隐式信号没被新字段挤掉
    expect(text).toContain('常被播放：A|a ×2')
  })
})

describe('喜欢 / 不感兴趣互斥', () => {
  it('记一侧时清掉对侧计数，不会同时存在', () => {
    // 实现方式锚点：互斥由 applyExplicitFeedback 单点保证
    expect(profileSrc).toContain('function applyExplicitFeedback')
    expect(profileSrc).toContain("delete (kind === 'liked' ? s.disliked : s.liked)[key]")
  })

  it('liked / disliked 走同一条互斥路径，played / skipped 保持原样', () => {
    expect(profileSrc).toContain("kind === 'liked' && key")
    expect(profileSrc).toContain("kind === 'disliked' && key")
    expect(profileSrc).toContain("s.played[key] = (s.played[key] || 0) + 1")
    expect(profileSrc).toContain("s.skipped[key] = (s.skipped[key] || 0) + 1")
  })
})

describe('显式反馈渲染成提示词段落', () => {
  it('都为空的上下文不产出段落（不污染 prompt）', () => {
    expect(renderExplicitFeedback({ profile: '', learned: '', liked: [], disliked: [] })).toBe('')
    expect(renderExplicitFeedback({ profile: '', learned: '' })).toBe('')
  })

  it('不感兴趣带「必须避开」的行动指令', () => {
    const text = renderExplicitFeedback({
      profile: '',
      learned: '',
      liked: ['周杰伦|晴天'],
      disliked: ['某电子|吵闹'],
    })
    expect(text).toContain('明确表示喜欢：周杰伦|晴天')
    expect(text).toContain('必须避开')
    expect(text).toContain('某电子|吵闹')
  })

  it('画像上下文渲染把显式反馈并进去（歌单 / 歌词同享）', () => {
    const text = renderProfileContext({
      profile: '喜欢钢琴',
      learned: '',
      liked: ['A|a'],
      disliked: ['B|b'],
    })
    expect(text).toContain('用户画像：喜欢钢琴')
    expect(text).toContain('明确表示喜欢：A|a')
    expect(text).toContain('必须避开')
  })
})

describe('反馈真正影响下次推荐', () => {
  const pool = [cand(1, 'a', '周杰伦', '晴天'), cand(2, 'b', '某电子', '吵闹'), cand(3, 'c', 'C', 'c3'), cand(4, 'd', 'D', 'd4')]

  it('不感兴趣的曲目从候选池剔除，并重排编号', () => {
    const kept = excludeDisliked(pool, ['某电子|吵闹'])
    expect(kept.map((c) => c.track.id)).toEqual(['a', 'c', 'd'])
    // 编号连续，提示词里不出现跳号
    expect(kept.map((c) => c.index)).toEqual([1, 2, 3])
  })

  it('剔除后不足 3 首时退回原池，不让推荐直接失败', () => {
    const kept = excludeDisliked(pool, ['周杰伦|晴天', '某电子|吵闹'])
    expect(kept).toHaveLength(4)
  })

  it('没有不感兴趣时原样返回，不做无谓拷贝', () => {
    expect(excludeDisliked(pool, [])).toBe(pool)
  })

  it('提示词里能看到喜欢 / 不感兴趣段落', () => {
    const { system, user } = buildRecommendPrompt({
      settings: settings(),
      limit: 5,
      contextLabel: '晚上',
      hour: 20,
      profileContext: {
        profile: '喜欢安静的女声',
        learned: '常被播放：A|a ×2',
        liked: ['周杰伦|晴天'],
        disliked: ['某电子|吵闹'],
      },
      portraitText: '总播放 10 次',
      hasHistory: true,
      pool,
    })
    expect(user).toContain('明确表示喜欢：周杰伦|晴天')
    expect(user).toContain('某电子|吵闹')
    // 明确告诉模型要避开，而不只是陈述
    expect(user).toContain('必须避开')
    expect(system).toContain('不得推荐')
    // 既有注入项没被挤掉
    expect(user).toContain('用户自述偏好：喜欢安静的女声')
    expect(user).toContain('从使用中观察到的偏好')
    expect(user).toContain('当前时间：晚上（20 点）')
    expect(user).toContain('候选曲目：')
  })

  it('没有反馈时提示词不出现空段落', () => {
    const { user } = buildRecommendPrompt({
      settings: settings(),
      limit: 5,
      contextLabel: '下午',
      hour: 15,
      profileContext: { profile: '', learned: '', liked: [], disliked: [] },
      portraitText: '',
      hasHistory: false,
      pool,
    })
    expect(user).not.toContain('显式反馈')
    expect(user).toContain('（暂无播放记录）')
  })

  it('generateRecommendation 确实用了剔除与提示词构造', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiRecommend.ts'), 'utf8')
    expect(src).toContain('excludeDisliked(dedupedPool, profileContext.disliked')
    expect(src).toContain('buildRecommendPrompt({')
    expect(src).toContain('renderExplicitFeedback(profileContext)')
  })
})

describe('UI：喜欢 / 不感兴趣两个操作', () => {
  it('每项都有两个反馈按钮，且带可见文字与 aria-label', () => {
    expect(componentSrc).toContain("sendFeedback(t.id, 'liked'")
    expect(componentSrc).toContain("sendFeedback(t.id, 'disliked'")
    expect(componentSrc).toContain("'已喜欢'")
    expect(componentSrc).toContain("'已忽略'")
    expect(componentSrc).toContain('aria-pressed')
    expect(componentSrc).toContain('aria-label')
  })

  it('不感兴趣后该项变灰（不是静默记录）', () => {
    expect(componentSrc).toContain('discover-ai__item--muted')
    expect(cssSrc).toContain('.discover-ai__item--muted')
  })

  it('状态不只靠颜色：按钮文案随状态切换', () => {
    expect(componentSrc).toContain("state === 'liked' ? '已喜欢' : '喜欢'")
    expect(componentSrc).toContain("disliked ? '已忽略' : '不感兴趣'")
  })

  it('button 不嵌套 button：列表项改成容器 + 播放按钮', () => {
    expect(componentSrc).toContain('discover-ai__play')
    expect(componentSrc).not.toMatch(/className="discover-ai__item"[\s\S]{0,400}<img/)
  })

  it('平台能力缺失时整组反馈按钮不渲染（静默降级）', () => {
    expect(componentSrc).toContain('platform.userProfile && (')
    // 调用侧一律可选链，缺能力也不抛
    expect(componentSrc).toContain('platform.userProfile?.record(')
  })

  it('已显式表态的曲目不再补记 skipped（避免同一件事计两次）', () => {
    expect(componentSrc).toContain('!feedbackRef.current[t.id]')
  })
})

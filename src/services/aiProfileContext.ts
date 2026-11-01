/**
 * v1.4.13-pre2 画像上下文：手写画像（外部文件）+ 学习信号摘要。
 *
 * 抽成独立模块而不是留在 aiRecommend 里，是因为三个 AI 服务（推荐/歌单/歌词）都要用它——
 * 放在任一服务里都会形成循环依赖（aiPlaylist → aiRecommend → aiPlaylist）。
 *
 * 每次调用都现读文件、不缓存：用户用编辑器改完即刻生效，这正是把画像搬出设置页的初衷。
 */

import { platform } from '@/platform'

export interface ProfileContext {
  /** 用户手写的画像正文 */
  profile: string
  /** 学习信号摘要（已渲染成文本） */
  learned: string
  /**
   * v1.4.14-pre3 显式「喜欢」的曲目 key（artist|title），按次数降序。
   * 与 played 的区别：played 是被动播放，liked 是用户主动点的按钮，权重更高。
   */
  liked?: string[]
  /** v1.4.14-pre3 显式「不感兴趣」的曲目 key，按次数降序 */
  disliked?: string[]
}

export const EMPTY_PROFILE_CONTEXT: ProfileContext = { profile: '', learned: '', liked: [], disliked: [] }

/** 把学习信号渲染成紧凑文本（与主进程 profile.ts 的 renderLearned 同口径） */
export function renderLearnedSummary(raw: unknown): string {
  const s = raw as
    | {
        played?: Record<string, number>
        skipped?: Record<string, number>
        liked?: Record<string, number>
        disliked?: Record<string, number>
        playlistSaved?: { times: number; tracks: number }
        lyricReverted?: number
      }
    | null
  if (!s) return ''
  const top = (rec?: Record<string, number>) =>
    Object.entries(rec || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => k + ' ×' + v)
  const lines: string[] = []
  // v1.4.14-pre3：显式表态（liked / disliked）与隐式行为分开陈述；
  // 老数据没有这两个字段，top 内部按空对象兜底
  const played = top(s.played)
  const skipped = top(s.skipped)
  const liked = top(s.liked)
  const disliked = top(s.disliked)
  if (played.length) lines.push('常被播放：' + played.join('、'))
  if (skipped.length) lines.push('常被跳过：' + skipped.join('、'))
  if (liked.length) lines.push('明确喜欢：' + liked.join('、'))
  if (disliked.length) lines.push('明确不感兴趣：' + disliked.join('、'))
  if (s.playlistSaved && s.playlistSaved.times > 0) {
    lines.push('AI 歌单被保存 ' + s.playlistSaved.times + ' 次，累计 ' + s.playlistSaved.tracks + ' 首')
  }
  if (s.lyricReverted && s.lyricReverted > 0) lines.push('歌词增强被还原 ' + s.lyricReverted + ' 次')
  return lines.join('\n')
}

/** 从学习信号里取出某个字段的 key，按次数降序截断 */
function topKeys(rec: Record<string, number> | undefined, limit: number): string[] {
  return Object.entries(rec || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k)
}

/**
 * v1.4.14-pre3：把显式表态（喜欢 / 不感兴趣）渲染成提示词段落。
 *
 * 与 renderLearnedSummary 分开，是因为两者的用法不同：隐式信号只陈述，
 * 显式信号还要给出行动指令（不感兴趣的必须避开），措辞不能混在一起。
 */
export function renderExplicitFeedback(ctx: ProfileContext, limit = 12): string {
  const liked = (ctx.liked || []).slice(0, limit)
  const disliked = (ctx.disliked || []).slice(0, limit)
  if (!liked.length && !disliked.length) return ''
  const lines: string[] = []
  if (liked.length) lines.push('明确表示喜欢：' + liked.join('、'))
  if (disliked.length) lines.push('明确表示不感兴趣（必须避开，不要再推荐）：' + disliked.join('、'))
  return lines.join('\n')
}

/** 读画像上下文；任何失败都退化为空，绝不阻断 AI 功能 */
export async function loadProfileContext(): Promise<ProfileContext> {
  const cap = platform.userProfile
  // v1.4.14-pre3 降级：Web / 移动端没有 userProfile 能力，反馈功能整体静默关闭
  if (!cap) return EMPTY_PROFILE_CONTEXT
  try {
    const [read, learnedRaw] = await Promise.all([cap.read(), cap.getLearned()])
    const raw = learnedRaw as {
      liked?: Record<string, number>
      disliked?: Record<string, number>
    } | null
    return {
      profile: (read?.text || '').trim(),
      learned: renderLearnedSummary(learnedRaw),
      // 老文件没有这两个字段，topKeys 内部按空对象兜底
      liked: topKeys(raw?.liked, 12),
      disliked: topKeys(raw?.disliked, 12),
    }
  } catch {
    return EMPTY_PROFILE_CONTEXT
  }
}

/**
 * 把画像上下文渲染成提示词前置段落；都为空时返回空串。
 *
 * v1.4.14-pre3：显式表态（喜欢 / 不感兴趣）也并进来，
 * 这样歌单与歌词两个服务不用各自改动就能吃到反馈。
 * 注意 learned 只含隐式信号（播放 / 跳过），与 explicit 不重叠，不会重复陈述。
 */
export function renderProfileContext(ctx: ProfileContext): string {
  return [
    ctx.profile ? '用户画像：' + ctx.profile : '',
    ctx.learned ? '从使用中观察到的偏好：\n' + ctx.learned : '',
    renderExplicitFeedback(ctx),
  ]
    .filter(Boolean)
    .join('\n\n')
}

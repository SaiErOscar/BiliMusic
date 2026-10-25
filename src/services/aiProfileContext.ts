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
}

export const EMPTY_PROFILE_CONTEXT: ProfileContext = { profile: '', learned: '' }

/** 把学习信号渲染成紧凑文本（与主进程 profile.ts 的 renderLearned 同口径） */
export function renderLearnedSummary(raw: unknown): string {
  const s = raw as
    | {
        played?: Record<string, number>
        skipped?: Record<string, number>
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
  const played = top(s.played)
  const skipped = top(s.skipped)
  if (played.length) lines.push('常被播放：' + played.join('、'))
  if (skipped.length) lines.push('常被跳过：' + skipped.join('、'))
  if (s.playlistSaved && s.playlistSaved.times > 0) {
    lines.push('AI 歌单被保存 ' + s.playlistSaved.times + ' 次，累计 ' + s.playlistSaved.tracks + ' 首')
  }
  if (s.lyricReverted && s.lyricReverted > 0) lines.push('歌词增强被还原 ' + s.lyricReverted + ' 次')
  return lines.join('\n')
}

/** 读画像上下文；任何失败都退化为空，绝不阻断 AI 功能 */
export async function loadProfileContext(): Promise<ProfileContext> {
  const cap = platform.userProfile
  if (!cap) return EMPTY_PROFILE_CONTEXT
  try {
    const [read, learnedRaw] = await Promise.all([cap.read(), cap.getLearned()])
    return {
      profile: (read?.text || '').trim(),
      learned: renderLearnedSummary(learnedRaw),
    }
  } catch {
    return EMPTY_PROFILE_CONTEXT
  }
}

/** 把画像上下文渲染成提示词前置段落；都为空时返回空串 */
export function renderProfileContext(ctx: ProfileContext): string {
  return [
    ctx.profile ? '用户画像：' + ctx.profile : '',
    ctx.learned ? '从使用中观察到的偏好：\n' + ctx.learned : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

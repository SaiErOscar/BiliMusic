// v1.4.13-pre1 用户画像外部文件 + 学习记录
//
// 需求（用户明确）：画像不在设置页编辑，改为点击打开本地文件、用编辑器改。
// 因此画像必须落成真实文件（localStorage 打不开），并处理外部编辑带来的各种边界。
//
// 文件布局（均在 userData 下）：
// - user-profile.md   用户手写画像。应用只在用户显式「应用学习结果」时追加自动小节。
// - ai-learned.json   从使用行为沉淀的偏好信号，供下次调用注入。

import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'

/** 画像文件大小上限：防止用户粘贴长文把 prompt 撑爆 */
export const PROFILE_MAX_BYTES = 8 * 1024

/** 自动学习小节的标题；追加时据此判断是否已存在 */
const LEARNED_SECTION = '## AI 记录（自动生成，勿手改）'

const PROFILE_HEADER = [
  '# 用户画像',
  '',
  '<!--',
  '  这份文件用于让 AI 更懂你的口味，内容会随每次 AI 请求发送给你所配置的 AI 服务商。',
  '  只存本地，不上传开发者。',
  '',
  '  写什么都行：喜欢的曲风、常听的场景、不想听到的类型、讨厌的编曲……',
  '  例：喜欢安静的女声和钢琴；写代码时不想听人声；讨厌过于吵闹的电子乐。',
  '-->',
  '',
  '',
].join('\n')

export interface LearnedSignals {
  /** 推荐曲目被播放的次数，key 为 artist|title 归一化串 */
  played: Record<string, number>
  /** 推荐曲目被跳过的次数 */
  skipped: Record<string, number>
  /** v1.4.14-pre3 显式「喜欢」的次数（用户主动点按钮，区别于隐式的 played） */
  liked: Record<string, number>
  /** v1.4.14-pre3 显式「不感兴趣」的次数（区别于隐式的 skipped） */
  disliked: Record<string, number>
  /** 歌单被保存的次数与累计曲目数 */
  playlistSaved: { times: number; tracks: number }
  /** 歌词增强被还原的次数（说明不合口味） */
  lyricReverted: number
  updatedAt: string
}

const EMPTY_LEARNED: LearnedSignals = {
  played: {},
  skipped: {},
  liked: {},
  disliked: {},
  playlistSaved: { times: 0, tracks: 0 },
  lyricReverted: 0,
  updatedAt: '',
}

function profilePath(): string {
  return path.join(app.getPath('userData'), 'user-profile.md')
}
function learnedPath(): string {
  return path.join(app.getPath('userData'), 'ai-learned.json')
}

/** 读画像：不存在按空处理，超限截断，剥 BOM */
async function readProfile(): Promise<string> {
  try {
    const buf = await fs.readFile(profilePath())
    const slice = buf.subarray(0, PROFILE_MAX_BYTES)
    return slice.toString('utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

/**
 * 首次创建画像文件（含注释头）。已存在则不动——绝不清空用户内容。
 * 用临时文件 + rename 保证原子性，避免与外部编辑器并发写出半截文件。
 */
async function ensureProfileFile(): Promise<string> {
  const target = profilePath()
  try {
    await fs.access(target)
    return target
  } catch {
    /* 不存在，继续创建 */
  }
  const tmp = target + '.tmp'
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(tmp, PROFILE_HEADER, 'utf8')
  await fs.rename(tmp, target)
  return target
}

/**
 * 读学习信号。
 *
 * v1.4.14-pre3：老文件没有 liked/disliked 字段，逐字段 `|| {}` 兜底而不是整体判空——
 * 缺新字段时历史 played/skipped 必须原样保留，不能因为升级就把老数据丢掉。
 */
async function readLearned(): Promise<LearnedSignals> {
  try {
    const raw = JSON.parse(await fs.readFile(learnedPath(), 'utf8')) as Partial<LearnedSignals>
    return {
      played: raw.played || {},
      skipped: raw.skipped || {},
      liked: raw.liked || {},
      disliked: raw.disliked || {},
      playlistSaved: raw.playlistSaved || { times: 0, tracks: 0 },
      lyricReverted: raw.lyricReverted || 0,
      updatedAt: raw.updatedAt || '',
    }
  } catch {
    return { ...EMPTY_LEARNED }
  }
}

async function writeLearned(signals: LearnedSignals): Promise<void> {
  signals.updatedAt = new Date().toISOString()
  await fs.mkdir(path.dirname(learnedPath()), { recursive: true })
  await fs.writeFile(learnedPath(), JSON.stringify(signals, null, 2), 'utf8')
}

/** 显式表态的两种取值（用户主动点的按钮，区别于 played/skipped 这类隐式行为） */
export type ExplicitFeedbackKind = 'liked' | 'disliked'

/** 'profile:record' 接受的全部信号类型 */
export type RecordKind = 'played' | 'skipped' | 'lyricReverted' | ExplicitFeedbackKind

/**
 * 记一次显式表态，并保证 liked / disliked 互斥。
 *
 * 选择「清零对侧」而不是「打标记」：
 * - 打标记要额外存时间与顺序，读侧还得再判一次优先级；而老文件没有这些字段，
 *   等于给向后兼容又加一层分支。
 * - 清零之后两个 map 天然互推（同一个 key 不可能同时出现在两侧），
 *   renderLearned 与提示词注入都不用再写互斥判断，任何读取方都不会看到矛盾状态。
 * 代价：留不下「先喜欢又反悔」的摇摆史。这类历史对推荐没有增益，
 * 反而会让模型在两种相反信号之间来回权衡，所以是刻意放弃的。
 */
function applyExplicitFeedback(s: LearnedSignals, key: string, kind: ExplicitFeedbackKind): void {
  delete (kind === 'liked' ? s.disliked : s.liked)[key]
  const same = kind === 'liked' ? s.liked : s.disliked
  same[key] = (same[key] || 0) + 1
}

/** 把学习信号渲染成给模型的紧凑文本；无信号返回空串 */
export function renderLearned(signals: LearnedSignals, limit = 8): string {
  const top = (rec: Record<string, number>) =>
    Object.entries(rec)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, v]) => k + ' ×' + v)
  const lines: string[] = []
  // v1.4.14-pre3：老信号对象可能没有 liked/disliked（备份恢复、旧文件），读侧一律兜底
  const played = top(signals.played)
  const skipped = top(signals.skipped)
  const liked = top(signals.liked || {})
  const disliked = top(signals.disliked || {})
  if (played.length) lines.push('常被播放：' + played.join('、'))
  if (skipped.length) lines.push('常被跳过：' + skipped.join('、'))
  if (liked.length) lines.push('明确喜欢：' + liked.join('、'))
  if (disliked.length) lines.push('明确不感兴趣：' + disliked.join('、'))
  if (signals.playlistSaved.times > 0) {
    lines.push('AI 歌单被保存 ' + signals.playlistSaved.times + ' 次，累计 ' + signals.playlistSaved.tracks + ' 首')
  }
  if (signals.lyricReverted > 0) lines.push('歌词增强被还原 ' + signals.lyricReverted + ' 次')
  return lines.join('\n')
}

/** 把学习结果写入画像文件末尾的自动小节；小节已存在则替换其内容 */
async function applyLearnedToProfile(): Promise<{ ok: boolean; message: string }> {
  const signals = await readLearned()
  const body = renderLearned(signals)
  if (!body) return { ok: false, message: '还没有可应用的学习结果' }
  await ensureProfileFile()
  const current = await readProfile()
  const section = LEARNED_SECTION + '\n\n' + body + '\n'
  const idx = current.indexOf(LEARNED_SECTION)
  const next =
    idx >= 0
      ? current.slice(0, idx).replace(/\s+$/, '') + '\n\n' + section
      : current.replace(/\s+$/, '') + '\n\n' + section
  const tmp = profilePath() + '.tmp'
  await fs.writeFile(tmp, next, 'utf8')
  await fs.rename(tmp, profilePath())
  return { ok: true, message: '已写入画像文件末尾的自动小节' }
}

export function registerProfileHandlers(): void {
  ipcMain.handle('profile:read', async () => ({ text: await readProfile(), path: profilePath() }))
  ipcMain.handle('profile:open', async () => {
    try {
      const target = await ensureProfileFile()
      const err = await shell.openPath(target)
      return err ? { ok: false, message: err } : { ok: true, path: target }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('profile:reveal', async () => {
    try {
      const target = await ensureProfileFile()
      shell.showItemInFolder(target)
      return { ok: true, path: target }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('profile:get-learned', async () => readLearned())
  // v1.4.13-pre4 备份恢复：写回画像正文与学习信号
  ipcMain.handle('profile:write-text', async (_e, text: string) => {
    try {
      const tmp = profilePath() + '.tmp'
      await fs.mkdir(path.dirname(profilePath()), { recursive: true })
      await fs.writeFile(tmp, String(text || ''), 'utf8')
      await fs.rename(tmp, profilePath())
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('profile:set-learned', async (_e, signals: unknown) => {
    try {
      const s = signals as Partial<LearnedSignals>
      await writeLearned({
        played: s?.played || {},
        skipped: s?.skipped || {},
        liked: s?.liked || {},
        disliked: s?.disliked || {},
        playlistSaved: s?.playlistSaved || { times: 0, tracks: 0 },
        lyricReverted: s?.lyricReverted || 0,
        updatedAt: '',
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('profile:apply-learned', async () => applyLearnedToProfile())
  ipcMain.handle('profile:clear-learned', async () => {
    await writeLearned({ ...EMPTY_LEARNED })
    return { ok: true }
  })
  ipcMain.handle('profile:record', async (_e, kind: RecordKind, key?: string) => {
    const s = await readLearned()
    if (kind === 'played' && key) s.played[key] = (s.played[key] || 0) + 1
    else if (kind === 'skipped' && key) s.skipped[key] = (s.skipped[key] || 0) + 1
    else if (kind === 'liked' && key) applyExplicitFeedback(s, key, 'liked')
    else if (kind === 'disliked' && key) applyExplicitFeedback(s, key, 'disliked')
    else if (kind === 'lyricReverted') s.lyricReverted += 1
    await writeLearned(s)
    return { ok: true }
  })
  ipcMain.handle('profile:record-playlist', async (_e, tracks: number) => {
    const s = await readLearned()
    s.playlistSaved.times += 1
    s.playlistSaved.tracks += Math.max(0, tracks || 0)
    await writeLearned(s)
    return { ok: true }
  })
}

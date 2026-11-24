/**
 * v1.4.17-pre1 本地歌词文件：同目录同名自动匹配 + 手动导入。
 *
 * 用户的第 3 项要求：
 * - 本地歌曲支持联网搜索歌词，**也支持本地歌词**；
 * - 若 .lrc 与音频在同一目录、且文件名除扩展名外完全相同，**直接匹配、无需手动导入**；
 * - B 站视频也额外支持本地导入歌词。
 *
 * 本文件只做纯逻辑（路径推导 / 内容解析 / 缓存键），
 * 真正的读盘在主进程（electron/lyricsApi.ts），不在这里碰 fs。
 */

/** 歌词文件扩展名（小写，带点） */
export const LYRIC_EXTENSIONS = ['.lrc', '.txt'] as const

/**
 * 由音频文件路径推导「同目录同名」的歌词文件候选路径。
 *
 * 口径：**文件名除扩展名外完全相同**才算自动匹配，且必须是同一目录。
 * 因此 `D:/m/歌.mp3` → `D:/m/歌.lrc`，不会去匹配 `D:/m/歌 - 副本.lrc`
 * 或子目录里的同名文件——用户说的「完全相同」就是这个意思。
 *
 * @returns 按优先级排列的候选路径（.lrc 优先于 .txt）
 */
export function siblingLyricPaths(audioPath: string): string[] {
  if (!audioPath) return []
  const normalized = audioPath.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const dir = slash >= 0 ? normalized.slice(0, slash) : ''
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const dot = base.lastIndexOf('.')
  // 没有扩展名（或点在开头，如 .hidden）时整体当文件名
  const stem = dot > 0 ? base.slice(0, dot) : base
  if (!stem) return []
  return LYRIC_EXTENSIONS.map((ext) => (dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`))
}

/**
 * 手动导入歌词的缓存键。
 *
 * 本地曲目用 `localPath`，B 站曲目用 `bvid`/id——两者都能导入本地歌词，
 * 但必须落成不同的键，否则同一台机器上「某首本地歌」与「某个 BV」会互相覆盖。
 * 统一加 `local:` 前缀，与联网歌词的缓存（按 track.id）区分开。
 */
export function localLyricCacheKey(track: { id?: string; localPath?: string; bvid?: string }): string {
  const anchor = track.localPath || track.bvid || track.id || ''
  return `local:${anchor.toLowerCase()}`
}

/** 判断一段内容是否带时间轴（决定 synced） */
export function looksSynced(content: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(content)
}

/**
 * 校验并清理导入的歌词文本。
 *
 * 拒绝的情况：
 * - 空内容 / 全是空白；
 * - 二进制垃圾（含 NUL 或大量不可打印字符）——用户很可能选错了文件。
 *
 * 只做「能不能用」的判断，不在这里解析成行：解析复用 lyrics.ts 的 parseLrc，
 * 保证本地歌词与联网歌词走同一条时间轴逻辑。
 */
export type LyricFileCheck =
  | { ok: true; content: string; synced: boolean }
  | { ok: false; reason: 'empty' | 'binary' }

export function checkLyricFileContent(raw: string): LyricFileCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  // 去 BOM：Windows 记事本存 UTF-8 默认带 BOM，留着会让第一行的时间标签解析失败
  const content = raw.replace(/^\uFEFF/, '')
  if (!content.trim()) return { ok: false, reason: 'empty' }

  // 不可打印字符占比过高 → 当作选错了文件（音频/图片被当歌词导入）
  let bad = 0
  const sample = content.slice(0, 4000)
  for (const ch of sample) {
    const code = ch.codePointAt(0) || 0
    if (code === 0) return { ok: false, reason: 'binary' }
    if (code < 32 && ch !== '\n' && ch !== '\r' && ch !== '\t') bad++
  }
  if (sample.length > 0 && bad / sample.length > 0.02) return { ok: false, reason: 'binary' }

  return { ok: true, content, synced: looksSynced(content) }
}

/** 从文件路径取文件名（含扩展名），用于界面提示 */
export function fileNameOf(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const i = normalized.lastIndexOf('/')
  return i >= 0 ? normalized.slice(i + 1) : normalized
}

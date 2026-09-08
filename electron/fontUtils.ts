/**
 * v1.3.8 系统字体解析纯函数（不依赖 electron，便于单元测试）
 */

export const FONT_FILE_RE = /\.(ttf|otf|ttc)$/i

/** 去重收集一个字体名（去空白后非空才收） */
export function pushUnique(set: Set<string>, name: string): void {
  const v = name.trim()
  if (v) set.add(v)
}

/**
 * Windows：解析 `reg query ...Fonts` 的 stdout。
 * 行形如：`    Arial Bold    REG_SZ    aribtl.ttf`（键名 2+空格 类型 2+空格 文件）。
 * 只取指向字体文件的项，键名去掉 `(TrueType)`/`(OpenType)` 后缀与尾部 ` Regular`。
 */
export function parseRegFonts(stdout: string, set: Set<string>): void {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    const m = line.match(/^(.+?)\s{2,}REG_SZ\s{2,}(.+)$/i)
    if (!m) continue
    const valueName = m[1].trim()
    const file = m[2].trim()
    if (!FONT_FILE_RE.test(file)) continue
    let display = valueName.replace(/\s*\((TrueType|OpenType)\)\s*$/i, '').trim()
    display = display.replace(/\s+Regular$/i, '').trim()
    pushUnique(set, display)
  }
}

/** macOS：从字体文件名（含扩展名）解析候选字体名，非法扩展名返回 null */
export function parseMacFontFile(fileName: string): string | null {
  if (!FONT_FILE_RE.test(fileName)) return null
  const base = fileName.replace(FONT_FILE_RE, '').trim()
  return base || null
}

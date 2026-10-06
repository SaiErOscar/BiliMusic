/**
 * 平台感知的路径工具（v1.4.7-pre1 修复4）：渲染层此前硬编码 '\' 拼接与替换，
 * mac/Linux 上会产出错误路径。这里把「路径中实际出现的分隔符」都视为分隔符，
 * 纯函数无平台依赖，跨平台行为由 CI 的 mac/Linux 跑单测兜底。
 */

/** 取路径末段文件名（'/' 与 '\' 均视为分隔符，去尾部多余分隔） */
export function pathBasename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

/** 取文件所在目录（保留原分隔符风格；根目录返回带分隔符前缀，无目录返回空串） */
export function pathDirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx < 0) return ''
  if (idx === 0) return trimmed.slice(0, 1)
  return trimmed.slice(0, idx)
}

/** 拼接目录与文件名（目录缺省直接返回文件名；sep 缺省 Windows 分隔符，调用方按运行平台传） */
export function joinPath(dir: string, name: string, sep = '\\'): string {
  if (!dir) return name
  return new RegExp(`[\\\\/]$`).test(dir) ? dir + name : dir + sep + name
}

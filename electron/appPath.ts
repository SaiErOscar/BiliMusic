// v1.4.15-pre8 app:// 协议的路径解析（纯函数，可单测）
//
// 背景：渲染层通过自定义 app:// 协议加载，handler 里把 URL 的 pathname 直接
// path.join 到渲染根目录。**URL 解析不会归一化编码后的斜杠**，于是：
//   app://local/..%2f..%2f..%2fWindows/win.ini
//   → pathname "/..%2f..%2f..%2fWindows/win.ini"
//   → decodeURIComponent → "/../../../Windows/win.ini"
//   → path.join('I:/BiliMusic/dist', …) → "I:\Windows\win.ini"
// 已实测成立。页面本身就在 app://local 源上且协议带 supportFetchAPI，
// 这是同源 fetch，不受 CORS 限制，渲染层任一处注入即可读全盘。
//
// 修复口径：解码后必须仍落在渲染根目录子树内，否则拒绝。
// 单靠 path.join 归一化不够——必须用 path.resolve 后再做前缀断言，
// 并且要处理 Windows 的大小写与分隔符差异。
import path from 'path'

export interface ResolveResult {
  ok: boolean
  /** 通过校验时的绝对路径 */
  filePath?: string
  /** 拒绝原因，用于日志与测试断言 */
  reason?: 'bad-encoding' | 'null-byte' | 'escaped-root'
}

/**
 * 把 app:// 的 pathname 解析成渲染根目录内的绝对路径。
 *
 * @param rootPath 渲染层根目录（dist 或 OTA asar 所在目录）
 * @param pathname URL 的 pathname（未解码）
 */
export function resolveAppAssetPath(rootPath: string, pathname: string): ResolveResult {
  // 先对**原串**检查编码后的分隔符与 NUL：解码后再查会被 "..%2f" 这类绕过
  const raw = String(pathname ?? '')
  if (/%00/i.test(raw)) return { ok: false, reason: 'null-byte' }

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // 非法百分号序列（如 "%zz"）直接拒绝，避免解码抛错穿到 handler
    return { ok: false, reason: 'bad-encoding' }
  }
  // 解码后仍可能出现裸 NUL（"%00" 已被上面挡掉，这里兜底）
  if (decoded.indexOf('\u0000') !== -1) return { ok: false, reason: 'null-byte' }

  const root = path.resolve(rootPath)
  // 关键：拼成 './' + decoded 再 resolve，让 ".." 真正参与归一化；
  // 直接 path.join(root, decoded) 在绝对路径片段（如 "/C:/x"）下会丢弃 root。
  const target = path.resolve(root, '.' + decoded)

  // 前缀断言必须带分隔符，否则 root="…/dist" 会放行 "…/dist-evil/x"
  const withSep = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(withSep)) {
    return { ok: false, reason: 'escaped-root' }
  }
  return { ok: true, filePath: target }
}

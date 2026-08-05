/**
 * 语义化版本比较工具（共享，供主进程和测试使用）
 */

/**
 * 仅比较 x.y.z 主体，忽略 -alpha 之类后缀；a > b 返回 true
 */
export function semverGt(a: string, b: string): boolean {
  const pa = a.split('-')[0].split('.').map((n) => Number(n) || 0)
  const pb = b.split('-')[0].split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

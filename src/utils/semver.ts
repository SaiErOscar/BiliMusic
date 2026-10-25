/**
 * 语义化版本比较工具（共享，供主进程和测试使用）
 */

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识；无后缀时为空数组（正式版） */
  pre: string[]
}

function parse(version: string): ParsedVersion {
  const [core, ...rest] = version.trim().split('-')
  const nums = core.split('.').map((n) => Number(n) || 0)
  const pre = rest.length ? rest.join('-').split('.') : []
  return { major: nums[0] || 0, minor: nums[1] || 0, patch: nums[2] || 0, pre }
}

/**
 * 比较两个预发布标识数组，遵循 semver 2.0.0 第 11 条：
 * - 空数组（正式版）大于任何预发布
 * - 逐段比较：数字段按数值比、字符串段按字典序；数字段小于字符串段
 * - 前缀相同时，段数多的更大（pre1 < pre1.1）
 * 返回 1 / 0 / -1
 */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d > 0 ? 1 : -1
    } else if (xn !== yn) {
      // 数字标识的优先级低于字母标识（semver 2.0.0 §11）
      return xn ? -1 : 1
    } else if (x !== y) {
      // 本项目的预览号形如 pre1 / pre2 / … / pre10，必须按数字比而不是字典序，
      // 否则 pre10 < pre9（字典序）会让第 10 轮预览被判成比第 9 轮旧。
      const xt = x.match(/^(\D*)(\d+)$/)
      const yt = y.match(/^(\D*)(\d+)$/)
      if (xt && yt && xt[1] === yt[1]) {
        const d = Number(xt[2]) - Number(yt[2])
        if (d !== 0) return d > 0 ? 1 : -1
      } else {
        return x > y ? 1 : -1
      }
    }
  }
  return 0
}

/** 完整比较（含预发布），a > b 返回 1，相等 0，a < b 返回 -1 */
export function semverCompare(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  return comparePre(pa.pre, pb.pre)
}

/**
 * a 是否严格大于 b（含预发布）。
 *
 * v1.4.11-pre4 修复：旧实现只比 x.y.z 主体、丢弃 -preN 后缀，导致
 * `semverGt('1.4.11-pre3', '1.4.11-pre1')` 返回 false。OTA 更新器据此判断
 * 「全量安装包是否已高于缓存的渲染补丁」，比较恒为 false 就永远清不掉旧补丁——
 * 表现是装了新包界面却还是旧的（v1.4.11-pre2/pre3 连续两次踩到）。
 */
export function semverGt(a: string, b: string): boolean {
  return semverCompare(a, b) > 0
}

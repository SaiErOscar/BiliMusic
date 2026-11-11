import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

/**
 * v1.4.15-pre3：`src/` 内 `window.electronAPI` 直调的守卫。
 *
 * v1.4.4 定的目标是「`src/` 里 `window.electronAPI` 只剩 `src/platform/`」，
 * 靠的是人工 grep 断言，**没有测试守着**。于是后来又长出两处直调：
 * - `src/services/ai.ts`：`aiUnsupportedReason()` 里探测桌面桥是否存在
 * - `src/theme/apply.ts`：`syncThemedIcon()` 里调 `applyThemeIcon`
 *
 * 这两处是**已知并允许的存量**（见下方 ALLOWED），补平台层能力需要跨模块改动，
 * 单独排期。本测试的作用是把「新增直调」变成会变红的事——
 * 没有这条断言，下一次谁再图方便直接摸 electronAPI，没人会发现。
 *
 * 判定口径：只看 `src/` 下的 .ts/.tsx，跳过 `src/platform/`（那是唯一合法收口处）
 * 与 `src/types/`（类型声明，不是调用）。
 */

const SRC = path.resolve(__dirname, '../src')

/** 允许保留直调的存量文件（相对 src/），每项都要写清为什么。 */
const ALLOWED: Record<string, string> = {
  'services/ai.ts': '能力探测：判断桌面桥是否存在以给出可读的降级原因，补 platform 能力后排期',
  'theme/apply.ts': '主题图标同步：platform 尚无 applyThemeIcon capability，补能力后排期',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

/** 去掉注释，避免注释里提到 electronAPI 就误判（本项目注释里常写这类说明）。 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('src/ 内 window.electronAPI 直调守卫', () => {
  const files = walk(SRC).filter((f) => {
    const rel = path.relative(SRC, f).replace(/\\/g, '/')
    // 平台层是唯一合法收口处；types 是声明
    if (rel.startsWith('platform/')) return false
    if (rel.startsWith('types/')) return false
    return true
  })

  it('能扫到源码文件（守卫自身不能空转）', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('直调点集合与允许清单完全一致，新增直调会变红', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/')
      const code = stripComments(readFileSync(f, 'utf8'))
      if (code.includes('window.electronAPI')) offenders.push(rel)
    }
    expect(
      offenders.sort(),
      'src/ 下新增了 window.electronAPI 直调。请改走 src/platform 的 capability（见 v1.4.4 解耦约定）。' +
        '若确有例外，把它连同理由加进本文件的 ALLOWED。',
    ).toEqual(Object.keys(ALLOWED).sort())
  })

  it('允许清单里每一项都仍然真实存在（防止修好后忘了删）', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const code = stripComments(readFileSync(path.join(SRC, rel), 'utf8'))
      expect(code.includes('window.electronAPI'), rel + ' 已不再直调，请从 ALLOWED 移除').toBe(true)
    }
  })

  it('平台层确实是收口处：platform/electron.ts 里读 electronAPI', () => {
    const code = readFileSync(path.join(SRC, 'platform/electron.ts'), 'utf8')
    expect(code).toContain('electronAPI')
  })
})

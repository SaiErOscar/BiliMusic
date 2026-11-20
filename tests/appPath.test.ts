// v1.4.15-pre8 app:// 路径穿越防护
//
// 这组测试守的是 R-01：渲染层通过 app:// 加载，handler 把 URL pathname 拼进
// 渲染根目录。URL 解析**不会**归一化编码后的斜杠，因此 "..%2f" 能穿越出去。
// 实测（修复前）：app://local/..%2f..%2f..%2fWindows/win.ini → I:\Windows\win.ini
//
// electron/ 不在主 tsconfig 范围，所以这里真实 import 并调用，而不是只看类型。
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveAppAssetPath } from '../electron/appPath'

const ROOT = process.platform === 'win32' ? 'I:\\BiliMusic\\dist' : '/app/dist'

describe('resolveAppAssetPath —— 正常路径放行', () => {
  it('根路径与普通静态资源', () => {
    expect(resolveAppAssetPath(ROOT, '/index.html').ok).toBe(true)
    expect(resolveAppAssetPath(ROOT, '/assets/index-abc.js').ok).toBe(true)
  })

  it('解析结果是根目录下的绝对路径', () => {
    const r = resolveAppAssetPath(ROOT, '/assets/app.js')
    expect(r.ok).toBe(true)
    expect(r.filePath).toBe(path.resolve(ROOT, 'assets/app.js'))
  })

  it('百分号编码的正常文件名（中文、空格）', () => {
    const r = resolveAppAssetPath(ROOT, '/assets/%E4%B8%AD%E6%96%87%20file.js')
    expect(r.ok).toBe(true)
    expect(r.filePath).toBe(path.resolve(ROOT, 'assets/中文 file.js'))
  })
})

describe('resolveAppAssetPath —— 穿越必须拒绝（R-01 核心）', () => {
  const attacks = [
    ['编码斜杠 ..%2f', '/..%2f..%2f..%2fWindows/win.ini'],
    ['编码点 %2e%2e%2f', '/%2e%2e%2f%2e%2e%2fWindows/win.ini'],
    ['编码反斜杠 ..%5c', '/..%5c..%5cWindows/win.ini'],
    ['混合编码', '/..%2f..%5c..%2fWindows/win.ini'],
    ['裸 .. 段', '/../../Windows/win.ini'],
    ['深层裸 ..', '/a/b/../../../../etc/passwd'],
  ] as const

  for (const [label, input] of attacks) {
    it(label + ' 被拒绝', () => {
      const r = resolveAppAssetPath(ROOT, input)
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('escaped-root')
      expect(r.filePath).toBeUndefined()
    })
  }

  it('NUL 字节被拒绝（%00）', () => {
    const r = resolveAppAssetPath(ROOT, '/index.html%00.png')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('null-byte')
  })

  it('非法百分号序列被拒绝而不是抛错', () => {
    const r = resolveAppAssetPath(ROOT, '/%zz')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('bad-encoding')
  })

  it('前缀相近的兄弟目录不能绕过（dist vs dist-evil）', () => {
    // 关键：前缀断言必须带分隔符，否则 "/app/dist-evil/x" 会被当成在 "/app/dist" 内
    const r = resolveAppAssetPath(ROOT, '/..%2fdist-evil%2fevil.js')
    expect(r.ok).toBe(false)
  })

  it('空 pathname 解析到根目录本身，不算越界', () => {
    const r = resolveAppAssetPath(ROOT, '')
    expect(r.ok).toBe(true)
    expect(r.filePath).toBe(path.resolve(ROOT))
  })
})

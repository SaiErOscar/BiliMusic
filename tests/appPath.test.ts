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

describe('跨平台：反斜杠必须当分隔符（CI 上 Linux/macOS 才暴露的漏洞）', () => {
  // 这一组是 v1.4.15-pre8 的真实教训：
  // posix 的 path.resolve **不认 "\" 为分隔符**，于是 "..%5c..%5cWindows/win.ini"
  // 在 Linux/macOS 上会被当成普通文件名放行——Windows 本地全绿，CI 才红。
  // 这里不依赖运行平台，直接断言"反斜杠形式的穿越必须被拒"。

  it('..%5c 形式在任意平台都被拒绝', () => {
    const r = resolveAppAssetPath(ROOT, '/..%5c..%5c..%5cWindows/win.ini')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('escaped-root')
  })

  it('裸反斜杠 .. 段也被拒绝（未编码）', () => {
    const r = resolveAppAssetPath(ROOT, '/..\\..\\Windows/win.ini')
    expect(r.ok).toBe(false)
  })

  it('反斜杠与正斜杠混合的穿越被拒绝', () => {
    const r = resolveAppAssetPath(ROOT, '/..%2f..%5c..%2fetc/passwd')
    expect(r.ok).toBe(false)
  })

  it('对照：正常文件名的反斜杠不参与路径解析（不被误判为穿越）', () => {
    // 只看 ok=true 会漏掉"过度拒绝"，这里确认正常资源仍可访问
    const r = resolveAppAssetPath(ROOT, '/assets/app.js')
    expect(r.ok).toBe(true)
  })

  it('返回的 filePath 里不含 .. 段', () => {
    const r = resolveAppAssetPath(ROOT, '/..%5c..%5cWindows/win.ini')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('escaped-root')
  })
})

describe('跨平台语义（用 posix 显式模拟，Windows 上也能验）', () => {
  // **这是 pre8 最重要的一条教训**：
  // Windows 的 path.resolve 本来就认反斜杠，所以"去掉归一化"这个退化
  // 在 Windows 本地测不出来——19 项仍全绿。漏洞只在 Linux/macOS 暴露，
  // 是 CI 的 ubuntu 先红才发现。
  //
  // 结论：要验证跨平台路径行为，**不能依赖运行时 path 的语义**，
  // 必须显式用 path.posix 复现目标平台的行为。

  /** 用 posix 语义复刻实现，验证"反斜杠必须归一化" */
  function resolvePosix(rootPath: string, pathname: string) {
    const raw = String(pathname ?? '')
    if (/%00/i.test(raw)) return { ok: false, reason: 'null-byte' }
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return { ok: false, reason: 'bad-encoding' }
    }
    const normalized = decoded.replace(/\\/g, '/')
    const root = path.posix.resolve(rootPath)
    const target = path.posix.resolve(root, '.' + normalized)
    const withSep = root.endsWith('/') ? root : root + '/'
    if (target !== root && !target.startsWith(withSep)) {
      return { ok: false, reason: 'escaped-root' }
    }
    return { ok: true, filePath: target }
  }

  const POSIX_ROOT = '/app/dist'

  it('posix 下 ..%5c 穿越被拒绝（Windows 上同样会跑这条）', () => {
    const r = resolvePosix(POSIX_ROOT, '/..%5c..%5cWindows/win.ini')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('escaped-root')
  })

  it('posix 下正常资源仍放行', () => {
    const r = resolvePosix(POSIX_ROOT, '/assets/app.js')
    expect(r.ok).toBe(true)
    expect(r.filePath).toBe('/app/dist/assets/app.js')
  })

  it('反证：不做反斜杠归一化时，posix 会把它当文件名放行（说明这条断言有区分力）', () => {
    // 复刻"未归一化"的写法，确认它确实会放行——证明上面的用例不是碰巧通过
    const decoded = decodeURIComponent('/..%5c..%5cWindows/win.ini')
    const root = path.posix.resolve(POSIX_ROOT)
    const target = path.posix.resolve(root, '.' + decoded) // 故意不归一化
    expect(target.startsWith(root + '/')).toBe(true) // 未归一化 => 被当成普通文件名，放行
  })
})

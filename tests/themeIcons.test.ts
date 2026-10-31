// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// v1.4.13-pre3：主题化图标。
// 真实切换效果需真机看，这里守住「图标集齐全 + 主进程按主题取图 + 找不到时回落」。

// v1.4.13-pre13：守住「引用的 CSS 变量必须真的定义过」。
//
// 这是 pre12/pre13 两次「浅色下面板文字看不见」的共同根因：
// 代码里写 var(--color-text) / var(--color-surface)，而项目里根本不存在这两个变量
// （实际是 --color-foreground / --color-card），声明静默失效后回退到继承值或硬编码色，
// 于是深色正常、浅色白字白底，且没有任何报错。
describe('CSS 变量引用必须已定义', () => {
  const css = readFileSync(path.resolve(__dirname, '../src/styles/index.css'), 'utf8')

  /** 收集所有「定义」的变量名（--x: ...） */
  const defined = new Set(
    [...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]),
  )

  /** 收集所有「引用」的变量名（var(--x)） */
  const referenced = new Set(
    [...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]),
  )

  it('没有引用未定义的变量', () => {
    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(missing, '以下变量被引用但从未定义：' + missing.join(', ')).toEqual([])
  })

  /*
   * 这两个名字曾让浅色主题出过两次问题。现在已在 :root 里显式定义
   * （指向 --color-foreground / --color-card），所以断言改为
   * 「必须有定义」而不是「不许出现」——名字本身不是错，未定义才是。
   */
  it('曾出问题的两个变量已有定义', () => {
    expect(defined.has('--color-text')).toBe(true)
    expect(defined.has('--color-surface')).toBe(true)
  })
})


const ICON_DIR = path.resolve(__dirname, '../electron/icons')
const THEMES = ['default', 'ocean', 'forest', 'twilight', 'graphite']

describe('主题图标集完整性', () => {
  it('每套主题都有明暗两版图标', () => {
    for (const id of THEMES) {
      for (const mode of ['light', 'dark']) {
        const f = path.join(ICON_DIR, 'icon-' + id + '-' + mode + '.png')
        expect(() => readFileSync(f), '缺少 ' + f).not.toThrow()
      }
    }
  })

  it('图标文件是合法 PNG（魔数正确）', () => {
    const buf = readFileSync(path.join(ICON_DIR, 'icon-default-dark.png'))
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })
})

describe('主进程按主题取图', () => {
  const src = readFileSync(path.resolve(__dirname, '../electron/main.ts'), 'utf8')

  it('按 themeId + mode 拼文件名，找不到回落默认图标', () => {
    expect(src).toContain('loadThemedIcon')
    expect(src).toContain("kind + '-' + themeId + '-' + mode + '.png'")
    // 回落：自定义基色没有预生成图标
    expect(src).toContain('isEmpty()')
  })

  it('窗口与托盘都换图', () => {
    expect(src).toContain('mainWindow.setIcon(img)')
    // v1.4.13-pre7：托盘直接用 tray-*.png（与 icon.ico 同一套设计的成品），
    // 不再把 256px 桌面图缩到 32px——那样会把立体图缩糊。
    expect(src).toContain("loadThemedIcon(themeId, mode, 'tray')")
  })

  it('有独立 IPC 供渲染层触发', () => {
    expect(src).toContain("ipcMain.handle('theme:apply-icon'")
  })
})

describe('渲染层在主题变化时同步图标', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/theme/apply.ts'), 'utf8')
  it('refreshBrandTokens 里调用 applyThemeIcon', () => {
    expect(src).toContain('syncThemedIcon')
    expect(src).toContain('applyThemeIcon')
  })

  // v1.4.13-pre6：标题栏那枚 logo 是自绘的，setIcon 管不到它，
  // 必须把主题与明暗写到 <html> 上供 CSS/组件取用。
  it('把主题与明暗写到 documentElement 供标题栏取用', () => {
    expect(src).toContain('data-app-theme')
    expect(src).toContain('data-app-mode')
  })
})

describe('标题栏 logo 跟随主题（v1.4.13-pre6）', () => {
  const tb = readFileSync(path.resolve(__dirname, '../src/components/layout/TitleBar.tsx'), 'utf8')

  it('不再硬编码静态图标，按主题取图', () => {
    expect(tb).toContain('THEME_ICONS')
    expect(tb).toContain('data-app-theme')
    expect(tb).toContain('MutationObserver')
  })

  it('自定义基色回落到默认图，不显示破图', () => {
    expect(tb).toContain('setIconSrc(appIcon)')
  })

  it('构建会把图标集同步到 public/icons（否则运行时 404）', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['sync-icons']).toBeTruthy()
    expect(pkg.scripts['build']).toContain('sync-icons')
  })
})

describe('托盘图标是「白色字形 + 主题色衬底」', () => {
  // v1.4.13-pre7：托盘改成「保留桌面图标的光影，只换色相」。
  // pre6 的纯色平涂被用户判为「白色太暗、主题色太深、没有光影」。
  it('托盘保留桌面图标的明暗层次，只替换色相', () => {
    const src = readFileSync(path.resolve(__dirname, '../scripts/make-theme-icons.cjs'), 'utf8')
    expect(src).toContain('mixToward')
    expect(src).toContain('smoothstep')
    expect(src).toContain('inside')
  })

  it('托盘图是合法 PNG 且尺寸已压到 256', () => {
    const buf = readFileSync(path.join(ICON_DIR, 'tray-ocean-dark.png'))
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    // 体积守门：单文件不超过 60KB。保留光影后信息量比纯色平涂大，但仍远小于原图。
    expect(buf.length).toBeLessThan(60 * 1024)
  })
})

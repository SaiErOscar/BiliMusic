// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// v1.4.13-pre3：主题化图标。
// 真实切换效果需真机看，这里守住「图标集齐全 + 主进程按主题取图 + 找不到时回落」。

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
    // 托盘用桌面图标缩放（白主体 + 主题色衬底），不再是单色 tray 图
    expect(src).toContain('tray.setImage(trayImg)')
    expect(src).toContain("loadThemedIcon(themeId, mode, 'icon').resize({ width: 32, height: 32 })")
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
  it('生成脚本按 alpha 分两层，而不是整体染成主题色', () => {
    const src = readFileSync(path.resolve(__dirname, '../scripts/make-theme-icons.cjs'), 'utf8')
    // 字形处取 255（白），其余取主题色 —— 这是 pre6 的结构性改动
    expect(src).toContain('255*glyph')
    expect(src).toContain('inside')
  })

  it('托盘图是合法 PNG 且尺寸已压到 256', () => {
    const buf = readFileSync(path.join(ICON_DIR, 'tray-ocean-dark.png'))
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    // 体积守门：单文件不超过 40KB（压缩前是 30KB+ 的高分辨率原图）
    expect(buf.length).toBeLessThan(40 * 1024)
  })
})

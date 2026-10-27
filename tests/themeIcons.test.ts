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
    // 实现改成先取 img 再 setIcon（为二次写入刷新 Windows 缓存）
    expect(src).toContain('setIcon(img)')
    expect(src).toContain('setImage(loadThemedIcon')
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
})

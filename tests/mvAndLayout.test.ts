// @vitest-environment jsdom
import { readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// v1.4.9-pre3 回归：设置行「标签逐字竖排」与「MV 无控件导出」的静态契约。
//
// 为什么用源码断言而不是渲染测试：
// - 竖排是纯 CSS 布局问题（flex 宽度争夺），jsdom 不做真实布局，渲染出来也测不出
//   宽度塌陷；能守住的是「这行确实挂了 stacked 类」与「该类确实把行改成纵向堆叠」
//   这两件事，真正的观感仍需真机看。
// - 无控件导出同理：守住「设置项存在 + 契约字段存在 + 舞台按 clean 条件渲染」，
//   成片画面仍需真机导一次确认。

const css = readFileSync(path.resolve(__dirname, '../src/styles/index.css'), 'utf8').replace(/\r\n/g, '\n')
const settingsSrc = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8').replace(/\r\n/g, '\n')
const stageSrc = readFileSync(path.resolve(__dirname, '../src/components/MvExportStage.tsx'), 'utf8').replace(/\r\n/g, '\n')
const typesSrc = readFileSync(path.resolve(__dirname, '../src/types/index.ts'), 'utf8').replace(/\r\n/g, '\n')
const storageSrc = readFileSync(path.resolve(__dirname, '../src/utils/storage.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('睡眠定时行不再竖排（v1.4.9-pre3）', () => {
  it('睡眠定时行显式声明 stacked，走纵向堆叠布局', () => {
    // 抓「睡眠定时」这个 SettingsRow 开标签到 children 之间那一段
    const idx = settingsSrc.indexOf('label="睡眠定时"')
    expect(idx).toBeGreaterThan(-1)
    // stacked 属性须出现在该行开标签范围内（向前找到 <SettingsRow）
    const openTagStart = settingsSrc.lastIndexOf('<SettingsRow', idx)
    const openTagEnd = settingsSrc.indexOf('>', idx)
    const openTag = settingsSrc.slice(openTagStart, openTagEnd + 1)
    expect(openTag).toContain('stacked')
  })

  it('CSS 定义了 .settings-row--stacked 且改为纵向排列', () => {
    expect(css).toContain('.settings-row--stacked')
    const ruleStart = css.indexOf('.settings-row--stacked {')
    expect(ruleStart).toBeGreaterThan(-1)
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/flex-direction:\s*column/)
  })

  it('堆叠行的控件区放开 max-width，不再被 46vw 限死', () => {
    expect(css).toContain('.settings-row--stacked .settings-row__control')
    const ruleStart = css.indexOf('.settings-row--stacked .settings-row__control {')
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/max-width:\s*100%/)
    expect(rule).toMatch(/width:\s*100%/)
  })

  it('默认行仍是横向 space-between（回归防线：别把通用行也改竖）', () => {
    const ruleStart = css.indexOf('.settings-row {')
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/justify-content:\s*space-between/)
    expect(rule).not.toMatch(/flex-direction:\s*column/)
  })
})

describe('MV 无控件导出（v1.4.9-pre3）', () => {
  it('AppSettings 契约含 mvCleanExport 布尔字段', () => {
    expect(typesSrc).toMatch(/mvCleanExport:\s*boolean/)
  })

  it('默认值为 false，保持既有含控件导出画面', () => {
    expect(storageSrc).toMatch(/mvCleanExport:\s*false/)
  })

  it('设置页有对应开关并写回 mvCleanExport', () => {
    expect(settingsSrc).toContain('MV 无控件导出')
    expect(settingsSrc).toContain('settings.mvCleanExport')
  })

  it('舞台按 clean 条件渲染：进度条与控件区都在 !clean 分支内', () => {
    expect(stageSrc).toContain('const clean = payload?.clean === true')
    expect(stageSrc).toContain('{!clean && (')
    // 关键控件都被包进该分支（取 !clean 分支到其结束之间的片段做断言）
    const branchStart = stageSrc.indexOf('{!clean && (')
    const branchEnd = stageSrc.indexOf('</section>', branchStart)
    const branch = stageSrc.slice(branchStart, branchEnd)
    expect(branch).toContain('now-playing-progress')
    expect(branch).toContain('now-playing-controls')
    expect(branch).toContain('PlayerSlider')
  })

  it('clean 为 false 时控件仍渲染（缺省路径不退化）', () => {
    // clean 由 payload.clean === true 计算，缺省 payload.clean 为 undefined → false
    expect(stageSrc).toMatch(/payload\?\.clean === true/)
  })
})

describe('MV 封面比例与阴影（v1.4.9-pre3）', () => {
  it('舞台封面使用 --mv 专用类', () => {
    expect(stageSrc).toContain('now-playing-cover--mv')
    expect(stageSrc).toContain('now-playing-cover-wrap--mv')
  })

  it('MV 封面改为 contain，不裁切也不拉伸', () => {
    const ruleStart = css.indexOf('.now-playing-cover--mv {')
    expect(ruleStart).toBeGreaterThan(-1)
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/object-fit:\s*contain/)
    expect(rule).toMatch(/aspect-ratio:\s*auto/)
  })

  it('MV 封面容器固定 1:1 占位，不同比例封面都不跳高', () => {
    const ruleStart = css.indexOf('.now-playing-cover-wrap--mv {')
    expect(ruleStart).toBeGreaterThan(-1)
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/aspect-ratio:\s*1/)
  })

  it('屏幕播放页封面仍保持 1:1 + cover（不被 MV 改动波及）', () => {
    const ruleStart = css.indexOf('.now-playing-cover {')
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/aspect-ratio:\s*1/)
    expect(rule).toMatch(/object-fit:\s*cover/)
  })
})

describe('可视化定位与柱底对齐（v1.4.9-pre3 起，v1.4.10 重做）', () => {
  const rule = () => {
    const start = css.indexOf('.now-playing-visualizer {')
    const end = css.indexOf('}', start)
    // 去掉块内注释再断言，避免注释里的示例文字（如 width:auto）干扰
    return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  }
  const visualizerSource = () =>
    readFileSync(path.resolve(__dirname, '../src/components/AudioVisualizer.tsx'), 'utf8').replace(
      /\r\n/g,
      '\n',
    )

  it('.now-playing-visualizer 用绝对定位脱离文档流', () => {
    expect(css.indexOf('.now-playing-visualizer {')).toBeGreaterThan(-1)
    expect(rule()).toMatch(/position:\s*absolute/)
  })

  it('可视化不抢鼠标事件', () => {
    expect(rule()).toMatch(/pointer-events:\s*none/)
  })

  it('柱底与封面显示底部共线（bottom: 0，不探出封面）', () => {
    expect(rule()).toMatch(/bottom:\s*0;/)
    expect(rule()).not.toMatch(/bottom:\s*-/)
  })

  it('画布与封面同宽：不再用 left/right 内缩（内缩 + 内联宽度会让画布整块偏移、右端探出封面）', () => {
    expect(rule()).toMatch(/left:\s*0;/)
    expect(rule()).not.toMatch(/left:\s*\d+%/)
    expect(rule()).not.toMatch(/^\s*right:\s*\S/m)
  })

  it('画布宽度显式声明（canvas 是 replaced 元素，width:auto 会退回固有 300×150 比例）', () => {
    expect(rule()).toMatch(/width:\s*100%/)
  })

  it('画布底部圆角与封面一致，柱根轮廓与封面底边严丝合缝', () => {
    expect(rule()).toMatch(/border-radius:\s*0 0 22px 22px/)
  })

  it('不再使用底部淡出遮罩（对齐后淡出会削掉柱根）', () => {
    expect(rule()).not.toMatch(/mask-image/)
  })

  it('组件不再下发内联宽度（内联 width 会盖掉 CSS 宽度，并让绝对定位的 right 失效）', () => {
    const src = visualizerSource()
    expect(src).toMatch(/style=\{\{\s*display:\s*'block'\s*\}\}/)
    expect(src).not.toMatch(/width:\s*'100%'/)
  })

  it('柱根直角：绘制路径不再用 roundRect（四角全圆会让柱根连不成一条线）', () => {
    const src = visualizerSource()
    expect(src).not.toMatch(/roundRect/)
    expect(src).toMatch(/moveTo\(x,\s*height\)/)
  })

  it('组件兜底高度与 CSS 高度一致（避免首帧被拉伸）', () => {
    const constMatch = visualizerSource().match(/const CANVAS_HEIGHT = (\d+)/)
    expect(constMatch).not.toBeNull()
    const constHeight = Number(constMatch![1])
    const cssHeight = Number((rule().match(/height:\s*(\d+)px/) || [])[1])
    expect(cssHeight).toBeGreaterThan(0)
    expect(constHeight).toBe(cssHeight)
  })
})

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

describe('可视化不再挤压播放页布局（v1.4.9-pre3）', () => {
  it('.now-playing-visualizer 用绝对定位脱离文档流', () => {
    const ruleStart = css.indexOf('.now-playing-visualizer {')
    expect(ruleStart).toBeGreaterThan(-1)
    const ruleEnd = css.indexOf('}', ruleStart)
    const rule = css.slice(ruleStart, ruleEnd)
    expect(rule).toMatch(/position:\s*absolute/)
  })

  it('可视化不抢鼠标事件', () => {
    const ruleStart = css.indexOf('.now-playing-visualizer {')
    const ruleEnd = css.indexOf('}', ruleStart)
    expect(css.slice(ruleStart, ruleEnd)).toMatch(/pointer-events:\s*none/)
  })
})

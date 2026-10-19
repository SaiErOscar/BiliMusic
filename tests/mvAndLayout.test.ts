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
  // v1.4.10-pre1：绘制实现搬到 services/visualizerDraw.ts，播放页与 MV 舞台共用
  const drawSource = () =>
    readFileSync(path.resolve(__dirname, '../src/services/visualizerDraw.ts'), 'utf8').replace(
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
    const src = drawSource()
    expect(src).not.toMatch(/roundRect/)
    expect(src).toMatch(/moveTo\(x,\s*height\)/)
  })

  it('组件不再自带绘制实现，改用共享绘制函数', () => {
    const src = visualizerSource()
    expect(src).toContain('drawVisualizerBars')
    expect(src).not.toMatch(/createLinearGradient/)
  })

  it('兜底高度与 CSS 高度一致（避免首帧被拉伸）', () => {
    const constMatch = drawSource().match(/VISUALIZER_CANVAS_HEIGHT = (\d+)/)
    expect(constMatch).not.toBeNull()
    const constHeight = Number(constMatch![1])
    const cssHeight = Number((rule().match(/height:\s*(\d+)px/) || [])[1])
    expect(cssHeight).toBeGreaterThan(0)
    expect(constHeight).toBe(cssHeight)
  })
})

describe('MV 导出跟随音频可视化（v1.4.10-pre1）', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
  const serviceSrc = read('../src/services/mvExport.ts')
  const mainSrc = read('../electron/mvExport.ts')
  const drawSrc = read('../src/services/visualizerDraw.ts')
  const decodeSrc = read('../src/utils/spectrumDecode.ts')
  const pageSrc = read('../src/components/AudioVisualizer.tsx')

  it('导出选项与主进程 payload 契约含 visualizer 开关', () => {
    expect(serviceSrc).toMatch(/visualizer\?:\s*boolean/)
    expect(serviceSrc).toContain('visualizer: options.visualizer === true')
    expect(mainSrc).toMatch(/visualizer\?:\s*boolean/)
  })

  it('单曲与批量导出都跟随设置里的 audioVisualizer', () => {
    const downloadBtn = read('../src/components/DownloadButton.tsx')
    const batch = read('../src/services/batchDownloadStore.ts')
    expect(downloadBtn).toContain('visualizer: settings.audioVisualizer')
    expect(batch).toContain('visualizer: appSettings.audioVisualizer')
  })

  it('无控件导出不含可视化（clean 优先于开关）', () => {
    expect(mainSrc).toContain('payload.visualizer === true && payload.clean !== true')
    expect(stageSrc).toContain('payload?.visualizer === true && !clean')
  })

  it('可视化开启时采样网格加密到 1/30，且只在分析成功（spectrum 非空）时生效', () => {
    expect(mainSrc).toContain('const VISUALIZER_STEP = 1 / ANALYSIS_HZ')
    expect(mainSrc).toMatch(/spectrum \? Math\.min\(preset\.step, VISUALIZER_STEP\) : preset\.step/)
    expect(mainSrc).toMatch(/spectrum \? Math\.max\(preset\.maxFrames, VISUALIZER_MAX_FRAMES\) : preset\.maxFrames/)
  })

  it('主进程离线分析已下载音频，并把频谱注入离屏舞台', () => {
    expect(mainSrc).toContain('buildSpectrumTimelineAsync')
    expect(mainSrc).toContain('spectrum: spectrum?.base64')
    expect(mainSrc).toContain('spectrumHz: spectrum?.hz')
    expect(mainSrc).toContain('spectrumBars: spectrum?.bars')
  })

  it('分析失败只降级为无柱子，不中断导出', () => {
    expect(mainSrc).toContain('频谱分析失败，导出将不含音频可视化')
    // 分析入口内部吞错返回 null，runExport 侧把 null 当「可视化关闭」继续跑
    expect(mainSrc).toMatch(/return \{ base64: encodeTimelineBase64\(timeline\)[\s\S]*?\n    return null\n  \}/)
  })

  it('舞台按时间索引频谱绘制，且不引入任何重绘循环', () => {
    expect(stageSrc).toContain('barsAtTime(spectrum, time)')
    expect(stageSrc).toContain('decodeSpectrum(')
    expect(stageSrc).toContain('useLayoutEffect')
    // requestAnimationFrame 会让 paint 与时间点失去对应关系，舞台内绝不允许出现
    expect(stageSrc).not.toContain('requestAnimationFrame')
  })

  it('播放页与导出舞台共用同一份绘制实现', () => {
    expect(drawSrc).toContain('export function drawVisualizerBars')
    expect(pageSrc).toContain("from '@/services/visualizerDraw'")
    expect(stageSrc).toContain("from '@/services/visualizerDraw'")
  })

  it('频谱解码对坏数据返回 null，不把导出搞挂', () => {
    expect(decodeSrc).toContain('atob')
    expect(decodeSrc).toMatch(/return null/)
  })

  it('MV 舞台的柱子贴封面显示区下缘（按 contain 缩放规则算，不贴容器底边）', () => {
    expect(stageSrc).toContain('naturalWidth')
    expect(stageSrc).toContain('imageBottom')
    expect(css).toContain('.now-playing-visualizer--mv')
  })

  it('设置页小字说清「音频可视化」影响 MV 导出、无控件导出不含可视化', () => {
    const audioRow = settingsSrc.slice(settingsSrc.indexOf('label="音频可视化"'))
    expect(audioRow.slice(0, 240)).toMatch(/MV/)
    const cleanRow = settingsSrc.slice(settingsSrc.indexOf('label="MV 无控件导出"'))
    expect(cleanRow.slice(0, 240)).toMatch(/频谱/)
  })

  it('频谱模块参数与播放页同源（FFT 2048 / 40 桶 / 30Hz 分析）', () => {
    const specSrc = read('../electron/spectrum.ts')
    expect(specSrc).toMatch(/export const FFT_SIZE = 2048/)
    expect(specSrc).toMatch(/export const BAR_COUNT = 40/)
    expect(specSrc).toMatch(/export const ANALYSIS_HZ = 30/)
  })
})

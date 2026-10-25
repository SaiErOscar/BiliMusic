import { readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

// v1.4.9-pre4 回归：设置页「播放」板块拆分与左右栏均衡。
//
// 拆分动机：原「播放」板块含 13 行（音质/自动播放/可视化/媒体键/睡眠定时/歌词显示/
// 歌词双语/桌面歌词配色字号粗细字体/样式预设），既过长，又与「外观」挤在同一列，
// 导致左栏 19 行 vs 右栏 10 行严重失衡。
//
// 这些断言守住拆分结果与均衡度，避免后续再加设置项时又堆回同一块。

const settingsSrc = readFileSync(path.resolve(__dirname, '../src/pages/Settings.tsx'), 'utf8').replace(/\r\n/g, '\n')

/** 抓出所有 SettingsGroup 的 title */
function groupTitles(): string[] {
  return [...settingsSrc.matchAll(/<SettingsGroup title="([^"]+)"/g)].map((m) => m[1])
}

/**
 * 按 settings-column 切分左右两栏源码。
 *
 * 依赖源码结构：`<div className="settings-column">` 出现两次，第二处起到
 * `settings-span`（横跨两列的账号/关于）之前即右栏主体。
 */
function columns(): { left: string; right: string } {
  const marker = '<div className="settings-column">'
  const first = settingsSrc.indexOf(marker)
  const second = settingsSrc.indexOf(marker, first + 1)
  expect(first).toBeGreaterThan(-1)
  expect(second).toBeGreaterThan(first)
  // 右栏到「账号」板块（settings-span）为止
  const spanStart = settingsSrc.indexOf('className="settings-span"', second)
  return {
    left: settingsSrc.slice(first, second),
    right: settingsSrc.slice(second, spanStart > second ? spanStart : settingsSrc.length),
  }
}

/** 统计某段源码里的 SettingsRow 数量 */
function countRows(fragment: string): number {
  return (fragment.match(/<SettingsRow\b/g) || []).length
}

/**
 * 估算一段源码的渲染高度（px）。
 *
 * v1.4.9-pre4 教训：第一版按「行数」配平，数出来左 13 / 右 16 看似均衡，实际左栏
 * 矮了 400px 以上——因为不同行的真实高度差很大：
 * - 普通行（只有标签 + 开关/下拉）  ≈ 68（min-height）
 * - 带 description 的行            ≈ 80（多一行说明文字）
 * - 输入框行（云同步三行）          ≈ 76（input 比开关高）
 * - stacked 行（睡眠定时/样式预设） ≈ 110（标签在上、控件换行在下）
 * - 按钮组（settings-actions）      ≈ 60 起，多组叠加
 * - 每个板块头（MusicSection 标题） ≈ 60
 *
 * 这里只做相对比较，绝对值不必精确；目的是让「按高度配平」有可回归的量化口径。
 */
function estimateHeight(fragment: string): number {
  // v1.4.11-pre4：AI 分组有「不可用」降级分支与正常分支两份，二者互斥渲染。
  // 静态估算必须只算正常分支，否则两栏高度被高估而误判失衡。
  const withoutFallback = fragment.replace(
    /\{!isAiSupported\(\) \? \([\s\S]*?\) : \(/,
    '(',
  )
  fragment = withoutFallback
  let height = 0
  // 板块头
  height += (fragment.match(/<SettingsGroup\b/g) || []).length * 60
  // stacked 行单独先数（避免被普通行重复计数）
  const stackedRows = (fragment.match(/<SettingsRow[^>]*\bstacked\b/g) || []).length
  height += stackedRows * 110
  const allRows = countRows(fragment)
  const plainRows = allRows - stackedRows
  // 输入框行：以 settings-input 出现次数估算
  const inputRows = Math.min(plainRows, (fragment.match(/className="settings-input"/g) || []).length)
  const describedRows = (fragment.match(/<SettingsRow[^>]*description=/g) || []).length - stackedRows
  const bareRows = Math.max(0, plainRows - inputRows - Math.max(0, describedRows))
  height += inputRows * 76
  height += Math.max(0, describedRows) * 80
  height += bareRows * 68
  // 按钮组
  height += (fragment.match(/settings-actions/g) || []).length * 60
  return height
}

describe('设置页「播放」板块拆分（v1.4.9-pre4）', () => {
  it('存在「播放」「播放页」「桌面歌词」三个板块', () => {
    const titles = groupTitles()
    expect(titles).toContain('播放')
    expect(titles).toContain('播放页')
    expect(titles).toContain('桌面歌词')
  })

  it('「播放」板块只保留核心播放行为（音质/自动播放/媒体键/睡眠定时）', () => {
    const start = settingsSrc.indexOf('<SettingsGroup title="播放"')
    const end = settingsSrc.indexOf('</SettingsGroup>', start)
    const block = settingsSrc.slice(start, end)
    expect(block).toContain('label="音质"')
    expect(block).toContain('label="自动播放"')
    expect(block).toContain('label="全局媒体键"')
    expect(block).toContain('label="睡眠定时"')
    // 拆分出去的项不应再留在「播放」
    expect(block).not.toContain('label="音频可视化"')
    expect(block).not.toContain('label="歌词显示"')
    expect(block).not.toContain('label="歌词双语"')
    expect(block).not.toContain('label="歌词文字颜色"')
    expect(block).not.toContain('label="样式预设"')
  })

  it('「播放页」板块承接播放页显示项（可视化/歌词显示/歌词双语）', () => {
    const start = settingsSrc.indexOf('<SettingsGroup title="播放页"')
    const end = settingsSrc.indexOf('</SettingsGroup>', start)
    const block = settingsSrc.slice(start, end)
    expect(block).toContain('label="音频可视化"')
    expect(block).toContain('label="歌词显示"')
    expect(block).toContain('label="歌词双语"')
  })

  it('「桌面歌词」板块承接歌词窗外观（配色/字号/粗细/字体/预设）', () => {
    const start = settingsSrc.indexOf('<SettingsGroup title="桌面歌词"')
    const end = settingsSrc.indexOf('</SettingsGroup>', start)
    const block = settingsSrc.slice(start, end)
    expect(block).toContain('label="歌词文字颜色"')
    expect(block).toContain('label="歌词按钮颜色"')
    expect(block).toContain('label="歌词字号"')
    expect(block).toContain('label="歌词粗细"')
    expect(block).toContain('label="歌词字体"')
    expect(block).toContain('label="样式预设"')
  })

  it('「桌面歌词」板块仍限定桌面端（移动端无歌词窗）', () => {
    const start = settingsSrc.indexOf('<SettingsGroup title="桌面歌词"')
    // 往前找最近的 !isNativeApp() 条件
    const guard = settingsSrc.lastIndexOf('!isNativeApp()', start)
    expect(guard).toBeGreaterThan(-1)
    // 条件与该板块之间不应插入另一个 SettingsGroup（否则说明包裹关系不对）
    const between = settingsSrc.slice(guard, start)
    expect(between).not.toContain('<SettingsGroup')
  })

  it('没有板块超过 7 行（避免再次出现单块过长）', () => {
    const blocks = [...settingsSrc.matchAll(/<SettingsGroup title="([^"]+)"[\s\S]*?<\/SettingsGroup>/g)]
    expect(blocks.length).toBeGreaterThan(0)
    for (const m of blocks) {
      const rows = countRows(m[0])
      expect(rows, `板块「${m[1]}」有 ${rows} 行，超过上限`).toBeLessThanOrEqual(7)
    }
  })

  it('左右两栏估算高度差不超过 10%（按真实行高，不按行数）', () => {
    const { left, right } = columns()
    const leftH = estimateHeight(left)
    const rightH = estimateHeight(right)
    expect(leftH).toBeGreaterThan(0)
    expect(rightH).toBeGreaterThan(0)
    const diffRatio = Math.abs(leftH - rightH) / Math.max(leftH, rightH)
    expect(
      diffRatio,
      `左栏约 ${leftH}px / 右栏约 ${rightH}px，相差 ${(diffRatio * 100).toFixed(1)}%`,
    ).toBeLessThanOrEqual(0.1)
  })

  it('云同步与歌单迁移同栏（两者同属「歌单数据」，且右栏高度已配平）', () => {
    const { left, right } = columns()
    const syncInLeft = left.includes('title="歌单云同步"')
    const transferInLeft = left.includes('title="歌单迁移"')
    expect(syncInLeft).toBe(transferInLeft)
  })

  it('账号与关于保持横跨两栏（settings-span）', () => {
    // 两个板块都挂 settings-span 类，CSS 里对应 grid-column: 1 / -1。
    // 注意：不能用 indexOf('>') 截取开标签——icon={<X size={20} />} 里就有个 '>'，
    // 会提前截断。这里直接在板块标题之后的固定窗口内找 className 声明。
    for (const title of ['账号', '关于']) {
      const start = settingsSrc.indexOf(`<SettingsGroup title="${title}"`)
      expect(start, `未找到板块「${title}」`).toBeGreaterThan(-1)
      // 该板块开标签的窗口：到下一个换行后的「>」为止（SettingsGroup 是多行或单行均可）
      const window = settingsSrc.slice(start, start + 200)
      const hasSpan = /className="settings-span"/.test(window)
      expect(hasSpan, `板块「${title}」未挂 settings-span，窗口内容：${window.split('\n')[0]}`).toBe(true)
    }
    // CSS 里该类的定义必须是横跨
    const css = readFileSync(path.resolve(__dirname, '../src/styles/index.css'), 'utf8').replace(/\r\n/g, '\n')
    const ruleStart = css.indexOf('.settings-span {')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = css.slice(ruleStart, css.indexOf('}', ruleStart))
    expect(rule).toMatch(/grid-column:\s*1\s*\/\s*-1/)
  })

  it('板块总数增加但设置项一个不少（拆分不是删除）', () => {
    // 拆分前「播放」13 行 + 「外观」6 行 + 「下载」7 行 + 云同步 3 行 + 关于 1 行
    const titles = groupTitles()
    expect(titles.length).toBeGreaterThanOrEqual(8)
    // 关键设置项逐一在场
    for (const label of [
      '音质', '自动播放', '音频可视化', '歌词显示', '歌词双语',
      '歌词文字颜色', '歌词字号', '样式预设', 'MV 无控件导出',
    ]) {
      expect(settingsSrc).toContain(`label="${label}"`)
    }
  })
})

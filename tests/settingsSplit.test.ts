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
  /*
   * v1.4.13-pre13：右栏要一直取到文件末尾，**不能**截到 settings-span 之前。
   *
   * 原实现把「账号」「关于」两块（settings-span，横跨整行）从右栏里切掉了，
   * 于是估算只算了它们上面那部分。实际渲染时这两块排在右栏下方，
   * 会让右栏明显更高——用户看到的「右栏比左栏高」就是这么来的，
   * 而测试因为漏算反而报「已配平」。
   *
   * 通栏板块在视觉上归到右栏末尾（左栏先结束），所以计入右栏才符合真实观感。
   */
  return {
    left: settingsSrc.slice(first, second),
    right: settingsSrc.slice(second),
  }
}

/**
 * 统计某段源码里的 SettingsRow 数量。
 *
 * v1.4.14-pre4：先剥掉 JSX 注释再数。注释里解释口径时会出现字面量 <SettingsRow>
 * （「测试只数静态 <SettingsRow>」这类），不剥掉就会被当成真实的行。
 */
function countRows(fragment: string): number {
  const code = fragment.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  return (code.match(/<SettingsRow\b/g) || []).length
}

/**
 * 通过 render-prop 往分组里注入行的子面板。
 *
 * 键是设置页里的 JSX 标签名，值是面板源码路径。
 * 新增这类面板时补一条，下面的行数口径才会把它算进去。
 */
const INJECTING_PANELS: Record<string, string> = {
  AiPlaylistPanel: '../src/components/AiPlaylistPanel.tsx',
  AiPortraitPanel: '../src/components/AiPortraitPanel.tsx',
}

/**
 * 读一个子面板注入的行数：常驻行 + 条件行。
 *
 * 面板不写字面量 <SettingsRow>，而是调用设置页传进去的 Row({...})。
 * 其中无条件的 Row({...}) 是常驻行；写在三元里的「? Row({...})」
 * 是预览/结果行——生成之后才出现，但用户看得到，必须计入最坏行数。
 * 按这个特征判定而不是按面板名硬编码，面板以后加减行数时这里会跟着变。
 */
function panelInjectedRows(panelPath: string): { always: number; conditional: number } {
  const src = readFileSync(path.resolve(__dirname, panelPath), 'utf8').replace(/\r\n/g, '\n')
  const total = (src.match(/\bRow\(\{/g) || []).length
  const conditional = (src.match(/[?:]\s*Row\(\{/g) || []).length
  return { always: total - conditional, conditional }
}

/**
 * v1.4.14-pre4：统计一段分组源码在**真实渲染**下的行数。
 *
 * 旧口径只数源码里的 <SettingsRow>，漏掉了子面板通过 render-prop 注入的行。
 * 于是「AI 助手」静态 4 行看着安全，真实渲染却是默认 7 行、
 * 生成歌单/画像预览后 9 行——测试一直绿着，超限只能靠人工数。
 *
 * 现在把被引用到的子面板一并计入，返回**最坏情况**（常驻行 + 条件行全展开），
 * 因为「生成预览后超限」正是这次要根治的观感问题。
 */
function countRealRows(fragment: string): number {
  let rows = countRows(fragment)
  for (const [tag, panelPath] of Object.entries(INJECTING_PANELS)) {
    if (!fragment.includes('<' + tag)) continue
    const injected = panelInjectedRows(panelPath)
    rows += injected.always + injected.conditional
  }
  return rows
}

/**
 * v1.4.14-pre10：各板块的**真机实测高度**（px）。
 *
 * 来源：Electron 36 加载 dist/index.html#/settings，视口 1728×1032，
 * 用 getBoundingClientRect() 逐块读取，两栏合计与 grid 总高一致。
 * 数值随内容变化——给板块加行、改行高、加按钮组都要重测并更新此表。
 *
 * 与栏位解耦：表按标题索引，移动板块不用改表，只有内容变化才需要改。
 */
const MEASURED_GROUP_HEIGHT: Record<string, number> = {
  外观: 456,
  // v1.4.15-pre1：均衡器入口占一行，287 + 68 = 355。
  // 实测依据：该组五行里四行普通行各 68px、睡眠定时 103.1px，
  // 表头 28.8px；旧值 287 = 3×68 + 83，加一行后必须同步改这里。
  播放: 355,
  歌单云同步: 381,
  歌单迁移: 112,
  下载: 524,
  'AI 助手': 289,
  'AI 用量': 299,
  桌面歌词: 589,
  播放页: 349,
}

/**
 * 跨两栏的板块（settings-span）。它们排在两栏下方、不属于任何一栏，
 * 所以既不计入左右栏高度，也不要求有实测值。
 */
const SPAN_TITLES = new Set(['账号', '关于'])

/**
 * 按实测表累加一段源码里出现的板块高度；缺表项直接失败，强制补测。
 *
 * 先剥掉「AI 不可用」降级分支：`!isAiSupported() ? (降级组) : (正常组)` 两份互斥渲染，
 * 静态统计必须只算正常分支，否则右栏被多算一整个「AI 助手」组。
 */
function measuredHeight(fragment: string): number {
  const code = fragment.replace(/\{!isAiSupported\(\) \? \([\s\S]*?\) : \(/, '(')
  const titles = [...code.matchAll(/<SettingsGroup title="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((t) => !SPAN_TITLES.has(t))
  let total = 0
  for (const t of titles) {
    const h = MEASURED_GROUP_HEIGHT[t]
    expect(h, '板块「' + t + '」缺少实测高度，请在 Electron 里量一次并补进 MEASURED_GROUP_HEIGHT').toBeTypeOf('number')
    total += h
  }
  // 板块间距（.settings-column 的 gap: 24px），n 块之间共 n-1 段
  return total + Math.max(0, titles.length - 1) * 24
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

  /*
   * v1.4.14-pre4：口径从「数静态 <SettingsRow>」改成「数真实渲染行」。
   *
   * 旧口径漏掉子面板注入的行，于是「AI 助手」静态 4 行 / 真实 7 行（预览后 9 行）
   * 一直是绿的。现在子面板的行也计入，且按最坏情况（预览展开）算。
   */
  it('没有板块超过 7 行（含子面板注入的行，避免再次出现单块过长）', () => {
    const blocks = [...settingsSrc.matchAll(/<SettingsGroup title="([^"]+)"[\s\S]*?<\/SettingsGroup>/g)]
    expect(blocks.length).toBeGreaterThan(0)
    for (const m of blocks) {
      const rows = countRealRows(m[0])
      expect(rows, '板块「' + m[1] + '」真实渲染有 ' + rows + ' 行，超过上限').toBeLessThanOrEqual(7)
    }
  })

  it('「AI 助手」板块真实渲染留有余量（不超过 5 行）', () => {
    /*
     * 「AI 助手」有两份互斥渲染：!isAiSupported() 时的「不可用」降级分支，
     * 和正常分支。indexOf 命中的是第一份（降级），必须往后找真正的那个。
     * 这里剥掉降级分支再定位，与 estimateHeight 的口径保持一致。
     */
    const withoutFallback = settingsSrc.replace(
      /\{!isAiSupported\(\) \? \([\s\S]*?\) : \(/,
      '(',
    )
    const start = withoutFallback.indexOf('<SettingsGroup title="AI 助手"')
    expect(start).toBeGreaterThan(-1)
    const end = withoutFallback.indexOf('</SettingsGroup>', start)
    const block = withoutFallback.slice(start, end)
    /*
     * 只断言「不超 5」而不是「正好 3」：歌单预览与画像结果各会多出一行，
     * 最坏 5 行。留 2 行缓冲是刻意的——刚好卡在 7 行等于把上限变成靶子，
     * 下次谁再加一行就又要重排。
     */
    const rows = countRealRows(block)
    expect(rows, '「AI 助手」真实渲染 ' + rows + ' 行').toBeLessThanOrEqual(5)
    // 生成入口必须还在组内（它们是功能入口，不是配置）
    expect(block).toContain('<AiPlaylistPanel')
    expect(block).toContain('<AiPortraitPanel')
  })

  /*
   * v1.4.14-pre10（用户第 1 项）：配平改用**真机实测高度**，废弃静态估算。
   *
   * 为什么换口径：用户报「设置页未配平」时，静态估算报 5.97%、测试全绿，
   * 而 Electron 加载 dist 实测（1728×1032 视口）左 1855 / 右 1597，差 13.9%。
   * 估算把「带 description 的行」一律按 80px 计、把板块头按 60px 计，
   * 与真实渲染（68/83/103/105 混排、板块头约 48px）系统性偏离，
   * 且偏离方向在两栏不同，于是估算出来的差值没有意义。
   *
   * 现在把每块的实测高度记成表：按板块标题索引，与它在哪一栏无关，
   * 所以移动板块不需要重测。新增板块若不在表里，测试直接失败并要求补测——
   * 这正是上一轮漏掉的动作。
   */
  it('左右两栏实测高度差不超过 10%（真机高度表，非估算）', () => {
    const { left, right } = columns()
    const leftH = measuredHeight(left)
    const rightH = measuredHeight(right)
    expect(leftH).toBeGreaterThan(0)
    expect(rightH).toBeGreaterThan(0)
    const diffRatio = Math.abs(leftH - rightH) / Math.max(leftH, rightH)
    expect(
      diffRatio,
      `左栏约 ${leftH}px / 右栏约 ${rightH}px，相差 ${(diffRatio * 100).toFixed(1)}%`,
    ).toBeLessThanOrEqual(0.1)
  })

  /*
   * v1.4.14-pre10（用户第 1 项）：歌单迁移从左侧移到右侧。
   *
   * 原断言要求云同步与迁移同栏。真机实测（Electron 加载 dist，1728×1032 视口）：
   * 迁移留在左栏时 左 1855 / 右 1597，差 13.9%——用户报的「未配平」属实，
   * 而当时这条断言与高度断言都是绿的，说明静态估算口径不可信。
   * 迁移组仅 112px，右移后实测 左 1719 / 右 1733，差 0.8%。
   *
   * 语义未变：两者仍同属「歌单数据搬运」，只是分列两侧。
   */
  it('云同步与歌单迁移分列两侧（为配平），但都仍在设置页', () => {
    const { left, right } = columns()
    const syncInLeft = left.includes('title="歌单云同步"')
    const transferInLeft = left.includes('title="歌单迁移"')
    const transferInRight = right.includes('title="歌单迁移"')
    expect(syncInLeft).toBe(true)
    expect(transferInRight).toBe(true)
    expect(transferInLeft).toBe(false)
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

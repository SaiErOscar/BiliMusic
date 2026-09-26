// v1.3.10 歌词窗内联 HTML 真机 harness：从 miniWindows.ts 提取 getLyricHtml 模板，
// 用 jsdom 执行，验证自动颜色改造后脚本无运行时错误、有效色回落与开关派发逻辑正确。
// 历史教训（lessons/UI调试归因与验证方法论）：CSS 按压态不证明 JS 派发，必须真派发事件读结果。
import { readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect, vi } from 'vitest'
import { JSDOM } from 'jsdom'

// 从源文件截取 getLyricHtml 返回的模板字符串（模板内无 ${} 插值，可安全截取）
// 归一化行尾符：CI 的 windows-latest 按 autocrlf 检出为 CRLF，会使下面硬编码的 LF 标记（如 `\n}）匹配不到，故统一转成 LF
const src = readFileSync(path.resolve(__dirname, '../electron/miniWindows.ts'), 'utf8').replace(/\r\n/g, '\n')
const startMarker = 'return `<!doctype html>'
const si = src.indexOf(startMarker)
expect(si).toBeGreaterThan(-1)
const bodyStart = si + 'return `'.length
const bodyEnd = src.indexOf('`\n}', bodyStart)
expect(bodyEnd).toBeGreaterThan(bodyStart)
const html = src.slice(bodyStart, bodyEnd)

function mount(initialState: Record<string, unknown>) {
  const sent: any[] = []
  let stateCb: ((s: unknown) => void) | null = null
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'data:text/html,',
    // 模拟 Windows，走 isWin 分支（色块点击弹取色、input[type=color] 不直接编辑）
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    beforeParse(window: any) {
      ;(window as any).miniAPI = {
        sendCommand: (c: any) => sent.push(c),
        onState: (cb: any) => {
          stateCb = cb
          return () => {}
        },
      }
    },
  })
  // 脚本末尾会调用 render()；随后用 onState 注入完整初始 state
  stateCb?.(initialState)
  return { dom, sent, setState: (s: unknown) => stateCb?.(s) }
}

const baseState = {
  hasTrack: true,
  title: 'X',
  artist: 'Y',
  coverUrl: 'https://x/c.jpg',
  isPlaying: true,
  volume: 50,
  isMuted: false,
  progress: 1,
  duration: 100,
  lyricLines: [{ time: 0, text: '歌词' }],
  synced: true,
  theme: 'dark',
  lyricTextColor: '#111111', // 手动文字色
  lyricControlColor: '#222222', // 手动控件色
  lyricFontSize: 30,
  lyricFontWeight: 820,
  lyricFontFamily: 'system-ui',
  repeatMode: 'none',
  autoTextColor: false,
  autoControlColor: false,
  autoLyricTextColor: '',
  autoLyricControlColor: '',
}

describe('歌词窗自动颜色 harness', () => {
  it('脚本完整执行：无运行时错误，面板与开关元素齐备', () => {
    const { dom } = mount(baseState)
    const d = dom.window.document
    expect(d.getElementById('apAutoText')).not.toBeNull()
    expect(d.getElementById('apAutoCtrl')).not.toBeNull()
    expect(d.getElementById('apTextRight')).not.toBeNull()
    // render 至少跑过一次：play 按钮已随 hasTrack 启用
    expect((d.getElementById('play') as HTMLButtonElement).disabled).toBe(false)
  })

  it('默认（自动关）显示手动色', () => {
    const { dom } = mount(baseState)
    const root = dom.window.document.documentElement
    expect(root.style.getPropertyValue('--lyric-color')).toBe('#111111')
    expect(root.style.getPropertyValue('--ctrl-color')).toBe('#222222')
  })

  it('开文字自动色→显示自动色；色块置灰；开关回显 on', () => {
    const { dom, setState } = mount(baseState)
    setState({ ...baseState, autoTextColor: true, autoLyricTextColor: '#ff375f' })
    const root = dom.window.document.documentElement
    expect(root.style.getPropertyValue('--lyric-color')).toBe('#ff375f')
    const d = dom.window.document
    expect((d.getElementById('apAutoText') as HTMLInputElement).checked).toBe(true)
    expect(d.getElementById('apTextRight')!.className).toContain('dim')
    // 色块显示自动色（作为预览）
    expect((d.getElementById('apTextColor') as HTMLInputElement).value).toBe('#ff375f')
  })

  it('自动开时色块置灰后，拖字号仍不把自动色当手动色发回（防污染）', () => {
    const { dom, sent, setState } = mount({
      ...baseState,
      autoTextColor: true,
      autoLyricTextColor: '#ff375f',
      autoControlColor: true,
      autoLyricControlColor: '#00aa88',
    })
    const d = dom.window.document
    const font = d.getElementById('apFontSize') as HTMLInputElement
    font.value = '40'
    font.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    // 找最近一条 update-lyric-appearance：手动色应保持原 #111111/#222222，不得被自动色污染
    const ap = [...sent].reverse().find((c) => c.type === 'update-lyric-appearance')
    expect(ap).toBeTruthy()
    expect(ap.lyricTextColor).toBe('#111111')
    expect(ap.lyricControlColor).toBe('#222222')
    expect(ap.lyricFontSize).toBe(40)
    void setState
  })

  it('面板自动开关派发：点文字自动→发 autoTextColor:true 且色块置灰', () => {
    const { dom, sent } = mount(baseState)
    const d = dom.window.document
    const cb = d.getElementById('apAutoText') as HTMLInputElement
    cb.checked = true
    cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    const last = sent[sent.length - 1]
    expect(last).toEqual({ type: 'update-lyric-appearance', autoTextColor: true })
    expect(d.getElementById('apTextRight')!.className).toContain('dim')
    // 本地乐观：即使还没回流，歌词色不应被清空（此时自动色未就绪，回落手动色）
    const root = d.documentElement
    expect(root.style.getPropertyValue('--lyric-color')).toBe('#111111')
  })

  it('控件自动开+自动色就绪→ctrl 显示自动色', () => {
    const { setState, dom } = mount(baseState)
    setState({ ...baseState, autoControlColor: true, autoLyricControlColor: '#00ff88' })
    const root = dom.window.document.documentElement
    expect(root.style.getPropertyValue('--ctrl-color')).toBe('#00ff88')
  })

  it('关回自动色：autoLyricTextColor 仍在但开关关→立即回落手动色', () => {
    const { setState, dom } = mount({
      ...baseState,
      autoTextColor: true,
      autoLyricTextColor: '#ff375f',
    })
    // 用户关掉开关，但自动色缓存仍在
    setState({ ...baseState, autoTextColor: false, autoLyricTextColor: '#ff375f' })
    const root = dom.window.document.documentElement
    expect(root.style.getPropertyValue('--lyric-color')).toBe('#111111')
  })
})

void vi

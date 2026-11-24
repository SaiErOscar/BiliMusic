// v1.4.17-pre1 桌面歌词双语 + 长行滚动 + 本地歌词文件
//
// 三项各自都有一个「看起来对、实际从来没生效」的反向场景，逐条给出正反断言。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  estimateTextWidth,
  isLineTooLong,
  planLyricLayout,
} from '../src/services/desktopLyricLines'
import {
  LYRIC_EXTENSIONS,
  checkLyricFileContent,
  fileNameOf,
  localLyricCacheKey,
  looksSynced,
  siblingLyricPaths,
} from '../src/services/localLyrics'

/** 读源码统一换行：CI 的 windows-latest 检出是 CRLF，按 LF 写死的断言会「本地绿、CI 红」 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

/*
 * 一、双语副行
 *
 * 根因：useMiniWindowSync 读的是 line.ttext，而 LyricLine 的真字段是 translation，
 * ttext 全项目仅此一处，永远取到 undefined —— 官方译文从来没进过歌词窗。
 * 渲染端另有第二个断点：sub 只有类型声明，歌词窗 HTML 从未渲染它。
 */
describe('桌面歌词双语：数据端与渲染端都真的接通了', () => {
  const sync = read('src/hooks/useMiniWindowSync.ts')
  const mini = read('electron/miniWindows.ts')

  it('读的是 translation，不再只读不存在的 ttext', () => {
    expect(sync).toMatch(/line\.translation/)
    // 旧写法把 ttext 当唯一来源，必须消失
    expect(sync).not.toMatch(/const translated = \(line as \{ ttext\?: string \}\)\.ttext/)
  })

  it('歌词窗 HTML 里真的有副行元素', () => {
    expect(mini).toMatch(/id="sub"/)
  })

  it('副行有样式（不是只有元素没有外观）', () => {
    expect(mini).toMatch(/\.sub\s*\{/)
  })

  it('renderLyric 会把 sub 写进副行元素', () => {
    expect(mini).toMatch(/subEl\.textContent = sub/)
  })

  it('没有副行时会隐藏副行，不留空白占位', () => {
    expect(mini).toMatch(/subEl\.style\.display = 'none'/)
  })
})

/*
 * 二、长行处理
 *
 * 用户口径：非双语允许占两行，不要一行放不下就滚动；双语时主行放不下才滚动。
 * 滚动按这句的演唱时长与歌词长度算，只滚一次不循环。
 */
describe('长行：非双语可两行，双语超长才滚动', () => {
  const W = 592
  const FS = 30

  it('放得下就是 plain', () => {
    const plan = planLyricLayout({ text: '短歌词', fontSize: FS, availableWidth: W, hasSub: false })
    expect(plan.mode).toBe('plain')
    expect(plan.scrollDistance).toBe(0)
  })

  it('单语略超宽 → 折成两行，不滚动', () => {
    // 宽约 1.5 倍可用宽度：两行放得下
    const text = '这是一句比较长的歌词'.repeat(3)
    const plan = planLyricLayout({ text, fontSize: FS, availableWidth: W, hasSub: false })
    expect(plan.mode).toBe('wrap')
    expect(plan.scrollMs).toBe(0)
  })

  it('**关键**：同样长度，带副行（双语）时必须滚动而不是折行', () => {
    const text = '这是一句比较长的歌词'.repeat(3)
    const single = planLyricLayout({ text, fontSize: FS, availableWidth: W, hasSub: false })
    const dual = planLyricLayout({ text, fontSize: FS, availableWidth: W, hasSub: true })
    expect(single.mode).toBe('wrap')
    expect(dual.mode).toBe('scroll')
    expect(dual.scrollDistance).toBeGreaterThan(0)
  })

  it('单语但超过两行宽 → 也滚动（两行也放不下）', () => {
    const text = '这是一句非常非常长的歌词'.repeat(10)
    const plan = planLyricLayout({ text, fontSize: FS, availableWidth: W, hasSub: false })
    expect(plan.mode).toBe('scroll')
  })

  it('滚动时长随距离增长（取未触顶上限的区间）', () => {
    // 距离 = 估算宽 - 可用宽；两档都远低于 9000ms 上限，才能比出「越长越慢」
    const near = planLyricLayout({ text: 'x'.repeat(40), fontSize: FS, availableWidth: 600, hasSub: true })
    const far = planLyricLayout({ text: 'x'.repeat(80), fontSize: FS, availableWidth: 600, hasSub: true })
    expect(near.mode).toBe('scroll')
    expect(far.mode).toBe('scroll')
    expect(far.scrollMs).toBeGreaterThan(near.scrollMs)
  })

  it('滚动时长不超过这句的演唱时长（唱完前要滚到位）', () => {
    const plan = planLyricLayout({
      text: '这是一句很长很长的歌词'.repeat(8),
      fontSize: FS,
      availableWidth: 200,
      hasSub: true,
      lineSeconds: 2,
    })
    // 留 20% 余量
    expect(plan.scrollMs).toBeLessThanOrEqual(2000 * 0.8)
  })

  it('滚动时长有上下限，不会短到看不见也不会长到离谱', () => {
    const tiny = planLyricLayout({ text: 'x'.repeat(30), fontSize: FS, availableWidth: 10, hasSub: true, lineSeconds: 0.1 })
    expect(tiny.scrollMs).toBeGreaterThanOrEqual(900)
    const huge = planLyricLayout({ text: 'x'.repeat(5000), fontSize: FS, availableWidth: 100, hasSub: true })
    expect(huge.scrollMs).toBeLessThanOrEqual(9000)
  })

  it('**关键**：动画只播一次，不循环', () => {
    const mini = read('electron/miniWindows.ts')
    // animation ... 1 forwards —— 次数必须是 1，且 forwards 停在末尾不回弹
    expect(mini).toMatch(/animation:\s*lyric-scroll\s+var\(--scroll-ms[^;]*\)\s*[^;]*\s1\s+forwards/)
    expect(mini).not.toMatch(/animation:\s*lyric-scroll[^;]*infinite/)
  })

  it('只在换句时重启动画，进度推送不会反复触发', () => {
    const mini = read('electron/miniWindows.ts')
    expect(mini).toMatch(/lastRenderedIdx/)
    expect(mini).toMatch(/const changed = idx !== lastRenderedIdx/)
  })

  it('歌词区会裁切，超长内容不会盖住控制条', () => {
    const mini = read('electron/miniWindows.ts')
    expect(mini).toMatch(/\.lyric\s*\{[^}]*overflow:\s*hidden/)
    expect(mini).toMatch(/\.lyric\s*\{[^}]*min-height:\s*0/)
  })

  it('宽度估算：中文按 1em、拉丁按 0.55em', () => {
    expect(estimateTextWidth('中文', 30)).toBe(60)
    expect(estimateTextWidth('ab', 30)).toBeCloseTo(33, 0)
    expect(isLineTooLong('中文中文', 30, 100)).toBe(true)
  })
})

/*
 * 三、本地歌词文件
 */
describe('本地歌词：同目录同名自动匹配', () => {
  it('同目录同名 .lrc 优先，其次 .txt', () => {
    expect(siblingLyricPaths('D:/music/歌.mp3')).toEqual(['D:/music/歌.lrc', 'D:/music/歌.txt'])
  })

  it('Windows 反斜杠路径也认', () => {
    expect(siblingLyricPaths('D:\\music\\歌.flac')).toEqual(['D:/music/歌.lrc', 'D:/music/歌.txt'])
  })

  it('**关键**：名字不完全相同就不匹配（歌 - 副本 不算）', () => {
    const paths = siblingLyricPaths('D:/music/歌.mp3')
    expect(paths).not.toContain('D:/music/歌 - 副本.lrc')
  })

  it('多个点只替换最后一段扩展名', () => {
    expect(siblingLyricPaths('D:/m/artist.song.name.m4a')[0]).toBe('D:/m/artist.song.name.lrc')
  })

  it('空路径返回空数组', () => {
    expect(siblingLyricPaths('')).toEqual([])
  })

  it('只有 .lrc 与 .txt 两种扩展名', () => {
    expect([...LYRIC_EXTENSIONS]).toEqual(['.lrc', '.txt'])
  })

  it('主进程侧有一份同口径实现（两份必须同步）', () => {
    const main = read('electron/lyricsApi.ts')
    expect(main).toMatch(/siblingLyricCandidates/)
    expect(main).toMatch(/\['\.lrc', '\.txt'\]/)
  })
})

describe('本地歌词：内容校验与缓存键', () => {
  it('带时间轴 → synced', () => {
    const r = checkLyricFileContent('[00:12.34]第一句\n[00:18.00]第二句')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.synced).toBe(true)
  })

  it('纯文本 → 能用但不同步', () => {
    const r = checkLyricFileContent('第一句\n第二句')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.synced).toBe(false)
  })

  it('空文件被拒', () => {
    expect(checkLyricFileContent('   \n  ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('**关键**：二进制文件被拒（用户选错文件时给明确原因）', () => {
    expect(checkLyricFileContent('\u0000\u0001\u0002abc')).toEqual({ ok: false, reason: 'binary' })
  })

  it('BOM 被剥掉，否则第一行时间标签解析失败', () => {
    const r = checkLyricFileContent('\uFEFF[00:01.00]第一句')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content.startsWith('[00:01.00]')).toBe(true)
      expect(r.synced).toBe(true)
    }
  })

  it('本地曲目与 B 站曲目用不同的缓存键，不会互相覆盖', () => {
    const local = localLyricCacheKey({ localPath: 'D:/m/a.mp3' })
    const bili = localLyricCacheKey({ bvid: 'BV1xx' })
    expect(local).not.toBe(bili)
    expect(local.startsWith('local:')).toBe(true)
  })

  it('路径大小写不同视为同一首', () => {
    expect(localLyricCacheKey({ localPath: 'D:/M/A.MP3' })).toBe(localLyricCacheKey({ localPath: 'd:/m/a.mp3' }))
  })

  it('looksSynced 认多种时间格式', () => {
    expect(looksSynced('[00:01]x')).toBe(true)
    expect(looksSynced('[1:02.5]x')).toBe(true)
    expect(looksSynced('没有时间轴')).toBe(false)
  })

  it('fileNameOf 取文件名用于界面提示', () => {
    expect(fileNameOf('D:/m/歌.lrc')).toBe('歌.lrc')
    expect(fileNameOf('D:\\m\\歌.lrc')).toBe('歌.lrc')
  })
})

describe('本地歌词：接入取词链路', () => {
  const lyrics = read('src/services/lyrics.ts')

  it('getLyricForTrack 先试本地歌词，再联网', () => {
    const body = lyrics.slice(lyrics.indexOf('export async function getLyricForTrack'))
    const localIdx = body.indexOf('getLocalLyricForTrack')
    const netIdx = body.indexOf('searchBestCandidate')
    expect(localIdx).toBeGreaterThan(-1)
    expect(netIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeLessThan(netIdx)
  })

  it('手动导入的优先于同目录同名自动匹配', () => {
    const body = lyrics.slice(
      lyrics.indexOf('export async function getLocalLyricForTrack'),
      lyrics.indexOf('export async function importLocalLyricFile'),
    )
    // 先查缓存（手动导入写入的就是它），再走 readLocal
    expect(body.indexOf("imported?.status === 'ok'")).toBeLessThan(body.indexOf('api.readLocal'))
  })

  it('B 站曲目也能手动导入（没有 localPath 也要能走 importLocalLyricFile）', () => {
    const body = lyrics.slice(lyrics.indexOf('export async function importLocalLyricFile'))
    expect(body).not.toMatch(/if \(!track\.localPath\) return/)
  })

  it('LyricSource 增加 local 且有中文标签', () => {
    expect(lyrics).toMatch(/'local'/)
    expect(lyrics).toMatch(/local:\s*'本地'/)
  })
})

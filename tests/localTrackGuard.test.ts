// v1.4.16-pre1 本地曲目不得触发 B 站取流
//
// 缺陷根因：本地曲目 bvid 为空，但 id 是路径派生的 local_xxx（非空），
// 于是各处的 `!bvid && !id` 守卫全部失效，下游把 local_xxx 当 B 站稿件号请求，
// 必然 404。本地音乐页每一行都渲染默认操作组，所以用户点下载/导出 MV 必失败。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Track } from '../src/types'

function biliTrack(): Track {
  return {
    id: 'BV1xx411c7mD',
    title: 'B 站曲目',
    artist: '歌手',
    coverUrl: '',
    duration: 200,
    videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    bvid: 'BV1xx411c7mD',
    playCount: 0,
    isLiked: false,
  }
}

function localTrack(): Track {
  return {
    id: 'local_96c4ea240ce5f692',
    title: '本地曲目',
    artist: '',
    coverUrl: '',
    duration: 0,
    videoUrl: '',
    bvid: '',
    playCount: 0,
    isLiked: false,
    localPath: 'C:\\Music\\a.mp3',
  }
}

/**
 * 复刻 DownloadButton 的渲染守卫（与 src/components/DownloadButton.tsx 同逻辑）。
 * 抽成纯函数便于单测——组件本身要渲染 React，测起来重。
 */
function shouldRenderDownload(track: Track, bvid?: string): boolean {
  const actualBvid = bvid || track.bvid || track.id
  const actualId = track.id
  if (track.localPath || actualBvid?.startsWith('local_')) return false
  if (!actualBvid || !actualId) return false
  return true
}

/** 复刻助手的单曲下载守卫 */
function assistantCanDownload(track: Track): boolean {
  if (track.localPath || (!track.bvid && !track.id)) return false
  return true
}

describe('下载入口守卫：本地曲目必须被挡下', () => {
  it('本地曲目不渲染下载按钮', () => {
    expect(shouldRenderDownload(localTrack())).toBe(false)
  })

  it('本地曲目即使显式传入 local_ 前缀的 bvid 也被挡下', () => {
    expect(shouldRenderDownload(localTrack(), 'local_abc123')).toBe(false)
  })

  it('B 站曲目正常渲染', () => {
    expect(shouldRenderDownload(biliTrack())).toBe(true)
  })

  it('**回归**：只看 id 非空会误放行本地曲目（说明旧守卫为何失效）', () => {
    const t = localTrack()
    // 旧逻辑：!bvid && !id → false（因为 id 非空），于是放行
    const oldGuardWouldPass = !(!t.bvid && !t.id)
    expect(oldGuardWouldPass).toBe(true) // 旧守卫确实放行了
    // 新逻辑必须挡住
    expect(shouldRenderDownload(t)).toBe(false)
  })
})

describe('源码级守卫：防止复刻逻辑正确但实现被删', () => {
  // 上面的用例复刻了组件逻辑——它们只能证明"我理解的逻辑对"，
  // 证明不了"组件里真的有这段守卫"。这里直接读源码断言，
  // 有人把守卫删掉时这条会红（纯逻辑复刻抓不到）。
  const readSrc = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

  it('DownloadButton 真的包含 localPath 守卫', () => {
    const src = readSrc('src/components/DownloadButton.tsx')
    expect(src).toContain('actualTrack?.localPath')
    expect(src).toContain("actualBvid?.startsWith('local_')")
  })

  it('assistantExecutor 的单曲下载真的包含 localPath 守卫', () => {
    const src = readSrc('src/services/assistantExecutor.ts')
    expect(src).toMatch(/track\.localPath \|\| \(!track\.bvid && !track\.id\)/)
  })

  it('assistantExecutor 的批量下载真的跳过本地曲目', () => {
    const src = readSrc('src/services/assistantExecutor.ts')
    expect(src).toContain('本地曲目，无需下载')
  })
})

describe('助手下载守卫：本地曲目给出明确原因', () => {
  it('本地曲目不允许下载', () => {
    expect(assistantCanDownload(localTrack())).toBe(false)
  })

  it('B 站曲目允许下载', () => {
    expect(assistantCanDownload(biliTrack())).toBe(true)
  })

  it('既无 bvid 也无 id 的异常曲目仍被挡下', () => {
    const broken = { ...biliTrack(), bvid: '', id: '' }
    expect(assistantCanDownload(broken)).toBe(false)
  })
})

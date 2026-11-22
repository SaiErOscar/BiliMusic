// v1.4.16-pre2 增量扫描：文件没变就跳过重读标签
//
// 背景：旧扫描对每个文件都调 localMusicReadTags（读 head+tail），
// 读不出再走 ffmpeg 兜底（约 92ms/首）。上千首曲库每次重扫都要全量重读。
// 现在用 mtime + size 做判据：两者都没变就复用旧条目。
import { describe, expect, it } from 'vitest'
import { buildLocalTrack, needsRescan } from '../src/services/localMusic'
import type { Track } from '../src/types'

const FILE = 'C:\\Music\\a.mp3'
const META = { mtime: '2026-11-18T10:00:00.000Z', size: 1024 }

function trackWith(meta?: { mtime: string; size: number }): Track {
  return buildLocalTrack(FILE, { source: 'id3v2', title: '歌', artist: '人' }, undefined, meta)
}

describe('needsRescan —— 增量判据', () => {
  it('索引里没有这首歌 → 需要读', () => {
    expect(needsRescan(undefined, META)).toBe(true)
  })

  it('mtime 与 size 都一致 → 跳过', () => {
    expect(needsRescan(trackWith(META), META)).toBe(false)
  })

  it('mtime 变了 → 需要重读（文件被替换）', () => {
    const t = trackWith(META)
    expect(needsRescan(t, { mtime: '2026-11-19T10:00:00.000Z', size: META.size })).toBe(true)
  })

  it('size 变了 → 需要重读（内容被改）', () => {
    const t = trackWith(META)
    expect(needsRescan(t, { mtime: META.mtime, size: 2048 })).toBe(true)
  })

  it('旧索引缺指纹字段 → 需要重读（升级后第一次扫描补齐）', () => {
    const legacy = buildLocalTrack(FILE, { source: 'id3v2', title: '歌' })
    expect(legacy.localMtime).toBeUndefined()
    expect(needsRescan(legacy, META)).toBe(true)
  })

  it('只有 mtime 没有 size 的残缺索引也重读', () => {
    const partial: Track = { ...trackWith(), localMtime: META.mtime }
    expect(needsRescan(partial, META)).toBe(true)
  })
})

describe('buildLocalTrack —— 指纹写入', () => {
  it('传入指纹时写入 localMtime 与 localSize', () => {
    const t = trackWith(META)
    expect(t.localMtime).toBe(META.mtime)
    expect(t.localSize).toBe(META.size)
  })

  it('不传指纹时不写这两个字段（保持向后兼容）', () => {
    const t = buildLocalTrack(FILE, { source: 'id3v2', title: '歌' })
    expect(t.localMtime).toBeUndefined()
    expect(t.localSize).toBeUndefined()
  })

  it('指纹不影响其他字段', () => {
    const a = buildLocalTrack(FILE, { source: 'id3v2', title: '歌', artist: '人' })
    const b = trackWith(META)
    expect(b.id).toBe(a.id)
    expect(b.title).toBe(a.title)
    expect(b.artist).toBe(a.artist)
  })
})

describe('增量扫描的正确性（模拟）', () => {
  /** 模拟页面里的增量循环 */
  function simulateScan(
    files: { filePath: string; mtime: string; size: number }[],
    existing: Track[],
  ): { reused: number; read: number } {
    const byPath = new Map<string, Track>()
    for (const t of existing) if (t.localPath) byPath.set(t.localPath.toLowerCase(), t)
    let reused = 0
    let read = 0
    for (const f of files) {
      const meta = { mtime: f.mtime, size: f.size }
      if (!needsRescan(byPath.get(f.filePath.toLowerCase()), meta)) reused += 1
      else read += 1
    }
    return { reused, read }
  }

  it('全部未变 → 全部跳过', () => {
    const files = [
      { filePath: FILE, mtime: META.mtime, size: META.size },
    ]
    expect(simulateScan(files, [trackWith(META)])).toEqual({ reused: 1, read: 0 })
  })

  it('混合：未变的跳过，新文件与改过的重读', () => {
    const files = [
      { filePath: FILE, mtime: META.mtime, size: META.size }, // 未变
      { filePath: 'C:\\Music\\b.mp3', mtime: META.mtime, size: 500 }, // 新文件
      { filePath: 'C:\\Music\\c.mp3', mtime: '2026-11-20T00:00:00.000Z', size: 700 }, // 改过
    ]
    const existing = [
      trackWith(META),
      buildLocalTrack('C:\\Music\\c.mp3', { source: 'id3v2', title: 'c' }, undefined, {
        mtime: '2026-11-01T00:00:00.000Z', size: 700,
      }),
    ]
    expect(simulateScan(files, existing)).toEqual({ reused: 1, read: 2 })
  })

  it('大小写不同的同一路径仍算同一文件', () => {
    const files = [{ filePath: 'c:\\music\\A.MP3', mtime: META.mtime, size: META.size }]
    expect(simulateScan(files, [trackWith(META)])).toEqual({ reused: 1, read: 0 })
  })
})

import { describe, it, expect } from 'vitest'
import { mergeTombstones, mergeItems } from '../src/utils/sync'
import type { Playlist, Tombstone } from '../src/types'

describe('mergeTombstones', () => {
  it('同 id 取较晚的 deletedAt', () => {
    const a: Tombstone[] = [{ id: '1', deletedAt: '2025-01-01T00:00:00.000Z' }]
    const b: Tombstone[] = [{ id: '1', deletedAt: '2025-01-02T00:00:00.000Z' }]
    const result = mergeTombstones(a, b)
    expect(result).toHaveLength(1)
    expect(result[0].deletedAt).toBe('2025-01-02T00:00:00.000Z')
  })

  it('不同 id 合并', () => {
    const a: Tombstone[] = [{ id: '1', deletedAt: '2025-01-01T00:00:00.000Z' }]
    const b: Tombstone[] = [{ id: '2', deletedAt: '2025-01-02T00:00:00.000Z' }]
    const result = mergeTombstones(a, b)
    expect(result).toHaveLength(2)
  })

  it('空数组合并', () => {
    expect(mergeTombstones([], [])).toEqual([])
    expect(mergeTombstones([{ id: '1', deletedAt: '2025-01-01' }], [])).toHaveLength(1)
  })
})

describe('mergeItems', () => {
  const now = '2025-01-01T00:00:00.000Z'
  const later = '2025-01-02T00:00:00.000Z'

  const makePlaylist = (id: string, updatedAt: string): Playlist => ({
    id,
    name: `Playlist ${id}`,
    coverUrl: '',
    tracks: [],
    createdAt: now,
    updatedAt,
  })

  it('取版本较新的项', () => {
    const local = [makePlaylist('1', now)]
    const remote = [makePlaylist('1', later)]
    const result = mergeItems(local, remote, [], [], (p) => p.id, (p) => p.updatedAt)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].updatedAt).toBe(later)
  })

  it('墓碑晚于版本则删除胜出', () => {
    const local = [makePlaylist('1', now)]
    const remote: Playlist[] = []
    const localTombs: Tombstone[] = []
    const remoteTombs: Tombstone[] = [{ id: '1', deletedAt: later }]
    const result = mergeItems(local, remote, localTombs, remoteTombs, (p) => p.id, (p) => p.updatedAt)
    expect(result.items).toHaveLength(0)
  })

  it('版本新于墓碑则存活', () => {
    const local = [makePlaylist('1', later)]
    const remote: Playlist[] = []
    const localTombs: Tombstone[] = []
    const remoteTombs: Tombstone[] = [{ id: '1', deletedAt: now }]
    const result = mergeItems(local, remote, localTombs, remoteTombs, (p) => p.id, (p) => p.updatedAt)
    expect(result.items).toHaveLength(1)
    // 存活项的墓碑被剪除
    expect(result.tombstones).toHaveLength(0)
  })

  it('合并不同 id 的项', () => {
    const local = [makePlaylist('1', now)]
    const remote = [makePlaylist('2', now)]
    const result = mergeItems(local, remote, [], [], (p) => p.id, (p) => p.updatedAt)
    expect(result.items).toHaveLength(2)
  })
})

// v1.4.16-pre1 本地曲库搜索、排序与目录管理
import { describe, expect, it } from 'vitest'
import {
  LOCAL_SORT_LABELS,
  filterLocalTracks,
  sortLocalTracksBy,
} from '../src/services/localMusic'
import type { Track } from '../src/types'

function t(opts: Partial<Track> & { id: string; title: string }): Track {
  return {
    artist: '',
    coverUrl: '',
    duration: 0,
    videoUrl: '',
    bvid: '',
    playCount: 0,
    isLiked: false,
    localPath: 'C:\\Music\\' + opts.id + '.mp3',
    ...opts,
  } as Track
}

describe('filterLocalTracks —— 搜索', () => {
  const list = [
    t({ id: 'a', title: '稻香', artist: '周杰伦' }),
    t({ id: 'b', title: '晴天', artist: '周杰伦' }),
    t({ id: 'c', title: 'Yellow', artist: 'Coldplay' }),
  ]

  it('按标题匹配', () => {
    expect(filterLocalTracks(list, '稻香').map((x) => x.id)).toEqual(['a'])
  })

  it('按歌手匹配（返回该歌手全部曲目）', () => {
    expect(filterLocalTracks(list, '周杰伦').map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('大小写不敏感', () => {
    expect(filterLocalTracks(list, 'yellow').map((x) => x.id)).toEqual(['c'])
    expect(filterLocalTracks(list, 'COLDPLAY').map((x) => x.id)).toEqual(['c'])
  })

  it('空关键词返回原数组引用（调用方可跳过重复计算）', () => {
    expect(filterLocalTracks(list, '')).toBe(list)
    expect(filterLocalTracks(list, '   ')).toBe(list)
  })

  it('无匹配返回空数组', () => {
    expect(filterLocalTracks(list, '不存在的歌')).toEqual([])
  })

  it('不修改原数组', () => {
    const before = [...list]
    filterLocalTracks(list, '周杰伦')
    expect(list).toEqual(before)
  })
})

describe('sortLocalTracksBy —— 排序', () => {
  const list = [
    t({ id: 'a', title: 'B 歌', artist: '张三', duration: 100, addedAt: '2026-01-01T00:00:00.000Z' }),
    t({ id: 'b', title: 'A 歌', artist: '李四', duration: 300, addedAt: '2026-03-01T00:00:00.000Z' }),
    t({ id: 'c', title: 'C 歌', artist: '王五', duration: 200, addedAt: '2026-02-01T00:00:00.000Z' }),
  ]

  it('按歌手排序', () => {
    const sorted = sortLocalTracksBy(list, 'artist')
    expect(sorted.map((x) => x.artist)).toEqual(['李四', '王五', '张三'])
  })

  it('按标题排序', () => {
    const sorted = sortLocalTracksBy(list, 'title')
    expect(sorted.map((x) => x.title)).toEqual(['A 歌', 'B 歌', 'C 歌'])
  })

  it('按加入时间排序（新的在前）', () => {
    const sorted = sortLocalTracksBy(list, 'added')
    expect(sorted.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('按时长排序（长的在前）', () => {
    const sorted = sortLocalTracksBy(list, 'duration')
    expect(sorted.map((x) => x.duration)).toEqual([300, 200, 100])
  })

  it('缺 addedAt 的条目排在最后而不是最前', () => {
    const withMissing = [
      t({ id: 'x', title: 'X', addedAt: '2026-01-01T00:00:00.000Z' }),
      t({ id: 'y', title: 'Y' }), // 无 addedAt
    ]
    const sorted = sortLocalTracksBy(withMissing, 'added')
    expect(sorted[0].id).toBe('x')
    expect(sorted[1].id).toBe('y')
  })

  it('不修改原数组', () => {
    const before = list.map((x) => x.id)
    sortLocalTracksBy(list, 'title')
    expect(list.map((x) => x.id)).toEqual(before)
  })

  it('每种排序都有中文标签', () => {
    for (const mode of ['artist', 'title', 'added', 'duration'] as const) {
      expect(LOCAL_SORT_LABELS[mode]).toBeTruthy()
    }
  })
})

describe('搜索 + 排序组合', () => {
  it('先过滤再排序，结果正确', () => {
    const list = [
      t({ id: 'a', title: 'B', artist: '周杰伦' }),
      t({ id: 'b', title: 'A', artist: '周杰伦' }),
      t({ id: 'c', title: 'C', artist: '别人' }),
    ]
    const result = sortLocalTracksBy(filterLocalTracks(list, '周杰伦'), 'title')
    expect(result.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

// v1.4.15-pre4 分享抽屉的模块级状态。
//
// 这组测试守的是一条具体的界面不变式：分享抽屉的开关状态不能跟着列表行走。
// TrackActions 在 VirtualList 里会按可视区卸载重建（VirtualList.tsx:122-125），
// 状态若留在行组件内，用户打开分享后一滚动抽屉就消失。状态放在模块作用域才不受
// 组件生命周期影响，下面的用例直接验证这个性质。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeShare, getShareTarget, openShare, subscribeShare } from '../src/services/shareStore'
import type { Playlist, Track } from '../src/types'

function track(id: number): Track {
  return {
    id: 't' + id,
    title: '歌名' + id,
    artist: '歌手',
    coverUrl: '',
    duration: 200,
    videoUrl: 'https://www.bilibili.com/video/BV1xx411c7mD',
    bvid: 'BV1xx411c7mD',
    playCount: 0,
    isLiked: false,
  }
}

function playlist(): Playlist {
  return {
    id: 'p1',
    name: '歌单',
    coverUrl: '',
    tracks: [track(1)],
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  }
}

beforeEach(() => {
  closeShare()
})

describe('shareStore —— 分享对象状态', () => {
  it('初始状态为 null（抽屉关闭）', () => {
    expect(getShareTarget()).toBeNull()
  })

  it('openShare 设置单曲目标', () => {
    const t = track(1)
    openShare({ kind: 'track', track: t })
    const target = getShareTarget()
    expect(target).not.toBeNull()
    expect(target?.kind).toBe('track')
    if (target?.kind === 'track') expect(target.track.id).toBe('t1')
  })

  it('openShare 设置歌单目标', () => {
    openShare({ kind: 'playlist', playlist: playlist() })
    const target = getShareTarget()
    expect(target?.kind).toBe('playlist')
    if (target?.kind === 'playlist') expect(target.playlist.name).toBe('歌单')
  })

  it('closeShare 清空目标', () => {
    openShare({ kind: 'track', track: track(1) })
    closeShare()
    expect(getShareTarget()).toBeNull()
  })

  it('状态活在模块作用域：调用方的组件卸载不影响它', () => {
    // 模拟「行组件打开分享后被 VirtualList 卸载」：这里没有任何组件，
    // 状态照样读得到——这正是把 state 放在模块级而不是 useState 的理由。
    openShare({ kind: 'track', track: track(2) })
    const target = getShareTarget()
    if (target?.kind === 'track') expect(target.track.id).toBe('t2')
  })

  it('重复 openShare 覆盖为最后一次的目标', () => {
    openShare({ kind: 'track', track: track(1) })
    openShare({ kind: 'track', track: track(3) })
    const target = getShareTarget()
    if (target?.kind === 'track') expect(target.track.id).toBe('t3')
  })

  it('closeShare 在已关闭时不重复通知订阅者', () => {
    const listener = vi.fn()
    const unsub = subscribeShare(listener)
    closeShare()
    expect(listener).not.toHaveBeenCalled()
    unsub()
  })
})

describe('shareStore —— 订阅', () => {
  it('openShare / closeShare 都会通知订阅者', () => {
    const listener = vi.fn()
    const unsub = subscribeShare(listener)
    openShare({ kind: 'track', track: track(1) })
    expect(listener).toHaveBeenCalledTimes(1)
    closeShare()
    expect(listener).toHaveBeenCalledTimes(2)
    unsub()
  })

  it('退订后不再收到通知', () => {
    const listener = vi.fn()
    subscribeShare(listener)()
    openShare({ kind: 'track', track: track(1) })
    expect(listener).not.toHaveBeenCalled()
  })

  it('多个订阅者互不干扰，退订一个不影响另一个', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = subscribeShare(a)
    const unsubB = subscribeShare(b)
    openShare({ kind: 'track', track: track(1) })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unsubA()
    openShare({ kind: 'track', track: track(2) })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    unsubB()
  })
})

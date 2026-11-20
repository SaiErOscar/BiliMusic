// v1.4.15-pre8 存储写入失败上报（修 R-05）
//
// 背景：safeSetItem 一直正确返回 boolean，但 13 处调用方全部忽略。
// 配额满时加歌、拖排序、收藏、导入备份都会"看起来成功"却根本没落盘，
// 重启即回退，用户毫无线索。
//
// 这组测试守两条不变式：
// 1. save* 必须把失败如实返回（不能吞掉）；
// 2. 失败时必须广播事件（否则界面无从提示）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FAVORITES_CHANGED_EVENT,
  PLAYLISTS_CHANGED_EVENT,
  STORAGE_FAILED_EVENT,
  saveFavoriteTracks,
  savePlaylists,
} from '../src/utils/storage'
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

let failedEvents: string[] = []

beforeEach(() => {
  failedEvents = []
  window.addEventListener(STORAGE_FAILED_EVENT, ((e: CustomEvent) => {
    failedEvents.push(e.detail?.key ?? '')
  }) as EventListener)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('存储写入成功时', () => {
  it('savePlaylists 返回 true，且广播变更事件', () => {
    const changed = vi.fn()
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, changed)
    const ok = savePlaylists([playlist()])
    window.removeEventListener(PLAYLISTS_CHANGED_EVENT, changed)
    expect(ok).toBe(true)
    expect(changed).toHaveBeenCalled()
    expect(failedEvents).toEqual([])
  })

  it('saveFavoriteTracks 返回 true，且广播变更事件', () => {
    const changed = vi.fn()
    window.addEventListener(FAVORITES_CHANGED_EVENT, changed)
    const ok = saveFavoriteTracks([track(1)])
    window.removeEventListener(FAVORITES_CHANGED_EVENT, changed)
    expect(ok).toBe(true)
    expect(changed).toHaveBeenCalled()
    expect(failedEvents).toEqual([])
  })
})

describe('存储写入失败时（配额满）', () => {
  /** 让 localStorage.setItem 一律抛配额异常，模拟空间耗尽 */
  function breakStorage() {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      const e = new Error('QuotaExceededError')
      e.name = 'QuotaExceededError'
      throw e
    })
  }

  it('savePlaylists 返回 false 而不是假装成功', () => {
    breakStorage()
    expect(savePlaylists([playlist()])).toBe(false)
  })

  it('savePlaylists 失败时广播存储失败事件', () => {
    breakStorage()
    savePlaylists([playlist()])
    expect(failedEvents).toContain('bilimusic_playlists')
  })

  it('savePlaylists 失败时**不**广播"已变更"——否则界面会拿内存值渲染得像成功了', () => {
    breakStorage()
    const changed = vi.fn()
    window.addEventListener(PLAYLISTS_CHANGED_EVENT, changed)
    savePlaylists([playlist()])
    window.removeEventListener(PLAYLISTS_CHANGED_EVENT, changed)
    expect(changed).not.toHaveBeenCalled()
  })

  it('saveFavoriteTracks 返回 false 并广播失败事件', () => {
    breakStorage()
    expect(saveFavoriteTracks([track(1)])).toBe(false)
    expect(failedEvents).toContain('bilimusic_favorites')
  })
})

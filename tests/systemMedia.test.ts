import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_SEEK_STEP,
  SYSTEM_MEDIA_ACTIONS,
  clampSeekTime,
  clearSystemMediaActions,
  handleSystemMediaAction,
  registerSystemMediaActions,
  resolveSeekTarget,
  type SystemMediaAction,
  type SystemMediaPlaybackSnapshot,
  type SystemMediaSeekDetails,
  type SystemMediaSession,
  type SystemMediaTarget,
} from '../src/utils/systemMedia'

function makeTarget() {
  const calls: string[] = []
  const seeks: Array<{ seconds: number; fast: boolean }> = []
  const target: SystemMediaTarget = {
    play: () => { calls.push('play') },
    pause: () => { calls.push('pause') },
    next: () => { calls.push('next') },
    prev: () => { calls.push('prev') },
    seek: (seconds, fast) => { calls.push('seek'); seeks.push({ seconds, fast }) },
  }
  return { target, calls, seeks }
}

const snapshot = (currentTime = 0, duration = 0): SystemMediaPlaybackSnapshot => ({ currentTime, duration })

function run(action: SystemMediaAction, details: SystemMediaSeekDetails = {}, snap = snapshot()) {
  const { target, calls, seeks } = makeTarget()
  handleSystemMediaAction(action, details, target, snap)
  return { calls, seeks }
}

describe('systemMedia：动作分发（v1.4.13-pre14 系统媒体控制）', () => {
  it('八个动作全部纳入注册清单', () => {
    expect([...SYSTEM_MEDIA_ACTIONS].sort()).toEqual([
      'nexttrack', 'pause', 'play', 'previoustrack',
      'seekbackward', 'seekforward', 'seekto', 'stop',
    ])
  })

  it('play / pause / stop 落到对应控制函数', () => {
    expect(run('play').calls).toEqual(['play'])
    expect(run('pause').calls).toEqual(['pause'])
    // stop 与既有 globalShortcut 的 stop 语义一致：暂停而非清空队列
    expect(run('stop').calls).toEqual(['pause'])
  })

  it('previoustrack / nexttrack 落到 prev / next', () => {
    expect(run('previoustrack').calls).toEqual(['prev'])
    expect(run('nexttrack').calls).toEqual(['next'])
  })

  it('target 为 null（播放器未挂载）时静默不抛错', () => {
    expect(() => handleSystemMediaAction('play', {}, null, snapshot())).not.toThrow()
    expect(() => handleSystemMediaAction('seekto', { seekTime: 10 }, null, snapshot())).not.toThrow()
  })
})

describe('systemMedia：seekto 两种 detail', () => {
  it('seekTime 走绝对定位', () => {
    const { calls, seeks } = run('seekto', { seekTime: 42 }, snapshot(5, 100))
    expect(calls).toEqual(['seek'])
    expect(seeks[0]).toEqual({ seconds: 42, fast: false })
  })

  it('只有 seekOffset 时按相对当前位置处理', () => {
    const { seeks } = run('seekto', { seekOffset: 15 }, snapshot(30, 100))
    expect(seeks[0].seconds).toBe(45)
  })

  it('seekTime 优先于 seekOffset', () => {
    const { seeks } = run('seekto', { seekTime: 7, seekOffset: 50 }, snapshot(30, 100))
    expect(seeks[0].seconds).toBe(7)
  })

  it('fastSeek 透传到 target.seek 的 fast 参数', () => {
    expect(run('seekto', { seekTime: 20, fastSeek: true }, snapshot(0, 100)).seeks[0].fast).toBe(true)
    expect(run('seekto', { seekTime: 20, fastSeek: false }, snapshot(0, 100)).seeks[0].fast).toBe(false)
  })

  it('没有任何时间信息时不移动播放位置', () => {
    expect(run('seekto', {}, snapshot(30, 100)).calls).toEqual([])
  })
})

describe('systemMedia：seekbackward / seekforward', () => {
  it('使用系统给出的 seekOffset', () => {
    expect(run('seekforward', { seekOffset: 30 }, snapshot(10, 100)).seeks[0].seconds).toBe(40)
    expect(run('seekbackward', { seekOffset: 30 }, snapshot(100, 200)).seeks[0].seconds).toBe(70)
  })

  it('缺省 seekOffset 时走 DEFAULT_SEEK_STEP', () => {
    expect(run('seekforward', {}, snapshot(10, 100)).seeks[0].seconds).toBe(10 + DEFAULT_SEEK_STEP)
    expect(run('seekbackward', {}, snapshot(100, 200)).seeks[0].seconds).toBe(100 - DEFAULT_SEEK_STEP)
  })

  it('非有限或非正的 seekOffset 同样回落到默认步长', () => {
    expect(run('seekforward', { seekOffset: Number.NaN }, snapshot(10, 100)).seeks[0].seconds).toBe(20)
    expect(run('seekforward', { seekOffset: 0 }, snapshot(10, 100)).seeks[0].seconds).toBe(20)
    expect(run('seekforward', { seekOffset: -5 }, snapshot(10, 100)).seeks[0].seconds).toBe(20)
  })

  it('后退不会越过开头', () => {
    expect(run('seekbackward', { seekOffset: 30 }, snapshot(5, 100)).seeks[0].seconds).toBe(0)
  })

  it('前进不会越过结尾', () => {
    expect(run('seekforward', { seekOffset: 30 }, snapshot(90, 100)).seeks[0].seconds).toBe(100)
  })
})

describe('systemMedia：clampSeekTime / resolveSeekTarget', () => {
  it('夹到 [0, duration]', () => {
    expect(clampSeekTime(-5, 100)).toBe(0)
    expect(clampSeekTime(150, 100)).toBe(100)
    expect(clampSeekTime(50, 100)).toBe(50)
  })

  it('duration 不可用（直播/未知时长）时只裁下界', () => {
    expect(clampSeekTime(50, Number.NaN)).toBe(50)
    expect(clampSeekTime(50, 0)).toBe(50)
    expect(clampSeekTime(-1, Number.NaN)).toBe(0)
  })

  it('非有限输入归零', () => {
    expect(clampSeekTime(Number.NaN, 100)).toBe(0)
    expect(clampSeekTime(Number.POSITIVE_INFINITY, 100)).toBe(100)
  })

  it('resolveSeekTarget 在无时间信息时返回 null', () => {
    expect(resolveSeekTarget({}, snapshot())).toBeNull()
  })

  it('resolveSeekTarget 同时接受 seekTime 与 seekOffset', () => {
    expect(resolveSeekTarget({ seekTime: 3 }, snapshot(0, 10))).toEqual({ seconds: 3, fast: false })
    expect(resolveSeekTarget({ seekOffset: 3 }, snapshot(2, 10))).toEqual({ seconds: 5, fast: false })
  })
})

describe('systemMedia：注册与清理', () => {
  function makeSession() {
    const handlers = new Map<SystemMediaAction, ((d: SystemMediaSeekDetails) => void) | null>()
    const session: SystemMediaSession = {
      setActionHandler: (action, handler) => { handlers.set(action, handler) },
    }
    return { session, handlers }
  }

  it('注册全部八个动作并返回成功列表', () => {
    const { session, handlers } = makeSession()
    const registered = registerSystemMediaActions(session, () => null, () => snapshot())
    expect(registered).toHaveLength(8)
    expect([...handlers.keys()].sort()).toEqual([...SYSTEM_MEDIA_ACTIONS].sort())
  })

  it('单个动作不受支持时不影响其余动作', () => {
    const { session, handlers } = makeSession()
    const registered = registerSystemMediaActions(
      {
        setActionHandler: (action, handler) => {
          if (action === 'seekto') throw new Error('unsupported')
          session.setActionHandler(action, handler)
        },
      },
      () => null,
      () => snapshot(),
    )
    expect(registered).not.toContain('seekto')
    expect(registered).toHaveLength(7)
    expect(handlers.has('seekto')).toBe(false)
  })

  it('回调每次触发都重新读取 target 与 snapshot（不缓存闭包）', () => {
    const { session, handlers } = makeSession()
    const first = makeTarget()
    const second = makeTarget()
    let active = first.target
    let current = snapshot(0, 100)

    registerSystemMediaActions(session, () => active, () => current)
    const seekTo = handlers.get('seekto')!

    seekTo({ seekTime: 10 })
    active = second.target
    current = snapshot(60, 200)
    seekTo({ seekTime: 10 })

    expect(first.seeks).toEqual([{ seconds: 10, fast: false }])
    expect(second.seeks).toEqual([{ seconds: 10, fast: false }])
  })

  it('清理把每个动作置 null，并只清本次真正注册过的动作', () => {
    const { session, handlers } = makeSession()
    registerSystemMediaActions(session, () => null, () => snapshot())
    clearSystemMediaActions(session)
    for (const action of SYSTEM_MEDIA_ACTIONS) {
      expect(handlers.get(action)).toBeNull()
    }
  })

  it('清理时个别动作抛错不影响其余动作', () => {
    const cleared: SystemMediaAction[] = []
    const session: SystemMediaSession = {
      setActionHandler: (action, handler) => {
        if (handler === null) {
          if (action === 'play') throw new Error('boom')
          cleared.push(action)
        }
      },
    }
    expect(() => clearSystemMediaActions(session)).not.toThrow()
    expect(cleared).toHaveLength(7)
    expect(cleared).not.toContain('play')
  })

  it('清理只针对传入的动作子集', () => {
    const { session, handlers } = makeSession()
    registerSystemMediaActions(session, () => null, () => snapshot())
    clearSystemMediaActions(session, ['play', 'pause'])
    expect(handlers.get('play')).toBeNull()
    expect(handlers.get('pause')).toBeNull()
    expect(handlers.get('nexttrack')).not.toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { applySleepAction, formatSleepRemaining, SLEEP_IDLE, SLEEP_PRESET_MINUTES, type SleepTimerState } from '../src/utils/sleepTimer'

const NOW = 1_000_000_000_000

function countdownState(minutes: number, from = NOW): SleepTimerState {
  return applySleepAction(SLEEP_IDLE, { type: 'start-countdown', minutes, now: from }).next
}

describe('SLEEP_PRESET_MINUTES', () => {
  it('档位为 15/30/45/60/90（2026-10-15 定案）', () => {
    expect([...SLEEP_PRESET_MINUTES]).toEqual([15, 30, 45, 60, 90])
  })
})

describe('applySleepAction · start-countdown', () => {
  it('按分钟写入绝对到点时刻，不触发停止', () => {
    const t = applySleepAction(SLEEP_IDLE, { type: 'start-countdown', minutes: 30, now: NOW })
    expect(t.next).toEqual({ sleepEndsAt: NOW + 30 * 60_000, sleepAfterCurrent: false })
    expect(t.shouldStop).toBe(false)
  })

  it('非法分钟数（<=0 / 非有限）不改变状态', () => {
    for (const m of [0, -5, NaN]) {
      const t = applySleepAction(SLEEP_IDLE, { type: 'start-countdown', minutes: m, now: NOW })
      expect(t.next).toEqual(SLEEP_IDLE)
      expect(t.shouldStop).toBe(false)
    }
  })

  it('新倒计时覆盖已设的「播完当前曲」', () => {
    const st: SleepTimerState = { sleepEndsAt: null, sleepAfterCurrent: true }
    const t = applySleepAction(st, { type: 'start-countdown', minutes: 15, now: NOW })
    expect(t.next).toEqual({ sleepEndsAt: NOW + 15 * 60_000, sleepAfterCurrent: false })
  })

  it('重复设倒计时以最后一次为准', () => {
    const first = countdownState(15)
    const t = applySleepAction(first, { type: 'start-countdown', minutes: 90, now: NOW + 60_000 })
    expect(t.next.sleepEndsAt).toBe(NOW + 60_000 + 90 * 60_000)
  })
})

describe('applySleepAction · start-after-current / cancel', () => {
  it('播完当前曲只置布尔，不动已有倒计时', () => {
    const st = countdownState(45)
    const t = applySleepAction(st, { type: 'start-after-current' })
    expect(t.next).toEqual({ sleepEndsAt: st.sleepEndsAt, sleepAfterCurrent: true })
    expect(t.shouldStop).toBe(false)
  })

  it('cancel 整态归零', () => {
    const st: SleepTimerState = { sleepEndsAt: NOW + 60_000, sleepAfterCurrent: true }
    expect(applySleepAction(st, { type: 'cancel' }).next).toEqual(SLEEP_IDLE)
  })
})

describe('applySleepAction · track-end', () => {
  it('播完当前曲激活时停止并整态清空（含并存的倒计时）', () => {
    const st: SleepTimerState = { sleepEndsAt: NOW + 60_000, sleepAfterCurrent: true }
    const t = applySleepAction(st, { type: 'track-end', now: NOW })
    expect(t.shouldStop).toBe(true)
    expect(t.next).toEqual(SLEEP_IDLE)
  })

  it('未激活时不停止、状态原样', () => {
    const st = countdownState(30)
    const t = applySleepAction(st, { type: 'track-end', now: NOW })
    expect(t.shouldStop).toBe(false)
    expect(t.next).toEqual(st)
  })
})

describe('applySleepAction · tick', () => {
  it('未到点不停止', () => {
    const st = countdownState(30)
    const t = applySleepAction(st, { type: 'tick', now: NOW + 60_000 })
    expect(t.shouldStop).toBe(false)
    expect(t.next).toEqual(st)
  })

  it('正好到点停止并整态清空', () => {
    const st = countdownState(30)
    const t = applySleepAction(st, { type: 'tick', now: NOW + 30 * 60_000 })
    expect(t.shouldStop).toBe(true)
    expect(t.next).toEqual(SLEEP_IDLE)
  })

  it('已过点停止并整态清空', () => {
    const st = countdownState(30)
    const t = applySleepAction(st, { type: 'tick', now: NOW + 31 * 60_000 })
    expect(t.shouldStop).toBe(true)
    expect(t.next).toEqual(SLEEP_IDLE)
  })

  it('无倒计时时 tick 不动作（仅「播完当前曲」态不因 tick 停止）', () => {
    const t = applySleepAction(SLEEP_IDLE, { type: 'tick', now: NOW })
    expect(t.shouldStop).toBe(false)
    expect(t.next).toEqual(SLEEP_IDLE)

    const afterCurrent = applySleepAction(SLEEP_IDLE, { type: 'start-after-current' }).next
    const t2 = applySleepAction(afterCurrent, { type: 'tick', now: NOW + 9_999_999 })
    expect(t2.shouldStop).toBe(false)
    expect(t2.next).toEqual(afterCurrent)
  })
})

describe('formatSleepRemaining', () => {
  it('格式化为 m:ss 并向上取整', () => {
    expect(formatSleepRemaining(NOW + 65_000, NOW)).toBe('1:05')
    expect(formatSleepRemaining(NOW + 65_400, NOW)).toBe('1:06')
    expect(formatSleepRemaining(NOW + 30_000, NOW)).toBe('0:30')
    expect(formatSleepRemaining(NOW + 90 * 60_000, NOW)).toBe('90:00')
  })

  it('无倒计时与已到点均返回 0:00', () => {
    expect(formatSleepRemaining(null, NOW)).toBe('0:00')
    expect(formatSleepRemaining(NOW, NOW)).toBe('0:00')
    expect(formatSleepRemaining(NOW - 1, NOW)).toBe('0:00')
  })
})

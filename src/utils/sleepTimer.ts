/**
 * v1.4.8-pre1 睡眠定时纯状态机。
 * 从 PlayerContext 的散落迁移逻辑抽出，供单测直接覆盖（tests/sleepTimer.test.ts）。
 *
 * 状态：倒计时到点时刻（绝对时间戳，跨切歌不重置）+ 播完当前曲停布尔。
 * 两条停止路径（播完当前曲 / 倒计时到点）触发任一即整态清空，
 * 避免「播完当前曲」触发后倒计时残留、到点再弹一次停止提示。
 */

export interface SleepTimerState {
  /** 倒计时到点时刻（毫秒时间戳）；null = 未设倒计时 */
  sleepEndsAt: number | null
  /** 是否播完当前曲后停止 */
  sleepAfterCurrent: boolean
}

/** 空闲态：两条停止路径均未激活 */
export const SLEEP_IDLE: SleepTimerState = { sleepEndsAt: null, sleepAfterCurrent: false }

/** 预设档位（分钟），2026-10-15 定案 */
export const SLEEP_PRESET_MINUTES = [15, 30, 45, 60, 90] as const

export type SleepAction =
  | { type: 'start-countdown'; minutes: number; now: number }
  | { type: 'start-after-current' }
  | { type: 'cancel' }
  | { type: 'track-end'; now: number }
  | { type: 'tick'; now: number }

export interface SleepTransition {
  /** 迁移后的状态 */
  next: SleepTimerState
  /** true = 该动作触发停止播放（到点 / 播完当前曲），调用方暂停音频并提示 */
  shouldStop: boolean
}

/**
 * 睡眠定时状态迁移。纯函数：不碰 audio、不弹 toast，只算下一状态与是否停止。
 * - start-countdown：新倒计时覆盖旧态（含已设的播完当前曲）；分钟数非法（<=0 / 非有限）时状态原样返回
 * - start-after-current：只置布尔，不动已有倒计时
 * - cancel：整态归零
 * - track-end：播完当前曲激活时触发停止并整态清空（优先于一切续播逻辑）
 * - tick：倒计时到点（now >= sleepEndsAt）触发停止并整态清空
 */
export function applySleepAction(state: SleepTimerState, action: SleepAction): SleepTransition {
  switch (action.type) {
    case 'start-countdown': {
      const m = Math.floor(action.minutes)
      if (!Number.isFinite(m) || m <= 0) return { next: state, shouldStop: false }
      return {
        next: { sleepEndsAt: action.now + m * 60_000, sleepAfterCurrent: false },
        shouldStop: false,
      }
    }
    case 'start-after-current':
      return { next: { ...state, sleepAfterCurrent: true }, shouldStop: false }
    case 'cancel':
      return { next: { ...SLEEP_IDLE }, shouldStop: false }
    case 'track-end':
      if (!state.sleepAfterCurrent) return { next: state, shouldStop: false }
      return { next: { ...SLEEP_IDLE }, shouldStop: true }
    case 'tick':
      if (state.sleepEndsAt === null || action.now < state.sleepEndsAt) return { next: state, shouldStop: false }
      return { next: { ...SLEEP_IDLE }, shouldStop: true }
  }
}

/** 倒计时剩余文案（m:ss，向上取整）；无倒计时或已到点返回 '0:00'。纯函数。 */
export function formatSleepRemaining(sleepEndsAt: number | null, now: number): string {
  if (sleepEndsAt === null) return '0:00'
  const sec = Math.max(0, Math.ceil((sleepEndsAt - now) / 1000))
  return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`
}

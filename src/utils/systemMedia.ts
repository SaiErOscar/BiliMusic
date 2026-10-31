/**
 * v1.4.13-pre14 系统媒体控制（MediaSession → Windows SMTC / macOS Now Playing）
 *
 * 背景：v1.4.9-pre3 为了让 globalShortcut 能收到硬件媒体键，在 main.ts 关掉了
 * Chromium 的 HardwareMediaKeyHandling。这个 feature 同时也是 Chromium 把渲染层
 * navigator.mediaSession 桥接到系统媒体面板（Windows SMTC）的开关——关掉之后
 * 系统音量浮层里再也不会出现 BiliMusic。
 *
 * 本模块只做「系统媒体面板下发的动作 → 播放控制」的纯映射与注册，不碰 DOM 状态，
 * 因此可以直接单测。PlayerContext 负责把最新状态塞进 ref 后调用这里。
 */

/** 系统媒体面板可以下发的动作 */
export type SystemMediaAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'previoustrack'
  | 'nexttrack'
  | 'seekbackward'
  | 'seekforward'
  | 'seekto'

/**
 * 与 MediaSessionActionDetails 同形（字段全可选），便于纯函数直接吃原生 details。
 * - seekto：绝对定位，优先取 seekTime；只有 seekOffset 时按相对位移处理
 * - seekbackward / seekforward：取 seekOffset，缺省走 DEFAULT_SEEK_STEP
 * - fastSeek：true 表示「快速近似定位」（拖拽进度条场景），可走 HTMLMediaElement.fastSeek
 */
export interface SystemMediaSeekDetails {
  fastSeek?: boolean
  seekOffset?: number
  seekTime?: number
}

/** 动作发生瞬间的播放位置快照（由调用方用 ref 提供，保证不是闭包里的旧值） */
export interface SystemMediaPlaybackSnapshot {
  currentTime: number
  duration: number
}

/** 动作落到播放器上的实际效果 */
export interface SystemMediaTarget {
  play: () => void
  pause: () => void
  next: () => void
  prev: () => void
  /** seconds 已由本模块夹到 [0, duration]；fast=true 表示允许近似定位 */
  seek: (seconds: number, fast: boolean) => void
}

/** navigator.mediaSession 中本模块用到的最小面 */
export interface SystemMediaSession {
  setActionHandler(
    action: SystemMediaAction,
    handler: ((details: SystemMediaSeekDetails) => void) | null,
  ): void
}

/** 必须全部注册的动作集合（顺序即注册顺序） */
export const SYSTEM_MEDIA_ACTIONS: readonly SystemMediaAction[] = [
  'play',
  'pause',
  'stop',
  'previoustrack',
  'nexttrack',
  'seekbackward',
  'seekforward',
  'seekto',
]

/** seekbackward / seekforward 未带 seekOffset 时的默认步长（秒） */
export const DEFAULT_SEEK_STEP = 10

/**
 * 把秒数夹到 [0, duration]。
 * duration 不可用（NaN / 0 / 负数，例如直播流）时只做下界裁剪，避免把进度条锁死在 0。
 */
export function clampSeekTime(value: number, duration: number): number {
  // NaN 没有可用的位置语义，归零（相当于不动）；±Infinity 交给下面的夹取，
  // 会自然落到开头/结尾，比一律归零更符合「拖到最右」的直觉。
  if (Number.isNaN(value)) return 0
  const upper = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY
  return Math.min(Math.max(value, 0), upper)
}

/**
 * 解析一次定位请求。
 * @returns null 表示 details 里没有任何可用的时间信息（此时不应移动播放位置）
 */
export function resolveSeekTarget(
  details: SystemMediaSeekDetails,
  snapshot: SystemMediaPlaybackSnapshot,
): { seconds: number; fast: boolean } | null {
  const absolute =
    typeof details.seekTime === 'number' && Number.isFinite(details.seekTime) ? details.seekTime : null
  const relative =
    typeof details.seekOffset === 'number' && Number.isFinite(details.seekOffset)
      ? snapshot.currentTime + details.seekOffset
      : null
  const raw = absolute ?? relative
  if (raw === null) return null
  return { seconds: clampSeekTime(raw, snapshot.duration), fast: details.fastSeek === true }
}

/**
 * 执行一个系统媒体动作。
 * target 为空（播放器尚未挂载/已卸载）时静默返回，绝不抛错——
 * 系统面板的回调抛错会污染 Chromium 的媒体会话状态。
 */
export function handleSystemMediaAction(
  action: SystemMediaAction,
  details: SystemMediaSeekDetails,
  target: SystemMediaTarget | null,
  snapshot: SystemMediaPlaybackSnapshot,
): void {
  if (!target) return
  switch (action) {
    case 'play':
      target.play()
      return
    case 'pause':
    case 'stop':
      // stop 与既有 globalShortcut 的 'stop' 语义一致：停在这里而不是清空队列
      target.pause()
      return
    case 'previoustrack':
      target.prev()
      return
    case 'nexttrack':
      target.next()
      return
    case 'seekbackward':
    case 'seekforward': {
      const rawOffset = details.seekOffset
      const offset =
        typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset > 0
          ? rawOffset
          : DEFAULT_SEEK_STEP
      const resolved = resolveSeekTarget(
        { seekOffset: action === 'seekforward' ? offset : -offset, fastSeek: details.fastSeek },
        snapshot,
      )
      if (resolved) target.seek(resolved.seconds, resolved.fast)
      return
    }
    case 'seekto': {
      const resolved = resolveSeekTarget(details, snapshot)
      if (resolved) target.seek(resolved.seconds, resolved.fast)
      return
    }
  }
}

/**
 * 注册全部动作，返回本次真正注册成功的动作列表（用于精确解绑）。
 * 单个动作不被支持时 setActionHandler 会抛错，这里逐个吞掉，
 * 避免一个不支持的动作拖垮其余七个。
 */
export function registerSystemMediaActions(
  session: SystemMediaSession,
  getTarget: () => SystemMediaTarget | null,
  getSnapshot: () => SystemMediaPlaybackSnapshot,
): SystemMediaAction[] {
  const registered: SystemMediaAction[] = []
  for (const action of SYSTEM_MEDIA_ACTIONS) {
    try {
      session.setActionHandler(action, (details) => {
        handleSystemMediaAction(action, details ?? {}, getTarget(), getSnapshot())
      })
      registered.push(action)
    } catch {
      // 当前 Chromium 版本/平台不支持该动作，跳过
    }
  }
  return registered
}

/** 逐个解绑；某个动作本就没注册成功时解绑也会抛错，同样逐个吞掉 */
export function clearSystemMediaActions(
  session: SystemMediaSession,
  actions: readonly SystemMediaAction[] = SYSTEM_MEDIA_ACTIONS,
): void {
  for (const action of actions) {
    try {
      session.setActionHandler(action, null)
    } catch {
      // ignore
    }
  }
}

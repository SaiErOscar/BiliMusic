/**
 * v1.4.8-pre1 倍速纯函数。
 * 从 PlayerContext 抽出为独立模块，供单测直接覆盖（tests/playbackRate.test.ts）；
 * PlayerContext 原样再导出，保持既有引用面（PlayerBar 等）不变。
 */

/** 倍速档位（0.5~2.0x，点击循环） */
export const PLAYBACK_RATE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

/** 把任意输入归一到合法倍速档位；非法/缺失回退 1。纯函数，便于单测。 */
export function normalizePlaybackRate(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
  const hit = PLAYBACK_RATE_STEPS.find((s) => s === raw)
  return hit ?? 1
}

/** 给定当前倍速，返回循环切换后的下一档。纯函数。 */
export function nextPlaybackRate(current: number): number {
  const idx = PLAYBACK_RATE_STEPS.indexOf(normalizePlaybackRate(current) as (typeof PLAYBACK_RATE_STEPS)[number])
  return PLAYBACK_RATE_STEPS[(idx + 1) % PLAYBACK_RATE_STEPS.length]
}

/**
 * v1.4.10-pre2 MV 导出进度区间分配。
 *
 * 为什么需要它：导出链路的百分比原先由各阶段各自上报——下载音频按 0~100 报，分析音频
 * 与渲染播放页又各自从 0 起算到 99。结果是同一次导出里进度条来回跳：
 *
 *   下载音频 100% → 分析音频 0% → 99% → 渲染播放页 0% → 99% → 合成视频 99% → 100%
 *
 * v1.4.8-pre4 的「进度连贯化」只处理了渲染→合成这一段（合成不再逐帧上报百分比），
 * v1.4.10-pre1 新增分析阶段后，回跳又多出两处。这里把整条链路切成互不重叠的区间，
 * 每个阶段只在自己的区间内推进，任何阶段切换处进度条都只前进不后退。
 *
 * 区间划分按各阶段的实际耗时占比给：音频下载是秒级、频谱分析是秒级、逐帧渲染占大头。
 *
 *   下载音频   0 ~  9
 *   分析音频  10 ~ 24
 *   渲染播放页 25 ~ 98
 *   合成视频  99（固定，等出片）
 *   完成      100
 *
 * 纯函数、零 electron 依赖，可直接被 vitest 覆盖（同 electron/encoders.ts 的做法）。
 */

/** 需要按比例推进的阶段（合成/完成是固定值，不在此表内）。 */
export type ProgressStage = 'audio' | 'analyze' | 'render'

/** 各阶段的百分比区间 [起点, 终点)。终点本身留给下一阶段的起点。 */
const STAGE_WINDOWS: Record<ProgressStage, readonly [number, number]> = {
  audio: [0, 10],
  analyze: [10, 25],
  render: [25, 99],
}

/** 合成阶段固定百分比：帧已全部写完，等 ffmpeg 收尾。 */
export const COMPOSE_PERCENT = 99
/** 完成百分比。 */
export const DONE_PERCENT = 100

/**
 * 把某阶段内的完成比例（0~1）映射成整条链路上的百分比。
 *
 * 阶段内最高只到「终点 - 1」：终点留给下一阶段的起点，因此相邻阶段衔接处的值
 * 严格递增（9 → 10 → 24 → 25 → 98 → 99 → 100），不会出现同值停顿或回退。
 */
export function stagePercent(stage: ProgressStage, ratio: number): number {
  const [start, end] = STAGE_WINDOWS[stage]
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  return Math.min(end - 1, start + Math.round(clamped * (end - start)))
}

/** 整条链路的完整百分比序列（自检与单测用，正式代码不调用）。 */
export function stageWindow(stage: ProgressStage): readonly [number, number] {
  return STAGE_WINDOWS[stage]
}

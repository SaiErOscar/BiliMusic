/**
 * v1.4.11-pre2 封面取景：容器比例跟随逻辑（播放页与 MV 导出舞台共用）。
 *
 * 背景：`contain` 模式下 1:1 容器会留白，频谱柱贴容器底边就会浮在图片下方的空白里，
 * 与「柱子从封面里长出来」的观感割裂。解法是让容器本身跟随封面真实比例，
 * 柱子自然贴到图片真实下缘。
 *
 * 但容器不能无限跟随：导出舞台是固定的 1280×720，9:16 竖版封面的真实比例会把
 * 左侧栏撑得比画面还高，直接毁掉成片构图；播放页同理会把歌词卡与进度条顶出视口。
 * 因此超过阈值时退回 1:1 容器内居中显示（此时 contain 的留白是可接受的）。
 */

/** 容器跟随封面的比例上限：宽/高不超过 1，即最高允许 1:1.6 的竖版比例 */
export const COVER_ASPECT_LIMIT = 1.6

/** 容器比例跟随只在 contain 模式生效：cover 铺满与 fill 拉伸都不需要跟随 */
export function shouldFollowCoverAspect(mode: string): boolean {
  return mode === 'contain'
}

/**
 * 由封面固有尺寸算出容器 aspect-ratio 数值（宽/高）。
 *
 * - 未就绪（naturalWidth/Height 为 0）返回 1，避免首帧 NaN 撑破布局
 * - 竖版比例超过 COVER_ASPECT_LIMIT 时钳到上限，防止极端比例撑爆容器
 * - 横版不做下限钳制：16:9 之类本就比 1:1 矮，跟随它不会挤压下方布局
 */
export function coverAspectRatio(naturalWidth: number, naturalHeight: number): number {
  if (!naturalWidth || !naturalHeight || naturalWidth <= 0 || naturalHeight <= 0) return 1
  const ratio = naturalWidth / naturalHeight
  // 竖版（ratio < 1）：限制「高/宽」不超过 COVER_ASPECT_LIMIT
  if (ratio < 1) return Math.max(ratio, 1 / COVER_ASPECT_LIMIT)
  return ratio
}

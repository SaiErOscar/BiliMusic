// v1.4.15-pre4 分享抽屉的模块级状态。
//
// 为什么不能把 open 放在 TrackActions 里：
// TrackActions 被 VirtualList 的行渲染使用（AppleMusicPage.tsx:124/175 等），
// 列表按 computeVisibleRange 只渲染可视区 + OVERSCAN 行（VirtualList.tsx:122-125），
// 滚动时行组件会被卸载重建。抽屉状态若挂在行内，用户打开分享后随手一滚，
// 抽屉就会跟着那行一起消失——看起来像「闪一下没了」。
//
// 范式照抄 src/services/batchDownloadStore.ts：模块级 state + subscribe + emit，
// 不引入任何状态库，也不依赖组件生命周期。
import type { Playlist, Track } from '@/types'

/** 当前要分享的对象：歌单或单曲，二选一 */
export type ShareTarget =
  | { kind: 'playlist'; playlist: Playlist }
  | { kind: 'track'; track: Track }

let target: ShareTarget | null = null

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

export function subscribeShare(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** 当前分享对象；null 表示抽屉关闭 */
export function getShareTarget(): ShareTarget | null {
  return target
}

/** 打开抽屉并设置分享对象 */
export function openShare(next: ShareTarget) {
  target = next
  emit()
}

/** 关闭抽屉 */
export function closeShare() {
  if (!target) return
  target = null
  emit()
}

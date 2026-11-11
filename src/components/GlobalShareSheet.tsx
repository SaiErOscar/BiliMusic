/**
 * v1.4.15-pre4 分享抽屉的全局挂载点。
 *
 * 状态在 src/services/shareStore.ts（模块级），这里只负责订阅并渲染。
 * 挂在 App 根部而不是各个列表行里：TrackActions 会被 VirtualList 按可视区
 * 卸载重建（VirtualList.tsx:122-125），抽屉若跟着行走，滚一下就会消失。
 * 范式与 App.tsx 里的 GlobalLoginDialog 一致——全局浮层只在一个地方渲染。
 */
import { useEffect, useState } from 'react'
import ShareQrSheet from '@/components/ShareQrSheet'
import { closeShare, getShareTarget, subscribeShare } from '@/services/shareStore'
import type { ShareTarget } from '@/services/shareStore'

export default function GlobalShareSheet() {
  const [target, setTarget] = useState<ShareTarget | null>(getShareTarget)

  useEffect(() => subscribeShare(() => setTarget(getShareTarget())), [])

  if (!target) return null
  return target.kind === 'playlist'
    ? <ShareQrSheet open onClose={closeShare} playlist={target.playlist} />
    : <ShareQrSheet open onClose={closeShare} track={target.track} />
}

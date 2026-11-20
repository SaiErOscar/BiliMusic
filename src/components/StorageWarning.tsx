/**
 * v1.4.15-pre8 存储写入失败的全局提示（修 R-05）。
 *
 * 背景：safeSetItem 一直正确返回 boolean，但调用方全部忽略它。
 * 配额满时加歌、拖排序、收藏、导入备份都会"看起来成功"却根本没落盘，
 * 重启即回退，用户完全没有线索。
 *
 * 这里订阅 storage.ts 广播的失败事件，用一条可关闭的横幅说明后果。
 * 之所以做成全局而不是散在各页面：写失败可能发生在任何一处，
 * 且用户最需要知道的是「刚才那次操作没保存」，与具体页面无关。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { STORAGE_FAILED_EVENT } from '@/utils/storage'

export default function StorageWarning() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onFailed = () => setVisible(true)
    window.addEventListener(STORAGE_FAILED_EVENT, onFailed)
    return () => window.removeEventListener(STORAGE_FAILED_EVENT, onFailed)
  }, [])

  // 同一类失败重复触发时不叠加，只保留一条
  if (!visible) return null

  return (
    <div className="storage-warning" role="alert">
      <AlertTriangle size={16} />
      <span>存储空间不足，刚才的改动没有保存。请清理本地音乐或歌词缓存后重试。</span>
      <button type="button" onClick={() => setVisible(false)} title="关闭" aria-label="关闭">
        <X size={14} />
      </button>
    </div>
  )
}

import { useEffect } from 'react'
import { getUserInfo } from '@/services/api'
import { getFavoriteFolders } from '@/services/bilibiliApi'
import { importBiliFavorites, syncBiliFavorites } from '@/services/biliFavorites'

const PERIODIC = 10 * 1000 // 每 10 秒
const STARTUP_DELAY = 3000 // 启动后延迟，避开启动高峰

/**
 * B站收藏夹自动同步：登录后启动时执行一次「导入本地 + 双向同步」，随后每 10 秒自动执行。
 * 静默执行，不打扰 UI；未登录或网络失败时自动跳过。
 */
export function useAutoBiliFavoritesSync(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    let running = false

    const runOnce = async () => {
      if (running) return
      running = true
      try {
        const info = await getUserInfo()
        if (!info?.isLogin || !info.mid) return
        const { list } = await getFavoriteFolders(info.mid)
        for (const folder of list) {
          try {
            await importBiliFavorites(folder.id)
            await syncBiliFavorites(folder.id)
          } catch {
            // 单个收藏夹失败不影响其他
          }
        }
      } catch {
        // 未登录或网络异常，跳过本轮
      } finally {
        running = false
      }
    }

    const boot = () => {
      void runOnce()
      if (!timer) timer = setInterval(() => void runOnce(), PERIODIC)
    }
    const bootTimer = setTimeout(boot, STARTUP_DELAY)

    // 收藏夹内容变更（收藏/移除/导入等）时立即触发一次同步，实现「更改即双向同步」
    const onChange = () => void runOnce()
    window.addEventListener('bilimusic:bili-favorites-changed', onChange)

    // 打开收藏夹页面或切换收藏夹时，请求立即同步一次
    const onSyncRequest = () => void runOnce()
    window.addEventListener('bilimusic:bili-favorites-sync-request', onSyncRequest)

    return () => {
      clearTimeout(bootTimer)
      if (timer) clearInterval(timer)
      window.removeEventListener('bilimusic:bili-favorites-changed', onChange)
      window.removeEventListener('bilimusic:bili-favorites-sync-request', onSyncRequest)
    }
  }, [])
}
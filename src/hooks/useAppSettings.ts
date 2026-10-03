import { useEffect, useState } from 'react'
import {
  loadAppSettings,
  SETTINGS_CHANGED_EVENT,
  updateAppSettings,
} from '@/utils/storage'
import type { AppSettings } from '@/types'
import { platform } from '@/platform'

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings())

  // 首次加载时，若下载路径为空，从主进程获取系统默认音乐目录
  useEffect(() => {
    if (settings.downloadDir) return
    const getDefaultDownloadDir = platform.download?.getDefaultDownloadDir
    if (!getDefaultDownloadDir) return
    getDefaultDownloadDir().then((dir: string) => {
      if (dir) {
        updateAppSettings({ downloadDir: dir })
      }
    }).catch(() => { /* 主进程不可用时静默降级 */ })
  }, [])

  useEffect(() => {
    const sync = () => setSettings(loadAppSettings())
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const setAppSettings = (patch: Partial<AppSettings>) => {
    const next = updateAppSettings(patch)
    setSettings(next)
  }

  return { settings, setAppSettings }
}

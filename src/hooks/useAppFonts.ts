import { useEffect } from 'react'
import { useAppSettings } from '@/hooks/useAppSettings'

// 'system-ui' 视为“默认”：不设覆盖，回退到组件原有字体栈（与升级前观感一致）
const DEFAULT = 'system-ui'

/**
 * v1.3.8 将主窗口两处字体设置挂到 :root CSS 变量，供 PlayerBar / LyricsView 引用：
 * - --app-title-font：标题栏+播放条歌曲名/歌手
 * - --app-lyric-font：播放页歌词
 * 默认值为 'system-ui' 时移除变量，组件回退到原字体栈。
 */
export function useAppFonts() {
  const { settings } = useAppSettings()

  useEffect(() => {
    const root = document.documentElement
    if (settings.titleFontFamily && settings.titleFontFamily !== DEFAULT) {
      root.style.setProperty('--app-title-font', settings.titleFontFamily)
    } else {
      root.style.removeProperty('--app-title-font')
    }
    if (settings.playerLyricFontFamily && settings.playerLyricFontFamily !== DEFAULT) {
      root.style.setProperty('--app-lyric-font', settings.playerLyricFontFamily)
    } else {
      root.style.removeProperty('--app-lyric-font')
    }
  }, [settings.titleFontFamily, settings.playerLyricFontFamily])
}

import { Maximize2, Minimize2, Minus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import appIcon from '@/assets/icon.png'
import { platform } from '@/platform'

/**
 * v1.4.13-pre6 标题栏 logo 跟随主题。
 *
 * 这枚图标是自绘的（窗口 frame:false），主进程的 setIcon 改的是任务栏/Alt-Tab
 * 那一枚，管不到这里——所以它必须自己按主题取图。
 * 图标集由 scripts/make-theme-icons.cjs 预生成，构建时从 electron/icons 复制到
 * public/icons，用 URL 直接引用（不必打进 bundle）。
 */
const THEME_ICONS: Record<string, string> = {
  default: '/icons/icon-default',
  forest: '/icons/icon-forest',
  ocean: '/icons/icon-ocean',
  twilight: '/icons/icon-twilight',
  graphite: '/icons/icon-graphite',
}

function titlebarIcon(themeId: string, mode: string): string {
  const base = THEME_ICONS[themeId] || THEME_ICONS.default
  return `${base}-${mode === 'light' ? 'light' : 'dark'}.png`
}

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [iconSrc, setIconSrc] = useState<string>(appIcon)

  // 主题变化时换图：读 <html> 上的 data-app-theme / data-app-mode（由 theme/apply.ts 写入）
  useEffect(() => {
    const read = () => {
      const root = document.documentElement
      const themeId = root.getAttribute('data-app-theme') || 'default'
      const mode = root.getAttribute('data-app-mode') || 'dark'
      // 自定义基色没有预生成图标，THEME_ICONS 里没有就回落到内置默认图
      if (!THEME_ICONS[themeId]) { setIconSrc(appIcon); return }
      setIconSrc(titlebarIcon(themeId, mode))
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-app-theme', 'data-app-mode'],
    })
    return () => observer.disconnect()
  }, [])

  // 窗口控制按钮只在桌面壳（Electron 且非鸿蒙）显示；手机端没有 shell capability，不显示
  const showWindowControls = !!platform.shell && platform.runtime?.platform !== 'openharmony'

  useEffect(() => {
    const shell = platform.shell
    if (!shell) return

    shell.isMaximized?.().then(setMaximized).catch(() => {})
    return shell.onMaximizedChange?.(setMaximized)
  }, [])

  return (
    <div className={`app-titlebar ${showWindowControls ? '' : 'app-titlebar--native'}`}>
      <div className="app-titlebar__brand">
        <img src={iconSrc} alt="" className="app-titlebar__logo" draggable={false} />
        BiliMusic
      </div>

      {showWindowControls && (
        <div className="app-titlebar__controls">
          <WindowButton icon={<Minus size={14} />} action="minimize" label="最小化" />
          <WindowButton icon={maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />} action="maximize" label={maximized ? '还原窗口' : '最大化'} />
          <WindowButton icon={<X size={15} />} action="close" label="关闭" isClose />
        </div>
      )}
    </div>
  )
}

function WindowButton({
  icon,
  action,
  label,
  isClose = false,
}: {
  icon: React.ReactNode
  action: 'minimize' | 'maximize' | 'close'
  label: string
  isClose?: boolean
}) {
  const handleClick = () => {
    const shell = platform.shell
    if (!shell) return
    if (action === 'minimize') shell.minimize()
    else if (action === 'maximize') shell.maximize()
    else if (action === 'close') shell.close()
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`app-window-button ${isClose ? 'app-window-button--close' : ''}`}
      onClick={handleClick}
    >
      {icon}
    </button>
  )
}

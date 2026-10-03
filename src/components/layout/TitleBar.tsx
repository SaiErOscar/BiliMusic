import { Maximize2, Minimize2, Minus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import appIcon from '@/assets/icon.png'
import { platform } from '@/platform'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

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
        <img src={appIcon} alt="" className="app-titlebar__logo" draggable={false} />
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

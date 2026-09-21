import { useState } from 'react'

// v1.3.9-pre3 取色控件：Windows 下色块本身就是按钮，点击直接弹自写的"取色面板窗"（复刻原生
// input[type=color] 的色板/色相/吸管/RGB/HEX UI，面板内点吸管再进全屏准星取色），入口收进色块、
// 与桌面歌词面板一致。非 Windows（mac 需屏幕录制权限 / 鸿蒙受限）回退原生 input[type=color]，功能不缺失。

export default function ColorField({
  value,
  onChange,
  title,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  title?: string
  /** v1.3.10 自动颜色开启时禁用手动取色；v1.3.11 起不再降透明度，色块如实显示实时自动色，仅不可点击 */
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const canPick =
    window.electronAPI?.platform === 'win32' &&
    typeof window.electronAPI?.openColorPicker === 'function'

  if (!canPick) {
    return (
      <input
        type="color"
        className="settings-color"
        value={value}
        title={title || '选择颜色'}
        disabled={disabled}
        style={disabled ? { cursor: 'not-allowed' } : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  const pick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const hex = await window.electronAPI?.openColorPicker?.(value)
      if (hex) onChange(hex)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="settings-color settings-color--swatch"
      style={{ background: value, ...(disabled ? { cursor: 'not-allowed' } : null) }}
      title={disabled ? '已启用自动颜色' : title || '点击打开取色面板'}
      disabled={busy || disabled}
      onClick={pick}
    >
      <span className="settings-color__hex">{value.toUpperCase()}</span>
    </button>
  )
}

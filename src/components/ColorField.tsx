import { useState } from 'react'

// v1.3.9 取色控件：Windows 下用桌面放大镜取色器（desktopCapturer 抓屏）替换原生 input[type=color]，
// 非 Windows（mac 需屏幕录制权限 / 鸿蒙受限）回退原生颜色选择器，保证功能不缺失。
// 复用 .settings-color 视觉；放大镜取色时点击色块弹出全屏取色窗，取消不改当前值。

function isWindows(): boolean {
  return window.electronAPI?.platform === 'win32'
}

function openNativePicker(): Promise<string | null> {
  const api = window.electronAPI?.openColorPicker
  if (!api) return Promise.resolve(null)
  return api().catch(() => null)
}

export default function ColorField({
  value,
  onChange,
  title,
}: {
  value: string
  onChange: (v: string) => void
  title?: string
}) {
  const [busy, setBusy] = useState(false)
  const usePicker = isWindows() && typeof window.electronAPI?.openColorPicker === 'function'

  if (!usePicker) {
    return (
      <input
        type="color"
        className="settings-color"
        value={value}
        title={title || '选择颜色'}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  const pick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const hex = await openNativePicker()
      if (hex) onChange(hex)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="settings-color settings-color--pick"
      style={{ background: value }}
      title={title || '点击从屏幕取色'}
      disabled={busy}
      onClick={pick}
    >
      <span className="settings-color__hex">{value.toUpperCase()}</span>
    </button>
  )
}

import { useState } from 'react'
import { Pipette } from 'lucide-react'

// v1.3.9-pre2 取色控件：保留原生 input[type=color]（可直接输入十六进制、点色块弹系统调色板预览），
// 在其右侧并列一个"屏幕取色"按钮，仅 Windows 显示（点击弹全屏透明十字准星无感取色）。
// 非 Windows（mac 需屏幕录制权限 / 鸿蒙受限）隐藏该按钮，回到纯原生取色，功能不缺失。

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
  const canPick =
    window.electronAPI?.platform === 'win32' &&
    typeof window.electronAPI?.openColorPicker === 'function'

  const pick = async () => {
    if (busy) return
    setBusy(true)
    try {
      const hex = await window.electronAPI?.openColorPicker?.()
      if (hex) onChange(hex)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="settings-color-group">
      <input
        type="color"
        className="settings-color"
        value={value}
        title={title || '选择颜色'}
        onChange={(e) => onChange(e.target.value)}
      />
      {canPick && (
        <button
          type="button"
          className="settings-color-pick"
          title="从屏幕任意位置取色"
          disabled={busy}
          onClick={pick}
        >
          <Pipette size={15} />
        </button>
      )}
    </span>
  )
}

import { useEffect, useState } from 'react'

// 内置保底字体：即使主进程枚举失败（如鸿蒙/权限受限）也能提供常见中文可选
const FALLBACK_FONTS = [
  'system-ui',
  'Microsoft YaHei',
  'SimHei',
  'SimSun',
  'KaiTi',
  'FangSong',
  'PingFang SC',
  'Hiragino Sans GB',
  'Heiti SC',
  'Arial',
  'Segoe UI',
  'Consolas',
]

function normalize(list: string[]): string[] {
  const set = new Set<string>(FALLBACK_FONTS)
  for (const f of list || []) if (f && typeof f === 'string') set.add(f)
  return Array.from(set)
}

/**
 * v1.3.8 字体下拉：从主进程枚举系统字体并附带内置保底，选中即用该字体名预览。
 * 三处（桌面歌词 / 标题栏+播放条 / 播放页歌词）共用；字体列表进程内只取一次。
 */
let cachedFonts: string[] | null = null

export default function FontSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [fonts, setFonts] = useState<string[]>(cachedFonts ?? FALLBACK_FONTS)

  useEffect(() => {
    let cancelled = false
    if (cachedFonts) {
      setFonts(cachedFonts)
      return
    }
    const api = (window as unknown as { electronAPI?: { listSystemFonts?: () => Promise<string[]> } }).electronAPI
    api
      ?.listSystemFonts?.()
      .then((list) => {
        cachedFonts = normalize(list)
        if (!cancelled) setFonts(cachedFonts)
      })
      .catch(() => {
        if (!cancelled) setFonts(FALLBACK_FONTS)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 当前值不在列表里（历史遗留/枚举变化）时，把它并入选项首位，避免 select 显示空
  const options = fonts.includes(value) ? fonts : [value, ...fonts]

  return (
    <select
      className="settings-select settings-select--font"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((f) => (
        <option key={f} value={f} style={{ fontFamily: `${f}, system-ui` }}>
          {f === 'system-ui' ? '默认（跟随系统）' : f}
        </option>
      ))}
    </select>
  )
}

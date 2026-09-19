// v1.3.10 自动颜色纯算法（不依赖 electron，便于单元测试，模式同 fontUtils.ts）
// 颜色空间转换、主色提取、亮度校正、对比色计算都在这里；
// 网络下载封面 / desktopCapturer 抓屏等 IO 在 autoColor.ts。

export interface RGB {
  r: number
  g: number
  b: number
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { r: 255, g: 255, b: 255 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map((x) => clamp255(x).toString(16).padStart(2, '0')).join('')
}

/** WCAG 相对亮度（0~1），用于判断明暗 */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** 从 BGRA 位图按归一化坐标(0~1)取一点 RGB；越界返回 null */
export function sampleBgra(
  data: Uint8Array,
  width: number,
  height: number,
  nx: number,
  ny: number,
): RGB | null {
  const px = Math.min(width - 1, Math.max(0, Math.floor(nx * width)))
  const py = Math.min(height - 1, Math.max(0, Math.floor(ny * height)))
  const idx = (py * width + px) * 4
  if (idx + 2 >= data.length) return null
  // BGRA：[0]=B,[1]=G,[2]=R
  return { r: data[idx + 2], g: data[idx + 1], b: data[idx] }
}

// HSL 互转，用于亮度/饱和度调节（保留色相，校正明度）
export function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  return { h, s, l }
}

export function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): RGB {
  if (s === 0) {
    const v = clamp255(l * 255)
    return { r: v, g: v, b: v }
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: clamp255(hue2rgb(p, q, h + 1 / 3) * 255),
    g: clamp255(hue2rgb(p, q, h) * 255),
    b: clamp255(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

/**
 * 从像素集合取「代表色」。
 *  - vivid=true（封面文字色）：按 (count × 饱和度权重) 取最鲜艳且足够多的主色，忽略过暗/过亮/灰点。
 *  - vivid=false（背景主色）：取出现最多的色簇（含中性色），代表背景基调。
 * 分桶：每通道 >>4（16 级），同桶求均值。
 */
export function dominantColor(pixels: RGB[], vivid: boolean): RGB | null {
  if (!pixels.length) return null
  type Bucket = { n: number; r: number; g: number; b: number }
  const map = new Map<number, Bucket>()
  for (const p of pixels) {
    const key = ((p.r >> 4) << 8) | ((p.g >> 4) << 4) | (p.b >> 4)
    let b = map.get(key)
    if (!b) {
      b = { n: 0, r: 0, g: 0, b: 0 }
      map.set(key, b)
    }
    b.n++
    b.r += p.r
    b.g += p.g
    b.b += p.b
  }
  let best: Bucket | null = null
  let bestScore = -1
  for (const b of map.values()) {
    const avg: RGB = { r: b.r / b.n, g: b.g / b.n, b: b.b / b.n }
    let score: number
    if (vivid) {
      const { s, l } = rgbToHsl(avg)
      // 排除极暗/过亮（多为黑边、高光）与低饱和灰
      if (l < 0.14 || l > 0.92) continue
      score = b.n * (0.25 + s)
    } else {
      score = b.n
    }
    if (score > bestScore) {
      bestScore = score
      best = b
    }
  }
  if (!best) {
    // vivid 全部被过滤时，退化为最普通的频次主色
    return dominantColor(pixels, false)
  }
  return { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n }
}

/**
 * 文字色亮度校正：保留主色色相/饱和，把明度拉进「视频画面上可读」的区间。
 * 桌面歌词通常压在偏暗的视频/桌面上，故默认把偏暗色提亮到 0.66~0.86；
 * theme=light（浅色桌面）时反过来压暗，保证浅底也看得清。
 */
export function correctTextColor(base: RGB, theme: 'light' | 'dark'): RGB {
  const { h, s } = rgbToHsl(base)
  // 饱和度偏低（发灰）时适度增艳，避免提亮后变成一片惨白/惨灰
  const sat = Math.min(1, Math.max(s, 0.35))
  if (theme === 'light') {
    // 浅色背景：文字取较深明度
    return hslToRgb({ h, s: sat, l: 0.28 })
  }
  // 深色背景：确保足够亮，落在可读区间
  const cur = rgbToHsl(base)
  const l = Math.max(0.66, Math.min(0.86, cur.l < 0.5 ? 0.74 : cur.l))
  return hslToRgb({ h, s: sat, l })
}

/**
 * 控件对比色：给定背景主色，返回与背景高对比且鲜艳的颜色。
 * 用补色（色相 +180°）保证「反差」，再按背景明暗推明度：暗背景→亮控件，亮背景→暗控件。
 */
export function contrastColor(bg: RGB): RGB {
  const { h, s: bgS } = rgbToHsl(bg)
  const lum = relativeLuminance(bg)
  const compHue = (h + 0.5) % 1
  // 背景偏灰（低饱和）时，补色也灰，改给一个稳定鲜艳色，避免灰对灰
  const sat = bgS < 0.12 ? 0.72 : 0.82
  // 亮背景要把控件色压得更暗才看得清（L=0.34 对白底仅约 2.5:1 对比），暗背景则提亮
  const light = lum < 0.5 ? 0.66 : 0.26
  return hslToRgb({ h: compHue, s: sat, l: light })
}

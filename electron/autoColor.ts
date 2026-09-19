// v1.3.10 两种自动颜色（Windows 优先，其余平台安全降级）
//
// 目标：
//  1) 文字自动色：从当前歌曲封面提取主色，做亮度校正后作为桌面歌词文字色（保证视频画面上可读）。
//  2) 控件自动色：每 5 秒采样歌词窗「周围」屏幕像素，取背景主色，计算其高对比色作为按钮/控件色。
//
// 取色不落在歌词窗内联 HTML（data: 窗 + 跨域封面污染 canvas 的坑），统一在主进程完成：
//  封面经 net.fetch（带 Referer/UA，绕 B 站 CDN 防盗链）下载 → nativeImage 缩放采样像素 → 量化取主色；
//  背景经 desktopCapturer 抓屏位图 → 按窗口矩形取外圈环 → 量化取背景主色 → 高对比色。
// 算出的色经现有 update-lyric-appearance 通道回流主窗口持久化到 AppSettings，再随 mini:state 下发，单一数据源不变。
//
// 纯算法（颜色空间/主色/校正/对比色）在 autoColorUtils.ts，便于单测；本文件只负责 IO。
import { nativeImage, desktopCapturer, screen, net } from 'electron'
import {
  type RGB,
  sampleBgra,
  dominantColor,
  correctTextColor,
  contrastColor,
  rgbToHex,
} from './autoColorUtils'

const BILI_REFERER = 'https://www.bilibili.com'
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ===== 异步：封面主色 → 文字色 =====

let coverInflight = ''
const coverCache = new Map<string, string>()

/**
 * 下载封面并提取「文字色」（已亮度校正）。失败返回 null，调用方保持当前色。
 * 同一 coverUrl 并发只跑一次；结果按 url|theme 缓存，避免来回切换曲目重复下载。
 */
export async function extractCoverTextColor(
  coverUrl: string,
  theme: 'light' | 'dark',
): Promise<string | null> {
  if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) return null
  const cacheKey = coverUrl + '|' + theme
  const hit = coverCache.get(cacheKey)
  if (hit) return hit
  if (coverInflight === coverUrl) return null // 正在下载，跳过（下次状态变化会重试）
  coverInflight = coverUrl
  try {
    const resp = await net.fetch(coverUrl, {
      headers: { Referer: BILI_REFERER, 'User-Agent': BILI_UA },
    })
    if (!resp.ok) return null
    const buf = new Uint8Array(await resp.arrayBuffer())
    const img = nativeImage.createFromBuffer(Buffer.from(buf))
    if (img.isEmpty()) return null
    // 缩到 64×64 采样，兼顾速度与主色稳定性
    const small = img.resize({ width: 64, height: 64, quality: 'good' })
    const { width, height } = small.getSize()
    const data = new Uint8Array(small.toBitmap())
    const pixels: RGB[] = []
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4
        if (idx + 2 >= data.length) continue
        if (data[idx + 3] < 24) continue // 透明像素（PNG 封面）忽略
        pixels.push({ r: data[idx + 2], g: data[idx + 1], b: data[idx] }) // BGRA
      }
    }
    const dom = dominantColor(pixels, true)
    if (!dom) return null
    const hex = rgbToHex(correctTextColor(dom, theme))
    if (coverCache.size > 60) coverCache.clear()
    coverCache.set(cacheKey, hex)
    return hex
  } catch {
    return null
  } finally {
    if (coverInflight === coverUrl) coverInflight = ''
  }
}

// ===== 异步：歌词窗周围背景采样 → 控件对比色 =====

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 抓歌词窗所在屏，取窗口外一圈「环」像素算背景主色，返回高对比控件色 hex。
 * 用纯比例法把 DIP 矩形映射到位图像素（绕开 scaleFactor/DIP 换算假设，同 v1.3.9-pre4 取色经验）。
 * ring 为环宽（DIP）。抓屏时歌词窗透明、仅文字与按钮有像素，环在窗口矩形之外故基本取到真实背景。
 */
export async function sampleControlColor(winRect: Rect, ring: number): Promise<string | null> {
  const display = screen.getDisplayMatching(winRect) || screen.getPrimaryDisplay()
  const b = display.bounds
  const scale = display.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) },
  })
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) return null
  const img = source.thumbnail
  const { width: bw, height: bh } = img.getSize()
  const data = new Uint8Array(img.toBitmap())

  // 步进采样环带：每 10 DIP 一点，只取窗口矩形之外的环，避开歌词文字/按钮像素
  const step = 10
  const x0 = winRect.x - ring
  const y0 = winRect.y - ring
  const x1 = winRect.x + winRect.width + ring
  const y1 = winRect.y + winRect.height + ring
  const pixels: RGB[] = []
  for (let dy = y0; dy <= y1; dy += step) {
    for (let dx = x0; dx <= x1; dx += step) {
      const insideWin =
        dx >= winRect.x && dx <= winRect.x + winRect.width &&
        dy >= winRect.y && dy <= winRect.y + winRect.height
      if (insideWin) continue
      // 跨屏部分丢弃：只采样当前 display.bounds 内
      if (dx < b.x || dx > b.x + b.width || dy < b.y || dy > b.y + b.height) continue
      // DIP → 归一化（相对 display.bounds），再 → 位图像素
      const nx = (dx - b.x) / b.width
      const ny = (dy - b.y) / b.height
      if (nx < 0 || nx >= 1 || ny < 0 || ny >= 1) continue
      const px = sampleBgra(data, bw, bh, nx, ny)
      if (px) pixels.push(px)
    }
  }
  const bg = dominantColor(pixels, false)
  if (!bg) return null
  return rgbToHex(contrastColor(bg))
}

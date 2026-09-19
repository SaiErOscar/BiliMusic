import { describe, it, expect } from 'vitest'
import {
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  relativeLuminance,
  sampleBgra,
  dominantColor,
  correctTextColor,
  contrastColor,
  type RGB,
} from '../electron/autoColorUtils'

describe('hex/rgb 转换', () => {
  it('hexToRgb 解析 #rrggbb（含无 # 与前缀空白）', () => {
    expect(hexToRgb('#ff375f')).toEqual({ r: 255, g: 55, b: 95 })
    expect(hexToRgb(' 00FF00 ')).toEqual({ r: 0, g: 255, b: 0 })
  })
  it('非法 hex 回退白色', () => {
    expect(hexToRgb('xyz')).toEqual({ r: 255, g: 255, b: 255 })
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 }) // 3 位不匹配 6 位正则
  })
  it('rgbToHex 四舍五入并补零', () => {
    expect(rgbToHex({ r: 255, g: 55, b: 95 })).toBe('#ff375f')
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
    expect(rgbToHex({ r: 10.6, g: 0, b: 0 })).toBe('#0b0000')
  })
  it('往返稳定', () => {
    for (const h of ['#ff375f', '#ffffff', '#000000', '#123456', '#abcdef']) {
      expect(rgbToHex(hexToRgb(h))).toBe(h)
    }
  })
})

describe('hsl 互转', () => {
  it('纯红/绿/蓝往返', () => {
    const primaries: RGB[] = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]
    for (const p of primaries) {
      const back = hslToRgb(rgbToHsl(p))
      expect(back.r).toBeCloseTo(p.r, 0)
      expect(back.g).toBeCloseTo(p.g, 0)
      expect(back.b).toBeCloseTo(p.b, 0)
    }
  })
  it('灰阶 h=0 s=0', () => {
    const { s } = rgbToHsl({ r: 128, g: 128, b: 128 })
    expect(s).toBe(0)
  })
})

describe('relativeLuminance', () => {
  it('白>中灰>黑', () => {
    const white = relativeLuminance({ r: 255, g: 255, b: 255 })
    const gray = relativeLuminance({ r: 128, g: 128, b: 128 })
    const black = relativeLuminance({ r: 0, g: 0, b: 0 })
    expect(white).toBeCloseTo(1, 2)
    expect(black).toBe(0)
    expect(white).toBeGreaterThan(gray)
    expect(gray).toBeGreaterThan(black)
  })
})

describe('sampleBgra (BGRA 通道顺序，v1.3.9-pre4 关键约定)', () => {
  // 构造 2x1 位图：像素0 = R=10,G=20,B=30；像素1 = R=200,G=100,B=50
  const data = new Uint8Array([30, 20, 10, 255, 50, 100, 200, 255])
  it('按 [0]=B,[1]=G,[2]=R 读取', () => {
    expect(sampleBgra(data, 2, 1, 0, 0)).toEqual({ r: 10, g: 20, b: 30 })
    expect(sampleBgra(data, 2, 1, 0.75, 0)).toEqual({ r: 200, g: 100, b: 50 })
  })
  it('越界坐标夹取到边界内', () => {
    expect(sampleBgra(data, 2, 1, 5, 5)).toEqual({ r: 200, g: 100, b: 50 })
  })
})

describe('dominantColor', () => {
  const fill = (c: RGB, n: number): RGB[] => Array.from({ length: n }, () => ({ ...c }))
  it('vivid=false 取出现最多的色簇（背景主色）', () => {
    const px = [...fill({ r: 20, g: 20, b: 20 }, 100), ...fill({ r: 250, g: 10, b: 10 }, 5)]
    const bg = dominantColor(px, false)
    expect(bg).not.toBeNull()
    // 数量占优的暗灰应胜出
    expect(bg!.r).toBeLessThan(60)
  })
  it('vivid=true 偏向鲜艳色（忽略占多数的暗背景）', () => {
    const px = [...fill({ r: 15, g: 15, b: 15 }, 100), ...fill({ r: 240, g: 40, b: 90 }, 30)]
    const dom = dominantColor(px, true)
    expect(dom).not.toBeNull()
    // 应取到偏红的鲜艳簇，而非黑灰
    expect(dom!.r).toBeGreaterThan(150)
  })
  it('空集合返回 null', () => {
    expect(dominantColor([], true)).toBeNull()
  })
})

describe('correctTextColor（亮度可读性校正）', () => {
  it('深色主题下偏暗主色被提亮', () => {
    const out = correctTextColor({ r: 60, g: 10, b: 30 }, 'dark')
    const lum = relativeLuminance(out)
    expect(lum).toBeGreaterThan(0.25) // 明显比原暗色更亮
    const { l } = rgbToHsl(out)
    expect(l).toBeGreaterThanOrEqual(0.65)
  })
  it('浅色主题下文字压暗', () => {
    const out = correctTextColor({ r: 240, g: 200, b: 60 }, 'light')
    const { l } = rgbToHsl(out)
    expect(l).toBeCloseTo(0.28, 2)
  })
  it('保留色相（红仍偏红）', () => {
    const out = correctTextColor({ r: 200, g: 20, b: 60 }, 'dark')
    expect(out.r).toBeGreaterThan(out.g)
  })
})

describe('contrastColor（控件高对比色）', () => {
  it('暗背景返回亮控件色', () => {
    const out = contrastColor({ r: 20, g: 20, b: 30 })
    expect(relativeLuminance(out)).toBeGreaterThan(0.4)
  })
  it('亮背景返回暗控件色', () => {
    const out = contrastColor({ r: 240, g: 240, b: 245 })
    expect(relativeLuminance(out)).toBeLessThan(0.3)
  })
  it('与背景明暗方向相反（对比成立）', () => {
    const darkBg = { r: 30, g: 30, b: 30 }
    const lightBg = { r: 235, g: 235, b: 235 }
    const c1 = relativeLuminance(contrastColor(darkBg))
    const c2 = relativeLuminance(contrastColor(lightBg))
    expect(c1).toBeGreaterThan(c2)
  })
})

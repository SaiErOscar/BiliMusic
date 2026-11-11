// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import EqualizerSheet, {
  applyEqualizerBand,
  applyEqualizerEnabled,
  applyEqualizerFlat,
  applyEqualizerPreset,
  eqPresetLabel,
  formatGain,
} from '../src/components/EqualizerSheet'
import {
  EQ_BANDS,
  EQ_BAND_COUNT,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  EQ_PRESETS,
  EQ_PRESET_ORDER,
  bandLabel,
  normalizeEqualizer,
} from '../src/services/equalizer'
import type { EqualizerSettings } from '../src/types'

/*
 * v1.4.15-pre1 均衡器设置界面。
 *
 * 组件里的状态迁移都提成了纯函数（applyEqualizer*），这里直接覆盖它们——
 * 在 jsdom 里模拟 range 拖动既脆又测不到「写进去的是不是归一化后的值」。
 * 渲染部分只断言结构：十根柱子、量程与步进、预设次序、自定义只在需要时出现。
 */

const flat = normalizeEqualizer(undefined)

function render(value: EqualizerSettings = flat): string {
  return renderToStaticMarkup(EqualizerSheet({ value, onChange: () => {}, onClose: () => {} }))
}

describe('均衡器抽屉：渲染结构', () => {
  it('十根柱子，量程与步进对齐契约常量', () => {
    const html = render()
    expect((html.match(/type="range"/g) || []).length).toBe(EQ_BAND_COUNT)
    expect(html).toContain('min="' + EQ_MIN_GAIN_DB + '"')
    expect(html).toContain('max="' + EQ_MAX_GAIN_DB + '"')
    expect(html).toContain('step="0.5"')
  })

  it('每根柱子下方都有频段短标签', () => {
    const html = render()
    for (const freq of EQ_BANDS) expect(html).toContain(bandLabel(freq))
  })

  it('预设按 EQ_PRESET_ORDER 的固定次序渲染，不依赖对象键序', () => {
    const html = render()
    const order = EQ_PRESET_ORDER.map((id) => html.indexOf(EQ_PRESETS[id].label))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('flat 时不出现「自定义」标记', () => {
    expect(render()).not.toContain('自定义')
  })

  it('preset 为 custom 时才显示「自定义」', () => {
    const custom = normalizeEqualizer({ enabled: true, preset: 'custom', gains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
    expect(render(custom)).toContain('自定义')
  })

  it('总开关与重置按钮在场', () => {
    const html = render()
    expect(html).toContain('启用均衡器')
    expect(html).toContain('重置为平坦')
    expect(html).toContain('role="switch"')
  })
})

describe('均衡器抽屉：预设切换写入的 gains 正确', () => {
  it('选每个预置都写入该预置的曲线，且 preset 一致', () => {
    for (const id of EQ_PRESET_ORDER) {
      const next = applyEqualizerPreset(flat, id)
      expect(next.preset, id).toBe(id)
      expect(next.gains, id).toEqual(EQ_PRESETS[id].gains)
    }
  })

  it('切预置不会改开关状态', () => {
    const on: EqualizerSettings = { ...flat, enabled: true }
    expect(applyEqualizerPreset(on, 'rock').enabled).toBe(true)
    expect(applyEqualizerPreset(flat, 'rock').enabled).toBe(false)
  })

  it('从 custom 切回预置时，脏的旧曲线不会残留', () => {
    const custom = normalizeEqualizer({ enabled: true, preset: 'custom', gains: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9] })
    const next = applyEqualizerPreset(custom, 'vocal')
    expect(next.gains).toEqual(EQ_PRESETS.vocal.gains)
  })

  it('开关只改 enabled，曲线原样保留', () => {
    const rock = applyEqualizerPreset(flat, 'rock')
    const off = applyEqualizerEnabled(rock, false)
    expect(off.enabled).toBe(false)
    expect(off.preset).toBe('rock')
    expect(off.gains).toEqual(EQ_PRESETS.rock.gains)
  })

  it('重置为平坦回到 flat 且十段全零，开关不动', () => {
    const on = applyEqualizerEnabled(applyEqualizerPreset(flat, 'bass'), true)
    const reset = applyEqualizerFlat(on)
    expect(reset.preset).toBe('flat')
    expect(reset.gains).toEqual(new Array(EQ_BAND_COUNT).fill(0))
    expect(reset.enabled).toBe(true)
  })
})

describe('均衡器抽屉：手动拖动后的 preset 归属', () => {
  it('拖出预置曲线之外 → custom，且只有被拖的那一段变了', () => {
    const rock = applyEqualizerPreset(flat, 'rock')
    const next = applyEqualizerBand(rock, 3, 7.5)
    expect(next.preset).toBe('custom')
    expect(next.gains[3]).toBe(7.5)
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      if (i === 3) continue
      expect(next.gains[i], '第 ' + i + ' 段不应被拖动影响').toBe(EQ_PRESETS.rock.gains[i])
    }
  })

  it('把柱子拖回某个预置的形状 → 自动归位到该预置', () => {
    // 从 flat 起，逐段拖成 pop 的曲线
    let value = flat
    EQ_PRESETS.pop.gains.forEach((g, i) => {
      value = applyEqualizerBand(value, i, g)
    })
    expect(value.preset).toBe('pop')
    expect(value.gains).toEqual(EQ_PRESETS.pop.gains)
  })

  it('全部拖回 0 → 归位到 flat 而不是 custom', () => {
    const bass = applyEqualizerPreset(flat, 'bass')
    let value = bass
    for (let i = 0; i < EQ_BAND_COUNT; i++) value = applyEqualizerBand(value, i, 0)
    expect(value.preset).toBe('flat')
  })

  it('越界值被归一化到量程内，不会把脏值写进设置', () => {
    const hi = applyEqualizerBand(flat, 0, 999)
    expect(hi.gains[0]).toBe(EQ_MAX_GAIN_DB)
    const lo = applyEqualizerBand(flat, 9, -999)
    expect(lo.gains[9]).toBe(EQ_MIN_GAIN_DB)
  })

  it('NaN / Infinity 按 0 处理', () => {
    expect(applyEqualizerBand(flat, 2, NaN).gains[2]).toBe(0)
    expect(applyEqualizerBand(flat, 2, Infinity).gains[2]).toBe(0)
  })

  it('非法下标不写坏数组，原曲线原样返回', () => {
    const rock = applyEqualizerPreset(flat, 'rock')
    expect(applyEqualizerBand(rock, -1, 5).gains).toEqual(EQ_PRESETS.rock.gains)
    expect(applyEqualizerBand(rock, EQ_BAND_COUNT, 5).gains).toEqual(EQ_PRESETS.rock.gains)
  })

  it('脏输入进组件前先被归一化：长度不足补 0、越界钳制', () => {
    const dirty = { enabled: true, preset: 'custom', gains: [50, -50] } as EqualizerSettings
    const clean = normalizeEqualizer(dirty)
    expect(clean.gains).toHaveLength(EQ_BAND_COUNT)
    expect(clean.gains[0]).toBe(EQ_MAX_GAIN_DB)
    expect(clean.gains[1]).toBe(EQ_MIN_GAIN_DB)
    expect(clean.gains[2]).toBe(0)
    // 归一化是幂等的：再跑一次不会再变
    expect(normalizeEqualizer(clean)).toEqual(clean)
  })
})

describe('均衡器抽屉：显示辅助', () => {
  it('custom 的显示名是「自定义」，其余取预置 label', () => {
    expect(eqPresetLabel('custom')).toBe('自定义')
    for (const id of EQ_PRESET_ORDER) expect(eqPresetLabel(id)).toBe(EQ_PRESETS[id].label)
  })

  it('增益文本带正负号，整数不带小数点', () => {
    expect(formatGain(0)).toBe('0')
    expect(formatGain(3)).toBe('+3')
    expect(formatGain(-3)).toBe('-3')
    expect(formatGain(3.5)).toBe('+3.5')
    expect(formatGain(-0.4)).toBe('-0.4')
  })
})

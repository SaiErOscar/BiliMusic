import { describe, it, expect } from 'vitest'
import {
  EQ_BANDS,
  EQ_BAND_COUNT,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  EQ_PRESETS,
  EQ_PRESET_ORDER,
  bandLabel,
  bandQ,
  clampGain,
  gainToRatio,
  gainsEqual,
  isFlat,
  normalizeEqualizer,
  normalizeGains,
  presetAfterManualEdit,
  presetGains,
} from '../src/services/equalizer'
import { DEFAULT_APP_SETTINGS, DEFAULT_EQUALIZER } from '../src/utils/storage'

describe('均衡器：频段定义', () => {
  it('固定十个频段，升序且与频段数一致', () => {
    expect(EQ_BAND_COUNT).toBe(10)
    expect(EQ_BANDS).toHaveLength(10)
    for (let i = 1; i < EQ_BANDS.length; i++) {
      expect(EQ_BANDS[i]).toBeGreaterThan(EQ_BANDS[i - 1])
    }
  })

  it('Q 值随频段递增且始终为正', () => {
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const q = bandQ(i)
      expect(q).toBeGreaterThan(0)
      if (i > 0) expect(q).toBeGreaterThanOrEqual(bandQ(i - 1))
    }
  })

  it('频段标签在 1kHz 以上用 k 写法', () => {
    expect(bandLabel(31)).toBe('31')
    expect(bandLabel(500)).toBe('500')
    expect(bandLabel(1000)).toBe('1k')
    expect(bandLabel(16000)).toBe('16k')
  })
})

describe('均衡器：预置曲线', () => {
  it('flat 必须是全零，DEFAULT_EQUALIZER 依赖这一点', () => {
    expect(EQ_PRESETS.flat.gains).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('每条预置都是十段且都在量程内', () => {
    for (const id of EQ_PRESET_ORDER) {
      const gains = EQ_PRESETS[id].gains
      expect(gains, id).toHaveLength(EQ_BAND_COUNT)
      for (const g of gains) {
        expect(g, id).toBeGreaterThanOrEqual(EQ_MIN_GAIN_DB)
        expect(g, id).toBeLessThanOrEqual(EQ_MAX_GAIN_DB)
      }
    }
  })

  it('预设顺序表覆盖全部非 custom 预置，无遗漏无重复', () => {
    const keys = Object.keys(EQ_PRESETS).sort()
    expect([...EQ_PRESET_ORDER].sort()).toEqual(keys)
    expect(new Set(EQ_PRESET_ORDER).size).toBe(EQ_PRESET_ORDER.length)
  })

  it('presetGains 返回副本，改它不污染常量', () => {
    const a = presetGains('rock')
    a[0] = 99
    expect(EQ_PRESETS.rock.gains[0]).not.toBe(99)
    expect(presetGains('rock')[0]).toBe(EQ_PRESETS.rock.gains[0])
  })

  it('custom 没有固定曲线，返回全零', () => {
    expect(presetGains('custom')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('均衡器：增益归一化', () => {
  it('越界钳制到 ±12dB，非有限值按 0', () => {
    expect(clampGain(50)).toBe(EQ_MAX_GAIN_DB)
    expect(clampGain(-50)).toBe(EQ_MIN_GAIN_DB)
    expect(clampGain(NaN)).toBe(0)
    expect(clampGain(Infinity)).toBe(0)
  })

  it('长度不足补齐 0，超长截断', () => {
    expect(normalizeGains([3])).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(normalizeGains(new Array(20).fill(2))).toHaveLength(10)
  })

  it('非数组输入退回全零，不抛错', () => {
    expect(normalizeGains(null)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(normalizeGains('abc')).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(normalizeGains(undefined)).toHaveLength(10)
  })

  it('四舍五入到 0.1dB，且不产生 -0', () => {
    const out = normalizeGains([3.14159, -0.04])
    expect(out[0]).toBe(3.1)
    expect(Object.is(out[1], -0)).toBe(false)
  })
})

describe('均衡器：整组设置归一化', () => {
  it('缺字段时兜底成关闭 + flat 全零', () => {
    expect(normalizeEqualizer(undefined)).toEqual({
      enabled: false,
      preset: 'flat',
      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    })
  })

  it('非 custom 预设时，增益以预置曲线为准（覆盖脏值）', () => {
    const out = normalizeEqualizer({ enabled: true, preset: 'rock', gains: [9, 9, 9, 9, 9, 9, 9, 9, 9, 9] })
    expect(out.preset).toBe('rock')
    expect(out.gains).toEqual(EQ_PRESETS.rock.gains)
  })

  it('custom 时信任调用方给的增益', () => {
    const out = normalizeEqualizer({ enabled: true, preset: 'custom', gains: [1, 2, 3] })
    expect(out.preset).toBe('custom')
    expect(out.gains).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 0, 0])
  })

  it('未知预设名退回 flat', () => {
    expect(normalizeEqualizer({ preset: '不存在的' as never }).preset).toBe('flat')
  })

  it('enabled 非布尔值按真值转换', () => {
    expect(normalizeEqualizer({ enabled: 1 }).enabled).toBe(true)
    expect(normalizeEqualizer({ enabled: 0 }).enabled).toBe(false)
  })
})

describe('均衡器：与默认值的一致性', () => {
  it('DEFAULT_EQUALIZER 自身就是合法归一化结果（幂等）', () => {
    expect(normalizeEqualizer(DEFAULT_EQUALIZER)).toEqual(DEFAULT_EQUALIZER)
  })

  it('DEFAULT_EQUALIZER 的增益与 flat 预置完全一致', () => {
    expect(DEFAULT_EQUALIZER.gains).toEqual(EQ_PRESETS.flat.gains)
  })

  it('DEFAULT_APP_SETTINGS 带上了均衡器默认值且默认关闭', () => {
    expect(DEFAULT_APP_SETTINGS.equalizer).toEqual(DEFAULT_EQUALIZER)
    expect(DEFAULT_APP_SETTINGS.equalizer.enabled).toBe(false)
  })
})

describe('均衡器：手动编辑后的预设归属', () => {
  it('拖回某个预置曲线时自动归位到该预置', () => {
    expect(presetAfterManualEdit([...EQ_PRESETS.pop.gains])).toBe('pop')
    expect(presetAfterManualEdit([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe('flat')
  })

  it('不匹配任何预置时记为 custom', () => {
    expect(presetAfterManualEdit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('custom')
  })
})

describe('均衡器：比较与比例', () => {
  it('浮点尾数不影响相等判定', () => {
    expect(gainsEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1.0000001, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(true)
    expect(gainsEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(false)
  })

  it('isFlat 只对全零为真', () => {
    expect(isFlat([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(true)
    expect(isFlat(presetGains('rock'))).toBe(false)
  })

  it('gainToRatio 落在 0~1，越界被钳制', () => {
    expect(gainToRatio(0)).toBe(0)
    expect(gainToRatio(EQ_MAX_GAIN_DB)).toBe(1)
    expect(gainToRatio(-EQ_MAX_GAIN_DB)).toBe(1)
    expect(gainToRatio(999)).toBe(1)
  })
})

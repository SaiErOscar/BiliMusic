/**
 * v1.4.15-pre1 均衡器设置抽屉。
 *
 * 只做「界面 + 写回」两件事：
 * - 频段、量程、预置曲线、归一化规则全部来自 src/services/equalizer.ts（已冻结），
 *   这里不复制任何一份常量，避免「界面按一套、播放按另一套」；
 * - 任何一次写入都先过 normalizeEqualizer / normalizeGains 再交给调用方，
 *   越界值、NaN、长度不对的数组不会进入设置存储。
 *
 * 外壳复用 ai-sheet__* 那套浮层样式（见 AiConfigSheet）：
 * 深色玻璃 / 浅色实心白面的分主题处理已经在那边做过了，
 * 这里只补 eq-* 前缀的均衡器专属零件，不复制一份外壳。
 */
import {
  EQ_BANDS,
  EQ_BAND_COUNT,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  EQ_PRESETS,
  EQ_PRESET_ORDER,
  bandLabel,
  normalizeEqualizer,
  normalizeGains,
  presetAfterManualEdit,
  presetGains,
} from '@/services/equalizer'
import type { EqualizerPresetId, EqualizerSettings } from '@/types'

/**
 * 预设的显示名。
 *
 * custom 不在 EQ_PRESETS 里（它没有固定曲线），所以单独兜一句；
 * 设置页入口行与抽屉里的当前状态都走这一个函数，两处不会写出不一样的名字。
 */
export function eqPresetLabel(preset: EqualizerPresetId): string {
  return preset === 'custom' ? '自定义' : EQ_PRESETS[preset].label
}

/** 单段增益的显示文本：整数不带小数点，正数带 + 号，0 就是 0。 */
export function formatGain(gain: number): string {
  const rounded = Math.round(gain * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return rounded > 0 ? '+' + text : text
}

/*
 * 下面四个是抽屉里全部的状态迁移，组件只负责把它们接到控件上。
 *
 * 提成纯函数而不是写在 onClick 里，是为了让「写入前必须归一化」这条规则
 * 只有一处实现——想加一条新的写入口，就只能走这四个里的一个。
 * 顺带让 tests/equalizerSheet.test.ts 能直接覆盖真实逻辑，
 * 不必在 jsdom 里模拟 range 的拖动事件。
 */

/** 开关：只改 enabled，曲线与预设原样保留。 */
export function applyEqualizerEnabled(value: EqualizerSettings, enabled: boolean): EqualizerSettings {
  return normalizeEqualizer({ ...value, enabled })
}

/**
 * 选预设：写回的就是该预设的曲线。
 *
 * 不在这里调 presetGains 拼 gains——normalizeEqualizer 的契约是
 * 「preset 不是 custom 时以预置曲线为准」，重复写一遍只会多一个可能写错的地方。
 */
export function applyEqualizerPreset(value: EqualizerSettings, preset: EqualizerPresetId): EqualizerSettings {
  return normalizeEqualizer({ enabled: value.enabled, preset, gains: value.gains })
}

/**
 * 拖动某一根柱子。
 *
 * 先在当前曲线上改这一段（其余九段保持用户看到的样子），再交给
 * presetAfterManualEdit 决定归属：拖回某个预置的形状就自动归位到那个预置，
 * 否则记为 custom。
 */
export function applyEqualizerBand(value: EqualizerSettings, index: number, rawGain: number): EqualizerSettings {
  const gains = normalizeGains(value.gains)
  if (index < 0 || index >= EQ_BAND_COUNT) {
    return normalizeEqualizer({ enabled: value.enabled, preset: value.preset, gains })
  }
  gains[index] = rawGain
  const normalized = normalizeGains(gains)
  return normalizeEqualizer({
    enabled: value.enabled,
    preset: presetAfterManualEdit(normalized),
    gains: normalized,
  })
}

/** 重置为平坦：回到 flat 预置，开关状态不动。 */
export function applyEqualizerFlat(value: EqualizerSettings): EqualizerSettings {
  return normalizeEqualizer({ enabled: value.enabled, preset: 'flat', gains: presetGains('flat') })
}

interface Props {
  /** 当前设置；组件内部会再过一次 normalizeEqualizer，脏值不会显示成脏界面 */
  value: EqualizerSettings
  onChange: (next: EqualizerSettings) => void
  onClose: () => void
}

export default function EqualizerSheet({ value, onChange, onClose }: Props) {
  const current = normalizeEqualizer(value)
  const gains = current.gains

  return (
    <div className="ai-sheet-overlay" onClick={onClose}>
      <div className="ai-sheet eq-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ai-sheet__head">
          <strong>均衡器</strong>
          <button type="button" className="ai-sheet__close" onClick={onClose}>×</button>
        </div>

        <div className="ai-sheet__body eq-sheet__body">
          <div className="eq-switch-row">
            <div className="eq-switch-row__text">
              <strong>启用均衡器</strong>
              <span>关闭时完全不接管播放链路，声音直通</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={current.enabled}
              aria-label="启用均衡器"
              className={'eq-switch' + (current.enabled ? ' eq-switch--on' : '')}
              onClick={() => onChange(applyEqualizerEnabled(current, !current.enabled))}
            >
              <span />
            </button>
          </div>

          <div className="eq-presets" role="group" aria-label="均衡器预设">
            {EQ_PRESET_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={current.preset === id}
                className={'eq-preset' + (current.preset === id ? ' eq-preset--on' : '')}
                onClick={() => onChange(applyEqualizerPreset(current, id))}
              >
                {EQ_PRESETS[id].label}
              </button>
            ))}
            {/* custom 没有固定曲线，只在真的处于自定义时才出现，点了也不做任何事 */}
            {current.preset === 'custom' && <span className="eq-preset eq-preset--on">自定义</span>}
          </div>

          <div className="eq-bands">
            {EQ_BANDS.map((freq, index) => (
              <div className="eq-band" key={freq}>
                <span className="eq-band__value">{formatGain(gains[index])}</span>
                <input
                  className="eq-band__range"
                  type="range"
                  min={EQ_MIN_GAIN_DB}
                  max={EQ_MAX_GAIN_DB}
                  step={0.5}
                  value={gains[index]}
                  aria-label={'频段 ' + bandLabel(freq) + ' Hz'}
                  title={bandLabel(freq) + ' Hz：' + formatGain(gains[index]) + ' dB'}
                  onChange={(e) => onChange(applyEqualizerBand(current, index, Number(e.target.value)))}
                />
                <span className="eq-band__label">{bandLabel(freq)}</span>
              </div>
            ))}
          </div>

          <div className="eq-actions">
            <button type="button" className="eq-reset" onClick={() => onChange(applyEqualizerFlat(current))}>
              重置为平坦
            </button>
            <span className="eq-actions__hint">
              当前：{eqPresetLabel(current.preset)} · {current.enabled ? '已开启' : '已关闭'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

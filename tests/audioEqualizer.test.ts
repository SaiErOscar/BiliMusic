// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  closeAudioGraph,
  disposeAudioGraph,
  ensureAudioGraph,
  getAnalyser,
  getEqualizerFilters,
  setEqualizerEnabled,
  setEqualizerGains,
} from '../src/services/audioGraph'
import { EQ_BANDS, EQ_BAND_COUNT, bandQ } from '../src/services/equalizer'

// v1.4.15-pre1 均衡器接线：jsdom 没有 Web Audio，这里装一个假 AudioContext，
// 用它记录每条 connect/disconnect，从而把「拓扑」和「节点是否被复用」变成可断言的事实。
// 断言的是真实调用序列，不是 audioGraph.ts 内部实现细节。

/** 假 AudioParam：只需 value 可读可写。 */
interface FakeParam {
  value: number
}

/** 假 AudioNode：记录自己连去了谁，以及被 connect / disconnect 的次数。 */
class FakeNode {
  readonly kind: string
  readonly id: number
  type = ''
  frequency: FakeParam = { value: 0 }
  Q: FakeParam = { value: 0 }
  gain: FakeParam = { value: 0 }
  fftSize = 0
  smoothingTimeConstant = 0
  /** 当前出边（connect 的目标） */
  outputs: FakeNode[] = []
  connectCount = 0
  disconnectCount = 0

  constructor(kind: string, id: number) {
    this.kind = kind
    this.id = id
  }

  connect(target: FakeNode): FakeNode {
    this.outputs.push(target)
    this.connectCount += 1
    return target
  }

  disconnect(target?: FakeNode): void {
    this.disconnectCount += 1
    if (!target) {
      this.outputs = []
      return
    }
    this.outputs = this.outputs.filter((n) => n !== target)
  }
}

/** 本用例内创建过的全部假节点（用于取到 source / destination 做断言）。 */
let created: FakeNode[] = []
let nodeSeq = 0
let biquadCalls = 0

class FakeAudioContext {
  readonly destination: FakeNode
  state = 'running'
  closed = false

  constructor() {
    this.destination = new FakeNode('destination', nodeSeq++)
    created.push(this.destination)
  }

  createMediaElementSource(_audio: unknown): FakeNode {
    const n = new FakeNode('source', nodeSeq++)
    created.push(n)
    return n
  }

  createAnalyser(): FakeNode {
    const n = new FakeNode('analyser', nodeSeq++)
    created.push(n)
    return n
  }

  createBiquadFilter(): FakeNode {
    biquadCalls += 1
    const n = new FakeNode('biquad', nodeSeq++)
    created.push(n)
    return n
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  resume(): Promise<void> {
    return Promise.resolve()
  }
}

/** 取本用例创建的第一个某类节点。 */
function find(kind: string): FakeNode | undefined {
  return created.find((n) => n.kind === kind)
}

/** 造一个能通过 identity 比较的假 audio 元素。 */
function fakeAudio(): HTMLAudioElement {
  return { tagName: 'AUDIO' } as unknown as HTMLAudioElement
}

/** 所有已创建节点的 connect/disconnect 总次数（用于断言「没有重连」）。 */
function totalWiringCalls(): { connect: number; disconnect: number } {
  return created.reduce(
    (acc, n) => ({ connect: acc.connect + n.connectCount, disconnect: acc.disconnect + n.disconnectCount }),
    { connect: 0, disconnect: 0 },
  )
}

beforeEach(() => {
  created = []
  nodeSeq = 0
  biquadCalls = 0
  ;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext
})

afterEach(() => {
  closeAudioGraph()
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
})

describe('均衡器链拓扑', () => {
  it('可视化开启时链路为 source → 10 个滤波器 → analyser → destination', () => {
    const ctx = ensureAudioGraph(fakeAudio(), { analyser: true })
    expect(ctx).not.toBeNull()

    const filters = getEqualizerFilters()
    expect(filters).toHaveLength(EQ_BAND_COUNT)

    const source = find('source')!
    const analyser = find('analyser')!
    const destination = find('destination')!

    // 源节点的唯一下游是第一个滤波器
    expect(source.outputs).toEqual([filters[0]])
    // 十个滤波器首尾串联
    for (let i = 0; i < filters.length - 1; i++) {
      expect(filters[i].outputs).toEqual([filters[i + 1]])
    }
    // 链尾接 analyser，analyser 再接 destination
    expect(filters[filters.length - 1].outputs).toEqual([analyser])
    expect(analyser.outputs).toEqual([destination])
  })

  it('只开均衡器（未开可视化）时链尾仍接到 destination，不会静音', () => {
    const ctx = ensureAudioGraph(fakeAudio(), { analyser: false })
    expect(ctx).not.toBeNull()

    const filters = getEqualizerFilters()
    expect(filters).toHaveLength(EQ_BAND_COUNT)

    const source = find('source')!
    const destination = find('destination')!
    const analyser = find('analyser')!

    expect(source.outputs).toEqual([filters[0]])
    for (let i = 0; i < filters.length - 1; i++) {
      expect(filters[i].outputs).toEqual([filters[i + 1]])
    }
    // 关键断言：链尾直连 destination，且 analyser 不在活路径上
    expect(filters[filters.length - 1].outputs).toEqual([destination])
    expect(analyser.outputs).toEqual([])
    expect(getAnalyser()).toBeNull()
  })

  it('十个滤波器都是 peaking，频率与 Q 取自 equalizer 的频段定义', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const filters = getEqualizerFilters()
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      expect(filters[i].type).toBe('peaking')
      expect(filters[i].frequency.value).toBe(EQ_BANDS[i])
      expect(filters[i].Q.value).toBe(bandQ(i))
    }
  })

  it('建图后滤波器初值全 0（直通），未启用前不改变频响', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    expect(getEqualizerFilters().every((f) => f.gain.value === 0)).toBe(true)
  })

  it('可视化后开时把 analyser 插回链尾，滤波器不重建', () => {
    const audio = fakeAudio()
    ensureAudioGraph(audio, { analyser: false })
    const before = getEqualizerFilters()

    ensureAudioGraph(audio, { analyser: true })
    const after = getEqualizerFilters()

    // 同一组节点对象被复用
    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i])

    const analyser = find('analyser')!
    const destination = find('destination')!
    expect(after[after.length - 1].outputs).toEqual([analyser])
    expect(analyser.outputs).toEqual([destination])
    expect(getAnalyser()).toBe(analyser)
  })

  it('同一元素重复 ensureAudioGraph 不会重建滤波器节点', () => {
    const audio = fakeAudio()
    ensureAudioGraph(audio, { analyser: true })
    const first = getEqualizerFilters()
    ensureAudioGraph(audio, { analyser: true })
    ensureAudioGraph(audio, { analyser: true })
    const second = getEqualizerFilters()

    expect(biquadCalls).toBe(EQ_BAND_COUNT)
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i])
  })
})

describe('增益更新与旁路', () => {
  it('更新增益写入对应滤波器，且不重建节点', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const filters = getEqualizerFilters()
    const gains = [6, 5, 4, 3, 2, 1, -1, -2, -3, -4]

    setEqualizerEnabled(true)
    setEqualizerGains(gains)

    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      expect(filters[i].gain.value).toBe(gains[i])
    }
    // 节点对象还是原来那十个，也没有额外创建滤波器
    const after = getEqualizerFilters()
    for (let i = 0; i < filters.length; i++) expect(after[i]).toBe(filters[i])
    expect(biquadCalls).toBe(EQ_BAND_COUNT)
  })

  it('连续多次更新增益复用同一组节点对象', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const first = getEqualizerFilters()
    setEqualizerEnabled(true)

    setEqualizerGains([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    const second = getEqualizerFilters()
    setEqualizerGains([2, 2, 2, 2, 2, 2, 2, 2, 2, 2])
    const third = getEqualizerFilters()

    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      expect(second[i]).toBe(first[i])
      expect(third[i]).toBe(first[i])
      expect(third[i].gain.value).toBe(2)
    }
    expect(biquadCalls).toBe(EQ_BAND_COUNT)
  })

  it('关闭均衡器把十个增益全置 0（旁路），且不产生任何 disconnect/connect', () => {
    ensureAudioGraph(fakeAudio(), { analyser: true })
    const filters = getEqualizerFilters()
    setEqualizerEnabled(true)
    setEqualizerGains([8, 7, 5, 2, 0, 0, 0, 0, 0, 0])
    expect(filters[0].gain.value).toBe(8)

    const wiringBefore = totalWiringCalls()
    setEqualizerEnabled(false)
    const wiringAfter = totalWiringCalls()

    // 旁路 = 全零
    expect(filters.every((f) => f.gain.value === 0)).toBe(true)
    // 关键：没有断开重连（否则会有可听见的断音）
    expect(wiringAfter).toEqual(wiringBefore)
  })

  it('旁路后再启用会恢复此前保存的曲线', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const filters = getEqualizerFilters()
    setEqualizerEnabled(true)
    setEqualizerGains([5, 4, 3, 2, 1, 0, -1, -2, -3, -4])

    setEqualizerEnabled(false)
    expect(filters.every((f) => f.gain.value === 0)).toBe(true)

    setEqualizerEnabled(true)
    expect(filters[0].gain.value).toBe(5)
    expect(filters[9].gain.value).toBe(-4)
  })

  it('脏增益被归一化：长度补齐、越界钳制到 ±12dB、非有限值按 0', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const filters = getEqualizerFilters()
    setEqualizerEnabled(true)

    setEqualizerGains([99, -99, 3, NaN])
    expect(filters[0].gain.value).toBe(12)
    expect(filters[1].gain.value).toBe(-12)
    expect(filters[2].gain.value).toBe(3)
    expect(filters[3].gain.value).toBe(0)
    // 缺的段补齐 0
    for (let i = 4; i < EQ_BAND_COUNT; i++) expect(filters[i].gain.value).toBe(0)
  })

  it('旁路状态下更新曲线只记录不生效，启用后一次套用', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const filters = getEqualizerFilters()
    setEqualizerGains([6, 6, 6, 6, 6, 6, 6, 6, 6, 6])
    // 尚未启用：仍是直通
    expect(filters.every((f) => f.gain.value === 0)).toBe(true)

    setEqualizerEnabled(true)
    expect(filters.every((f) => f.gain.value === 6)).toBe(true)
  })
})

describe('释放与降级', () => {
  it('disposeAudioGraph 把均衡器归零并让链尾回到 destination', () => {
    ensureAudioGraph(fakeAudio(), { analyser: true })
    const filters = getEqualizerFilters()
    setEqualizerEnabled(true)
    setEqualizerGains([4, 4, 4, 4, 4, 4, 4, 4, 4, 4])

    disposeAudioGraph()

    expect(filters.every((f) => f.gain.value === 0)).toBe(true)
    const destination = find('destination')!
    expect(filters[filters.length - 1].outputs).toEqual([destination])
    expect(getAnalyser()).toBeNull()
  })

  it('closeAudioGraph 后滤波器全部断开且不再返回节点', () => {
    ensureAudioGraph(fakeAudio(), { analyser: true })
    const filters = getEqualizerFilters()
    closeAudioGraph()

    expect(getEqualizerFilters()).toEqual([])
    expect(getAnalyser()).toBeNull()
    for (const f of filters) expect(f.outputs).toEqual([])
  })

  it('未建图时 setEqualizerEnabled / setEqualizerGains 是空操作，不抛错', () => {
    expect(() => setEqualizerEnabled(true)).not.toThrow()
    expect(() => setEqualizerGains([1, 2, 3])).not.toThrow()
    expect(getEqualizerFilters()).toEqual([])
  })

  it('环境没有 AudioContext 时返回 null，且均衡器调用安全降级', async () => {
    // 换一份全新的模块实例：模块内的 unavailable 标志是模块级状态，
    // 必须隔离，否则会影响本文件其余用例。
    vi.resetModules()
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
    const fresh = await import('../src/services/audioGraph')

    expect(fresh.ensureAudioGraph(fakeAudio(), { analyser: false })).toBeNull()
    expect(() => fresh.setEqualizerEnabled(true)).not.toThrow()
    expect(() => fresh.setEqualizerGains([3, 3, 3])).not.toThrow()
    expect(fresh.getEqualizerFilters()).toEqual([])
    expect(fresh.getAnalyser()).toBeNull()
  })

  it('createBiquadFilter 抛错时整组丢弃，主链路仍接通 destination（不影响出声）', async () => {
    vi.resetModules()
    class BrokenEqContext extends FakeAudioContext {
      createBiquadFilter(): FakeNode {
        throw new Error('boom')
      }
    }
    ;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = BrokenEqContext
    const fresh = await import('../src/services/audioGraph')

    const ctx = fresh.ensureAudioGraph(fakeAudio(), { analyser: false })
    expect(ctx).not.toBeNull()
    expect(fresh.getEqualizerFilters()).toEqual([])

    // 没有滤波器时 source 必须直连 destination，否则静音
    const source = created.find((n) => n.kind === 'source')!
    const destination = created.find((n) => n.kind === 'destination')!
    expect(source.outputs).toEqual([destination])
  })

  it('createAnalyser 抛错时只降级可视化，均衡器链照常接到 destination', async () => {
    vi.resetModules()
    class NoAnalyserContext extends FakeAudioContext {
      createAnalyser(): FakeNode {
        throw new Error('boom')
      }
    }
    ;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = NoAnalyserContext
    const fresh = await import('../src/services/audioGraph')

    const ctx = fresh.ensureAudioGraph(fakeAudio(), { analyser: true })
    expect(ctx).not.toBeNull()

    const filters = fresh.getEqualizerFilters()
    expect(filters).toHaveLength(EQ_BAND_COUNT)
    const destination = created.find((n) => n.kind === 'destination')!
    expect(filters[filters.length - 1].outputs).toEqual([destination])
    expect(fresh.getAnalyser()).toBeNull()
  })
})

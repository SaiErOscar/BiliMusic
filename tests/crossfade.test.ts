// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MASTER_GAIN_FULL,
  MASTER_GAIN_SILENT,
  CROSSFADE_MAX_SECONDS,
  CROSSFADE_MIN_SECONDS,
  closeAudioGraph,
  disposeAudioGraph,
  ensureAudioGraph,
  fadeMasterGain,
  getMasterGainValue,
  normalizeCrossfadeSeconds,
  runCrossfade,
} from '../src/services/audioGraph'
import { getEqualizerFilters } from '../src/services/audioGraph'
import { DEFAULT_APP_SETTINGS, loadAppSettings } from '../src/utils/storage'
import { EQ_BAND_COUNT } from '../src/services/equalizer'

// v1.4.15-pre2 淡入淡出切歌：jsdom 没有 Web Audio，这里装一个会记账的假 AudioContext，
// 把「渐变调用序列」「链路拓扑」「作废旧渐变」变成可断言的事实。
// 断言的是真实调用序列，不是 audioGraph.ts 的内部实现细节。

/** 一条排定的自动化事件。 */
interface FakeEvent {
  type: 'set' | 'ramp' | 'cancel'
  /** set / ramp 的目标值 */
  value?: number
  /** 排定时刻（AudioContext 时间轴，秒） */
  time: number
}

/** 假 AudioParam：记录每一次自动化调用。 */
class FakeParam {
  value = 0
  events: FakeEvent[] = []

  setValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ type: 'set', value, time })
    return this
  }

  linearRampToValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ type: 'ramp', value, time })
    return this
  }

  cancelScheduledValues(time: number): FakeParam {
    this.events.push({ type: 'cancel', time })
    return this
  }

  /** 只看渐变事件（set/ramp），用于断言「没有产生任何渐变」。 */
  ramps(): FakeEvent[] {
    return this.events.filter((e) => e.type === 'ramp')
  }
}

/** 假 AudioNode：记录出边与 connect/disconnect 次数。 */
class FakeNode {
  readonly kind: string
  readonly id: number
  type = ''
  frequency: FakeParam = new FakeParam()
  Q: FakeParam = new FakeParam()
  gain: FakeParam = new FakeParam()
  fftSize = 0
  smoothingTimeConstant = 0
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

let created: FakeNode[] = []
let nodeSeq = 0
/** AudioContext 时间轴（秒），测试可调。 */
let ctxNow = 0

class FakeAudioContext {
  readonly destination: FakeNode
  state = 'running'

  constructor() {
    this.destination = new FakeNode('destination', nodeSeq++)
    created.push(this.destination)
  }

  get currentTime(): number {
    return ctxNow
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
    const n = new FakeNode('biquad', nodeSeq++)
    created.push(n)
    return n
  }

  createGain(): FakeNode {
    const n = new FakeNode('gain', nodeSeq++)
    created.push(n)
    return n
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  resume(): Promise<void> {
    return Promise.resolve()
  }
}

function find(kind: string): FakeNode | undefined {
  return created.find((n) => n.kind === kind)
}

function fakeAudio(): HTMLAudioElement {
  return { tagName: 'AUDIO' } as unknown as HTMLAudioElement
}

/**
 * 推进假时钟：既推进 AudioContext 时间轴，也推进 setTimeout。
 * 两者必须同步，否则「渐变终点 = now + 时长」这类断言会失真。
 */
async function advance(ms: number): Promise<void> {
  ctxNow += ms / 1000
  await vi.advanceTimersByTimeAsync(ms)
}

/** 取输出增益节点（建图后必然存在）。 */
function masterGainNode(): FakeNode {
  const node = find('gain')
  if (!node) throw new Error('masterGain 未创建')
  return node
}

beforeEach(() => {
  created = []
  nodeSeq = 0
  ctxNow = 0
  ;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = FakeAudioContext
})

afterEach(() => {
  vi.useRealTimers()
  closeAudioGraph()
  delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
})

describe('链路拓扑：masterGain 在链尾与 destination 之间', () => {
  it('可视化开启时链路为 source → 10 个滤波器 → analyser → masterGain → destination', () => {
    expect(ensureAudioGraph(fakeAudio(), { analyser: true })).not.toBeNull()

    const filters = getEqualizerFilters()
    const analyser = find('analyser')!
    const master = masterGainNode()
    const destination = find('destination')!

    expect(filters[filters.length - 1].outputs).toEqual([analyser])
    expect(analyser.outputs).toEqual([master])
    expect(master.outputs).toEqual([destination])
  })

  it('未开可视化时兜底分支同样经过 masterGain（不能直连 destination）', () => {
    expect(ensureAudioGraph(fakeAudio(), { analyser: false })).not.toBeNull()

    const filters = getEqualizerFilters()
    const analyser = find('analyser')!
    const master = masterGainNode()
    const destination = find('destination')!

    // 关键：链尾落到 masterGain，而不是绕过它直连 destination
    expect(filters[filters.length - 1].outputs).toEqual([master])
    expect(master.outputs).toEqual([destination])
    expect(analyser.outputs).toEqual([])
  })

  it('滤波器整组创建失败时 source 仍经 masterGain 到 destination', async () => {
    vi.resetModules()
    class BrokenEqContext extends FakeAudioContext {
      createBiquadFilter(): FakeNode {
        throw new Error('boom')
      }
    }
    ;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = BrokenEqContext
    const fresh = await import('../src/services/audioGraph')

    expect(fresh.ensureAudioGraph(fakeAudio(), { analyser: false })).not.toBeNull()
    expect(fresh.getEqualizerFilters()).toEqual([])

    const source = find('source')!
    const master = masterGainNode()
    const destination = find('destination')!
    expect(source.outputs).toEqual([master])
    expect(master.outputs).toEqual([destination])
  })

  it('masterGain 初值为满值 1，建图本身不改变音量', () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    expect(getMasterGainValue()).toBe(MASTER_GAIN_FULL)
    expect(masterGainNode().gain.events).toEqual([])
  })

  it('关闭可视化重接线后 masterGain 仍只有一条出边（不会重复连接导致翻倍）', () => {
    const audio = fakeAudio()
    ensureAudioGraph(audio, { analyser: true })
    ensureAudioGraph(audio, { analyser: false })

    const master = masterGainNode()
    const destination = find('destination')!
    expect(master.outputs).toEqual([destination])
    expect(master.connectCount).toBe(2) // 两次接线，但每次重接前都断干净
  })
})

describe('关闭淡入淡出：零延迟硬切', () => {
  it('enabled=false 时 swap 立即执行，且不产生任何渐变调用', async () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain
    const swaps: string[] = []

    const outcome = await runCrossfade({
      enabled: false,
      seconds: 3,
      swap: () => { swaps.push('swap') },
    })

    expect(outcome).toBe('immediate')
    expect(swaps).toEqual(['swap'])
    // 关键：一次渐变都没有
    expect(gain.ramps()).toEqual([])
    expect(gain.events).toEqual([])
    // 增益保持满值
    expect(getMasterGainValue()).toBe(MASTER_GAIN_FULL)
  })

  it('关闭时不等待任何时长（同步完成，不排 setTimeout）', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    let swapped = false

    const p = runCrossfade({ enabled: false, seconds: 10, swap: () => { swapped = true } })
    // 不推进任何假时钟：关闭路径必须已经在同一轮微任务里换完曲
    await p
    expect(swapped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('增益停在 0（上次淡出中途被打断）时，关闭路径先复位到满值再硬切', async () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain
    // 制造「上次淡出中途被打断」的状态：增益目标停在 0
    expect(fadeMasterGain(MASTER_GAIN_SILENT, 2)).toBe(true)
    expect(getMasterGainValue()).toBe(MASTER_GAIN_SILENT)
    gain.events.length = 0

    await runCrossfade({ enabled: false, seconds: 3, swap: () => {} })

    // 必须复位到满值，否则关闭淡入淡出后就是永久静音
    expect(getMasterGainValue()).toBe(MASTER_GAIN_FULL)
    expect(gain.ramps()).toEqual([])
  })
})

describe('开启淡入淡出：淡出 → 切换 → 淡入', () => {
  it('调用序列是先淡出到 0、再 swap、再淡入到 1', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain
    const order: string[] = []

    const p = runCrossfade({
      enabled: true,
      seconds: 4,
      swap: () => { order.push('swap') },
    })

    // 淡出已排定，swap 还没发生
    expect(gain.ramps().map((e) => e.value)).toEqual([MASTER_GAIN_SILENT])
    expect(order).toEqual([])

    await advance(2000)
    await p

    // 淡出 → swap → 淡入
    expect(order).toEqual(['swap'])
    expect(gain.ramps().map((e) => e.value)).toEqual([MASTER_GAIN_SILENT, MASTER_GAIN_FULL])
  })

  it('淡出与淡入各占 crossfadeSeconds 的一半', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain

    const p = runCrossfade({ enabled: true, seconds: 6, swap: () => {} })
    await advance(3000)
    await p

    const ramps = gain.ramps()
    expect(ramps).toHaveLength(2)
    // 起点 t=0，淡出终点 3s（= 6/2），淡入终点 6s（再 + 3s）
    expect(ramps[0].time).toBeCloseTo(3, 5)
    expect(ramps[1].time).toBeCloseTo(6, 5)
  })

  it('每次渐变都以「当前值」作为起点，从渐变中途再次发起时曲线连续', async () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain
    gain.value = 0.5

    expect(fadeMasterGain(MASTER_GAIN_SILENT, 2)).toBe(true)

    const events = gain.events
    expect(events[0].type).toBe('cancel')
    expect(events[1]).toEqual({ type: 'set', value: 0.5, time: 0 })
    expect(events[2]).toEqual({ type: 'ramp', value: MASTER_GAIN_SILENT, time: 2 })
  })

  it('时长越界时按 1~10 秒钳制', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain

    const p = runCrossfade({ enabled: true, seconds: 999, swap: () => {} })
    await advance((CROSSFADE_MAX_SECONDS / 2) * 1000)
    await p

    expect(gain.ramps()[0].time).toBeCloseTo(CROSSFADE_MAX_SECONDS / 2, 5)
  })
})

describe('淡出期间再次切歌：旧渐变作废', () => {
  it('旧任务返回 superseded 且不执行 swap，以最新一次为准', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain
    const swaps: string[] = []

    const first = runCrossfade({
      enabled: true,
      seconds: 4,
      swap: () => { swaps.push('first') },
    })
    // 淡出进行到一半时用户又点了另一首
    await advance(1000)
    const second = runCrossfade({
      enabled: true,
      seconds: 4,
      swap: () => { swaps.push('second') },
    })

    await advance(2000)
    await second
    await advance(4000)
    const firstOutcome = await first

    expect(firstOutcome).toBe('superseded')
    // 旧切歌绝不能再换曲（否则会切到用户已经放弃的那首）
    expect(swaps).toEqual(['second'])
    // 增益最终停在满值：新一次接管并完成了淡入
    expect(gain.ramps()[gain.ramps().length - 1].value).toBe(MASTER_GAIN_FULL)
  })

  it('新一次切歌会取消旧渐变排定的事件（cancelScheduledValues）', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const gain = masterGainNode().gain

    const first = runCrossfade({ enabled: true, seconds: 4, swap: () => {} })
    const cancelsBefore = gain.events.filter((e) => e.type === 'cancel').length
    const second = runCrossfade({ enabled: true, seconds: 4, swap: () => {} })

    expect(gain.events.filter((e) => e.type === 'cancel').length).toBeGreaterThan(cancelsBefore)

    await advance(6000)
    await second
    expect(await first).toBe('superseded')
  })

  it('关闭淡入淡出时连续切歌不会互相作废（每次都真的换曲）', async () => {
    ensureAudioGraph(fakeAudio(), { analyser: false })
    const swaps: string[] = []
    const run = (name: string) => runCrossfade({
      enabled: false,
      seconds: 3,
      swap: () => { swaps.push(name) },
    })

    expect(await run('a')).toBe('immediate')
    expect(await run('b')).toBe('immediate')
    expect(swaps).toEqual(['a', 'b'])
  })
})

describe('降级：拿不到音频图时安全退回普通播放', () => {
  it('环境没有 AudioContext 时 runCrossfade 硬切且不抛错', async () => {
    vi.resetModules()
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
    const fresh = await import('../src/services/audioGraph')

    const swaps: string[] = []
    const outcome = await fresh.runCrossfade({
      enabled: true,
      seconds: 3,
      swap: () => { swaps.push('swap') },
    })

    expect(outcome).toBe('immediate')
    expect(swaps).toEqual(['swap'])
    expect(fresh.fadeMasterGain(0, 1)).toBe(false)
    expect(fresh.getMasterGainValue()).toBe(MASTER_GAIN_FULL)
  })

  it('createGain 抛错时淡入淡出禁用，播放链路仍直连 destination', async () => {
    vi.resetModules()
    class NoGainContext extends FakeAudioContext {
      createGain(): FakeNode {
        throw new Error('boom')
      }
    }
    ;(globalThis as unknown as { AudioContext?: unknown }).AudioContext = NoGainContext
    const fresh = await import('../src/services/audioGraph')

    expect(fresh.ensureAudioGraph(fakeAudio(), { analyser: false })).not.toBeNull()

    const filters = fresh.getEqualizerFilters()
    expect(filters).toHaveLength(EQ_BAND_COUNT)
    // 没有增益节点：链尾直连 destination，绝不能悬空（悬空 = 静音）
    const destination = find('destination')!
    expect(filters[filters.length - 1].outputs).toEqual([destination])

    const swaps: string[] = []
    const outcome = await fresh.runCrossfade({
      enabled: true,
      seconds: 3,
      swap: () => { swaps.push('swap') },
    })
    expect(outcome).toBe('immediate')
    expect(swaps).toEqual(['swap'])
  })

  it('swap 抛错时 runCrossfade 不抛出去，增益被复位', async () => {
    vi.useFakeTimers()
    ensureAudioGraph(fakeAudio(), { analyser: false })
    masterGainNode().gain.value = MASTER_GAIN_SILENT

    const p = runCrossfade({
      enabled: true,
      seconds: 2,
      swap: () => { throw new Error('load failed') },
    })
    await advance(1000)

    await expect(p).resolves.toBe('degraded')
    expect(getMasterGainValue()).toBe(MASTER_GAIN_FULL)
  })
})

describe('释放与设置项', () => {
  it('disposeAudioGraph 把输出增益复位到满值（避免停在淡出中途永久静音）', () => {
    ensureAudioGraph(fakeAudio(), { analyser: true })
    masterGainNode().gain.value = MASTER_GAIN_SILENT

    disposeAudioGraph()

    expect(getMasterGainValue()).toBe(MASTER_GAIN_FULL)
  })

  it('closeAudioGraph 后 masterGain 断开，取值回退满值', () => {
    ensureAudioGraph(fakeAudio(), { analyser: true })
    const master = masterGainNode()
    closeAudioGraph()

    expect(master.outputs).toEqual([])
    expect(getMasterGainValue()).toBe(MASTER_GAIN_FULL)
  })

  it('normalizeCrossfadeSeconds 钳制到 1~10 秒，非有限值回退 3', () => {
    expect(normalizeCrossfadeSeconds(5)).toBe(5)
    expect(normalizeCrossfadeSeconds(0)).toBe(CROSSFADE_MIN_SECONDS)
    expect(normalizeCrossfadeSeconds(-8)).toBe(CROSSFADE_MIN_SECONDS)
    expect(normalizeCrossfadeSeconds(99)).toBe(CROSSFADE_MAX_SECONDS)
    expect(normalizeCrossfadeSeconds(NaN)).toBe(3)
    expect(normalizeCrossfadeSeconds(Infinity)).toBe(CROSSFADE_MAX_SECONDS)
    expect(normalizeCrossfadeSeconds(undefined)).toBe(3)
    expect(normalizeCrossfadeSeconds('4')).toBe(4)
  })

  it('设置项默认值：淡入淡出关闭、时长 3 秒（升级用户听感零变化）', () => {
    expect(DEFAULT_APP_SETTINGS.crossfadeEnabled).toBe(false)
    expect(DEFAULT_APP_SETTINGS.crossfadeSeconds).toBe(3)
    // 老数据里没有这两个字段时，合并默认值兜底成「关闭 + 3 秒」
    const merged = loadAppSettings()
    expect(merged.crossfadeEnabled).toBe(false)
    expect(merged.crossfadeSeconds).toBe(3)
  })
})

/**
 * v1.4.9-pre2 音频可视化 / v1.4.15-pre1 均衡器：Web Audio 图的唯一持有者。
 *
 * 为什么需要这个模块（而不是在组件里直接 new AudioContext）：
 *
 * 1. `createMediaElementSource(audio)` 对同一个 <audio> 元素只能调用一次，第二次
 *    会抛 InvalidStateError。播放器的 audio 元素是长生命周期单例（PlayerContext
 *    只 new 一次），因此「源节点只建一次」的约束必须由一个模块级单例来兜住，
 *    否则开关反复切换就会把播放搞挂。
 *
 * 2. 元素一旦被 createMediaElementSource 接管，其声音就改由 AudioContext 的图
 *    输出，且**没有官方推荐的方式「解除接管」**。所以本模块刻意采用「一次接管、
 *    永久复用」的策略：只在真正需要可视化或均衡器时接管一次；之后即使两者都关闭，
 *    也只是把分析节点断开、把均衡器增益归零（零 CPU），播放链路上仍挂着这条已在
 *    工作的图。**绝不能在关闭时把 source 的输出全断掉**——元素已被接管，信号无处
 *    可去就是整条播放链路静音。
 *    （注：本图对音质/音量无影响——Chromium 实测 audio.volume/muted 在接管后
 *    依然生效，RMS 1.0/0.25/静音 分别为 0.43/0.11/0。）
 *
 * 3. 可视化与均衡器绝不参与「能不能播」的判断：AudioContext 构造失败、resume 失败、
 *    createMediaElementSource 抛错，一律静默降级为「无可视化 / 无均衡器」，返回 null。
 *
 * 4. 均衡器链的拓扑固定为 source → 十个 BiquadFilter → analyser → destination；
 *    分析节点缺席（可视化没开或建不出来）时，**链尾直接落到 ctx.destination**。
 *    这两条分支共用 wireChain，避免「只开均衡器」时因为链尾悬空而静音。
 *    旁路只把十个 gain 置 0，不做 disconnect/connect——重连会在切换瞬间产生可听见的断音。
 *
 * 降级与单测：模块不假设 AudioContext 一定存在（jsdom 下没有），所有入口在
 * 缺失时都安全返回 null，因此降级路径可被 tests/audioGraph.test.ts 直接覆盖；
 * 均衡器链的拓扑与增益行为由 tests/audioEqualizer.test.ts 用假 AudioContext 覆盖。
 */

import {
  EQ_BANDS,
  EQ_BAND_COUNT,
  bandQ,
  normalizeGains,
} from '@/services/equalizer'

/** 分析节点 FFT 窗口。2048 在「低频分辨率」与「每帧开销」之间取平衡。 */
export const ANALYSER_FFT_SIZE = 2048

/** 分析节点的平滑系数（0~1，越大越平滑）。0.8 让柱状跳动不抖。 */
export const ANALYSER_SMOOTHING = 0.8

/**
 * 分桶时丢弃的最高频比例。
 *
 * 音乐能量集中在低频，而频域数组的线性分桶会让最后 1/4 频点几乎恒为 0（16kHz 以上
 * 基本没有内容），整排柱子会集体塌成 0。丢掉尾部后每根柱子都有可见动态。
 */
export const SPECTRUM_USABLE_RATIO = 0.72

/** 均衡器旁路时写入的增益（全 0 = 直通）。模块级常量，避免每次旁路都新建数组。 */
const BYPASS_GAINS: readonly number[] = new Array<number>(EQ_BAND_COUNT).fill(0)

/** v1.4.15-pre2 输出增益的满值（1 = 不改变音量）。 */
export const MASTER_GAIN_FULL = 1

/** v1.4.15-pre2 输出增益的静音值。 */
export const MASTER_GAIN_SILENT = 0

/** 淡入淡出时长的合法范围（秒）。设置项在消费侧按此钳制。 */
export const CROSSFADE_MIN_SECONDS = 1
export const CROSSFADE_MAX_SECONDS = 10
/** 无法判断时的回退时长（秒），与 DEFAULT_APP_SETTINGS.crossfadeSeconds 一致。 */
export const DEFAULT_CROSSFADE_SECONDS = 3

/**
 * 把任意脏输入钳制成合法的淡入淡出时长（秒）。
 *
 * 非有限值（NaN / Infinity / undefined）回退默认 3 秒；越界钳到 1~10 秒。
 * 设置项从 localStorage 来，可能是任意脏数据，消费侧必须过这一道。
 */
export function normalizeCrossfadeSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  // NaN / 非数字：完全无法判断，回退默认 3 秒
  if (Number.isNaN(n)) return DEFAULT_CROSSFADE_SECONDS
  // ±Infinity 是明确的「越界」，按方向钳到边界而不是回退默认值
  if (n === Infinity) return CROSSFADE_MAX_SECONDS
  if (n === -Infinity) return CROSSFADE_MIN_SECONDS
  if (n <= CROSSFADE_MIN_SECONDS) return CROSSFADE_MIN_SECONDS
  if (n >= CROSSFADE_MAX_SECONDS) return CROSSFADE_MAX_SECONDS
  return n
}

interface AudioGraph {
  ctx: AudioContext
  source: MediaElementAudioSourceNode
  /** v1.4.15-pre2 输出增益节点（链尾，紧接 destination）；创建失败时为 null（无淡入淡出） */
  masterGain: GainNode | null
  /**
   * 输出增益的**目标值**（1 = 满值，0 = 静音）。
   * 渐变进行中记录的是终点；之所以单独存一份，是因为 AudioParam.value 在
   * 排定自动化之后不会立刻变成目标值（真实浏览器要等时间轴走到），
   * 直接读它会让「已经是目标值就别再写」这个判断失效。
   */
  masterGainValue: number
  /** 分析节点；创建失败时为 null（可视化降级，播放与均衡器照常） */
  analyser: AnalyserNode | null
  /** 十段均衡滤波器；创建失败时为空数组（整组丢弃，退回直通链路） */
  filters: BiquadFilterNode[]
  /** 期望的均衡曲线（dB）。旁路时滤波器 gain 写 0，但这份曲线保留以便重新启用 */
  eqGains: number[]
  /** 均衡器是否启用（false = 旁路） */
  eqEnabled: boolean
  /** 分析节点当前是否接在活路径上 */
  analyserActive: boolean
  /** 已接管的元素：用于识别「换了元素」，避免二次 createMediaElementSource 抛错 */
  element: HTMLAudioElement
}

let graph: AudioGraph | null = null
/** 已判定为「本环境不支持 Web Audio」时置位，避免每次播放都重试构造 */
let unavailable = false

/** ensureAudioGraph 的可选项。 */
export interface AudioGraphOptions {
  /**
   * 是否把分析节点接入活路径（即可视化是否开启）。默认 true，与既有行为一致。
   * 传 false 时链尾直接接 destination——均衡器单独工作也必须出声。
   */
  analyser?: boolean
}

/** 取 AudioContext 构造器（兼容 webkit 前缀的旧内核）；不存在返回 null 而非抛错。 */
function getAudioContextCtor(): typeof AudioContext | null {
  // 用 globalThis 而不是 window：jsdom 下 AudioContext 整个缺失，
  // 而 TS 的 Window 类型也未声明该属性，直接读 window.AudioContext 会编译不过。
  const g = globalThis as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return g.AudioContext ?? g.webkitAudioContext ?? null
}

/** 是否已接管音频元素（建过图）。供 UI 判断有无分析节点时请用 getAnalyser。 */
export function isAudioGraphReady(): boolean {
  return graph !== null
}

/**
 * 建十个 BiquadFilter（peaking，频率/Q 取自 services/equalizer 的频段定义）。
 *
 * 任何一步失败就整组丢弃并返回空数组：只建出半个链会改变频响，
 * 而「没有均衡器」是安全且听得出来的降级。
 */
/**
 * 建输出增益节点（淡入淡出用），失败返回 null。
 *
 * 增益初值必须是 1：节点常驻链路，初值不是 1 就等于凭空改了音量。
 */
function createMasterGain(ctx: AudioContext): GainNode | null {
  try {
    const gain = ctx.createGain()
    gain.gain.value = MASTER_GAIN_FULL
    return gain
  } catch (e) {
    console.warn('[audioGraph] 创建输出增益节点失败，淡入淡出已禁用：', e)
    return null
  }
}

function createEqualizerFilters(ctx: AudioContext): BiquadFilterNode[] {
  const filters: BiquadFilterNode[] = []
  try {
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
      const filter = ctx.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = EQ_BANDS[i]
      filter.Q.value = bandQ(i)
      // 初值全 0 = 直通：均衡器还没被显式启用前，链路的频响必须与无均衡器一致
      filter.gain.value = 0
      filters.push(filter)
    }
  } catch (e) {
    console.warn('[audioGraph] 创建均衡滤波器失败，均衡器已禁用：', e)
    return []
  }
  return filters
}

/**
 * 按「分析节点是否启用」把整条主链路重接一遍。
 *
 * 链序：source → filters[0..9] → (analyser) → destination。
 * 只在「建图」与「可视化开/关」时调用，**增益更新绝不走这里**——
 * 断开重连会在切换瞬间产生可听见的断音。
 */
function wireChain(g: AudioGraph, analyserActive: boolean): void {
  const { ctx, source, filters, analyser, masterGain } = g

  // 重接前先断干净：同一条边连两次会让信号翻倍
  try { source.disconnect() } catch { /* 已断开 */ }
  for (const filter of filters) {
    try { filter.disconnect() } catch { /* 已断开 */ }
  }
  if (analyser) {
    try { analyser.disconnect() } catch { /* 已断开 */ }
  }
  if (masterGain) {
    try { masterGain.disconnect() } catch { /* 已断开 */ }
  }

  let node: AudioNode = source
  for (const filter of filters) {
    node.connect(filter)
    node = filter
  }

  const useAnalyser = analyser !== null && analyserActive
  if (useAnalyser) {
    node.connect(analyser)
    node = analyser
  }

  // 链尾统一落到 masterGain → destination。
  // 淡入淡出只靠这个节点，而「分析节点是否在活路径上」是两条不同分支，
  // 任何一条绕过 masterGain 都会让兜底路径失去淡入淡出能力（甚至静音）。
  // 建不出增益节点时才退回直连 destination——元素已被接管，链尾悬空 = 整条链路静音。
  if (masterGain) {
    node.connect(masterGain)
    masterGain.connect(ctx.destination)
    g.analyserActive = useAnalyser
    return
  }

  node.connect(ctx.destination)
  g.analyserActive = useAnalyser
}

/**
 * 把当前曲线写进十个滤波器。
 *
 * 旁路不拆节点，只把 gain 全置 0（见文件头第 4 条）：节点常驻、只改 AudioParam，
 * 所以启用/关闭、拖柱子都不会产生断音。
 */
function applyGains(g: AudioGraph): void {
  const gains = g.eqEnabled ? g.eqGains : BYPASS_GAINS
  for (let i = 0; i < g.filters.length; i++) {
    const value = gains[i] ?? 0
    try {
      g.filters[i].gain.value = value
    } catch { /* 节点已失效：忽略，不影响播放 */ }
  }
}

/**
 * 建立（或复用）audio 元素的 Web Audio 图。
 *
 * - 同一元素重复调用：直接复用，不会二次 createMediaElementSource；
 *   仅当「分析节点是否在活路径上」与本次请求不一致时才重接线。
 * - 换了元素（理论上不会发生）：先彻底释放旧图再接管新元素。
 * - 任何一步失败：返回 null 并记住「不可用」，调用方按「无可视化/无均衡器」继续播放。
 */
export function ensureAudioGraph(
  audio: HTMLAudioElement | null | undefined,
  options?: AudioGraphOptions,
): AudioContext | null {
  const wantAnalyser = options?.analyser !== false
  if (!audio || unavailable) return graph?.ctx ?? null
  if (graph) {
    // 正常情况下元素是同一个，直接复用；仅当元素被替换时才重建
    if (graph.element === audio) {
      const effectiveAnalyser = wantAnalyser && graph.analyser !== null
      if (graph.analyserActive !== effectiveAnalyser) wireChain(graph, wantAnalyser)
      void resumeAudioGraph()
      return graph.ctx
    }
    closeAudioGraph()
  }

  const Ctor = getAudioContextCtor()
  if (!Ctor) {
    unavailable = true
    return null
  }

  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch (e) {
    // 没有音频设备 / 上下文数量超限等：静默降级
    console.warn('[audioGraph] AudioContext 创建失败，可视化与均衡器已禁用：', e)
    unavailable = true
    return null
  }

  let source: MediaElementAudioSourceNode
  try {
    source = ctx.createMediaElementSource(audio)
  } catch (e) {
    // InvalidStateError（该元素已被其他 context 接管）等：不能影响播放
    console.warn('[audioGraph] 接管音频元素失败，可视化与均衡器已禁用：', e)
    void ctx.close().catch(() => { /* 关闭失败无需处理 */ })
    unavailable = true
    return null
  }

  // 分析节点与滤波器都是可选件：建不出来只损失对应能力，播放不能受影响
  let analyser: AnalyserNode | null = null
  try {
    analyser = ctx.createAnalyser()
    analyser.fftSize = ANALYSER_FFT_SIZE
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING
  } catch (e) {
    console.warn('[audioGraph] 创建分析节点失败，可视化已禁用：', e)
    analyser = null
  }

  const next: AudioGraph = {
    ctx,
    source,
    analyser,
    masterGain: createMasterGain(ctx),
    masterGainValue: MASTER_GAIN_FULL,
    filters: createEqualizerFilters(ctx),
    eqGains: normalizeGains([]),
    eqEnabled: false,
    analyserActive: false,
    element: audio,
  }
  graph = next

  // 源节点一旦创建就已经把元素的声音改道到本 context，因此链路必须立刻接通，
  // 否则会「没声音」。wireChain 保证链尾一定落在 destination（或 analyser → destination）。
  wireChain(next, wantAnalyser)
  void resumeAudioGraph()
  return ctx
}

/**
 * 恢复处于 suspended 的 AudioContext。
 * 浏览器自动播放策略可能让新建 context 处于 suspended，此时 analyser 拿不到数据；
 * resume() 失败（例如没有用户手势）只影响可视化，不影响播放，故静默吞掉。
 */
export function resumeAudioGraph(): Promise<void> {
  const ctx = graph?.ctx
  if (!ctx || ctx.state !== 'suspended') return Promise.resolve()
  return ctx.resume().catch(() => { /* 无可视化但播放照常 */ })
}

/**
 * 取分析节点；尚未建图或可视化未开启（分析节点不在活路径上）时返回 null
 * （可视化组件据此渲染占位）。
 * 调用方应直接编译期引用本函数（而不是包一层动态 import），
 * 以保证 Vite/Rollup 能正确做静态分析（动态引用会被拆包或报错）。
 */
export function getAnalyser(): AnalyserNode | null {
  if (!graph || !graph.analyserActive) return null
  return graph.analyser
}

/**
 * 取均衡滤波器（返回副本，调用方拿不到内部数组）。
 * 尚未建图或滤波器创建失败时返回空数组。供测试与调试断言「节点是否被复用」。
 */
export function getEqualizerFilters(): BiquadFilterNode[] {
  return graph ? [...graph.filters] : []
}

/**
 * 按增益数组更新十个滤波器（不重建节点）。
 *
 * 入参可以是任意脏数据：内部走 normalizeGains 归一成合法的十段增益
 * （长度补齐/截断、越界钳制到 ±12dB、非有限值按 0）。均衡器处于旁路时只记下曲线，
 * 等启用时再套用。未建图时是空操作——调用方无需先判断。
 */
export function setEqualizerGains(gains: unknown): void {
  if (!graph) return
  graph.eqGains = normalizeGains(gains)
  applyGains(graph)
}

/**
 * 启用/旁路均衡器。
 *
 * 旁路 = 把十个滤波器 gain 全置 0，**不做 disconnect/connect**：
 * 重连期间会有可听见的断音，而改 AudioParam 是无缝的。
 */
export function setEqualizerEnabled(enabled: boolean): void {
  if (!graph) return
  graph.eqEnabled = Boolean(enabled)
  applyGains(graph)
}

// ===== v1.4.15-pre2 淡入淡出切歌 =====
//
// 只改 masterGain.gain 这个 AudioParam，不重连任何节点：重连会在切换瞬间断音。
// 渐变一律用 setValueAtTime(当前值) + linearRampToValueAtTime(目标值)：
// - 先写当前值，是从「渐变中途」再次发起时曲线连续的保证（不会从旧起点跳变）；
// - 用 linear 而非 exponential：exponential 的终点不能是 0，而淡出必须能到 0。

/** 把 AudioParam 的当前值钳到合法范围，供渐变起点使用。 */
function currentGainValue(param: AudioParam): number {
  const v = param.value
  return Number.isFinite(v) ? v : MASTER_GAIN_FULL
}

/** 取消该参数上已排定的自动化事件（作废旧渐变）。 */
function cancelScheduled(param: AudioParam, when: number): void {
  try {
    param.cancelScheduledValues(when)
  } catch { /* 老实现没有该方法：忽略，后面的 setValueAtTime 仍会覆盖 */ }
}

/**
 * 立刻把输出增益设为指定值（不做渐变）。
 *
 * 已是目标值时**完全不碰 AudioParam**：淡入淡出关闭的路径走这里，
 * 必须保证「关闭时一次自动化调用都不产生」，否则就不再是零延迟硬切。
 */
function setMasterGainValue(g: AudioGraph, value: number): void {
  const node = g.masterGain
  if (!node) return
  try {
    const param = node.gain
    // 目标值一致就完全不碰 AudioParam（关闭淡入淡出的路径必须零自动化调用）
    if (g.masterGainValue === value && param.value === value) return
    const now = g.ctx.currentTime
    const safeNow = Number.isFinite(now) ? now : 0
    cancelScheduled(param, safeNow)
    param.setValueAtTime(value, safeNow)
    param.value = value
    g.masterGainValue = value
  } catch { /* 节点已失效：忽略，不影响播放 */ }
}

/** 复位输出增益到满值（切歌取消、释放、降级时用）。 */
function resetMasterGain(g: AudioGraph): void {
  setMasterGainValue(g, MASTER_GAIN_FULL)
}

/**
 * 在 seconds 秒内把输出增益从**当前值**线性渐变到 target。
 *
 * 返回 false 表示没有可用的增益节点（未建图 / 建节点失败），调用方应直接硬切。
 * 任何一步抛错都被吞掉：淡入淡出是锦上添花，绝不能让它把播放搞挂。
 */
export function fadeMasterGain(target: number, seconds: number): boolean {
  const g = graph
  if (!g || !g.masterGain) return false
  const dur = normalizeCrossfadeSeconds(seconds)
  try {
    const param = g.masterGain.gain
    const now = g.ctx.currentTime
    const safeNow = Number.isFinite(now) ? now : 0
    cancelScheduled(param, safeNow)
    // 起点写当前值：从渐变中途再次发起时曲线保持连续
    param.setValueAtTime(currentGainValue(param), safeNow)
    param.linearRampToValueAtTime(target, safeNow + dur)
    g.masterGainValue = target
    return true
  } catch (e) {
    console.warn('[audioGraph] 输出增益渐变失败，本次改用硬切：', e)
    return false
  }
}

/** 切歌编排的结果。 */
export type CrossfadeOutcome =
  /** 完成了淡出 → 切换 → 淡入 */
  | 'crossfaded'
  /** 未启用淡入淡出（或无可用音频图）：零延迟硬切，没有产生任何渐变 */
  | 'immediate'
  /** 期间又切了别的歌：本次作废，不执行切换 */
  | 'superseded'
  /** 渐变过程中出错：已退回硬切，播放不受影响 */
  | 'degraded'

/** 本次切歌的序号。每次 runCrossfade 递增，旧任务据此发现自己已过期。 */
let crossfadeSeq = 0

/** runCrossfade 的参数。 */
export interface CrossfadeOptions {
  /** 是否启用淡入淡出。false 时同步立刻执行 swap，行为与未实现本功能时完全一致 */
  enabled: boolean
  /** 总时长（秒），淡出与淡入各占一半；越界由 normalizeCrossfadeSeconds 钳制 */
  seconds: number
  /** 真正的换曲动作（换 src + 起播） */
  swap: () => void | Promise<void>
}

function delay(ms: number): Promise<void> {
  const wait = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (wait === 0) return Promise.resolve()
  return new Promise<void>((resolve) => { setTimeout(resolve, wait) })
}

/**
 * 淡入淡出切歌：先淡出（总时长的一半）→ 执行 swap 换新曲 → 淡入（另一半）。
 *
 * 关键约束：
 * - 关闭 / 无音频图 / 建不出增益节点 → 直接 swap，**不做任何渐变调用**，零延迟；
 * - 期间又发起了一次切歌（seq 变化）→ 本次立刻作废，不执行 swap、不淡入，
 *   增益交给最新那次接管（新一次从当前值起渐变，不会跳变）；
 * - swap 抛错或渐变抛错 → 复位增益并确保 swap 至少执行一次，返回 degraded。
 *
 * 本函数不抛错。
 */
export async function runCrossfade(options: CrossfadeOptions): Promise<CrossfadeOutcome> {
  const seq = ++crossfadeSeq
  const { enabled, seconds, swap } = options
  const g = graph

  // 关闭或没有可用音频图：与既有行为完全一致——零延迟硬切。
  // 这里刻意不调用任何渐变 API（连 setValueAtTime 都只在增益不等于满值时才写）。
  if (!enabled || !g || !g.masterGain) {
    resetMasterGainIfAny(g)
    await swap()
    return 'immediate'
  }

  const half = normalizeCrossfadeSeconds(seconds) / 2
  let swapped = false

  try {
    if (!fadeMasterGain(MASTER_GAIN_SILENT, half)) {
      // 渐变起不来（参数异常）：退回硬切
      await swap()
      return 'degraded'
    }
    await delay(half * 1000)
    if (seq !== crossfadeSeq) return 'superseded'

    await swap()
    swapped = true
    if (seq !== crossfadeSeq) return 'superseded'

    fadeMasterGain(MASTER_GAIN_FULL, half)
    return 'crossfaded'
  } catch (e) {
    console.warn('[audioGraph] 淡入淡出切歌失败，已退回普通播放：', e)
    if (seq === crossfadeSeq) {
      resetMasterGainIfAny(graph)
      if (!swapped) {
        try { await swap() } catch { /* 已尽力，交给上层处理 */ }
      }
    }
    return 'degraded'
  }
}

/** 取当前输出增益值；无图时返回满值。供调试与测试断言。 */
export function getMasterGainValue(): number {
  return graph ? graph.masterGainValue : MASTER_GAIN_FULL
}

/** 放弃进行中的渐变并把增益复位到满值（不换曲）。 */
export function cancelCrossfade(): void {
  crossfadeSeq += 1
  resetMasterGainIfAny(graph)
}

/** 内部小工具：graph 可能为 null，统一在这里兜住。 */
function resetMasterGainIfAny(g: AudioGraph | null): void {
  if (g) resetMasterGain(g)
}

/**
 * 释放分析分支并旁路均衡器，但**保留**已接管的主链路。
 *
 * 注意：不关闭 AudioContext、不断开 source→destination 这条主链路。
 * 原因见文件头第 2 条——元素一旦被接管就无法干净地交还给浏览器默认输出，
 * 把链路断掉只会让播放彻底没声音。这里做两件事：
 * 1) 均衡器归零，听感回到直通；
 * 2) 分析节点摘出活路径，链尾直接接 destination（rAF 停止后本图零开销）。
 */
export function disposeAudioGraph(): void {
  if (!graph) return
  graph.eqEnabled = false
  applyGains(graph)
  // 输出增益必须复位：若恰好停在淡出中途（增益 0），保留链路就等于永久静音
  resetMasterGain(graph)
  // 只有分析节点确实还挂在活路径上时才重接线：无谓的断开重连会在切换瞬间产生断音
  if (graph.analyserActive) wireChain(graph, false)
}

/** 关闭 AudioContext 并彻底释放（仅在卸载播放器时调用）。 */
export function closeAudioGraph(): void {
  const g = graph
  graph = null
  if (!g) return
  try { g.source.disconnect() } catch { /* 已断开 */ }
  for (const filter of g.filters) {
    try { filter.disconnect() } catch { /* 已断开 */ }
  }
  if (g.analyser) {
    try { g.analyser.disconnect() } catch { /* 已断开 */ }
  }
  if (g.masterGain) {
    try { g.masterGain.disconnect() } catch { /* 已断开 */ }
  }
  void g.ctx.close().catch(() => { /* 已关闭 */ })
}

/**
 * 把频域数据分桶成柱高（纯函数，便于单测）。
 *
 * - 返回长度为 barCount 的数组，每项归一化到 0..1；
 * - 空输入或非法 barCount 时返回全 0（不得出现 NaN / Infinity）；
 * - 分桶取每段最大值而非平均值：柱状图用峰值更贴近听感，也不会因为
 *   某段里几个接近 0 的频点把整根柱子拉平。
 *
 * @param freqData analyser.getByteFrequencyData 得到的 0..255 频域数据
 * @param barCount 期望柱子数量（非法值按 1 兜底）
 */
export function computeBars(freqData: ArrayLike<number>, barCount: number): number[] {
  const count = Number.isFinite(barCount) ? Math.max(1, Math.floor(barCount)) : 1
  const bars = new Array<number>(count).fill(0)

  const len = freqData ? freqData.length : 0
  if (!len) return bars

  // 只用有实际内容的低频段，避免高频恒定静音把柱高整体拉塌
  const usable = Math.max(1, Math.floor(len * SPECTRUM_USABLE_RATIO))

  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * usable) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * usable) / count))

    let peak = 0
    for (let j = start; j < end && j < len; j++) {
      const v = freqData[j]
      // 非有限值（脏数据）当 0 处理，杜绝 NaN 传染整根柱子
      if (Number.isFinite(v) && v > peak) peak = v
    }

    const normalized = peak / 255
    bars[i] = normalized > 1 ? 1 : normalized
  }

  return bars
}

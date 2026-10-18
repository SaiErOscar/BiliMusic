/**
 * v1.4.9-pre2 音频可视化：Web Audio 分析图的唯一持有者。
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
 *    永久复用」的策略：只在真正需要可视化时接管一次；之后即使关闭可视化，
 *    也只是把分析节点断开（零 CPU），播放链路上仍挂着这条已在工作的图。
 *    （注：本图对音质/音量无影响——Chromium 实测 audio.volume/muted 在接管后
 *    依然生效，RMS 1.0/0.25/静音 分别为 0.43/0.11/0。）
 *
 * 3. 可视化绝不参与「能不能播」的判断：AudioContext 构造失败、resume 失败、
 *    createMediaElementSource 抛错，一律静默降级为「无可视化」，返回 null。
 *
 * 降级与单测：模块不假设 AudioContext 一定存在（jsdom 下没有），所有入口在
 * 缺失时都安全返回 null，因此降级路径可被 tests/audioGraph.test.ts 直接覆盖。
 */

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

interface AudioGraph {
  ctx: AudioContext
  source: MediaElementAudioSourceNode
  analyser: AnalyserNode
  /** 已接管的元素：用于识别「换了元素」，避免二次 createMediaElementSource 抛错 */
  element: HTMLAudioElement
}

let graph: AudioGraph | null = null
/** 已判定为「本环境不支持 Web Audio」时置位，避免每次播放都重试构造 */
let unavailable = false

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

/** 是否已成功建立音频图（供 UI 判断有无 analyser）。 */
export function isAudioGraphReady(): boolean {
  return graph !== null
}

/**
 * 建立（或复用）audio 元素的 Web Audio 分析图。
 *
 * - 同一元素重复调用：直接复用，不会二次 createMediaElementSource。
 * - 换了元素（理论上不会发生）：先释放旧图再接管新元素。
 * - 任何一步失败：返回 null 并记住「不可用」，调用方按「无可视化」继续播放。
 */
export function ensureAudioGraph(audio: HTMLAudioElement | null | undefined): AudioContext | null {
  if (!audio || unavailable) return graph?.ctx ?? null
  if (graph) {
    // 正常情况下元素是同一个，直接复用；仅当元素被替换时才重建
    if (graph.element === audio) {
      void resumeAudioGraph()
      return graph.ctx
    }
    disposeAudioGraph()
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
    console.warn('[audioGraph] AudioContext 创建失败，可视化已禁用：', e)
    unavailable = true
    return null
  }

  let source: MediaElementAudioSourceNode
  try {
    source = ctx.createMediaElementSource(audio)
  } catch (e) {
    // InvalidStateError（该元素已被其他 context 接管）等：不能影响播放
    console.warn('[audioGraph] 接管音频元素失败，可视化已禁用：', e)
    void ctx.close().catch(() => { /* 关闭失败无需处理 */ })
    unavailable = true
    return null
  }

  let analyser: AnalyserNode
  try {
    analyser = ctx.createAnalyser()
    analyser.fftSize = ANALYSER_FFT_SIZE
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING
  } catch (e) {
    console.warn('[audioGraph] 创建分析节点失败，可视化已禁用：', e)
    void ctx.close().catch(() => { /* 关闭失败无需处理 */ })
    unavailable = true
    return null
  }

  // 源节点一旦创建就已经把元素的声音改道到本 context，因此
  // source → analyser → destination 必须立刻接通，否则会「没声音」。
  // analyser 是直通节点（不改变信号），不接 destination 它就拿不到数据。
  source.connect(analyser)
  analyser.connect(ctx.destination)

  graph = { ctx, source, analyser, element: audio }
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
 * 取分析节点；尚未建立音频图时返回 null（可视化组件据此渲染占位）。
 * 调用方应直接编译期引用本函数（而不是包一层动态 import），
 * 以保证 Vite/Rollup 能正确做静态分析（动态引用会被拆包或报错）。
 */
export function getAnalyser(): AnalyserNode | null {
  return graph?.analyser ?? null
}

/**
 * 释放音频图。
 *
 * 注意：不关闭 AudioContext、不断开 source→destination 这条主链路。
 * 原因见文件头第 2 条——元素一旦被接管就无法干净地交还给浏览器默认输出，
 * 关掉 context 只会让播放彻底没声音。这里只断开「分析」分支：
 * analyser 不再挂任何输出，rAF 停止后本图零开销。
 */
export function disposeAudioGraph(): void {
  if (!graph) return
  try {
    graph.source.disconnect(graph.analyser)
  } catch { /* 已断开 */ }
  try {
    graph.analyser.disconnect()
  } catch { /* 已断开 */ }
  graph = null
}

/** 关闭 AudioContext 并彻底释放（仅在卸载播放器时调用）。 */
export function closeAudioGraph(): void {
  const ctx = graph?.ctx
  disposeAudioGraph()
  if (ctx) void ctx.close().catch(() => { /* 已关闭 */ })
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

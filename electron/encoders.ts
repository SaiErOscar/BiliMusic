/**
 * v1.4.7-pre2 硬编候选选择：按 GPU 厂商预判过滤/排序编码器候选。
 *
 * 背景（pre1 现状）：候选顺序固定 NVENC→QSV→AMF→libx264，厂商不符的机器每次导出
 * 都要白跑失败候选——Intel 核显机器先烧一遍 NVENC，macOS 上 NVENC/QSV/AMF 全是死路
 * （三次失败才落 libx264）。本模块用 Electron app.getGPUInfo 拿厂商，只保留在场厂商
 * 的编码器并按 N 卡→A 卡→Intel→Apple 排序，libx264 恒为保底。
 *
 * 「真实任务即探测」原则不变：预判只决定候选集合与顺序，真实合成失败仍回退下一候选。
 * 纯函数 orderEncodersFor 不依赖 electron，可单测；GPU 探测懒加载 electron。
 */

export interface EncoderCandidate {
  codec: string
  /** 编码质量参数（追加在 -c:v 之后） */
  qualityArgs: string[]
}

/** 各厂商硬编候选（libx264 兜底由 orderEncodersFor 统一追加） */
export const ENCODERS_BY_VENDOR: Record<string, EncoderCandidate> = {
  nvidia: { codec: 'h264_nvenc', qualityArgs: ['-preset', 'p4', '-cq', '23'] },
  amd: { codec: 'h264_amf', qualityArgs: ['-quality', 'balanced'] },
  intel: { codec: 'h264_qsv', qualityArgs: ['-global_quality', '23'] },
  apple: { codec: 'h264_videotoolbox', qualityArgs: ['-b:v', '5M'] },
}
const CPU_FALLBACK: EncoderCandidate = { codec: 'libx264', qualityArgs: ['-preset', 'veryfast', '-crf', '20'] }

/** 厂商优先级：独显在前（NVENC/AMF 常在独显上，QSV 在核显上，混合机器两类都可试） */
const VENDOR_PRIORITY = ['nvidia', 'amd', 'intel', 'apple']

/**
 * 按 GPU 厂商列表排出候选顺序。vendors 为机器上实际在场厂商（vendorId 识别）。
 * - 已知厂商：在场厂商的硬编器按优先级排列 + libx264 保底（厂商不符的白跑候选全部消除）
 * - 未知（探测失败/未识别）：win/linux 维持 pre1 四候选原序；darwin 直接
 *   videotoolbox 领头（NVENC/QSV/AMF 在 mac 上必死，无需白跑）
 */
export function orderEncodersFor(vendors: string[], platform: string): EncoderCandidate[] {
  const known = VENDOR_PRIORITY.filter((v) => vendors.includes(v))
  if (!known.length) {
    if (platform === 'darwin') return [ENCODERS_BY_VENDOR.apple, CPU_FALLBACK]
    return [ENCODERS_BY_VENDOR.nvidia, ENCODERS_BY_VENDOR.intel, ENCODERS_BY_VENDOR.amd, CPU_FALLBACK]
  }
  const list = known.map((v) => ENCODERS_BY_VENDOR[v])
  list.push(CPU_FALLBACK)
  return list
}

/** PCI vendorId → 厂商名（0x10DE NVIDIA / 0x8086 Intel / 0x1002·0x1022 AMD / 0x106B Apple） */
export function vendorFromId(id: number): string | null {
  const v = id & 0xffff
  if (v === 0x10de) return 'nvidia'
  if (v === 0x8086) return 'intel'
  if (v === 0x1002 || v === 0x1022) return 'amd'
  if (v === 0x106b) return 'apple'
  return null
}

/** 探测机器 GPU 厂商集合；失败返回空数组（回退平台默认候选） */
export async function detectGpuVendors(): Promise<string[]> {
  try {
    // 懒加载：模块本身不 import electron，vitest 可直接测纯函数
    const { app } = await import('electron')
    const info = (await app.getGPUInfo('basic')) as {
      gpuDevice?: { vendorId?: number; deviceString?: string; driverVendor?: string }[]
    }
    const vendors = new Set<string>()
    for (const dev of info.gpuDevice || []) {
      const byId = typeof dev.vendorId === 'number' ? vendorFromId(dev.vendorId) : null
      if (byId) { vendors.add(byId); continue }
      // vendorId 缺失时按字符串兜底识别
      const s = `${dev.deviceString || ''} ${dev.driverVendor || ''}`.toLowerCase()
      if (/nvidia|geforce|quadro/.test(s)) vendors.add('nvidia')
      else if (/intel/.test(s)) vendors.add('intel')
      else if (/amd|radeon|ati/.test(s)) vendors.add('amd')
      else if (/apple/.test(s)) vendors.add('apple')
    }
    return [...vendors]
  } catch {
    return []
  }
}

/** 组合入口：探测 + 排序（每次导出调一次） */
export async function resolveEncoderCandidates(platform: string): Promise<EncoderCandidate[]> {
  return orderEncodersFor(await detectGpuVendors(), platform)
}

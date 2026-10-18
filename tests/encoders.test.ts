import { describe, expect, it } from 'vitest'
import { classifyFfmpegFailure, orderEncodersFor, vendorFromId } from '../electron/encoders'

/**
 * v1.4.7-pre2 硬编候选厂商预判：纯函数排序逻辑。
 * 目标——厂商不符的白跑候选消除（Intel 机器不再先烧 NVENC、macOS 不再连试
 * NVENC/QSV/AMF 三次死路），libx264 恒保底，探测失败回退平台默认序。
 */
describe('vendorFromId（PCI vendorId 识别）', () => {
  it('主流厂商', () => {
    expect(vendorFromId(0x10de)).toBe('nvidia')
    expect(vendorFromId(0x8086)).toBe('intel')
    expect(vendorFromId(0x1002)).toBe('amd')
    expect(vendorFromId(0x1022)).toBe('amd')
    expect(vendorFromId(0x106b)).toBe('apple')
  })

  it('未知 id 与高位脏位', () => {
    expect(vendorFromId(0x1234)).toBeNull()
    expect(vendorFromId(0xabcd8086)).toBe('intel')
    expect(vendorFromId(Number.NaN)).toBeNull()
  })
})

describe('orderEncodersFor（候选排序）', () => {
  it('Intel 核显：直达 QSV，不再白跑 NVENC/AMF', () => {
    const list = orderEncodersFor(['intel'], 'win32')
    expect(list.map((c) => c.codec)).toEqual(['h264_qsv', 'libx264'])
  })

  it('NVIDIA：NVENC 领头，无核显则不试 QSV', () => {
    const list = orderEncodersFor(['nvidia'], 'win32')
    expect(list.map((c) => c.codec)).toEqual(['h264_nvenc', 'libx264'])
  })

  it('混合机器（独显+核显）：按独显优先两级硬编都在场', () => {
    const list = orderEncodersFor(['nvidia', 'intel'], 'win32')
    expect(list.map((c) => c.codec)).toEqual(['h264_nvenc', 'h264_qsv', 'libx264'])
  })

  it('AMD：AMF 领头', () => {
    const list = orderEncodersFor(['amd'], 'win32')
    expect(list.map((c) => c.codec)).toEqual(['h264_amf', 'libx264'])
  })

  it('Apple（darwin）：直达 videotoolbox', () => {
    const list = orderEncodersFor(['apple'], 'darwin')
    expect(list.map((c) => c.codec)).toEqual(['h264_videotoolbox', 'libx264'])
  })

  it('探测失败回退平台默认：darwin 仍 videotoolbox 领头（NVENC/QSV/AMF 在 mac 必死）', () => {
    const list = orderEncodersFor([], 'darwin')
    expect(list.map((c) => c.codec)).toEqual(['h264_videotoolbox', 'libx264'])
  })

  it('探测失败回退平台默认：win 维持 pre1 四候选原序', () => {
    const list = orderEncodersFor([], 'win32')
    expect(list.map((c) => c.codec)).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'])
  })
})

/**
 * v1.4.8-pre5：失败归类决定「是否拉黑编码器」。
 * 目标——磁盘满、权限、缺音频流等输入输出侧失败不得写进会话级黑名单，
 * 否则一次误判会让本次进程内所有 MV 导出不可用。
 */
describe('classifyFfmpegFailure（失败归类）', () => {
  it('输入输出侧不可恢复 → fatal', () => {
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): av_interleaved_write_frame(): No space left on device')).toBe('fatal')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Error opening output file: Permission denied')).toBe('fatal')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Stream map \'1:a\' matches no streams.')).toBe('fatal')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Invalid data found when processing input')).toBe('fatal')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): could not find codec parameters for stream')).toBe('fatal')
  })

  it('编码器自身不可用 → encoder', () => {
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Error while opening encoder for output stream #0:0')).toBe('encoder')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Error initializing output stream 0:0 -- device failed (-17)')).toBe('encoder')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Cannot load nvcuda.dll')).toBe('encoder')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Unknown encoder \'h264_qsv\'')).toBe('encoder')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): No capable devices found')).toBe('encoder')
    expect(classifyFfmpegFailure('Error: write EPIPE')).toBe('encoder')
  })

  it('无法归类 → unknown（回退但不拉黑）', () => {
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): Conversion failed!')).toBe('unknown')
    expect(classifyFfmpegFailure('ffmpeg 失败 (exit 1): 未知错误')).toBe('unknown')
    expect(classifyFfmpegFailure('')).toBe('unknown')
  })

  it('fatal 优先于 encoder：磁盘满时即便同段出现 encoder 字样也不拉黑', () => {
    expect(classifyFfmpegFailure('Error while opening encoder: No space left on device')).toBe('fatal')
  })
})

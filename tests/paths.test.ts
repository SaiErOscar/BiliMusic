import { describe, expect, it } from 'vitest'
import { pathBasename, pathDirname, joinPath } from '../src/utils/paths'

/**
 * v1.4.7-pre1 修复4：平台感知路径工具。
 * 渲染层此前硬编码 '\'（batchDownloadStore 的 mvDir、Downloads 的 joinPath），
 * mac/Linux 上产出错误路径；这里把两种分隔符都视为分隔符。
 */
describe('pathBasename（双分隔符）', () => {
  it('Windows 风格反斜杠', () => {
    expect(pathBasename('I:\\Music\\MV\\歌名.mp4')).toBe('歌名.mp4')
  })

  it('POSIX 风格正斜杠', () => {
    expect(pathBasename('/Users/sai/Music/MV/歌名.mp4')).toBe('歌名.mp4')
  })

  it('混合分隔符（真实场景：mac 上拼接出的路径）', () => {
    expect(pathBasename('/Users/sai/Music/MV\\歌名.mp4')).toBe('歌名.mp4')
  })

  it('尾部带分隔符', () => {
    expect(pathBasename('I:\\Music\\MV\\')).toBe('MV')
  })

  it('无分隔符时整体返回', () => {
    expect(pathBasename('歌名.mp4')).toBe('歌名.mp4')
  })
})

describe('pathDirname（双分隔符）', () => {
  it('Windows 风格', () => {
    expect(pathDirname('I:\\Music\\MV\\歌名.mp4')).toBe('I:\\Music\\MV')
  })

  it('POSIX 风格', () => {
    expect(pathDirname('/Users/sai/Music/MV/歌名.mp4')).toBe('/Users/sai/Music/MV')
  })

  it('混合分隔符', () => {
    expect(pathDirname('I:/Music/MV\\歌名.mp4')).toBe('I:/Music/MV')
  })

  it('根目录保留前缀分隔符', () => {
    expect(pathDirname('/a.mp4')).toBe('/')
    expect(pathDirname('C:\\a.mp4')).toBe('C:')
  })

  it('无目录时返回空串', () => {
    expect(pathDirname('a.mp4')).toBe('')
  })
})

describe('joinPath（分隔符可指定）', () => {
  it('按传入分隔符拼接', () => {
    expect(joinPath('I:\\Music\\MV', 'a.mp4', '\\')).toBe('I:\\Music\\MV\\a.mp4')
    expect(joinPath('/Users/sai/MV', 'a.mp4', '/')).toBe('/Users/sai/MV/a.mp4')
  })

  it('目录已有尾分隔符不重复', () => {
    expect(joinPath('I:\\Music\\MV\\', 'a.mp4', '\\')).toBe('I:\\Music\\MV\\a.mp4')
  })

  it('目录为空直接返回文件名', () => {
    expect(joinPath('', 'a.mp4', '\\')).toBe('a.mp4')
  })
})

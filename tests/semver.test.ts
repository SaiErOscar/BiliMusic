import { describe, it, expect } from 'vitest'
import { semverGt } from '../src/utils/semver'

describe('semverGt', () => {
  it('基础版本比较', () => {
    expect(semverGt('1.2.5', '1.2.4')).toBe(true)
    expect(semverGt('1.2.4', '1.2.5')).toBe(false)
  })

  it('不同次版本号', () => {
    expect(semverGt('1.3.0', '1.2.9')).toBe(true)
    expect(semverGt('1.2.9', '1.3.0')).toBe(false)
  })

  it('不同主版本号', () => {
    expect(semverGt('2.0.0', '1.9.9')).toBe(true)
    expect(semverGt('1.9.9', '2.0.0')).toBe(false)
  })

  it('相同版本返回false', () => {
    expect(semverGt('1.2.3', '1.2.3')).toBe(false)
  })

  it('忽略后缀', () => {
    expect(semverGt('1.2.5-alpha', '1.2.4')).toBe(true)
    expect(semverGt('1.2.4-beta', '1.2.5')).toBe(false)
  })

  it('处理缺失的版本段', () => {
    expect(semverGt('1.2', '1.1')).toBe(true)
    expect(semverGt('1', '0')).toBe(true)
  })
})

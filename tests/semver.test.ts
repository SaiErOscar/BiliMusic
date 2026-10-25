import { describe, it, expect } from 'vitest'
import { semverCompare, semverGt } from '../src/utils/semver'

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

  it('主体不同时，预发布后缀不改变主体大小的判定', () => {
    expect(semverGt('1.2.5-alpha', '1.2.4')).toBe(true)
    expect(semverGt('1.2.4-beta', '1.2.5')).toBe(false)
  })

  it('处理缺失的版本段', () => {
    expect(semverGt('1.2', '1.1')).toBe(true)
    expect(semverGt('1', '0')).toBe(true)
  })
})

// v1.4.11-pre4 回归：旧实现丢弃 -preN 后缀，只比 x.y.z 主体，
// 导致 semverGt('1.4.11-pre3','1.4.11-pre1') === false。
// OTA 更新器用这个比较判断「全量包是否已高于缓存的渲染补丁」，
// 恒为 false 就永远清不掉旧补丁——装新包界面还是旧的（pre2/pre3 连续两次踩到）。
describe('预发布后缀参与比较（v1.4.11-pre4）', () => {
  it('同一主体的预发布按序号比较', () => {
    expect(semverGt('1.4.11-pre3', '1.4.11-pre1')).toBe(true)
    expect(semverGt('1.4.11-pre1', '1.4.11-pre3')).toBe(false)
  })

  it('预发布号按数字比，不是字典序（pre10 > pre9）', () => {
    expect(semverGt('1.4.11-pre10', '1.4.11-pre9')).toBe(true)
    expect(semverGt('1.4.11-pre9', '1.4.11-pre10')).toBe(false)
  })

  it('正式版高于同号预发布', () => {
    expect(semverGt('1.4.11', '1.4.11-pre1')).toBe(true)
    expect(semverGt('1.4.11-pre1', '1.4.11')).toBe(false)
  })

  it('主体更大的预发布仍然更大', () => {
    expect(semverGt('1.4.12-pre1', '1.4.11')).toBe(true)
    expect(semverGt('1.5.0-pre1', '1.4.11')).toBe(true)
  })

  it('段数更多且前缀相同时更大', () => {
    expect(semverGt('1.4.11-pre1.1', '1.4.11-pre1')).toBe(true)
  })

  it('semverCompare 三态正确', () => {
    expect(semverCompare('1.4.11-pre3', '1.4.11-pre1')).toBe(1)
    expect(semverCompare('1.4.11-pre1', '1.4.11-pre3')).toBe(-1)
    expect(semverCompare('1.4.11-pre1', '1.4.11-pre1')).toBe(0)
  })
})

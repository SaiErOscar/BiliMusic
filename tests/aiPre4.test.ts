// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { FALLBACK_MODELS, hostOf, toProductName } from '../src/services/aiModels'
import { loadRecentlyRecommended, rememberRecommended } from '../src/services/aiRecommend'

// v1.4.13-pre4：模型下拉、推荐去重、WorkBuddy 接入、备份完整性。

describe('模型下拉', () => {
  it('DeepSeek 内置表含 flash / pro 两条线', () => {
    const ids = (FALLBACK_MODELS['api.deepseek.com'] || []).map((m) => m.id)
    expect(ids).toContain('deepseek-flash')
    expect(ids).toContain('deepseek-pro')
  })

  it('展示产品名而非接口名', () => {
    expect(toProductName('deepseek-flash')).toBe('DeepSeek Flash')
    expect(toProductName('deepseek-pro')).toBe('DeepSeek Pro')
  })

  it('主机名解析用于匹配回落表', () => {
    expect(hostOf('https://api.deepseek.com')).toBe('api.deepseek.com')
    expect(hostOf('not a url')).toBe('')
  })
})

describe('推荐去重', () => {
  it('记住推荐过的曲目并读回', () => {
    rememberRecommended([{ id: 'a' }, { id: 'b' }])
    expect(loadRecentlyRecommended()).toContain('a')
    expect(loadRecentlyRecommended()).toContain('b')
  })

  it('重复推荐不产生重复条目', () => {
    rememberRecommended([{ id: 'a' }])
    rememberRecommended([{ id: 'a' }])
    expect(loadRecentlyRecommended().filter((x) => x === 'a')).toHaveLength(1)
  })

  it('候选池优先剔除最近推过的', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiRecommend.ts'), 'utf8')
    expect(src).toContain('loadRecentlyRecommended')
    expect(src).toContain('freshPool')
  })
})

describe('WorkBuddy 接入（参考 dsh-connect-workbuddy，MIT）', () => {
  const src = readFileSync(path.resolve(__dirname, '../electron/workbuddy.ts'), 'utf8')

  it('两个区域基址正确', () => {
    expect(src).toContain('https://www.codebuddy.cn')
    expect(src).toContain('https://www.workbuddy.ai')
  })

  it('走插件的 v2/plugin 与 v2/chat/completions 端点', () => {
    expect(src).toContain("'/v2/plugin'")
    expect(src).toContain('/v2/chat/completions')
  })

  it('支持本地凭据与网页登录两条路径', () => {
    expect(src).toContain('workbuddy-desktop')
    expect(src).toContain('auth/state')
    expect(src).toContain('auth/token')
  })

  it('凭据经 safeStorage 加密落盘，不写明文', () => {
    expect(src).toContain('safeStorage.encryptString')
    expect(src).toContain('拒绝以明文保存')
  })
})

describe('备份导出完整性', () => {
  const src = readFileSync(path.resolve(__dirname, '../src/utils/backup.ts'), 'utf8')
  it('画像正文、播放统计、学习信号都进备份', () => {
    expect(src).toContain('userProfileText')
    expect(src).toContain('playStats')
    expect(src).toContain('aiLearned')
  })
  it('恢复时写回这三项', () => {
    expect(src).toContain('savePlayStatsRaw')
    expect(src).toContain('writeText')
    expect(src).toContain('setLearned')
  })
})

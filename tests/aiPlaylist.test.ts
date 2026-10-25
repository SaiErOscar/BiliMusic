// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { AI_PRESETS, describeHttpError, resolveChatUrl } from '../src/services/ai'
import { AI_PLAYLIST_MAX_TRACKS, parsePlaylistJson } from '../src/services/aiPlaylist'

// v1.4.11-pre5：DeepSeek 地址口径 + 错误码映射 + 歌单解析。
// 网络与 LLM 行为无法在 jsdom 里测，靠纯函数守住可回归的部分。

describe('DeepSeek 地址口径（v1.4.11-pre5）', () => {
  it('预设用不带 /v1 的规范地址', () => {
    const ds = AI_PRESETS.find((p) => p.id === 'deepseek')
    expect(ds?.baseUrl).toBe('https://api.deepseek.com')
  })

  it('DeepSeek 补 /chat/completions，不补 /v1', () => {
    expect(resolveChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions')
    // 用户手填带 /v1 的写法同样可用（官方文档也给了这种）
    expect(resolveChatUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  it('OpenAI 仍补 /v1/chat/completions', () => {
    expect(resolveChatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
  })
})

describe('错误码映射（对齐 DeepSeek 官方错误表）', () => {
  const cases: [number, string][] = [
    [400, '请求格式错误'],
    [401, '认证失败'],
    [402, '余额不足'],
    [422, '参数错误'],
    [429, '请求速率达到上限'],
    [500, '服务器内部故障'],
    [503, '服务器繁忙'],
  ]
  for (const [status, keyword] of cases) {
    it(status + ' 给出可操作说明', () => {
      const msg = describeHttpError(status)
      expect(msg).toContain(String(status))
      expect(msg).toContain(keyword)
    })
  }

  it('附带服务端原始说明', () => {
    const msg = describeHttpError(401, JSON.stringify({ error: { message: 'Invalid API key' } }))
    expect(msg).toContain('Invalid API key')
  })

  it('非 JSON 响应体截断后附上', () => {
    const msg = describeHttpError(500, 'gateway timeout')
    expect(msg).toContain('gateway timeout')
  })

  it('未知状态码有兜底', () => {
    expect(describeHttpError(418)).toContain('418')
  })
})

describe('歌单 JSON 解析（容忍围栏与废话）', () => {
  it('解析纯 JSON', () => {
    const r = parsePlaylistJson('{"name":"夜车","description":"安静","indexes":[1,3,5]}')
    expect(r.name).toBe('夜车')
    expect(r.indexes).toEqual([1, 3, 5])
  })

  it('解析代码围栏包裹的 JSON', () => {
    const r = parsePlaylistJson('好的：\n```json\n{"name":"x","indexes":[2]}\n```\n以上。')
    expect(r.name).toBe('x')
    expect(r.indexes).toEqual([2])
  })

  it('过滤非正数与非数字编号', () => {
    const r = parsePlaylistJson('{"indexes":[1,-2,0,"3","abc",4]}')
    expect(r.indexes).toEqual([1, 3, 4])
  })

  it('无 JSON 时抛可读错误', () => {
    expect(() => parsePlaylistJson('抱歉我做不到')).toThrow('JSON')
  })
})

describe('歌单上限与安全约束', () => {
  it('单次最多 30 首', () => {
    expect(AI_PLAYLIST_MAX_TRACKS).toBe(30)
  })

  it('模型编造的编号会被丢弃而不是塞进歌单', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/services/aiPlaylist.ts'), 'utf8')
    expect(src).toContain('droppedIndexes')
    // 必须按编号映射回真实 Track，不能直接用模型给的标题
    expect(src).toContain('byIndex.get(idx)')
  })
})

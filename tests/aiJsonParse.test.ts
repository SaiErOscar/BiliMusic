import { describe, it, expect } from 'vitest'
import { parsePlaylistJson } from '../src/services/aiPlaylist'
import { parseRecommendation } from '../src/services/aiRecommend'

/**
 * v1.4.14-pre5：模型返回畸形 JSON 时必须给可读中文，而不是原生 SyntaxError。
 *
 * 原实现只检查花括号位置就 JSON.parse。注意要区分两种畸形：
 * - 没有闭合花括号 → 走既有「未返回可解析的 JSON」分支（原实现已覆盖）
 * - 花括号齐全但内部非法 → 原实现会直接 JSON.parse 并抛出原生 SyntaxError，
 *   用户看到 "Unexpected token ..." 这类英文报错，无从判断发生了什么。
 * 这里专门守后者。
 */
describe('AI JSON 解析容错（v1.4.14-pre5）', () => {
  it('歌单：花括号齐全但内部非法 → 可读中文而非 SyntaxError', () => {
    // 首尾都有花括号，但内部的键没有引号，JSON.parse 必然失败
    const malformed = '{name:夜跑,indexes:[1,2]}'
    expect(() => parsePlaylistJson(malformed)).toThrow(/不是合法 JSON/)
    try {
      parsePlaylistJson(malformed)
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).name).not.toBe('SyntaxError')
    }
  })

  it('推荐：花括号齐全但内部非法 → 可读中文而非 SyntaxError', () => {
    const malformed = '{greeting:晚上好,picks:[]}'
    const pool = [{ index: 1, track: { id: 'a', title: 'A', artist: 'B' } }] as never
    expect(() => parseRecommendation(malformed, pool)).toThrow(/不是合法 JSON/)
    try {
      parseRecommendation(malformed, pool)
    } catch (err) {
      expect((err as Error).name).not.toBe('SyntaxError')
    }
  })

  it('合法 JSON 不受影响（回归保护）', () => {
    expect(parsePlaylistJson('{"name":"夜跑","indexes":[1,2]}').indexes).toEqual([1, 2])
    const pool = [{ index: 1, track: { id: 'a', title: 'A', artist: 'B' } }] as never
    const r = parseRecommendation('{"greeting":"你好","picks":[{"index":1,"reason":"好听"}]}', pool)
    expect(r.greeting).toBe('你好')
    expect(r.picked).toHaveLength(1)
  })

  it('完全无花括号时仍走原有提示（未被新逻辑覆盖）', () => {
    expect(() => parsePlaylistJson('抱歉我无法回答')).toThrow(/未返回可解析的 JSON/)
  })
})

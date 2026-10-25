// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { estimateTokens, formatUsage, loadUsage } from '../src/services/aiUsage'

// v1.4.13-pre1：画像外部文件化、成本统计、主题色统一。

describe('AI 用量统计', () => {
  it('初始为空（本月未调用）', () => {
    const u = loadUsage()
    expect(u.calls).toBe(0)
    expect(formatUsage(u)).toBe('本月尚未调用')
  })

  it('token 粗估：字符数/3 向上取整', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('a'.repeat(30))).toBe(10)
  })

  it('有调用时显示次数与总量，并标注估算', () => {
    const text = formatUsage({ month: '2026-10', calls: 3, inputTokens: 1000, outputTokens: 500 })
    expect(text).toContain('3 次')
    expect(text).toContain('1,500')
    expect(text).toContain('估算')
  })
})

describe('用户画像外部文件（隐私与安全约束）', () => {
  const src = readFileSync(path.resolve(__dirname, '../electron/profile.ts'), 'utf8')

  it('画像落在 userData 的真实文件，不是 localStorage', () => {
    expect(src).toContain("app.getPath('userData')")
    expect(src).toContain('user-profile.md')
    // 不得使用 localStorage API（注释里提到这个词是说明「为什么不用它」）
    expect(src).not.toMatch(/localStorage\.(getItem|setItem|removeItem)/)
  })

  it('有大小上限，防止长文撑爆 prompt', () => {
    expect(src).toContain('PROFILE_MAX_BYTES')
    expect(src).toMatch(/PROFILE_MAX_BYTES = 8 \* 1024/)
  })

  it('写入用临时文件 + rename，避免与编辑器并发写坏', () => {
    expect(src).toContain(".tmp")
    expect(src).toContain('fs.rename')
  })

  it('学习结果只追加到自动小节，不覆盖用户手写内容', () => {
    expect(src).toContain('AI 记录（自动生成，勿手改）')
    // 已有小节时是替换该小节，而不是整体重写
    expect(src).toContain('current.slice(0, idx)')
  })

  it('应用学习结果必须由用户显式触发（独立 IPC）', () => {
    expect(src).toContain("ipcMain.handle('profile:apply-learned'")
  })
})

describe('主题色统一（播放顺序按钮等）', () => {
  it('主控件激活态不再硬编码粉色', () => {
    for (const f of ['PlayerBar.tsx', 'PlayQueue.tsx']) {
      const src = readFileSync(path.resolve(__dirname, '../src/components/' + (f === 'PlayerBar.tsx' ? 'layout/' : '') + f), 'utf8')
      expect(src).not.toContain("'#ff375f'")
      expect(src).toContain('var(--color-primary)')
    }
  })
})

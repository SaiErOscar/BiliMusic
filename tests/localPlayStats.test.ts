// v1.4.16-pre2 播放统计口径：本地曲目计入最近播放，但不进 AI 画像
//
// 用户口径：最近播放是用户自己的收听历史，本地曲目理应在里面；
// AI 画像分析的是 B 站听歌偏好，本地曲目没有 B 站元数据，混进去会稀释画像。
//
// 这里用源码级断言——统计逻辑嵌在 PlayerContext 的 effect 里，
// 起一个完整 Provider 成本太高，而这条规则的本质是「有没有这个分支」。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(
  path.join(process.cwd(), 'src/contexts/PlayerContext.tsx'),
  'utf8',
)

describe('本地曲目的播放统计口径', () => {
  it('本地曲目仍然计入最近播放（不做 localPath 过滤）', () => {
    // addRecentTrack 那一行必须无条件调用
    expect(src).toMatch(/if \(currentTrack\) addRecentTrack\(currentTrack\)/)
  })

  it('本地曲目跳过 AI 画像埋点', () => {
    // recordPlayStart 必须在 !localPath 分支里
    expect(src).toMatch(/if \(!isLocal\) recordPlayStart\(currentTrack\)/)
    // 且不能有无条件的 recordPlayStart 调用残留
    const unconditional = /^\s*recordPlayStart\(currentTrack\)$/m.test(src)
    expect(unconditional).toBe(false)
  })

  it('本地曲目不建立埋点状态（否则结算时仍会写入画像）', () => {
    expect(src).toMatch(/playStatRef\.current = isLocal \? null :/)
  })

  it('注释里写明了口径依据（避免后人「优化」掉）', () => {
    expect(src).toContain('不计入 AI 听歌画像')
    expect(src).toContain('计入最近播放')
  })
})

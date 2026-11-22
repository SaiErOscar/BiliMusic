// v1.4.16-pre2 lm:// 目录白名单
//
// 审计 R-30：lm:// 原先只校验扩展名，任何 .mp3 都能读，
// 渲染层一旦出现注入面就是「任意音频路径读取」通道。
// 现在只放行用户通过对话框选定（或 M3U 导入时显式授权）的目录内的文件。
import { describe, expect, it, beforeEach } from 'vitest'
import path from 'node:path'
import { authorizeMusicDir, authorizeMusicFile, isAuthorizedMusicFile } from '../electron/localMusic'

const sep = path.sep

beforeEach(() => {
  // 每个用例用不同目录，避免相互影响（authorizedDirs 是模块级集合）
})

describe('isAuthorizedMusicFile —— 白名单边界', () => {
  it('未授权任何目录时一律拒绝', () => {
    expect(isAuthorizedMusicFile('C:' + sep + 'Unknown' + sep + 'a.mp3')).toBe(false)
  })

  it('授权目录内的文件放行', () => {
    const dir = 'C:' + sep + 'Music' + sep + 'A'
    authorizeMusicDir(dir)
    expect(isAuthorizedMusicFile(dir + sep + 'song.mp3')).toBe(true)
  })

  it('子目录内的文件也放行（递归属于该目录）', () => {
    const dir = 'C:' + sep + 'Music' + sep + 'B'
    authorizeMusicDir(dir)
    expect(isAuthorizedMusicFile(dir + sep + 'sub' + sep + 'deep' + sep + 'song.flac')).toBe(true)
  })

  it('**关键**：前缀相近的兄弟目录不能绕过（Music vs Music-evil）', () => {
    const dir = 'C:' + sep + 'Music' + sep + 'C'
    authorizeMusicDir(dir)
    // 若不带分隔符做前缀断言，".../C-evil" 会被误判为在 ".../C" 内
    expect(isAuthorizedMusicFile('C:' + sep + 'Music' + sep + 'C-evil' + sep + 'evil.mp3')).toBe(false)
  })

  it('授权目录之外的文件拒绝', () => {
    const dir = 'C:' + sep + 'Music' + sep + 'D'
    authorizeMusicDir(dir)
    expect(isAuthorizedMusicFile('C:' + sep + 'Other' + sep + 'a.mp3')).toBe(false)
  })

  it('大小写不敏感（Windows 路径语义）', () => {
    const dir = 'C:' + sep + 'Music' + sep + 'E'
    authorizeMusicDir(dir)
    expect(isAuthorizedMusicFile(dir.toUpperCase() + sep + 'SONG.MP3')).toBe(true)
  })

  it('authorizeMusicFile 只授权该文件所在目录', () => {
    const file = 'C:' + sep + 'Imported' + sep + 'one.mp3'
    authorizeMusicFile(file)
    expect(isAuthorizedMusicFile(file)).toBe(true)
    // 同目录其他文件也放行（目录级授权）
    expect(isAuthorizedMusicFile('C:' + sep + 'Imported' + sep + 'two.mp3')).toBe(true)
    // 但不会放开整个盘符
    expect(isAuthorizedMusicFile('C:' + sep + 'Windows' + sep + 'secret.mp3')).toBe(false)
  })

  it('空路径不授权任何东西', () => {
    authorizeMusicDir('')
    expect(isAuthorizedMusicFile('')).toBe(false)
  })
})

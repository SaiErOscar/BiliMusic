import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildBackupFile,
  decryptBackup,
  readBackupMeta,
  collectBackup,
  applyBackup,
  type BackupPayload,
} from '../src/utils/backup'

function samplePayload(): BackupPayload {
  return {
    app: 'biliMusic',
    type: 'backup',
    formatVersion: 1,
    exportedAt: '2026-09-28T10:00:00.000Z',
    account: { dedeUserId: '12345', sessdata: 'sd', biliJct: 'jct', username: '小明', avatar: '' },
    playlists: [],
    playlistTombstones: [],
    favorites: [
      { id: 'a', title: '歌A', artist: 'x', coverUrl: '', duration: 1, videoUrl: '', bvid: '', playCount: 0, isLiked: true, likedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', title: '歌B', artist: 'y', coverUrl: '', duration: 1, videoUrl: '', bvid: '', playCount: 0, isLiked: true, likedAt: '2026-01-02T00:00:00.000Z' },
    ],
    favoriteTombstones: [],
    recent: [],
    downloads: [],
    lyricOffsets: { a: 100 },
    settings: { downloadDir: '/tmp/x' } as BackupPayload['settings'],
    theme: 'dark' as const,
  }
}

describe('backup 加密封装', () => {
  it('口令正确时可完整还原负载（含账号凭证）', async () => {
    const payload = samplePayload()
    const file = await buildBackupFile(payload, 'my-secret')
    expect(file.startsWith('BiliMusic-Backup/v1\n')).toBe(true)
    const back = await decryptBackup(file, 'my-secret')
    expect(back.account?.dedeUserId).toBe('12345')
    expect(back.account?.sessdata).toBe('sd')
    expect(back.favorites.map((f) => f.id).sort()).toEqual(['a', 'b'])
    expect(back.lyricOffsets.a).toBe(100)
  })

  it('口令错误时解密失败', async () => {
    const file = await buildBackupFile(samplePayload(), 'right')
    await expect(decryptBackup(file, 'wrong')).rejects.toThrow(/口令/)
  })

  it('明文不含敏感串（账号/口令被加密）', async () => {
    const file = await buildBackupFile(samplePayload(), 'my-secret')
    expect(file).not.toContain('my-secret')
    expect(file).not.toContain('12345')
    expect(file).not.toContain('SESSDATA')
    expect(file).not.toContain('小明')
  })

  it('readBackupMeta 只暴露非隐私元信息', async () => {
    const file = await buildBackupFile(samplePayload(), 'pw')
    const meta = readBackupMeta(file)
    expect(meta.hasAccount).toBe(true)
    expect(meta.exportedAt).toBe('2026-09-28T10:00:00.000Z')
    expect(meta).not.toHaveProperty('dedeUserId')
  })

  it('篡改文件魔数会被拒绝', async () => {
    const file = await buildBackupFile(samplePayload(), 'pw')
    expect(() => readBackupMeta('not-a-backup')).toThrow()
    expect(() => readBackupMeta('BiliMusic-Backup/v2\nxxxx')).toThrow()
  })
})

describe('backup 合并恢复', () => {
  beforeEach(() => localStorage.clear())

  it('我喜欢与最近播放按 id 并集去重', () => {
    localStorage.setItem('bilimusic_favorites', JSON.stringify([
      { id: 'b', title: '本地B', artist: '', coverUrl: '', duration: 1, videoUrl: '', bvid: '', playCount: 0, isLiked: true, likedAt: '2026-01-02T00:00:00.000Z' },
    ]))
    applyBackup(samplePayload())
    const favs = JSON.parse(localStorage.getItem('bilimusic_favorites') || '[]')
    expect(favs.map((f: { id: string }) => f.id).sort()).toEqual(['a', 'b'])
  })

  it('设置项以备份覆盖', () => {
    applyBackup(samplePayload())
    const s = JSON.parse(localStorage.getItem('bilimusic_settings') || '{}')
    expect(s.downloadDir).toBe('/tmp/x')
  })

  it('深浅色模式随备份恢复并即时生效（v1.4.3-pre7）', () => {
    localStorage.setItem('theme-mode', 'light')
    applyBackup(samplePayload()) // payload.theme = 'dark'
    expect(localStorage.getItem('theme-mode')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('加解密往返保留主题字段', async () => {
    const file = await buildBackupFile(samplePayload(), 'pw')
    const back = await decryptBackup(file, 'pw')
    expect(back.theme).toBe('dark')
    expect(back.account?.dedeUserId).toBe('12345')
  })
})

describe('collectBackup 账号留空降级', () => {
  it('无 electronAPI 时账号字段为 null，不抛错', async () => {
    localStorage.clear()
    const p = await collectBackup()
    expect(p.account).toBeNull()
    expect(p.type).toBe('backup')
  })
})

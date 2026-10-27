/**
 * v1.4.11-pre5 AI 智能歌单面板。
 *
 * 抽成独立组件而不是塞进 Settings.tsx：设置页已经很长，且该面板自带状态机
 * （输入 → 生成中 → 预览 → 保存）。SettingsRow 是 Settings.tsx 内的私有组件，
 * 这里用 render-prop 由设置页注入，避免为了一行 UI 把 SettingsRow 提成公共组件。
 */
import { useState, type ReactNode } from 'react'
import { ActionButton } from '@/components/AppleMusicPage'
import { generateAiPlaylist, saveAiPlaylist, type AiPlaylistResult } from '@/services/aiPlaylist'
import { saveAiConfig } from '@/services/ai'
import { platform } from '@/platform'
import type { AiSettings } from '@/types'

/** 行容器签名，与 Settings.tsx 的 SettingsRow 对齐（只用到这三个字段） */
export type RowRenderer = (props: {
  label: string
  description?: string
  stacked?: boolean
  children: ReactNode
}) => ReactNode

interface Props {
  /** 当前 AI 配置；生成前会先落盘，保证主进程按最新代理/密钥发请求 */
  config: AiSettings
  /** 由设置页注入的 SettingsRow */
  Row: RowRenderer
}

export default function AiPlaylistPanel({ config, Row }: Props) {
  const [intent, setIntent] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<AiPlaylistResult | null>(null)

  const run = async () => {
    setBusy(true)
    setMessage('生成中…')
    setPreview(null)
    try {
      await saveAiConfig(config)
      const result = await generateAiPlaylist(config, intent)
      setPreview(result)
      const dropped = result.droppedIndexes.length
      setMessage(
        '已生成「' + result.name + '」，共 ' + result.tracks.length + ' 首'
          + (dropped ? '（模型给的 ' + dropped + ' 个编号不存在，已丢弃）' : ''),
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const commit = () => {
    if (!preview) return
    try {
      const saved = saveAiPlaylist(preview)
      // v1.4.13-pre2 学习信号：保存说明这批选择被认可
      void platform.userProfile?.recordPlaylist(preview.tracks.length).catch(() => {})
      setMessage('已保存歌单「' + saved.name + '」，共 ' + preview.tracks.length + ' 首')
      setPreview(null)
      setIntent('')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      {/* v1.4.13-pre4 合并：场景描述与生成按钮同处一行，减少板块行数并让「输入→触发」更紧凑 */}
      {Row({
        label: '场景描述',
        description: message || '例如：适合深夜写代码的安静歌单',
        children: (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="settings-input"
              type="text"
              placeholder="适合深夜写代码的安静歌单"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            />
            <ActionButton onClick={() => void run()} disabled={busy}>
              {busy ? '生成中…' : '生成歌单'}
            </ActionButton>
          </div>
        ),
      })}
      {preview
        ? Row({
            label: preview.name,
            stacked: true,
            description: preview.description || ('共 ' + preview.tracks.length + ' 首'),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                <div style={{ fontSize: 12, opacity: 0.72, maxHeight: 120, overflowY: 'auto' }}>
                  {preview.tracks.map((t, i) => (
                    <div key={t.id}>{(i + 1) + '. ' + t.title + (t.artist ? ' - ' + t.artist : '')}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <ActionButton onClick={commit}>保存为歌单</ActionButton>
                  <ActionButton onClick={() => { setPreview(null); setMessage('已取消') }}>取消</ActionButton>
                </div>
              </div>
            ),
          })
        : null}
    </>
  )
}

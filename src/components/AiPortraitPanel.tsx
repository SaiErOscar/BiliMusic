/**
 * v1.4.12-pre1 AI 听歌画像面板。
 *
 * 与智能歌单/歌词增强同样抽成独立组件：自带「选范围 → 生成中 → 结果」状态机。
 */
import { useState } from 'react'
import { ActionButton } from '@/components/AppleMusicPage'
import { PORTRAIT_RANGE_LABELS, generatePortrait, type PortraitRange, type PortraitSummary } from '@/services/aiPortrait'
import { clearPlayStats } from '@/utils/storage'
import { saveAiConfig } from '@/services/ai'
import type { AiProviderConfig } from '@/types'
import type { RowRenderer } from '@/components/AiPlaylistPanel'

interface Props {
  config: AiProviderConfig
  Row: RowRenderer
}

export default function AiPortraitPanel({ config, Row }: Props) {
  const [range, setRange] = useState<PortraitRange>('month')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [text, setText] = useState('')
  const [summary, setSummary] = useState<PortraitSummary | null>(null)

  const run = async () => {
    setBusy(true)
    setMessage('生成中…')
    setText('')
    try {
      await saveAiConfig(config)
      const res = await generatePortrait(config, range)
      setText(res.text)
      setSummary(res.summary)
      setMessage('已生成')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {Row({
        label: '听歌画像',
        description: message || '按播放统计生成一段叙事化画像；统计只存本地',
        children: (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="settings-select"
              value={range}
              onChange={(e) => setRange(e.target.value as PortraitRange)}
            >
              <option value="month">近一个月</option>
              <option value="year">近一年</option>
              <option value="all">全部时间</option>
            </select>
            <ActionButton onClick={() => void run()} disabled={busy}>
              {busy ? '生成中…' : '生成画像'}
            </ActionButton>
          </div>
        ),
      })}
      {text
        ? Row({
            label: PORTRAIT_RANGE_LABELS[range] + '画像',
            stacked: true,
            description: summary
              ? '共 ' + summary.trackCount + ' 首 / ' + summary.totalPlays + ' 次 / ' + summary.totalHours + ' 小时'
              : '',
            children: (
              <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', width: '100%' }}>
                {text}
              </div>
            ),
          })
        : null}
      {Row({
        label: '清除播放统计',
        description: '删除本地累计的播放次数与时长，不影响最近播放列表',
        children: (
          <ActionButton
            onClick={() => {
              clearPlayStats()
              setText('')
              setSummary(null)
              setMessage('已清除')
            }}
          >
            清除
          </ActionButton>
        ),
      })}
    </>
  )
}

/**
 * v1.4.12-pre1 AI 听歌画像面板。
 *
 * 与智能歌单/歌词增强同样抽成独立组件：自带「选范围 → 生成中 → 结果」状态机。
 */
import { useEffect, useState } from 'react'
import { ActionButton } from '@/components/AppleMusicPage'
import { PORTRAIT_RANGE_LABELS, generatePortrait, type PortraitRange, type PortraitSummary } from '@/services/aiPortrait'
import { saveAiConfig } from '@/services/ai'
import type { AiSettings } from '@/types'
import type { RowRenderer } from '@/components/AiPlaylistPanel'

interface Props {
  config: AiSettings
  Row: RowRenderer
  /**
   * v1.4.14-pre4：外部要求重置已生成的结果。
   *
   * 「清除播放统计」已移进 AI 设置抽屉（它属于配置类动作，不是功能入口），
   * 但清除之后分组里那份已生成的画像就成了过期数据，必须一起清掉。
   * 用自增信号而不是把 setText/setSummary 提到设置页，是为了让面板继续
   * 自己管住「选范围 → 生成 → 结果」这条状态机。
   */
  resetSignal?: number
}

export default function AiPortraitPanel({ config, Row, resetSignal = 0 }: Props) {
  const [range, setRange] = useState<PortraitRange>('month')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [text, setText] = useState('')
  const [summary, setSummary] = useState<PortraitSummary | null>(null)

  // 播放统计被清空后，已生成的结果不再对应当前数据，直接作废
  useEffect(() => {
    if (!resetSignal) return
    setText('')
    setSummary(null)
    setMessage('播放统计已清除，可重新生成')
  }, [resetSignal])

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
    </>
  )
}

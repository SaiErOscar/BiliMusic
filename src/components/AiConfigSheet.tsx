/**
 * v1.4.13-pre11 AI 配置二级菜单。
 *
 * 用户反馈「AI 功能配置较多」，要求放进二级菜单，并在顶部提供三个分页：
 * AI 直连 / WorkBuddy 中国版 / WorkBuddy 国际版。
 *
 * 这里只做「分页 + 面板容器」，具体字段仍由设置页传入，
 * 避免把 SettingsRow 这类私有组件提成公共组件（改动面会失控）。
 */
import type { ReactNode } from 'react'

export type AiSourceTab = 'direct' | 'wb-cn' | 'wb-global'

export const AI_TABS: { id: AiSourceTab; label: string }[] = [
  { id: 'direct', label: 'AI 直连' },
  { id: 'wb-cn', label: 'WorkBuddy 中国版' },
  { id: 'wb-global', label: 'WorkBuddy 国际版' },
]

interface Props {
  active: AiSourceTab
  onChange: (tab: AiSourceTab) => void
  children: ReactNode
  /** 关闭二级菜单 */
  onClose: () => void
}

export default function AiConfigSheet({ active, onChange, children, onClose }: Props) {
  return (
    <div className="ai-sheet-overlay" onClick={onClose}>
      <div className="ai-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ai-sheet__head">
          <strong>AI 连接设置</strong>
          <button type="button" className="ai-sheet__close" onClick={onClose}>×</button>
        </div>

        <div className="ai-sheet__tabs" role="tablist">
          {AI_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              className={'ai-sheet__tab' + (active === tab.id ? ' ai-sheet__tab--on' : '')}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="ai-sheet__body">{children}</div>
      </div>
    </div>
  )
}

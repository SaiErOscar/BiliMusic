/**
 * v1.4.13-pre11 AI 配置二级菜单。
 *
 * 用户反馈「AI 功能配置较多」，要求放进二级菜单，并在顶部提供三个分页：
 * AI 直连 / WorkBuddy 中国版 / WorkBuddy 国际版。
 *
 * 这里只做「分页 + 面板容器」，具体字段仍由设置页传入，
 * 避免把 SettingsRow 这类私有组件提成公共组件（改动面会失控）。
 *
 * v1.4.14-pre4：外壳泛化为「任意分页集合」。
 * 「AI 助手」分组的配置项收进同一个抽屉后，需要的是
 * 推荐 / 画像 / 清洗 / 连接 四把分区钥匙，而不是写死的三把连接来源钥匙。
 * 于是 tabs 由调用方传入，分页 id 类型也随之泛型化；
 * 样式类仍是 ai-sheet__*，两处抽屉共用同一套外观与交互范式。
 */
import type { ReactNode } from 'react'

export type AiSourceTab = 'direct' | 'wb-cn' | 'wb-global'

export const AI_TABS: { id: AiSourceTab; label: string }[] = [
  { id: 'direct', label: 'AI 直连' },
  { id: 'wb-cn', label: 'WorkBuddy 中国版' },
  { id: 'wb-global', label: 'WorkBuddy 国际版' },
]

/** 分页定义；id 泛型化后，连接来源与设置分区可共用同一个外壳 */
export interface AiSheetTab<T extends string = AiSourceTab> {
  id: T
  label: string
}

interface Props<T extends string = AiSourceTab> {
  active: T
  onChange: (tab: T) => void
  /** 分页集合；省略时用连接来源的三页（保持原有调用方零改动） */
  tabs?: AiSheetTab<T>[]
  /** 抽屉标题；省略时为「AI 连接设置」 */
  title?: string
  children: ReactNode
  /** 关闭二级菜单 */
  onClose: () => void
}

export default function AiConfigSheet<T extends string = AiSourceTab>({
  active,
  onChange,
  tabs,
  title,
  children,
  onClose,
}: Props<T>) {
  // AI_TABS 是 AiSheetTab<AiSourceTab>[]，省略 tabs 时即回到 v1.4.13 的三页行为
  const items: AiSheetTab<T>[] = tabs ?? (AI_TABS as AiSheetTab<T>[])
  return (
    <div className="ai-sheet-overlay" onClick={onClose}>
      <div className="ai-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ai-sheet__head">
          <strong>{title ?? 'AI 连接设置'}</strong>
          <button type="button" className="ai-sheet__close" onClick={onClose}>×</button>
        </div>

        <div className="ai-sheet__tabs" role="tablist">
          {items.map((tab) => (
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

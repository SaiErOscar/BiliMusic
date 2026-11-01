/**
 * v1.4.14-pre4「AI 助手」设置抽屉。
 *
 * 动机：AI 助手分组长期顶在「板块不超过 7 行」的上限上——静态 4 行看似安全，
 * 但 AiPlaylistPanel / AiPortraitPanel 通过 Row(...) 注入的行不计入静态标签，
 * 默认态真实渲染 7 行，生成歌单/画像预览后到 9 行，早就超了。
 *
 * 分区依据是「这些配置各自服务于哪条 AI 链路」，而不是按 UI 控件类型凑数：
 * - 推荐：发现页推荐板块的触发方式（不点不消耗 API 是这里最需要说清的一句）
 * - 画像：人设 + 用户画像四个动作 + 听歌统计清理（都围绕「AI 眼里的你」）
 * - 清洗：喂给 AI 前的标题预处理（独立于推荐/画像，影响每一次请求的输入质量）
 * - 连接：服务商、模型、代理与连通性测试（v1.4.13 的三页抽屉从这里进）
 *
 * 生成入口（智能歌单 / 听歌画像）**不**搬进抽屉：它们是功能入口不是配置，
 * 留在分组里可直接触发；只有它们过长的配置行被收走。
 *
 * 本组件只做「分区 + 字段摆放」，状态与副作用（落盘、开编辑器、跑 AI）
 * 全部由设置页通过 props 注入，避免把 AiSettings 的持久化逻辑复制一份。
 */
import { ActionButton } from '@/components/AppleMusicPage'
import AiConfigSheet, { type AiSheetTab } from '@/components/AiConfigSheet'
import { loadAppSettings, updateAppSettings } from '@/utils/storage'
import type { AiSettings, TitleCleanMode } from '@/types'

/** 抽屉分区：推荐 / 画像 / 清洗 / 连接 */
export type AiSettingsTab = 'recommend' | 'portrait' | 'clean' | 'connect'

export const AI_SETTINGS_TABS: AiSheetTab<AiSettingsTab>[] = [
  { id: 'recommend', label: '推荐' },
  { id: 'portrait', label: '画像' },
  { id: 'clean', label: '清洗' },
  { id: 'connect', label: '连接' },
]

interface Props {
  active: AiSettingsTab
  onChange: (tab: AiSettingsTab) => void
  onClose: () => void
  /** 当前 AI 配置（含 recommendMode / persona） */
  config: AiSettings
  patchConfig: (patch: Partial<AiSettings>) => void
  /** 标题清洗模式存在 AppSettings 里，不在 AiSettings 内 */
  titleCleanMode: TitleCleanMode
  onTitleCleanModeChange: (mode: TitleCleanMode) => void
  /** 画像操作：编辑 / 定位 / 应用学习结果 / 清除学习记录 */
  onOpenProfile: () => void
  onRevealProfile: () => void
  onApplyLearned: () => void
  onClearLearned: () => void
  profileMessage: string
  /** 听歌统计清理：清完要把分组里的画像结果一并重置，所以交给设置页做 */
  onClearPlayStats: () => void
  playStatsMessage: string
  /** 连接分区：打开 v1.4.13 的三页连接抽屉 */
  onOpenConnect: () => void
  connectSummary: string
  savedApiCount: number
  /** 测试区状态文案（保存 / 测试连接的反馈） */
  aiMessage: string
  usageText: string
  aiTesting: boolean
  onSave: () => void
  onTest: () => void
  onClearUsage: () => void
}

export default function AiSettingsSheet({
  active,
  onChange,
  onClose,
  config,
  patchConfig,
  titleCleanMode,
  onTitleCleanModeChange,
  onOpenProfile,
  onRevealProfile,
  onApplyLearned,
  onClearLearned,
  profileMessage,
  onClearPlayStats,
  playStatsMessage,
  onOpenConnect,
  connectSummary,
  savedApiCount,
  aiMessage,
  usageText,
  aiTesting,
  onSave,
  onTest,
  onClearUsage,
}: Props) {
  /*
   * v1.4.14-pre6 池外推荐开关落在 AppSettings 里（不是 AiSettings）：
   * 它管的是「发现页要不要多问一轮」，属于界面行为，与 Provider 凭据无关。
   *
   * 这里刻意**不用** useAppSettings hook：本组件会被测试以普通函数方式直接调用
   * （不经 React 渲染器），任何 hook 都会抛 Invalid hook call。
   * 改为每次渲染同步读一次 localStorage——数据量很小；写入走 updateAppSettings
   * 会派发 SETTINGS_CHANGED_EVENT，设置页的 useAppSettings 收到后重渲染，
   * 本组件随之重读，开关状态自然同步。
   */
  const externalOn = loadAppSettings().aiExternalRecommend

  return (
    <AiConfigSheet<AiSettingsTab>
      active={active}
      onChange={onChange}
      tabs={AI_SETTINGS_TABS}
      title="AI 助手设置"
      onClose={onClose}
    >
      {active === 'recommend' && (
        <>
          <div className="ai-sheet__field">
            <span className="ai-sheet__label">推荐方式</span>
            <select
              className="settings-select"
              value={config.recommendMode}
              onChange={(e) => patchConfig({ recommendMode: e.target.value as AiSettings['recommendMode'] })}
            >
              <option value="click">点击后推荐（省费用）</option>
              <option value="auto">自动推荐（打开即生成）</option>
              <option value="off">不推荐（不显示板块）</option>
            </select>
            <span className="ai-sheet__hint">
              发现页 AI 推荐板块的触发方式；点击方式不点不消耗 API
            </span>
          </div>

          {/*
            v1.4.14-pre6 池外推荐：默认关闭。
            开关状态要能被读出来（role="switch" + aria-checked），
            否则「开关打开却没结果」时用户无从判断自己到底有没有开。
          */}
          <div className="ai-sheet__field">
            <span className="ai-sheet__label">曲库之外的推荐</span>
            <div className="ai-sheet__row">
              <button
                type="button"
                className={'settings-toggle' + (externalOn ? ' is-on' : '')}
                role="switch"
                aria-checked={externalOn}
                aria-label="推荐曲库之外的歌曲"
                onClick={() => updateAppSettings({ aiExternalRecommend: !externalOn })}
              >
                <span />
              </button>
              <span className="ai-sheet__hint">
                {externalOn ? '已开启' : '已关闭'}
              </span>
            </div>
            <span className="ai-sheet__hint">
              在歌单、收藏、喜欢之外再推几首，会消耗更多额度；
              候选由模型提出，逐条校验 BV 号与标题后才显示
            </span>
          </div>
        </>
      )}

      {active === 'portrait' && (
        <>
          <div className="ai-sheet__field">
            <span className="ai-sheet__label">人设</span>
            <input
              className="settings-input"
              type="text"
              placeholder="人设：例：像个话不多的老朋友，别用感叹号"
              value={config.persona}
              onChange={(e) => patchConfig({ persona: e.target.value })}
            />
            <span className="ai-sheet__hint">
              你希望 AI 用什么口吻说话，只影响推荐措辞
            </span>
          </div>

          <div className="ai-sheet__field">
            <span className="ai-sheet__label">用户画像</span>
            <div className="ai-sheet__row" style={{ flexWrap: 'wrap' }}>
              <ActionButton onClick={onOpenProfile}>编辑画像</ActionButton>
              <ActionButton onClick={onRevealProfile}>定位文件</ActionButton>
              <ActionButton onClick={onApplyLearned}>应用学习结果</ActionButton>
              <ActionButton onClick={onClearLearned}>清除学习记录</ActionButton>
            </div>
            <span className="ai-sheet__hint">
              {profileMessage
                || '画像：点「编辑」用系统编辑器改本地文件（只存本地，仅随 AI 请求发给你配置的服务商）'}
            </span>
          </div>

          <div className="ai-sheet__field">
            <span className="ai-sheet__label">听歌统计</span>
            <div className="ai-sheet__row">
              <ActionButton onClick={onClearPlayStats}>清除播放统计</ActionButton>
            </div>
            <span className="ai-sheet__hint">
              {playStatsMessage || '删除本地累计的播放次数与时长，不影响最近播放列表'}
            </span>
          </div>
        </>
      )}

      {active === 'clean' && (
        <div className="ai-sheet__field">
          <span className="ai-sheet__label">标题清洗</span>
          <select
            className="settings-select"
            value={titleCleanMode}
            onChange={(e) => onTitleCleanModeChange(e.target.value as TitleCleanMode)}
          >
            <option value="rule">程序清洗（快、免费）</option>
            <option value="ai">AI 清洗（更准、消耗额度）</option>
            <option value="off">不清洗（用原标题）</option>
          </select>
          <span className="ai-sheet__hint">
            喂给 AI 前先去掉标题噪声（【4K】【翻唱】、emoji、UP 主前缀、播放量）；
            AI 清洗更准但每次消耗额度
          </span>
        </div>
      )}

      {active === 'connect' && (
        <>
          <div className="ai-sheet__field">
            <span className="ai-sheet__label">当前连接</span>
            <span className="ai-sheet__hint">{connectSummary}</span>
            <div className="ai-sheet__row">
              <ActionButton onClick={onOpenConnect}>连接设置</ActionButton>
              {savedApiCount > 0 && (
                <span className="ai-sheet__hint">已记 {savedApiCount} 套</span>
              )}
            </div>
          </div>

          <div className="ai-sheet__field">
            <span className="ai-sheet__label">保存与测试</span>
            <div className="ai-sheet__row" style={{ flexWrap: 'wrap' }}>
              <ActionButton onClick={onSave}>保存</ActionButton>
              <ActionButton onClick={onTest} disabled={aiTesting}>
                {aiTesting ? '测试中…' : '测试连接'}
              </ActionButton>
              <ActionButton onClick={onClearUsage}>清零用量</ActionButton>
            </div>
            <span className="ai-sheet__hint">
              {aiMessage || usageText || '先保存，再测试地址、密钥、模型与代理是否都通'}
            </span>
          </div>
        </>
      )}
    </AiConfigSheet>
  )
}

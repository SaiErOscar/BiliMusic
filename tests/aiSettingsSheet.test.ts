// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AiSettingsSheet, { AI_SETTINGS_TABS, type AiSettingsTab } from '../src/components/AiSettingsSheet'
import type { AiSettings } from '../src/types'

const config = {
  baseUrl: '', model: '', apiKey: '', proxyMode: 'system', proxyUrl: '',
  recommendMode: 'click', userProfile: { text: '', updatedAt: '' }, persona: '',
} as AiSettings

function render(tab: AiSettingsTab): string {
  return renderToStaticMarkup(
    AiSettingsSheet({
      active: tab,
      onChange: () => {},
      onClose: () => {},
      config,
      patchConfig: () => {},
      titleCleanMode: 'rule',
      onTitleCleanModeChange: () => {},
      onOpenProfile: () => {},
      onRevealProfile: () => {},
      onApplyLearned: () => {},
      onClearLearned: () => {},
      profileMessage: '',
      onClearPlayStats: () => {},
      playStatsMessage: '',
      onOpenConnect: () => {},
      connectSummary: '未配置',
      savedApiCount: 0,
      aiMessage: '',
      usageText: '',
      aiTesting: false,
      onSave: () => {},
      onTest: () => {},
      onClearUsage: () => {},
    }),
  )
}

describe('AI 设置抽屉分区', () => {
  it('四个分区都在顶栏', () => {
    const html = render('recommend')
    for (const t of AI_SETTINGS_TABS) expect(html).toContain(t.label)
    expect(html).toContain('AI 助手设置')
  })

  it('推荐分区含推荐方式三档', () => {
    const html = render('recommend')
    for (const v of ['click', 'auto', 'off']) expect(html).toContain('value="' + v + '"')
  })

  it('画像分区含人设与四个画像动作', () => {
    const html = render('portrait')
    expect(html).toContain('人设')
    for (const s of ['编辑画像', '定位文件', '应用学习结果', '清除学习记录']) expect(html).toContain(s)
  })

  it('清洗分区含标题清洗三档', () => {
    const html = render('clean')
    for (const v of ['rule', 'ai', 'off']) expect(html).toContain('value="' + v + '"')
  })

  it('连接分区含连接入口与保存测试', () => {
    const html = render('connect')
    expect(html).toContain('连接设置')
    expect(html).toContain('测试连接')
  })
})

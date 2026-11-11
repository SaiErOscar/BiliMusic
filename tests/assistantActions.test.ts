import { describe, it, expect } from 'vitest'

import {
  ASSISTANT_ACTIONS,
  getAssistantAction,
  matchActions,
  renderActionsForPrompt,
} from '../src/services/assistantActions'
import type { AssistantAction } from '../src/services/assistantActions'
import { DEFAULT_APP_SETTINGS } from '../src/utils/storage'
import { BUILTIN_THEMES } from '../src/theme/tokens'

/** AppSettings 的全部字段名，用来断言「每个字段都有动作」 */
const SETTINGS_FIELDS = Object.keys(DEFAULT_APP_SETTINGS)

function ids(): string[] {
  return ASSISTANT_ACTIONS.map(a => a.id)
}

describe('动作注册表 · 覆盖面', () => {
  it('id 全局唯一', () => {
    const all = ids()
    expect(new Set(all).size).toBe(all.length)
  })

  it('每个动作的字段都合法（非空 id/label/aliases/group，参数名不重复）', () => {
    for (const action of ASSISTANT_ACTIONS) {
      expect(action.id).toMatch(/^[a-z]+\.[a-zA-Z0-9-]+$/)
      expect(action.label.length).toBeGreaterThan(0)
      expect(action.aliases.length).toBeGreaterThan(0)
      expect(action.group.length).toBeGreaterThan(0)
      expect(['safe', 'confirm']).toContain(action.risk)
      const names = action.params.map(p => p.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('enum 参数必须带 options，其余类型不带 options', () => {
    for (const action of ASSISTANT_ACTIONS) {
      for (const param of action.params) {
        if (param.type === 'enum') expect(param.options?.length ?? 0).toBeGreaterThan(0)
        else expect(param.options).toBeUndefined()
      }
    }
  })

  it('有必填参数的动作都提供了 askFor', () => {
    for (const action of ASSISTANT_ACTIONS) {
      if (action.params.some(p => p.required)) expect(typeof action.askFor).toBe('function')
    }
  })

  it('覆盖全部播放控制动作', () => {
    for (const id of [
      'playback.play',
      'playback.pause',
      'playback.next',
      'playback.prev',
      'playback.volume',
      'playback.rate',
      'playback.repeat',
      'playback.shuffle',
      'playback.seek',
    ]) {
      expect(getAssistantAction(id), id).toBeDefined()
    }
  })

  it('覆盖歌单 / 收藏 / 下载 / 搜索 / 导出 / 系统动作', () => {
    for (const id of [
      'playlist.create',
      'playlist.rename',
      'playlist.delete',
      'playlist.add-track',
      'playlist.remove-track',
      'playlist.list',
      'favorite.add',
      'favorite.remove',
      'favorite.list',
      'download.track',
      'download.playlist',
      'search.video',
      'export.mv-single',
      'system.check-version',
    ]) {
      expect(getAssistantAction(id), id).toBeDefined()
    }
  })
})

describe('动作注册表 · 设置项一一对应', () => {
  it('AppSettings 的每个字段都有 settings.set-<field> 动作', () => {
    const missing = SETTINGS_FIELDS.filter(f => !getAssistantAction(`settings.set-${f}`))
    expect(missing).toEqual([])
  })

  it('设置动作数量与 AppSettings 字段数一致，且不多不少', () => {
    const settingActions = ASSISTANT_ACTIONS.filter(a => a.group === 'settings')
    expect(settingActions.length).toBe(SETTINGS_FIELDS.length)
    // 反向：没有指向不存在字段的设置动作
    const fields = new Set<string>(SETTINGS_FIELDS)
    for (const action of settingActions) {
      expect(fields.has(action.id.slice('settings.set-'.length)), action.id).toBe(true)
    }
  })

  it('可写设置项都有必填参数，只读设置项 params 为空且标注只读', () => {
    const readOnly = [
    'autoLyricTextColor',
    'autoLyricControlColor',
    'themeSeedOverride',
    'lyricPresets',
    'equalizer',
  ]
    for (const field of SETTINGS_FIELDS) {
      const action = getAssistantAction(`settings.set-${field}`)
      expect(action, field).toBeDefined()
      if (!action) continue
      if (readOnly.includes(field)) {
        expect(action.params, field).toEqual([])
        expect(action.label, field).toContain('只读')
        expect(action.risk, field).toBe('safe')
      } else {
        expect(action.params.length, field).toBe(1)
        expect(action.params[0].required, field).toBe(true)
      }
    }
  })

  it('关键设置动作的枚举候选与代码里的联合类型一致', () => {
    const quality = getAssistantAction('settings.set-playQuality')
    expect(quality?.params[0].options?.map(o => o.value)).toEqual(['标准', '高品质', '无损'])

    const theme = getAssistantAction('settings.set-themeId')
    expect(theme?.params[0].options?.map(o => o.value)).toEqual(BUILTIN_THEMES.map(t => t.id))

    const cover = getAssistantAction('settings.set-coverFit')
    expect(cover?.params[0].options?.map(o => o.value)).toEqual(['cover', 'contain', 'fill'])

    const clean = getAssistantAction('settings.set-titleCleanMode')
    expect(clean?.params[0].options?.map(o => o.value)).toEqual(['off', 'rule', 'ai'])

    const repeat = getAssistantAction('playback.repeat')
    expect(repeat?.params[0].options?.map(o => o.value)).toEqual(['none', 'all', 'one', 'shuffle'])
  })
})

describe('动作注册表 · 风险分级', () => {
  it('MV 导出是 confirm（耗时且产生文件）', () => {
    expect(getAssistantAction('export.mv-single')?.risk).toBe('confirm')
  })

  it('删除歌单是 confirm（不可撤销）', () => {
    expect(getAssistantAction('playlist.delete')?.risk).toBe('confirm')
  })

  it('播放控制与改设置都是 safe', () => {
    expect(getAssistantAction('playback.play')?.risk).toBe('safe')
    expect(getAssistantAction('settings.set-playQuality')?.risk).toBe('safe')
  })

  it('check-version 只读：safe 且无参数，不执行 OTA', () => {
    const action = getAssistantAction('system.check-version')
    expect(action?.risk).toBe('safe')
    expect(action?.params).toEqual([])
  })

  it('OTA 更新 / 备份恢复 / 退出登录一律不在表里', () => {
    const forbidden = /ota|update-?app|install-?update|backup|restore|logout|sign-?out|login|退出登录|备份|恢复/
    const offenders = ASSISTANT_ACTIONS.filter(a => forbidden.test(a.id))
    expect(offenders.map(a => a.id)).toEqual([])
    // 也不许通过别名混进来
    const aliasOffenders = ASSISTANT_ACTIONS.filter(a =>
      a.aliases.some(alias => /备份|恢复备份|退出登录|注销|安装更新|立即更新/.test(alias)),
    )
    expect(aliasOffenders.map(a => a.id)).toEqual([])
  })

  it('只有 confirm 类动作会改数据，且 confirm 数量是可控的小集合', () => {
    const confirmIds = ASSISTANT_ACTIONS.filter(a => a.risk === 'confirm').map(a => a.id).sort()
    expect(confirmIds).toEqual(['export.mv-single', 'playlist.delete'])
  })
})

describe('getAssistantAction', () => {
  it('按 id 精确取，取不到返回 undefined', () => {
    expect(getAssistantAction('playback.next')?.label).toBe('下一首')
    expect(getAssistantAction('playback.nope')).toBeUndefined()
    expect(getAssistantAction('')).toBeUndefined()
  })
})

describe('matchActions', () => {
  it('空输入不返回任何候选', () => {
    expect(matchActions('')).toEqual([])
    expect(matchActions('   ')).toEqual([])
  })

  it('别名完全命中排第一', () => {
    expect(matchActions('加到歌单')[0].id).toBe('playlist.add-track')
    expect(matchActions('下一首')[0].id).toBe('playback.next')
    expect(matchActions('我的收藏')[0].id).toBe('favorite.list')
  })

  it('label 完全命中排第一', () => {
    expect(matchActions('添加歌曲到歌单')[0].id).toBe('playlist.add-track')
    expect(matchActions('导出当前歌曲 MV')[0].id).toBe('export.mv-single')
  })

  it('句子里的别名也能命中', () => {
    expect(matchActions('帮我暂停一下')[0].id).toBe('playback.pause')
    expect(matchActions('把这首歌加到歌单里')[0].id).toBe('playlist.add-track')
    expect(matchActions('给我来点随机播放')[0].id).toBe('playback.shuffle')
  })

  it('设置项能按别名命中', () => {
    expect(matchActions('音质')[0].id).toBe('settings.set-playQuality')
    expect(matchActions('换个主题')[0].id).toBe('settings.set-themeId')
    expect(matchActions('把歌词双语打开')[0].id).toBe('settings.set-lyricBilingual')
  })

  it('忽略首尾空白', () => {
    expect(matchActions('  下一首  ')[0].id).toBe('playback.next')
  })

  it('单字输入不做包含匹配，避免命中一大片', () => {
    const hits = matchActions('歌')
    expect(hits.length).toBeLessThan(ASSISTANT_ACTIONS.length)
  })

  it('完全无关的输入返回空', () => {
    expect(matchActions('今天天气怎么样')).toEqual([])
  })

  it('同分时顺序稳定（连续两次调用结果一致）', () => {
    const a = matchActions('歌单').map(x => x.id)
    const b = matchActions('歌单').map(x => x.id)
    expect(a).toEqual(b)
  })
})

describe('renderActionsForPrompt', () => {
  const text = renderActionsForPrompt()

  it('列出全部动作 id，一行一个', () => {
    for (const action of ASSISTANT_ACTIONS) {
      expect(text).toContain(action.id)
    }
    const lines = text.split('\n')
    expect(lines.filter(l => /^[a-z]+\.[a-zA-Z0-9-]+ /.test(l)).length).toBe(ASSISTANT_ACTIONS.length)
  })

  it('按 group 分组，每个分组标题都在', () => {
    for (const label of ['播放控制', '歌单', '收藏', '下载', '搜索', '导出', '设置', '系统']) {
      expect(text).toContain(`# ${label}`)
    }
  })

  it('不列别名，保持紧凑', () => {
    const action: AssistantAction | undefined = getAssistantAction('playlist.add-track')
    expect(action).toBeDefined()
    for (const alias of action?.aliases ?? []) {
      // 「加到歌单」是别名，提示词里只应出现 label 与参数名
      expect(text).not.toContain(alias)
    }
  })

  it('参数以 name:type 紧凑呈现，枚举给候选值', () => {
    expect(text).toContain('playlist.add-track 添加歌曲到歌单(track:track, playlist:playlist)')
    expect(text).toContain('mode:enum=none|all|one|shuffle')
  })

  it('confirm 与只读动作带标记', () => {
    expect(text).toMatch(/export\.mv-single .*\[需确认\]/)
    expect(text).toMatch(/settings\.set-lyricPresets .*\[只读\]/)
  })

  it('体积可控：不超过 6000 字符', () => {
    expect(text.length).toBeLessThan(6000)
  })
})

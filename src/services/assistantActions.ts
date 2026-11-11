/**
 * v1.4.14-pre9 对话助手 · 动作注册表（声明式）。
 *
 * 设计要点：
 * - **只声明，不执行**：本模块只描述「有哪些动作、要什么参数、风险多高」，
 *   执行函数放在别的模块（UI 层按 id 分发）。这样注册表本身是纯数据 + 纯函数，
 *   可以被单测完整覆盖，也不会把十几个下游副作用缠成一个巨大的 import 图。
 * - **新增功能只需加一行**：助手通过 renderActionsForPrompt 自动认识新动作，
 *   planAssistantRequest / UI 都不用改。
 * - **风险分级**：safe 直接执行；confirm 必须二次确认（删歌单、MV 导出）。
 *   语音/对话**永远不包含** OTA 更新、备份恢复、退出登录——它们根本不进这张表。
 *   「是不是最新版」是只读查询，单独一条 system.check-version，只查不升。
 * - **不碰 React、不发请求**：本文件只 import 类型和主题常量（纯数据）。
 */

import type { AppSettings } from '@/types'
import { BUILTIN_THEMES } from '@/theme/tokens'

/** 动作风险等级 */
export type ActionRisk = 'safe' | 'confirm'

/** 动作参数类型 */
export type ActionParamType = 'string' | 'number' | 'boolean' | 'enum' | 'track' | 'playlist'

export interface ActionParam {
  name: string
  type: ActionParamType
  /** 中文描述，会进提示词 */
  desc: string
  required: boolean
  /** type==='enum' 时的候选值 */
  options?: { value: string; label: string }[]
}

export interface AssistantAction {
  /** 唯一 id，如 'playlist.add-track'、'settings.set-quality' */
  id: string
  /** 中文名，如「添加歌曲到歌单」 */
  label: string
  /** 中文别名，用户可能怎么说，如 ['加到歌单','放进歌单'] */
  aliases: string[]
  /** 分组，用于 UI 分类展示：'playback'|'playlist'|'favorite'|'download'|'search'|'settings'|'export'|'system' */
  group: string
  risk: ActionRisk
  params: ActionParam[]
  /** 多步对话时，若缺少必填参数，要问的问题 */
  askFor?: (missing: string[]) => string
}

/* ---------- 参数构造小工具（纯语法糖，让下面的表能一行一个动作） ---------- */

function req(name: string, type: ActionParamType, desc: string, options?: ActionParam['options']): ActionParam {
  return options ? { name, type, desc, required: true, options } : { name, type, desc, required: true }
}

function opt(name: string, type: ActionParamType, desc: string): ActionParam {
  return { name, type, desc, required: false }
}

/* ---------- 播放 / 歌单 / 收藏 / 下载 / 搜索 / 导出 / 系统 ---------- */

const PLAYBACK_ACTIONS: AssistantAction[] = [
  {
    id: 'playback.play',
    label: '播放',
    aliases: ['播放', '开始播放', '继续播放', '放歌'],
    group: 'playback',
    risk: 'safe',
    params: [],
  },
  {
    id: 'playback.pause',
    label: '暂停',
    aliases: ['暂停', '暂停播放', '停一下'],
    group: 'playback',
    risk: 'safe',
    params: [],
  },
  {
    id: 'playback.next',
    label: '下一首',
    aliases: ['下一首', '切歌', '跳过这首', '换一首'],
    group: 'playback',
    risk: 'safe',
    params: [],
  },
  {
    id: 'playback.prev',
    label: '上一首',
    aliases: ['上一首', '回到上一首', '前一首'],
    group: 'playback',
    risk: 'safe',
    params: [],
  },
  {
    id: 'playback.volume',
    label: '调整音量',
    aliases: ['音量', '声音大小', '调大声音', '调小声音'],
    group: 'playback',
    risk: 'safe',
    params: [req('volume', 'number', '音量百分比 0–100')],
    askFor: () => '音量调到多少？（0–100）',
  },
  {
    id: 'playback.rate',
    label: '调整当前播放倍速',
    aliases: ['倍速', '播放速度', '加速播放', '慢放'],
    group: 'playback',
    risk: 'safe',
    params: [req('rate', 'number', '倍速，0.5–2.0')],
    askFor: () => '倍速调到多少？（0.5–2.0）',
  },
  {
    id: 'playback.repeat',
    label: '设置循环模式',
    aliases: ['循环', '单曲循环', '列表循环', '循环模式'],
    group: 'playback',
    risk: 'safe',
    params: [
      req('mode', 'enum', '循环模式', [
        { value: 'none', label: '不循环' },
        { value: 'all', label: '列表循环' },
        { value: 'one', label: '单曲循环' },
        { value: 'shuffle', label: '随机播放' },
      ]),
    ],
    askFor: () => '循环模式选哪种？不循环 / 列表循环 / 单曲循环 / 随机播放',
  },
  {
    id: 'playback.shuffle',
    label: '随机播放',
    aliases: ['随机播放', '打乱顺序', '随便放'],
    group: 'playback',
    risk: 'safe',
    params: [],
  },
  {
    id: 'playback.seek',
    label: '跳转播放进度',
    aliases: ['跳转', '快进', '跳到', '定位到'],
    group: 'playback',
    risk: 'safe',
    params: [req('position', 'string', '目标位置，如 1:30、90（秒）或 50%')],
    askFor: () => '跳到哪个位置？（如 1:30 或 50%）',
  },
]

const PLAYLIST_ACTIONS: AssistantAction[] = [
  {
    id: 'playlist.create',
    label: '新建歌单',
    aliases: ['新建歌单', '创建歌单', '建一个歌单', '做个歌单'],
    group: 'playlist',
    risk: 'safe',
    params: [req('name', 'string', '新歌单的名字')],
    askFor: () => '新歌单叫什么名字？',
  },
  {
    id: 'playlist.rename',
    label: '重命名歌单',
    aliases: ['重命名歌单', '歌单改名', '改歌单名'],
    group: 'playlist',
    risk: 'safe',
    params: [req('playlist', 'playlist', '要改名的歌单'), req('name', 'string', '新的歌单名')],
    askFor: missing => (missing[0] === 'playlist' ? '要改哪个歌单的名字？' : '新的名字叫什么？'),
  },
  {
    id: 'playlist.delete',
    label: '删除歌单',
    aliases: ['删除歌单', '删掉歌单', '清空歌单'],
    group: 'playlist',
    // 删除不可撤销，必须二次确认
    risk: 'confirm',
    params: [req('playlist', 'playlist', '要删除的歌单')],
    askFor: () => '要删除哪个歌单？',
  },
  {
    id: 'playlist.add-track',
    label: '添加歌曲到歌单',
    aliases: ['加到歌单', '放进歌单', '添加到歌单', '加入歌单'],
    group: 'playlist',
    risk: 'safe',
    params: [req('track', 'track', '要添加的歌曲'), req('playlist', 'playlist', '目标歌单')],
    askFor: missing => (missing[0] === 'playlist' ? '要添加到哪个歌单？' : '要添加哪首歌？'),
  },
  {
    id: 'playlist.remove-track',
    label: '从歌单移除歌曲',
    aliases: ['从歌单移除', '移出歌单', '从歌单删掉'],
    group: 'playlist',
    risk: 'safe',
    params: [req('track', 'track', '要移除的歌曲'), req('playlist', 'playlist', '来源歌单')],
    askFor: missing => (missing[0] === 'playlist' ? '从哪个歌单移除？' : '要移除哪首歌？'),
  },
  {
    id: 'playlist.list',
    label: '查看我的歌单',
    aliases: ['我的歌单', '有哪些歌单', '歌单列表', '看看歌单'],
    group: 'playlist',
    risk: 'safe',
    params: [],
  },
]

const FAVORITE_ACTIONS: AssistantAction[] = [
  {
    id: 'favorite.add',
    label: '收藏歌曲',
    aliases: ['收藏', '喜欢这首', '加到喜欢', '收藏这首'],
    group: 'favorite',
    risk: 'safe',
    // 省略 track 时执行器取当前播放曲目
    params: [opt('track', 'track', '要收藏的歌曲，省略则为当前播放')],
  },
  {
    id: 'favorite.remove',
    label: '取消收藏',
    aliases: ['取消收藏', '不再喜欢', '取消喜欢'],
    group: 'favorite',
    risk: 'safe',
    params: [opt('track', 'track', '要取消收藏的歌曲，省略则为当前播放')],
  },
  {
    id: 'favorite.list',
    label: '查看我的收藏',
    aliases: ['我的收藏', '收藏列表', '我喜欢的歌'],
    group: 'favorite',
    risk: 'safe',
    params: [],
  },
]

const DOWNLOAD_ACTIONS: AssistantAction[] = [
  {
    id: 'download.track',
    label: '下载歌曲',
    aliases: ['下载这首歌', '下载当前', '下这首歌'],
    group: 'download',
    risk: 'safe',
    params: [opt('track', 'track', '要下载的歌曲，省略则为当前播放')],
  },
  {
    id: 'download.playlist',
    label: '批量下载歌单',
    aliases: ['批量下载', '下载整个歌单', '下载歌单'],
    group: 'download',
    risk: 'safe',
    params: [req('playlist', 'playlist', '要批量下载的歌单')],
    askFor: () => '要批量下载哪个歌单？',
  },
]

const SEARCH_ACTIONS: AssistantAction[] = [
  {
    id: 'search.video',
    label: '搜索视频',
    aliases: ['搜索', '搜一下', '找一下', '帮我找'],
    group: 'search',
    risk: 'safe',
    params: [req('query', 'string', '搜索关键词')],
    askFor: () => '想搜什么？给我几个关键词。',
  },
]

const EXPORT_ACTIONS: AssistantAction[] = [
  {
    id: 'export.mv-single',
    label: '导出当前歌曲 MV',
    aliases: ['导出MV', '导出视频', '保存MV', '生成MV'],
    group: 'export',
    // 耗时且产生文件，走 confirm
    risk: 'confirm',
    params: [
      opt('track', 'track', '要导出的歌曲，省略则为当前播放'),
      opt('watermark', 'boolean', '是否加 BiliMusic 水印，省略则用设置里的开关'),
      opt('cleanExport', 'boolean', '是否导出无控件纯净版，省略则用设置里的开关'),
    ],
    askFor: () => '要导出哪首歌的 MV？',
  },
]

const SYSTEM_ACTIONS: AssistantAction[] = [
  {
    id: 'system.check-version',
    label: '检查是否有新版本（只读，不执行更新）',
    aliases: ['检查更新', '有没有新版本', '是不是最新版', '最新版本', '查一下版本'],
    group: 'system',
    // 只查不升：OTA 下载/安装永远不进语音
    risk: 'safe',
    params: [],
  },
]

/* ---------- 设置项：AppSettings 每个字段一条动作 ---------- */

/**
 * 一个设置字段的动作规格。
 * `param` 缺省 = 该字段是派生值或结构体，助手只能查不能说（见下方 READONLY 说明）。
 */
interface SettingSpec {
  field: keyof AppSettings
  label: string
  aliases: string[]
  param?: ActionParam
  ask?: (missing: string[]) => string
}

/**
 * 34 个 AppSettings 字段，一一对应。
 *
 * 其中 5 个**只读**（params 为空、label 标注「只读」）：
 * - autoLyricTextColor / autoLyricControlColor：由封面/背景采样算出的派生色，
 *   写它等于伪造一次自动取色结果，下次采样就会被覆盖，让用户「设置」它没有意义。
 * - themeSeedOverride：Partial<ThemeSeed> 结构体（primary/secondary/accent 三项），
 *   自然语言没法安全表达「只覆盖次要色」这种操作，交给设置页的主题面板。
 * - lyricPresets：LyricStylePreset[] 数组，同样是结构体。
 * - equalizer：EqualizerSettings 结构体（开关 + 预设名 + 十段增益三者必须自洽），
 *   「低频多一点」这类说法无法安全映射成十段 dB 值，写它容易写出界面显示与曲线对不上的状态。
 * 保留它们（而不是删掉）是为了让「每个字段都有动作」成为一条可断言的不变式——
 * 将来给 AppSettings 加字段，测试会立刻红掉并提醒补动作。
 */
const SETTING_SPECS: SettingSpec[] = [
  {
    field: 'sidebarState',
    label: '侧边栏状态',
    aliases: ['侧边栏', '侧栏'],
    param: req('sidebarState', 'enum', '侧边栏展开方式', [
      { value: 'expanded', label: '展开' },
      { value: 'collapsed', label: '收起' },
      { value: 'auto', label: '自动' },
    ]),
  },
  {
    field: 'playQuality',
    label: '播放音质',
    aliases: ['音质', '播放音质'],
    param: req('playQuality', 'enum', '播放音质', [
      { value: '标准', label: '标准' },
      { value: '高品质', label: '高品质' },
      { value: '无损', label: '无损' },
    ]),
  },
  {
    field: 'downloadQuality',
    label: '下载音质',
    aliases: ['下载音质'],
    param: req('downloadQuality', 'enum', '下载音质', [
      { value: '标准', label: '标准' },
      { value: '高品质', label: '高品质' },
      { value: '无损', label: '无损' },
    ]),
  },
  {
    field: 'downloadFormat',
    label: '下载格式',
    aliases: ['下载格式'],
    param: req('downloadFormat', 'enum', '下载产物格式', [
      { value: 'audio', label: '音频' },
      { value: 'video', label: '视频' },
    ]),
  },
  {
    field: 'downloadDir',
    label: '下载目录',
    aliases: ['下载目录', '下载路径'],
    param: req('downloadDir', 'string', '下载保存的目录路径'),
  },
  {
    field: 'autoPlay',
    label: '自动播放',
    aliases: ['自动播放'],
    param: req('autoPlay', 'boolean', '是否自动播放'),
  },
  {
    field: 'showLyrics',
    label: '显示歌词',
    aliases: ['显示歌词', '歌词开关'],
    param: req('showLyrics', 'boolean', '是否显示歌词'),
  },
  {
    field: 'lyricTextColor',
    label: '歌词文字颜色',
    aliases: ['歌词颜色', '歌词文字色'],
    param: req('lyricTextColor', 'string', '十六进制颜色，如 #ffffff'),
  },
  {
    field: 'lyricControlColor',
    label: '歌词控件颜色',
    aliases: ['歌词控件色'],
    param: req('lyricControlColor', 'string', '十六进制颜色，如 #ff375f'),
  },
  {
    field: 'lyricFontSize',
    label: '歌词字号',
    aliases: ['歌词字号', '歌词大小'],
    param: req('lyricFontSize', 'number', '歌词字号（像素）'),
  },
  {
    field: 'lyricFontWeight',
    label: '歌词粗细',
    aliases: ['歌词粗细', '字重'],
    param: req('lyricFontWeight', 'number', '歌词字重（100–900）'),
  },
  {
    field: 'lyricFontFamily',
    label: '桌面歌词字体',
    aliases: ['歌词字体'],
    param: req('lyricFontFamily', 'string', '字体族名，如 system-ui'),
  },
  {
    field: 'titleFontFamily',
    label: '标题栏字体',
    aliases: ['标题字体'],
    param: req('titleFontFamily', 'string', '字体族名，如 system-ui'),
  },
  {
    field: 'playerLyricFontFamily',
    label: '播放页歌词字体',
    aliases: ['播放页字体'],
    param: req('playerLyricFontFamily', 'string', '字体族名，如 system-ui'),
  },
  {
    field: 'autoTextColor',
    label: '自动歌词文字色',
    aliases: ['自动歌词色', '自动文字色'],
    param: req('autoTextColor', 'boolean', '是否从封面自动取歌词文字色'),
  },
  {
    field: 'autoControlColor',
    label: '自动控件色',
    aliases: ['自动控件色'],
    param: req('autoControlColor', 'boolean', '是否从背景自动取控件色'),
  },
  // 只读：派生色，由自动取色算出
  { field: 'autoLyricTextColor', label: '（只读）自动算出的歌词文字色，由系统从封面计算', aliases: ['自动算出的歌词色'] },
  { field: 'autoLyricControlColor', label: '（只读）自动算出的控件色，由系统从背景计算', aliases: ['自动算出的控件色'] },
  {
    field: 'autoAiLyricForeign',
    label: '外文歌词自动 AI 增强',
    aliases: ['外文歌词增强', 'AI歌词增强'],
    param: req('autoAiLyricForeign', 'boolean', '缺译文时是否自动做 AI 增强（会消耗额度）'),
  },
  {
    field: 'desktopLyricSubline',
    label: '桌面歌词副行',
    aliases: ['歌词副行', '显示译文行'],
    param: req('desktopLyricSubline', 'boolean', '主行下方是否显示译文 / AI 增强副行'),
  },
  {
    field: 'mvWatermark',
    label: 'MV 水印',
    aliases: ['水印', 'MV水印'],
    param: req('mvWatermark', 'boolean', '导出 MV 是否加 BiliMusic 水印'),
  },
  {
    field: 'mvSmoothness',
    label: 'MV 流畅度',
    aliases: ['流畅度', '导出流畅度'],
    param: req('mvSmoothness', 'enum', 'MV 导出流畅度档位', [
      { value: '快速', label: '快速' },
      { value: '标准', label: '标准' },
      { value: '流畅', label: '流畅' },
      { value: '极致', label: '极致' },
    ]),
  },
  {
    field: 'playbackRate',
    label: '默认播放倍速',
    aliases: ['默认倍速'],
    param: req('playbackRate', 'number', '默认倍速，0.5–2.0'),
  },
  {
    field: 'globalMediaKeys',
    label: '全局媒体键',
    aliases: ['媒体键', '全局快捷键'],
    param: req('globalMediaKeys', 'boolean', '是否注册全局媒体键'),
  },
  {
    field: 'themeId',
    label: '主题',
    aliases: ['主题', '配色方案', '换肤'],
    param: req(
      'themeId',
      'enum',
      '内置主题 id',
      BUILTIN_THEMES.map(t => ({ value: t.id, label: t.name })),
    ),
  },
  // 只读：Partial<ThemeSeed> 结构体
  { field: 'themeSeedOverride', label: '（只读）主题基色覆盖项，结构体，请在设置页主题面板修改', aliases: ['主题覆盖色'] },
  // 只读：LyricStylePreset[] 结构体
  { field: 'lyricPresets', label: '（只读）歌词窗样式预设库，结构体，请在设置页管理', aliases: ['歌词预设'] },
  // 只读：EqualizerSettings 结构体（enabled / preset / 十段增益三项联动），
  // 自然语言说「低频多一点」没法安全映射成十段 dB 值，交给设置页的均衡器面板。
  { field: 'equalizer', label: '（只读）均衡器设置，结构体，请在设置页均衡器面板调整', aliases: ['均衡器', 'EQ'] },
  {
    field: 'audioVisualizer',
    label: '音频可视化',
    aliases: ['频谱', '可视化'],
    param: req('audioVisualizer', 'boolean', '播放页是否显示频谱可视化'),
  },
  {
    field: 'crossfadeEnabled',
    label: '淡入淡出切歌',
    aliases: ['淡入淡出', '交叉淡化', '切歌渐变'],
    param: req('crossfadeEnabled', 'boolean', '切歌时是否淡出淡入'),
  },
  {
    field: 'crossfadeSeconds',
    label: '淡入淡出时长',
    aliases: ['渐变时长', '切歌时长'],
    // number 而非 enum：允许任意 1~10 秒。钳制在消费侧（normalizeCrossfadeSeconds），
    // 这里不做枚举是为了不把「3.5 秒」这类合法输入挡在门外。
    param: req('crossfadeSeconds', 'number', '淡入淡出总时长（秒，1~10）'),
  },
  {
    field: 'lyricBilingual',
    label: '歌词双语',
    aliases: ['双语歌词'],
    param: req('lyricBilingual', 'boolean', '是否原词与译文同行显示'),
  },
  {
    field: 'mvCleanExport',
    label: 'MV 纯净导出',
    aliases: ['纯净导出', '无控件导出'],
    param: req('mvCleanExport', 'boolean', '导出 MV 时是否隐藏控件'),
  },
  {
    field: 'coverFit',
    label: '封面取景',
    aliases: ['封面裁切', '封面填充'],
    param: req('coverFit', 'enum', '封面填充方式', [
      { value: 'cover', label: '铺满裁切' },
      { value: 'contain', label: '完整显示' },
      { value: 'fill', label: '拉伸填满' },
    ]),
  },
  {
    field: 'titleCleanMode',
    label: '歌名清洗模式',
    aliases: ['歌名清洗', '标题清洗'],
    param: req('titleCleanMode', 'enum', '喂给 AI 前的标题清洗方式', [
      { value: 'off', label: '关闭' },
      { value: 'rule', label: '规则清洗' },
      { value: 'ai', label: 'AI 清洗' },
    ]),
  },
  {
    field: 'aiExternalRecommend',
    label: '池外推荐',
    aliases: ['池外推荐', '额外推荐'],
    param: req('aiExternalRecommend', 'boolean', '是否在歌单/收藏之外额外推荐（消耗更高）'),
  },
]

const SETTINGS_ACTIONS: AssistantAction[] = SETTING_SPECS.map(spec => {
  const action: AssistantAction = {
    id: `settings.set-${spec.field}`,
    label: spec.label,
    aliases: spec.aliases,
    group: 'settings',
    risk: 'safe',
    params: spec.param ? [spec.param] : [],
  }
  if (spec.param) {
    action.askFor = spec.ask ?? (() => `${spec.label}设成什么？`)
  }
  return action
})

/* ---------- 注册表 ---------- */

/** 所有动作的声明（不含执行函数，执行函数在另一个模块，避免循环依赖） */
export const ASSISTANT_ACTIONS: AssistantAction[] = [
  ...PLAYBACK_ACTIONS,
  ...PLAYLIST_ACTIONS,
  ...FAVORITE_ACTIONS,
  ...DOWNLOAD_ACTIONS,
  ...SEARCH_ACTIONS,
  ...EXPORT_ACTIONS,
  ...SYSTEM_ACTIONS,
  ...SETTINGS_ACTIONS,
]

const ACTION_BY_ID = new Map<string, AssistantAction>(ASSISTANT_ACTIONS.map(a => [a.id, a]))

/** 按 id 查 */
export function getAssistantAction(id: string): AssistantAction | undefined {
  return ACTION_BY_ID.get(id)
}

/**
 * 按用户文本模糊匹配动作（别名 + label 子串），返回候选。
 *
 * 排序：完全等于某条别名 > 完全等于 label > 文本里含某条别名（别名越长越靠前）
 * > 别名/label 含输入（输入越长越靠前）。单字输入不参与「包含」匹配，避免命中一大片。
 */
export function matchActions(text: string): AssistantAction[] {
  const q = text.trim().toLowerCase()
  if (!q) return []

  const scored: { action: AssistantAction; score: number }[] = []
  for (const action of ASSISTANT_ACTIONS) {
    let score = 0
    for (const alias of action.aliases) {
      const a = alias.toLowerCase()
      if (a === q) score = Math.max(score, 1000 + a.length)
      else if (q.includes(a)) score = Math.max(score, 500 + a.length)
      else if (q.length >= 2 && a.includes(q)) score = Math.max(score, 100 + q.length)
    }
    const label = action.label.toLowerCase()
    if (label === q) score = Math.max(score, 900)
    else if (q.includes(label)) score = Math.max(score, 400 + label.length)
    else if (q.length >= 2 && label.includes(q)) score = Math.max(score, 80 + q.length)

    if (score > 0) scored.push({ action, score })
  }

  // 同分时保持注册表顺序，保证输出稳定可测
  scored.sort((x, y) => y.score - x.score)
  return scored.map(s => s.action)
}

/* ---------- 提示词渲染 ---------- */

const GROUP_LABELS: Record<string, string> = {
  playback: '播放控制',
  playlist: '歌单',
  favorite: '收藏',
  download: '下载',
  search: '搜索',
  export: '导出',
  settings: '设置（id 前缀 settings.set-）',
  system: '系统',
}

const GROUP_ORDER = ['playback', 'playlist', 'favorite', 'download', 'search', 'export', 'settings', 'system']

/** 只读动作（params 为空且 label 以「（只读）」开头） */
function isReadOnly(action: AssistantAction): boolean {
  return action.params.length === 0 && action.label.startsWith('（只读）')
}

function renderParam(param: ActionParam): string {
  const options = param.type === 'enum' && param.options?.length
    ? `=${param.options.map(o => o.value).join('|')}`
    : ''
  const optional = param.required ? '' : '?'
  return `${param.name}${optional}:${param.type}${options}`
}

/**
 * 把动作清单渲染成提示词段落（供 aiChatAssistant 使用）。
 *
 * 紧凑策略：按 group 分块，每个动作**一行**，只给 id + label + 参数名与类型；
 * 不列 aliases（模型认 label 就够，别名是给 matchActions 做本地兜底的），
 * 枚举只在行内给候选值，不展开成子项。
 */
export function renderActionsForPrompt(): string {
  const lines: string[] = [
    '【可执行动作】每行格式：<动作 id> <中文名>(参数)。',
    '参数写作 名称:类型，可选的加 ?；枚举用 =a|b|c 给候选值。',
    '[需确认] 的动作必须先把动作和参数说清楚、等用户明确同意再执行。',
    '[只读] 的动作只查询，不改变任何东西。',
  ]

  const groups = new Map<string, AssistantAction[]>()
  for (const action of ASSISTANT_ACTIONS) {
    const bucket = groups.get(action.group)
    if (bucket) bucket.push(action)
    else groups.set(action.group, [action])
  }

  const ordered = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a)
    const ib = GROUP_ORDER.indexOf(b)
    return (ia < 0 ? GROUP_ORDER.length : ia) - (ib < 0 ? GROUP_ORDER.length : ib)
  })

  for (const group of ordered) {
    const actions = groups.get(group) ?? []
    lines.push('')
    lines.push(`# ${GROUP_LABELS[group] ?? group}`)
    for (const action of actions) {
      const params = action.params.length ? `(${action.params.map(renderParam).join(', ')})` : ''
      const marks = [action.risk === 'confirm' ? '[需确认]' : '', isReadOnly(action) ? '[只读]' : '']
        .filter(Boolean)
        .join('')
      lines.push(`${action.id} ${action.label}${params}${marks}`)
    }
  }

  return lines.join('\n')
}

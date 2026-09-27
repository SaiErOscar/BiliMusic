/**
 * 内置使用说明文案（本地化）。
 *
 * 设计约定：
 * - 文案按语言 key 组织（HELP_CONTENT[lang]），新增语言只需补一个分支，不动组件。
 * - 当前界面为简体中文，仅提供 zh；en 留空占位，待接入全局 i18n 时填充。
 * - getHelpContent() 是组件唯一的取数入口，未来接语言切换只需在此按 locale 选择。
 */

export type HelpLang = 'zh' | 'en'

export interface HelpSection {
  /** 分节小标题 */
  title: string
  /** 分节下的要点列表 */
  items: string[]
}

export interface HelpContent {
  /** 弹窗主标题 */
  title: string
  /** 弹窗副标题（引导语） */
  subtitle: string
  /** 分节内容 */
  sections: HelpSection[]
  /** 底部致谢 / 版权行 */
  footer: string
}

const zh: HelpContent = {
  title: '使用说明',
  subtitle: 'BiliMusic 把 B 站变成你的音乐库，下面是几分钟上手指南。',
  sections: [
    {
      title: '搜索与播放',
      items: [
        '在顶部搜索框输入歌名、UP 主或视频关键词，结果以专辑 / 歌曲列表展示。',
        '点击曲目即可播放，支持下一首播放、加入队列、添加到歌单。',
        '底部播放栏提供播放暂停、上一首下一首、循环随机、进度与音量控制。',
        '「发现」页聚合最近播放、我喜欢、B 站收藏夹、本地下载四类入口。',
      ],
    },
    {
      title: '登录 B 站账号',
      items: [
        '进入「设置 → 账号」，可用扫码、账号密码或手机验证码登录。',
        '登录页为 B 站官方窗口，人机验证由官方页处理，成功后应用自动同步 Cookie。',
        '登录后即可读取你的收藏夹，并与本地歌单双向同步。',
      ],
    },
    {
      title: '下载音乐',
      items: [
        '在曲目上点下载按钮，可选音频（m4a/flac）或视频（MP4）。',
        '「修改文件属性」与「下载歌词 (.lrc)」是两个独立开关，可分别勾选。',
        '歌单或 B 站收藏夹支持一键批量下载，下载可在后台继续、随时恢复进度。',
        '下载记录含原视频链接，可在「下载」页查看。',
      ],
    },
    {
      title: '歌词与桌面歌词',
      items: [
        '播放页自动匹配歌词，支持手动搜索选择版本、按曲目调整时间偏移。',
        '「设置 → 外观」或播放页可开启桌面歌词，歌词悬浮显示在桌面上。',
        '开启后，任务栏托盘右键菜单也能一键打开 / 关闭桌面歌词。',
        '桌面歌词支持配色、字体与全局取色，可在歌词窗内直接调整。',
      ],
    },
    {
      title: '歌单与同步',
      items: [
        '本地歌单支持创建、编辑、导入导出，可在「设置」里迁移歌单。',
        '配置 WebDAV 后，歌单与设置可在多设备间云同步。',
      ],
    },
    {
      title: '更新与更多',
      items: [
        '「设置 → 关于」可检查更新，应用支持界面与安装包增量更新。',
        '更多功能介绍与源码请见项目 GitHub 主页。',
      ],
    },
  ],
  footer: '感谢你使用 BiliMusic，祝听歌愉快。',
}

const en: HelpContent | null = null

const HELP_CONTENT: Record<HelpLang, HelpContent | null> = { zh, en }

/** 当前界面语言。未来接入全局 i18n 时，改为读取用户语言设置即可。 */
export function resolveHelpLang(): HelpLang {
  return 'zh'
}

/**
 * 取使用说明文案。若目标语言尚未提供内容，回退到中文，保证弹窗永不为空。
 */
export function getHelpContent(lang: HelpLang = resolveHelpLang()): HelpContent {
  return HELP_CONTENT[lang] ?? HELP_CONTENT.zh!
}

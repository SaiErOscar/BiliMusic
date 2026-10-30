export interface Track {
  id: string
  title: string
  artist: string
  coverUrl: string
  duration: number
  videoUrl: string
  bvid: string
  // 音乐中心曲目的顶层 avid+cid：当 bvid 稿件不存在（-404）时回退直取音乐流
  aid?: string | number
  cid?: string | number
  playCount: number
  isLiked: boolean
  likedAt?: string // 收藏时间，供云同步按 like/unlike 时间合并
  addedAt?: string // 加入歌单时间，供歌单内按加入时间排序
}

export interface Playlist {
  id: string
  name: string
  description?: string
  coverUrl: string
  tracks: Track[]
  createdAt: string
  updatedAt: string
}

// 删除墓碑：双向同步时区分「在此端删除」与「此端从未有过」，避免删除项被对端复活
export interface Tombstone {
  id: string
  deletedAt: string
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type RepeatMode = 'none' | 'all' | 'one' | 'shuffle'
export type SidebarState = 'expanded' | 'collapsed' | 'auto'
export type DownloadFormat = 'audio' | 'video'

export interface DownloadRecord {
  id: string
  title: string
  artist: string
  bvid: string
  /** 音频/视频下载；v1.4.6 新增 'mv'（导出播放界面视频） */
  format: DownloadFormat | 'mv'
  quality: string
  filename: string
  downloadDir: string
  /** v1.4.6-pre4：实际产物绝对路径（同名防覆盖改写后的真实位置）；旧记录可能缺失，UI 以 downloadDir+filename 兜底推算 */
  filePath?: string
  /** v1.4.8-pre4：B 站视频封面；旧记录可能缺失，列表按 bvid 懒加载补齐 */
  coverUrl?: string
  downloadedAt: string
}

/** v1.4.9-pre1 主题体系化：用户在内置主题上覆盖的基色，只存改过的项 */
export interface ThemeSeedOverride {
  primary?: string
  secondary?: string
  accent?: string
}

/** v1.4.9-pre1 歌词窗样式预设：一组可命名的歌词窗外观项 */
export interface LyricStylePreset {
  id: string
  name: string
  lyricTextColor: string
  lyricControlColor: string
  lyricFontSize: number
  lyricFontWeight: number
  lyricFontFamily: string
}

export interface AppSettings {
  sidebarState: SidebarState
  playQuality: '标准' | '高品质' | '无损'
  downloadQuality: '标准' | '高品质' | '无损'
  downloadFormat: DownloadFormat
  downloadDir: string
  autoPlay: boolean
  showLyrics: boolean
  // 桌面歌词配色（hex，如 #ffffff / #ff375f）
  lyricTextColor: string
  lyricControlColor: string
  // 桌面歌词字号/粗细（v1.3.6 外观小面板）
  lyricFontSize: number
  lyricFontWeight: number
  // v1.3.8 字体选项（三面板独立）：桌面歌词 / 标题栏+播放条 / 播放页歌词
  lyricFontFamily: string
  titleFontFamily: string
  playerLyricFontFamily: string
  // v1.3.10 自动颜色开关：歌词文字色（封面提色）/ 控件色（窗周围背景采样），独立生效
  autoTextColor: boolean
  autoControlColor: boolean
  // v1.3.10 自动色算出的实际颜色（与手动色 lyricTextColor/lyricControlColor 分离）：
  // 手动色永不被自动色覆盖，关闭开关即回到开启前的手动色；歌词窗按「开关开且自动色就绪」时显示自动色。
  autoLyricTextColor: string
  autoLyricControlColor: string
  /**
   * v1.4.13-pre11 桌面歌词：外文歌词在缺少译文时自动做 AI 增强。
   * 默认关闭——它会消耗 API 额度，不该在用户不知情时发生。
   */
  autoAiLyricForeign: boolean
  /** v1.4.13-pre11 桌面歌词：主行下方显示副行（译文 / AI 增强） */
  desktopLyricSubline: boolean
  // v1.4.6 MV 导出：画面角落 BiliMusic 水印开关（默认开）
  mvWatermark: boolean
  // v1.4.7-pre1 MV 导出：流畅度档位（快速 0.15s/标准 0.1s/流畅 0.05s/极致 0.03s 关键帧步长）
  mvSmoothness: '快速' | '标准' | '流畅' | '极致'
  // v1.4.8-pre1 播放三件套：倍速播放档位（0.5/0.75/1/1.25/1.5/1.75/2.0）
  playbackRate: number
  // v1.4.8-pre1 桌面全局媒体键开关（Electron globalShortcut，失焦也生效）
  // 默认关闭，避免抢占其他播放器的系统媒体键
  globalMediaKeys: boolean
  // v1.4.9-pre1 主题体系化：所选内置主题 id（default = BiliBili 粉，即 index.css 默认值）
  themeId: string
  // v1.4.9-pre1：在所选主题基色上的覆盖项（空对象表示用主题原色）
  themeSeedOverride: ThemeSeedOverride
  // v1.4.9-pre1：歌词窗样式预设库
  lyricPresets: LyricStylePreset[]
  // v1.4.9-pre2 音频可视化：播放页频谱可视化开关
  // 桌面端默认关：关闭时播放源沿用 CDN 直链，起播延迟与原行为一致；
  // 开启后才切 Blob（Web Audio 需要同源音频），移动端本就走 Blob 分支，无额外代价。
  audioVisualizer: boolean
  // v1.4.9-pre2 歌词双语：网易源 tlyric 翻译行与原词同行显示（无翻译时自然回退单语）
  lyricBilingual: boolean
  // v1.4.9-pre3 MV 无控件导出：隐藏进度条/时间/播放按钮/音量/循环，只留封面、歌曲信息、
  // 歌词与水印（对应播放页「鼠标静止后控件淡出」的纯净观感）
  mvCleanExport: boolean
  // v1.4.11-pre2 封面取景（播放页与 MV 导出共用同一开关，保证两端观感统一）：
  //   cover   = 裁切居中铺满方框，不拉伸不留白（默认，与 v1.4.10/pre1 现状一致）
  //   contain = 保持原比例完整显示，比例不符时留白
  //   fill    = 非等比拉伸填满方框（画面会变形）
  // contain 时容器改为跟随封面真实比例（见 useCoverAspect / COVER_ASPECT_LIMIT）
  coverFit: CoverFitMode
}

/**
 * v1.4.11-pre2 封面取景模式。
 * 命名对齐 CSS object-fit 的三个取值，便于直接把模式名映射成样式，不必再维护一张对照表。
 */
export type CoverFitMode = 'cover' | 'contain' | 'fill'

/**
 * v1.4.11-pre3 AI 底座：OpenAI 兼容 Provider 配置。
 *
 * 密钥安全口径（用户明确要求）：绝不写注册表、必须加密落盘、导出全部数据时一并导出。
 * 落盘在主进程完成（electron/ai.ts，safeStorage 加密），渲染层这份结构只是透传载体，
 * 不进 localStorage、不进 AppSettings。
 */
export interface AiProviderConfig {
  /** OpenAI 兼容 baseURL，如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 模型名，如 deepseek-chat */
  model: string
  /** API 密钥（内存明文；落盘由主进程加密） */
  apiKey: string
  /** 代理模式：system = 跟随系统（默认）；manual = 独占使用 proxyUrl */
  proxyMode: 'system' | 'manual'
  /** 手动代理地址，如 http://127.0.0.1:7890 */
  proxyUrl: string
}

/**
 * v1.4.12-pre2 推荐触发方式。
 * auto = 打开发现页即生成；click = 点按钮才请求（默认，省费用）；off = 不显示推荐板块
 */
export type AiRecommendMode = 'auto' | 'click' | 'off'

/**
 * v1.4.12-pre2 用户画像 —— 与「听歌画像」是两件事：
 * - 听歌画像：由播放统计自动聚合的听歌习惯摘要（只读、数据驱动）
 * - 用户画像：用户可自行查看与修改的自我描述（偏好、场景、禁忌），用于个性化推荐
 *
 * 隐私口径（必须在 UI 写明）：**只存本地；仅在使用 AI 功能时随请求发送给你所配置的
 * AI 服务商；绝不上传开发者**——本应用没有任何开发者侧上报通道。
 */
export interface AiUserProfile {
  text: string
  updatedAt: string
}

/** 完整 AI 设置 = Provider 配置 + 推荐模式 + 用户画像 + 人设 */
export interface AiSettings extends AiProviderConfig {
  recommendMode: AiRecommendMode
  userProfile: AiUserProfile
  /**
   * v1.4.13-pre4 AI 人设：影响发现页推荐问候语的语气与表达风格。
   *
   * 与「用户画像」互补——画像是「关于我」，人设是「我希望你用什么口吻跟我说话」。
   * 只影响语言表述，不改变挑选逻辑。
   */
  persona: string
  /**
   * v1.4.13-pre4 AI 来源：
   * - provider：走下方 baseUrl + apiKey 的 OpenAI 兼容服务
   * - workbuddy：走 WorkBuddy 账号（本地凭据或网页登录），模型名用 wbModel
   */
  source?: 'provider' | 'workbuddy'
  /** WorkBuddy 区域（决定走国内还是国际网关） */
  wbRegion?: 'cn' | 'global'
  /** WorkBuddy 模型 id */
  wbModel?: string
  /**
   * v1.4.13-pre11 API 记忆：用户保存过的每一套直连配置。
   *
   * 切换预设、输入新地址或切到 WorkBuddy 时**不再清除**原有 API，
   * 而是留在这里，之后可在下拉里一键切回；只有显式点「清除」才移除。
   * 密钥与当前配置同级加密，不额外落明文。
   */
  savedApis?: SavedApi[]
}

/** 一套被记住的直连配置（不含 WorkBuddy，它由账号凭据维护） */
export interface SavedApi {
  /** 稳定 id，用于下拉选中与删除 */
  id: string
  /** 展示名，缺省用地址主机名 */
  label: string
  baseUrl: string
  model: string
  /** 上次保存时的密钥；仅本地加密存储 */
  apiKey?: string
  /** 最近一次使用时间（epoch ms），用于排序 */
  usedAt?: number
}

export type NavItem = {
  icon: string
  label: string
  path: string
}

export interface UserInfo {
  isLogin: boolean
  mid: number
  uname: string
  face: string
  vipType: number
  vipStatus: number
}

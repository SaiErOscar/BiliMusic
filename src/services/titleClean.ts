/**
 * v1.4.14-pre4 曲目标题清洗：把 B 站视频标题里的噪声（【4K】【翻唱】【中文字幕】、emoji、
 * UP 主前缀、播放量、时长）去掉，再交给后续的曲目理解 / 推荐使用。
 *
 * 两种模式由用户在设置里自选：
 * - rule：复用 lyrics.ts 的 cleanTitle（它同时被歌词搜索依赖，口径必须保持一致），
 *   并在它之前/之后做**二次整理**补它的盲区。纯函数、零成本、确定性。
 * - ai：独立发一次 aiChat 请求，只洗一个标题。用户明确要求「不在一次请求中，避免幻觉」，
 *   所以它绝不和曲目理解 / 推荐揉进同一段对话；返回不可信时静默退回 rule。
 *
 * 为什么是「二次整理」而不是重写一套规则：cleanTitle 的正则已经被下载与歌词匹配依赖，
 * 另写一套会让同一条标题在「搜歌词」和「喂 AI」两个场景下得到不同结果。
 *
 * 实测盲区（用真实 B 站标题跑 cleanTitle 得到，二次整理逐条对治）：
 *   【某UP主】晴天 - 周杰伦        -> 某UP主 晴天 周杰伦    （UP 主前缀被留下）
 *   告白气球 周杰伦 1.2万播放      -> ... 1 2万播放         （小数点被拆开，播放量残留）
 *   五月天 - 温柔 [完整版] 3:45    -> 五月天 温柔 3 45      （时长被拆成两个数字）
 *   薛之谦《演员》 - 官方版 1080P  -> 薛之谦 演员 1080P     （分辨率残留）
 *   【纯享版】夜曲 - 周杰伦 高清   -> 夜曲 周杰伦 高清      （「高清」未收录在 NOISE 里）
 *   【歌单】100首华语经典 一小时   -> 100 华语经典          （计数前缀残留）
 * 前四条必须在调用 cleanTitle **之前**处理：它会把【】整段删掉，事后就找不到前缀了。
 */

import { aiChat, getAiConfig } from '@/services/ai'
import { isAiConfigured } from '@/services/aiTrackInsight'
import { cleanTitle } from '@/services/lyrics'
import type { AiSettings, AppSettings } from '@/types'

/** 清洗模式：off 用原标题 / rule 程序清洗 / ai 模型清洗 */
export type TitleCleanMode = 'off' | 'rule' | 'ai'

/** 清洗结果来源，便于排查「这条为什么长这样」 */
export type TitleCleanSource = 'off' | 'rule' | 'ai' | 'ai-fallback-rule'

export interface TitleCleanResult {
  title: string
  source: TitleCleanSource
}

export interface TitleCleanOptions {
  /** 显式指定模式；缺省读 settings.titleCleanMode，再缺省按 rule */
  mode?: TitleCleanMode
  /** 用于取默认模式；ai 配置也可以放在 settings.ai 里 */
  settings?: Partial<AppSettings> & { ai?: AiSettings }
  /** AI 配置；不传时尝试 settings.ai */
  aiConfig?: AiSettings
}

/** 三档的中文标签，设置页与文档共用一份，避免两处各写一套 */
export const TITLE_CLEAN_MODE_LABELS: Record<TitleCleanMode, string> = {
  off: '不清洗（用原标题）',
  rule: '程序清洗（快、免费）',
  ai: 'AI 清洗（更准、消耗额度）',
}

/** 老用户没有该字段时按 rule 兜底；值非法也按 rule（不抛错、不崩设置页） */
export function resolveTitleCleanMode(mode: unknown): TitleCleanMode {
  return mode === 'off' || mode === 'rule' || mode === 'ai' ? mode : 'rule'
}

// ===== 二次整理的规则（补 cleanTitle 的盲区，不推翻它） =====

/** 尾部播放量 / 弹幕数 / 点赞数：「1.2万播放」「3.4亿播放」「12万观看」 */
const TAIL_STAT =
  /\s*[\d.]+\s*[万亿千百]?\s*次?\s*(?:播放|观看|弹幕|点赞|收藏|评论|投币|人看过|人在看)\s*$/u

/** 尾部纯时长：「3:45」「01:02:03」「3分45秒」 */
const TAIL_TIME = /\s*(?:\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\s*分\s*\d{1,2}\s*秒|\d{1,2}\s*分钟?)\s*$/u

/** 残留分辨率 / 帧率 / 画质词：1080P、4K、60FPS、HDR、Hi-Res、高清、超清 */
const RESIDUAL_TAG =
  /\b(?:\d{3,4}\s*[pPiI]|[248]\s*[kK]|\d{2}\s*[fF][pP][sS]|hdr|hires|hi-?res|flac|mp3|wav)\b|高清|超清|蓝光|原画/giu

/** 首尾的纯分隔符残片（只剩 -、|、·、/ 之类） */
const DANGLING_SEP =
  /^[\s\-–—_|/\\·•～~「」『』"'\x60*:：，,;；]+|[\s\-–—_|/\\·•～~「」『』"'\x60*:：，,;；]+$/gu

/** 行首括号段：【某UP主】、[某某]、（某某） */
const LEAD_BRACKET = /^\s*[【[（(]\s*([^】\]）)]{1,24})\s*[】\]）)]\s*/u

/** 行首「UP主：」「作者：」这类显式标签 */
const LEAD_LABEL = /^\s*(?:UP\s*主|up\s*主|作者|投稿者|up)\s*[:：]\s*/iu

/**
 * 行首计数前缀：「100首」「12集」「8期」。
 *
 * 只在前方确有括号段时才用（见 stripLeadNoise）：那种位置的数字一定是列表计数，
 * 不会是歌名的一部分——「2002年的第一场雪」没有前导括号段，不会被误伤。
 */
const LEAD_COUNT = /^\s*\d{1,4}\s*(?:首|集|期|支|个)\s*/u

/**
 * 显式标签后面的那个名字：「UP主：某某某 · 歌名」里的「某某某」。
 *
 * 只在**后面紧跟分隔符**时才吃：`作者：周杰伦 稻香` 没有分隔符，说明标签后面
 * 直接就是曲目信息，吃掉它会把歌名一起删掉。
 */
const LEAD_LABEL_NAME = /^[^\s·\-|/—–]{1,24}\s*(?=[·\-–—|/])/u


/**
 * 判断一个行首括号段是不是「UP 主名」而不是「歌名信息」。
 *
 * 保守口径：只有带 UP/作者/投稿/频道 等显式标记，或以「音乐 / 电台 / 频道 / 工作室 / official」
 * 结尾的频道名才削。像【稻香】这种不带任何标记的括号段一律留给 cleanTitle 处理，
 * 因为把它当前缀削掉会直接丢掉歌名。
 */
function looksLikeUploader(inner: string): boolean {
  const s = inner.trim()
  if (!s) return false
  if (/up\s*主|作者|投稿者|的频道|的投稿|官方账号/iu.test(s)) return true
  return /(?:音乐|电台|频道|工作室|official)$/iu.test(s) && !/[《》<>]/.test(s)
}

/** 削行首 UP 主前缀（括号段 / 显式标签 / 计数前缀），削完为空就原样返回 */
function stripLeadNoise(raw: string): string {
  let s = raw
  const bracket = s.match(LEAD_BRACKET)
  if (bracket && looksLikeUploader(bracket[1])) {
    const rest = s.slice(bracket[0].length).trim()
    if (rest) s = rest
  }
  // 行首括号段后面紧跟计数前缀（【歌单】100首…）：括号段由 cleanTitle 丢弃，
  // 计数前缀若留着就会变成孤立的「100」。
  const afterBracket = s.replace(LEAD_BRACKET, '')
  if (afterBracket !== s) {
    const counted = afterBracket.replace(LEAD_COUNT, '').trim()
    // 只有确实削掉了计数前缀才采用；replace 未命中时原样返回，不能无条件赋值
    if (counted && counted !== afterBracket) s = counted
  }
  if (LEAD_LABEL.test(s)) {
    const afterLabel = s.replace(LEAD_LABEL, '').trim()
    if (afterLabel) {
      const named = afterLabel.replace(LEAD_LABEL_NAME, '').trim()
      s = named || afterLabel
    }
  }
  return s
}

/** 削尾部噪声；噪声可能叠好几层（「… 3:45 1.2万播放」），循环到削不动为止 */
function stripTailNoise(input: string): string {
  let s = input
  for (let i = 0; i < 4; i += 1) {
    const before = s
    s = s.replace(TAIL_STAT, '').replace(TAIL_TIME, '').trim()
    if (s === before) break
  }
  return s
}

/**
 * 程序模式核心：二次整理 + cleanTitle。纯函数，可直接单测。
 *
 * 顺序是刻意的——前缀与尾部统计必须在 cleanTitle **之前**削：
 * cleanTitle 会把【】整段删掉、把 1.2万播放 拆成 `1 2万播放`、把 3:45 拆成 `3 45`，
 * 事后再处理就只能靠猜。cleanTitle 之后只补两件它做不到的事：残留画质词与分隔符残片。
 */
export function cleanTitleByRule(raw: string): string {
  const source = (raw || '').trim()
  if (!source) return ''

  let s = stripLeadNoise(source)
  s = stripTailNoise(s)
  s = s.replace(RESIDUAL_TAG, ' ').trim()

  s = cleanTitle(s)
  if (!s) return ''

  // cleanTitle 之后仍可能残留（它自己也可能造出新的尾部数字），再补一遍
  s = stripTailNoise(s)
  s = s.replace(RESIDUAL_TAG, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(DANGLING_SEP, '').trim()
  s = s.replace(/\s+/g, ' ').trim()

  // 削过头（整条标题都是噪声）就退回 cleanTitle 的结果，再不行退回原标题
  if (!s) {
    const fallback = cleanTitle(source).trim()
    return fallback || source.slice(0, 60)
  }
  return s
}

// ===== 文件名合法性 =====

/**
 * 文件名上限（不含扩展名）。
 *
 * Windows 单段上限 255，这里取 120 是因为主进程同名防覆盖会追加 ` (2)` 后缀，
 * 下载目录本身也可能很深；留足余量比顶着上限更实用。
 */
export const FILENAME_MAX_LENGTH = 120

/*
 * Windows 不允许出现在文件名里的字符（含 C0 控制字符）。
 *
 * 控制字符不用 \u0000-\u001f 区间写法：eslint 的 no-control-regex 会报错，
 * 且区间字面量在编辑器里不可见、容易看漏。改为在清洗函数里按码点剔除。
 */
const ILLEGAL_FILENAME_CHAR = /[<>:"/\\|?*]/g

/** 去掉 C0 控制字符（0x00-0x1f）与 DEL（0x7f）；按码点判断，避免正则区间 */
function stripControlChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x1f && code !== 0x7f) out += ch
  }
  return out
}

/** Windows 保留设备名：带不带扩展名都不能用作文件名 */
const RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/**
 * 把任意标题整理成一个可落盘的文件名主体（不含扩展名）。纯函数，零成本。
 *
 * 清洗（rule / ai）解决的是「名字好不好看」，这里解决的是「这个名字能不能写进磁盘」，
 * 两件事必须分开：AI 输出的任何字符都不能直接当成路径。四类处理：
 * 1. 非法字符换成下划线；2. 收尾的点与空格去掉（Windows 会截断或直接拒绝）；
 * 3. 超长按码点截断（不用 slice，避免劈开代理对）；4. 空串与保留设备名兜底。
 */
export function sanitizeFilename(raw: string, fallback = '未知曲目'): string {
  // 先剔控制字符再换非法字符：控制字符会让路径在主进程侧被静默截断
  let s = stripControlChars(raw || '').replace(ILLEGAL_FILENAME_CHAR, '_')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/g, '')
  // Array.from 按码点切，emoji 不会被劈成半个代理对
  if (s.length > FILENAME_MAX_LENGTH) s = Array.from(s).slice(0, FILENAME_MAX_LENGTH).join('')
  s = s.replace(/[. ]+$/g, '').trim()
  if (!s) return fallback
  // 保留设备名加下划线即可绕开（CON -> CON_），比换一个名字更容易让人认出来
  if (RESERVED_FILENAME.test(s)) return `${s}_`
  return s
}

// ===== AI 模式 =====

/**
 * AI 清洗的 system 提示词。
 * 一次只洗一个标题；明确禁止解释、禁止加引号、禁止改动歌手名与歌名本身的文字。
 */
export const TITLE_CLEAN_SYSTEM_PROMPT = [
  '你是曲目标题清洗器。用户会给你一条 B 站视频标题，你只输出清洗后的歌曲标题。',
  '规则：',
  '1. 只输出清洗后的标题本身：不要解释、不要注释、不要加引号或书名号、不要加「标题：」这类前缀。',
  '2. 去掉噪声：画质标记（4K/1080P/HDR）、版本标记（MV/官方/Live/翻唱/纯享/完整版/中文字幕）、',
  '   emoji、UP 主前缀、播放量与时长。',
  '3. 不要改动歌手名与歌名本身的文字，不要翻译，不要补全你不确定的字。',
  '4. 保留「歌手 - 歌名」的结构；若原标题只有歌名，就只输出歌名。',
  '5. 只输出一行。',
].join('\n')

/** 模型回复里出现这些，说明它没按约定「只输出标题」 */
const REFUSAL_HINT = /^(?:抱歉|对不起|无法|我不能|sorry)/iu

/**
 * 判断模型返回是否可信（防幻觉）。纯函数，单测不需要真发请求。
 *
 * 判不可信的四种情况：
 * 1. 空串；2. 多行 / 被引号包裹（说明吐了解释或没按格式）；
 * 3. 长度超过原标题的 1.5 倍（清洗只会变短，变长就是在扩写）；
 * 4. 与原标题的字符重叠率低于 50%（等于自己编了一个歌名）。
 */
export function isTrustworthyTitle(raw: string, cleaned: string): boolean {
  const out = (cleaned || '').trim()
  const base = (raw || '').trim()
  if (!out || !base) return false
  if (/[\r\n]/.test(out)) return false
  if (/^["'「『《].*["'」』》]$/u.test(out)) return false
  if (REFUSAL_HINT.test(out)) return false
  if (out.length > Math.max(base.length, 8) * 1.5) return false

  const norm = (t: string) => t.replace(/\s+/g, '')
  const rawChars = new Set(norm(base))
  const outChars = norm(out)
  if (!outChars) return false
  let hit = 0
  for (const ch of outChars) if (rawChars.has(ch)) hit += 1
  return hit / outChars.length >= 0.5
}

/** 从模型回复里取出标题行：容忍代码围栏、「标题：」前缀与首尾引号 */
export function parseCleanedTitle(reply: string): string {
  let s = (reply || '').trim()
  const fenced = s.match(/\x60\x60\x60(?:[a-z]*)\s*([\s\S]*?)\x60\x60\x60/i)
  if (fenced) s = fenced[1].trim()
  const firstLine =
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || ''
  return firstLine
    .replace(/^(?:清洗后(?:的)?标题|标题|title)\s*[:：]\s*/iu, '')
    .replace(/^["'「『《]+|["'」』》]+$/gu, '')
    .trim()
}

/** 独立一次请求：一次只洗一个标题，避免批量导致串行错位 */
async function cleanTitleByAi(raw: string, config: AiSettings): Promise<string> {
  const reply = await aiChat(config, {
    messages: [
      { role: 'system', content: TITLE_CLEAN_SYSTEM_PROMPT },
      { role: 'user', content: raw },
    ],
    // 清洗是确定性任务，低温减少自由发挥
    temperature: 0.2,
    timeoutMs: 20000,
  })
  return parseCleanedTitle(reply)
}

/**
 * 对外唯一入口：按模式清洗一条标题。
 *
 * AI 模式的失败是**静默**的——不抛错，退回 rule 结果并把 source 标成 ai-fallback-rule，
 * 这样调用方不需要 try/catch，排查时也能一眼看出这条到底走没走成 AI。
 */
export async function cleanTrackTitle(
  raw: string,
  options: TitleCleanOptions = {},
): Promise<TitleCleanResult> {
  const source0 = (raw || '').trim()
  const mode = resolveTitleCleanMode(options.mode ?? options.settings?.titleCleanMode)

  if (mode === 'off') return { title: source0, source: 'off' }

  const ruleTitle = cleanTitleByRule(source0)
  if (mode === 'rule') return { title: ruleTitle, source: 'rule' }

  const config = options.aiConfig ?? options.settings?.ai
  if (!config) return { title: ruleTitle, source: 'ai-fallback-rule' }

  try {
    const aiTitle = await cleanTitleByAi(source0, config)
    if (!isTrustworthyTitle(source0, aiTitle)) {
      return { title: ruleTitle, source: 'ai-fallback-rule' }
    }
    return { title: aiTitle, source: 'ai' }
  } catch {
    // 未配置 / 超时 / 401 一律退回规则结果：清洗是锦上添花，不该让播放链路报错
    return { title: ruleTitle, source: 'ai-fallback-rule' }
  }
}

// ===== 批量清洗（下载 / 歌单批量下载用） =====

/**
 * 一次 AI 请求最多洗多少条标题。
 *
 * 单条请求对歌单来说是灾难：20 首 = 20 次往返，慢且贵。批量清洗把整批塞进一次请求，
 * 用带序号的 JSON 数组进出（与 aiLyrics 的分批范式同一套做法），模型一次就能对齐。
 *
 * 上限取 20 而不是更大：标题很短，20 条的输入约几百 token，输出也稳定；
 * 再往上模型漏项/串号的概率明显上升，而漏项只能退回规则清洗，等于白花钱。
 */
export const TITLE_CLEAN_BATCH_SIZE = 20

/** 批量清洗的一条输入/输出；index 用于把结果对回原顺序，绝不允许模型改号 */
export interface TitleCleanBatchItem {
  index: number
  title: string
}

/**
 * 批量清洗的 system 提示词。
 *
 * 与单条版的关键差别：要求返回 JSON 数组并原样带 index，这样一次请求能洗多首，
 * 且调用方能逐条校验（校验不过的那条退回规则清洗，不影响同批其它条）。
 */
export const TITLE_CLEAN_BATCH_SYSTEM_PROMPT = [
  '你是曲目标题清洗器。用户会给你一个 JSON 数组，每项形如 {"index":序号,"title":B站视频标题}。',
  '规则：',
  '1. 逐条清洗，只输出 JSON 数组，不要任何解释文字或代码围栏。',
  '2. 必须原样返回同样数量的项，index 与输入一一对应，不得增删、改号或调换顺序。',
  '3. 去掉噪声：画质标记（4K/1080P/HDR）、版本标记（MV/官方/Live/翻唱/纯享/完整版/中文字幕）、',
  '   emoji、UP 主前缀、播放量与时长。',
  '4. 不要改动歌手名与歌名本身的文字，不要翻译，不要补全你不确定的字。',
  '5. 保留「歌手 - 歌名」的结构；若原标题只有歌名，就只输出歌名。',
  '6. 输出格式：[{"index":0,"title":"清洗后的标题"}]',
].join('\n')

/** 按上限切批；空输入返回空数组 */
export function planTitleCleanBatches<T>(items: T[], batchSize = TITLE_CLEAN_BATCH_SIZE): T[][] {
  const size = Math.max(1, batchSize)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 构造批量清洗的一轮对话；导出以便单测断言「一次请求带了多条标题」 */
export function buildTitleCleanBatchMessages(
  batch: TitleCleanBatchItem[],
): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: TITLE_CLEAN_BATCH_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(batch) },
  ]
}

/**
 * 从批量回复里取出条目。纯函数，单测不需要真发请求。
 *
 * 解析失败一律返回空数组（调用方据此把整批退回规则清洗），绝不抛错：
 * 清洗是下载链路上的增强，任何一步都不该让下载失败。
 */
export function parseCleanedTitleList(reply: string): TitleCleanBatchItem[] {
  let s = (reply || '').trim()
  const fenced = s.match(/\x60\x60\x60(?:[a-z]*)\s*([\s\S]*?)\x60\x60\x60/i)
  if (fenced) s = fenced[1].trim()
  // 容忍模型在数组前后多说一句：只取最外层的 [...] 片段
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(s.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: TitleCleanBatchItem[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { index?: unknown; title?: unknown }
    const index = typeof rec.index === 'number' ? rec.index : Number(rec.index)
    const title = typeof rec.title === 'string' ? rec.title : ''
    if (!Number.isInteger(index) || index < 0 || !title.trim()) continue
    out.push({ index, title: parseCleanedTitle(title) })
  }
  return out
}

/** 一次请求洗一批；返回 序号 → 标题。抛错由调用方兜底 */
async function cleanTitleBatchByAi(
  batch: TitleCleanBatchItem[],
  config: AiSettings,
): Promise<Map<number, string>> {
  const reply = await aiChat(config, {
    messages: buildTitleCleanBatchMessages(batch),
    temperature: 0.2,
    // 一批比单条慢，超时放宽；失败只是退回规则清洗，不阻断下载
    timeoutMs: 45000,
  })
  const allowed = new Set(batch.map((b) => b.index))
  const result = new Map<number, string>()
  for (const item of parseCleanedTitleList(reply)) {
    // 只接受本批内的序号，防止模型改号或串批
    if (allowed.has(item.index)) result.set(item.index, item.title)
  }
  return result
}

/**
 * 批量清洗：与 cleanTrackTitle 同一套模式与兜底口径，但**整批共用一次请求**。
 *
 * 返回数组与入参一一对应、顺序一致（下载侧要按下标取文件名，错位就是给错歌改名）。
 *
 * 三条聚合策略：
 * 1. 去重——同一歌单里重复标题只洗一次，回填时按原下标摊开（省 token，也避免同一条
 *    被洗成两种写法）；
 * 2. 切批——超过 TITLE_CLEAN_BATCH_SIZE 才拆成多个请求，绝不退化成「每条一次」；
 * 3. 逐条校验——模型结果要过 isTrustworthyTitle 才采用，不可信或漏项的那条退回规则
 *    清洗，同批其它条不受影响。
 *
 * 任何失败都不抛错：最差情况就是整批退回规则清洗，下载照常进行。
 */
export async function cleanTrackTitles(
  raws: string[],
  options: TitleCleanOptions = {},
): Promise<TitleCleanResult[]> {
  const sources = raws.map((r) => (r || '').trim())
  const mode = resolveTitleCleanMode(options.mode ?? options.settings?.titleCleanMode)

  if (mode === 'off') return sources.map((title) => ({ title, source: 'off' as const }))

  const ruleTitles = sources.map((s) => cleanTitleByRule(s))
  if (mode === 'rule') return ruleTitles.map((title) => ({ title, source: 'rule' as const }))

  const config = options.aiConfig ?? options.settings?.ai
  const fallback = (): TitleCleanResult[] =>
    ruleTitles.map((title) => ({ title, source: 'ai-fallback-rule' }))
  if (!config) return fallback()

  // 去重：unique[0] 是标题文本，unique[1] 是它第一次出现的下标集合
  const order: string[] = []
  const positions = new Map<string, number[]>()
  sources.forEach((s, i) => {
    const list = positions.get(s)
    if (list) list.push(i)
    else {
      positions.set(s, [i])
      order.push(s)
    }
  })

  const cleaned = new Map<string, string>()
  for (const batch of planTitleCleanBatches(order.map((title, index) => ({ index, title })))) {
    let aiTitles: Map<number, string>
    try {
      aiTitles = await cleanTitleBatchByAi(batch, config)
    } catch {
      // 单批失败只丢该批（这些条退回规则清洗），不中断其余批次
      continue
    }
    for (const item of batch) {
      const out = aiTitles.get(item.index)
      // 漏项或不可信：这一条不写进 cleaned，回填时自然退回规则结果
      if (out && isTrustworthyTitle(item.title, out)) cleaned.set(item.title, out)
    }
  }

  return sources.map((source, i) => {
    const aiTitle = cleaned.get(source)
    return aiTitle ? { title: aiTitle, source: 'ai' as const } : { title: ruleTitles[i], source: 'ai-fallback-rule' as const }
  })
}

/**
 * 按模式取 AI 配置：只有 ai 模式才去主进程读。
 *
 * off / rule 一律返回 undefined，调用方据此根本不发请求（这是「不花钱」的硬保证：
 * 不是靠提示词或后续判断，而是压根没有可用的 config）。
 * 读配置失败也只当没配，退回规则清洗。
 */
export async function loadTitleCleanAiConfig(mode: TitleCleanMode): Promise<AiSettings | undefined> {
  if (mode !== 'ai') return undefined
  try {
    const config = await getAiConfig()
    // 未配置就别发那个注定 401/404 的请求：既慢又白花一次额度
    return isAiConfigured(config) ? config : undefined
  } catch {
    return undefined
  }
}

/**
 * 下载用文件名：清洗 + 文件名合法性处理，一步到位。单曲入口。
 *
 * 清洗决定「叫什么」，sanitizeFilename 决定「能不能落盘」——两件事分开做，
 * 所以这里串起来给下载侧用，调用方不必记得再处理一次非法字符。
 */
export async function cleanFilenameForDownload(
  raw: string,
  options: TitleCleanOptions = {},
): Promise<string> {
  const { title } = await cleanTrackTitle(raw, options)
  return sanitizeFilename(title || (raw || '').trim())
}

/**
 * 下载用文件名：批量版。整批共用一次请求（见 cleanTrackTitles），返回顺序与入参一致。
 *
 * off 模式下 sanitizeFilename 仍然生效：用户选择「不清洗」是不要 AI/规则整理名字，
 * 不是要一个写不进磁盘的文件名。
 */
export async function cleanFilenamesForDownload(
  raws: string[],
  options: TitleCleanOptions = {},
): Promise<string[]> {
  const results = await cleanTrackTitles(raws, options)
  return results.map((r, i) => sanitizeFilename(r.title || (raws[i] || '').trim()))
}

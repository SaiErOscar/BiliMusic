/**
 * v1.4.11-pre5 AI 智能歌单：用 LLM 从本地曲库里挑歌并生成歌单。
 *
 * 设计要点：
 * - 只让模型做选择，不让它编造曲目：把本地曲库编号后发给模型，要求它只返回编号。
 *   返回的编号再映射回真实 Track——模型幻觉出不存在歌曲时自然被过滤掉。
 * - 曲库过大时先裁剪：把整库塞进上下文既贵又慢，先按收藏/最近播放/下载合并去重再截断。
 * - 产出先预览再落库：返回结构化结果，由 UI 确认后才 createPlaylist。
 */

import { aiChat, type AiChatMessage } from '@/services/ai'
import { loadFavoriteTracks, loadRecentTracks, loadDownloadRecords, createPlaylist, addTrackToPlaylist } from '@/utils/storage'
import type { AiProviderConfig, Playlist, Track } from '@/types'

/** 单次最多喂给模型的候选曲目数（控制 token 成本与延迟） */
export const AI_PLAYLIST_POOL_LIMIT = 120

/** 生成的歌单最多收多少首 */
export const AI_PLAYLIST_MAX_TRACKS = 30

export interface AiPlaylistCandidate {
  track: Track
  /** 喂给模型时的编号（从 1 开始） */
  index: number
}

export interface AiPlaylistResult {
  name: string
  description: string
  tracks: Track[]
  /** 模型给出但曲库里不存在的编号（用于诊断，不进歌单） */
  droppedIndexes: number[]
}

/**
 * 组装候选池：收藏 → 最近播放 → 本地下载，按 id 去重，截断到上限。
 *
 * 顺序有意义：收藏是用户明确表达过喜好的，最近播放反映当下口味，下载代表已投入成本。
 */
export function buildCandidatePool(limit = AI_PLAYLIST_POOL_LIMIT): AiPlaylistCandidate[] {
  const seen = new Set<string>()
  const pool: AiPlaylistCandidate[] = []
  const push = (track: Track) => {
    if (!track || !track.id || seen.has(track.id)) return
    seen.add(track.id)
    pool.push({ track, index: pool.length + 1 })
  }
  for (const t of loadFavoriteTracks()) push(t)
  for (const t of loadRecentTracks()) push(t)
  for (const r of loadDownloadRecords()) {
    const rec = r as unknown as { id?: string; title?: string; artist?: string; bvid?: string; coverUrl?: string }
    if (!rec.id || !rec.title) continue
    push({
      id: rec.id,
      title: rec.title,
      artist: rec.artist || '',
      coverUrl: rec.coverUrl || '',
      duration: 0,
      videoUrl: '',
      bvid: rec.bvid || '',
      playCount: 0,
      isLiked: false,
    })
  }
  return pool.slice(0, limit)
}

/** 把候选池渲染成提示词里的清单行 */
function renderPool(pool: AiPlaylistCandidate[]): string {
  return pool
    .map(({ track, index }) => index + '. ' + track.title + (track.artist ? ' - ' + track.artist : ''))
    .join('\n')
}

/** 从模型回复里抠出 JSON（容忍代码围栏与前后废话） */
export function parsePlaylistJson(reply: string): { name?: string; description?: string; indexes: number[] } {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : reply).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型未返回可解析的 JSON')
  const obj = JSON.parse(raw.slice(start, end + 1)) as { name?: unknown; description?: unknown; indexes?: unknown }
  const indexes = Array.isArray(obj.indexes)
    ? obj.indexes.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : []
  return {
    name: typeof obj.name === 'string' ? obj.name.trim() : undefined,
    description: typeof obj.description === 'string' ? obj.description.trim() : undefined,
    indexes,
  }
}

/**
 * 生成歌单（不落库）。由调用方预览确认后再调 saveAiPlaylist。
 *
 * @param intent 用户自然语言描述，如「适合深夜写代码的安静歌单」
 */
export async function generateAiPlaylist(
  config: AiProviderConfig,
  intent: string,
  pool = buildCandidatePool(),
): Promise<AiPlaylistResult> {
  if (!pool.length) throw new Error('曲库为空：请先收藏、播放或下载一些歌曲')
  const trimmedIntent = intent.trim()
  if (!trimmedIntent) throw new Error('请先描述想要的歌单')

  const systemLines = [
    '你是音乐歌单策划。用户会给一个场景/情绪描述，以及一份带编号的候选曲目清单。',
    '你的任务：从清单中挑选最契合的曲目，组成一个歌单。',
    '严格要求：',
    '1. 只能从清单里挑，编号必须是清单中真实存在的数字，不得编造；',
    '2. 最多挑 ' + AI_PLAYLIST_MAX_TRACKS + ' 首，宁少勿滥，不契合的一首也不要放；',
    '3. 只输出一个 JSON 对象，不要任何解释文字，格式：',
    '{"name":"歌单名（不超过 20 字）","description":"一句话说明（不超过 40 字）","indexes":[编号,...]}',
  ].join('\n')

  const messages: AiChatMessage[] = [
    { role: 'system', content: systemLines },
    { role: 'user', content: '场景/情绪：' + trimmedIntent + '\n\n候选曲目：\n' + renderPool(pool) },
  ]

  const reply = await aiChat(config, { messages, temperature: 0.4, timeoutMs: 90000 })
  const parsed = parsePlaylistJson(reply)

  const byIndex = new Map(pool.map((c) => [c.index, c.track]))
  const tracks: Track[] = []
  const droppedIndexes: number[] = []
  const used = new Set<string>()
  for (const idx of parsed.indexes) {
    const track = byIndex.get(idx)
    if (!track) {
      // 模型编造了不存在的编号：丢掉并记录，绝不塞进歌单
      droppedIndexes.push(idx)
      continue
    }
    if (used.has(track.id)) continue
    used.add(track.id)
    tracks.push(track)
    if (tracks.length >= AI_PLAYLIST_MAX_TRACKS) break
  }
  if (!tracks.length) throw new Error('模型没有选出可用曲目，换个描述再试一次')

  return {
    name: parsed.name || trimmedIntent.slice(0, 20),
    description: parsed.description || '',
    tracks,
    droppedIndexes,
  }
}

/** 把预览结果落库：建歌单 + 逐首加入，返回新建的歌单 */
export function saveAiPlaylist(result: AiPlaylistResult): Playlist {
  const playlist = createPlaylist({ name: result.name, description: result.description })
  for (const track of result.tracks) addTrackToPlaylist(playlist.id, track)
  return playlist
}

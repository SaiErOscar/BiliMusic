import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Track } from '@/types'
import {
  getLyricForTrack,
  chooseLyricCandidate,
  clearLyricCache,
  getLyricOffset,
  setLyricOffset,
  type LyricResult,
  type LyricCandidate,
} from '@/services/lyrics'

export type LyricStatus = 'idle' | 'loading' | 'ok' | 'unsynced' | 'empty' | 'none'

/**
 * 按当前曲目懒加载歌词（仅当 enabled，即歌词页打开时）。
 * 过期请求丢弃，避免快速切歌时的竞态。
 */
export function useLyrics(track: Track | null, enabled: boolean) {
  const [status, setStatus] = useState<LyricStatus>('idle')
  const [result, setResult] = useState<LyricResult | null>(null)
  const [offset, setOffset] = useState(0)
  const reqIdRef = useRef(0)
  /**
   * v1.4.11-pre6 AI 歌词增强叠加层：行号 → 增强文本。
   *
   * 独立于 result 存放，渲染时再合并——这样关掉开关/切歌即时还原，
   * 原始歌词（含官方 tlyric）始终是权威，也不会污染歌词缓存与 .lrc 导出。
   */
  const [aiEnhance, setAiEnhance] = useState<Map<number, string> | null>(null)

  const load = useCallback(async (t: Track) => {
    const reqId = ++reqIdRef.current
    setStatus('loading')
    setResult(null)
    const res = await getLyricForTrack(t)
    if (reqId !== reqIdRef.current) return // 已切歌，丢弃过期结果
    // v1.4.5：用户主动选「不显示歌词」→ 独立 none 态（内容为「无歌词」），区别于自动匹配失败的 empty
    if (res?.noLyric) {
      setStatus('none')
      setResult(res)
      setOffset(0)
      return
    }
    if (!res || (!res.lines.length && !res.instrumental)) {
      setStatus('empty')
      setResult(null)
      return
    }
    setResult(res)
    setStatus(res.synced ? 'ok' : 'unsynced')
    setOffset(getLyricOffset(t.id))
  }, [])

  useEffect(() => {
    if (!enabled || !track) return
    load(track)
    // 仅在曲目切换或启用时重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, track?.id])

  // v1.3.7：手动匹配改为抽屉内直接调 searchMultiSourceRound（多源+翻页），本 hook 不再提供单源 search

  const choose = useCallback(async (record: LyricCandidate) => {
    if (!track) return
    setStatus('loading')
    const res = await chooseLyricCandidate(track.id, record)
    // v1.4.5：选中「不显示歌词」→ 进入独立 none 态
    if (res?.noLyric) {
      setStatus('none')
      setResult(res)
      setOffset(0)
      return
    }
    if (!res) {
      setStatus('empty')
      setResult(null)
      return
    }
    setResult(res)
    setStatus(res.synced ? 'ok' : 'unsynced')
    setOffset(getLyricOffset(track.id))
  }, [track])

  const retry = useCallback(() => {
    if (!track) return
    clearLyricCache(track.id)
    setAiEnhance(null)
    load(track)
  }, [track, load])

  /** 清掉 AI 增强叠加层（切歌、关闭开关时调用） */
  const clearAiEnhance = useCallback(() => setAiEnhance(null), [])

  /** 应用 AI 增强结果；行号越界的直接忽略 */
  const applyAiEnhance = useCallback((map: Map<number, string>) => setAiEnhance(map), [])

  const adjustOffset = useCallback((deltaMs: number) => {
    if (!track) return
    const newOffset = offset + deltaMs
    setLyricOffset(track.id, newOffset)
    setOffset(newOffset)
    // 重新加载歌词以应用新偏移
    if (result) {
      const baseLines = result.lines.map(line => ({
        ...line,
        time: line.time >= 0 ? line.time - (offset / 1000) + (newOffset / 1000) : line.time,
      }))
      setResult({ ...result, lines: baseLines, offset: newOffset })
    }
  }, [track, result, offset])

  const resetOffset = useCallback(() => {
    if (!track) return
    setLyricOffset(track.id, 0)
    setOffset(0)
    if (result) {
      const baseLines = result.lines.map(line => ({
        ...line,
        time: line.time >= 0 ? line.time - (offset / 1000) : line.time,
      }))
      setResult({ ...result, lines: baseLines, offset: 0 })
    }
  }, [track, result, offset])

  /**
   * 渲染用的歌词结果：把 AI 增强按行号叠到 translation 上。
   * 没有增强时原样返回，避免无谓的对象重建触发下游重渲染。
   */
  const displayResult = useMemo(() => {
    if (!result || !aiEnhance || !aiEnhance.size) return result
    return {
      ...result,
      lines: result.lines.map((line, i) => {
        const text = aiEnhance.get(i)
        return text ? { ...line, translation: text } : line
      }),
    }
  }, [result, aiEnhance])

  return {
    status,
    result: displayResult,
    /** 原始结果（不含 AI 叠加），供需要权威歌词的调用方使用 */
    rawResult: result,
    choose,
    retry,
    offset,
    adjustOffset,
    resetOffset,
    applyAiEnhance,
    clearAiEnhance,
    hasAiEnhance: !!aiEnhance?.size,
  }
}

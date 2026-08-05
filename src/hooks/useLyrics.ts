import { useState, useEffect, useCallback, useRef } from 'react'
import type { Track } from '@/types'
import {
  getLyricForTrack,
  searchLyricCandidates,
  chooseLyricCandidate,
  clearLyricCache,
  getLyricOffset,
  setLyricOffset,
  type LyricResult,
  type LyricCandidate,
} from '@/services/lyrics'

export type LyricStatus = 'idle' | 'loading' | 'ok' | 'unsynced' | 'empty'

/**
 * 按当前曲目懒加载歌词（仅当 enabled，即歌词页打开时）。
 * 过期请求丢弃，避免快速切歌时的竞态。
 */
export function useLyrics(track: Track | null, enabled: boolean) {
  const [status, setStatus] = useState<LyricStatus>('idle')
  const [result, setResult] = useState<LyricResult | null>(null)
  const [offset, setOffset] = useState(0)
  const reqIdRef = useRef(0)

  const load = useCallback(async (t: Track) => {
    const reqId = ++reqIdRef.current
    setStatus('loading')
    setResult(null)
    const res = await getLyricForTrack(t)
    if (reqId !== reqIdRef.current) return // 已切歌，丢弃过期结果
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

  const search = useCallback((q: string): Promise<LyricCandidate[]> => searchLyricCandidates(q), [])

  const choose = useCallback(async (record: LyricCandidate) => {
    if (!track) return
    setStatus('loading')
    const res = await chooseLyricCandidate(track.id, record)
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
    load(track)
  }, [track, load])

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

  return { status, result, search, choose, retry, offset, adjustOffset, resetOffset }
}

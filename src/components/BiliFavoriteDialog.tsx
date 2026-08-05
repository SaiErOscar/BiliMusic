import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Heart, X, Loader2, Check } from 'lucide-react'
import { listBiliFavoriteFolders } from '@/services/biliFavorites'
import { dealFavorite } from '@/services/bilibiliApi'
import type { FavoriteFolder } from '@/services/bilibiliApi'

interface BiliFavoriteDialogProps {
  open: boolean
  onClose: () => void
  aid?: string | number
  bvid: string
  title: string
}

/**
 * 收藏到 Bilibili 收藏夹弹窗
 * 用户可选择一个或多个收藏夹进行收藏
 */
export default function BiliFavoriteDialog({
  open,
  onClose,
  aid,
  title,
}: BiliFavoriteDialogProps) {
  const [folders, setFolders] = useState<FavoriteFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [result, setResult] = useState<'idle' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const loadFolders = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listBiliFavoriteFolders()
      setFolders(data.list || [])
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '获取收藏夹失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setResult('idle')
      setMessage('')
      setSelected(new Set())
      loadFolders()
    }
  }, [open, loadFolders])

  const toggleFolder = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = async () => {
    if (!aid || selected.size === 0) return
    setSubmitting(true)
    setResult('idle')
    try {
      const aidNum = Number(aid)
      const folderIds = Array.from(selected)
      // B站 dealFavorite 一次只能处理一个 rid，但可以同时添加到多个收藏夹
      await dealFavorite(aidNum, folderIds)
      setResult('success')
      setMessage(`已收藏到 ${folderIds.length} 个收藏夹`)
      setTimeout(() => onClose(), 1500)
    } catch (e) {
      setResult('error')
      setMessage(e instanceof Error ? e.message : '收藏失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="playlist-dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={() => !submitting && onClose()}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <motion.div
            className="playlist-dialog"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 440, width: '90vw' }}
          >
            <div className="playlist-dialog__head">
              <div>
                <p>Bilibili Favorites</p>
                <h2>收藏到B站</h2>
              </div>
              <button type="button" onClick={() => !submitting && onClose()} disabled={submitting}>
                <X size={18} />
              </button>
            </div>

            <div style={{ marginBottom: 12, padding: '0 4px' }}>
              <p style={{ fontSize: 12, color: 'var(--color-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {title}
              </p>
            </div>

            {loading ? (
              <div style={{ padding: '24px 0', textAlign: 'center' }}>
                <Loader2 size={24} className="spin" style={{ margin: '0 auto 8px' }} />
                <p style={{ color: 'var(--color-muted)', fontSize: 13 }}>正在获取收藏夹列表...</p>
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: 'auto', padding: '0 2px' }}>
                {folders.length === 0 ? (
                  <p style={{ color: 'var(--color-muted)', textAlign: 'center', padding: '16px 0', fontSize: 13 }}>
                    未找到收藏夹
                  </p>
                ) : (
                  folders.map((folder) => {
                    const isSelected = selected.has(folder.id)
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => toggleFolder(folder.id)}
                        disabled={submitting}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 10,
                          border: `1px solid ${isSelected ? 'var(--color-primary)' : 'var(--glass-border)'}`,
                          background: isSelected ? 'rgba(255, 55, 95, 0.08)' : 'var(--glass-bg)',
                          marginBottom: 6,
                          cursor: submitting ? 'wait' : 'pointer',
                          fontFamily: 'inherit',
                          textAlign: 'left',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <strong style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-foreground)' }}>
                            {folder.title}
                          </strong>
                          <small style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                            {folder.media_count} 个内容
                          </small>
                        </div>
                        <div style={{
                          width: 20,
                          height: 20,
                          borderRadius: '50%',
                          border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--glass-border)'}`,
                          background: isSelected ? 'var(--color-primary)' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          {isSelected && <Check size={12} color="#fff" />}
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            )}

            {message && (
              <p style={{
                marginTop: 10,
                padding: '8px 12px',
                borderRadius: 8,
                background: result === 'success' ? 'rgba(48, 209, 88, 0.1)' : result === 'error' ? 'rgba(255, 55, 95, 0.1)' : 'var(--glass-bg)',
                color: result === 'success' ? '#30d158' : result === 'error' ? '#ff375f' : 'var(--color-foreground)',
                fontSize: 13,
                textAlign: 'center',
              }}>
                {message}
              </p>
            )}

            <div className="playlist-dialog__actions">
              <button type="button" onClick={() => !submitting && onClose()} disabled={submitting}>
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || selected.size === 0 || !aid}
                style={{
                  opacity: (submitting || selected.size === 0 || !aid) ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {submitting ? <Loader2 size={14} className="spin" /> : <Heart size={14} />}
                收藏{selected.size > 0 ? ` (${selected.size})` : ''}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

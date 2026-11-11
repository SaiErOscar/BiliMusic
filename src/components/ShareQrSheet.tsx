/**
 * v1.4.15-pre4 分享二维码抽屉。
 *
 * 只做「界面 + 调用」两件事，分享什么文本、装不装得下全部由
 * src/services/shareCode.ts（已冻结）决定，这里不复制任何一份容量常量。
 * QRCode.toDataURL 的用法与 LoginDialog.tsx:86 一致（同一依赖、同一套参数口径）。
 *
 * 外壳复用 ai-sheet__* 那套浮层样式（见 EqualizerSheet）：深浅主题的玻璃/实心面
 * 已经在那边处理过，这里只补 share-qr__* 专属零件。
 *
 * 必须挂到 body：歌单卡片 .playlist-card 带 overflow: hidden，
 * 抽屉若挂在卡片里会被裁掉（同 NowPlaying.tsx:1201 的理由）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { buildShare, shareNotice } from '@/services/shareCode'
import type { SharePayload } from '@/services/shareCode'
import type { Playlist, Track } from '@/types'

interface Props {
  open: boolean
  onClose: () => void
  /** 歌单模式（与 track 二选一） */
  playlist?: Playlist
  /** 单曲模式（与 playlist 二选一） */
  track?: Track
}

/** 二维码边长（px）：比登录码大一圈，歌单清单密度高，留足扫码像素 */
const QR_SIZE = 240

export default function ShareQrSheet({ open, onClose, playlist, track }: Props) {
  const [dataUrl, setDataUrl] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  /** 卸载标记：异步画码返回时组件可能已经关掉，避免对已卸载组件 setState */
  const aliveRef = useRef(true)

  const result = useMemo<SharePayload | null>(() => {
    if (!open) return null
    // 分开调用而不是拼一个联合入参：buildShare 的重载按具体类型分派
    if (playlist) return buildShare(playlist)
    if (track) return buildShare(track)
    return null
  }, [open, playlist, track])
  const notice = result ? shareNotice(result) : null
  /*
   * 什么情况下不画码：
   * - payload 为空（本地曲目没有可分享地址）；
   * - 歌单里一首都没装进去（payload 只剩歌单名）——那种码扫出来是一句无处可去的话，
   *   提示条已经说明了原因，这里只留复制按钮，避免给出一个扫了没用的码。
   * 判断只用 shareCode 已导出的字段，不复制它的容量逻辑。
   */
  const hasContent = result
    ? result.payload !== '' && (result.kind === 'playlist' ? result.included > 0 : result.shareable)
    : false
  const qrText = hasContent ? (result?.payload ?? '') : ''

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open || !qrText) {
      setDataUrl('')
      setError('')
      return
    }
    let cancelled = false
    setError('')
    setDataUrl('')
    QRCode.toDataURL(qrText, {
      width: QR_SIZE,
      margin: 2,
      color: { dark: '#18191C', light: '#FFFFFF' },
    })
      .then((url) => {
        if (cancelled || !aliveRef.current) return
        setDataUrl(url)
      })
      .catch(() => {
        if (cancelled || !aliveRef.current) return
        // 画码失败要说人话，不能留一块空白
        setError('二维码生成失败，可以直接用下方文本复制分享')
      })
    return () => {
      cancelled = true
    }
  }, [open, qrText])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 「已复制」两秒后自行消失；重复点击会重置计时
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = useCallback(async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.text)
      if (aliveRef.current) setCopied(true)
    } catch {
      // 剪贴板被拒（无权限 / 非安全上下文）时退回「选中文本框，让用户自己按 Ctrl+C」
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.select()
    }
  }, [result])

  if (!open || !result) return null

  const title = result.kind === 'playlist' ? '分享歌单' : '分享歌曲'

  return createPortal(
    <div className="ai-sheet-overlay" onClick={onClose}>
      <div className="ai-sheet share-qr" onClick={(e) => e.stopPropagation()}>
        <div className="ai-sheet__head">
          <strong>{title}</strong>
          <button type="button" className="ai-sheet__close" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="ai-sheet__body share-qr__body">
          {notice && <p className="share-qr__notice">{notice}</p>}

          {qrText ? (
            dataUrl ? (
              // 白底容器：深色主题下透明底二维码扫不出来，底色必须在图片外框上
              <div className="share-qr__frame">
                <img src={dataUrl} alt="分享二维码" width={QR_SIZE} height={QR_SIZE} />
              </div>
            ) : error ? (
              <p className="share-qr__error">{error}</p>
            ) : (
              <div className="share-qr__frame share-qr__frame--loading">生成中…</div>
            )
          ) : null}

          <textarea
            ref={textareaRef}
            className="share-qr__text"
            readOnly
            value={result.text}
            rows={result.kind === 'playlist' ? 6 : 3}
            aria-label="分享文本"
          />

          <div className="share-qr__actions">
            <button type="button" className="share-qr__copy" onClick={() => { void copy() }}>
              {copied ? '已复制' : '复制文本'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

import { useState, useCallback } from 'react'
import { X, Download, Upload, Cloud, CloudDownload, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react'
import {
  collectBackup,
  buildBackupFile,
  readBackupMeta,
  decryptBackup,
  applyBackup,
  type BackupPayload,
  type BackupMeta,
  type ApplyResult,
} from '@/utils/backup'
import { useAuth } from '@/contexts/AuthContext'

const BACKUP_FILE = 'biliMusic-backup.bmback'

interface BackupModalProps {
  onClose: () => void
  webdavConfigured: boolean
}

type Phase =
  | { name: 'menu' }
  | { name: 'export'; step: 'privacy' | 'password' | 'busy' }
  | { name: 'import'; step: 'pick' | 'password' | 'account' | 'busy' }
  | { name: 'result' }

interface AccountChoice {
  same: boolean
  currentName: string
  currentUid: string
  backupName: string
  backupUid: string
}

export default function BackupModal({ onClose, webdavConfigured }: BackupModalProps) {
  const { checkLogin, username: curName } = useAuth()
  const [phase, setPhase] = useState<Phase>({ name: 'menu' })
  const [password, setPassword] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [meta, setMeta] = useState<BackupMeta | null>(null)
  const [pendingPayload, setPendingPayload] = useState<BackupPayload | null>(null)
  const [pendingText, setPendingText] = useState<string>('')
  const [account, setAccount] = useState<AccountChoice | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string; detail?: ApplyResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exportTarget, setExportTarget] = useState<'file' | 'webdav'>('file')

  const api = window.electronAPI
  const hasFileApi = Boolean(api?.saveBackupFile && api?.openBackupFile)

  // ===== 导出 =====
  const startExport = (target: 'file' | 'webdav') => { setExportTarget(target); setPassword(''); setConfirmPw(''); setPhase({ name: 'export', step: 'privacy' }) }
  const toPassword = () => setPhase({ name: 'export', step: 'password' })

  const doExport = useCallback(async (viaWebdav: boolean) => {
    setPhase({ name: 'export', step: 'busy' }); setBusy(true); setError('')
    try {
      if (!password) throw new Error('请设置备份口令')
      if (password.length < 4) throw new Error('口令至少 4 位')
      if (password !== confirmPw) throw new Error('两次输入的口令不一致')
      const payload = await collectBackup()
      const fileText = await buildBackupFile(payload, password)
      if (viaWebdav) {
        const put = await api?.webdavPut?.(BACKUP_FILE, fileText)
        if (!put?.ok) throw new Error(put?.message || '上传 WebDAV 失败')
        setResult({ ok: true, message: `已同步到 WebDAV（${BACKUP_FILE}）` })
      } else {
        const save = await api?.saveBackupFile?.(fileText)
        if (save?.canceled) { setPhase({ name: 'menu' }); return }
        if (!save?.ok) throw new Error(save?.message || '写入文件失败')
        setResult({ ok: true, message: `已导出到：${save.path || '所选位置'}` })
      }
      setPhase({ name: 'result' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase({ name: 'export', step: 'password' })
    } finally {
      setBusy(false)
    }
  }, [password, confirmPw, api])

  // ===== 导入 =====
  const startImport = useCallback(async (viaWebdav: boolean) => {
    setError(''); setPassword(''); setMeta(null); setPendingPayload(null); setPendingText(''); setAccount(null)
    try {
      let fileText: string
      if (viaWebdav) {
        setBusy(true)
        const get = await api?.webdavGet?.(BACKUP_FILE)
        if (!get?.ok || !get.content) throw new Error(get?.message || 'WebDAV 上未找到备份文件')
        fileText = get.content
      } else {
        setBusy(true)
        const open = await api?.openBackupFile?.()
        if (open?.canceled) return
        if (!open?.ok || !open.content) throw new Error(open?.message || '读取文件失败')
        fileText = open.content
      }
      setMeta(readBackupMeta(fileText))
      setPendingText(fileText)
      setPhase({ name: 'import', step: 'password' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase({ name: 'menu' })
    } finally {
      setBusy(false)
    }
  }, [api])

  const doImportDecrypt = useCallback(async () => {
    const fileText = pendingText
    if (!fileText) { setError('请先选择备份文件'); return }
    setBusy(true); setError('')
    try {
      const payload = await decryptBackup(fileText, password)
      setPendingPayload(payload)
      // 账号比对
      const cur = await api?.biliApi?.getCookies?.()
      const backupUid = payload.account?.dedeUserId || ''
      const currentUid = cur?.dedeUserId || ''
      const same = !!backupUid && backupUid === currentUid
      setAccount({
        same: same || !backupUid,
        currentName: cur?.isLoggedIn ? (curName || '已登录') : '未登录',
        currentUid,
        backupName: payload.account?.username || '（备份内未记录用户名）',
        backupUid,
      })
      setPhase({ name: 'import', step: 'account' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [password, pendingText, api, curName])

  const finishImport = useCallback(async (switchAccount: boolean) => {
    const payload = pendingPayload
    if (!payload) return
    setBusy(true); setError('')
    try {
      // 账号处理：仅在备份含账号且用户选择切换时写回 Cookie
      if (switchAccount && payload.account?.sessdata && payload.account?.dedeUserId) {
        const res = await api?.biliApi?.setCookies?.({
          sessdata: payload.account.sessdata,
          biliJct: payload.account.biliJct,
          dedeUserId: payload.account.dedeUserId,
        })
        if (!res?.success) throw new Error(res?.message || '切换账号失败（凭证可能已失效，稍后可重新登录）')
        localStorage.setItem('bilimusic_user', JSON.stringify({ username: payload.account.username, avatar: payload.account.avatar }))
        await checkLogin().catch(() => undefined)
      }
      const detail = applyBackup(payload)
      setResult({ ok: true, message: switchAccount ? '导入完成，已切换到备份账号' : '导入完成，数据已合并', detail })
      setPhase({ name: 'result' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [pendingPayload, api, checkLogin])

  const cancel = () => { setPhase({ name: 'menu' }); setError(''); setPassword('') }

  return (
    <div className="bm-backdrop" onClick={busy ? undefined : onClose}>
      <div className="bm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="bm-head">
          <span className="bm-title"><ShieldCheck size={18} /> 备份数据</span>
          <button type="button" className="bm-close" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>

        {phase.name === 'menu' && (
          <div className="bm-body">
            <p className="bm-hint">
              一键备份 B 站账号、歌单、我喜欢、最近播放、下载记录、歌词偏移与设置。导出前会设置口令加密，忘记口令无法恢复。
            </p>
            {hasFileApi && (
              <button type="button" className="bm-btn" onClick={() => startExport('file')} disabled={busy}>
                <Download size={16} /> 导出为文件
              </button>
            )}
            {webdavConfigured && (
              <button type="button" className="bm-btn" onClick={() => startExport('webdav')} disabled={busy}>
                <Cloud size={16} /> 同步至 WebDAV
              </button>
            )}
            {hasFileApi && (
              <button type="button" className="bm-btn" onClick={() => startImport(false)} disabled={busy}>
                <Upload size={16} /> 从文件导入
              </button>
            )}
            {webdavConfigured && (
              <button type="button" className="bm-btn" onClick={() => startImport(true)} disabled={busy}>
                <CloudDownload size={16} /> 从 WebDAV 导入
              </button>
            )}
            {error && <p className="bm-error"><AlertTriangle size={14} /> {error}</p>}
          </div>
        )}

        {phase.name === 'export' && phase.step === 'privacy' && (
          <div className="bm-body">
            <div className="bm-warn">
              <AlertTriangle size={18} />
              <p>导出的文件包含你的 B 站登录凭证（Cookie）等隐私数据。请确认会妥善保管该文件，避免泄露给他人；口令也无法找回泄露的数据。</p>
            </div>
            <div className="bm-actions">
              <button type="button" className="bm-btn ghost" onClick={cancel}>取消</button>
              <button type="button" className="bm-btn primary" onClick={toPassword}>我已了解，继续</button>
            </div>
          </div>
        )}

        {phase.name === 'export' && phase.step === 'password' && (
          <div className="bm-body">
            <label className="bm-field">设置口令
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 4 位，忘记不可恢复" autoFocus />
            </label>
            <label className="bm-field">再次输入口令
              <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="确认口令" />
            </label>
            {error && <p className="bm-error"><AlertTriangle size={14} /> {error}</p>}
            <div className="bm-actions">
              <button type="button" className="bm-btn ghost" onClick={cancel} disabled={busy}>取消</button>
              <button type="button" className="bm-btn primary" onClick={() => doExport(exportTarget === 'webdav')} disabled={busy}>
                {busy ? <Loader2 size={16} className="bm-spin" /> : (exportTarget === 'webdav' ? <Cloud size={16} /> : <Download size={16} />)}
                {exportTarget === 'webdav' ? '加密并同步 WebDAV' : '加密并保存文件'}
              </button>
            </div>
          </div>
        )}

        {phase.name === 'export' && phase.step === 'busy' && (
          <div className="bm-body bm-center"><Loader2 size={22} className="bm-spin" /> 正在加密并导出…</div>
        )}

        {phase.name === 'import' && phase.step === 'password' && (
          <div className="bm-body">
            {meta && (
              <p className="bm-hint">
                备份导出时间：{new Date(meta.exportedAt).toLocaleString()}
                <br />{meta.hasAccount ? '包含 B 站账号信息' : '不含账号信息'}
              </p>
            )}
            <label className="bm-field">输入备份口令
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="解密所需口令" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') doImportDecrypt() }} />
            </label>
            {error && <p className="bm-error"><AlertTriangle size={14} /> {error}</p>}
            <div className="bm-actions">
              <button type="button" className="bm-btn ghost" onClick={cancel} disabled={busy}>取消</button>
              <button type="button" className="bm-btn primary" onClick={doImportDecrypt} disabled={busy || !password}>
                {busy ? <Loader2 size={16} className="bm-spin" /> : null} 解密
              </button>
            </div>
          </div>
        )}

        {phase.name === 'import' && phase.step === 'account' && account && (
          <div className="bm-body">
            {account.same ? (
              <>
                <p className="bm-hint">账号一致或备份不含账号，将把数据合并到本机。</p>
                <div className="bm-actions">
                  <button type="button" className="bm-btn ghost" onClick={cancel}>取消</button>
                  <button type="button" className="bm-btn primary" onClick={() => finishImport(false)} disabled={busy}>确认导入合并</button>
                </div>
              </>
            ) : (
              <>
                <div className="bm-warn">
                  <AlertTriangle size={18} />
                  <p>备份账号与当前账号不同。<br />当前：{account.currentName}<br />备份：{account.backupName}</p>
                </div>
                <p className="bm-hint">导入会合并数据；设置项将以备份覆盖本机。请选择对登录账号的处理：</p>
                <div className="bm-actions">
                  <button type="button" className="bm-btn ghost" onClick={() => finishImport(false)} disabled={busy}>保留当前账号</button>
                  <button type="button" className="bm-btn primary" onClick={() => finishImport(true)} disabled={busy}>切换到备份账号</button>
                </div>
              </>
            )}
            {error && <p className="bm-error"><AlertTriangle size={14} /> {error}</p>}
          </div>
        )}

        {phase.name === 'result' && result && (
          <div className="bm-body">
            <p className={result.ok ? 'bm-ok' : 'bm-error'}>
              {result.ok ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />} {result.message}
            </p>
            {result.detail && (
              <p className="bm-hint">
                歌单 {result.detail.playlists} · 我喜欢 {result.detail.favorites} · 最近播放 {result.detail.recent} · 下载记录 {result.detail.downloads}
              </p>
            )}
            <div className="bm-actions"><button type="button" className="bm-btn primary" onClick={onClose}>完成</button></div>
          </div>
        )}

        {busy && phase.name === 'menu' && (
          <div className="bm-body bm-center"><Loader2 size={22} className="bm-spin" /> 正在读取备份…</div>
        )}
      </div>
    </div>
  )
}

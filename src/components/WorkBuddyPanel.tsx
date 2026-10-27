/**
 * v1.4.13-pre4 WorkBuddy 接入面板（弹出式，不占设置板块）。
 *
 * 三种入口并存：
 * - 直接使用本机 WorkBuddy 桌面端已登录的凭据（不必再登录）
 * - 网页登录（国内版 / 国际版，系统浏览器完成授权后回填）
 * - 模型切换：从该区域可用模型里选，选中即作为当前 AI 来源
 */
import { useEffect, useState } from 'react'
import { ActionButton } from '@/components/AppleMusicPage'
import { platform } from '@/platform'

type Region = 'cn' | 'global'

interface Credential {
  accessToken: string
  region: Region
  account?: string
  expiresAt?: number
}

interface Props {
  onClose: () => void
  /** 选定模型后回填给设置页（作为当前 AI 来源） */
  onPick: (cred: Credential, model: string) => void
}

export default function WorkBuddyPanel({ onClose, onPick }: Props) {
  const [region, setRegion] = useState<Region>('cn')
  const [local, setLocal] = useState<Credential[]>([])
  const [saved, setSaved] = useState<Credential | null>(null)
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const cap = platform.workbuddy

  useEffect(() => {
    if (!cap) return
    void (async () => {
      try {
        const [l, s] = await Promise.all([cap.localCredentials(), cap.savedCredential()])
        setLocal(l)
        setSaved(s)
        if (s) setRegion(s.region)
      } catch {
        /* ignore */
      }
    })()
  }, [cap])

  const current = saved || local[0] || null

  const loadModels = async (cred: Credential) => {
    if (!cap) return
    setBusy(true)
    setMsg('读取模型列表…')
    try {
      const list = await cap.models(cred.region, cred.accessToken)
      setModels(list)
      setModel(list[0]?.id || '')
      setMsg(list.length ? '共 ' + list.length + ' 个可用模型' : '该账号没有可用模型')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const applyLocalCredential = async (cred: Credential) => {
    setRegion(cred.region)
    await cap?.saveCredential(cred)
    setSaved(cred)
    await loadModels(cred)
  }

  const webLogin = async () => {
    if (!cap) return
    setBusy(true)
    setMsg('正在打开浏览器…')
    try {
      const r = await cap.startLogin(region)
      if (!r.ok || !r.key) {
        setMsg(r.message || '发起登录失败')
        return
      }
      setMsg('请在浏览器完成登录，完成后会自动回填')
      // 轮询，最长 10 分钟
      const deadline = Date.now() + 10 * 60 * 1000
      const key = r.key
      const tick = async () => {
        if (Date.now() > deadline) { setMsg('登录超时，请重试'); setBusy(false); return }
        const p = await cap.pollLogin(key)
        if (p.status === 'ok') {
          await cap.saveCredential(p.credential)
          setSaved(p.credential)
          setMsg('登录成功')
          setBusy(false)
          await loadModels(p.credential)
          return
        }
        if (p.status === 'expired') { setMsg('登录已过期，请重试'); setBusy(false); return }
        setTimeout(() => void tick(), 2500)
      }
      setTimeout(() => void tick(), 2500)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="wb-overlay" onClick={onClose}>
      <div className="wb-panel" onClick={(e) => e.stopPropagation()}>
        <div className="wb-head">
          <strong>WorkBuddy 模型</strong>
          <button type="button" className="wb-close" onClick={onClose}>×</button>
        </div>

        <div className="wb-row">
          <span>区域</span>
          <select
            className="settings-select"
            value={region}
            onChange={(e) => setRegion(e.target.value as Region)}
          >
            <option value="cn">国内版（codebuddy.cn）</option>
            <option value="global">国际版（workbuddy.ai）</option>
          </select>
        </div>

        <div className="wb-row">
          <span>本机凭据</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {local.length === 0 && <em style={{ opacity: 0.6 }}>未检测到桌面端登录</em>}
            {local.map((c, i) => (
              <ActionButton key={i} onClick={() => void applyLocalCredential(c)}>
                {c.region === 'cn' ? '国内' : '国际'}{c.account ? ' · ' + c.account : ''}
              </ActionButton>
            ))}
          </div>
        </div>

        <div className="wb-row">
          <span>网页登录</span>
          <ActionButton onClick={() => void webLogin()} disabled={busy}>
            {busy ? '处理中…' : '用浏览器登录' + (region === 'cn' ? '国内版' : '国际版')}
          </ActionButton>
        </div>

        <div className="wb-row">
          <span>当前账号</span>
          <em style={{ opacity: 0.75 }}>
            {current ? (current.region === 'cn' ? '国内版' : '国际版') + (current.account ? ' · ' + current.account : '') : '未登录'}
          </em>
        </div>

        <div className="wb-row">
          <span>模型</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="settings-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.length === 0 && <option value="">（先选择账号读取模型）</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <ActionButton
              onClick={() => { if (current && model) { onPick(current, model); onClose() } }}
              disabled={!current || !model}
            >
              使用此模型
            </ActionButton>
          </div>
        </div>

        {msg && <p className="wb-msg">{msg}</p>}
      </div>
    </div>
  )
}

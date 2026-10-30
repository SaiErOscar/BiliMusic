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
  /** 已保存的模型 id，用于打开面板时回显上次的选择 */
  initialModel?: string
}

export default function WorkBuddyPanel({ onClose, onPick, initialModel }: Props) {
  const [region, setRegion] = useState<Region>('cn')
  const [local, setLocal] = useState<Credential[]>([])
  const [saved, setSaved] = useState<Credential | null>(null)
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  /** v1.4.13-pre11 账号池：本机桌面端 + 已保存的网页登录 */
  const [accounts, setAccounts] = useState<{ id: string; region: Region; account: string; expiresAt: number; origin: string }[]>([])
  /** v1.4.13-pre11 当前账号积分；上游不提供时为 null */
  const [credits, setCredits] = useState<{ remaining: number; used: number } | null>(null)
  const [creditsMsg, setCreditsMsg] = useState('')

  const cap = platform.workbuddy

  /*
   * 打开面板时恢复上次的登录态。
   *
   * v1.4.13-pre8（用户第 3 项「可列出账号、绑定账号，但仍无法持久显示」）：
   * 原来只把 saved 塞进 state，**没有去拉模型列表**，也没回填上次选的模型。
   * 于是模型下拉是空的、「使用此模型」不可点，界面上看起来就像没登录。
   * 现在读到凭据就自动拉一次模型，并把已存模型回显出来。
   */
  useEffect(() => {
    if (!cap) return
    let cancelled = false
    void (async () => {
      try {
        const [l, s, acc] = await Promise.all([
          cap.localCredentials(),
          cap.savedCredential(),
          cap.accounts ? cap.accounts() : Promise.resolve([]),
        ])
        if (cancelled) return
        setLocal(l)
        setSaved(s)
        setAccounts(acc || [])
        if (!s) return
        setRegion(s.region)
        setBusy(true)
        setMsg('读取模型列表…')
        const list = await cap.models(s.region, s.accessToken)
        if (cancelled) return
        setModels(list)
        // 优先回显上次选的模型；它不在列表里（如账号换了）才退回第一个
        const prefer = initialModel && list.some((m) => m.id === initialModel) ? initialModel : (list[0]?.id || '')
        setModel(prefer)
        setMsg(list.length ? '共 ' + list.length + ' 个可用模型' : '该账号没有可用模型')
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [cap, initialModel])

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

  /**
   * v1.4.13-pre11 查积分。
   *
   * 上游不提供时明确说「查不到」，不用本地统计冒充——积分是账，猜不得。
   */
  const loadCredits = async (cred: Credential) => {
    if (!cap?.credits) { setCreditsMsg('当前版本不支持积分查询'); return }
    setCreditsMsg('查询中…')
    try {
      const r = await cap.credits(cred)
      if (!r) { setCredits(null); setCreditsMsg('上游未提供积分信息'); return }
      setCredits(r)
      setCreditsMsg('')
    } catch (e) {
      setCredits(null)
      setCreditsMsg(e instanceof Error ? e.message : String(e))
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

        {/*
          v1.4.13-pre11（用户第 3 项）：账号池。
          同时登录多个 WorkBuddy 账号时在这里统一维护——能看见有几个号、
          各自是哪个区域、token 何时过期，并能一键切换。
        */}
        <div className="wb-row">
          <span>账号池</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
            {accounts.length === 0 ? (
              <em style={{ opacity: 0.6 }}>暂无可用账号</em>
            ) : (
              accounts.map((a) => (
                <div key={a.id} className="wb-account">
                  <strong>{a.account}</strong>
                  <em>{a.region === 'cn' ? '中国版' : '国际版'}</em>
                  <em>{a.origin === 'local' ? '本机' : '网页登录'}</em>
                  <em>
                    {a.expiresAt > 0
                      ? '至 ' + new Date(a.expiresAt).toLocaleDateString()
                      : '有效期未知'}
                  </em>
                  <span style={{ flex: 1 }} />
                  <ActionButton
                    onClick={() => {
                      const found = local.find((c) => (c.account || '') === a.account && c.region === a.region)
                      if (found) void applyLocalCredential(found)
                      else if (saved && (saved.account || '') === a.account) void applyLocalCredential(saved)
                      else setMsg('该账号不在当前可用凭据里，请重新登录')
                    }}
                  >
                    使用
                  </ActionButton>
                </div>
              ))
            )}
          </div>
        </div>

        {/* v1.4.13-pre11（用户第 3、4 项）：查账号积分 */}
        <div className="wb-row">
          <span>积分</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ActionButton onClick={() => current && void loadCredits(current)} disabled={!current}>
              查看积分
            </ActionButton>
            <em style={{ opacity: 0.75 }}>
              {credits
                ? '剩余 ' + credits.remaining + ' · 已用 ' + credits.used
                : (creditsMsg || '未查询')}
            </em>
          </div>
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

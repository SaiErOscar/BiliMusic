/**
 * v1.4.13-pre12 WorkBuddy 分页面板。
 *
 * 用户要求：
 * - 把 WorkBuddy 面板**完全迁移**进 AI 配置面板（不再有独立弹窗）；
 * - **取消「区域」下拉**——在国内版分页下就配国内版，国际版分页下就配国际版；
 * - 账号池独立显示，且国内分页不再显示国际版本机凭据（反之亦然）。
 *
 * 因此这个组件的 region 由父级分页决定，组件内部不再切换区域。
 */
import { useCallback, useEffect, useState } from 'react'
import { ActionButton } from '@/components/AppleMusicPage'
import { platform } from '@/platform'

type Region = 'cn' | 'global'

interface Credential {
  accessToken: string
  region: Region
  account?: string
  expiresAt?: number
}

interface Account {
  id: string
  region: Region
  account: string
  expiresAt: number
  origin: string
}

interface Props {
  /** 由父级分页决定，组件内不可切换 */
  region: Region
  /** 已保存的模型 id，用于回显 */
  initialModel?: string
  /** 选定模型后回填给设置页 */
  onPick: (cred: Credential, model: string) => void
}

const REGION_LABEL: Record<Region, string> = {
  cn: 'WorkBuddy 中国版（codebuddy.cn）',
  global: 'WorkBuddy 国际版（workbuddy.ai）',
}

export default function WorkBuddyPane({ region, initialModel, onPick }: Props) {
  const [local, setLocal] = useState<Credential[]>([])
  const [saved, setSaved] = useState<Credential | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [model, setModel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [credits, setCredits] = useState<{ remaining: number; used: number } | null>(null)
  const [creditsMsg, setCreditsMsg] = useState('')

  const cap = platform.workbuddy

  /** 只保留本分页所属区域的凭据——用户明确要求不跨区显示 */
  const sameRegion = useCallback(
    (cred: Credential | null): cred is Credential => !!cred && cred.region === region,
    [region],
  )

  const loadModels = useCallback(async (cred: Credential) => {
    if (!cap) return
    setBusy(true)
    setMsg('读取模型列表…')
    try {
      const list = await cap.models(cred.region, cred.accessToken)
      setModels(list)
      const prefer = initialModel && list.some((m) => m.id === initialModel) ? initialModel : (list[0]?.id || '')
      setModel(prefer)
      setMsg(list.length ? '共 ' + list.length + ' 个可用模型' : '该账号没有可用模型')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [cap, initialModel])

  /*
   * 打开分页时恢复该区域已有的登录态。
   * v1.4.13-pre12：按 region 过滤——切到中国版分页时不该看到国际版账号。
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
        const mine = (l || []).filter((c) => c.region === region)
        const savedMine = sameRegion(s as Credential | null) ? (s as Credential) : null
        setLocal(mine)
        setSaved(savedMine)
        setAccounts((acc || []).filter((a) => a.region === region))
        const current = savedMine || mine[0] || null
        if (current) await loadModels(current)
      } catch (e) {
        if (!cancelled) setMsg(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [cap, region, sameRegion, loadModels])

  const current = saved || local[0] || null

  const applyLocal = async (cred: Credential) => {
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

  const loadCredits = async () => {
    if (!cap?.credits) { setCreditsMsg('当前版本不支持积分查询'); return }
    if (!current) return
    setCreditsMsg('查询中…')
    try {
      const r = await cap.credits(current)
      if (!r) { setCredits(null); setCreditsMsg('上游未提供积分信息'); return }
      setCredits(r)
      setCreditsMsg('')
    } catch (e) {
      setCredits(null)
      setCreditsMsg(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <div className="ai-sheet__field">
        <span className="ai-sheet__hint">{REGION_LABEL[region]}。区域由上方分页决定，无需再选。</span>
      </div>

      <div className="ai-sheet__field">
        <span className="ai-sheet__label">本机凭据</span>
        <div className="ai-sheet__row" style={{ flexWrap: 'wrap' }}>
          {local.length === 0 && <span className="ai-sheet__hint">未检测到该区域的桌面端登录</span>}
          {local.map((c, i) => (
            <ActionButton key={i} onClick={() => void applyLocal(c)}>
              {c.account || '未命名'}
            </ActionButton>
          ))}
        </div>
      </div>

      <div className="ai-sheet__field">
        <span className="ai-sheet__label">网页登录</span>
        <div className="ai-sheet__row">
          <ActionButton onClick={() => void webLogin()} disabled={busy}>
            {busy ? '处理中…' : '用浏览器登录'}
          </ActionButton>
          <span className="ai-sheet__hint">
            {current ? '当前：' + (current.account || '未命名') : '未登录'}
          </span>
        </div>
      </div>

      {/* 账号池：只显示本区域的账号 */}
      <div className="ai-sheet__field">
        <span className="ai-sheet__label">账号池（{accounts.length}）</span>
        {accounts.length === 0 ? (
          <span className="ai-sheet__hint">该区域暂无可用账号</span>
        ) : (
          <div className="ai-sheet__saved">
            {accounts.map((a) => (
              <div key={a.id} className="wb-account">
                <strong>{a.account}</strong>
                <em>{a.origin === 'local' ? '本机' : '网页登录'}</em>
                <em>{a.expiresAt > 0 ? '至 ' + new Date(a.expiresAt).toLocaleDateString() : '有效期未知'}</em>
                <span style={{ flex: 1 }} />
                <ActionButton
                  onClick={() => {
                    const found = local.find((c) => (c.account || '') === a.account)
                    if (found) void applyLocal(found)
                    else if (saved && (saved.account || '') === a.account) void applyLocal(saved)
                    else setMsg('该账号不在当前可用凭据里，请重新登录')
                  }}
                >
                  使用
                </ActionButton>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ai-sheet__field">
        <span className="ai-sheet__label">模型</span>
        <div className="ai-sheet__row">
          <select className="settings-select" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.length === 0 && <option value="">（先选择账号读取模型）</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <ActionButton
            onClick={() => { if (current && model) onPick(current, model) }}
            disabled={!current || !model}
          >
            使用此模型
          </ActionButton>
        </div>
      </div>

      <div className="ai-sheet__field">
        <span className="ai-sheet__label">积分</span>
        <div className="ai-sheet__row">
          <ActionButton onClick={() => void loadCredits()} disabled={!current}>查看积分</ActionButton>
          <span className="ai-sheet__hint">
            {credits ? '剩余 ' + credits.remaining + ' · 已用 ' + credits.used : (creditsMsg || '未查询')}
          </span>
        </div>
      </div>

      {msg && <span className="ai-sheet__hint">{msg}</span>}
    </>
  )
}

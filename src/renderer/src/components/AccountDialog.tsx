import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Eye, EyeOff, ExternalLink, KeyRound, LoaderCircle, Trash2 } from 'lucide-react'
import { ACCOUNT_COLORS, PROVIDERS, detectPreset, findPreset, type ProviderPreset } from '@shared/presets'
import type { AccountDraft, AuthType, ServerConfig } from '@shared/types'
import { api } from '../api'
import { confirmDialog, errorText, reloadAccounts, setView, toast, useStore } from '../store'
import { cx, escapeHtml } from '../util'
import { Modal, ProviderLogo, Switch } from './Common'

function ServerFields({ title, value, onChange }: { title: string; value: ServerConfig; onChange: (v: ServerConfig) => void }) {
  return (
    <div className="field">
      <label>{title}</label>
      <div className="grid-2" style={{ gridTemplateColumns: '1fr 90px 120px' }}>
        <input className="input" value={value.host} placeholder="服务器地址" onChange={(e) => onChange({ ...value, host: e.target.value })} />
        <input className="input" value={value.port} inputMode="numeric" onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
        <select className="select" value={value.secure ? 'ssl' : 'starttls'} onChange={(e) => onChange({ ...value, secure: e.target.value === 'ssl' })}>
          <option value="ssl">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
        </select>
      </div>
    </div>
  )
}

export function AccountDialog({ accountId, provider }: { accountId?: string; provider?: string }) {
  const accounts = useStore((s) => s.accounts)
  const existing = accounts.find((a) => a.id === accountId)
  const [preset, setPreset] = useState<ProviderPreset | null>(existing ? findPreset(existing.provider) : provider ? findPreset(provider) : null)
  const [email, setEmail] = useState(existing?.email ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [label, setLabel] = useState(existing?.label ?? '')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [authType, setAuthType] = useState<AuthType>(existing?.authType ?? preset?.auth[0] ?? 'password')
  const [imap, setImap] = useState<ServerConfig>(existing?.imap ?? preset?.imap ?? { host: '', port: 993, secure: true })
  const [smtp, setSmtp] = useState<ServerConfig>(existing?.smtp ?? preset?.smtp ?? { host: '', port: 465, secure: true })
  const [username, setUsername] = useState(existing && existing.username !== existing.email ? existing.username : '')
  const [useProxy, setUseProxy] = useState(existing?.useProxy ?? preset?.useProxy ?? false)
  const [appendSent, setAppendSent] = useState(existing?.appendSent ?? preset?.appendSent ?? true)
  const [color, setColor] = useState(existing?.color ?? '')
  const [signature, setSignature] = useState(existing?.signature?.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') ?? '')
  const [oauth, setOauth] = useState<{ handle: string; email: string } | null>(null)
  const [busy, setBusy] = useState<'test' | 'oauth' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canForce, setCanForce] = useState(false)

  const close = () => useStore.setState({ dialog: null })

  const choose = (p: ProviderPreset) => {
    setPreset(p)
    setAuthType(p.auth[0])
    setImap(p.imap)
    setSmtp(p.smtp)
    setUseProxy(p.useProxy)
    setAppendSent(p.appendSent)
    setError(null)
  }

  // 选“其他邮箱”时根据邮箱地址自动识别服务商
  useEffect(() => {
    if (preset?.id !== 'custom' || existing) return
    const p = detectPreset(email)
    if (p) choose(p)
    else {
      const domain = email.split('@')[1]
      if (domain && !imap.host) {
        setImap({ host: `imap.${domain}`, port: 993, secure: true })
        setSmtp({ host: `smtp.${domain}`, port: 465, secure: true })
      }
    }
  }, [email]) // eslint-disable-line react-hooks/exhaustive-deps

  const isOAuth = authType !== 'password'
  const draft = useMemo<AccountDraft | null>(() => {
    if (!preset) return null
    return {
      id: existing?.id,
      email: email.trim(),
      name: name.trim(),
      label: label.trim() || undefined,
      provider: preset.id,
      color: color || undefined,
      authType,
      username: username.trim() || undefined,
      imap,
      smtp,
      useProxy,
      appendSent,
      signature: signature.trim() ? escapeHtml(signature.trim()).replace(/\n/g, '<br>') : '',
      password: authType === 'password' ? password || undefined : undefined,
      oauthHandle: oauth?.handle
    }
  }, [preset, existing, email, name, label, color, authType, username, imap, smtp, useProxy, appendSent, signature, password, oauth])

  // 等浏览器登录时按钮可以再点一次（重新打开浏览器）；只认最后一次的结果
  const oauthAttempt = useRef(0)
  const doOAuth = async () => {
    const mine = ++oauthAttempt.current
    setBusy('oauth')
    setError(null)
    try {
      const r = await api.oauthLogin(authType === 'oauth-google' ? 'google' : 'microsoft', email || undefined)
      if (mine !== oauthAttempt.current) return
      setOauth({ handle: r.handle, email: r.email || email.trim() })
      // 已经填了邮箱就不改：微软账号的登录名可能是别的地址（比如 QQ 邮箱），收发信要用 Outlook 地址
      if (r.email && !email.trim()) setEmail(r.email)
      if (r.name && !name) setName(r.name)
      toast('授权成功', 'ok')
    } catch (err) {
      if (mine === oauthAttempt.current) setError(errorText(err))
    } finally {
      if (mine === oauthAttempt.current) setBusy(null)
    }
  }

  const save = async (force = false) => {
    if (!draft) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) return setError('请填写正确的邮箱地址')
    if (!isOAuth && !draft.password && !existing) return setError(`请填写${preset?.passwordLabel ?? '密码'}`)
    if (isOAuth && !oauth && (!existing || existing.authType !== authType)) return setError('请先点击上面的按钮完成登录授权')
    if (!draft.imap.host || !draft.smtp.host) return setError('请填写收信和发信服务器')
    setBusy('test')
    setError(null)
    setCanForce(false)
    try {
      if (!force) {
        const r = await api.testAccount(draft)
        if (!r.ok) {
          setError(r.error ?? '连接失败')
          setCanForce(true)
          return
        }
      }
      await api.saveAccount(draft)
      await reloadAccounts()
      toast(existing ? '已保存' : '添加成功，正在同步邮件…', 'ok')
      close()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!existing) return
    if (!(await confirmDialog(`删除账号“${existing.label}”？本地缓存的邮件会被清除，服务器上的邮件不受影响。`, '删除账号', true))) {
      useStore.setState({ dialog: { kind: 'account', accountId: existing.id } })
      return
    }
    try {
      await api.removeAccount(existing.id)
      await reloadAccounts()
      const v = useStore.getState().view
      if (v.kind !== 'unified' && v.accountId === existing.id) setView({ kind: 'unified', box: 'inbox' })
      toast('账号已删除', 'ok')
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  // ---------- 第一步：选服务商 ----------
  if (!preset) {
    return (
      <Modal title="添加邮箱" onClose={close}>
        <div className="dialog-body">
          <div className="hint">选择你的邮箱服务商。服务器参数会自动填好，你只需要填邮箱地址和授权码。</div>
          <div className="provider-grid">
            {PROVIDERS.map((p) => (
              <div key={p.id} className="provider" onClick={() => choose(p)}>
                <ProviderLogo id={p.id} />
                {p.name}
              </div>
            ))}
          </div>
        </div>
      </Modal>
    )
  }

  // ---------- 第二步：填写信息 ----------
  const providerName = authType === 'oauth-google' ? 'Google' : '微软'
  return (
    <Modal
      title={existing ? `编辑账号 · ${existing.label}` : `添加 ${preset.name}`}
      onClose={close}
      icon={
        existing ? undefined : (
          <button className="btn icon" onClick={() => setPreset(null)} title="返回">
            <ArrowLeft size={18} />
          </button>
        )
      }
      footer={
        <>
          {existing && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              <Trash2 size={15} />
              删除账号
            </button>
          )}
          {canForce && (
            <button className="btn outline" onClick={() => save(true)} disabled={!!busy}>
              仍然保存
            </button>
          )}
          <button className="btn outline" onClick={close}>
            取消
          </button>
          <button className="btn primary" onClick={() => save()} disabled={!!busy}>
            {busy === 'test' ? <LoaderCircle size={15} className="spin" /> : null}
            {busy === 'test' ? '正在验证…' : existing ? '保存' : '登录并添加'}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <div className="help-box">
          {preset.help}
          {preset.helpUrl && (
            <>
              {' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api.openExternal(preset.helpUrl!))}>
                打开网页 <ExternalLink size={11} />
              </a>
            </>
          )}
        </div>

        {preset.auth.length > 1 && (
          <div className="field">
            <label>登录方式</label>
            <div className="segmented" style={{ alignSelf: 'flex-start' }}>
              {preset.auth.map((a) => (
                <button key={a} type="button" className={cx(a === authType && 'on')} onClick={() => setAuthType(a)}>
                  {a === 'password' ? preset.passwordLabel : a === 'oauth-microsoft' ? '微软账号授权' : 'Google 授权'}
                </button>
              ))}
            </div>
          </div>
        )}

        {isOAuth && (
          <div className="field">
            <button className="btn soft" style={{ height: 40 }} onClick={doOAuth} disabled={busy === 'test'}>
              {busy === 'oauth' ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}
              {busy === 'oauth' ? '请在浏览器中完成登录…（点此重新打开）' : oauth ? `已授权：${oauth.email}（点此重新授权）` : `用${providerName}账号登录`}
            </button>
            <div className="hint">
              会打开系统浏览器进行登录，本软件不会接触你的密码。
              {authType === 'oauth-microsoft' && (
                <>
                  首次使用需要在{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), useStore.setState({ dialog: { kind: 'settings', tab: 'oauth' } }))}>
                    设置 → 账号登录
                  </a>{' '}
                  里填写微软应用 ID。
                </>
              )}
            </div>
          </div>
        )}

        <div className="field">
          <label>邮箱地址</label>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={`例如 name@${preset.domains[0] ?? 'example.com'}`} autoFocus={!existing} />
        </div>

        {!isOAuth && (
          <div className="field">
            <label>{preset.passwordLabel}</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={existing ? '不修改请留空' : `填写${preset.passwordLabel}`}
                style={{ paddingRight: 40 }}
                onKeyDown={(e) => e.key === 'Enter' && void save()}
              />
              <button className="btn icon sm" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => setShowPw(!showPw)} type="button">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label>发件人名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="对方收到邮件时看到的名字" />
        </div>

        {error && <div className="error-box">{error}</div>}

        <details className="details" open={preset.id === 'custom' || !!existing}>
          <summary>
            <ChevronRight size={14} />
            更多设置（服务器、代理、签名）
          </summary>
          <div>
            <div className="field">
              <label>侧栏显示名称</label>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={email || '默认显示邮箱地址'} />
            </div>
            <div className="field">
              <label>标记颜色</label>
              <div className="row" style={{ gap: 6 }}>
                {ACCOUNT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: c,
                      border: 'none',
                      cursor: 'pointer',
                      boxShadow: (color || existing?.color) === c ? `0 0 0 2px var(--glass-solid), 0 0 0 4px ${c}` : 'none'
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <label>签名</label>
              <textarea className="textarea" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="写信时自动附在末尾" rows={3} />
            </div>
            <ServerFields title="收信服务器（IMAP）" value={imap} onChange={setImap} />
            <ServerFields title="发信服务器（SMTP）" value={smtp} onChange={setSmtp} />
            <div className="field">
              <label>登录用户名</label>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="一般和邮箱地址相同，可留空" />
            </div>
            <div className="set-row" style={{ padding: '4px 0', minHeight: 0 }}>
              <div className="label">
                <div>通过代理连接</div>
                <div className="hint">Gmail 等境外邮箱在大陆需要开启，代理地址在 设置 → 网络 里配置</div>
              </div>
              <Switch on={useProxy} onChange={setUseProxy} />
            </div>
            <div className="set-row" style={{ padding: '4px 0', minHeight: 0, borderBottom: 'none' }}>
              <div className="label">
                <div>发信后保存副本到“已发送”</div>
                <div className="hint">QQ、Gmail、Outlook 会自动保存，不用开；如果发现已发送里有重复邮件请关闭</div>
              </div>
              <Switch on={appendSent} onChange={setAppendSent} />
            </div>
          </div>
        </details>
      </div>
    </Modal>
  )
}

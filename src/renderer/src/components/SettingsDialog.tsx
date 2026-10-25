import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Bell, Globe, Info, KeyRound, Languages, LoaderCircle, Palette, Pencil, Plus, Users, Wand, Wifi } from 'lucide-react'
import { LANGS } from '@shared/langs'
import { PALETTES } from '@shared/theme'
import type { Settings, TranslateProvider } from '@shared/types'
import { api, isDemo } from '../api'
import { errorText, toast, updateSettings, useStore, type SettingsTab } from '../store'
import { backgroundUnrestricted, isNative, openBatterySettings, requestNotificationPermission } from '../native'
import { cx } from '../util'
import { Modal, Segmented, Switch } from './Common'
import { RulesTab } from './Rules'

const TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: 'appearance', label: '外观', icon: <Palette size={16} /> },
  { id: 'general', label: '通用', icon: <Bell size={16} /> },
  { id: 'translate', label: '翻译', icon: <Languages size={16} /> },
  { id: 'rules', label: '收信规则', icon: <Wand size={16} /> },
  { id: 'accounts', label: '邮箱账号', icon: <Users size={16} /> },
  { id: 'network', label: '网络代理', icon: <Wifi size={16} /> },
  { id: 'oauth', label: '账号登录', icon: <KeyRound size={16} /> },
  { id: 'about', label: '关于', icon: <Info size={16} /> }
]

const PROVIDERS: { id: TranslateProvider; name: string; desc: string }[] = [
  { id: 'google', name: 'Google 翻译（免费）', desc: '不用配置，支持 100+ 种语言，保留邮件排版；大陆网络需要代理。' },
  { id: 'azure', name: '微软翻译', desc: '官方接口，每月 200 万字符免费，国内直连；需要 Azure 密钥。' },
  { id: 'llm', name: '大模型翻译', desc: 'DeepSeek / 通义千问 / Kimi / OpenAI 等，语气最自然，需要 API Key。' },
  { id: 'deepl', name: 'DeepL', desc: '欧洲语言质量很好，免费 Key 每月 50 万字符。' }
]

const LLM_PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
]

/** 失焦或回车时才保存的输入框 */
function LazyInput({ value, onSave, placeholder, type = 'text', mono }: { value: string; onSave: (v: string) => void; placeholder?: string; type?: string; mono?: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <input
      className="input"
      type={type}
      value={v}
      placeholder={placeholder}
      style={mono ? { fontFamily: 'Consolas, monospace', fontSize: 12.5 } : undefined}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="label">
        <div>{title}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Appearance({ s }: { s: Settings }) {
  return (
    <>
      <h4>主题</h4>
      <Row title="颜色模式">
        <Segmented
          value={s.theme}
          options={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' }
          ]}
          onChange={(theme) => updateSettings({ theme })}
        />
      </Row>
      <h4>背景颜色</h4>
      <div className="swatches" style={{ padding: '6px 0 10px' }}>
        {PALETTES.map((p) => (
          <button key={p.id} className={cx('swatch', s.palette === p.id && 'on')} onClick={() => updateSettings({ palette: p.id })}>
            <div className="sw" style={{ background: `linear-gradient(135deg, ${p.light.bg} 50%, ${p.dark.bg} 50%)` }}>
              <i style={{ background: p.light.accent }} />
            </div>
            {p.name}
          </button>
        ))}
      </div>
      <Row title="背景柔光" hint="在纯色背景上加几团柔和的光斑，让磨砂玻璃效果更明显">
        <Switch on={s.orbs} onChange={(orbs) => updateSettings({ orbs })} />
      </Row>
      <Row title="按会话分组" hint="同一话题的往来邮件（包括你的回复）合并成一行，打开后按时间顺序排列">
        <Switch on={s.threading} onChange={(threading) => updateSettings({ threading })} />
      </Row>
      <Row title="列表密度">
        <Segmented
          value={s.density}
          options={[
            { value: 'comfortable', label: '舒适' },
            { value: 'compact', label: '紧凑' }
          ]}
          onChange={(density) => updateSettings({ density })}
        />
      </Row>
    </>
  )
}

function General({ s }: { s: Settings }) {
  return (
    <>
      <h4>阅读</h4>
      <Row title="打开邮件时标为已读">
        <Switch on={s.markReadOnOpen} onChange={(markReadOnOpen) => updateSettings({ markReadOnOpen })} />
      </Row>
      <Row title="自动加载远程图片" hint="关闭后可以防止发件人通过图片追踪你是否读了邮件">
        <Switch on={s.loadRemoteImages} onChange={(loadRemoteImages) => updateSettings({ loadRemoteImages })} />
      </Row>
      <h4>同步与通知</h4>
      <Row title={isNative ? '新邮件通知' : '新邮件桌面通知'}>
        <Switch
          on={s.notifications}
          onChange={(notifications) => {
            void updateSettings({ notifications })
            if (notifications && isNative) void requestNotificationPermission()
          }}
        />
      </Row>
      {isNative && <AndroidBackground s={s} />}
      <Row title="定时检查其他文件夹" hint="收件箱是实时推送的，这里控制已发送、垃圾邮件等文件夹的检查间隔">
        <select className="select" style={{ width: 120 }} value={s.syncIntervalMin} onChange={(e) => updateSettings({ syncIntervalMin: Number(e.target.value) })}>
          {[1, 2, 5, 10, 15, 30, 60].map((n) => (
            <option key={n} value={n}>
              每 {n} 分钟
            </option>
          ))}
        </select>
      </Row>
      {!isNative && <h4>窗口</h4>}
      {!isNative && (
        <>
          <Row title="关闭窗口时最小化到托盘" hint="保持后台运行，才能及时收到新邮件通知">
            <Switch on={s.closeToTray} onChange={(closeToTray) => updateSettings({ closeToTray })} />
          </Row>
          <Row title="开机自动启动">
            <Switch on={s.launchAtLogin} onChange={(launchAtLogin) => updateSettings({ launchAtLogin })} />
          </Row>
        </>
      )}
    </>
  )
}

/** 安卓：后台收信 + 电池优化 */
function AndroidBackground({ s }: { s: Settings }) {
  const [unrestricted, setUnrestricted] = useState<boolean | null>(null)
  useEffect(() => {
    const check = () => void backgroundUnrestricted().then(setUnrestricted)
    check()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  const on = s.backgroundSync !== false
  return (
    <>
      <Row title="退到后台后继续收信" hint="关掉 App 也能马上收到新邮件通知。通知栏会常驻一条“正在接收邮件”（可以在系统通知设置里把它折叠）">
        <Switch on={on} onChange={(backgroundSync) => updateSettings({ backgroundSync })} />
      </Row>
      {on && (
        <Row
          title="允许在后台运行"
          hint={
            unrestricted
              ? '已允许，系统不会为了省电把 Moyer Mail 停掉'
              : '一加/OPPO 等手机会为了省电停掉后台应用。点右边按钮，在系统弹窗里选“允许”；如果还是收不到，请在系统设置 → 应用 → Moyer Mail 里打开“允许自启动”和“允许后台运行”'
          }
        >
          {unrestricted ? <span className="chip">已允许</span> : <button className="btn soft sm" onClick={openBatterySettings}>去设置</button>}
        </Row>
      )}
    </>
  )
}

function Translate({ s }: { s: Settings }) {
  const t = s.translate
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const setT = (patch: Partial<Settings['translate']>) => updateSettings({ translate: { ...t, ...patch } })

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await api.translate({ texts: [`Hello! Thanks for your email. I'll get back to you tomorrow. (${Date.now() % 1000})`], to: t.targetLang })
      setResult(r.texts[0])
    } catch (err) {
      setResult('❌ ' + errorText(err))
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <h4>翻译服务</h4>
      <div className="option-cards">
        {PROVIDERS.map((p) => (
          <button key={p.id} className={cx('option-card', t.provider === p.id && 'on')} onClick={() => setT({ provider: p.id })}>
            <b>{p.name}</b>
            <span>{p.desc}</span>
          </button>
        ))}
      </div>
      {t.provider === 'llm' && (
        <div className="field" style={{ marginTop: 12, gap: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="hint">快速填写：</span>
            {LLM_PRESETS.map((p) => (
              <button key={p.name} className="btn sm outline" onClick={() => setT({ llm: { ...t.llm, baseUrl: p.baseUrl, model: p.model } })}>
                {p.name}
              </button>
            ))}
          </div>
          <label className="hint">接口地址（Base URL）</label>
          <LazyInput value={t.llm.baseUrl} onSave={(baseUrl) => setT({ llm: { ...t.llm, baseUrl } })} mono />
          <label className="hint">模型名称</label>
          <LazyInput value={t.llm.model} onSave={(model) => setT({ llm: { ...t.llm, model } })} mono />
          <label className="hint">API Key（加密保存在本机）</label>
          <LazyInput value={t.llm.apiKey} type="password" onSave={(apiKey) => setT({ llm: { ...t.llm, apiKey } })} placeholder="sk-..." mono />
        </div>
      )}
      {t.provider === 'azure' && (
        <div className="field" style={{ marginTop: 12, gap: 10 }}>
          <div className="hint" style={{ lineHeight: 1.7 }}>
            在{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), void api.openExternal('https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation'))}>
              Azure 门户
            </a>{' '}
            创建“翻译器（Translator）”资源，定价层选 F0（免费），然后在“密钥和终结点”页面复制密钥和位置/区域。
          </div>
          <label className="hint">密钥（加密保存在本机）</label>
          <LazyInput value={t.azure.key} type="password" onSave={(key) => setT({ azure: { ...t.azure, key } })} mono />
          <label className="hint">区域（例如 eastasia，全局资源可留空）</label>
          <LazyInput value={t.azure.region} onSave={(region) => setT({ azure: { ...t.azure, region } })} placeholder="eastasia" mono />
        </div>
      )}
      {t.provider === 'deepl' && (
        <div className="field" style={{ marginTop: 12 }}>
          <label className="hint">DeepL API Key（加密保存在本机）</label>
          <LazyInput value={t.deepl.apiKey} type="password" onSave={(apiKey) => setT({ deepl: { apiKey } })} placeholder="xxxxxxxx-xxxx-...:fx" mono />
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn outline sm" onClick={test} disabled={testing}>
          {testing ? <LoaderCircle size={14} className="spin" /> : <Globe size={14} />}
          测试翻译
        </button>
        {result && <span className="muted ellipsis" style={{ fontSize: 12.5 }}>{result}</span>}
      </div>
      <h4>阅读邮件</h4>
      <Row title="翻译成">
        <select className="select" style={{ width: 140 }} value={t.targetLang} onChange={(e) => setT({ targetLang: e.target.value })}>
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </Row>
      <Row title="列表里显示外语标题的译文" hint="邮件列表里外语标题直接显示翻译，前面标有“译”字">
        <Switch on={t.listSubjects} onChange={(listSubjects) => setT({ listSubjects })} />
      </Row>
      <Row title="自动翻译外语邮件" hint="打开不是上面这种语言的邮件时，自动翻译">
        <Switch on={t.autoTranslate} onChange={(autoTranslate) => setT({ autoTranslate })} />
      </Row>
      <Row title="显示方式">
        <Segmented
          value={t.display}
          options={[
            { value: 'replace', label: '只看译文' },
            { value: 'bilingual', label: '双语对照' }
          ]}
          onChange={(display) => setT({ display })}
        />
      </Row>
      <div className="hint" style={{ marginTop: 8 }}>
        小技巧：在邮件里选中一段文字，会出现“翻译”按钮；写信时可以用中文写好，再一键翻译成对方的语言。
      </div>
    </>
  )
}

function Network({ s }: { s: Settings }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await api.testProxy()
      setResult({ ok: r.ok, text: r.ok ? '可以访问外网（Google）' : r.error ?? '失败' })
    } catch (err) {
      setResult({ ok: false, text: errorText(err) })
    } finally {
      setTesting(false)
    }
  }
  return (
    <>
      <h4>代理</h4>
      <div className="hint" style={{ marginBottom: 8 }}>
        只有在账号设置里开启了“通过代理连接”的邮箱（默认是 Gmail、Yahoo 等）才会走代理，QQ、163 等国内邮箱直连。翻译和 OAuth 登录也走这里的设置。
      </div>
      <Row title="代理模式">
        <Segmented
          value={s.proxy.mode}
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'custom', label: '自定义' },
            { value: 'off', label: '不用代理' }
          ]}
          onChange={(mode) => updateSettings({ proxy: { ...s.proxy, mode } })}
        />
      </Row>
      {s.proxy.mode === 'custom' && (
        <div className="field" style={{ padding: '10px 0' }}>
          <label>代理地址</label>
          <LazyInput value={s.proxy.url} onSave={(url) => updateSettings({ proxy: { ...s.proxy, url } })} placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890" mono />
          <div className="hint">Clash / v2rayN 等软件的本地代理端口，一般是 7890 或 10808。</div>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn outline sm" onClick={test} disabled={testing}>
          {testing ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}
          测试连接
        </button>
        {result && <span style={{ fontSize: 12.5, color: result.ok ? 'var(--ok)' : 'var(--danger)' }}>{result.text}</span>}
      </div>
    </>
  )
}

function Accounts() {
  const accounts = useStore((s) => s.accounts)
  const sync = useStore((s) => s.sync)
  const move = async (i: number, d: number) => {
    const ids = accounts.map((a) => a.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    try {
      await api.reorderAccounts(ids)
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }
  return (
    <>
      <h4>已添加的邮箱</h4>
      {accounts.length === 0 && <div className="hint">还没有添加邮箱。</div>}
      {accounts.map((a, i) => (
        <div className="acct-row" key={a.id}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: a.color, flexShrink: 0 }} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{a.label}</div>
            <div className="hint">
              {a.email}
              {sync[a.id]?.phase === 'error' && <span style={{ color: 'var(--danger)' }}> · {sync[a.id].error}</span>}
            </div>
          </div>
          <button className="btn icon sm" onClick={() => move(i, -1)} disabled={i === 0} title="上移">
            <ArrowUp size={14} />
          </button>
          <button className="btn icon sm" onClick={() => move(i, 1)} disabled={i === accounts.length - 1} title="下移">
            <ArrowDown size={14} />
          </button>
          <button className="btn sm outline" onClick={() => useStore.setState({ dialog: { kind: 'account', accountId: a.id } })}>
            <Pencil size={13} />
            编辑
          </button>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button className="btn soft" onClick={() => useStore.setState({ dialog: { kind: 'account' } })}>
          <Plus size={15} />
          添加邮箱
        </button>
      </div>
    </>
  )
}

function OAuth({ s }: { s: Settings }) {
  const o = s.oauth
  return (
    <>
      <h4>微软（Outlook / Hotmail）</h4>
      <div className="hint" style={{ lineHeight: 1.7 }}>
        微软已经关闭了 Outlook 邮箱的密码登录，第三方软件必须通过 OAuth 授权。需要你用自己的微软账号注册一个免费的“应用”，拿到应用 ID（只需做一次）：
      </div>
      <ol className="steps">
        <li>
          打开{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), void api.openExternal('https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'))}>
            Microsoft Entra 应用注册
          </a>
          ，点“新注册”。
        </li>
        <li>名称随便填（如 Moyer Mail），账户类型选“任何组织目录中的帐户和个人 Microsoft 帐户”。</li>
        <li>
          重定向 URI 平台选“公共客户端/本机（移动和桌面）”，填 <code>http://localhost</code>，点注册。
        </li>
        <li>复制概述页里的“应用程序（客户端）ID”，粘贴到下面。</li>
      </ol>
      <div className="field" style={{ marginTop: 8 }}>
        <label>微软应用 ID</label>
        <LazyInput value={o.microsoftClientId} onSave={(microsoftClientId) => updateSettings({ oauth: { ...o, microsoftClientId } })} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" mono />
      </div>
      <h4 style={{ marginTop: 22 }}>Google（可选）</h4>
      <div className="hint" style={{ lineHeight: 1.7 }}>
        Gmail 推荐直接用“应用专用密码”登录，最简单。如果你想用 OAuth，需要在 Google Cloud Console 创建“桌面应用”类型的 OAuth 客户端，并启用 Gmail API。
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>Google 客户端 ID</label>
        <LazyInput value={o.googleClientId} onSave={(googleClientId) => updateSettings({ oauth: { ...o, googleClientId } })} mono />
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>Google 客户端密钥</label>
        <LazyInput value={o.googleClientSecret} type="password" onSave={(googleClientSecret) => updateSettings({ oauth: { ...o, googleClientSecret } })} mono />
      </div>
    </>
  )
}

function About() {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => undefined)
  }, [])
  return (
    <>
      <h4>Moyer Mail</h4>
      <div className="muted">版本 {info?.version ?? '-'}{isDemo && '（演示模式）'}</div>
      <div className="hint" style={{ marginTop: 4 }}>
        数据目录：{info?.dataDir}
        <br />
        所有邮件和账号信息只保存在本机，授权码使用 Windows 系统加密保存。
      </div>
      <h4>快捷键</h4>
      <div className="kbd-list">
        <kbd>J / ↓</kbd>
        <span>下一封</span>
        <kbd>K / ↑</kbd>
        <span>上一封</span>
        <kbd>C</kbd>
        <span>写邮件</span>
        <kbd>R</kbd>
        <span>回复</span>
        <kbd>A</kbd>
        <span>全部回复</span>
        <kbd>F</kbd>
        <span>转发</span>
        <kbd>T</kbd>
        <span>翻译 / 切换原文</span>
        <kbd>S</kbd>
        <span>星标</span>
        <kbd>U</kbd>
        <span>标为已读/未读</span>
        <kbd>H</kbd>
        <span>稍后提醒</span>
        <kbd>E</kbd>
        <span>归档</span>
        <kbd>Delete</kbd>
        <span>删除</span>
        <kbd>/</kbd>
        <span>搜索</span>
        <kbd>Ctrl+Enter</kbd>
        <span>发送邮件</span>
        <kbd>Esc</kbd>
        <span>关闭弹窗 / 最小化写信窗口</span>
      </div>
    </>
  )
}

export function SettingsDialog({ tab: initial }: { tab?: SettingsTab }) {
  const settings = useStore((s) => s.settings)
  const [tab, setTab] = useState<SettingsTab>(initial ?? 'appearance')
  if (!settings) return null
  return (
    <Modal title="设置" onClose={() => useStore.setState({ dialog: null })} wide>
      <div className="settings">
        <div className="settings-nav">
          {TABS.map((t) => (
            <div key={t.id} className={cx('nav-item', tab === t.id && 'on')} onMouseDown={() => setTab(t.id)}>
              {t.icon}
              {t.label}
            </div>
          ))}
        </div>
        <div className="settings-body" key={tab}>
          {tab === 'appearance' && <Appearance s={settings} />}
          {tab === 'general' && <General s={settings} />}
          {tab === 'translate' && <Translate s={settings} />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'network' && <Network s={settings} />}
          {tab === 'accounts' && <Accounts />}
          {tab === 'oauth' && <OAuth s={settings} />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </Modal>
  )
}

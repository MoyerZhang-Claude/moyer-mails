import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Menu, Search, X } from 'lucide-react'
import { PROVIDERS } from '@shared/presets'
import { findPalette } from '@shared/theme'
import { api, isDemo, onEngineEvent } from '../api'
import {
  init,
  moveTo,
  openComposer,
  refreshList,
  reloadAccounts,
  reloadFolders,
  replyTo,
  selectMessage,
  selectRelative,
  setSearch,
  setView,
  toggleFlag,
  toggleSeen,
  toast,
  useStore
} from '../store'
import { setupGestures } from '../gestures'
import { setSystemBarsDark } from '../native'
import { debounce } from '../util'
import { AccountDialog } from './AccountDialog'
import { ConfirmDialog, ProviderLogo, Toasts } from './Common'
import { Composers } from './Composer'
import { MessageList } from './MessageList'
import { Reader } from './Reader'
import { RuleDialog } from './Rules'
import { ScheduledDialog } from './Scheduled'
import { SettingsDialog } from './SettingsDialog'
import { Sidebar } from './Sidebar'

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function useTheme() {
  const settings = useStore((s) => s.settings)
  useEffect(() => {
    if (!settings) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && mq.matches)
      const pal = findPalette(settings.palette)
      const tone = dark ? pal.dark : pal.light
      const root = document.documentElement
      root.classList.toggle('dark', dark)
      root.classList.toggle('compact', settings.density === 'compact')
      root.style.setProperty('--bg', tone.bg)
      root.style.setProperty('--accent', tone.accent)
      root.style.setProperty('--orb-a', tone.orbA)
      root.style.setProperty('--orb-b', tone.orbB)
      root.style.setProperty('--on-accent', luminance(tone.accent) > 0.5 ? '#111111' : '#ffffff')
      void api.setWindowTheme(dark, tone.bg).catch(() => undefined)
      void setSystemBarsDark(dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings?.theme, settings?.palette, settings?.density]) // eslint-disable-line react-hooks/exhaustive-deps
}

function useEngineEvents() {
  useEffect(() => {
    const refresh = debounce(() => void refreshList(), 250)
    const folders = debounce(() => void reloadFolders(), 300)
    return onEngineEvent((name, payload) => {
      switch (name) {
        case 'accounts-changed':
          void reloadAccounts()
          break
        case 'folders-changed':
          folders()
          break
        case 'messages-changed':
          refresh()
          break
        case 'sync-status': {
          const p = payload as { accountId: string }
          useStore.setState((s) => ({ sync: { ...s.sync, [p.accountId]: payload as never } }))
          break
        }
        case 'counts':
          useStore.setState({ counts: payload as never })
          break
        case 'settings-changed':
          useStore.setState({ settings: { ...(payload as object) } as never })
          break
        case 'compose':
          openComposer({ mode: 'new' })
          break
        case 'toast': {
          const t = payload as { text: string; kind: 'info' | 'ok' | 'error' }
          toast(t.text, t.kind)
          break
        }
        case 'scheduled-changed':
          useStore.setState({ scheduledCount: (payload as { count: number }).count })
          break
        case 'open-message': {
          const { id } = payload as { id: number }
          const st = useStore.getState()
          if (!st.list.some((m) => m.id === id)) setView({ kind: 'unified', box: 'inbox' })
          void selectMessage(id)
          break
        }
      }
    })
  }, [])
}

function useShortcuts(searchRef: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const t = e.target as HTMLElement
      const typing = !!t.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      if (st.dialog || st.composers.some((c) => !c.minimized)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        openComposer({ mode: 'new' })
        return
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      const map: Record<string, () => void> = {
        j: () => selectRelative(1),
        ArrowDown: () => selectRelative(1),
        k: () => selectRelative(-1),
        ArrowUp: () => selectRelative(-1),
        c: () => openComposer({ mode: 'new' }),
        r: () => replyTo('reply'),
        a: () => replyTo('replyAll'),
        f: () => replyTo('forward'),
        s: () => void toggleFlag(),
        u: () => void toggleSeen(),
        e: () => void moveTo('archive'),
        Delete: () => void moveTo('trash'),
        '#': () => void moveTo('trash'),
        t: () => window.dispatchEvent(new Event('moyer:translate')),
        h: () => st.selectedId != null && window.dispatchEvent(new Event('moyer:snooze')),
        '/': () => {
          searchRef.current?.focus()
        },
        Escape: () => {
          if (st.checked.length) useStore.setState({ checked: [] })
          else if (st.search) setSearch('')
          else if (st.sidebarOpen) useStore.setState({ sidebarOpen: false })
          else void selectMessage(null)
        }
      }
      const fn = map[k] ?? map[k.toLowerCase()]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchRef])
}

function TitleBar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }) {
  const search = useStore((s) => s.search)
  const sync = useStore((s) => s.sync)
  const accounts = useStore((s) => s.accounts)
  const [text, setText] = useState(search)
  const apply = useRef(debounce((v: string) => setSearch(v), 220)).current
  useEffect(() => setText(search), [search])
  const errors = Object.values(sync).filter((s) => s.phase === 'error')
  return (
    <header className="titlebar">
      <div className="brand">
        <button className="btn icon sm mobile-only" onClick={() => useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen }))}>
          <Menu size={17} />
        </button>
        <svg width="20" height="20" viewBox="0 0 64 64" aria-hidden>
          <defs>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--accent)" />
              <stop offset="1" stopColor="var(--orb-b)" />
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#lg)" />
          <path d="M14 22c0-2.2 1.8-4 4-4h28c2.2 0 4 1.8 4 4v20c0 2.2-1.8 4-4 4H18c-2.2 0-4-1.8-4-4z" fill="none" stroke="#fff" strokeWidth="4" strokeLinejoin="round" />
          <path d="m16 21 16 12 16-12" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Moyer Mail</span>
        {isDemo && <span className="chip">演示</span>}
      </div>
      {accounts.length > 0 && (
        <div className="search">
          <Search size={15} />
          <input
            ref={searchRef}
            value={text}
            placeholder="搜索邮件：主题、发件人、正文"
            onChange={(e) => {
              setText(e.target.value)
              apply(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setText('')
                setSearch('')
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Enter') setSearch(text)
            }}
          />
          {text ? (
            <button
              className="btn icon sm clear"
              onClick={() => {
                setText('')
                setSearch('')
              }}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </div>
      )}
      <span className="grow" />
      {errors.length > 0 && (
        <button
          className="btn sm"
          style={{ color: 'var(--danger)' }}
          title={errors.map((e) => `${accounts.find((a) => a.id === e.accountId)?.label}：${e.error}`).join('\n')}
          onClick={() => useStore.setState({ dialog: { kind: 'account', accountId: errors[0].accountId } })}
        >
          <CircleAlert size={15} />
          {errors.length} 个账号连接失败
        </button>
      )}
    </header>
  )
}

function Welcome() {
  return (
    <div className="welcome glass panel pop">
      <h1>欢迎使用 Moyer Mail</h1>
      <p>把 QQ、Gmail、Outlook、163 等所有邮箱放在一起收发，外语邮件一键翻译。先添加第一个邮箱吧：</p>
      <div className="provider-grid">
        {PROVIDERS.slice(0, 8).map((p) => (
          <div key={p.id} className="provider" onClick={() => useStore.setState({ dialog: { kind: 'account', provider: p.id } })}>
            <ProviderLogo id={p.id} />
            {p.name}
          </div>
        ))}
      </div>
      <button className="btn outline" onClick={() => useStore.setState({ dialog: { kind: 'account' } })}>
        更多邮箱…
      </button>
    </div>
  )
}

function Dialogs() {
  const dialog = useStore((s) => s.dialog)
  if (!dialog) return null
  if (dialog.kind === 'account') return <AccountDialog key={dialog.accountId ?? dialog.provider ?? 'new'} accountId={dialog.accountId} provider={dialog.provider} />
  if (dialog.kind === 'settings') return <SettingsDialog tab={dialog.tab} />
  if (dialog.kind === 'rule') return <RuleDialog rule={dialog.rule} preset={dialog.preset} />
  if (dialog.kind === 'scheduled') return <ScheduledDialog />
  return <ConfirmDialog />
}

export function App() {
  const ready = useStore((s) => s.ready)
  const hasAccounts = useStore((s) => s.accounts.length > 0)
  const orbs = useStore((s) => s.settings?.orbs ?? true)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void init()
  }, [])
  useTheme()
  useEngineEvents()
  // 切换“按会话分组”后重新加载列表
  const threading = useStore((s) => s.settings?.threading)
  const firstThreading = useRef(true)
  useEffect(() => {
    if (firstThreading.current) {
      firstThreading.current = false
      return
    }
    void refreshList(true)
  }, [threading])
  useShortcuts(searchRef)
  // 手机上右滑打开侧栏（读信时也可以）、左滑关闭
  useEffect(() => setupGestures(), [])

  return (
    <>
      <div className="backdrop">
        {orbs && (
          <>
            <div className="orb a" />
            <div className="orb b" />
            <div className="orb c" />
          </>
        )}
      </div>
      <div className="app">
        <TitleBar searchRef={searchRef} />
        {ready && (
          <main className="main" onMouseDown={(e) => sidebarOpen && !(e.target as HTMLElement).closest('.sidebar') && useStore.setState({ sidebarOpen: false })}>
            {/* 窄屏时侧栏后面的半透明遮罩，点一下关闭侧栏 */}
            <div className={sidebarOpen ? 'drawer-scrim show' : 'drawer-scrim'} />
            <Sidebar />
            {hasAccounts ? (
              <>
                <MessageList />
                <Reader />
              </>
            ) : (
              <Welcome />
            )}
          </main>
        )}
      </div>
      <Composers />
      <Dialogs />
      <Toasts />
    </>
  )
}

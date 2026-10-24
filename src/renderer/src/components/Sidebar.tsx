import { memo, useMemo, type ReactNode } from 'react'
import { AlarmClock, Archive, CalendarClock, ChevronDown, CircleAlert, FileText, Folder, Inbox, Mail, Pencil, Plus, Send, Settings, ShieldAlert, Star, Trash2 } from 'lucide-react'
import type { FolderInfo, FolderRole, UnifiedBox, ViewKey } from '@shared/types'
import { openComposer, setView, toggleCollapsed, useStore, viewEquals } from '../store'
import { cx, folderName } from '../util'

const UNIFIED: { box: UnifiedBox; label: string; icon: ReactNode }[] = [
  { box: 'inbox', label: '全部收件箱', icon: <Inbox size={17} /> },
  { box: 'unread', label: '未读', icon: <Mail size={17} /> },
  { box: 'flagged', label: '星标', icon: <Star size={17} /> },
  { box: 'snoozed', label: '稍后处理', icon: <AlarmClock size={17} /> },
  { box: 'sent', label: '已发送', icon: <Send size={17} /> },
  { box: 'drafts', label: '草稿', icon: <FileText size={17} /> },
  { box: 'junk', label: '垃圾邮件', icon: <ShieldAlert size={17} /> },
  { box: 'trash', label: '已删除', icon: <Trash2 size={17} /> }
]

export function roleIcon(role: FolderRole, size = 16) {
  switch (role) {
    case 'inbox':
      return <Inbox size={size} />
    case 'sent':
      return <Send size={size} />
    case 'drafts':
      return <FileText size={size} />
    case 'trash':
      return <Trash2 size={size} />
    case 'junk':
      return <ShieldAlert size={size} />
    case 'archive':
    case 'all':
      return <Archive size={size} />
    case 'flagged':
      return <Star size={size} />
    default:
      return <Folder size={size} />
  }
}

function NavItem({ view, label, icon, count, current, indent = 0 }: { view: ViewKey; label: string; icon: ReactNode; count?: number; current: ViewKey; indent?: number }) {
  const on = viewEquals(view, current)
  return (
    <div className={cx('nav-item', on && 'on')} style={indent ? { paddingLeft: 10 + indent * 14 } : undefined} onMouseDown={(e) => e.button === 0 && !on && setView(view)} title={label}>
      {icon}
      <span className="ellipsis">{label}</span>
      {!!count && <span className="count">{count > 999 ? '999+' : count}</span>}
    </div>
  )
}

function depthOf(f: FolderInfo, byPath: Map<string, FolderInfo>) {
  let d = 0
  let p = f.parentPath
  while (p && byPath.has(p) && d < 6) {
    d++
    p = byPath.get(p)!.parentPath
  }
  return d
}

export const Sidebar = memo(function Sidebar() {
  const accounts = useStore((s) => s.accounts)
  const folders = useStore((s) => s.folders)
  const counts = useStore((s) => s.counts)
  const view = useStore((s) => s.view)
  const sync = useStore((s) => s.sync)
  const collapsed = useStore((s) => s.collapsed)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const scheduledCount = useStore((s) => s.scheduledCount)

  const byAccount = useMemo(() => {
    const map = new Map<string, FolderInfo[]>()
    for (const f of folders) {
      if (!map.has(f.accountId)) map.set(f.accountId, [])
      map.get(f.accountId)!.push(f)
    }
    return map
  }, [folders])

  return (
    <aside className={cx('panel glass sidebar', sidebarOpen && 'open')}>
      <button className="btn primary compose-btn" onClick={() => openComposer({ mode: 'new' })} title="写邮件 (C)">
        <Pencil size={16} />
        写邮件
      </button>
      <nav className="nav">
        <div className="nav-section">
          {UNIFIED.map((u) => (
            <NavItem
              key={u.box}
              view={{ kind: 'unified', box: u.box }}
              label={u.label}
              icon={u.icon}
              current={view}
              count={
                u.box === 'inbox' || u.box === 'unread'
                  ? counts?.unified.inbox
                  : u.box === 'drafts'
                    ? counts?.unified.drafts
                    : u.box === 'junk'
                      ? counts?.unified.junk
                      : u.box === 'snoozed'
                        ? counts?.unified.snoozed
                        : undefined
              }
            />
          ))}
          {scheduledCount > 0 && (
            <div className="nav-item" onMouseDown={(e) => e.button === 0 && useStore.setState({ dialog: { kind: 'scheduled' } })} title="定时发送">
              <CalendarClock size={17} />
              <span className="ellipsis">定时发送</span>
              <span className="count">{scheduledCount}</span>
            </div>
          )}
        </div>
        {accounts.map((acc) => {
          const fs = (byAccount.get(acc.id) ?? []).filter((f) => !f.noSelect)
          const byPath = new Map(fs.map((f) => [f.path, f]))
          const status = sync[acc.id]
          const key = `acct:${acc.id}`
          const isCollapsed = collapsed[key]
          const sorted = [...fs].sort((a, b) => {
            const ra = a.role === 'other' ? 1 : 0
            const rb = b.role === 'other' ? 1 : 0
            return ra - rb || (ra ? a.path.localeCompare(b.path) : 0)
          })
          return (
            <div className="nav-section" key={acc.id}>
              <div className={cx('nav-title account-head', isCollapsed && 'collapsed')} onClick={() => toggleCollapsed(key)} title={acc.email}>
                <span className="dot" style={{ background: acc.color, width: 9, height: 9, borderRadius: '50%', flexShrink: 0 }} />
                <span className="ellipsis grow">{acc.label}</span>
                {status?.phase === 'error' && (
                  <span
                    className="err"
                    title={status.error}
                    onClick={(e) => {
                      e.stopPropagation()
                      useStore.setState({ dialog: { kind: 'account', accountId: acc.id } })
                    }}
                  >
                    <CircleAlert size={15} />
                  </span>
                )}
                {!!counts?.accounts[acc.id] && isCollapsed && <span className="count faint">{counts.accounts[acc.id]}</span>}
                <ChevronDown size={14} className="chev" />
              </div>
              {!isCollapsed &&
                (fs.length === 0 ? (
                  <div className="nav-item faint" style={{ cursor: 'default', fontSize: 12.5 }}>
                    {status?.phase === 'error' ? '连接失败，点红色图标查看' : '正在连接…'}
                  </div>
                ) : (
                  sorted.map((f) => (
                    <NavItem
                      key={f.path}
                      view={{ kind: 'folder', accountId: acc.id, path: f.path }}
                      label={folderName(f)}
                      icon={roleIcon(f.role)}
                      current={view}
                      indent={f.role === 'other' ? depthOf(f, byPath) : 0}
                      count={f.role === 'sent' || f.role === 'trash' || f.role === 'drafts' ? 0 : counts?.folders[`${acc.id}\n${f.path}`]}
                    />
                  ))
                ))}
            </div>
          )
        })}
      </nav>
      <div className="sidebar-foot">
        <button className="btn sm" onClick={() => useStore.setState({ dialog: { kind: 'account' } })}>
          <Plus size={16} />
          添加邮箱
        </button>
        <button className="btn icon sm" title="设置" onClick={() => useStore.setState({ dialog: { kind: 'settings' } })} style={{ flex: '0 0 auto' }}>
          <Settings size={16} />
        </button>
      </div>
    </aside>
  )
})

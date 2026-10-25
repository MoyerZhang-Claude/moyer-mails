import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlarmClock,
  Archive,
  CheckCheck,
  Inbox,
  LoaderCircle,
  Mail,
  MailOpen,
  Menu,
  Paperclip,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  Star,
  Trash2,
  Wand,
  X
} from 'lucide-react'
import { detectLang, normalizeLang } from '@shared/langs'
import type { MessageSummary, ViewKey } from '@shared/types'
import { api } from '../api'
import {
  expandIds,
  formatWhen,
  loadMore,
  markAllReadInView,
  moveTo,
  searchOnServer,
  selectMessage,
  setUnreadOnly,
  snoozeTo,
  toast,
  toggleChecked,
  toggleFlag,
  toggleSeen,
  useStore
} from '../store'
import { cx, displayName, folderName, shortTime } from '../util'
import { Avatar, ContextMenu, Segmented, type MenuItem } from './Common'
import { snoozePresets, TimeMenu } from './TimeMenu'

const UNIFIED_TITLES: Record<string, string> = {
  inbox: '全部收件箱',
  unread: '未读邮件',
  flagged: '星标邮件',
  snoozed: '稍后处理',
  sent: '已发送',
  drafts: '草稿',
  junk: '垃圾邮件',
  trash: '已删除',
  all: '所有邮件'
}

export function useViewTitle(view: ViewKey): string {
  const accounts = useStore((s) => s.accounts)
  const folders = useStore((s) => s.folders)
  if (view.kind === 'unified') return UNIFIED_TITLES[view.box]
  const acc = accounts.find((a) => a.id === view.accountId)
  if (view.kind === 'account') return acc?.label ?? '收件箱'
  const f = folders.find((x) => x.accountId === view.accountId && x.path === view.path)
  return f ? folderName(f) : view.path
}

// ---------- 列表里的外语标题翻译 ----------
const subjectTr = new Map<string, string>()

/** 去掉 Re: / Fwd: 前缀（会话数已经说明是往来邮件，译文里不用再显示“回复：回复：”） */
function stripReply(subject: string) {
  return subject.replace(/^\s*((re|fwd?|fw|aw|wg|sv|回复|答复|转发)\s*[:：]\s*)+/i, '').trim()
}

function needsTranslation(subject: string, target: string): boolean {
  const plain = stripReply(subject).replace(/\[[^\]]*\]/g, ' ')
  if ((plain.match(/\p{L}/gu) ?? []).length < 4) return false
  const lang = normalizeLang(detectLang(plain))
  if (!lang) return false
  if (target.startsWith('zh') && lang.startsWith('zh')) return false
  return lang !== target
}

function useSubjectTranslations(rows: MessageSummary[], enabled: boolean, target: string) {
  const [, bump] = useState(0)
  const key = rows.map((m) => m.id).join(',')
  useEffect(() => {
    if (!enabled) return
    const need = [...new Set(rows.map((m) => m.subject))].filter((s) => s && !subjectTr.has(`${target}\n${s}`) && needsTranslation(s, target)).slice(0, 60)
    if (!need.length) return
    const t = setTimeout(async () => {
      for (const s of need) subjectTr.set(`${target}\n${s}`, '')
      try {
        const r = await api.translate({ texts: need.map(stripReply), to: target })
        need.forEach((s, i) => {
          const tr = (r.texts[i] ?? '').trim()
          subjectTr.set(`${target}\n${s}`, tr && tr.toLowerCase() !== stripReply(s).toLowerCase() ? tr : '')
        })
        bump((x) => x + 1)
      } catch {
        /* 翻译失败就显示原文 */
      }
    }, 200)
    return () => clearTimeout(t)
  }, [key, enabled, target]) // eslint-disable-line react-hooks/exhaustive-deps
  return (subject: string) => (enabled ? subjectTr.get(`${target}\n${subject}`) || '' : '')
}

const Row = memo(function Row({
  m,
  on,
  checked,
  color,
  showAccount,
  start,
  tr,
  snoozedView,
  onMenu
}: {
  m: MessageSummary
  on: boolean
  checked: boolean
  color?: string
  showAccount: boolean
  start: number
  tr: string
  snoozedView: boolean
  onMenu: (e: React.MouseEvent, m: MessageSummary) => void
}) {
  const showTo = m.role === 'sent' || m.role === 'drafts'
  const who = showTo ? (m.to[0] ? `发给 ${displayName(m.to[0])}${m.to.length > 1 ? ` 等 ${m.to.length} 人` : ''}` : '（无收件人）') : displayName(m.from)
  return (
    <div
      className={cx('msg-row', on && 'on', checked && 'checked', !m.seen && 'unread')}
      style={{ transform: `translateY(${start}px)` }}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        if (e.ctrlKey || e.metaKey) toggleChecked(m.id, false)
        else if (e.shiftKey) toggleChecked(m.id, true)
        else if (!on || useStore.getState().checked.length) void selectMessage(m.id)
      }}
      onContextMenu={(e) => onMenu(e, m)}
    >
      {showAccount && color && <span className="acct-bar" style={{ background: color }} />}
      <Avatar addr={showTo ? m.to[0] ?? null : m.from} unread={!m.seen} />
      <div className="msg-body">
        <div className="msg-line">
          <span className="msg-from ellipsis">
            {who}
            {(m.threadCount ?? 1) > 1 && <span className="thread-count">{m.threadCount}</span>}
          </span>
          <span className="msg-icons">
            {m.hasAttachments && <Paperclip size={13} />}
            {m.flagged && <Star size={13} className="star" fill="currentColor" />}
          </span>
          {snoozedView && m.snoozeUntil ? (
            <span className="msg-time snooze-time">
              <AlarmClock size={12} />
              {formatWhen(m.snoozeUntil)}
            </span>
          ) : (
            <span className="msg-time">{shortTime(m.date)}</span>
          )}
        </div>
        <div className="msg-line">
          {tr ? (
            <span className="msg-subject ellipsis" title={m.subject}>
              <span className="tr-mark">译</span>
              {tr}
            </span>
          ) : (
            <span className="msg-subject ellipsis">{m.subject || '（无主题）'}</span>
          )}
        </div>
        <div className="msg-snippet ellipsis">{m.snippet || ' '}</div>
      </div>
    </div>
  )
})

export const MessageList = memo(function MessageList() {
  const list = useStore((s) => s.list)
  const total = useStore((s) => s.total)
  const view = useStore((s) => s.view)
  const selectedId = useStore((s) => s.selectedId)
  const checked = useStore((s) => s.checked)
  const loading = useStore((s) => s.listLoading)
  const search = useStore((s) => s.search)
  const unreadOnly = useStore((s) => s.unreadOnly)
  const accounts = useStore((s) => s.accounts)
  const counts = useStore((s) => s.counts)
  const sync = useStore((s) => s.sync)
  const exhausted = useStore((s) => s.olderExhausted)
  const compact = useStore((s) => s.settings?.density === 'compact')
  const trEnabled = useStore((s) => !!s.settings?.translate.listSubjects)
  const trTarget = useStore((s) => s.settings?.translate.targetLang ?? 'zh')
  const title = useViewTitle(view)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; m: MessageSummary } | null>(null)
  const [snoozeMenu, setSnoozeMenu] = useState<{ x: number; y: number; ids: number[] } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [serverSearching, setServerSearching] = useState(false)
  const snoozedView = view.kind === 'unified' && view.box === 'snoozed'

  const rowH = compact ? 56 : 80
  const virt = useVirtualizer({
    count: list.length + 1,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 10
  })

  useEffect(() => {
    virt.measure()
  }, [rowH, virt])

  // 换视图时回到顶部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [view, search, unreadOnly])

  // 键盘切换时让选中行保持可见
  useEffect(() => {
    if (selectedId == null) return
    const idx = list.findIndex((m) => m.id === selectedId)
    if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' })
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = virt.getVirtualItems()
  const last = items[items.length - 1]
  useEffect(() => {
    if (last && last.index >= list.length - 8 && list.length > 0 && !loading) void loadMore()
  }, [last?.index, list.length, loading])

  const visibleRows = items.filter((it) => it.index < list.length).map((it) => list[it.index])
  const trOf = useSubjectTranslations(visibleRows, trEnabled, trTarget)

  const colors = new Map(accounts.map((a) => [a.id, a.color]))
  const showAccount = view.kind === 'unified' && accounts.length > 1
  const syncing = Object.values(sync).some((s) => s.phase === 'syncing' || s.phase === 'connecting')

  const onMenu = useCallback((e: React.MouseEvent, m: MessageSummary) => {
    e.preventDefault()
    const st = useStore.getState()
    if (!st.checked.includes(m.id) && st.selectedId !== m.id) void selectMessage(m.id)
    setMenu({ x: e.clientX, y: e.clientY, m })
  }, [])

  const menuItems = (m: MessageSummary, x: number, y: number): (MenuItem | 'sep')[] => {
    const st = useStore.getState()
    const ids = expandIds(st.checked.length ? st.checked : [m.id])
    const items: (MenuItem | 'sep')[] = [
      { label: m.seen ? '标为未读' : '标为已读', icon: m.seen ? <Mail size={15} /> : <MailOpen size={15} />, onClick: () => void toggleSeen(ids) },
      { label: m.flagged ? '取消星标' : '加星标', icon: <Star size={15} />, onClick: () => void toggleFlag(ids) },
      snoozedView
        ? { label: '取消稍后提醒', icon: <AlarmClock size={15} />, onClick: () => void snoozeTo(null, ids) }
        : { label: '稍后提醒…', icon: <AlarmClock size={15} />, onClick: () => setSnoozeMenu({ x, y, ids }) },
      'sep',
      { label: '归档', icon: <Archive size={15} />, onClick: () => void moveTo('archive', ids) },
      m.role === 'junk'
        ? { label: '不是垃圾邮件', icon: <Inbox size={15} />, onClick: () => void moveTo('inbox', ids) }
        : { label: '标为垃圾邮件', icon: <ShieldAlert size={15} />, onClick: () => void moveTo('junk', ids) },
      { label: m.role === 'trash' ? '彻底删除' : '删除', icon: <Trash2 size={15} />, danger: true, onClick: () => void moveTo('trash', ids) }
    ]
    if (m.from?.address && m.role !== 'sent') {
      items.push('sep', {
        label: '自动处理此发件人的邮件…',
        icon: <Wand size={15} />,
        onClick: () =>
          useStore.setState({
            dialog: {
              kind: 'rule',
              preset: {
                name: `来自 ${displayName(m.from)}`,
                accountId: m.accountId,
                conditions: [{ field: 'from', op: 'contains', value: m.from!.address }]
              }
            }
          })
      })
    }
    return items
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.syncNow(view.kind === 'unified' ? undefined : view.accountId)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const serverSearch = async () => {
    setServerSearching(true)
    await searchOnServer()
    setServerSearching(false)
  }

  const unreadCount =
    view.kind === 'unified'
      ? view.box === 'inbox' || view.box === 'unread'
        ? counts?.unified.inbox
        : undefined
      : view.kind === 'folder'
        ? counts?.folders[`${view.accountId}\n${view.path}`]
        : undefined

  const serverSearchBtn = (
    <button className="btn soft sm" onClick={serverSearch} disabled={serverSearching}>
      {serverSearching ? <LoaderCircle size={14} className="spin" /> : <Server size={14} />}
      在服务器上搜索更早的邮件
    </button>
  )

  return (
    <section className="panel glass list-panel">
      <div className="list-head">
        <button className="btn icon mobile-only" onClick={() => useStore.setState({ sidebarOpen: !useStore.getState().sidebarOpen })}>
          <Menu size={18} />
        </button>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{search ? `搜索“${search}”` : title}</h2>
          <div className="sub">{search ? `找到 ${total} 封` : snoozedView ? `${total} 封，到点会提醒你` : unreadCount ? `${unreadCount} 封未读` : `${total} 封邮件`}</div>
        </div>
        {!search && !snoozedView && (
          <Segmented
            value={unreadOnly ? 'unread' : 'all'}
            options={[
              { value: 'all', label: '全部' },
              { value: 'unread', label: '未读' }
            ]}
            onChange={(v) => setUnreadOnly(v === 'unread')}
          />
        )}
        {!search && !!unreadCount && (
          <button className="btn icon" title="全部标为已读" onClick={() => void markAllReadInView()}>
            <CheckCheck size={16} />
          </button>
        )}
        <button className="btn icon" title="立即同步" onClick={refresh}>
          <RefreshCw size={16} className={refreshing || syncing ? 'spin' : ''} />
        </button>
      </div>
      {checked.length > 0 && (
        <div className="bulk-bar pop">
          <span style={{ fontWeight: 600, fontSize: 12.5, marginRight: 'auto', paddingLeft: 4 }}>已选 {checked.length} 项</span>
          <button className="btn icon sm" title="标为已读/未读" onClick={() => void toggleSeen()}>
            <MailOpen size={15} />
          </button>
          <button className="btn icon sm" title="星标" onClick={() => void toggleFlag()}>
            <Star size={15} />
          </button>
          <button
            className="btn icon sm"
            title="稍后提醒"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setSnoozeMenu({ x: r.left, y: r.bottom + 4, ids: expandIds(useStore.getState().checked) })
            }}
          >
            <AlarmClock size={15} />
          </button>
          <button className="btn icon sm" title="归档" onClick={() => void moveTo('archive')}>
            <Archive size={15} />
          </button>
          <button className="btn icon sm danger" title="删除" onClick={() => void moveTo('trash')}>
            <Trash2 size={15} />
          </button>
          <button className="btn icon sm" title="取消选择" onClick={() => useStore.setState({ checked: [] })}>
            <X size={15} />
          </button>
        </div>
      )}
      {list.length === 0 ? (
        <div className="empty">
          {loading ? (
            <LoaderCircle size={28} className="spin" />
          ) : search ? (
            <>
              <Search size={40} />
              <h3>本地没有找到相关邮件</h3>
              <div>本地只保存了最近的邮件，更早的可以到服务器上找。</div>
              {serverSearchBtn}
            </>
          ) : snoozedView ? (
            <>
              <AlarmClock size={44} />
              <h3>没有稍后处理的邮件</h3>
              <div>在邮件上点“稍后提醒”，它会先从收件箱消失，到时间再回来提醒你。</div>
            </>
          ) : (
            <>
              <Inbox size={44} />
              <h3>{unreadOnly ? '没有未读邮件' : syncing ? '正在同步…' : '这里空空如也'}</h3>
            </>
          )}
        </div>
      ) : (
        <div className="list-scroll" ref={scrollRef}>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {items.map((it) =>
              it.index < list.length ? (
                <Row
                  key={list[it.index].id}
                  m={list[it.index]}
                  on={list[it.index].id === selectedId}
                  checked={checked.includes(list[it.index].id)}
                  color={colors.get(list[it.index].accountId)}
                  showAccount={showAccount}
                  start={it.start}
                  tr={trOf(list[it.index].subject)}
                  snoozedView={snoozedView}
                  onMenu={onMenu}
                />
              ) : (
                <div key="foot" className="list-foot" style={{ position: 'absolute', left: 0, right: 0, transform: `translateY(${it.start}px)` }}>
                  {search ? serverSearchBtn : list.length < total || (!exhausted && !snoozedView) ? '正在加载更多…' : `共 ${total} 项`}
                </div>
              )
            )}
          </div>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.m, menu.x, menu.y)} onClose={() => setMenu(null)} />}
      {snoozeMenu && (
        <TimeMenu
          title="稍后提醒"
          presets={snoozePresets()}
          style={{ position: 'fixed', left: Math.min(snoozeMenu.x, window.innerWidth - 260), top: Math.min(snoozeMenu.y, window.innerHeight - 330) }}
          onPick={(ts) => void snoozeTo(ts, snoozeMenu.ids)}
          onClose={() => setSnoozeMenu(null)}
        />
      )}
    </section>
  )
})

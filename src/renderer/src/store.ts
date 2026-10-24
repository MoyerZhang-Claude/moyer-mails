import { create } from 'zustand'
import DOMPurify from 'dompurify'
import type {
  AccountConfig,
  Address,
  Counts,
  FolderInfo,
  MessageDetail,
  MessageSummary,
  OutgoingAttachment,
  Rule,
  Settings,
  SyncStatus,
  ViewKey
} from '@shared/types'
import { api } from './api'
import { displayName, escapeHtml, formatAddress, fullTime, textToHtml } from './util'

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward'

export interface ComposerInit {
  mode: ComposeMode
  accountId?: string
  to?: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject?: string
  bodyHtml?: string
  quoteHtml?: string
  attachments?: OutgoingAttachment[]
  inReplyTo?: string | null
  references?: string | null
  replyToLocalId?: number | null
  replyLang?: string | null
}

export interface ComposerState {
  id: string
  mode: ComposeMode
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  bodyHtml: string
  quoteHtml: string
  includeQuote: boolean
  attachments: OutgoingAttachment[]
  inReplyTo: string | null
  references: string | null
  replyToLocalId: number | null
  replyLang: string | null
  minimized: boolean
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'ok' | 'error'
}

export type SettingsTab = 'appearance' | 'general' | 'translate' | 'network' | 'accounts' | 'oauth' | 'about'

export type Dialog =
  | null
  | { kind: 'account'; accountId?: string; provider?: string }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'confirm'; text: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'scheduled' }
  | { kind: 'rule'; rule?: Rule; preset?: Partial<Rule> }

interface State {
  ready: boolean
  accounts: AccountConfig[]
  folders: FolderInfo[]
  settings: Settings | null
  counts: Counts | null
  sync: Record<string, SyncStatus>
  view: ViewKey
  search: string
  unreadOnly: boolean
  list: MessageSummary[]
  total: number
  listLoading: boolean
  olderExhausted: boolean
  selectedId: number | null
  checked: number[]
  detail: MessageDetail | null
  detailLoading: boolean
  detailError: string | null
  composers: ComposerState[]
  dialog: Dialog
  toasts: Toast[]
  sidebarOpen: boolean
  collapsed: Record<string, boolean>
  scheduledCount: number
}

const PAGE = 150
const detailCache = new Map<number, MessageDetail>()

function cacheDetail(d: MessageDetail) {
  detailCache.set(d.id, d)
  if (detailCache.size > 80) detailCache.delete(detailCache.keys().next().value as number)
}

export function viewEquals(a: ViewKey, b: ViewKey) {
  return JSON.stringify(a) === JSON.stringify(b)
}

let toastId = 1
let listSeq = 0

export const useStore = create<State>(() => ({
  ready: false,
  accounts: [],
  folders: [],
  settings: null,
  counts: null,
  sync: {},
  view: { kind: 'unified', box: 'inbox' },
  search: '',
  unreadOnly: false,
  list: [],
  total: 0,
  listLoading: false,
  olderExhausted: false,
  selectedId: null,
  checked: [],
  detail: null,
  detailLoading: false,
  detailError: null,
  composers: [],
  dialog: null,
  toasts: [],
  sidebarOpen: false,
  scheduledCount: 0,
  collapsed: JSON.parse(localStorage.getItem('moyer.collapsed') || '{}')
}))

const set = useStore.setState
const get = useStore.getState

// ======================= 提示 =======================
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = toastId++
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 2600)
}

export function errorText(err: unknown): string {
  return (err as Error)?.message || String(err)
}

export function confirmDialog(text: string, ok = '确定', danger = false): Promise<boolean> {
  return new Promise((resolve) => set({ dialog: { kind: 'confirm', text, ok, danger, resolve } }))
}

// ======================= 初始化 =======================
export async function init() {
  const [settings, accounts, folders, counts, sync] = await Promise.all([
    api.getSettings(),
    api.listAccounts(),
    api.listFolders(),
    api.getCounts(),
    api.getSyncStatus()
  ])
  set({ settings, accounts, folders, counts, sync: Object.fromEntries(sync.map((s) => [s.accountId, s])), ready: true })
  await refreshList()
  void refreshScheduledCount()
  const drafts = loadDrafts()
  if (drafts.length) set({ composers: drafts.map((d) => ({ ...d, minimized: true })) })
}

export async function reloadAccounts() {
  const [accounts, folders, counts] = await Promise.all([api.listAccounts(), api.listFolders(), api.getCounts()])
  set({ accounts, folders, counts })
}

export async function reloadFolders() {
  set({ folders: await api.listFolders() })
}

// ======================= 列表 =======================
export async function refreshList(reset = false) {
  const s = get()
  const seq = ++listSeq
  if (reset) set({ listLoading: true })
  const limit = reset ? PAGE : Math.max(PAGE, s.list.length)
  try {
    const res = await api.listMessages({ view: s.view, search: s.search, unreadOnly: s.unreadOnly, threads: !!s.settings?.threading, offset: 0, limit })
    if (seq !== listSeq) return
    set({ list: res.items, total: res.total, listLoading: false })
  } catch (err) {
    if (seq === listSeq) set({ listLoading: false })
    toast(errorText(err), 'error')
  }
}

let loadingMore = false
export async function loadMore() {
  const s = get()
  if (loadingMore) return
  loadingMore = true
  try {
    if (s.list.length < s.total) {
      const res = await api.listMessages({ view: s.view, search: s.search, unreadOnly: s.unreadOnly, threads: !!s.settings?.threading, offset: s.list.length, limit: PAGE })
      const ids = new Set(get().list.map((m) => m.id))
      set({ list: [...get().list, ...res.items.filter((m) => !ids.has(m.id))], total: res.total })
    } else if (!s.olderExhausted && !s.search) {
      const n = await api.loadOlder(s.view)
      if (n === 0) set({ olderExhausted: true })
      else await refreshList()
    }
  } catch (err) {
    toast(errorText(err), 'error')
  } finally {
    loadingMore = false
  }
}

export function setView(view: ViewKey) {
  set({ view, selectedId: null, detail: null, checked: [], olderExhausted: false, sidebarOpen: false })
  if (view.kind === 'folder') void api.openFolder(view.accountId, view.path)
  void refreshList(true)
}

export const setSearch = (search: string) => {
  set({ search, olderExhausted: false })
  void refreshList(true)
}

export function setUnreadOnly(unreadOnly: boolean) {
  set({ unreadOnly })
  void refreshList(true)
}

// ======================= 阅读 =======================
let detailSeq = 0
export async function selectMessage(id: number | null, opts: { keepChecked?: boolean } = {}) {
  const seq = ++detailSeq
  if (id == null) {
    set({ selectedId: null, detail: null, detailError: null })
    return
  }
  const cached = detailCache.get(id)
  set({ selectedId: id, detail: cached ?? null, detailLoading: !cached, detailError: null, ...(opts.keepChecked ? {} : { checked: [] }) })
  const summary = get().list.find((m) => m.id === id)
  if (summary && !summary.seen && get().settings?.markReadOnOpen) void setSeen(summary.threadIds ?? [id], true, true)
  try {
    const d = await api.getMessage(id)
    cacheDetail(d)
    if (seq === detailSeq) set({ detail: { ...d, seen: true }, detailLoading: false })
  } catch (err) {
    if (seq === detailSeq) set({ detailLoading: false, detailError: errorText(err) })
  }
}

export function selectRelative(delta: number) {
  const { list, selectedId } = get()
  if (!list.length) return
  const idx = selectedId == null ? -1 : list.findIndex((m) => m.id === selectedId)
  const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))]
  if (next && next.id !== selectedId) void selectMessage(next.id)
}

/** 会话模式下，一行代表一个会话：把行编号展开成会话里的全部邮件 */
export function expandIds(ids: number[]): number[] {
  const list = get().list
  const out = new Set<number>()
  for (const id of ids) {
    out.add(id)
    const row = list.find((m) => m.id === id)
    for (const t of row?.threadIds ?? []) out.add(t)
  }
  return [...out]
}

/** 当前操作对象：勾选的多封，或当前打开的一封（会话模式下包含整个会话） */
export function targetIds(): number[] {
  const { checked, selectedId } = get()
  if (checked.length) return expandIds(checked)
  return selectedId != null ? expandIds([selectedId]) : []
}

export function toggleChecked(id: number, range: boolean) {
  const { checked, list, selectedId } = get()
  if (range) {
    const anchor = checked[checked.length - 1] ?? selectedId
    const a = list.findIndex((m) => m.id === anchor)
    const b = list.findIndex((m) => m.id === id)
    if (a >= 0 && b >= 0) {
      const ids = list.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.id)
      set({ checked: [...new Set([...checked, ...ids])] })
      return
    }
  }
  const base = checked.length === 0 && selectedId != null && selectedId !== id ? [selectedId] : checked
  set({ checked: base.includes(id) ? base.filter((x) => x !== id) : [...base, id] })
}

// ======================= 操作（先改界面，后同步） =======================
function patchList(ids: number[], patch: Partial<MessageSummary>) {
  const idSet = new Set(ids)
  const hit = (m: MessageSummary) => idSet.has(m.id) || !!m.threadIds?.some((t) => idSet.has(t))
  set((s) => ({
    list: s.list.map((m) => (hit(m) ? { ...m, ...patch } : m)),
    detail: s.detail && idSet.has(s.detail.id) ? { ...s.detail, ...patch } : s.detail
  }))
  for (const id of ids) {
    const d = detailCache.get(id)
    if (d) detailCache.set(id, { ...d, ...patch })
  }
}

export async function setSeen(ids: number[], seen: boolean, silent = false) {
  if (!ids.length) return
  const before = get().list.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, seen: m.seen }))
  patchList(ids, { seen })
  try {
    await api.setFlags(ids, { seen })
  } catch (err) {
    for (const b of before) patchList([b.id], { seen: b.seen })
    if (!silent) toast(errorText(err), 'error')
  }
}

export async function toggleFlag(ids = targetIds()) {
  if (!ids.length) return
  const items = get().list.filter((m) => ids.includes(m.id) || m.threadIds?.some((t) => ids.includes(t)))
  const flagged = !(items.length ? items.every((m) => m.flagged) : get().detail?.flagged)
  patchList(ids, { flagged })
  try {
    await api.setFlags(ids, { flagged })
  } catch (err) {
    patchList(ids, { flagged: !flagged })
    toast(errorText(err), 'error')
  }
}

export async function toggleSeen(ids = targetIds()) {
  if (!ids.length) return
  const items = get().list.filter((m) => ids.includes(m.id) || m.threadIds?.some((t) => ids.includes(t)))
  const seen = !items.every((m) => m.seen)
  await setSeen(ids, seen)
}

export async function moveTo(target: 'trash' | 'archive' | 'junk' | 'inbox' | { path: string }, ids = targetIds()) {
  if (!ids.length) return
  const s = get()
  const inTrash = s.list.filter((m) => ids.includes(m.id)).every((m) => m.role === 'trash')
  if (target === 'trash' && inTrash) {
    const ok = await confirmDialog(`彻底删除这 ${ids.length} 封邮件？删除后无法恢复。`, '彻底删除', true)
    if (!ok) return
  }
  // 选中下一封
  const idx = s.list.findIndex((m) => m.id === s.selectedId)
  const remaining = s.list.filter((m) => !ids.includes(m.id))
  const nextSel = s.selectedId != null && ids.includes(s.selectedId) ? remaining[Math.min(idx, remaining.length - 1)]?.id ?? null : s.selectedId
  set({ list: remaining, total: Math.max(0, s.total - ids.length), checked: [] })
  for (const id of ids) detailCache.delete(id)
  if (nextSel !== s.selectedId) void selectMessage(nextSel)
  const label = target === 'trash' ? (inTrash ? '已彻底删除' : '已删除') : target === 'archive' ? '已归档' : target === 'junk' ? '已移到垃圾邮件' : '已移动'
  try {
    await api.moveMessages(ids, target)
    toast(label, 'ok')
  } catch (err) {
    toast(errorText(err), 'error')
    void refreshList()
  }
}

// ======================= 写信 =======================
const DRAFT_KEY = 'moyer.drafts'

function loadDrafts(): ComposerState[] {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveDrafts() {
  const list = get().composers.filter((c) => c.bodyHtml.replace(/<[^>]+>|&nbsp;|\s/g, '') || c.subject || c.to.length)
  localStorage.setItem(DRAFT_KEY, JSON.stringify(list))
}

export function openComposer(init: ComposerInit) {
  const s = get()
  const accounts = s.accounts.filter((a) => a.enabled)
  if (!accounts.length) {
    toast('请先添加一个邮箱账号', 'info')
    set({ dialog: { kind: 'account' } })
    return
  }
  let accountId = init.accountId && accounts.some((a) => a.id === init.accountId) ? init.accountId : undefined
  if (!accountId) {
    const v = s.view
    accountId = v.kind !== 'unified' ? v.accountId : accounts[0].id
  }
  const acc = accounts.find((a) => a.id === accountId) ?? accounts[0]
  const sig = acc.signature ? `<p><br></p><div class="moyer-signature">--<br>${acc.signature}</div>` : ''
  const c: ComposerState = {
    id: Math.random().toString(36).slice(2),
    mode: init.mode,
    accountId: acc.id,
    to: init.to ?? [],
    cc: init.cc ?? [],
    bcc: init.bcc ?? [],
    subject: init.subject ?? '',
    bodyHtml: init.bodyHtml ?? `<p><br></p>${sig}`,
    quoteHtml: init.quoteHtml ?? '',
    includeQuote: true,
    attachments: init.attachments ?? [],
    inReplyTo: init.inReplyTo ?? null,
    references: init.references ?? null,
    replyToLocalId: init.replyToLocalId ?? null,
    replyLang: init.replyLang ?? null,
    minimized: false
  }
  set((st) => ({ composers: [...st.composers.map((x) => ({ ...x, minimized: true })), c] }))
}

export function updateComposer(id: string, patch: Partial<ComposerState>) {
  set((s) => ({ composers: s.composers.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
}

export function closeComposer(id: string) {
  set((s) => ({ composers: s.composers.filter((c) => c.id !== id) }))
  saveDrafts()
}

function quoteBody(d: MessageDetail): string {
  if (d.html) {
    return DOMPurify.sanitize(d.html, { FORBID_TAGS: ['style', 'script', 'title', 'meta', 'link', 'base', 'form', 'input', 'button'] })
  }
  return textToHtml(d.text ?? '')
}

export function replyTo(mode: ComposeMode, d: MessageDetail | null = get().detail) {
  if (!d) return
  const accounts = get().accounts
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()))
  const notMine = (a: Address) => !mine.has(a.address.toLowerCase())
  const subjectBase = d.subject || ''
  if (mode === 'forward') {
    const header = [
      '---------- 转发的邮件 ----------',
      `发件人：${d.from ? formatAddress(d.from) : ''}`,
      `日期：${fullTime(d.date)}`,
      `主题：${subjectBase}`,
      `收件人：${d.to.map(formatAddress).join(', ')}`
    ]
      .map(escapeHtml)
      .join('<br>')
    openComposer({
      mode,
      accountId: d.accountId,
      subject: /^(fwd?|转发)[:：]/i.test(subjectBase) ? subjectBase : `Fwd: ${subjectBase}`,
      quoteHtml: `<div style="margin-top:16px;color:#555">${header}</div><div style="margin-top:8px">${quoteBody(d)}</div>`,
      attachments: d.attachments.map((a) => ({ filename: a.filename, size: a.size, fromMessage: { id: d.id, index: a.index } })),
      replyLang: d.lang
    })
    return
  }
  let to: Address[]
  let cc: Address[] = []
  if (d.role === 'sent') to = d.to
  else to = d.replyTo.length ? d.replyTo : d.from ? [d.from] : []
  if (mode === 'replyAll') {
    const seen = new Set(to.map((a) => a.address.toLowerCase()))
    cc = [...d.to, ...d.cc].filter((a) => notMine(a) && !seen.has(a.address.toLowerCase()) && (seen.add(a.address.toLowerCase()), true))
  }
  const header = `在 ${fullTime(d.date)}，${displayName(d.from)}${d.from?.address ? ` &lt;${escapeHtml(d.from.address)}&gt;` : ''} 写道：`
  openComposer({
    mode,
    accountId: d.accountId,
    to,
    cc,
    subject: /^(re|回复|答复)[:：]/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`,
    quoteHtml: `<div style="margin-top:16px;color:#555">${header}</div><blockquote style="margin:6px 0 0 0;padding-left:12px;border-left:3px solid #d0d7de;color:#444">${quoteBody(d)}</blockquote>`,
    inReplyTo: d.messageId,
    references: [d.references, d.messageId].filter(Boolean).join(' ') || null,
    replyToLocalId: d.id,
    replyLang: d.lang
  })
}

export function toggleCollapsed(key: string) {
  const collapsed = { ...get().collapsed, [key]: !get().collapsed[key] }
  localStorage.setItem('moyer.collapsed', JSON.stringify(collapsed))
  set({ collapsed })
}

export async function updateSettings(patch: Partial<Settings>) {
  const prev = get().settings
  if (prev) set({ settings: { ...prev, ...patch } as Settings })
  try {
    set({ settings: await api.setSettings(patch) })
  } catch (err) {
    toast(errorText(err), 'error')
    if (prev) set({ settings: prev })
  }
}

// ======================= 第二批功能 =======================
export async function markAllReadInView() {
  const s = get()
  const unread = s.view.kind === 'unified' && (s.view.box === 'inbox' || s.view.box === 'unread') ? s.counts?.unified.inbox : undefined
  const ok = await confirmDialog(unread ? `把这里的 ${unread} 封未读邮件全部标为已读？` : '把这里的未读邮件全部标为已读？', '全部标为已读')
  if (!ok) return
  set((st) => ({ list: st.list.map((m) => ({ ...m, seen: true })) }))
  try {
    await api.markAllRead(s.view)
    toast('已全部标为已读', 'ok')
  } catch (err) {
    toast(errorText(err), 'error')
  }
  void refreshList()
}

export async function searchOnServer(): Promise<number> {
  const s = get()
  if (!s.search.trim()) return 0
  try {
    const n = await api.searchServer(s.search, s.view)
    toast(n ? `在服务器上又找到 ${n} 封` : '服务器上没有更多结果', n ? 'ok' : 'info')
    if (n) await refreshList()
    return n
  } catch (err) {
    toast(errorText(err), 'error')
    return 0
  }
}

export function formatWhen(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  if (day === today) return `今天 ${hm}`
  if (day === today + 86_400_000) return `明天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export async function snoozeTo(until: number | null, ids = targetIds()) {
  if (!ids.length) return
  const s = get()
  const inSnoozed = s.view.kind === 'unified' && s.view.box === 'snoozed'
  if (until != null || inSnoozed) {
    const idx = s.list.findIndex((m) => m.id === s.selectedId)
    const remaining = s.list.filter((m) => !ids.includes(m.id))
    set({ list: remaining, total: Math.max(0, s.total - (s.list.length - remaining.length)), checked: [] })
    if (s.selectedId != null && ids.includes(s.selectedId)) void selectMessage(remaining[Math.min(idx, remaining.length - 1)]?.id ?? null)
  }
  try {
    await api.snooze(ids, until)
    toast(until ? `已推迟到 ${formatWhen(until)}，到时会提醒你` : '已取消稍后提醒', 'ok')
  } catch (err) {
    toast(errorText(err), 'error')
    void refreshList()
  }
}

export async function refreshScheduledCount() {
  try {
    set({ scheduledCount: (await api.listScheduled()).length })
  } catch {
    /* 忽略 */
  }
}

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { simpleParser, type AddressObject } from 'mailparser'
import type { MessageStructureObject } from 'imapflow'
import { detectLang } from '@shared/langs'
import { ACCOUNT_COLORS, findPreset } from '@shared/presets'
import type {
  AccountConfig,
  AccountDraft,
  Address,
  AttachmentInfo,
  Counts,
  DraftInput,
  FolderRole,
  ListQuery,
  ListResult,
  MessageDetail,
  MessageSummary,
  OAuthResult,
  Rule,
  ScheduledItem,
  Settings,
  SyncStatus,
  TestResult,
  TranslateRequest,
  TranslateResult,
  UnifiedBox,
  ViewKey
} from '@shared/types'
import { AccountStore, type OAuthTokens } from './accounts'
import { Db, rowToFolder, rowToSummary, safeJson, type MessageRow, type SqlParam } from './db'
import type { Host } from './host'
import { oauthInteractive, refreshTokens } from './oauth'
import { proxyFor } from './proxy'
import { AccountSession, verifyImap } from './session'
import { SettingsStore } from './settings'
import { buildRaw, sendRaw, verifySmtp, type SmtpAuth } from './smtp'
import { Translator } from './translate'
import { friendlyError, htmlToText, makeSnippet, toAddresses, uid, UserError, yieldLoop } from './util'

const LARGE_MESSAGE = 4_000_000
const DANGEROUS_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.msi', '.msp', '.lnk', '.hta', '.jar', '.reg', '.cpl', '.dll', '.appx', '.msix'])

interface BodyMeta {
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | null
  replyTo?: Address[]
  bcc?: Address[]
  to?: Address[]
  cc?: Address[]
}

function addrList(obj: AddressObject | AddressObject[] | undefined): Address[] {
  if (!obj) return []
  const arr = Array.isArray(obj) ? obj : [obj]
  return toAddresses(arr.flatMap((o) => o.value.flatMap((v) => (v.group ? v.group : [v]))))
}

function folderKey(accountId: string, path: string) {
  return `${accountId}\n${path}`
}

export class Engine {
  readonly db: Db
  readonly settings: SettingsStore
  readonly accounts: AccountStore
  private translator: Translator
  private sessions = new Map<string, AccountSession>()
  private pendingOAuth = new Map<string, { tokens: OAuthTokens; email: string }>()
  private refreshing = new Map<string, Promise<OAuthTokens>>()
  private timer?: NodeJS.Timeout
  private countsTimer?: NodeJS.Timeout
  private pruneTimer?: NodeJS.Timeout
  private tickTimer?: NodeJS.Timeout
  private firstTick?: NodeJS.Timeout
  private stopped = false
  private mailDir: string

  constructor(private host: Host) {
    mkdirSync(host.dataDir, { recursive: true })
    this.mailDir = join(host.dataDir, 'mail')
    mkdirSync(this.mailDir, { recursive: true })
    this.db = new Db(join(host.dataDir, 'moyer-mail.db'))
    this.settings = new SettingsStore(this.db, host)
    this.accounts = new AccountStore(this.db, host)
    this.translator = new Translator(this.db, host)
  }

  // ======================= 生命周期 =======================
  start() {
    this.host.applySettings(this.settings.get())
    for (const acc of this.accounts.list()) if (acc.enabled) this.startSession(acc)
    this.resetTimer()
    this.pruneTimer = setTimeout(() => this.translator.prune(), 60_000)
    this.tickTimer = setInterval(() => void this.tick(), 30_000)
    // 上次退出时正在发送的定时邮件，重新排队
    this.db.run("UPDATE outbox SET status = 'pending' WHERE status = 'sending'")
    this.firstTick = setTimeout(() => void this.tick(), 5_000)
  }

  async shutdown() {
    clearInterval(this.timer)
    clearTimeout(this.pruneTimer)
    clearTimeout(this.countsTimer)
    clearInterval(this.tickTimer)
    clearTimeout(this.firstTick)
    this.stopped = true
    await Promise.all([...this.sessions.values()].map((s) => s.stop()))
  }

  private resetTimer() {
    clearInterval(this.timer)
    const min = Math.max(1, this.settings.get().syncIntervalMin)
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) s.syncAll().catch(() => undefined)
    }, min * 60_000)
  }

  private startSession(acc: AccountConfig) {
    const session = new AccountSession(
      {
        db: this.db,
        imapOptions: async (a) => ({ auth: await this.credentials(a), proxy: await proxyFor(this.settings.get(), this.host, a.imap.host, a.useProxy) }),
        storeSource: (row, src) => this.storeSource(row, src),
        onStatus: (accountId, phase, error) =>
          this.host.emit('sync-status', { accountId, phase, error, lastSync: this.sessions.get(accountId)?.lastSync }),
        onChanged: (accountId, folders) => {
          if (folders.length) this.host.emit('messages-changed', { accountId, folders })
          this.emitCounts()
        },
        onFoldersChanged: (accountId) => this.host.emit('folders-changed', { accountId }),
        onNewMessages: (accountId, ids) => this.onNewMessages(accountId, ids),
        log: (...a) => this.host.log(...a)
      },
      acc
    )
    this.sessions.set(acc.id, session)
    session.start()
  }

  private async restartSession(id: string) {
    const old = this.sessions.get(id)
    this.sessions.delete(id)
    await old?.stop()
    const acc = this.accounts.get(id)
    if (acc?.enabled) this.startSession(acc)
  }

  private session(id: string): AccountSession {
    const s = this.sessions.get(id)
    if (!s) throw new UserError('这个账号已停用或不存在')
    return s
  }

  // ======================= 凭据 =======================
  private async credentials(acc: AccountConfig): Promise<SmtpAuth> {
    if (acc.authType === 'password') {
      const pass = this.accounts.getPassword(acc.id)
      if (!pass) throw new UserError('缺少授权码/密码，请编辑账号重新填写。')
      return { user: acc.username, pass }
    }
    let tokens = this.accounts.getOAuth(acc.id)
    if (!tokens) throw new UserError('登录已失效，请编辑账号重新授权。')
    if (tokens.expiresAt < Date.now() + 120_000) {
      let p = this.refreshing.get(acc.id)
      if (!p) {
        p = refreshTokens(tokens, this.settings.get(), this.host).finally(() => this.refreshing.delete(acc.id))
        this.refreshing.set(acc.id, p)
      }
      tokens = await p
      this.accounts.setOAuth(acc.id, tokens)
    }
    return { user: acc.username, accessToken: tokens.accessToken }
  }

  // ======================= 账号 =======================
  async listAccounts(): Promise<AccountConfig[]> {
    return this.accounts.list()
  }

  private draftToConfig(d: AccountDraft, existing?: AccountConfig): AccountConfig {
    const preset = findPreset(d.provider)
    const count = this.accounts.list().length
    return {
      id: existing?.id ?? d.id ?? uid(),
      email: d.email.trim(),
      name: d.name.trim() || d.email.split('@')[0],
      label: d.label?.trim() || existing?.label || d.email.trim(),
      provider: d.provider,
      color: d.color || existing?.color || (count === 0 ? preset.color : ACCOUNT_COLORS[count % ACCOUNT_COLORS.length]),
      authType: d.authType,
      username: d.username?.trim() || d.email.trim(),
      imap: { ...d.imap, host: d.imap.host.trim() },
      smtp: { ...d.smtp, host: d.smtp.host.trim() },
      useProxy: d.useProxy,
      appendSent: d.appendSent,
      signature: d.signature ?? existing?.signature ?? '',
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
      sortOrder: existing?.sortOrder ?? count
    }
  }

  private async draftAuth(d: AccountDraft, acc: AccountConfig): Promise<SmtpAuth> {
    if (d.authType === 'password') {
      const pass = d.password || (d.id ? this.accounts.getPassword(d.id) : undefined)
      if (!pass) throw new UserError('请填写授权码/密码')
      return { user: acc.username, pass }
    }
    if (d.oauthHandle) {
      const p = this.pendingOAuth.get(d.oauthHandle)
      if (!p) throw new UserError('授权已过期，请重新登录')
      return { user: acc.username, accessToken: p.tokens.accessToken }
    }
    if (d.id) return this.credentials(acc)
    throw new UserError('请先完成账号授权')
  }

  async testAccount(d: AccountDraft): Promise<TestResult> {
    const existing = d.id ? this.accounts.get(d.id) : undefined
    const acc = this.draftToConfig(d, existing)
    let auth: SmtpAuth
    try {
      auth = await this.draftAuth(d, acc)
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
    const settings = this.settings.get()
    const result: TestResult = { ok: true }
    const [imapRes, smtpRes] = await Promise.allSettled([
      (async () =>
        verifyImap({
          host: acc.imap.host,
          port: acc.imap.port,
          secure: acc.imap.secure,
          doSTARTTLS: acc.imap.secure ? undefined : true,
          auth,
          proxy: await proxyFor(settings, this.host, acc.imap.host, acc.useProxy)
        }))(),
      (async () => verifySmtp(acc, auth, await proxyFor(settings, this.host, acc.smtp.host, acc.useProxy)))()
    ])
    if (imapRes.status === 'rejected') {
      result.ok = false
      result.imap = friendlyError(imapRes.reason)
    }
    if (smtpRes.status === 'rejected') {
      result.ok = false
      result.smtp = friendlyError(smtpRes.reason)
    }
    if (!result.ok) result.error = result.imap ? `收信（IMAP）：${result.imap}` : `发信（SMTP）：${result.smtp}`
    return result
  }

  async saveAccount(d: AccountDraft): Promise<AccountConfig> {
    const existing = d.id ? this.accounts.get(d.id) : undefined
    if (!existing && this.accounts.list().some((a) => a.email.toLowerCase() === d.email.trim().toLowerCase()))
      throw new UserError('这个邮箱已经添加过了')
    const acc = this.draftToConfig(d, existing)
    this.accounts.save(acc)
    if (d.authType === 'password' && d.password) this.accounts.setPassword(acc.id, d.password)
    if (d.oauthHandle) {
      const p = this.pendingOAuth.get(d.oauthHandle)
      if (p) this.accounts.setOAuth(acc.id, p.tokens)
      this.pendingOAuth.delete(d.oauthHandle)
    }
    const needRestart =
      !existing ||
      !!d.password ||
      !!d.oauthHandle ||
      JSON.stringify([existing.imap, existing.smtp, existing.username, existing.useProxy, existing.authType, existing.enabled]) !==
        JSON.stringify([acc.imap, acc.smtp, acc.username, acc.useProxy, acc.authType, acc.enabled])
    if (needRestart) await this.restartSession(acc.id)
    else this.sessions.get(acc.id) && (this.sessions.get(acc.id)!.account = acc)
    this.host.emit('accounts-changed', this.accounts.list())
    return acc
  }

  async removeAccount(id: string) {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    await s?.stop()
    const ids = this.db.all<{ id: number }>('SELECT id FROM messages WHERE account_id = ?', id)
    this.accounts.remove(id)
    for (const r of ids) unlink(join(this.mailDir, `${r.id}.eml`)).catch(() => undefined)
    this.host.emit('accounts-changed', this.accounts.list())
    this.emitCounts()
  }

  async reorderAccounts(ids: string[]) {
    ids.forEach((id, i) => {
      const acc = this.accounts.get(id)
      if (acc) {
        acc.sortOrder = i
        this.accounts.save(acc)
        const s = this.sessions.get(id)
        if (s) s.account = acc
      }
    })
    this.host.emit('accounts-changed', this.accounts.list())
  }

  async oauthLogin(provider: 'microsoft' | 'google', loginHint?: string): Promise<OAuthResult> {
    const res = await oauthInteractive(provider, this.settings.get(), this.host, loginHint)
    const handle = uid(16)
    this.pendingOAuth.set(handle, { tokens: res.tokens, email: res.email })
    setTimeout(() => this.pendingOAuth.delete(handle), 30 * 60_000)
    return { handle, email: res.email, name: res.name }
  }

  // ======================= 文件夹与列表 =======================
  private enabledIds(): string[] {
    return this.accounts
      .list()
      .filter((a) => a.enabled)
      .map((a) => a.id)
  }

  async listFolders() {
    const order = new Map(this.accounts.list().map((a, i) => [a.id, i]))
    return this.db
      .all<any>('SELECT * FROM folders')
      .map(rowToFolder)
      .filter((f) => order.has(f.accountId))
      .sort((a, b) => order.get(a.accountId)! - order.get(b.accountId)! || 0)
  }

  private viewWhere(view: ViewKey, widen: boolean): { where: string[]; params: SqlParam[]; dedup: boolean } {
    const where: string[] = []
    const params: SqlParam[] = []
    let dedup = false
    const ids = this.enabledIds()
    where.push(`account_id IN (${ids.map(() => '?').join(',') || "''"})`)
    params.push(...ids)
    if (view.kind === 'unified') {
      const box: UnifiedBox = view.box
      if (widen && (box === 'inbox' || box === 'unread' || box === 'all')) {
        where.push("role NOT IN ('trash', 'junk')")
        if (box === 'unread') where.push('seen = 0')
        dedup = true
      } else if (box === 'inbox') where.push("role = 'inbox'")
      else if (box === 'unread') where.push("role = 'inbox' AND seen = 0")
      else if (box === 'flagged') {
        where.push("flagged = 1 AND role NOT IN ('trash', 'junk')")
        dedup = true
      } else if (box === 'snoozed') {
        where.push('snooze_until IS NOT NULL')
      } else if (box === 'all') {
        where.push("role NOT IN ('trash', 'junk')")
        dedup = true
      } else {
        where.push('role = ?')
        params.push(box)
      }
    } else if (view.kind === 'account') {
      where.push("account_id = ? AND role = 'inbox'")
      params.push(view.accountId)
    } else {
      where.push('account_id = ? AND folder = ?')
      params.push(view.accountId, view.path)
    }
    return { where, params, dedup }
  }

  async listMessages(q: ListQuery): Promise<ListResult> {
    const search = q.search?.trim() ?? ''
    const { where, params, dedup } = this.viewWhere(q.view, !!search)
    const snoozedView = q.view.kind === 'unified' && q.view.box === 'snoozed'
    // 稍后提醒的邮件到点之前只出现在“稍后处理”里
    if (!snoozedView && !search) {
      where.push('(snooze_until IS NULL OR snooze_until <= ?)')
      params.push(Date.now())
    }
    if (q.unreadOnly) where.push('seen = 0')
    if (search) {
      for (const term of search.split(/\s+/).filter(Boolean).slice(0, 6)) {
        if ([...term].length >= 3) {
          where.push('id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)')
          params.push(`"${term.replace(/"/g, '""')}"`)
        } else {
          const like = `%${term.replace(/[%_\\]/g, (m) => '\\' + m)}%`
          where.push(
            "(subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR id IN (SELECT rowid FROM msg_fts WHERE body LIKE ? ESCAPE '\\'))"
          )
          params.push(like, like, like, like)
        }
      }
    }
    let cond = where.join(' AND ')
    if (dedup) cond = `id IN (SELECT MAX(id) FROM messages WHERE ${cond} GROUP BY account_id, COALESCE(message_id, 'id:' || id))`
    const limit = Math.min(q.limit ?? 100, 500)
    const offset = q.offset ?? 0
    const noThreadBoxes: UnifiedBox[] = ['drafts', 'trash', 'junk', 'snoozed']
    const threaded = !!q.threads && !(q.view.kind === 'unified' && noThreadBoxes.includes(q.view.box))

    if (!threaded) {
      const order = snoozedView ? 'snooze_until ASC' : 'date DESC'
      const rows = this.db.raw.prepare(`SELECT * FROM messages WHERE ${cond} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as MessageRow[]
      const total = (this.db.raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${cond}`).get(...params) as { n: number }).n
      return { items: rows.map(rowToSummary), total }
    }

    // 会话模式：每个会话只显示最新的一封，带上会话里的其他邮件编号
    const part = "PARTITION BY account_id, COALESCE(thread_key, 'id:' || id)"
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM (
           SELECT m.*, ROW_NUMBER() OVER (${part} ORDER BY date DESC) AS rn,
             SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) OVER (${part}) AS t_unread,
             MAX(flagged) OVER (${part}) AS t_flag,
             MAX(has_att) OVER (${part}) AS t_att,
             group_concat(id) OVER (${part}) AS t_ids
           FROM messages m WHERE ${cond}
         ) WHERE rn = 1 ORDER BY date DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as unknown as (MessageRow & { t_unread: number; t_flag: number; t_att: number; t_ids: string })[]
    const total = (
      this.db.raw
        .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE ${cond} GROUP BY account_id, COALESCE(thread_key, 'id:' || id))`)
        .get(...params) as { n: number }
    ).n
    const items = rows.map((r) => {
      const s = rowToSummary(r)
      s.seen = r.t_unread === 0
      s.flagged = r.t_flag > 0
      s.hasAttachments = r.t_att > 0
      s.threadIds = String(r.t_ids).split(',').map(Number)
      s.threadCount = r.thread_key
        ? (
            this.db.get<{ n: number }>(
              "SELECT COUNT(DISTINCT COALESCE(message_id, 'id:' || id)) AS n FROM messages WHERE account_id = ? AND thread_key = ? AND role NOT IN ('trash', 'junk')",
              r.account_id,
              r.thread_key
            ) ?? { n: 1 }
          ).n
        : 1
      return s
    })
    return { items, total }
  }

  /** 会话里的全部邮件（同一封在多个文件夹里只保留一份），按时间从旧到新 */
  async getThread(id: number): Promise<MessageSummary[]> {
    const row = this.db.messageById(id)
    if (!row) throw new UserError('邮件不存在（可能已被删除）')
    if (!row.thread_key) return [rowToSummary(row)]
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM messages WHERE account_id = ? AND thread_key = ? AND (role NOT IN ('trash', 'junk') OR id = ?)
       ORDER BY date DESC LIMIT 100`,
      row.account_id,
      row.thread_key,
      id
    )
    const rank = (r: MessageRow) => (r.id === id ? 0 : r.role === 'all' ? 3 : r.body_state ? 1 : 2)
    const byMid = new Map<string, MessageRow>()
    for (const r of rows) {
      const k = r.message_id ?? `id:${r.id}`
      const prev = byMid.get(k)
      if (!prev || rank(r) < rank(prev)) byMid.set(k, r)
    }
    return [...byMid.values()].sort((a, b) => a.date - b.date).map(rowToSummary)
  }

  async loadOlder(view: ViewKey): Promise<number> {
    if (view.kind === 'folder') return this.session(view.accountId).loadOlder(view.path)
    if (view.kind === 'unified' && view.box === 'snoozed') return 0
    const role: FolderRole = view.kind === 'account' ? 'inbox' : view.box === 'unread' || view.box === 'flagged' || view.box === 'all' ? 'inbox' : (view.box as FolderRole)
    const ids = view.kind === 'account' ? [view.accountId] : this.enabledIds()
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const f = this.db.folderByRole(id, role)
        return f && this.sessions.get(id) ? this.sessions.get(id)!.loadOlder(f.path) : 0
      })
    )
    return results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0)
  }

  /** 视图对应的服务器文件夹 */
  private viewFolders(view: ViewKey): { accountId: string; path: string }[] {
    if (view.kind === 'folder') return [{ accountId: view.accountId, path: view.path }]
    const role: FolderRole | null =
      view.kind === 'account'
        ? 'inbox'
        : view.box === 'inbox' || view.box === 'unread'
          ? 'inbox'
          : view.box === 'flagged' || view.box === 'snoozed' || view.box === 'all'
            ? null
            : view.box
    if (!role) return []
    const ids = view.kind === 'account' ? [view.accountId] : this.enabledIds()
    return ids.flatMap((id) => {
      const f = this.db.folderByRole(id, role)
      return f ? [{ accountId: id, path: f.path }] : []
    })
  }

  async markAllRead(view: ViewKey): Promise<number> {
    const folders = this.viewFolders(view)
    if (!folders.length) {
      // 星标、稍后处理这类跨文件夹的视图：只处理本地能看到的
      const { items } = await this.listMessages({ view, unreadOnly: true, limit: 500 })
      const ids = items.map((m) => m.id)
      if (ids.length) await this.setFlags(ids, { seen: true })
      return ids.length ? 1 : 0
    }
    this.db.tx(() => {
      for (const f of folders) {
        this.db.run('UPDATE messages SET seen = 1 WHERE account_id = ? AND folder = ?', f.accountId, f.path)
        this.db.run('UPDATE folders SET unread = 0 WHERE account_id = ? AND path = ?', f.accountId, f.path)
      }
    })
    for (const f of folders) this.host.emit('messages-changed', { accountId: f.accountId, folders: [f.path] })
    this.emitCounts()
    const results = await Promise.allSettled(folders.map((f) => this.sessions.get(f.accountId)?.markFolderSeen(f.path)))
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (failed) throw new UserError(`部分邮箱同步到服务器失败：${friendlyError(failed.reason)}`)
    return folders.length
  }

  async searchServer(query: string, view: ViewKey): Promise<number> {
    const q = query.trim()
    if (!q) return 0
    let targets: { accountId: string; path: string }[]
    if (view.kind === 'folder') targets = [{ accountId: view.accountId, path: view.path }]
    else {
      const ids = view.kind === 'account' ? [view.accountId] : this.enabledIds()
      targets = ids.flatMap((id) => {
        // Gmail 搜“所有邮件”就能覆盖归档和已发送
        const all = this.accounts.get(id)?.provider === 'gmail' ? this.db.folderByRole(id, 'all') : undefined
        if (all) return [{ accountId: id, path: all.path }]
        return (['inbox', 'sent', 'archive'] as FolderRole[]).flatMap((r) => {
          const f = this.db.folderByRole(id, r)
          return f ? [{ accountId: id, path: f.path }] : []
        })
      })
    }
    const results = await Promise.allSettled(targets.map((t) => this.sessions.get(t.accountId)?.searchServer(t.path, q) ?? Promise.resolve([])))
    const found = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.length : 0), 0)
    if (!found && results.length && results.every((r) => r.status === 'rejected'))
      throw new UserError(`服务器搜索失败：${friendlyError((results[0] as PromiseRejectedResult).reason)}`)
    return found
  }

  async getCounts(): Promise<Counts> {
    const ids = this.enabledIds()
    const unified: Record<UnifiedBox, number> = { inbox: 0, unread: 0, flagged: 0, snoozed: 0, sent: 0, drafts: 0, trash: 0, junk: 0, all: 0 }
    const folders: Record<string, number> = {}
    const accounts: Record<string, number> = {}
    const set = new Set(ids)
    for (const f of this.db.all<{ account_id: string; path: string; role: string; unread: number; total: number }>(
      'SELECT account_id, path, role, unread, total FROM folders'
    )) {
      if (!set.has(f.account_id)) continue
      folders[folderKey(f.account_id, f.path)] = f.unread
      if (f.role === 'inbox') {
        unified.inbox += f.unread
        accounts[f.account_id] = (accounts[f.account_id] ?? 0) + f.unread
      }
      if (f.role === 'junk') unified.junk += f.unread
      if (f.role === 'drafts') unified.drafts += f.total
    }
    unified.unread = unified.inbox
    if (ids.length) {
      const inList = ids.map(() => '?').join(',')
      unified.flagged = (
        this.db.raw
          .prepare(
            `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages WHERE flagged = 1 AND role NOT IN ('trash','junk') AND account_id IN (${inList}) GROUP BY account_id, COALESCE(message_id, 'id:' || id))`
          )
          .get(...ids) as { n: number }
      ).n
      unified.snoozed = (this.db.raw.prepare(`SELECT COUNT(*) AS n FROM messages WHERE snooze_until IS NOT NULL AND account_id IN (${inList})`).get(...ids) as { n: number }).n
    }
    return { unified, folders, accounts }
  }

  private emitCounts() {
    clearTimeout(this.countsTimer)
    this.countsTimer = setTimeout(async () => this.host.emit('counts', await this.getCounts()), 150)
  }

  async getSyncStatus(): Promise<SyncStatus[]> {
    return [...this.sessions.values()].map((s) => ({ accountId: s.id, phase: s.phase, error: s.error, lastSync: s.lastSync }))
  }

  async syncNow(accountId?: string) {
    const list = accountId ? [this.session(accountId)] : [...this.sessions.values()]
    await Promise.allSettled(list.map((s) => s.syncAll()))
  }

  async openFolder(accountId: string, path: string) {
    this.sessions.get(accountId)?.schedule(path, 0)
  }

  // ======================= 邮件正文 =======================
  /** 解析邮件原文并存入本地缓存 */
  async storeSource(row: MessageRow, source: Buffer) {
    await yieldLoop()
    const parsed = await simpleParser(source, { skipTextToHtml: true, skipTextLinks: true, skipHtmlToText: true })
    const html = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null
    const text = parsed.text?.trim() ? parsed.text : html ? htmlToText(html) : ''
    const attachments: AttachmentInfo[] = parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename || `附件${index + 1}${a.contentType === 'message/rfc822' ? '.eml' : ''}`,
      contentType: a.contentType,
      size: a.size,
      inline: !!a.related || (a.contentDisposition === 'inline' && !!a.cid && !!html?.includes('data:')),
      cid: a.cid
    }))
    const real = attachments.filter((a) => !a.inline)
    const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references) : null
    const meta: BodyMeta = {
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      references: refs,
      replyTo: addrList(parsed.replyTo),
      bcc: addrList(parsed.bcc),
      to: addrList(parsed.to),
      cc: addrList(parsed.cc)
    }
    if (real.length) await writeFile(join(this.mailDir, `${row.id}.eml`), source)
    if (!this.db.messageById(row.id)) return
    this.db.setBody(row.id, {
      html,
      text,
      meta,
      attachments,
      lang: detectLang(`${row.subject}\n${text}`),
      snippet: makeSnippet(text),
      hasEml: real.length > 0,
      hasAtt: real.length > 0
    })
  }

  /** 大邮件：只下载正文和内嵌图片，附件等用户点开时再下载 */
  private async storeStructured(row: MessageRow, session: AccountSession) {
    const bs = safeJson<MessageStructureObject | null>(row.bs_json, null)
    const texts: MessageStructureObject[] = []
    const inline: MessageStructureObject[] = []
    const atts: MessageStructureObject[] = []
    const walk = (n: MessageStructureObject) => {
      if (n.childNodes?.length) return n.childNodes.forEach(walk)
      const disp = (n.disposition ?? '').toLowerCase()
      const filename = n.dispositionParameters?.filename ?? n.parameters?.name
      if ((n.type === 'text/plain' || n.type === 'text/html') && disp !== 'attachment' && !filename) texts.push(n)
      else if (n.type.startsWith('image/') && n.id && disp !== 'attachment') inline.push(n)
      else atts.push(n)
    }
    if (bs) walk(bs)
    let html: string | null = null
    let text: string | null = null
    for (const p of texts) {
      if (!p.part) continue
      const s = (await session.downloadPart(row, p.part)).toString('utf8')
      if (p.type === 'text/html' && !html) html = s
      else if (p.type === 'text/plain' && !text) text = s
    }
    if (html) {
      for (const p of inline) {
        const cid = p.id!.replace(/^<|>$/g, '')
        if (!p.part || !html.includes(`cid:${cid}`)) continue
        const data = await session.downloadPart(row, p.part)
        html = html.split(`cid:${cid}`).join(`data:${p.type};base64,${data.toString('base64')}`)
      }
    }
    const attachments: AttachmentInfo[] = atts.map((p, index) => ({
      index,
      filename: p.dispositionParameters?.filename ?? p.parameters?.name ?? `附件${index + 1}`,
      contentType: p.type,
      size: p.encoding === 'base64' ? Math.round((p.size ?? 0) * 0.74) : p.size ?? 0,
      inline: false,
      part: p.part
    }))
    const plain = text ?? (html ? htmlToText(html) : '')
    this.db.setBody(row.id, {
      html,
      text: plain,
      meta: { messageId: row.message_id, inReplyTo: row.in_reply_to },
      attachments,
      lang: detectLang(`${row.subject}\n${plain}`),
      snippet: makeSnippet(plain),
      hasEml: false,
      hasAtt: attachments.length > 0
    })
  }

  async getMessage(id: number): Promise<MessageDetail> {
    const row = this.db.messageById(id)
    if (!row) throw new UserError('邮件不存在（可能已被删除）')
    let body = this.db.getBody(id)
    if (!body) {
      const session = this.session(row.account_id)
      const bs = safeJson<MessageStructureObject | null>(row.bs_json, null)
      if (row.size > LARGE_MESSAGE && bs?.childNodes?.length) {
        await this.storeStructured(row, session)
      } else {
        const src = await session.fetchSource(row)
        if (!src) throw new UserError('这封邮件在服务器上已不存在')
        await this.storeSource(row, src)
      }
      body = this.db.getBody(id)
      if (!body) throw new UserError('邮件读取失败')
    }
    const fresh = this.db.messageById(id) ?? row
    const meta = safeJson<BodyMeta>(body.meta_json, {})
    const summary = rowToSummary(fresh)
    return {
      ...summary,
      to: meta.to?.length ? meta.to : summary.to,
      cc: meta.cc?.length ? meta.cc : summary.cc,
      replyTo: meta.replyTo ?? [],
      bcc: meta.bcc ?? [],
      inReplyTo: meta.inReplyTo ?? fresh.in_reply_to,
      references: meta.references ?? null,
      messageId: meta.messageId ?? fresh.message_id,
      html: body.html,
      text: body.text,
      attachments: safeJson<AttachmentInfo[]>(body.attachments_json, []).filter((a) => !a.inline),
      lang: body.lang,
      remoteImages: this.settings.get().loadRemoteImages
    }
  }

  // ======================= 旗标与移动 =======================
  private groupRows(ids: number[]) {
    const groups = new Map<string, { accountId: string; folder: string; role: string; rows: MessageRow[] }>()
    for (const r of this.db.messagesByIds(ids)) {
      const k = folderKey(r.account_id, r.folder)
      if (!groups.has(k)) groups.set(k, { accountId: r.account_id, folder: r.folder, role: r.role, rows: [] })
      groups.get(k)!.rows.push(r)
    }
    return [...groups.values()]
  }

  async setFlags(ids: number[], flags: { seen?: boolean; flagged?: boolean }) {
    const groups = this.groupRows(ids)
    // 先改本地，界面立刻生效
    this.db.tx(() => {
      for (const g of groups) {
        for (const r of g.rows) {
          if (flags.seen !== undefined) this.db.run('UPDATE messages SET seen = ? WHERE id = ?', flags.seen ? 1 : 0, r.id)
          if (flags.flagged !== undefined) this.db.run('UPDATE messages SET flagged = ? WHERE id = ?', flags.flagged ? 1 : 0, r.id)
        }
        if (flags.seen !== undefined) {
          const delta = g.rows.filter((r) => !!r.seen !== flags.seen).length * (flags.seen ? -1 : 1)
          if (delta)
            this.db.run('UPDATE folders SET unread = MAX(0, unread + ?) WHERE account_id = ? AND path = ?', delta, g.accountId, g.folder)
        }
      }
    })
    this.emitCounts()
    const errors: unknown[] = []
    await Promise.all(
      groups.map(async (g) => {
        const s = this.sessions.get(g.accountId)
        if (!s) return
        const uids = g.rows.map((r) => r.uid)
        try {
          if (flags.seen !== undefined) await s.setFlags(g.folder, uids, ['\\Seen'], flags.seen)
          if (flags.flagged !== undefined) await s.setFlags(g.folder, uids, ['\\Flagged'], flags.flagged)
        } catch (err) {
          errors.push(err)
          s.schedule(g.folder)
        }
      })
    )
    if (errors.length) throw new UserError(`同步到服务器失败：${friendlyError(errors[0])}`)
  }

  private destFor(accountId: string, sourceRole: string, target: 'trash' | 'archive' | 'junk' | 'inbox' | { path: string }): string | null {
    if (typeof target === 'object') return target.path
    if (target === 'archive') {
      const acc = this.accounts.get(accountId)
      if (acc?.provider === 'gmail') return this.db.folderByRole(accountId, 'all')?.path ?? null
      return this.db.folderByRole(accountId, 'archive')?.path ?? null
    }
    if (target === 'trash' && sourceRole === 'trash') return null
    return this.db.folderByRole(accountId, target)?.path ?? null
  }

  async moveMessages(ids: number[], target: 'trash' | 'archive' | 'junk' | 'inbox' | { path: string }) {
    const groups = this.groupRows(ids)
    const plans = groups.map((g) => ({ ...g, dest: this.destFor(g.accountId, g.role, target) }))
    for (const p of plans) {
      if (!p.dest && !(target === 'trash' && p.role === 'trash')) {
        const what = target === 'archive' ? '归档' : target === 'junk' ? '垃圾邮件' : target === 'trash' ? '废纸篓' : '目标'
        throw new UserError(`这个邮箱没有“${what}”文件夹`)
      }
    }
    // 本地先删除
    this.db.tx(() => {
      for (const p of plans) {
        const unseen = p.rows.filter((r) => !r.seen).length
        for (const r of p.rows) this.db.deleteMessage(r.id)
        if (unseen) this.db.run('UPDATE folders SET unread = MAX(0, unread - ?) WHERE account_id = ? AND path = ?', unseen, p.accountId, p.folder)
      }
    })
    for (const p of plans) this.host.emit('messages-changed', { accountId: p.accountId, folders: [p.folder] })
    this.emitCounts()
    const errors: unknown[] = []
    await Promise.all(
      plans.map(async (p) => {
        const s = this.sessions.get(p.accountId)
        if (!s) return
        const uids = p.rows.map((r) => r.uid)
        try {
          if (p.dest) await s.move(p.folder, uids, p.dest)
          else await s.deleteForever(p.folder, uids)
          if (p.dest) s.schedule(p.dest, 1500)
          for (const r of p.rows) unlink(join(this.mailDir, `${r.id}.eml`)).catch(() => undefined)
        } catch (err) {
          errors.push(err)
          s.schedule(p.folder, 0)
        }
      })
    )
    if (errors.length) throw new UserError(`操作失败：${friendlyError(errors[0])}`)
  }

  async deleteForever(ids: number[]) {
    await this.moveMessages(
      ids.filter((id) => this.db.messageById(id)?.role === 'trash'),
      'trash'
    )
    const others = ids.filter((id) => {
      const r = this.db.messageById(id)
      return r && r.role !== 'trash'
    })
    if (others.length) {
      for (const g of this.groupRows(others)) {
        for (const r of g.rows) this.db.deleteMessage(r.id)
        await this.sessions.get(g.accountId)?.deleteForever(
          g.folder,
          g.rows.map((r) => r.uid)
        )
        this.host.emit('messages-changed', { accountId: g.accountId, folders: [g.folder] })
      }
    }
  }

  // ======================= 附件 =======================
  private async attachmentContent(id: number, index: number): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const row = this.db.messageById(id)
    if (!row) throw new UserError('邮件不存在')
    const body = this.db.getBody(id)
    const list = safeJson<AttachmentInfo[]>(body?.attachments_json, [])
    const info = list.find((a) => a.index === index)
    if (info?.part) {
      const content = await this.session(row.account_id).downloadPart(row, info.part)
      return { filename: info.filename, contentType: info.contentType, content }
    }
    const emlPath = join(this.mailDir, `${id}.eml`)
    let source: Buffer | null = existsSync(emlPath) ? await readFile(emlPath) : null
    if (!source) {
      source = await this.session(row.account_id).fetchSource(row)
      if (!source) throw new UserError('邮件在服务器上已不存在')
      await writeFile(emlPath, source)
    }
    const parsed = await simpleParser(source, { skipTextToHtml: true, skipHtmlToText: true })
    const a = parsed.attachments[index]
    if (!a) throw new UserError('附件不存在')
    return { filename: info?.filename ?? a.filename ?? `附件${index + 1}`, contentType: a.contentType, content: a.content }
  }

  async openAttachment(id: number, index: number) {
    const a = await this.attachmentContent(id, index)
    if (DANGEROUS_EXT.has(extname(a.filename).toLowerCase()))
      throw new UserError('为了安全，可执行文件不能直接打开。请用“另存为”保存后自行确认。')
    const dir = join(tmpdir(), 'moyer-mail', String(id))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, a.filename.replace(/[\\/:*?"<>|]/g, '_'))
    await writeFile(file, a.content)
    await this.host.openPath(file)
  }

  async saveAttachment(id: number, index: number): Promise<boolean> {
    const a = await this.attachmentContent(id, index)
    const file = await this.host.saveDialog(a.filename.replace(/[\\/:*?"<>|]/g, '_'))
    if (!file) return false
    await writeFile(file, a.content)
    return true
  }

  async pickFiles() {
    return this.host.pickFiles()
  }

  // ======================= 发信 =======================
  async send(d: DraftInput) {
    const acc = this.accounts.get(d.accountId)
    if (!acc) throw new UserError('发件账号不存在')
    const recipients = [...d.to, ...d.cc, ...d.bcc].filter((a) => a.address)
    if (!recipients.length) throw new UserError('请填写收件人')
    const domain = acc.email.split('@')[1] || 'moyer.local'
    const attachments: { filename: string; path?: string; content?: Buffer; contentType?: string }[] = []
    for (const a of d.attachments) {
      if (a.fromMessage) {
        const c = await this.attachmentContent(a.fromMessage.id, a.fromMessage.index)
        attachments.push({ filename: c.filename, content: c.content, contentType: c.contentType })
      } else if (a.path) attachments.push({ filename: a.filename, path: a.path })
    }
    const input = {
      from: { name: acc.name, address: acc.email },
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      html: d.html,
      text: d.text,
      inReplyTo: d.inReplyTo,
      references: d.references,
      attachments,
      messageId: `<${uid(20)}@${domain}>`,
      date: new Date()
    }
    const raw = await buildRaw(input, false)
    const auth = await this.credentials(acc)
    const proxy = await proxyFor(this.settings.get(), this.host, acc.smtp.host, acc.useProxy)
    try {
      await sendRaw(acc, auth, proxy, raw, { from: acc.email, to: recipients.map((r) => r.address) })
    } catch (err) {
      throw new UserError(`发送失败：${friendlyError(err)}`)
    }
    for (const r of recipients) this.db.touchContact(r, 3)
    const session = this.sessions.get(acc.id)
    const sent = this.db.folderByRole(acc.id, 'sent')
    if (session && sent) {
      if (acc.appendSent) {
        buildRaw(input, true)
          .then((copy) => session.append(sent.path, copy, ['\\Seen']))
          .catch((err) => this.host.log('append sent failed', err))
          .finally(() => session.schedule(sent.path, 1000))
      } else session.schedule(sent.path, 4000)
    }
    if (d.replyToLocalId) {
      const row = this.db.messageById(d.replyToLocalId)
      if (row) {
        this.db.run('UPDATE messages SET answered = 1 WHERE id = ?', row.id)
        this.host.emit('messages-changed', { accountId: row.account_id, folders: [row.folder] })
        this.sessions
          .get(row.account_id)
          ?.setFlags(row.folder, [row.uid], ['\\Answered'], true)
          .catch(() => undefined)
      }
    }
  }

  async suggestContacts(query: string): Promise<Address[]> {
    const q = `%${query.trim().toLowerCase()}%`
    if (q === '%%') return []
    return this.db
      .all<{ address: string; name: string | null }>(
        'SELECT address, name FROM contacts WHERE address LIKE ? OR lower(name) LIKE ? ORDER BY score DESC, last_used DESC LIMIT 8',
        q,
        q
      )
      .map((r) => ({ address: r.address, name: r.name || undefined }))
  }

  // ======================= 翻译 =======================
  async translate(req: TranslateRequest): Promise<TranslateResult> {
    try {
      return await this.translator.translate(req, this.settings.get())
    } catch (err) {
      if (err instanceof UserError) throw err
      throw new UserError(`翻译失败：${friendlyError(err)}`)
    }
  }

  // ======================= 设置 =======================
  async getSettings(): Promise<Settings> {
    return this.settings.get()
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const before = this.settings.get()
    const after = this.settings.update(patch)
    this.host.applySettings(after)
    if (JSON.stringify(before.proxy) !== JSON.stringify(after.proxy)) {
      for (const id of [...this.sessions.keys()]) await this.restartSession(id)
    }
    if (before.syncIntervalMin !== after.syncIntervalMin) this.resetTimer()
    this.host.emit('settings-changed', after)
    return after
  }

  async testProxy(): Promise<TestResult> {
    try {
      const res = await this.host.fetch('https://www.gstatic.com/generate_204', { signal: AbortSignal.timeout(10_000) })
      return res.status === 204 || res.ok ? { ok: true } : { ok: false, error: `返回状态 ${res.status}` }
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  }

  async openExternal(url: string) {
    if (!/^(https?|mailto):/i.test(url)) throw new UserError('不支持的链接')
    await this.host.openExternal(url)
  }

  // ======================= 新邮件：规则 + 通知 =======================
  private async onNewMessages(accountId: string, ids: number[]) {
    let quiet = new Set<number>()
    try {
      quiet = (await this.applyRules(ids)).quiet
    } catch (err) {
      this.host.log('rules failed', err)
    }
    const notify = this.db
      .messagesByIds(ids)
      .filter((r) => !r.seen && !quiet.has(r.id))
      .map((r) => r.id)
    this.notifyNewMail(accountId, notify)
  }

  // ======================= 收信规则 =======================
  async listRules(): Promise<Rule[]> {
    return this.db.all<{ json: string }>('SELECT json FROM rules ORDER BY sort, rowid').map((r) => JSON.parse(r.json) as Rule)
  }

  async saveRule(rule: Rule): Promise<Rule> {
    const r: Rule = { ...rule, id: rule.id || uid(), name: rule.name.trim() || '未命名规则' }
    const existing = this.db.get<{ sort: number }>('SELECT sort FROM rules WHERE id = ?', r.id)
    const sort = existing?.sort ?? (this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM rules')?.n ?? 0)
    this.db.run('INSERT INTO rules (id, json, sort) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', r.id, JSON.stringify(r), sort)
    return r
  }

  async removeRule(id: string) {
    this.db.run('DELETE FROM rules WHERE id = ?', id)
  }

  private ruleMatches(rule: Rule, r: MessageRow): boolean {
    if (!rule.enabled || !rule.conditions.length) return false
    if (rule.accountId && rule.accountId !== r.account_id) return false
    const recips = [...safeJson<Address[]>(r.to_json, []), ...safeJson<Address[]>(r.cc_json, [])]
    const test = (c: Rule['conditions'][number]) => {
      const want = c.value.trim().toLowerCase()
      if (!want) return false
      const candidates =
        c.field === 'subject'
          ? [r.subject]
          : c.field === 'from'
            ? [r.from_addr ?? '', r.from_name ?? '']
            : recips.flatMap((a) => [a.address, a.name ?? ''])
      const vals = candidates.map((v) => v.toLowerCase().trim()).filter(Boolean)
      switch (c.op) {
        case 'contains':
          return vals.some((v) => v.includes(want))
        case 'notContains':
          return !vals.some((v) => v.includes(want))
        case 'equals':
          return vals.some((v) => v === want)
        case 'startsWith':
          return vals.some((v) => v.startsWith(want))
        case 'endsWith':
          return vals.some((v) => v.endsWith(want))
      }
    }
    return rule.match === 'any' ? rule.conditions.some(test) : rule.conditions.every(test)
  }

  /** 对一批邮件执行规则；返回不需要弹通知的邮件 */
  private async applyRules(ids: number[], only?: string): Promise<{ matched: number; quiet: Set<number> }> {
    const rules = (await this.listRules()).filter((r) => r.enabled && (!only || r.id === only))
    const quiet = new Set<number>()
    if (!rules.length || !ids.length) return { matched: 0, quiet }
    const markRead: number[] = []
    const flag: number[] = []
    const moves = new Map<'archive' | 'trash' | 'junk', number[]>()
    let matched = 0
    for (const row of this.db.messagesByIds(ids)) {
      let hit = false
      let moved = false
      for (const rule of rules) {
        if (!this.ruleMatches(rule, row)) continue
        hit = true
        const a = rule.actions
        if (a.markRead) markRead.push(row.id)
        if (a.flag) flag.push(row.id)
        if (a.silent || a.markRead) quiet.add(row.id)
        if (a.move && !moved) {
          moved = true
          quiet.add(row.id)
          if (!moves.has(a.move)) moves.set(a.move, [])
          moves.get(a.move)!.push(row.id)
        }
      }
      if (hit) matched++
    }
    if (markRead.length) await this.setFlags(markRead, { seen: true }).catch((e) => this.host.log('rule markRead', e))
    if (flag.length) await this.setFlags(flag, { flagged: true }).catch((e) => this.host.log('rule flag', e))
    for (const [target, list] of moves) await this.moveMessages(list, target).catch((e) => this.host.log('rule move', e))
    return { matched, quiet }
  }

  async runRules(ruleId?: string): Promise<number> {
    const ids = this.enabledIds()
    if (!ids.length) return 0
    const rows = this.db.all<{ id: number }>(
      `SELECT id FROM messages WHERE role = 'inbox' AND account_id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    )
    return (await this.applyRules(rows.map((r) => r.id), ruleId)).matched
  }

  // ======================= 稍后提醒 =======================
  async snooze(ids: number[], until: number | null) {
    const rows = this.db.messagesByIds(ids)
    this.db.tx(() => {
      for (const r of rows) this.db.run('UPDATE messages SET snooze_until = ? WHERE id = ?', until, r.id)
    })
    for (const [accountId, folders] of this.groupFolders(rows)) this.host.emit('messages-changed', { accountId, folders })
    this.emitCounts()
  }

  private groupFolders(rows: MessageRow[]) {
    const map = new Map<string, string[]>()
    for (const r of rows) {
      const list = map.get(r.account_id) ?? []
      if (!list.includes(r.folder)) list.push(r.folder)
      map.set(r.account_id, list)
    }
    return map
  }

  // ======================= 定时发送 =======================
  async scheduleSend(d: DraftInput, sendAt: number) {
    if (!this.accounts.get(d.accountId)) throw new UserError('发件账号不存在')
    if (![...d.to, ...d.cc, ...d.bcc].some((a) => a.address)) throw new UserError('请填写收件人')
    this.db.run(
      'INSERT INTO outbox (account_id, draft_json, send_at, status, created) VALUES (?, ?, ?, ?, ?)',
      d.accountId,
      JSON.stringify(d),
      Math.max(sendAt, Date.now()),
      'pending',
      Date.now()
    )
    this.emitScheduled()
    if (sendAt <= Date.now() + 1000) setTimeout(() => void this.tick(), 200)
  }

  async listScheduled(): Promise<ScheduledItem[]> {
    return this.db
      .all<{ id: number; account_id: string; draft_json: string; send_at: number; status: string; error: string | null }>(
        "SELECT * FROM outbox WHERE status IN ('pending', 'failed') ORDER BY send_at"
      )
      .map((r) => {
        const d = safeJson<DraftInput>(r.draft_json, {} as DraftInput)
        return { id: r.id, accountId: r.account_id, subject: d.subject ?? '', to: d.to ?? [], sendAt: r.send_at, status: r.status as ScheduledItem['status'], error: r.error }
      })
  }

  async cancelScheduled(id: number): Promise<DraftInput> {
    const row = this.db.get<{ draft_json: string; status: string }>('SELECT draft_json, status FROM outbox WHERE id = ?', id)
    if (!row) throw new UserError('这封定时邮件已经发出或不存在')
    if (row.status === 'sending') throw new UserError('正在发送中，无法取消')
    this.db.run('DELETE FROM outbox WHERE id = ?', id)
    this.emitScheduled()
    return JSON.parse(row.draft_json) as DraftInput
  }

  async sendScheduledNow(id: number) {
    this.db.run("UPDATE outbox SET send_at = ?, status = 'pending', error = NULL WHERE id = ? AND status != 'sending'", Date.now(), id)
    await this.tick()
    const row = this.db.get<{ error: string | null }>("SELECT error FROM outbox WHERE id = ? AND status = 'failed'", id)
    if (row) throw new UserError(row.error ?? '发送失败')
  }

  private emitScheduled() {
    const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'failed')")?.n ?? 0
    this.host.emit('scheduled-changed', { count: n })
  }

  // ======================= 定时任务：到点的提醒和定时邮件 =======================
  private ticking = false

  /** 每 30 秒执行一次（测试里也可以直接调用） */
  async tick() {
    if (this.ticking || this.stopped) return
    this.ticking = true
    try {
      const now = Date.now()
      // 稍后提醒到点：重新标为未读并提醒
      const due = this.db.all<MessageRow>('SELECT * FROM messages WHERE snooze_until IS NOT NULL AND snooze_until <= ?', now)
      if (due.length) {
        this.db.tx(() => {
          for (const r of due) this.db.run('UPDATE messages SET snooze_until = NULL WHERE id = ?', r.id)
        })
        await this.setFlags(
          due.map((r) => r.id),
          { seen: false }
        ).catch((e) => this.host.log('unsnooze', e))
        for (const [accountId, folders] of this.groupFolders(due)) this.host.emit('messages-changed', { accountId, folders })
        const first = due[0]
        if (this.settings.get().notifications)
          this.host.notify(
            due.length === 1 ? `提醒：${first.from_name || first.from_addr || ''}` : `提醒：${due.length} 封邮件`,
            first.subject || '（无主题）',
            () => this.host.emit('open-message', { id: first.id })
          )
      }
      // 定时发送
      const jobs = this.db.all<{ id: number; draft_json: string }>("SELECT id, draft_json FROM outbox WHERE status = 'pending' AND send_at <= ?", now)
      for (const job of jobs) {
        this.db.run("UPDATE outbox SET status = 'sending' WHERE id = ?", job.id)
        const d = JSON.parse(job.draft_json) as DraftInput
        try {
          await this.send(d)
          this.db.run('DELETE FROM outbox WHERE id = ?', job.id)
          this.host.emit('toast', { text: `定时邮件已发送：${d.subject || '（无主题）'}`, kind: 'ok' })
        } catch (err) {
          const msg = err instanceof UserError ? err.message : friendlyError(err)
          this.db.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", msg, job.id)
          this.host.notify('定时邮件发送失败', `${d.subject || '（无主题）'}\n${msg}`, () => undefined)
        }
      }
      if (jobs.length) this.emitScheduled()
    } finally {
      this.ticking = false
    }
  }

  // ======================= 通知 =======================
  private notifyNewMail(accountId: string, ids: number[]) {
    this.emitCounts()
    if (!this.settings.get().notifications) return
    const rows = this.db.messagesByIds(ids).sort((a, b) => b.date - a.date)
    if (!rows.length) return
    const acc = this.accounts.get(accountId)
    const first = rows[0]
    const sender = first.from_name || first.from_addr || '未知发件人'
    if (rows.length === 1) {
      this.host.notify(`${sender}`, `${first.subject || '（无主题）'}\n${acc?.label ?? ''}`, () => this.host.emit('open-message', { id: first.id }))
    } else {
      const names = [...new Set(rows.map((r) => r.from_name || r.from_addr))].slice(0, 3).join('、')
      this.host.notify(`${acc?.label ?? ''} 收到 ${rows.length} 封新邮件`, names, () => this.host.emit('open-message', { id: first.id }))
    }
  }
}

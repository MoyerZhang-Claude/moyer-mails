import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse, type MessageStructureObject } from 'imapflow'
import type { AccountConfig, FolderRole, SyncPhase } from '@shared/types'
import type { Db, MessageRow, NewMessage } from './db'
import { friendlyError, sleep, toAddress, toAddresses } from './util'

/** 首次同步每个文件夹拉取的邮件数 */
const INITIAL_WINDOW = 300
/** 每次“加载更早的邮件”拉取的数量 */
const OLDER_BATCH = 200
/** 预下载正文的数量和大小上限 */
const PREFETCH_INBOX = 50
const PREFETCH_OTHER = 15
const PREFETCH_MAX_SIZE = 1_500_000
/** 自动同步的文件夹类型 */
const AUTO_SYNC: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash']

const CLIENT_INFO = { name: 'Moyer Mail', version: '0.1.0', vendor: 'Moyer', 'support-url': 'https://github.com' }

export interface SessionContext {
  db: Db
  imapOptions(account: AccountConfig): Promise<Partial<ImapFlowOptions>>
  storeSource(row: MessageRow, source: Buffer): Promise<void>
  onStatus(accountId: string, phase: SyncPhase, error?: string): void
  onChanged(accountId: string, folders: string[]): void
  onFoldersChanged(accountId: string): void
  /** 收件箱里新到的邮件（首次同步不算）。在释放文件夹锁之后调用，可以放心移动邮件 */
  onNewMessages(accountId: string, ids: number[]): Promise<void>
  log(...args: unknown[]): void
}

export function roleOf(f: { path: string; specialUse?: string }): FolderRole {
  if (f.path.toUpperCase() === 'INBOX') return 'inbox'
  switch (f.specialUse) {
    case '\\Inbox':
      return 'inbox'
    case '\\Sent':
      return 'sent'
    case '\\Drafts':
      return 'drafts'
    case '\\Trash':
      return 'trash'
    case '\\Junk':
      return 'junk'
    case '\\Archive':
      return 'archive'
    case '\\All':
      return 'all'
    case '\\Flagged':
      return 'flagged'
    default:
      return 'other'
  }
}

const ROLE_ORDER: Record<FolderRole, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, all: 4, flagged: 5, junk: 6, trash: 7, other: 10 }

function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false
  if (node.childNodes?.length) return node.childNodes.some(hasAttachments)
  const disp = (node.disposition ?? '').toLowerCase()
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name
  if (disp === 'attachment') return true
  if (filename && !(node.type.startsWith('image/') && node.id)) return true
  return false
}

function messageFromFetch(accountId: string, folder: string, role: FolderRole, m: FetchMessageObject): NewMessage {
  const env = m.envelope ?? {}
  const internal = m.internalDate ? new Date(m.internalDate).getTime() : NaN
  const header = env.date ? new Date(env.date).getTime() : NaN
  const flags = m.flags ?? new Set<string>()
  return {
    accountId,
    folder,
    role,
    uid: m.uid,
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    subject: env.subject ?? '',
    from: toAddress(env.from?.[0]),
    to: toAddresses(env.to),
    cc: toAddresses(env.cc),
    date: Number.isFinite(internal) ? internal : Number.isFinite(header) ? header : Date.now(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAtt: hasAttachments(m.bodyStructure),
    size: m.size ?? 0,
    bodyStructure: m.bodyStructure ? JSON.stringify(m.bodyStructure) : null,
    threadId: m.threadId ?? null
  }
}

const FETCH_QUERY = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, threadId: true } as const

export class AccountSession {
  private worker?: ImapFlow
  private connecting?: Promise<ImapFlow>
  private watcher?: ImapFlow
  private stopped = false
  private pending = new Set<string>()
  private running = false
  private kickTimer?: NodeJS.Timeout
  private watcherBackoff = 5_000
  phase: SyncPhase = 'idle'
  error?: string
  lastSync?: number
  /** 首次同步完成之前不弹通知 */
  private primed = false

  constructor(private ctx: SessionContext, public account: AccountConfig) {}

  get id() {
    return this.account.id
  }

  private setPhase(phase: SyncPhase, error?: string) {
    this.phase = phase
    this.error = error
    if (phase === 'idle') this.lastSync = Date.now()
    this.ctx.onStatus(this.id, phase, error)
  }

  // ---------------- 连接 ----------------
  private async makeClient(extra: Partial<ImapFlowOptions>): Promise<ImapFlow> {
    const opts = await this.ctx.imapOptions(this.account)
    const c = new ImapFlow({
      host: this.account.imap.host,
      port: this.account.imap.port,
      secure: this.account.imap.secure,
      doSTARTTLS: this.account.imap.secure ? undefined : true,
      clientInfo: CLIENT_INFO,
      logger: false,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 10 * 60_000,
      ...opts,
      ...extra
    } as ImapFlowOptions)
    c.on('error', (err: unknown) => this.ctx.log(`[${this.account.email}] imap error`, (err as Error)?.message))
    await c.connect()
    return c
  }

  /** 工作连接：执行同步、取信、改旗标等操作 */
  async client(): Promise<ImapFlow> {
    if (this.worker?.usable) return this.worker
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      if (this.phase !== 'syncing') this.setPhase('connecting')
      const c = await this.makeClient({ disableAutoIdle: true })
      c.on('close', () => {
        if (this.worker === c) this.worker = undefined
      })
      this.worker = c
      return c
    })().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }

  /** 监听连接：一直停在收件箱上 IDLE，新邮件秒到 */
  private async runWatcher() {
    while (!this.stopped) {
      let c: ImapFlow | undefined
      try {
        c = await this.makeClient({ autoIdleDelay: 2_000, maxIdleTime: 4 * 60_000 })
        this.watcher = c
        const inbox = this.ctx.db.folderByRole(this.id, 'inbox')?.path ?? 'INBOX'
        await c.mailboxOpen(inbox)
        c.on('exists', () => this.schedule(inbox))
        c.on('expunge', () => this.schedule(inbox))
        c.on('flags', (ev: { uid?: number; flags?: Set<string> }) => {
          if (ev.uid && ev.flags) {
            const changed = this.ctx.db.updateFlags(this.id, inbox, ev.uid, {
              seen: ev.flags.has('\\Seen'),
              flagged: ev.flags.has('\\Flagged'),
              answered: ev.flags.has('\\Answered')
            })
            if (changed) this.ctx.onChanged(this.id, [inbox])
          } else this.schedule(inbox)
        })
        this.watcherBackoff = 5_000
        const closed = new Promise<void>((resolve) => c!.once('close', () => resolve()))
        // 重连后补一次同步，防止断线期间漏信
        this.schedule(inbox)
        await closed
      } catch (err) {
        this.ctx.log(`[${this.account.email}] watcher`, (err as Error)?.message)
        const msg = friendlyError(err)
        if (msg.startsWith('登录失败') || msg.includes('密码') || msg.includes('授权')) this.watcherBackoff = 10 * 60_000
      } finally {
        if (this.watcher === c) this.watcher = undefined
      }
      if (this.stopped) break
      await sleep(this.watcherBackoff)
      this.watcherBackoff = Math.min(this.watcherBackoff * 2, 10 * 60_000)
    }
  }

  start() {
    this.stopped = false
    this.syncAll().catch(() => undefined)
    void this.runWatcher()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.kickTimer)
    const all = [this.worker, this.watcher]
    this.worker = undefined
    this.watcher = undefined
    await Promise.all(all.map((c) => c?.logout().catch(() => c?.close())))
  }

  // ---------------- 同步调度 ----------------
  schedule(path: string, delay = 300) {
    this.pending.add(path)
    clearTimeout(this.kickTimer)
    this.kickTimer = setTimeout(() => void this.drain(), delay)
  }

  private async drain() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (this.pending.size && !this.stopped) {
        const path = this.pending.values().next().value as string
        this.pending.delete(path)
        await this.syncFolder(path)
      }
    } finally {
      this.running = false
    }
  }

  /** 列出文件夹，然后同步所有重要文件夹 */
  async syncAll() {
    try {
      this.setPhase('syncing')
      await this.syncFolderList()
      const folders = this.ctx.db.foldersOf(this.id).filter((f) => AUTO_SYNC.includes(f.role as FolderRole) && !f.no_select)
      folders.sort((a, b) => ROLE_ORDER[a.role as FolderRole] - ROLE_ORDER[b.role as FolderRole])
      for (const f of folders) {
        if (this.stopped) return
        try {
          await this.syncFolder(f.path, true)
        } catch (err) {
          // 收件箱失败算整体失败；其他文件夹失败只记日志
          if (f.role === 'inbox') throw err
          this.ctx.log(`[${this.account.email}] skip folder ${f.path}`, (err as Error)?.message)
        }
      }
      this.primed = true
      this.setPhase('idle')
    } catch (err) {
      this.ctx.log(`[${this.account.email}] syncAll`, err)
      this.setPhase('error', friendlyError(err))
      throw err
    }
  }

  async syncFolderList() {
    const c = await this.client()
    const list: ListResponse[] = await c.list()
    const db = this.ctx.db
    const seen = new Set<string>()
    db.tx(() => {
      for (const f of list) {
        seen.add(f.path)
        const role = roleOf(f)
        const noSelect = f.flags.has('\\Noselect') || f.flags.has('\\NonExistent')
        db.run(
          `INSERT INTO folders (account_id, path, name, delimiter, role, parent_path, no_select, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, delimiter = excluded.delimiter,
           role = excluded.role, parent_path = excluded.parent_path, no_select = excluded.no_select, sort = excluded.sort`,
          this.id,
          f.path,
          f.name,
          f.delimiter ?? '/',
          role,
          f.parentPath ?? '',
          noSelect ? 1 : 0,
          ROLE_ORDER[role]
        )
      }
      for (const f of db.foldersOf(this.id)) {
        if (!seen.has(f.path)) {
          db.deleteFolderMessages(this.id, f.path)
          db.run('DELETE FROM folders WHERE account_id = ? AND path = ?', this.id, f.path)
        }
      }
    })
    this.ctx.onFoldersChanged(this.id)
  }

  /** 同步一个文件夹：新邮件、旗标变化、服务器端删除，然后预下载正文 */
  async syncFolder(path: string, quiet = false) {
    const db = this.ctx.db
    const folder = db.getFolder(this.id, path)
    if (!folder || folder.no_select) return
    const role = folder.role as FolderRole
    if (!quiet) this.setPhase('syncing')
    const newIds: number[] = []
    let arrived: number[] = []
    let changed = false
    try {
      const c = await this.client()
      const lock = await c.getMailboxLock(path)
      try {
        // 重新 SELECT 一次：工作连接不 IDLE，缓存的邮件数 / UIDNEXT / MODSEQ 可能已经过时
        const mb = await c.mailboxOpen(path)
        if (!mb || this.stopped) return
        const uidValidity = String(mb.uidValidity)
        if (folder.uid_validity && folder.uid_validity !== uidValidity) {
          db.deleteFolderMessages(this.id, path)
          db.run('UPDATE folders SET highest_modseq = NULL WHERE account_id = ? AND path = ?', this.id, path)
          changed = true
        }
        let known = db.folderUids(this.id, path)
        const wasEmpty = known.length === 0

        if (mb.exists === 0) {
          if (known.length) {
            db.deleteFolderMessages(this.id, path)
            changed = true
          }
        } else {
          // 1. 新邮件
          let range: string | null = null
          let byUid = true
          if (known.length === 0) {
            range = `${Math.max(1, mb.exists - INITIAL_WINDOW + 1)}:*`
            byUid = false
          } else {
            const maxUid = known[known.length - 1]
            if (!mb.uidNext || mb.uidNext > maxUid + 1) range = `${maxUid + 1}:*`
          }
          if (range) {
            const maxUid = known.length ? known[known.length - 1] : 0
            const batch: NewMessage[] = []
            for await (const m of c.fetch(range, FETCH_QUERY, { uid: byUid })) {
              if (m.uid <= maxUid) continue
              batch.push(messageFromFetch(this.id, path, role, m))
            }
            if (this.stopped) return
            if (batch.length) {
              db.tx(() => {
                for (const m of batch) {
                  const id = db.insertMessage(m)
                  if (id) {
                    newIds.push(id)
                    if (m.from && role !== 'sent') db.touchContact(m.from, 1)
                  }
                }
              })
              changed = changed || newIds.length > 0
            }
          }

          // 2. 已缓存邮件的旗标变化与删除
          known = db.folderUids(this.id, path)
          if (!wasEmpty && known.length) {
            const minUid = known[0]
            const prevModseq = folder.highest_modseq ? BigInt(folder.highest_modseq) : undefined
            const modseqSame = prevModseq !== undefined && mb.highestModseq !== undefined && prevModseq === mb.highestModseq
            if (!modseqSame) {
              const opts = prevModseq !== undefined && mb.highestModseq !== undefined ? { uid: true, changedSince: prevModseq } : { uid: true }
              const updates: { uid: number; flags: Set<string> }[] = []
              for await (const m of c.fetch(`${minUid}:*`, { uid: true, flags: true }, opts)) {
                if (m.flags) updates.push({ uid: m.uid, flags: m.flags })
              }
              db.tx(() => {
                for (const u of updates) {
                  if (
                    db.updateFlags(this.id, path, u.uid, {
                      seen: u.flags.has('\\Seen'),
                      flagged: u.flags.has('\\Flagged'),
                      answered: u.flags.has('\\Answered')
                    })
                  )
                    changed = true
                }
              })
            }
            const serverUids = await c.search({ uid: `${minUid}:*` }, { uid: true })
            if (Array.isArray(serverUids)) {
              const set = new Set(serverUids)
              const gone = known.filter((u) => !set.has(u))
              if (gone.length) {
                db.tx(() => db.deleteMessagesByUid(this.id, path, gone))
                changed = true
              }
            }
          }
        }

        // 3. 未读数（以服务器为准）
        let unread = 0
        if (mb.exists > 0) {
          const unseen = await c.search({ seen: false }, { uid: true })
          unread = Array.isArray(unseen) ? unseen.length : 0
        }
        db.run(
          'UPDATE folders SET uid_validity = ?, highest_modseq = ?, total = ?, unread = ?, last_sync = ? WHERE account_id = ? AND path = ?',
          uidValidity,
          mb.highestModseq !== undefined ? String(mb.highestModseq) : null,
          mb.exists,
          unread,
          Date.now(),
          this.id,
          path
        )

        if (newIds.length && role === 'inbox' && this.primed && !wasEmpty) arrived = newIds
      } finally {
        lock.release()
      }
      if (arrived.length) await this.ctx.onNewMessages(this.id, arrived).catch((err) => this.ctx.log('onNewMessages', err))
      if (changed) this.ctx.onChanged(this.id, [path])
      else this.ctx.onChanged(this.id, [])
      await this.prefetch(path, role === 'inbox' ? PREFETCH_INBOX : PREFETCH_OTHER)
      if (!quiet) this.setPhase('idle')
    } catch (err) {
      this.ctx.log(`[${this.account.email}] syncFolder ${path}`, err)
      if (!quiet) this.setPhase('error', friendlyError(err))
      else throw err
    }
  }

  /** 预下载最新几封邮件的正文，点开时直接显示 */
  private async prefetch(path: string, limit: number) {
    const db = this.ctx.db
    const rows = db.all<MessageRow>(
      `SELECT * FROM messages WHERE account_id = ? AND folder = ? AND body_state = 0 AND size <= ?
       ORDER BY date DESC LIMIT ?`,
      this.id,
      path,
      PREFETCH_MAX_SIZE,
      limit
    )
    if (!rows.length) return
    const sources = new Map<number, Buffer>()
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    try {
      for await (const m of c.fetch(rows.map((r) => r.uid).join(','), { uid: true, source: true }, { uid: true })) {
        if (m.source) sources.set(m.uid, m.source)
      }
    } finally {
      lock.release()
    }
    let any = false
    for (const r of rows) {
      if (this.stopped) return
      const src = sources.get(r.uid)
      if (!src) continue
      try {
        await this.ctx.storeSource(r, src)
        any = true
      } catch (err) {
        this.ctx.log('prefetch parse failed', r.id, err)
      }
    }
    if (any) this.ctx.onChanged(this.id, [path])
  }

  /** 加载更早的邮件 */
  async loadOlder(path: string): Promise<number> {
    const db = this.ctx.db
    const folder = db.getFolder(this.id, path)
    if (!folder) return 0
    const known = db.folderUids(this.id, path)
    if (!known.length) {
      await this.syncFolder(path)
      return db.folderUids(this.id, path).length
    }
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    const batch: NewMessage[] = []
    try {
      if (known[0] <= 1) return 0
      const older = await c.search({ uid: `1:${known[0] - 1}` }, { uid: true })
      if (!Array.isArray(older) || !older.length) return 0
      const pick = older.sort((a, b) => a - b).slice(-OLDER_BATCH)
      for await (const m of c.fetch(pick.join(','), FETCH_QUERY, { uid: true })) {
        batch.push(messageFromFetch(this.id, path, folder.role as FolderRole, m))
      }
    } finally {
      lock.release()
    }
    let n = 0
    db.tx(() => {
      for (const m of batch) if (db.insertMessage(m)) n++
    })
    if (n) this.ctx.onChanged(this.id, [path])
    return n
  }

  // ---------------- 单封邮件操作 ----------------
  async fetchSource(row: MessageRow): Promise<Buffer | null> {
    const c = await this.client()
    const lock = await c.getMailboxLock(row.folder)
    try {
      const m = await c.fetchOne(String(row.uid), { uid: true, source: true }, { uid: true })
      return m && m.source ? m.source : null
    } finally {
      lock.release()
    }
  }

  async downloadPart(row: MessageRow, part: string): Promise<Buffer> {
    const c = await this.client()
    const lock = await c.getMailboxLock(row.folder)
    try {
      const res = await c.download(String(row.uid), part, { uid: true })
      if (!res.content) throw new Error('附件不存在')
      const chunks: Buffer[] = []
      for await (const ch of res.content) chunks.push(ch as Buffer)
      return Buffer.concat(chunks)
    } finally {
      lock.release()
    }
  }

  async setFlags(path: string, uids: number[], flags: string[], add: boolean) {
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    try {
      if (add) await c.messageFlagsAdd(uids.join(','), flags, { uid: true })
      else await c.messageFlagsRemove(uids.join(','), flags, { uid: true })
    } finally {
      lock.release()
    }
  }

  async move(path: string, uids: number[], dest: string) {
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    try {
      await c.messageMove(uids.join(','), dest, { uid: true })
    } finally {
      lock.release()
    }
  }

  /** 把整个文件夹的未读标为已读（包括没缓存到本地的） */
  async markFolderSeen(path: string) {
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    try {
      await c.messageFlagsAdd({ seen: false }, ['\\Seen'], { uid: true })
    } finally {
      lock.release()
    }
  }

  /** 在服务器上搜索，把本地还没有的结果（最新的 100 封）拉下来 */
  async searchServer(path: string, query: string): Promise<number[]> {
    const db = this.ctx.db
    const folder = db.getFolder(this.id, path)
    if (!folder || folder.no_select) return []
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    const batch: NewMessage[] = []
    try {
      const gmail = c.capabilities.has('X-GM-EXT-1')
      const found = await c.search(gmail ? { gmraw: query } : { or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true })
      if (!Array.isArray(found) || !found.length) return []
      const known = new Set(db.folderUids(this.id, path))
      const pick = found.filter((u) => !known.has(u)).sort((a, b) => a - b).slice(-100)
      if (!pick.length) return []
      for await (const m of c.fetch(pick.join(','), FETCH_QUERY, { uid: true })) {
        batch.push(messageFromFetch(this.id, path, folder.role as FolderRole, m))
      }
    } finally {
      lock.release()
    }
    const ids: number[] = []
    db.tx(() => {
      for (const m of batch) {
        const id = db.insertMessage(m)
        if (id) ids.push(id)
      }
    })
    if (ids.length) this.ctx.onChanged(this.id, [path])
    return ids
  }

  async deleteForever(path: string, uids: number[]) {
    const c = await this.client()
    const lock = await c.getMailboxLock(path)
    try {
      await c.messageDelete(uids.join(','), { uid: true })
    } finally {
      lock.release()
    }
  }

  async append(path: string, raw: Buffer, flags: string[]) {
    const c = await this.client()
    await c.append(path, raw, flags)
  }
}

/** 只验证登录，不保存 */
export async function verifyImap(options: ImapFlowOptions): Promise<void> {
  const c = new ImapFlow({ ...options, clientInfo: CLIENT_INFO, logger: false, connectionTimeout: 25_000, greetingTimeout: 20_000 })
  c.on('error', () => undefined)
  await c.connect()
  await c.logout().catch(() => c.close())
}

import { rmSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Address, FolderInfo, FolderRole, MessageSummary } from '@shared/types'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  account_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '/',
  role TEXT NOT NULL DEFAULT 'other',
  parent_path TEXT NOT NULL DEFAULT '',
  no_select INTEGER NOT NULL DEFAULT 0,
  uid_validity TEXT,
  highest_modseq TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  last_sync INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  role TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT,
  from_addr TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  date INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  has_att INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  body_state INTEGER NOT NULL DEFAULT 0,
  bs_json TEXT,
  UNIQUE (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_msg_role_date ON messages (role, date DESC);
CREATE INDEX IF NOT EXISTS idx_msg_folder_date ON messages (account_id, folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_msg_flagged ON messages (flagged, date DESC);
CREATE INDEX IF NOT EXISTS idx_msg_body ON messages (body_state, date DESC);

CREATE TABLE IF NOT EXISTS bodies (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  html TEXT,
  text TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  lang TEXT,
  has_eml INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5 (subject, people, body, tokenize = 'trigram');

CREATE TABLE IF NOT EXISTS contacts (
  address TEXT PRIMARY KEY,
  name TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS translations (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created INTEGER NOT NULL
);
`

export interface MessageRow {
  id: number
  account_id: string
  folder: string
  role: string
  uid: number
  message_id: string | null
  in_reply_to: string | null
  subject: string
  from_name: string | null
  from_addr: string | null
  to_json: string
  cc_json: string
  date: number
  seen: number
  flagged: number
  answered: number
  has_att: number
  size: number
  snippet: string
  body_state: number
  bs_json: string | null
  thread_key: string | null
  snooze_until: number | null
}

export interface FolderRow {
  account_id: string
  path: string
  name: string
  delimiter: string
  role: string
  parent_path: string
  no_select: number
  uid_validity: string | null
  highest_modseq: string | null
  total: number
  unread: number
  last_sync: number | null
  sort: number
}

export interface NewMessage {
  accountId: string
  folder: string
  role: FolderRole
  uid: number
  messageId: string | null
  inReplyTo: string | null
  subject: string
  from: Address | null
  to: Address[]
  cc: Address[]
  date: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAtt: boolean
  size: number
  bodyStructure: string | null
  threadId?: string | null
}

export function rowToSummary(r: MessageRow): MessageSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    folder: r.folder,
    role: r.role as FolderRole,
    uid: r.uid,
    messageId: r.message_id,
    subject: r.subject,
    from: r.from_addr || r.from_name ? { name: r.from_name ?? undefined, address: r.from_addr ?? '' } : null,
    to: safeJson<Address[]>(r.to_json, []),
    cc: safeJson<Address[]>(r.cc_json, []),
    date: r.date,
    seen: !!r.seen,
    flagged: !!r.flagged,
    answered: !!r.answered,
    hasAttachments: !!r.has_att,
    snippet: r.snippet,
    size: r.size,
    snoozeUntil: r.snooze_until ?? null
  }
}

export function rowToFolder(r: FolderRow): FolderInfo {
  return {
    accountId: r.account_id,
    path: r.path,
    name: r.name,
    delimiter: r.delimiter,
    role: r.role as FolderRole,
    parentPath: r.parent_path,
    noSelect: !!r.no_select,
    unread: r.unread,
    total: r.total
  }
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** 去掉 Re: / 回复: / Fwd: 等前缀，用来把同一话题的邮件串起来 */
export function normalizeSubject(s: string): string {
  return s
    .replace(/^\s*((re|fw|fwd|aw|wg|sv|vs|antw|tr|rif|回复|答复|回覆|转发|轉寄|转寄)\s*(\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function isReplySubject(s: string): boolean {
  return /^\s*(re|aw|sv|vs|antw|回复|答复|回覆)\s*(\[\d+\]|\(\d+\))?\s*[:：]/i.test(s)
}

interface ThreadInput {
  accountId: string
  messageId: string | null
  inReplyTo: string | null
  subject: string
  date: number
  threadId?: string | null
}

/**
 * 数据库版本升级。每一项把版本号从 i 升到 i+1。
 * 只能往后追加，已经发布的升级步骤不要再改，这样老用户的数据才能平滑升级。
 */
const MIGRATIONS: ((db: Db) => void)[] = [
  // v1：邮件会话、稍后提醒、定时发送、收信规则
  (db) => {
    const cols = db.all<{ name: string }>("SELECT name FROM pragma_table_info('messages')").map((c) => c.name)
    if (!cols.includes('thread_key')) db.raw.exec('ALTER TABLE messages ADD COLUMN thread_key TEXT')
    if (!cols.includes('subject_norm')) db.raw.exec('ALTER TABLE messages ADD COLUMN subject_norm TEXT')
    if (!cols.includes('snooze_until')) db.raw.exec('ALTER TABLE messages ADD COLUMN snooze_until INTEGER')
    db.raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages (account_id, thread_key);
      CREATE INDEX IF NOT EXISTS idx_msg_mid ON messages (account_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_msg_irt ON messages (account_id, in_reply_to);
      CREATE INDEX IF NOT EXISTS idx_msg_subj ON messages (account_id, subject_norm);
      CREATE INDEX IF NOT EXISTS idx_msg_snooze ON messages (snooze_until);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        send_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0
      );
    `)
    // 给已有邮件补上会话编号（按时间从旧到新）
    const rows = db.all<{ id: number; account_id: string; message_id: string | null; in_reply_to: string | null; subject: string; date: number }>(
      'SELECT id, account_id, message_id, in_reply_to, subject, date FROM messages ORDER BY date ASC'
    )
    for (const r of rows) db.assignThread(r.id, { accountId: r.account_id, messageId: r.message_id, inReplyTo: r.in_reply_to, subject: r.subject, date: r.date })
  }
]

export const DB_VERSION = MIGRATIONS.length

export class Db {
  readonly raw: DatabaseSync
  private cache = new Map<string, StatementSync>()

  constructor(file: string) {
    this.raw = new DatabaseSync(file)
    this.raw.exec(SCHEMA)
    this.migrate(file)
  }

  /** 升级数据库结构；升级前先自动备份一份 */
  private migrate(file: string) {
    const version = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version >= MIGRATIONS.length) return
    const hasData = !!this.get<{ x: number }>('SELECT 1 AS x FROM accounts LIMIT 1')
    if (hasData && file !== ':memory:') {
      const backup = `${file}.bak-v${version}`
      try {
        rmSync(backup, { force: true })
        this.raw.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
      } catch (err) {
        console.error('[db] backup before migration failed', err)
      }
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        MIGRATIONS[v](this)
        this.raw.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  /** 给一封邮件分配会话编号 */
  assignThread(id: number, m: ThreadInput) {
    const norm = normalizeSubject(m.subject)
    const keyOf = (sql: string, ...p: SqlParam[]) => this.get<{ k: string | null }>(sql, ...p)?.k ?? null
    let key: string | null = m.threadId ? `x:${m.threadId}` : null
    // 同一封邮件在别的文件夹里已经有会话（比如 Gmail 的多个标签）
    if (!key && m.messageId)
      key = keyOf('SELECT thread_key AS k FROM messages WHERE account_id = ? AND message_id = ? AND id != ? AND thread_key IS NOT NULL LIMIT 1', m.accountId, m.messageId, id)
    const parentKey = m.inReplyTo
      ? keyOf('SELECT thread_key AS k FROM messages WHERE account_id = ? AND message_id = ? AND thread_key IS NOT NULL LIMIT 1', m.accountId, m.inReplyTo)
      : null
    if (!key && parentKey) key = parentKey
    if (!key && norm && isReplySubject(m.subject))
      key = keyOf(
        `SELECT thread_key AS k FROM messages WHERE account_id = ? AND subject_norm = ? AND id != ? AND thread_key IS NOT NULL
         AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 1`,
        m.accountId,
        norm,
        id,
        m.date - 120 * 86_400_000,
        m.date + 86_400_000
      )
    if (!key) key = `m:${id}`
    this.run('UPDATE messages SET thread_key = ?, subject_norm = ? WHERE id = ?', key, norm, id)
    // 合并：上级邮件在别的会话里，或者先到的回复各自成了会话
    const merge = (other: string | null) => {
      if (other && other !== key && !other.startsWith('x:'))
        this.run('UPDATE messages SET thread_key = ? WHERE account_id = ? AND thread_key = ?', key, m.accountId, other)
    }
    merge(parentKey)
    if (m.messageId) {
      for (const o of this.all<{ k: string }>(
        'SELECT DISTINCT thread_key AS k FROM messages WHERE account_id = ? AND in_reply_to = ? AND thread_key IS NOT NULL',
        m.accountId,
        m.messageId
      ))
        merge(o.k)
    }
  }

  /** 预编译语句缓存 */
  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params) as T[]
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined
  }

  run(sql: string, ...params: SqlParam[]) {
    return this.stmt(sql).run(...params)
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const r = fn()
      this.raw.exec('COMMIT')
      return r
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- kv ----------
  getKv(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)?.value
  }

  setKv(key: string, value: string) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  // ---------- folders ----------
  getFolder(accountId: string, path: string): FolderRow | undefined {
    return this.get<FolderRow>('SELECT * FROM folders WHERE account_id = ? AND path = ?', accountId, path)
  }

  foldersOf(accountId: string): FolderRow[] {
    return this.all<FolderRow>('SELECT * FROM folders WHERE account_id = ? ORDER BY sort', accountId)
  }

  folderByRole(accountId: string, role: FolderRole): FolderRow | undefined {
    return this.get<FolderRow>('SELECT * FROM folders WHERE account_id = ? AND role = ? ORDER BY sort LIMIT 1', accountId, role)
  }

  // ---------- messages ----------
  insertMessage(m: NewMessage): number | null {
    const res = this.run(
      `INSERT INTO messages (account_id, folder, role, uid, message_id, in_reply_to, subject, from_name, from_addr,
        to_json, cc_json, date, seen, flagged, answered, has_att, size, bs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, folder, uid) DO NOTHING`,
      m.accountId,
      m.folder,
      m.role,
      m.uid,
      m.messageId,
      m.inReplyTo,
      m.subject,
      m.from?.name ?? null,
      m.from?.address ?? null,
      JSON.stringify(m.to),
      JSON.stringify(m.cc),
      m.date,
      m.seen ? 1 : 0,
      m.flagged ? 1 : 0,
      m.answered ? 1 : 0,
      m.hasAtt ? 1 : 0,
      m.size,
      m.bodyStructure
    )
    if (!res.changes) return null
    const id = Number(res.lastInsertRowid)
    this.assignThread(id, m)
    const people = [m.from?.name, m.from?.address, ...m.to.map((a) => `${a.name ?? ''} ${a.address}`)].filter(Boolean).join(' ')
    this.run('INSERT INTO msg_fts (rowid, subject, people, body) VALUES (?, ?, ?, ?)', id, m.subject, people, '')
    return id
  }

  messageById(id: number): MessageRow | undefined {
    return this.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)
  }

  messagesByIds(ids: number[]): MessageRow[] {
    if (ids.length === 0) return []
    return this.raw.prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as unknown as MessageRow[]
  }

  folderUids(accountId: string, folder: string): number[] {
    return this.all<{ uid: number }>('SELECT uid FROM messages WHERE account_id = ? AND folder = ? ORDER BY uid', accountId, folder).map(
      (r) => r.uid
    )
  }

  deleteMessagesByUid(accountId: string, folder: string, uids: number[]): number[] {
    const ids: number[] = []
    for (const uid of uids) {
      const row = this.get<{ id: number }>('SELECT id FROM messages WHERE account_id = ? AND folder = ? AND uid = ?', accountId, folder, uid)
      if (row) {
        this.deleteMessage(row.id)
        ids.push(row.id)
      }
    }
    return ids
  }

  deleteMessage(id: number) {
    this.run('DELETE FROM msg_fts WHERE rowid = ?', id)
    this.run('DELETE FROM bodies WHERE message_id = ?', id)
    this.run('DELETE FROM messages WHERE id = ?', id)
  }

  deleteFolderMessages(accountId: string, folder: string): number[] {
    const ids = this.all<{ id: number }>('SELECT id FROM messages WHERE account_id = ? AND folder = ?', accountId, folder).map((r) => r.id)
    for (const id of ids) this.deleteMessage(id)
    return ids
  }

  updateFlags(accountId: string, folder: string, uid: number, flags: { seen: boolean; flagged: boolean; answered: boolean }): boolean {
    const res = this.run(
      `UPDATE messages SET seen = ?, flagged = ?, answered = ?
       WHERE account_id = ? AND folder = ? AND uid = ? AND (seen != ? OR flagged != ? OR answered != ?)`,
      flags.seen ? 1 : 0,
      flags.flagged ? 1 : 0,
      flags.answered ? 1 : 0,
      accountId,
      folder,
      uid,
      flags.seen ? 1 : 0,
      flags.flagged ? 1 : 0,
      flags.answered ? 1 : 0
    )
    return res.changes > 0
  }

  setBody(id: number, body: { html: string | null; text: string | null; meta: object; attachments: object[]; lang: string | null; snippet: string; hasEml: boolean; hasAtt: boolean }) {
    this.tx(() => {
      this.run(
        `INSERT INTO bodies (message_id, html, text, meta_json, attachments_json, lang, has_eml) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text, meta_json = excluded.meta_json,
         attachments_json = excluded.attachments_json, lang = excluded.lang, has_eml = excluded.has_eml`,
        id,
        body.html,
        body.text,
        JSON.stringify(body.meta),
        JSON.stringify(body.attachments),
        body.lang,
        body.hasEml ? 1 : 0
      )
      this.run('UPDATE messages SET snippet = ?, body_state = 1, has_att = ? WHERE id = ?', body.snippet, body.hasAtt ? 1 : 0, id)
      const row = this.get<{ subject: string; people: string }>('SELECT subject, people FROM msg_fts WHERE rowid = ?', id)
      if (row) {
        this.run('DELETE FROM msg_fts WHERE rowid = ?', id)
        this.run('INSERT INTO msg_fts (rowid, subject, people, body) VALUES (?, ?, ?, ?)', id, row.subject, row.people, (body.text ?? '').slice(0, 20000))
      }
    })
  }

  getBody(id: number):
    | { html: string | null; text: string | null; meta_json: string; attachments_json: string; lang: string | null; has_eml: number }
    | undefined {
    return this.get('SELECT * FROM bodies WHERE message_id = ?', id)
  }

  // ---------- contacts ----------
  touchContact(addr: Address, weight: number) {
    if (!addr.address) return
    const address = addr.address.toLowerCase()
    this.run(
      `INSERT INTO contacts (address, name, score, last_used) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
       score = contacts.score + excluded.score, last_used = MAX(contacts.last_used, excluded.last_used)`,
      address,
      addr.name ?? '',
      weight,
      Date.now()
    )
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array

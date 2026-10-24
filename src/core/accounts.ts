import type { AccountConfig } from '@shared/types'
import type { Db } from './db'
import type { Host } from './host'

export interface OAuthTokens {
  provider: 'microsoft' | 'google'
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export class AccountStore {
  constructor(private db: Db, private host: Host) {}

  list(): AccountConfig[] {
    return this.db
      .all<{ json: string }>('SELECT json FROM accounts ORDER BY sort, rowid')
      .map((r) => JSON.parse(r.json) as AccountConfig)
  }

  get(id: string): AccountConfig | undefined {
    const r = this.db.get<{ json: string }>('SELECT json FROM accounts WHERE id = ?', id)
    return r ? (JSON.parse(r.json) as AccountConfig) : undefined
  }

  save(acc: AccountConfig) {
    this.db.run(
      'INSERT INTO accounts (id, json, sort) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, sort = excluded.sort',
      acc.id,
      JSON.stringify(acc),
      acc.sortOrder
    )
  }

  remove(id: string) {
    this.db.tx(() => {
      const ids = this.db.all<{ id: number }>('SELECT id FROM messages WHERE account_id = ?', id)
      for (const r of ids) this.db.run('DELETE FROM msg_fts WHERE rowid = ?', r.id)
      this.db.run('DELETE FROM bodies WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)', id)
      this.db.run('DELETE FROM messages WHERE account_id = ?', id)
      this.db.run('DELETE FROM folders WHERE account_id = ?', id)
      this.db.run('DELETE FROM accounts WHERE id = ?', id)
      this.db.run('DELETE FROM secrets WHERE key LIKE ?', `${id}:%`)
    })
  }

  private setSecret(key: string, value: string) {
    this.db.run(
      'INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      this.host.encrypt(value)
    )
  }

  private getSecret(key: string): string | undefined {
    const r = this.db.get<{ value: string }>('SELECT value FROM secrets WHERE key = ?', key)
    if (!r) return undefined
    try {
      return this.host.decrypt(r.value)
    } catch {
      return undefined
    }
  }

  setPassword(id: string, password: string) {
    this.setSecret(`${id}:password`, password)
  }

  getPassword(id: string): string | undefined {
    return this.getSecret(`${id}:password`)
  }

  setOAuth(id: string, tokens: OAuthTokens) {
    this.setSecret(`${id}:oauth`, JSON.stringify(tokens))
  }

  getOAuth(id: string): OAuthTokens | undefined {
    const s = this.getSecret(`${id}:oauth`)
    return s ? (JSON.parse(s) as OAuthTokens) : undefined
  }
}

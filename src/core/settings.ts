import type { Settings } from '@shared/types'
import type { Db } from './db'
import type { Host } from './host'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  palette: 'mist',
  orbs: true,
  density: 'comfortable',
  threading: true,
  loadRemoteImages: true,
  markReadOnOpen: true,
  notifications: true,
  closeToTray: true,
  launchAtLogin: false,
  syncIntervalMin: 5,
  proxy: { mode: 'system', url: '' },
  translate: {
    provider: 'google',
    targetLang: 'zh',
    autoTranslate: false,
    listSubjects: true,
    display: 'replace',
    llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
    deepl: { apiKey: '' },
    azure: { key: '', region: '' }
  },
  oauth: { microsoftClientId: '', googleClientId: '', googleClientSecret: '' }
}

/** 这些字段加密后再存盘 */
const SECRET_PATHS: string[][] = [
  ['translate', 'llm', 'apiKey'],
  ['translate', 'deepl', 'apiKey'],
  ['translate', 'azure', 'key'],
  ['oauth', 'googleClientSecret']
]

function getPath(obj: any, path: string[]) {
  return path.reduce((o, k) => (o == null ? o : o[k]), obj)
}

function setPath(obj: any, path: string[], value: unknown) {
  let o = obj
  for (const k of path.slice(0, -1)) o = o[k]
  o[path[path.length - 1]] = value
}

function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? deepMerge(out[k], v) : v
  }
  return out
}

export class SettingsStore {
  private current: Settings

  constructor(private db: Db, private host: Host) {
    const raw = db.getKv('settings')
    let stored: any = {}
    if (raw) {
      try {
        stored = JSON.parse(raw)
        for (const p of SECRET_PATHS) {
          const v = getPath(stored, p)
          if (typeof v === 'string' && v.startsWith('enc:')) {
            try {
              setPath(stored, p, host.decrypt(v.slice(4)))
            } catch {
              setPath(stored, p, '')
            }
          }
        }
      } catch {
        stored = {}
      }
    }
    this.current = deepMerge(DEFAULT_SETTINGS, stored)
    // 旧版本里的“微软免费接口”已经失效，自动换成 Google
    if (!['google', 'azure', 'llm', 'deepl'].includes(this.current.translate.provider)) this.current.translate.provider = 'google'
    // v0.2.0 的会话界面还没做好，当时强制关闭了会话分组；升级上来时打开一次
    if (raw && db.getKv('settings_rev') !== '2') {
      this.current = { ...this.current, threading: true }
      db.setKv('settings_rev', '2')
      this.update({})
    } else if (!raw) db.setKv('settings_rev', '2')
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    this.current = deepMerge(this.current, patch)
    const toStore = JSON.parse(JSON.stringify(this.current))
    for (const p of SECRET_PATHS) {
      const v = getPath(toStore, p)
      if (typeof v === 'string' && v) setPath(toStore, p, 'enc:' + this.host.encrypt(v))
    }
    this.db.setKv('settings', JSON.stringify(toStore))
    return this.current
  }
}

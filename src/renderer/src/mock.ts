// 演示模式：在普通浏览器里打开界面时使用的假数据，方便预览和调界面。
import type { MailApi } from '@shared/api'
import type { AccountConfig, Counts, FolderInfo, MessageDetail, MessageSummary, Settings, ViewKey } from '@shared/types'

const listeners = new Set<(name: string, payload: unknown) => void>()
export function mockOn(cb: (name: string, payload: unknown) => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function emit(name: string, payload: unknown) {
  for (const l of listeners) l(name, payload)
}

const now = Date.now()
const H = 3600_000

const accounts: AccountConfig[] = [
  mkAccount('a1', 'moyer.demo@qq.com', 'QQ 邮箱', 'qq', '#1e88e5', { host: 'imap.qq.com', port: 993, secure: true }),
  mkAccount('a2', 'moyer.demo@gmail.com', 'Gmail', 'gmail', '#ea4335', { host: 'imap.gmail.com', port: 993, secure: true }),
  mkAccount('a3', 'moyer.demo@outlook.com', 'Outlook', 'outlook', '#0a64c8', { host: 'outlook.office365.com', port: 993, secure: true })
]

function mkAccount(id: string, email: string, label: string, provider: string, color: string, imap: AccountConfig['imap']): AccountConfig {
  return {
    id,
    email,
    name: 'Moyer',
    label,
    provider,
    color,
    authType: 'password',
    username: email,
    imap,
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
    useProxy: provider === 'gmail',
    appendSent: false,
    signature: '',
    enabled: true,
    createdAt: now,
    sortOrder: 0
  }
}

const roles: [FolderInfo['role'], string][] = [
  ['inbox', 'INBOX'],
  ['sent', 'Sent'],
  ['drafts', 'Drafts'],
  ['archive', 'Archive'],
  ['junk', 'Junk'],
  ['trash', 'Trash']
]
const folders: FolderInfo[] = accounts.flatMap((a) =>
  roles.map(([role, path]) => ({ accountId: a.id, path, name: path, delimiter: '/', role, parentPath: '', noSelect: false, unread: 0, total: 0 }))
)
folders.push({ accountId: 'a1', path: '其他文件夹/工作', name: '工作', delimiter: '/', role: 'other', parentPath: '', noSelect: false, unread: 0, total: 0 })

interface Seed {
  acc: string
  from: [string, string]
  subject: string
  snippet: string
  hours: number
  seen?: boolean
  flagged?: boolean
  att?: boolean
  role?: FolderInfo['role']
  lang?: string
  html?: string
}

const seeds: Seed[] = [
  {
    acc: 'a2',
    from: ['GitHub', 'noreply@github.com'],
    subject: '[GitHub] A new SSH key was added to your account',
    snippet: 'The following SSH key was added to your account. If you believe this key was added in error, you can remove it…',
    hours: 0.3,
    lang: 'en',
    html: `<div style="font-family:Arial;max-width:560px;margin:auto"><h2 style="color:#24292f">A new SSH key was added</h2><p>Hey Moyer!</p><p>The following SSH key was added to your account:</p><p style="background:#f6f8fa;padding:12px;border-radius:6px"><b>Laptop</b><br>SHA256:9c2b…e81f</p><p>If you believe this key was added in error, you can remove the key and disable access at the following location: <a href="https://github.com/settings/keys">https://github.com/settings/keys</a>.</p><p>Thanks,<br>The GitHub Team</p></div>`
  },
  {
    acc: 'a1',
    from: ['王小明', 'xiaoming@example.com'],
    subject: '周六聚餐时间确认',
    snippet: '周六晚上 6 点在老地方，记得带上上次说的那本书，大家都到齐了。',
    hours: 1.2,
    lang: 'zh',
    html: '<p>Moyer：</p><p>周六晚上 6 点在老地方，记得带上上次说的那本书。</p><p>小明</p>'
  },
  {
    acc: 'a3',
    from: ['田中 優子', 'yuko.tanaka@example.jp'],
    subject: '来週の打ち合わせについて',
    snippet: 'お世話になっております。来週の打ち合わせですが、水曜日の午後2時からでいかがでしょうか。',
    hours: 2.5,
    flagged: true,
    lang: 'ja',
    html: '<p>Moyer様</p><p>お世話になっております。田中です。</p><p>来週の打ち合わせですが、<b>水曜日の午後2時</b>からでいかがでしょうか。ご都合が悪ければ、別の候補日をいくつか教えていただけますと幸いです。</p><p>資料は前日までにお送りします。</p><p>よろしくお願いいたします。<br>田中 優子</p>'
  },
  {
    acc: 'a2',
    from: ['Lukas Becker', 'lukas.becker@example.de'],
    subject: 'Rechnung Nr. 2026-1043',
    snippet: 'Sehr geehrter Herr Zhang, anbei erhalten Sie die Rechnung für den Monat Oktober. Bitte überweisen Sie den Betrag…',
    hours: 5,
    att: true,
    lang: 'de',
    html: '<p>Sehr geehrter Herr Zhang,</p><p>anbei erhalten Sie die Rechnung für den Monat Oktober. Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf das unten genannte Konto.</p><p>Bei Fragen stehe ich Ihnen gerne zur Verfügung.</p><p>Mit freundlichen Grüßen<br>Lukas Becker</p>'
  },
  {
    acc: 'a1',
    from: ['QQ邮箱团队', '10000@qq.com'],
    subject: '你的 QQ 邮箱已开启 IMAP/SMTP 服务',
    snippet: '你好，你已成功开启 IMAP/SMTP 服务，可以在第三方客户端中使用授权码登录。',
    hours: 9,
    seen: true,
    lang: 'zh'
  },
  {
    acc: 'a3',
    from: ['Microsoft account team', 'account-security-noreply@accountprotection.microsoft.com'],
    subject: 'New app(s) connected to your Microsoft account',
    snippet: 'Moyer Mail connected to the Microsoft account mo**@outlook.com. If you didn’t grant this access, please remove the app…',
    hours: 20,
    seen: true,
    lang: 'en'
  },
  {
    acc: 'a2',
    from: ['김민지', 'minji.kim@example.kr'],
    subject: '자료 공유드립니다',
    snippet: '안녕하세요, 지난번 회의에서 말씀드린 자료를 첨부해 드립니다. 확인 부탁드립니다.',
    hours: 26,
    att: true,
    lang: 'ko'
  },
  {
    acc: 'a1',
    from: ['李华', 'lihua@example.com'],
    subject: '项目周报 第43周',
    snippet: '本周完成：登录模块重构、邮件同步性能优化；下周计划：安卓版原型。',
    hours: 30,
    seen: true,
    flagged: true,
    lang: 'zh'
  },
  {
    acc: 'a2',
    from: ['Notion', 'team@makenotion.com'],
    subject: 'Your weekly digest: 5 pages updated',
    snippet: 'Here’s what happened in your workspace this week. 5 pages were updated and 2 comments were added.',
    hours: 50,
    seen: true,
    lang: 'en'
  },
  {
    acc: 'a3',
    from: ['Amélie Durand', 'amelie.durand@example.fr'],
    subject: 'Merci pour votre aide !',
    snippet: 'Bonjour Moyer, je voulais vous remercier pour votre aide la semaine dernière. Tout fonctionne parfaitement maintenant.',
    hours: 70,
    seen: true,
    lang: 'fr'
  },
  { acc: 'a1', from: ['Moyer', 'moyer.demo@qq.com'], subject: '回复：报价单', snippet: '收到，我这边确认一下再回复你。', hours: 3, seen: true, role: 'sent', lang: 'zh' },
  { acc: 'a2', from: ['Promo', 'deals@spam.example'], subject: 'You won a FREE iPhone!!!', snippet: 'Click here to claim your prize now…', hours: 12, role: 'junk', lang: 'en' }
]

let nextId = 1
const messages: (MessageSummary & { html?: string; lang?: string })[] = seeds.map((s) => ({
  id: nextId++,
  accountId: s.acc,
  folder: roles.find(([r]) => r === (s.role ?? 'inbox'))![1],
  role: s.role ?? 'inbox',
  uid: nextId,
  messageId: `<demo${nextId}@example>`,
  subject: s.subject,
  from: { name: s.from[0], address: s.from[1] },
  to: [{ name: 'Moyer', address: accounts.find((a) => a.id === s.acc)!.email }],
  cc: [],
  date: now - s.hours * H,
  seen: !!s.seen,
  flagged: !!s.flagged,
  answered: false,
  hasAttachments: !!s.att,
  snippet: s.snippet,
  size: 12000,
  html: s.html,
  lang: s.lang
}))

let settings: Settings = {
  theme: 'light',
  palette: 'mist',
  orbs: true,
  density: 'comfortable',
  threading: false,
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

function matches(m: MessageSummary, v: ViewKey) {
  if (v.kind === 'unified') {
    if (v.box === 'snoozed') return !!m.snoozeUntil
    if (m.snoozeUntil) return false
    if (v.box === 'inbox') return m.role === 'inbox'
    if (v.box === 'unread') return m.role === 'inbox' && !m.seen
    if (v.box === 'flagged') return m.flagged
    if (v.box === 'all') return m.role !== 'trash' && m.role !== 'junk'
    return m.role === v.box
  }
  if (v.kind === 'account') return m.accountId === v.accountId && m.role === 'inbox'
  return m.accountId === v.accountId && m.folder === v.path
}

function counts(): Counts {
  const unread = messages.filter((m) => m.role === 'inbox' && !m.seen)
  const folderCounts: Record<string, number> = {}
  const acc: Record<string, number> = {}
  for (const m of messages.filter((x) => !x.seen)) {
    folderCounts[`${m.accountId}\n${m.folder}`] = (folderCounts[`${m.accountId}\n${m.folder}`] ?? 0) + 1
    if (m.role === 'inbox') acc[m.accountId] = (acc[m.accountId] ?? 0) + 1
  }
  return {
    unified: {
      inbox: unread.length,
      unread: unread.length,
      flagged: messages.filter((m) => m.flagged).length,
      snoozed: messages.filter((m) => m.snoozeUntil).length,
      sent: 0,
      drafts: 0,
      trash: 0,
      junk: messages.filter((m) => m.role === 'junk' && !m.seen).length,
      all: 0
    },
    folders: folderCounts,
    accounts: acc
  }
}

const FAKE_TR: Record<string, string> = {
  'Hey Moyer!': '嗨，Moyer！',
  'A new SSH key was added': '新增了一个 SSH 密钥'
}

// 演示模式不模拟网络延迟（后台标签页里定时器会被浏览器节流）
async function delay<T>(v: T, _ms = 60): Promise<T> {
  await Promise.resolve()
  return v
}

export function createMockApi(): MailApi {
  return {
    listAccounts: () => delay(accounts),
    testAccount: () => delay({ ok: true }, 600),
    saveAccount: async (d) => delay({ ...accounts[0], ...d, id: d.id ?? 'new' } as AccountConfig),
    removeAccount: () => delay(undefined),
    reorderAccounts: () => delay(undefined),
    oauthLogin: () => delay({ handle: 'h', email: 'demo@outlook.com' }, 800),
    listFolders: () => delay(folders),
    listMessages: async (q) => {
      let items = messages.filter((m) => matches(m, q.view))
      if (q.unreadOnly) items = items.filter((m) => !m.seen)
      if (q.search) {
        const s = q.search.toLowerCase()
        items = messages.filter((m) => `${m.subject} ${m.from?.name} ${m.from?.address} ${m.snippet}`.toLowerCase().includes(s))
      }
      items.sort((a, b) => b.date - a.date)
      const off = q.offset ?? 0
      return delay({ items: items.slice(off, off + (q.limit ?? 100)), total: items.length }, 20)
    },
    getMessage: async (id) => {
      const m = messages.find((x) => x.id === id)!
      const d: MessageDetail = {
        ...m,
        replyTo: [],
        bcc: [],
        inReplyTo: null,
        references: null,
        html: m.html ?? null,
        text: m.html ? null : `${m.snippet}\n\n这是演示数据。连接真实邮箱后，这里会显示完整的邮件正文。`,
        attachments: m.hasAttachments ? [{ index: 0, filename: 'Rechnung-2026-1043.pdf', contentType: 'application/pdf', size: 184_320, inline: false }] : [],
        lang: m.lang ?? null,
        remoteImages: true
      }
      return delay(d, 30)
    },
    getCounts: () => delay(counts()),
    getSyncStatus: () => delay(accounts.map((a) => ({ accountId: a.id, phase: 'idle' as const, lastSync: now }))),
    setFlags: async (ids, f) => {
      for (const m of messages) if (ids.includes(m.id)) Object.assign(m, f.seen !== undefined ? { seen: f.seen } : {}, f.flagged !== undefined ? { flagged: f.flagged } : {})
      emit('counts', counts())
    },
    moveMessages: async (ids, target) => {
      for (const m of messages) {
        if (!ids.includes(m.id)) continue
        const role = typeof target === 'object' ? 'other' : target
        m.role = role
        m.folder = roles.find(([r]) => r === role)?.[1] ?? m.folder
      }
      emit('counts', counts())
    },
    deleteForever: () => delay(undefined),
    markAllRead: async () => {
      for (const m of messages) if (m.role === 'inbox') m.seen = true
      emit('counts', counts())
      return 1
    },
    searchServer: () => delay(0),
    getThread: async (id) => messages.filter((m) => m.id === id),
    snooze: async (ids, until) => {
      for (const m of messages) if (ids.includes(m.id)) m.snoozeUntil = until
      emit('counts', counts())
    },
    listRules: () => delay([]),
    saveRule: async (r) => r,
    removeRule: () => delay(undefined),
    runRules: () => delay(0),
    scheduleSend: () => delay(undefined),
    listScheduled: () => delay([]),
    cancelScheduled: () => Promise.reject(new Error('演示模式不支持')),
    sendScheduledNow: () => delay(undefined),
    syncNow: () => delay(undefined, 700),
    openFolder: () => delay(undefined),
    loadOlder: () => delay(0),
    openAttachment: () => delay(undefined),
    saveAttachment: () => delay(true),
    pickFiles: () => delay([]),
    send: () => delay(undefined, 900),
    suggestContacts: async (q) =>
      delay(
        [
          { name: '王小明', address: 'xiaoming@example.com' },
          { name: 'Lukas Becker', address: 'lukas.becker@example.de' },
          { name: '田中 優子', address: 'yuko.tanaka@example.jp' }
        ].filter((c) => `${c.name}${c.address}`.toLowerCase().includes(q.toLowerCase()))
      ),
    translate: async (req) => delay({ texts: req.texts.map((t) => FAKE_TR[t] ?? `【译】${t}`), detected: 'en' }, 300),
    getSettings: () => delay(settings),
    setSettings: async (p) => {
      settings = { ...settings, ...p } as Settings
      return settings
    },
    testProxy: () => delay({ ok: true }, 500),
    openExternal: async (url) => void window.open(url, '_blank'),
    setWindowTheme: () => delay(undefined),
    appInfo: () => delay({ version: '0.1.0', dataDir: '（演示模式）', platform: 'web' })
  }
}

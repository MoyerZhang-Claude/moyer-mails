// 界面层与引擎层共用的数据类型。安卓版也复用这一份。

export type AuthType = 'password' | 'oauth-microsoft' | 'oauth-google'

export interface ServerConfig {
  host: string
  port: number
  /** true = 直接 TLS（993/465）；false = STARTTLS（143/587） */
  secure: boolean
}

export interface Address {
  name?: string
  address: string
}

export interface AccountConfig {
  id: string
  email: string
  /** 发信时显示的名字 */
  name: string
  /** 侧栏里显示的名字，可以自定义，比如“QQ 工作号” */
  label: string
  provider: string
  color: string
  authType: AuthType
  username: string
  imap: ServerConfig
  smtp: ServerConfig
  useProxy: boolean
  /** 发信后是否把副本上传到“已发送”文件夹（有的服务商会自动保存） */
  appendSent: boolean
  signature: string
  enabled: boolean
  createdAt: number
  sortOrder: number
}

/** 添加/修改账号时界面提交的数据 */
export interface AccountDraft {
  id?: string
  email: string
  name: string
  label?: string
  provider: string
  color?: string
  authType: AuthType
  username?: string
  imap: ServerConfig
  smtp: ServerConfig
  useProxy: boolean
  appendSent: boolean
  signature?: string
  /** 密码 / 授权码；修改账号时留空表示不变 */
  password?: string
  /** OAuth 登录后拿到的临时凭据编号 */
  oauthHandle?: string
}

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged' | 'other'

export interface FolderInfo {
  accountId: string
  path: string
  name: string
  delimiter: string
  role: FolderRole
  parentPath: string
  noSelect: boolean
  unread: number
  total: number
}

export interface MessageSummary {
  id: number
  accountId: string
  folder: string
  role: FolderRole
  uid: number
  messageId: string | null
  subject: string
  from: Address | null
  to: Address[]
  cc: Address[]
  date: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  snippet: string
  size: number
  /** 稍后提醒的时间（毫秒） */
  snoozeUntil?: number | null
  /** 会话模式：会话里的邮件数（含已发送） */
  threadCount?: number
  /** 会话模式：当前视图里属于这个会话的全部邮件编号，操作时一起处理 */
  threadIds?: number[]
}

export interface AttachmentInfo {
  index: number
  filename: string
  contentType: string
  size: number
  inline: boolean
  cid?: string
  /** IMAP 部件编号（大邮件按需下载时使用） */
  part?: string
}

export interface MessageDetail extends MessageSummary {
  replyTo: Address[]
  bcc: Address[]
  inReplyTo: string | null
  references: string | null
  html: string | null
  text: string | null
  attachments: AttachmentInfo[]
  /** 本地粗略识别的语言代码，如 en / ja / zh */
  lang: string | null
  remoteImages: boolean
}

export type UnifiedBox = 'inbox' | 'unread' | 'flagged' | 'snoozed' | 'sent' | 'drafts' | 'trash' | 'junk' | 'all'

export type ViewKey =
  | { kind: 'unified'; box: UnifiedBox }
  | { kind: 'account'; accountId: string; box: 'inbox' }
  | { kind: 'folder'; accountId: string; path: string }

export interface ListQuery {
  view: ViewKey
  search?: string
  unreadOnly?: boolean
  /** 按会话分组 */
  threads?: boolean
  offset?: number
  limit?: number
}

export interface ListResult {
  items: MessageSummary[]
  total: number
}

export interface Counts {
  unified: Record<UnifiedBox, number>
  /** key = accountId + '\n' + path */
  folders: Record<string, number>
  accounts: Record<string, number>
}

export interface OutgoingAttachment {
  filename: string
  path?: string
  contentType?: string
  size?: number
  /** 转发时引用原邮件里的附件 */
  fromMessage?: { id: number; index: number }
}

export interface DraftInput {
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  text: string
  attachments: OutgoingAttachment[]
  inReplyTo?: string | null
  references?: string | null
  /** 回复的本地邮件编号，发送成功后标记“已回复” */
  replyToLocalId?: number | null
}

export type ThemeMode = 'light' | 'dark' | 'system'
export type TranslateProvider = 'google' | 'azure' | 'llm' | 'deepl'
export type ProxyMode = 'off' | 'system' | 'custom'

export interface Settings {
  theme: ThemeMode
  palette: string
  orbs: boolean
  density: 'comfortable' | 'compact'
  /** 按会话（主题）分组显示 */
  threading: boolean
  loadRemoteImages: boolean
  markReadOnOpen: boolean
  notifications: boolean
  /** 仅安卓：退到后台后保持收信（常驻通知） */
  backgroundSync?: boolean
  closeToTray: boolean
  launchAtLogin: boolean
  syncIntervalMin: number
  proxy: { mode: ProxyMode; url: string }
  translate: {
    provider: TranslateProvider
    targetLang: string
    autoTranslate: boolean
    /** 在邮件列表里显示外语标题的译文 */
    listSubjects: boolean
    /** replace = 译文替换原文；bilingual = 原文下方显示译文 */
    display: 'replace' | 'bilingual'
    llm: { baseUrl: string; apiKey: string; model: string }
    deepl: { apiKey: string }
    azure: { key: string; region: string }
  }
  oauth: {
    microsoftClientId: string
    googleClientId: string
    googleClientSecret: string
  }
}

export type SyncPhase = 'idle' | 'connecting' | 'syncing' | 'error' | 'offline'

export interface SyncStatus {
  accountId: string
  phase: SyncPhase
  error?: string
  lastSync?: number
}

export interface TranslateRequest {
  texts: string[]
  to: string
  from?: string
  /** html = 片段里有标签，需要保留 */
  format?: 'text' | 'html'
}

export interface TranslateResult {
  texts: string[]
  detected?: string
}

export interface TestResult {
  ok: boolean
  imap?: string
  smtp?: string
  error?: string
}

export interface OAuthResult {
  handle: string
  email: string
  name?: string
}

export interface PickedFile {
  path: string
  filename: string
  size: number
}

// ---------------- 收信规则 ----------------
export type RuleField = 'from' | 'to' | 'subject'
export type RuleOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith'

export interface RuleCondition {
  field: RuleField
  op: RuleOp
  value: string
}

export interface RuleActions {
  markRead?: boolean
  flag?: boolean
  move?: 'archive' | 'trash' | 'junk' | null
  /** 不弹新邮件通知 */
  silent?: boolean
}

export interface Rule {
  id: string
  name: string
  enabled: boolean
  /** null = 所有账号 */
  accountId: string | null
  match: 'all' | 'any'
  conditions: RuleCondition[]
  actions: RuleActions
}

// ---------------- 定时发送 ----------------
export interface ScheduledItem {
  id: number
  accountId: string
  subject: string
  to: Address[]
  sendAt: number
  status: 'pending' | 'failed'
  error: string | null
}

/** 引擎推送给界面的事件 */
export interface EngineEvents {
  'accounts-changed': AccountConfig[]
  'folders-changed': { accountId: string }
  'messages-changed': { accountId: string; folders: string[] }
  'sync-status': SyncStatus
  'counts': Counts
  'open-message': { id: number }
  'compose': { to?: string }
  'settings-changed': Settings
  'scheduled-changed': { count: number }
  'toast': { text: string; kind: 'info' | 'ok' | 'error' }
}

export type EngineEventName = keyof EngineEvents

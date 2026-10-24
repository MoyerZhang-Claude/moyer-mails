import type {
  AccountConfig,
  AccountDraft,
  Address,
  Counts,
  DraftInput,
  FolderInfo,
  ListQuery,
  ListResult,
  MessageDetail,
  MessageSummary,
  OAuthResult,
  Rule,
  ScheduledItem,
  PickedFile,
  Settings,
  SyncStatus,
  TestResult,
  TranslateRequest,
  TranslateResult,
  ViewKey
} from './types'

/**
 * 界面调用引擎的全部接口。桌面版走 Electron IPC，安卓版将来换成别的通道，
 * 界面代码不需要改。
 */
export interface MailApi {
  // 账号
  listAccounts(): Promise<AccountConfig[]>
  testAccount(draft: AccountDraft): Promise<TestResult>
  saveAccount(draft: AccountDraft): Promise<AccountConfig>
  removeAccount(id: string): Promise<void>
  reorderAccounts(ids: string[]): Promise<void>
  oauthLogin(provider: 'microsoft' | 'google', loginHint?: string): Promise<OAuthResult>

  // 文件夹与邮件
  listFolders(): Promise<FolderInfo[]>
  listMessages(query: ListQuery): Promise<ListResult>
  getMessage(id: number): Promise<MessageDetail>
  getCounts(): Promise<Counts>
  getSyncStatus(): Promise<SyncStatus[]>
  setFlags(ids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  moveMessages(ids: number[], target: 'trash' | 'archive' | 'junk' | 'inbox' | { path: string }): Promise<void>
  deleteForever(ids: number[]): Promise<void>
  syncNow(accountId?: string): Promise<void>
  openFolder(accountId: string, path: string): Promise<void>
  loadOlder(view: ViewKey): Promise<number>
  /** 把视图里所有未读（包括服务器上没缓存的）标为已读，返回处理的文件夹数 */
  markAllRead(view: ViewKey): Promise<number>
  /** 在服务器上搜索（找本地没缓存的旧邮件），返回新找到的数量 */
  searchServer(query: string, view: ViewKey): Promise<number>
  /** 会话里的全部邮件，按时间从旧到新 */
  getThread(id: number): Promise<MessageSummary[]>
  /** 稍后提醒；until 为 null 表示取消 */
  snooze(ids: number[], until: number | null): Promise<void>

  // 收信规则
  listRules(): Promise<Rule[]>
  saveRule(rule: Rule): Promise<Rule>
  removeRule(id: string): Promise<void>
  /** 对收件箱里已有的邮件运行一次规则，返回命中的邮件数 */
  runRules(ruleId?: string): Promise<number>

  // 定时发送
  scheduleSend(draft: DraftInput, sendAt: number): Promise<void>
  listScheduled(): Promise<ScheduledItem[]>
  /** 取消定时，返回原草稿以便继续编辑 */
  cancelScheduled(id: number): Promise<DraftInput>
  sendScheduledNow(id: number): Promise<void>

  // 附件
  openAttachment(messageId: number, index: number): Promise<void>
  saveAttachment(messageId: number, index: number): Promise<boolean>
  pickFiles(): Promise<PickedFile[]>

  // 写信
  send(draft: DraftInput): Promise<void>
  suggestContacts(query: string): Promise<Address[]>

  // 翻译
  translate(req: TranslateRequest): Promise<TranslateResult>

  // 设置
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  testProxy(): Promise<TestResult>

  // 其他
  openExternal(url: string): Promise<void>
  setWindowTheme(dark: boolean, color: string): Promise<void>
  appInfo(): Promise<{ version: string; dataDir: string; platform: string }>
}

export type MailApiMethod = keyof MailApi

/** 允许界面调用的方法白名单（主进程据此校验） */
export const API_METHODS: readonly MailApiMethod[] = [
  'listAccounts',
  'testAccount',
  'saveAccount',
  'removeAccount',
  'reorderAccounts',
  'oauthLogin',
  'listFolders',
  'listMessages',
  'getMessage',
  'getCounts',
  'getSyncStatus',
  'setFlags',
  'moveMessages',
  'deleteForever',
  'syncNow',
  'openFolder',
  'loadOlder',
  'markAllRead',
  'searchServer',
  'getThread',
  'snooze',
  'listRules',
  'saveRule',
  'removeRule',
  'runRules',
  'scheduleSend',
  'listScheduled',
  'cancelScheduled',
  'sendScheduledNow',
  'openAttachment',
  'saveAttachment',
  'pickFiles',
  'send',
  'suggestContacts',
  'translate',
  'getSettings',
  'setSettings',
  'testProxy',
  'openExternal',
  'setWindowTheme',
  'appInfo'
] as const

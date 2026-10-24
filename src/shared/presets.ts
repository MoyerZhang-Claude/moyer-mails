import type { AuthType, ServerConfig } from './types'

export interface ProviderPreset {
  id: string
  name: string
  short: string
  color: string
  domains: string[]
  imap: ServerConfig
  smtp: ServerConfig
  /** 第一个是推荐的登录方式 */
  auth: AuthType[]
  passwordLabel: string
  help: string
  helpUrl?: string
  useProxy: boolean
  appendSent: boolean
}

const ssl = (host: string, port = 993): ServerConfig => ({ host, port, secure: true })
const starttls = (host: string, port = 587): ServerConfig => ({ host, port, secure: false })

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'qq',
    name: 'QQ 邮箱',
    short: 'QQ',
    color: '#1e88e5',
    domains: ['qq.com', 'foxmail.com', 'vip.qq.com'],
    imap: ssl('imap.qq.com'),
    smtp: ssl('smtp.qq.com', 465),
    auth: ['password'],
    passwordLabel: '授权码',
    help: '在 QQ 邮箱网页版打开 设置 → 账号与安全（或“账号”页）→ 开启“IMAP/SMTP 服务”，按提示生成 16 位授权码，填在这里。注意不是 QQ 密码。',
    helpUrl: 'https://mail.qq.com',
    useProxy: false,
    appendSent: false
  },
  {
    id: 'gmail',
    name: 'Gmail',
    short: 'G',
    color: '#ea4335',
    domains: ['gmail.com', 'googlemail.com'],
    imap: ssl('imap.gmail.com'),
    smtp: ssl('smtp.gmail.com', 465),
    auth: ['password', 'oauth-google'],
    passwordLabel: '应用专用密码',
    help: '先在 Google 账号里开启两步验证，然后打开“应用专用密码”页面生成一个 16 位密码填在这里（不是 Google 登录密码）。中国大陆网络需要在 设置 → 网络 里配置代理。',
    helpUrl: 'https://myaccount.google.com/apppasswords',
    useProxy: true,
    appendSent: false
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail',
    short: 'O',
    color: '#0a64c8',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.com.cn', 'live.cn', 'hotmail.co.uk', 'outlook.jp'],
    imap: ssl('outlook.office365.com'),
    smtp: starttls('smtp-mail.outlook.com'),
    auth: ['oauth-microsoft', 'password'],
    passwordLabel: '密码',
    help: '微软已停止 Outlook 的密码登录，请使用“用微软账号登录”。第一次使用前需要在 设置 → 账号登录 填写微软应用 ID（只需配置一次）。',
    helpUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    useProxy: false,
    appendSent: false
  },
  {
    id: '163',
    name: '网易 163',
    short: '163',
    color: '#d6261c',
    domains: ['163.com'],
    imap: ssl('imap.163.com'),
    smtp: ssl('smtp.163.com', 465),
    auth: ['password'],
    passwordLabel: '授权码',
    help: '在 163 邮箱网页版打开 设置 → POP3/SMTP/IMAP → 开启“IMAP/SMTP 服务”，按提示获取授权码填在这里。',
    helpUrl: 'https://mail.163.com',
    useProxy: false,
    appendSent: true
  },
  {
    id: '126',
    name: '网易 126',
    short: '126',
    color: '#2e7d32',
    domains: ['126.com'],
    imap: ssl('imap.126.com'),
    smtp: ssl('smtp.126.com', 465),
    auth: ['password'],
    passwordLabel: '授权码',
    help: '在 126 邮箱网页版打开 设置 → POP3/SMTP/IMAP → 开启“IMAP/SMTP 服务”，按提示获取授权码填在这里。',
    useProxy: false,
    appendSent: true
  },
  {
    id: 'yeah',
    name: '网易 yeah.net',
    short: 'Y',
    color: '#00897b',
    domains: ['yeah.net'],
    imap: ssl('imap.yeah.net'),
    smtp: ssl('smtp.yeah.net', 465),
    auth: ['password'],
    passwordLabel: '授权码',
    help: '在网页版 设置 → POP3/SMTP/IMAP 里开启服务并获取授权码。',
    useProxy: false,
    appendSent: true
  },
  {
    id: 'exmail',
    name: '腾讯企业邮',
    short: '企',
    color: '#1565c0',
    domains: [],
    imap: ssl('imap.exmail.qq.com'),
    smtp: ssl('smtp.exmail.qq.com', 465),
    auth: ['password'],
    passwordLabel: '密码 / 客户端专用密码',
    help: '如果开启了微信安全登录，需要在企业邮网页版 设置 → 账户 里生成“客户端专用密码”。',
    useProxy: false,
    appendSent: false
  },
  {
    id: 'icloud',
    name: 'iCloud',
    short: 'i',
    color: '#555555',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: ssl('imap.mail.me.com'),
    smtp: starttls('smtp.mail.me.com'),
    auth: ['password'],
    passwordLabel: 'App 专用密码',
    help: '在 account.apple.com → 登录与安全 → App 专用密码 里生成一个密码填在这里。',
    helpUrl: 'https://account.apple.com/account/manage',
    useProxy: false,
    appendSent: true
  },
  {
    id: 'yahoo',
    name: 'Yahoo',
    short: 'Y!',
    color: '#6001d2',
    domains: ['yahoo.com', 'yahoo.co.jp', 'ymail.com'],
    imap: ssl('imap.mail.yahoo.com'),
    smtp: ssl('smtp.mail.yahoo.com', 465),
    auth: ['password'],
    passwordLabel: '应用密码',
    help: '在 Yahoo 账号安全设置里生成“应用密码”填在这里。',
    useProxy: true,
    appendSent: true
  },
  {
    id: 'sina',
    name: '新浪邮箱',
    short: '新',
    color: '#e53935',
    domains: ['sina.com', 'sina.cn', 'vip.sina.com'],
    imap: ssl('imap.sina.com'),
    smtp: ssl('smtp.sina.com', 465),
    auth: ['password'],
    passwordLabel: '授权码',
    help: '在新浪邮箱网页版 设置 → 客户端 pop/imap/smtp 里开启服务并获取授权码。',
    useProxy: false,
    appendSent: true
  },
  {
    id: 'aliyun',
    name: '阿里邮箱',
    short: '阿',
    color: '#ff6a00',
    domains: ['aliyun.com'],
    imap: ssl('imap.aliyun.com'),
    smtp: ssl('smtp.aliyun.com', 465),
    auth: ['password'],
    passwordLabel: '密码',
    help: '在阿里邮箱网页版 设置 → 账户与安全 里确认已开启 IMAP/SMTP。',
    useProxy: false,
    appendSent: true
  },
  {
    id: '139',
    name: '139 邮箱',
    short: '139',
    color: '#0091ea',
    domains: ['139.com'],
    imap: ssl('imap.139.com'),
    smtp: ssl('smtp.139.com', 465),
    auth: ['password'],
    passwordLabel: '授权码',
    help: '在 139 邮箱网页版 设置 → 客户端设置 里开启 IMAP/SMTP 并获取授权码。',
    useProxy: false,
    appendSent: true
  },
  {
    id: 'sohu',
    name: '搜狐邮箱',
    short: '搜',
    color: '#ffb300',
    domains: ['sohu.com'],
    imap: ssl('imap.sohu.com'),
    smtp: ssl('smtp.sohu.com', 465),
    auth: ['password'],
    passwordLabel: '独立密码 / 授权码',
    help: '在搜狐邮箱网页版 选项 → 设置 → POP3/SMTP/IMAP 里开启服务。',
    useProxy: false,
    appendSent: true
  },
  {
    id: 'yandex',
    name: 'Yandex',
    short: 'Я',
    color: '#fc3f1d',
    domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
    imap: ssl('imap.yandex.com'),
    smtp: ssl('smtp.yandex.com', 465),
    auth: ['password'],
    passwordLabel: '应用密码',
    help: '在 Yandex ID → 安全 → 应用密码 里生成邮件专用密码。',
    useProxy: true,
    appendSent: true
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    short: 'Z',
    color: '#e42527',
    domains: ['zoho.com', 'zohomail.com'],
    imap: ssl('imap.zoho.com'),
    smtp: ssl('smtp.zoho.com', 465),
    auth: ['password'],
    passwordLabel: '应用专用密码',
    help: '在 Zoho 账号 → 安全 → 应用专用密码 里生成密码，并在邮箱设置里启用 IMAP。',
    useProxy: true,
    appendSent: true
  },
  {
    id: 'custom',
    name: '其他邮箱',
    short: '@',
    color: '#607d8b',
    domains: [],
    imap: ssl(''),
    smtp: ssl('', 465),
    auth: ['password'],
    passwordLabel: '密码 / 授权码',
    help: '手动填写 IMAP 和 SMTP 服务器。大多数邮箱的服务器是 imap.域名 和 smtp.域名，端口 993 / 465。',
    useProxy: false,
    appendSent: true
  }
]

export function findPreset(id: string): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
}

export function detectPreset(email: string): ProviderPreset | null {
  const domain = email.split('@')[1]?.trim().toLowerCase()
  if (!domain) return null
  return PROVIDERS.find((p) => p.domains.includes(domain)) ?? null
}

/** 账号颜色候选 */
export const ACCOUNT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#64748b']

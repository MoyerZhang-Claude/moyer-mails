import type { Address, FolderInfo, FolderRole } from '@shared/types'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n: number) {
  return n < 10 ? '0' + n : String(n)
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 列表里的短时间 */
export function shortTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const day = startOfDay(d)
  const today = startOfDay(now)
  if (day === today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (day === today - 86_400_000) return '昨天'
  if (today - day < 6 * 86_400_000) return WEEK[d.getDay()]
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 阅读区的完整时间 */
export function fullTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function displayName(a: Address | null | undefined): string {
  if (!a) return '（未知）'
  return a.name?.trim() || a.address.split('@')[0] || a.address
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

const AVATAR_COLORS = ['#5b8def', '#e86a6a', '#3fb27f', '#e9a23b', '#9b6bea', '#e56ba5', '#2fb3b3', '#ef7f45', '#6c7ae0', '#7a8a9a']

export function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

export function initial(a: Address | null | undefined): string {
  const name = displayName(a).replace(/^["'\s]+/, '')
  const ch = [...name][0] ?? '?'
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch
}

export const ROLE_NAMES: Record<FolderRole, string> = {
  inbox: '收件箱',
  sent: '已发送',
  drafts: '草稿',
  trash: '已删除',
  junk: '垃圾邮件',
  archive: '归档',
  all: '所有邮件',
  flagged: '星标邮件',
  other: ''
}

export function folderName(f: FolderInfo): string {
  return ROLE_NAMES[f.role] || f.name
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 纯文本邮件转成 HTML：段落、换行、链接、引用 */
export function textToHtml(text: string): string {
  const linkify = (s: string) => s.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1">$1</a>')
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n')
      if (lines.every((l) => l.startsWith('>'))) {
        const inner = lines.map((l) => l.replace(/^>\s?/, '')).join('\n')
        return `<blockquote>${textToHtml(inner)}</blockquote>`
      }
      return `<p>${lines.map((l) => linkify(escapeHtml(l))).join('<br>')}</p>`
    })
    .join('')
}

export function parseAddressInput(raw: string): Address | null {
  const s = raw.trim().replace(/[,;，；]+$/, '')
  if (!s) return null
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || undefined, address: m[2].trim() }
  return { address: s }
}

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined
  return ((...args: any[]) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }) as T
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

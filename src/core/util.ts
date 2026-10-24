import { randomBytes } from 'node:crypto'
import type { Address } from '@shared/types'

export function uid(len = 12): string {
  return randomBytes(len).toString('base64url').slice(0, len)
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 让出事件循环，避免长任务卡住界面请求 */
export function yieldLoop() {
  return new Promise((r) => setImmediate(r))
}

export function toAddress(a: { name?: string; address?: string } | undefined | null): Address | null {
  if (!a) return null
  if (!a.address && !a.name) return null
  return { name: a.name || undefined, address: a.address ?? '' }
}

export function toAddresses(list: { name?: string; address?: string }[] | undefined | null): Address[] {
  return (list ?? []).map(toAddress).filter((a): a is Address => !!a && !!a.address)
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

/** 把 HTML 粗略转成纯文本（用于摘要和搜索） */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/[ \t ​‌‍﻿]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

export function makeSnippet(text: string): string {
  return text
    .replace(/^>.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** 把底层错误翻译成用户看得懂的中文 */
export function friendlyError(err: unknown): string {
  const e = err as { message?: string; code?: string; responseText?: string; response?: string; authenticationFailed?: boolean; serverResponseCode?: string }
  const raw = [e?.responseText, e?.response, e?.message, e?.code].filter(Boolean).join(' | ')
  const msg = raw.toLowerCase()
  if (msg.includes('unsafe login')) return '网易邮箱拒绝了登录（Unsafe Login）。请确认填写的是授权码，而不是登录密码。'
  if (msg.includes('application-specific password') || msg.includes('app password') || msg.includes('534-5.7.9'))
    return 'Gmail 需要使用“应用专用密码”登录（需先开启两步验证）。'
  if (msg.includes('basicauthblocked') || msg.includes('basic authentication is disabled'))
    return '微软已禁用这个账号的密码登录，请改用“用微软账号登录”。'
  if (e?.authenticationFailed || msg.includes('authenticationfailed') || msg.includes('invalid credentials') || msg.includes('authentication failed') || msg.includes('login fail') || msg.includes('535') || msg.includes('auth') && msg.includes('fail'))
    return '登录失败：授权码/密码不正确，或这个邮箱还没有开启 IMAP/SMTP 服务。'
  if (msg.includes('enotfound') || msg.includes('getaddrinfo')) return '找不到服务器，请检查服务器地址或网络连接。'
  if (msg.includes('etimedout') || msg.includes('connect_timeout') || msg.includes('timeout'))
    return '连接超时。如果是 Gmail 等境外邮箱，请在 设置 → 网络 里配置代理。'
  if (msg.includes('econnrefused')) return '服务器拒绝连接，请检查端口和加密方式。'
  if (msg.includes('econnreset') || msg.includes('socket hang up') || msg.includes('connection closed')) return '连接被中断，稍后会自动重试。'
  if (msg.includes('certificate') || msg.includes('self signed') || msg.includes('cert_')) return '服务器证书校验失败。'
  if (msg.includes('proxy') || msg.includes('socks')) return '代理连接失败，请检查代理地址是否正确、代理软件是否在运行。'
  if (msg.includes('too many') || msg.includes('limit')) return '服务器提示操作太频繁，请稍后再试。'
  return raw ? `出错了：${raw.slice(0, 300)}` : '未知错误'
}

export class UserError extends Error {}

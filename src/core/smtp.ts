import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import * as socks from 'socks'
import type { AccountConfig, Address } from '@shared/types'

export interface SmtpAuth {
  user: string
  pass?: string
  accessToken?: string
}

export interface ComposeInput {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  text: string
  inReplyTo?: string | null
  references?: string | null
  attachments: { filename: string; path?: string; content?: Buffer; contentType?: string }[]
  messageId: string
  date: Date
}

function fmt(list: Address[]) {
  return list.map((a) => (a.name ? { name: a.name, address: a.address } : a.address))
}

/** 生成 RFC822 原文。keepBcc=true 用于保存到“已发送” */
export async function buildRaw(input: ComposeInput, keepBcc: boolean): Promise<Buffer> {
  const composer = new MailComposer({
    from: input.from.name ? { name: input.from.name, address: input.from.address } : input.from.address,
    to: fmt(input.to),
    cc: fmt(input.cc),
    bcc: fmt(input.bcc),
    subject: input.subject,
    html: input.html,
    text: input.text,
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references ?? undefined,
    attachments: input.attachments,
    messageId: input.messageId,
    date: input.date,
    attachDataUrls: true,
    headers: { 'X-Mailer': 'Moyer Mail' }
  })
  const mime = composer.compile()
  ;(mime as unknown as { keepBcc: boolean }).keepBcc = keepBcc
  return mime.build()
}

function transportFor(account: AccountConfig, auth: SmtpAuth, proxy?: string) {
  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    requireTLS: !account.smtp.secure,
    name: '[127.0.0.1]',
    auth: auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass },
    proxy,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000
  } as Parameters<typeof nodemailer.createTransport>[0])
  if (proxy?.startsWith('socks')) transport.set('proxy_socks_module', socks)
  return transport
}

export async function sendRaw(account: AccountConfig, auth: SmtpAuth, proxy: string | undefined, raw: Buffer, envelope: { from: string; to: string[] }) {
  const transport = transportFor(account, auth, proxy)
  try {
    await transport.sendMail({ envelope, raw })
  } finally {
    transport.close()
  }
}

export async function verifySmtp(account: AccountConfig, auth: SmtpAuth, proxy?: string) {
  const transport = transportFor(account, auth, proxy)
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

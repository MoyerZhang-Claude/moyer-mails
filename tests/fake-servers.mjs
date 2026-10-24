// 本机假邮件服务器（开发调试用）：IMAP 127.0.0.1:1143、SMTP 127.0.0.1:1025
// 用户名 testuser，密码 testpass。运行：node tests/fake-servers.mjs
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')

const d = (h) => new Date(Date.now() - h * 3600_000)
// hoodiecrow 把 raw 当作“二进制字符串”，所以先转成 UTF-8 字节再交给它
const mail = (from, subject, html, extra = '') =>
  Buffer.from(`From: ${from}\r\nTo: Moyer <test@example.com>\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@example.com>\r\nMIME-Version: 1.0\r\n${extra}Content-Type: text/html; charset=utf-8\r\n\r\n${html}`, 'utf8').toString('binary')
const enc = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`

const inbox = [
  {
    raw: mail(
      '"GitHub" <noreply@github.com>',
      '[GitHub] A new SSH key was added to your account',
      `<div style="font-family:Arial;max-width:560px"><h2 style="color:#24292f">A new SSH key was added</h2><p>Hey Moyer!</p><p>The following SSH key was added to your account:</p><p style="background:#f6f8fa;padding:12px;border-radius:6px"><b>Laptop</b><br>SHA256:9c2b…e81f</p><p>If you believe this key was added in error, you can remove the key at <a href="https://github.com/settings/keys">https://github.com/settings/keys</a>.</p><p>Thanks,<br>The GitHub Team</p></div>`
    ),
    internaldate: d(0.4)
  },
  {
    raw: mail(`${enc('田中 優子')} <yuko@example.jp>`, enc('来週の打ち合わせについて'), '<p>Moyer様</p><p>お世話になっております。田中です。</p><p>来週の打ち合わせですが、<b>水曜日の午後2時</b>からでいかがでしょうか。ご都合が悪ければ、別の候補日を教えていただけますと幸いです。</p><p>よろしくお願いいたします。<br>田中 優子</p>'),
    flags: ['\\Flagged'],
    internaldate: d(2)
  },
  {
    raw: mail(`${enc('王小明')} <xiaoming@example.com>`, enc('周六聚餐时间确认'), '<p>Moyer：</p><p>周六晚上 6 点在老地方，记得带上上次说的那本书。</p><p>小明</p>'),
    internaldate: d(5)
  },
  {
    raw: mail('"Lukas Becker" <lukas@example.de>', 'Rechnung Nr. 2026-1043', '<p>Sehr geehrter Herr Zhang,</p><p>anbei erhalten Sie die Rechnung für den Monat Oktober. Bitte überweisen Sie den Betrag innerhalb von 14 Tagen.</p><p>Mit freundlichen Grüßen<br>Lukas Becker</p>'),
    flags: ['\\Seen'],
    internaldate: d(26)
  },
  {
    raw: mail(`${enc('김민지')} <minji@example.kr>`, enc('자료 공유드립니다'), '<p>안녕하세요, 지난번 회의에서 말씀드린 자료를 공유드립니다. 확인 부탁드립니다.</p>'),
    flags: ['\\Seen'],
    internaldate: d(50)
  }
]

const imap = hoodiecrow({
  plugins: ['STARTTLS', 'ID', 'IDLE', 'SPECIAL-USE', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'ENABLE', 'LITERALPLUS', 'UNSELECT'],
  storage: {
    INBOX: { messages: inbox },
    '': {
      separator: '/',
      folders: {
        Sent: { 'special-use': '\\Sent' },
        Drafts: { 'special-use': '\\Drafts' },
        Trash: { 'special-use': '\\Trash' },
        Archive: { 'special-use': '\\Archive' },
        Junk: { 'special-use': '\\Junk' }
      }
    }
  }
})
imap.listen(1143, '127.0.0.1', () => console.log('IMAP on 1143'))

const smtp = new SMTPServer({
  onAuth: (a, _s, cb) => (a.username === 'testuser' && a.password === 'testpass' ? cb(null, { user: 'testuser' }) : cb(new Error('Invalid credentials'))),
  onData(stream, _s, cb) {
    stream.resume()
    stream.on('end', () => {
      console.log('SMTP received a message')
      cb()
    })
  }
})
smtp.listen(1025, '127.0.0.1', () => console.log('SMTP on 1025'))

// 引擎端到端测试：在本机启动假的 IMAP（hoodiecrow）和 SMTP 服务器，
// 用真实的收发信引擎走一遍 添加账号 → 同步 → 读信 → 改旗标 → 删除 → 发信 → 搜索。
// 运行：npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// 测试服务器用的是自签名证书，只在这个测试进程里放行
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const require = createRequire(import.meta.url)
const hoodiecrow = require('hoodiecrow-imap')
const { SMTPServer } = require('smtp-server')
const { simpleParser } = require('mailparser')
const { Engine } = require('../out/core/engine.cjs')

const gbkSubject = '=?GBK?B?suLK1NPKvP4=?=' // “测试邮件” 的 GBK 编码
const attachmentMail = [
  'From: "Lukas Becker" <lukas@example.de>',
  'To: test@example.com',
  'Subject: Rechnung Nr. 2026-1043',
  'Message-ID: <inv1@example.de>',
  'Date: Thu, 22 Oct 2026 10:00:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Sehr geehrter Herr Zhang, anbei erhalten Sie die Rechnung.</p>',
  '--b1',
  'Content-Type: application/pdf; name="rechnung.pdf"',
  'Content-Disposition: attachment; filename="rechnung.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake pdf').toString('base64'),
  '--b1--',
  ''
].join('\r\n')

function storage() {
  return {
    INBOX: {
      messages: [
        { raw: `From: 王小明 <xm@example.com>\r\nTo: test@example.com\r\nSubject: ${gbkSubject}\r\nMessage-ID: <m1@example.com>\r\nContent-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xd5, 0xe2, 0xca, 0xc7, 0xb2, 0xe2, 0xca, 0xd4]).toString('base64')}\r\n`, flags: [], internaldate: '20-Oct-2026 08:00:00 +0800' },
        {
          // hoodiecrow 把 raw 当二进制字符串，非 ASCII 内容要先转成 UTF-8 字节
          raw: Buffer.from('From: GitHub <noreply@github.com>\r\nTo: test@example.com\r\nSubject: A new SSH key was added\r\nMessage-ID: <m2@github.com>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHey there! The following SSH key was added to your account. Viele Grüße', 'utf8').toString('binary'),
          flags: ['\\Seen'],
          internaldate: '21-Oct-2026 08:00:00 +0800'
        },
        { raw: attachmentMail, flags: ['\\Flagged'], internaldate: '22-Oct-2026 08:00:00 +0800' }
      ]
    },
    '': {
      separator: '/',
      folders: {
        Sent: { 'special-use': '\\Sent' },
        Trash: { 'special-use': '\\Trash' },
        Archive: { 'special-use': '\\Archive' },
        Junk: { 'special-use': '\\Junk' }
      }
    }
  }
}

let imap, smtp, engine, dataDir
const received = []
const events = []

function makeHost(dir) {
  return {
    dataDir: dir,
    appVersion: 'test',
    encrypt: (s) => Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s, 'base64').toString(),
    fetch: (url, init) => fetch(url, init),
    resolveSystemProxy: async () => 'DIRECT',
    openExternal: async () => {},
    openPath: async () => {},
    saveDialog: async () => null,
    pickFiles: async () => [],
    notify: (title, body) => events.push(['notify', title, body]),
    emit: (name, payload) => events.push([name, payload]),
    applySettings: () => {},
    log: () => {}
  }
}

async function waitFor(fn, ms = 15000, label = 'condition') {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

before(async () => {
  imap = hoodiecrow({
    plugins: ['STARTTLS', 'ID', 'IDLE', 'SPECIAL-USE', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'ENABLE', 'LITERALPLUS', 'UNSELECT'],
    storage: storage()
  })
  await new Promise((r) => imap.listen(0, '127.0.0.1', r))
  smtp = new SMTPServer({
    authOptional: false,
    onAuth(auth, _s, cb) {
      if (auth.username === 'testuser' && auth.password === 'testpass') cb(null, { user: 'testuser' })
      else cb(new Error('Invalid username or password'))
    },
    onData(stream, session, cb) {
      const chunks = []
      stream.on('data', (c) => chunks.push(c))
      stream.on('end', () => {
        received.push({ envelope: session.envelope, raw: Buffer.concat(chunks) })
        cb()
      })
    }
  })
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r))
  dataDir = mkdtempSync(join(tmpdir(), 'moyer-test-'))
  engine = new Engine(makeHost(dataDir))
  engine.start()
})

after(async () => {
  await engine?.shutdown()
  await new Promise((r) => setTimeout(r, 300))
  await new Promise((r) => imap.close(r))
  await new Promise((r) => smtp.close(r))
  engine?.db.raw.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const draft = () => ({
  email: 'test@example.com',
  name: '测试用户',
  provider: 'custom',
  authType: 'password',
  username: 'testuser',
  password: 'testpass',
  imap: { host: '127.0.0.1', port: imap.address().port, secure: false },
  smtp: { host: '127.0.0.1', port: smtp.server.address().port, secure: false },
  useProxy: false,
  appendSent: true
})

test('connection test rejects a wrong password with a friendly message', async () => {
  const r = await engine.testAccount({ ...draft(), password: 'wrong' })
  assert.equal(r.ok, false)
  assert.match(r.error, /登录失败|授权码|密码/)
})

test('connection test passes with correct credentials', async () => {
  const r = await engine.testAccount(draft())
  assert.equal(r.ok, true, JSON.stringify(r))
})

let accountId

function imapClient() {
  const { ImapFlow } = require('imapflow')
  return new ImapFlow({ host: '127.0.0.1', port: imap.address().port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
}

async function deliver(raw) {
  const c = imapClient()
  await c.connect()
  await c.append('INBOX', raw, [])
  await c.logout()
}

let sentMessageId
test('adding an account syncs folders and messages', async () => {
  const acc = await engine.saveAccount(draft())
  accountId = acc.id
  const res = await waitFor(async () => {
    const r = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' } })
    return r.total === 3 ? r : null
  }, 20000, 'initial sync')
  const subjects = res.items.map((m) => m.subject)
  assert.ok(subjects.includes('测试邮件'), `GBK subject decoded: ${subjects}`)
  const folders = await engine.listFolders()
  const roles = folders.map((f) => f.role).sort()
  assert.deepEqual(roles, ['archive', 'inbox', 'junk', 'sent', 'trash'])
  const counts = await engine.getCounts()
  assert.equal(counts.unified.inbox, 2, 'two unread in inbox')
  assert.equal(counts.unified.flagged, 1, 'one flagged')
})

test('reading a GBK plain-text mail decodes the body', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: '测试邮件' })
  assert.equal(items.length, 1)
  const d = await engine.getMessage(items[0].id)
  assert.equal(d.text.trim(), '你好，这是测试')
  assert.equal(d.lang, 'zh')
})

test('attachments are listed and retrievable; foreign language is detected', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'flagged' } })
  const d = await engine.getMessage(items[0].id)
  assert.equal(d.attachments.length, 1)
  assert.equal(d.attachments[0].filename, 'rechnung.pdf')
  assert.equal(d.lang, 'de')
  assert.match(d.html, /Rechnung/)
})

test('8-bit UTF-8 body with umlauts decodes correctly', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'SSH' })
  const d = await engine.getMessage(items[0].id)
  assert.match(d.text, /Viele Grüße/)
})

test('server search finds mail that is not cached locally', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'SSH' })
  // 模拟“本地没缓存的旧邮件”：只删本地记录
  engine.db.deleteMessage(items[0].id)
  assert.equal((await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'SSH' })).total, 0)
  const found = await engine.searchServer('SSH', { kind: 'unified', box: 'inbox' })
  assert.equal(found, 1)
  assert.equal((await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'SSH' })).total, 1)
})

test('marking read updates server and unread count', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'unread' } })
  assert.equal(items.length, 2)
  await engine.setFlags(items.map((m) => m.id), { seen: true })
  const counts = await engine.getCounts()
  assert.equal(counts.unified.inbox, 0)
  // 从服务器重新同步，确认旗标真的写到了服务器上
  await engine.syncNow(accountId)
  const after = await engine.listMessages({ view: { kind: 'unified', box: 'unread' } })
  assert.equal(after.total, 0)
})

test('deleting moves the message to Trash on the server', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'SSH' })
  assert.equal(items.length, 1)
  await engine.moveMessages([items[0].id], 'trash')
  const inbox = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' } })
  assert.equal(inbox.total, 2)
  const trash = await waitFor(async () => {
    const r = await engine.listMessages({ view: { kind: 'unified', box: 'trash' } })
    return r.total === 1 ? r : null
  }, 10000, 'trash sync')
  assert.equal(trash.items[0].subject, 'A new SSH key was added')
})

test('sending delivers via SMTP and saves a copy to Sent', async () => {
  const { items } = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'Rechnung' })
  const original = await engine.getMessage(items[0].id)
  await engine.send({
    accountId,
    to: [{ name: 'Lukas', address: 'lukas@example.de' }],
    cc: [],
    bcc: [{ address: 'secret@example.com' }],
    subject: 'Re: Rechnung Nr. 2026-1043',
    html: '<p>Danke! Ich überweise heute.</p>',
    text: 'Danke! Ich überweise heute.',
    attachments: [{ filename: 'rechnung.pdf', fromMessage: { id: original.id, index: 0 } }],
    inReplyTo: original.messageId,
    references: original.messageId,
    replyToLocalId: original.id
  })
  assert.equal(received.length, 1)
  const env = received[0].envelope
  assert.deepEqual(env.rcptTo.map((r) => r.address).sort(), ['lukas@example.de', 'secret@example.com'])
  const parsed = await simpleParser(received[0].raw)
  assert.equal(parsed.subject, 'Re: Rechnung Nr. 2026-1043')
  assert.equal(parsed.inReplyTo, '<inv1@example.de>')
  assert.equal(parsed.attachments.length, 1, 'forwarded attachment included')
  assert.equal(parsed.bcc, undefined, 'Bcc header not sent to recipients')
  sentMessageId = parsed.messageId
  const sent = await waitFor(async () => {
    const r = await engine.listMessages({ view: { kind: 'unified', box: 'sent' } })
    return r.total === 1 ? r : null
  }, 10000, 'sent copy')
  assert.equal(sent.items[0].subject, 'Re: Rechnung Nr. 2026-1043')
  const replied = await engine.getMessage(original.id)
  assert.equal(replied.answered, true)
  const contacts = await engine.suggestContacts('luk')
  assert.equal(contacts[0].address, 'lukas@example.de')
})

test('replies are grouped into one conversation', async () => {
  const view = { kind: 'unified', box: 'inbox' }
  let row = (await engine.listMessages({ view, threads: true })).items.find((m) => m.subject.includes('Rechnung'))
  assert.equal(row.threadCount, 2, 'original + my sent reply')
  const thread = await engine.getThread(row.id)
  assert.deepEqual(thread.map((m) => m.role), ['inbox', 'sent'])
  // 对方回复了我的回复
  await deliver(`From: Lukas Becker <lukas@example.de>\r\nTo: test@example.com\r\nSubject: Re: Re: Rechnung Nr. 2026-1043\r\nMessage-ID: <inv3@example.de>\r\nIn-Reply-To: ${sentMessageId}\r\n\r\nPerfekt, danke!`)
  row = await waitFor(async () => {
    const r = (await engine.listMessages({ view, threads: true })).items.find((m) => m.subject.startsWith('Re: Re: Rechnung'))
    return r ?? null
  }, 20000, 'reply in thread')
  assert.equal(row.threadCount, 3)
  assert.equal(row.threadIds.length, 2, 'two inbox messages in this conversation')
  const flat = await engine.listMessages({ view })
  const threaded = await engine.listMessages({ view, threads: true })
  assert.equal(threaded.total, flat.total - 1, 'conversation collapses into one row')
})

test('new mail arriving on the server shows up (IDLE / sync)', async () => {
  const before = events.length
  // 通过另一个连接往收件箱投递一封新邮件
  const { ImapFlow } = require('imapflow')
  const c = new ImapFlow({ host: '127.0.0.1', port: imap.address().port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false })
  await c.connect()
  await c.append('INBOX', 'From: Alice <alice@example.com>\r\nTo: test@example.com\r\nSubject: Hello from Alice\r\nMessage-ID: <new1@example.com>\r\n\r\nHi!', [])
  await c.logout()
  const res = await waitFor(async () => {
    const r = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'Alice' })
    return r.total === 1 ? r : null
  }, 20000, 'new mail via IDLE')
  assert.equal(res.items[0].subject, 'Hello from Alice')
  assert.ok(events.slice(before).some((e) => e[0] === 'notify'), 'desktop notification fired')
})

test('mark all read clears unread on the server too', async () => {
  assert.ok((await engine.getCounts()).unified.inbox > 0)
  await engine.markAllRead({ kind: 'unified', box: 'inbox' })
  assert.equal((await engine.getCounts()).unified.inbox, 0)
  await engine.syncNow(accountId)
  assert.equal((await engine.getCounts()).unified.inbox, 0, 'server agrees after re-sync')
})

test('rules mark, move and silence matching new mail', async () => {
  await engine.saveRule({
    id: '',
    name: 'Bob 的通知',
    enabled: true,
    accountId: null,
    match: 'all',
    conditions: [{ field: 'from', op: 'endsWith', value: '@bob.example' }],
    actions: { markRead: true, move: 'archive' }
  })
  assert.equal((await engine.listRules()).length, 1)
  const before = events.length
  await deliver('From: Bob <noti@bob.example>\r\nTo: test@example.com\r\nSubject: Weekly digest\r\nMessage-ID: <bob1@bob.example>\r\n\r\nNews')
  const archive = (await engine.listFolders()).find((f) => f.role === 'archive')
  const res = await waitFor(async () => {
    const r = await engine.listMessages({ view: { kind: 'folder', accountId, path: archive.path } })
    return r.items.find((m) => m.subject === 'Weekly digest') ?? null
  }, 20000, 'rule moved message to archive')
  assert.equal(res.seen, true)
  const inbox = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' }, search: 'digest' })
  assert.equal(inbox.items.filter((m) => m.role === 'inbox').length, 0)
  assert.ok(!events.slice(before).some((e) => e[0] === 'notify' && String(e[1]).includes('Bob')), 'no notification for filtered mail')
})

test('snooze hides a message and brings it back unread', async () => {
  const view = { kind: 'unified', box: 'inbox' }
  const alice = (await engine.listMessages({ view, search: 'Alice' })).items[0]
  await engine.snooze([alice.id], Date.now() + 3600_000)
  assert.ok(!(await engine.listMessages({ view })).items.some((m) => m.id === alice.id), 'hidden from inbox')
  assert.ok((await engine.listMessages({ view: { kind: 'unified', box: 'snoozed' } })).items.some((m) => m.id === alice.id))
  assert.equal((await engine.getCounts()).unified.snoozed, 1)
  const before = events.length
  await engine.snooze([alice.id], Date.now() - 1000)
  await engine.tick()
  const back = (await engine.listMessages({ view })).items.find((m) => m.id === alice.id)
  assert.ok(back, 'back in inbox')
  assert.equal(back.seen, false)
  assert.equal(back.snoozeUntil, null)
  assert.ok(events.slice(before).some((e) => e[0] === 'notify' && String(e[1]).startsWith('提醒')))
})

test('scheduled send can be cancelled or sent', async () => {
  const d = { accountId, to: [{ address: 'later@example.com' }], cc: [], bcc: [], subject: '定时邮件', html: '<p>hi</p>', text: 'hi', attachments: [] }
  await engine.scheduleSend(d, Date.now() + 3600_000)
  let list = await engine.listScheduled()
  assert.equal(list.length, 1)
  const back = await engine.cancelScheduled(list[0].id)
  assert.equal(back.subject, '定时邮件')
  assert.equal((await engine.listScheduled()).length, 0)
  const sentBefore = received.length
  await engine.scheduleSend(d, Date.now() + 3600_000)
  list = await engine.listScheduled()
  await engine.sendScheduledNow(list[0].id)
  assert.equal(received.length, sentBefore + 1)
  assert.equal((await engine.listScheduled()).length, 0)
})

test('removing the account clears local data', async () => {
  await engine.removeAccount(accountId)
  const r = await engine.listMessages({ view: { kind: 'unified', box: 'inbox' } })
  assert.equal(r.total, 0)
  assert.equal((await engine.listAccounts()).length, 0)
})

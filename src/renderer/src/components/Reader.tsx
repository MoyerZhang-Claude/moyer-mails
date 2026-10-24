import { memo, useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArrowLeft,
  Download,
  Forward,
  ImageOff,
  Inbox,
  Languages,
  LoaderCircle,
  Mail,
  MailOpen,
  Paperclip,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2
} from 'lucide-react'
import { langName, normalizeLang } from '@shared/langs'
import type { MessageDetail } from '@shared/types'
import { api } from '../api'
import { moveTo, replyTo, selectMessage, toast, toggleFlag, toggleSeen, useStore } from '../store'
import { translateText } from '../translate-dom'
import { cx, displayName, formatAddress, formatSize, fullTime } from '../util'
import { Avatar } from './Common'
import { MailFrame, type MailFrameHandle } from './MailFrame'

const EXT_COLORS: Record<string, string> = {
  pdf: '#e5484d',
  doc: '#2b6cdf',
  docx: '#2b6cdf',
  xls: '#1f9d55',
  xlsx: '#1f9d55',
  csv: '#1f9d55',
  ppt: '#e86a1b',
  pptx: '#e86a1b',
  zip: '#8a6d3b',
  rar: '#8a6d3b',
  '7z': '#8a6d3b',
  jpg: '#9b59b6',
  jpeg: '#9b59b6',
  png: '#9b59b6',
  gif: '#9b59b6',
  txt: '#6b7280',
  eml: '#0ea5e9'
}

interface TrState {
  state: 'idle' | 'working' | 'done' | 'error'
  done?: number
  total?: number
  detected?: string
  showing?: 'translated' | 'original'
  subject?: string
}

function Recipients({ d }: { d: MessageDetail }) {
  const [open, setOpen] = useState(false)
  const all = [...d.to, ...d.cc]
  if (!all.length) return null
  const short = (list: typeof d.to) => list.map((a) => displayName(a)).join('、')
  if (!open)
    return (
      <div className="recips" style={{ cursor: 'pointer' }} onClick={() => setOpen(true)} title="显示详细地址">
        <b>发给</b>
        {short(d.to)}
        {d.cc.length > 0 && <>，抄送 {short(d.cc)}</>}
      </div>
    )
  return (
    <div className="recips">
      <div>
        <b>收件人</b>
        {d.to.map(formatAddress).join('，')}
      </div>
      {d.cc.length > 0 && (
        <div>
          <b>抄送</b>
          {d.cc.map(formatAddress).join('，')}
        </div>
      )}
      {d.bcc.length > 0 && (
        <div>
          <b>密送</b>
          {d.bcc.map(formatAddress).join('，')}
        </div>
      )}
      {d.replyTo.length > 0 && (
        <div>
          <b>回复到</b>
          {d.replyTo.map(formatAddress).join('，')}
        </div>
      )}
    </div>
  )
}

export const Reader = memo(function Reader() {
  const selectedId = useStore((s) => s.selectedId)
  const detail = useStore((s) => s.detail)
  const loading = useStore((s) => s.detailLoading)
  const error = useStore((s) => s.detailError)
  const summary = useStore((s) => s.list.find((m) => m.id === s.selectedId) ?? null)
  const accounts = useStore((s) => s.accounts)
  const settings = useStore((s) => s.settings)
  const frame = useRef<MailFrameHandle>(null)
  const [tr, setTr] = useState<TrState>({ state: 'idle' })
  const [allowImages, setAllowImages] = useState(false)
  const autoDone = useRef<number | null>(null)
  const signal = useRef({ cancelled: false })

  const target = settings?.translate.targetLang ?? 'zh'
  const id = detail?.id

  useEffect(() => {
    signal.current.cancelled = true
    signal.current = { cancelled: false }
    setTr({ state: 'idle' })
    setAllowImages(!!settings?.loadRemoteImages)
  }, [id, settings?.loadRemoteImages])

  // 切换“显示图片”会重新渲染正文，译文需要重做
  useEffect(() => {
    signal.current.cancelled = true
    signal.current = { cancelled: false }
    setTr({ state: 'idle' })
  }, [allowImages])

  const lang = normalizeLang(detail?.lang)
  const foreign = !!lang && lang !== target && !(target.startsWith('zh') && lang.startsWith('zh'))

  const runTranslate = async () => {
    if (!detail) return
    if (tr.state === 'done') {
      const showing = tr.showing === 'translated' ? 'original' : 'translated'
      frame.current?.show(showing)
      setTr({ ...tr, showing })
      return
    }
    if (tr.state === 'working') return
    const sig = signal.current
    setTr({ state: 'working', done: 0, total: 0 })
    try {
      const subjectP = detail.subject ? translateText(detail.subject, target).catch(() => null) : Promise.resolve(null)
      const detected = await frame.current?.translate(target, settings?.translate.display === 'bilingual', (p) => !sig.cancelled && setTr((t) => ({ ...t, ...p })), sig)
      const subj = await subjectP
      if (sig.cancelled) return
      setTr({ state: 'done', showing: 'translated', detected: detected ?? lang ?? undefined, subject: subj?.text })
    } catch (err) {
      if (sig.cancelled) return
      setTr({ state: 'error' })
      toast((err as Error).message, 'error')
    }
  }

  // 用快捷键 T 翻译
  useEffect(() => {
    const h = () => void runTranslate()
    window.addEventListener('moyer:translate', h)
    return () => window.removeEventListener('moyer:translate', h)
  })

  const onFrameReady = () => {
    if (!detail || autoDone.current === detail.id) return
    autoDone.current = detail.id
    if (settings?.translate.autoTranslate && foreign) void runTranslate()
  }

  if (selectedId == null) {
    return (
      <section className="panel glass reader">
        <div className="empty reader-empty">
          <Mail size={52} strokeWidth={1.4} />
          <h3>选择一封邮件阅读</h3>
          <div className="hint" style={{ lineHeight: 1.9 }}>
            <kbd>J</kbd> / <kbd>K</kbd> 上下切换　<kbd>C</kbd> 写信　<kbd>/</kbd> 搜索
          </div>
        </div>
      </section>
    )
  }

  const d = detail
  const head = d ?? summary
  const account = accounts.find((a) => a.id === head?.accountId)
  const isTrash = head?.role === 'trash'
  const isJunk = head?.role === 'junk'

  return (
    <section className={cx('panel glass reader', selectedId != null && 'show')}>
      <div className="reader-bar">
        <button className="btn icon mobile-only" onClick={() => void selectMessage(null)}>
          <ArrowLeft size={18} />
        </button>
        <button className="btn" onClick={() => replyTo('reply')} disabled={!d} title="回复 (R)">
          <Reply size={16} />
          回复
        </button>
        <button className="btn icon" onClick={() => replyTo('replyAll')} disabled={!d} title="全部回复 (A)">
          <ReplyAll size={16} />
        </button>
        <button className="btn icon" onClick={() => replyTo('forward')} disabled={!d} title="转发 (F)">
          <Forward size={16} />
        </button>
        <span className="sep" />
        <button className={cx('btn', tr.state === 'done' && tr.showing === 'translated' && 'active')} onClick={runTranslate} disabled={!d} title="翻译 (T)">
          {tr.state === 'working' ? <LoaderCircle size={16} className="spin" /> : <Languages size={16} />}
          {tr.state === 'done' ? (tr.showing === 'translated' ? '看原文' : '看译文') : '翻译'}
        </button>
        <span className="grow" />
        <button className="btn icon" onClick={() => void toggleFlag()} title={head?.flagged ? '取消星标 (S)' : '加星标 (S)'}>
          <Star size={16} fill={head?.flagged ? '#f5b301' : 'none'} color={head?.flagged ? '#f5b301' : 'currentColor'} />
        </button>
        <button className="btn icon" onClick={() => void toggleSeen()} title={head?.seen ? '标为未读 (U)' : '标为已读 (U)'}>
          {head?.seen ? <Mail size={16} /> : <MailOpen size={16} />}
        </button>
        <button className="btn icon" onClick={() => void moveTo('archive')} title="归档 (E)">
          <Archive size={16} />
        </button>
        {isJunk ? (
          <button className="btn icon" onClick={() => void moveTo('inbox')} title="不是垃圾邮件">
            <Inbox size={16} />
          </button>
        ) : (
          <button className="btn icon" onClick={() => void moveTo('junk')} title="标为垃圾邮件">
            <ShieldAlert size={16} />
          </button>
        )}
        <button className="btn icon danger" onClick={() => void moveTo('trash')} title={isTrash ? '彻底删除 (Delete)' : '删除 (Delete)'}>
          <Trash2 size={16} />
        </button>
      </div>
      <div className="reader-scroll">
        {head && (
          <>
            <h1 className="reader-subject">
              {head.subject || '（无主题）'}
              {tr.subject && tr.showing === 'translated' && tr.subject !== head.subject && (
                <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-2)', marginTop: 4 }}>{tr.subject}</div>
              )}
            </h1>
            <div className="sender">
              <Avatar addr={head.from} />
              <div className="grow">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="sender-name">{displayName(head.from)}</span>
                  <span className="sender-addr">{head.from?.address}</span>
                </div>
                {d ? <Recipients d={d} /> : null}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="faint" style={{ fontSize: 12 }}>
                  {fullTime(head.date)}
                </div>
                {account && (
                  <span className="chip" style={{ marginTop: 6 }} title={account.email}>
                    <span className="dot" style={{ background: account.color }} />
                    {account.label}
                  </span>
                )}
              </div>
            </div>
          </>
        )}

        {d && foreign && tr.state === 'idle' && (
          <div className="banner pop">
            <Languages size={16} />
            <span className="grow">
              这封邮件是<b> {langName(lang)} </b>
            </span>
            <button className="btn soft sm" onClick={runTranslate}>
              翻译成{langName(target)}
            </button>
          </div>
        )}
        {tr.state === 'working' && (
          <div className="banner">
            <LoaderCircle size={16} className="spin" />
            <span className="grow">
              正在翻译… {tr.total ? `${tr.done}/${tr.total}` : ''}
            </span>
          </div>
        )}
        {tr.state === 'done' && (
          <div className="banner neutral">
            <Languages size={16} />
            <span className="grow">
              {tr.showing === 'translated' ? `已从${langName(tr.detected)}翻译成${langName(target)}` : '正在显示原文'}
            </span>
            <button className="btn sm" onClick={runTranslate}>
              {tr.showing === 'translated' ? '显示原文' : '显示译文'}
            </button>
          </div>
        )}
        {d && !allowImages && /<img[^>]+src=["']?https?:/i.test(d.html ?? '') && (
          <div className="banner neutral">
            <ImageOff size={16} />
            <span className="grow">为保护隐私，已阻止加载远程图片</span>
            <button className="btn sm" onClick={() => setAllowImages(true)}>
              显示图片
            </button>
          </div>
        )}

        {d ? (
          <MailFrame ref={frame} html={d.html} text={d.text} allowImages={allowImages} onReady={onFrameReady} />
        ) : error ? (
          <div className="error-box">{error}</div>
        ) : loading ? (
          <div className="paper" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="skeleton" style={{ height: 14, width: '70%' }} />
            <div className="skeleton" style={{ height: 14, width: '92%' }} />
            <div className="skeleton" style={{ height: 14, width: '84%' }} />
            <div className="skeleton" style={{ height: 14, width: '40%' }} />
          </div>
        ) : null}

        {d && d.attachments.length > 0 && (
          <>
            <div className="row faint" style={{ marginTop: 16, fontSize: 12.5 }}>
              <Paperclip size={14} /> {d.attachments.length} 个附件
            </div>
            <div className="attachments">
              {d.attachments.map((a) => {
                const ext = (a.filename.split('.').pop() ?? '').toLowerCase()
                return (
                  <div
                    key={a.index}
                    className="att"
                    title={`${a.filename}\n点击打开`}
                    onClick={() => api.openAttachment(d.id, a.index).catch((e) => toast((e as Error).message, 'error'))}
                  >
                    <div className="ext" style={{ background: EXT_COLORS[ext] ?? '#7a8699' }}>
                      {ext.slice(0, 4) || '?'}
                    </div>
                    <div className="grow">
                      <div className="name ellipsis">{a.filename}</div>
                      <div className="size">{formatSize(a.size)}</div>
                    </div>
                    <button
                      className="btn icon sm"
                      title="另存为"
                      onClick={(e) => {
                        e.stopPropagation()
                        api
                          .saveAttachment(d.id, a.index)
                          .then((ok) => ok && toast('已保存', 'ok'))
                          .catch((err) => toast((err as Error).message, 'error'))
                      }}
                    >
                      <Download size={15} />
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </section>
  )
})

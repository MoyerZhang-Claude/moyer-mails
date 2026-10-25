import { useEffect, useRef, useState } from 'react'
import { Download, Forward, ImageOff, Languages, LoaderCircle, Paperclip, Reply, ReplyAll } from 'lucide-react'
import { langName, normalizeLang } from '@shared/langs'
import type { MessageDetail, MessageSummary } from '@shared/types'
import { api } from '../api'
import { replyTo, toast, useStore } from '../store'
import { translateText } from '../translate-dom'
import { cx, displayName, formatAddress, formatSize, fullTime, shortTime } from '../util'
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
}

function Recipients({ d }: { d: MessageDetail }) {
  const [open, setOpen] = useState(false)
  const all = [...d.to, ...d.cc]
  if (!all.length) return null
  const short = (list: typeof d.to) => list.map((a) => displayName(a)).join('、')
  if (!open)
    return (
      <div
        className="recips"
        style={{ cursor: 'pointer' }}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        title="显示详细地址"
      >
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

function Attachments({ d }: { d: MessageDetail }) {
  if (!d.attachments.length) return null
  return (
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
  )
}

export interface MessageCardProps {
  m: MessageSummary
  /** 主邮件的正文由阅读区统一加载后传进来；其他邮件卡片自己加载 */
  detail?: MessageDetail | null
  loading?: boolean
  error?: string | null
  /** 主邮件：响应快捷键 T，并把标题译文报告给阅读区 */
  primary: boolean
  /** 会话模式：卡片可以折叠，底部有回复按钮 */
  inThread: boolean
  defaultOpen: boolean
  onSubjectTranslated?: (text: string | null) => void
}

export function MessageCard({ m, detail: given, loading: givenLoading, error: givenError, primary, inThread, defaultOpen, onSubjectTranslated }: MessageCardProps) {
  const settings = useStore((s) => s.settings)
  const [open, setOpen] = useState(defaultOpen)
  const [own, setOwn] = useState<{ detail: MessageDetail | null; loading: boolean; error: string | null }>({ detail: null, loading: false, error: null })
  const frame = useRef<MailFrameHandle>(null)
  const [tr, setTr] = useState<TrState>({ state: 'idle' })
  const [allowImages, setAllowImages] = useState(!!settings?.loadRemoteImages)
  const autoDone = useRef(false)
  const signal = useRef({ cancelled: false })
  const subjectTr = useRef<string | null>(null)

  const usesGiven = given !== undefined
  const d = usesGiven ? given : own.detail
  const loading = usesGiven ? !!givenLoading : own.loading
  const error = usesGiven ? givenError ?? null : own.error
  const target = settings?.translate.targetLang ?? 'zh'

  // 非主邮件：展开时再加载正文
  useEffect(() => {
    if (usesGiven || !open || own.detail || own.loading) return
    setOwn({ detail: null, loading: true, error: null })
    api
      .getMessage(m.id)
      .then((detail) => setOwn({ detail, loading: false, error: null }))
      .catch((err) => setOwn({ detail: null, loading: false, error: (err as Error).message }))
  }, [open, usesGiven, m.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 换邮件 / 切换“显示图片”时，译文要重做
  useEffect(() => {
    signal.current.cancelled = true
    signal.current = { cancelled: false }
    setTr({ state: 'idle' })
    autoDone.current = false
    subjectTr.current = null
    onSubjectTranslated?.(null)
  }, [d?.id, allowImages]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setAllowImages(!!settings?.loadRemoteImages), [settings?.loadRemoteImages, d?.id])

  const lang = normalizeLang(d?.lang)
  const foreign = !!lang && lang !== target && !(target.startsWith('zh') && lang.startsWith('zh'))

  const runTranslate = async () => {
    if (!d) return
    if (tr.state === 'done') {
      const showing = tr.showing === 'translated' ? 'original' : 'translated'
      frame.current?.show(showing)
      setTr({ ...tr, showing })
      onSubjectTranslated?.(showing === 'translated' ? subjectTr.current : null)
      return
    }
    if (tr.state === 'working') return
    const sig = signal.current
    setTr({ state: 'working', done: 0, total: 0 })
    try {
      const subjectP = primary && d.subject ? translateText(d.subject, target).catch(() => null) : Promise.resolve(null)
      const detected = await frame.current?.translate(target, settings?.translate.display === 'bilingual', (p) => !sig.cancelled && setTr((t) => ({ ...t, ...p })), sig)
      const subj = await subjectP
      if (sig.cancelled) return
      setTr({ state: 'done', showing: 'translated', detected: detected ?? lang ?? undefined })
      subjectTr.current = subj?.text && subj.text !== d.subject ? subj.text : null
      onSubjectTranslated?.(subjectTr.current)
    } catch (err) {
      if (sig.cancelled) return
      setTr({ state: 'error' })
      toast((err as Error).message, 'error')
    }
  }

  // 快捷键 T / 工具栏的“翻译”只作用于主邮件
  useEffect(() => {
    if (!primary) return
    const h = () => void runTranslate()
    window.addEventListener('moyer:translate', h)
    return () => window.removeEventListener('moyer:translate', h)
  })

  const onFrameReady = () => {
    if (!d || autoDone.current) return
    autoDone.current = true
    if (settings?.translate.autoTranslate && foreign) void runTranslate()
  }

  const showTo = m.role === 'sent' || m.role === 'drafts'

  // ---------- 折叠状态（只在会话里出现） ----------
  if (inThread && !open) {
    return (
      <div className="thread-card collapsed" onClick={() => setOpen(true)} title="展开">
        <Avatar addr={m.from} size={30} />
        <span className={cx('tc-name', !m.seen && 'unread')}>{showTo ? '我' : displayName(m.from)}</span>
        <span className="tc-snippet ellipsis">{m.snippet || m.subject}</span>
        <span className="tc-date">{shortTime(m.date)}</span>
      </div>
    )
  }

  const header = (
    <div className={cx('sender', inThread && 'clickable')} onClick={inThread ? () => setOpen(false) : undefined} title={inThread ? '收起' : undefined}>
      <Avatar addr={m.from} />
      <div className="grow">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="sender-name">{displayName(m.from)}</span>
          <span className="sender-addr">{m.from?.address}</span>
        </div>
        {d ? <Recipients d={d} /> : null}
      </div>
      <div className="faint" style={{ fontSize: 12, flexShrink: 0, textAlign: 'right' }}>
        {fullTime(m.date)}
      </div>
    </div>
  )

  return (
    <div className={cx(inThread ? 'thread-card' : 'single-card')}>
      {header}

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
          <span className="grow">正在翻译… {tr.total ? `${tr.done}/${tr.total}` : ''}</span>
        </div>
      )}
      {tr.state === 'done' && (
        <div className="banner neutral">
          <Languages size={16} />
          <span className="grow">{tr.showing === 'translated' ? `已从${langName(tr.detected)}翻译成${langName(target)}` : '正在显示原文'}</span>
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

      {d && <Attachments d={d} />}

      {inThread && d && (
        <div className="row card-actions">
          <button className="btn sm outline" onClick={() => replyTo('reply', d)}>
            <Reply size={14} />
            回复
          </button>
          <button className="btn sm outline" onClick={() => replyTo('replyAll', d)}>
            <ReplyAll size={14} />
            全部回复
          </button>
          <button className="btn sm outline" onClick={() => replyTo('forward', d)}>
            <Forward size={14} />
            转发
          </button>
          {!foreign && tr.state === 'idle' && (
            <button className="btn sm" onClick={runTranslate} title="翻译这封邮件">
              <Languages size={14} />
              翻译
            </button>
          )}
        </div>
      )}
    </div>
  )
}

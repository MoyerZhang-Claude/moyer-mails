import { memo, useEffect, useRef, useState } from 'react'
import { AlarmClock, Archive, ArrowLeft, Forward, Inbox, Languages, Mail, MailOpen, Reply, ReplyAll, ShieldAlert, Star, Trash2 } from 'lucide-react'
import type { MessageSummary } from '@shared/types'
import { api } from '../api'
import { moveTo, replyTo, selectMessage, snoozeTo, toggleFlag, toggleSeen, useStore } from '../store'
import { cx } from '../util'
import { MessageCard } from './MessageCard'
import { snoozePresets, TimeMenu } from './TimeMenu'

/** 会话太长时，中间的旧邮件收成一行“还有 N 封” */
function visibleThread(thread: MessageSummary[], selectedId: number, showAll: boolean) {
  if (showAll || thread.length <= 4) return { items: thread, hidden: 0 }
  const keep = new Set<number>([thread[0].id, ...thread.slice(-2).map((m) => m.id), selectedId])
  for (const m of thread) if (!m.seen) keep.add(m.id)
  const items: (MessageSummary | { fold: number })[] = []
  let run = 0
  for (const m of thread) {
    if (keep.has(m.id)) {
      if (run) items.push({ fold: run })
      run = 0
      items.push(m)
    } else run++
  }
  if (run) items.push({ fold: run })
  return { items, hidden: thread.length - keep.size }
}

export const Reader = memo(function Reader() {
  const selectedId = useStore((s) => s.selectedId)
  const detail = useStore((s) => s.detail)
  const loading = useStore((s) => s.detailLoading)
  const error = useStore((s) => s.detailError)
  const summary = useStore((s) => s.list.find((m) => m.id === s.selectedId) ?? null)
  const accounts = useStore((s) => s.accounts)
  const threading = useStore((s) => !!s.settings?.threading)
  const view = useStore((s) => s.view)
  const [thread, setThread] = useState<MessageSummary[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [subjectTr, setSubjectTr] = useState<string | null>(null)
  const [snoozeMenu, setSnoozeMenu] = useState<{ x: number; y: number } | null>(null)
  const snoozeBtn = useRef<HTMLButtonElement>(null)

  // 快捷键 H：稍后提醒
  useEffect(() => {
    const h = () => {
      const r = snoozeBtn.current?.getBoundingClientRect()
      if (r) setSnoozeMenu({ x: r.right - 250, y: r.bottom + 6 })
    }
    window.addEventListener('moyer:snooze', h)
    return () => window.removeEventListener('moyer:snooze', h)
  }, [])

  const threadCount = summary?.threadCount ?? 1
  useEffect(() => {
    setThread(null)
    setShowAll(false)
    setSubjectTr(null)
    if (selectedId == null || !threading || threadCount <= 1) return
    let alive = true
    api
      .getThread(selectedId)
      .then((t) => alive && setThread(t))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [selectedId, threading, threadCount])

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

  const head = detail ?? summary
  const account = accounts.find((a) => a.id === head?.accountId)
  const isTrash = head?.role === 'trash'
  const isJunk = head?.role === 'junk'
  const inSnoozed = view.kind === 'unified' && view.box === 'snoozed'
  const isThread = !!thread && thread.length > 1
  const shown = isThread ? visibleThread(thread, selectedId, showAll) : null

  return (
    <section className={cx('panel glass reader', selectedId != null && 'show')}>
      <div className="reader-bar">
        <button className="btn icon mobile-only" onClick={() => void selectMessage(null)}>
          <ArrowLeft size={18} />
        </button>
        <button className="btn" onClick={() => replyTo('reply')} disabled={!detail} title="回复 (R)">
          <Reply size={16} />
          回复
        </button>
        <button className="btn icon" onClick={() => replyTo('replyAll')} disabled={!detail} title="全部回复 (A)">
          <ReplyAll size={16} />
        </button>
        <button className="btn icon" onClick={() => replyTo('forward')} disabled={!detail} title="转发 (F)">
          <Forward size={16} />
        </button>
        <span className="sep" />
        <button className="btn" onClick={() => window.dispatchEvent(new Event('moyer:translate'))} disabled={!detail} title="翻译 / 切换原文 (T)">
          <Languages size={16} />
          翻译
        </button>
        <span className="grow" />
        <button className="btn icon" onClick={() => void toggleFlag()} title={head?.flagged ? '取消星标 (S)' : '加星标 (S)'}>
          <Star size={16} fill={head?.flagged ? '#f5b301' : 'none'} color={head?.flagged ? '#f5b301' : 'currentColor'} />
        </button>
        <button className="btn icon" onClick={() => void toggleSeen()} title={head?.seen ? '标为未读 (U)' : '标为已读 (U)'}>
          {head?.seen ? <Mail size={16} /> : <MailOpen size={16} />}
        </button>
        <button
          ref={snoozeBtn}
          className={cx('btn icon', inSnoozed && 'active')}
          title={inSnoozed ? '取消稍后提醒' : '稍后提醒 (H)'}
          onClick={(e) => {
            if (inSnoozed) return void snoozeTo(null)
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setSnoozeMenu({ x: r.right - 250, y: r.bottom + 6 })
          }}
        >
          <AlarmClock size={16} />
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
          <div className="row" style={{ alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
            <h1 className="reader-subject grow" style={{ margin: 0 }}>
              {head.subject || '（无主题）'}
              {subjectTr && <div className="subject-tr">{subjectTr}</div>}
            </h1>
            <div className="row" style={{ gap: 6, flexShrink: 0, paddingTop: 4 }}>
              {isThread && <span className="chip">{thread.length} 封</span>}
              {account && (
                <span className="chip" title={account.email}>
                  <span className="dot" style={{ background: account.color }} />
                  {account.label}
                </span>
              )}
            </div>
          </div>
        )}

        {isThread && shown ? (
          <div className="thread">
            {shown.items.map((it, i) =>
              'fold' in it ? (
                <button key={`fold${i}`} className="thread-fold" onClick={() => setShowAll(true)}>
                  还有 {it.fold} 封较早的邮件
                </button>
              ) : (
                <MessageCard
                  key={it.id}
                  m={it}
                  primary={it.id === selectedId}
                  inThread
                  defaultOpen={it.id === selectedId || !it.seen}
                  {...(it.id === selectedId ? { detail, loading, error, onSubjectTranslated: setSubjectTr } : {})}
                />
              )
            )}
          </div>
        ) : (
          head && (
            <MessageCard
              key={selectedId}
              m={summary ?? (detail as MessageSummary)}
              detail={detail}
              loading={loading}
              error={error}
              primary
              inThread={false}
              defaultOpen
              onSubjectTranslated={setSubjectTr}
            />
          )
        )}
      </div>
      {snoozeMenu && (
        <TimeMenu
          title="稍后提醒"
          presets={snoozePresets()}
          style={{ position: 'fixed', left: Math.max(8, snoozeMenu.x), top: snoozeMenu.y }}
          onPick={(ts) => void snoozeTo(ts)}
          onClose={() => setSnoozeMenu(null)}
        />
      )}
    </section>
  )
})

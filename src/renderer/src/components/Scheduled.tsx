import { useEffect, useState } from 'react'
import { CalendarClock, CircleAlert, LoaderCircle, Pencil, Send, X } from 'lucide-react'
import type { ScheduledItem } from '@shared/types'
import { api } from '../api'
import { confirmDialog, errorText, formatWhen, openComposer, toast, useStore } from '../store'
import { displayName } from '../util'
import { Modal } from './Common'
import { isNative } from '../native'

/** 侧栏“定时发送”：查看、立即发送、修改或取消 */
export function ScheduledDialog() {
  const accounts = useStore((s) => s.accounts)
  const count = useStore((s) => s.scheduledCount)
  const [items, setItems] = useState<ScheduledItem[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const close = () => useStore.setState({ dialog: null })

  useEffect(() => {
    api
      .listScheduled()
      .then(setItems)
      .catch((e) => toast(errorText(e), 'error'))
  }, [count])

  const sendNow = async (it: ScheduledItem) => {
    setBusy(it.id)
    try {
      await api.sendScheduledNow(it.id)
      toast('已发送', 'ok')
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setBusy(null)
      setItems(await api.listScheduled().catch(() => items))
    }
  }

  const edit = async (it: ScheduledItem) => {
    try {
      const d = await api.cancelScheduled(it.id)
      close()
      openComposer({
        mode: 'new',
        accountId: d.accountId,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        bodyHtml: d.html,
        attachments: d.attachments,
        inReplyTo: d.inReplyTo,
        references: d.references,
        replyToLocalId: d.replyToLocalId
      })
      toast('已取消定时，改好后可以重新定时或直接发送', 'info')
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const cancel = async (it: ScheduledItem) => {
    const ok = await confirmDialog(`取消发送“${it.subject || '（无主题）'}”？邮件内容会被丢弃。`, '取消发送', true)
    useStore.setState({ dialog: { kind: 'scheduled' } })
    if (!ok) return
    try {
      await api.cancelScheduled(it.id)
      toast('已取消', 'ok')
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  return (
    <Modal title="定时发送" onClose={close} icon={<CalendarClock size={18} />}>
      <div className="dialog-body">
        {items === null ? (
          <LoaderCircle size={18} className="spin" />
        ) : items.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <CalendarClock size={34} />
            <div>没有等待发送的邮件</div>
          </div>
        ) : (
          items.map((it) => {
            const acc = accounts.find((a) => a.id === it.accountId)
            return (
              <div className="scheduled-row" key={it.id}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <b className="ellipsis">{it.subject || '（无主题）'}</b>
                    {it.status === 'failed' ? (
                      <span className="chip" style={{ color: 'var(--danger)' }}>
                        <CircleAlert size={12} />
                        发送失败
                      </span>
                    ) : (
                      <span className="chip">{formatWhen(it.sendAt)}</span>
                    )}
                  </div>
                  <div className="hint ellipsis">
                    发给 {it.to.map((a) => displayName(a)).join('、') || '（无收件人）'}
                    {acc ? ` · 从 ${acc.label}` : ''}
                  </div>
                  {it.error && <div className="hint" style={{ color: 'var(--danger)' }}>{it.error}</div>}
                </div>
                <button className="btn sm soft" onClick={() => void sendNow(it)} disabled={busy === it.id}>
                  {busy === it.id ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}
                  {it.status === 'failed' ? '重试' : '立即发送'}
                </button>
                <button className="btn sm outline" onClick={() => void edit(it)}>
                  <Pencil size={13} />
                  修改
                </button>
                <button className="btn icon sm danger" title="取消发送" onClick={() => void cancel(it)}>
                  <X size={14} />
                </button>
              </div>
            )
          })
        )}
        <div className="hint">
          {isNative
            ? '要在关掉 App 后也按时发出，请在 设置 → 通用 里打开“退到后台后继续收信”；否则会在下次打开 Moyer Mail 时发出。'
            : '软件需要开着（可以缩在托盘里）才能按时发出。'}
        </div>
      </div>
    </Modal>
  )
}

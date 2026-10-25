import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import {
  Bold,
  CalendarClock,
  ChevronDown,
  Italic,
  Languages,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  Minus,
  Paperclip,
  RemoveFormatting,
  Send,
  Trash2,
  Underline,
  X
} from 'lucide-react'
import { LANGS, langName, normalizeLang } from '@shared/langs'
import { api, pathForFile } from '../api'
import { closeComposer, confirmDialog, errorText, formatWhen, saveDrafts, toast, updateComposer, useStore, type ComposerState } from '../store'
import { translateElement, unwrapMarkers } from '../translate-dom'
import { cx, debounce, formatSize, isValidEmail } from '../util'
import { RecipientInput } from './RecipientInput'
import { sendPresets, TimeMenu } from './TimeMenu'

const TITLES = { new: '写邮件', reply: '回复', replyAll: '全部回复', forward: '转发' }
const saveDraftsSoon = debounce(saveDrafts, 800)

function htmlToPlain(html: string) {
  const div = document.createElement('div')
  div.innerHTML = DOMPurify.sanitize(html)
  div.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
  div.querySelectorAll('p,div,li,tr,h1,h2,h3,blockquote').forEach((el) => el.append('\n'))
  return (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

function isBlank(html: string) {
  return !html.replace(/<div class="moyer-signature">[\s\S]*$/, '').replace(/<[^>]+>|&nbsp;|\s/g, '')
}

interface TrPanel {
  lang: string
  loading: boolean
  html: string | null
  back: string | null
  backLoading: boolean
}

function Composer({ c }: { c: ComposerState }) {
  const allAccounts = useStore((s) => s.accounts)
  const accounts = useMemo(() => allAccounts.filter((a) => a.enabled), [allAccounts])
  const editor = useRef<HTMLDivElement>(null)
  const trEditor = useRef<HTMLDivElement>(null)
  const [showCc, setShowCc] = useState(c.cc.length > 0 || c.bcc.length > 0)
  const [sending, setSending] = useState(false)
  const [scheduleAt, setScheduleAt] = useState<{ left: number; bottom: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [linkBox, setLinkBox] = useState<{ url: string; range: Range | null } | null>(null)
  const defaultLang = (() => {
    const l = normalizeLang(c.replyLang)
    return l && !l.startsWith('zh') ? l : 'en'
  })()
  const [tr, setTr] = useState<TrPanel>({ lang: defaultLang, loading: false, html: null, back: null, backLoading: false })
  const [showTr, setShowTr] = useState(false)

  useEffect(() => {
    if (editor.current) editor.current.innerHTML = c.bodyHtml
    // 回复时光标放在正文开头，新邮件放在收件人
    if (c.mode !== 'new' && c.mode !== 'forward') setTimeout(() => editor.current?.focus(), 30)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const update = (patch: Partial<ComposerState>) => {
    updateComposer(c.id, patch)
    saveDraftsSoon()
  }

  const onInput = () => update({ bodyHtml: editor.current?.innerHTML ?? '' })

  const exec = (cmd: string, value?: string) => {
    editor.current?.focus()
    document.execCommand(cmd, false, value)
    onInput()
  }

  const addFiles = (files: { path: string; filename: string; size: number }[]) => {
    if (!files.length) return
    update({ attachments: [...useStore.getState().composers.find((x) => x.id === c.id)!.attachments, ...files] })
  }

  const pick = async () => {
    try {
      addFiles(await api.pickFiles())
    } catch (err) {
      toast(errorText(err), 'error')
    }
  }

  const discard = async () => {
    const hasContent = !isBlank(editor.current?.innerHTML ?? '') || c.subject || c.attachments.length
    if (hasContent && !(await confirmDialog('放弃这封邮件？内容不会保存。', '放弃', true))) return
    closeComposer(c.id)
  }

  /** sendAt 有值时是定时发送 */
  const send = async (sendAt?: number) => {
    const st = useStore.getState().composers.find((x) => x.id === c.id) ?? c
    const all = [...st.to, ...st.cc, ...st.bcc]
    if (!all.length) return toast('请填写收件人', 'error')
    const bad = all.find((a) => !isValidEmail(a.address))
    if (bad) return toast(`邮箱地址不正确：${bad.address}`, 'error')
    if (!st.subject.trim() && !(await confirmDialog('这封邮件没有主题，仍然发送吗？', '发送'))) return
    const total = st.attachments.reduce((n, a) => n + (a.size ?? 0), 0)
    if (total > 25 * 1024 * 1024 && !(await confirmDialog(`附件总大小 ${formatSize(total)}，很多邮箱限制 25MB 以内，可能会发送失败。继续吗？`, '继续发送'))) return
    const body = editor.current?.innerHTML ?? ''
    const quote = st.includeQuote ? st.quoteHtml : ''
    const html = `<div style="font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;font-size:14px;line-height:1.6">${body}${quote}</div>`
    setSending(true)
    try {
      const draft = {
        accountId: st.accountId,
        to: st.to,
        cc: st.cc,
        bcc: st.bcc,
        subject: st.subject,
        html,
        text: htmlToPlain(body + quote),
        attachments: st.attachments,
        inReplyTo: st.inReplyTo,
        references: st.references,
        replyToLocalId: st.replyToLocalId
      }
      if (sendAt) {
        await api.scheduleSend(draft, sendAt)
        closeComposer(c.id)
        toast(`将在 ${formatWhen(sendAt)} 发送，可以在侧栏“定时发送”里修改`, 'ok')
      } else {
        await api.send(draft)
        closeComposer(c.id)
        toast('已发送', 'ok')
      }
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setSending(false)
    }
  }

  const translateDraft = async (lang = tr.lang) => {
    const html = editor.current?.innerHTML ?? ''
    if (isBlank(html)) return toast('先写点内容再翻译', 'info')
    setShowTr(true)
    setTr((t) => ({ ...t, lang, loading: true, html: null, back: null }))
    try {
      const box = document.createElement('div')
      box.innerHTML = html
      await translateElement(box, lang)
      unwrapMarkers(box)
      setTr((t) => ({ ...t, loading: false, html: box.innerHTML }))
    } catch (err) {
      setTr((t) => ({ ...t, loading: false }))
      toast(errorText(err), 'error')
    }
  }

  useEffect(() => {
    if (trEditor.current && tr.html != null) trEditor.current.innerHTML = tr.html
  }, [tr.html])

  const backTranslate = async () => {
    const html = trEditor.current?.innerHTML ?? ''
    setTr((t) => ({ ...t, backLoading: true }))
    try {
      const box = document.createElement('div')
      box.innerHTML = html
      await translateElement(box, 'zh')
      setTr((t) => ({ ...t, backLoading: false, back: htmlToPlain(box.innerHTML) }))
    } catch (err) {
      setTr((t) => ({ ...t, backLoading: false }))
      toast(errorText(err), 'error')
    }
  }

  const applyTr = (mode: 'replace' | 'both') => {
    const trHtml = trEditor.current?.innerHTML ?? ''
    if (!editor.current) return
    const original = editor.current.innerHTML
    editor.current.innerHTML = mode === 'replace' ? trHtml : `${trHtml}<p><br></p><hr><div style="color:#666">${original}</div>`
    onInput()
    setShowTr(false)
    setTr((t) => ({ ...t, html: null, back: null }))
  }

  return (
    <div className="composer-wrap" onMouseDown={(e) => e.target === e.currentTarget && update({ minimized: true })}>
      <div
        className="composer pop"
        style={{ position: 'relative' }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void send()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            update({ minimized: true })
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const files = Array.from(e.dataTransfer.files).map((f) => ({ path: pathForFile(f), filename: f.name, size: f.size }))
          addFiles(files.filter((f) => f.path))
        }}
      >
        {dragging && <div className="drop-hint">松开鼠标添加附件</div>}
        <div className="composer-head">
          <h3>{TITLES[c.mode]}</h3>
          <button className="btn icon sm" title="最小化 (Esc)" onClick={() => update({ minimized: true })}>
            <Minus size={16} />
          </button>
          <button className="btn icon sm" title="关闭" onClick={discard}>
            <X size={16} />
          </button>
        </div>
        <div className="c-field">
          <label>发件人</label>
          <select className="plain" value={c.accountId} onChange={(e) => update({ accountId: e.target.value })}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} &lt;{a.email}&gt;
              </option>
            ))}
          </select>
        </div>
        <div className="c-field">
          <label>收件人</label>
          <RecipientInput value={c.to} onChange={(to) => update({ to })} autoFocus={c.mode === 'new' || c.mode === 'forward'} />
          {!showCc && (
            <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setShowCc(true)}>
              抄送/密送
            </button>
          )}
        </div>
        {showCc && (
          <>
            <div className="c-field">
              <label>抄送</label>
              <RecipientInput value={c.cc} onChange={(cc) => update({ cc })} />
            </div>
            <div className="c-field">
              <label>密送</label>
              <RecipientInput value={c.bcc} onChange={(bcc) => update({ bcc })} />
            </div>
          </>
        )}
        <div className="c-field">
          <label>主题</label>
          <input className="plain" value={c.subject} onChange={(e) => update({ subject: e.target.value })} placeholder="邮件主题" />
        </div>

        <div className="row" style={{ padding: '6px 14px 0', gap: 2 }}>
          <button className="btn icon sm" title="加粗 (Ctrl+B)" onMouseDown={(e) => (e.preventDefault(), exec('bold'))}>
            <Bold size={15} />
          </button>
          <button className="btn icon sm" title="斜体 (Ctrl+I)" onMouseDown={(e) => (e.preventDefault(), exec('italic'))}>
            <Italic size={15} />
          </button>
          <button className="btn icon sm" title="下划线 (Ctrl+U)" onMouseDown={(e) => (e.preventDefault(), exec('underline'))}>
            <Underline size={15} />
          </button>
          <button className="btn icon sm" title="项目符号" onMouseDown={(e) => (e.preventDefault(), exec('insertUnorderedList'))}>
            <List size={15} />
          </button>
          <button className="btn icon sm" title="编号" onMouseDown={(e) => (e.preventDefault(), exec('insertOrderedList'))}>
            <ListOrdered size={15} />
          </button>
          <button
            className="btn icon sm"
            title="插入链接"
            onMouseDown={(e) => {
              e.preventDefault()
              const s = window.getSelection()
              const range = s && s.rangeCount && editor.current?.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null
              setLinkBox({ url: 'https://', range })
            }}
          >
            <Link size={15} />
          </button>
          <button className="btn icon sm" title="清除格式" onMouseDown={(e) => (e.preventDefault(), exec('removeFormat'))}>
            <RemoveFormatting size={15} />
          </button>
          {linkBox && (
            <div className="row pop" style={{ marginLeft: 8, gap: 4 }}>
              <input
                className="input"
                style={{ height: 28, width: 240 }}
                autoFocus
                value={linkBox.url}
                onChange={(e) => setLinkBox({ ...linkBox, url: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const sel = window.getSelection()
                    if (linkBox.range && sel) {
                      sel.removeAllRanges()
                      sel.addRange(linkBox.range)
                    }
                    if (linkBox.range && !linkBox.range.collapsed) exec('createLink', linkBox.url)
                    else exec('insertHTML', `<a href="${linkBox.url.replace(/"/g, '&quot;')}">${linkBox.url.replace(/</g, '&lt;')}</a>`)
                    setLinkBox(null)
                  } else if (e.key === 'Escape') {
                    e.stopPropagation()
                    setLinkBox(null)
                  }
                }}
              />
              <button className="btn icon sm" onClick={() => setLinkBox(null)}>
                <X size={14} />
              </button>
            </div>
          )}
        </div>

        <div className="editor-wrap">
          <div
            ref={editor}
            className="editor"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="正文…"
            onInput={onInput}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
              if (files.length) {
                e.preventDefault()
                for (const f of files) {
                  const reader = new FileReader()
                  reader.onload = () => exec('insertHTML', `<img src="${reader.result}" style="max-width:100%">`)
                  reader.readAsDataURL(f)
                }
                return
              }
              const html = e.clipboardData.getData('text/html')
              if (html) {
                e.preventDefault()
                exec('insertHTML', DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script', 'meta', 'link', 'form', 'input'] }))
              }
            }}
          />

          {showTr && (
            <div className="tr-panel pop">
              <div className="tr-panel-head">
                <Languages size={15} />
                <span className="grow">
                  {tr.loading ? `正在翻译成${langName(tr.lang)}…` : `${langName(tr.lang)}译文`}
                  {!tr.loading && <span className="tr-panel-hint">可以直接修改</span>}
                </span>
                <button className="btn icon sm" onClick={() => setShowTr(false)} title="关闭">
                  <X size={14} />
                </button>
              </div>
              {tr.loading ? (
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="skeleton" style={{ height: 12, width: '80%' }} />
                  <div className="skeleton" style={{ height: 12, width: '60%' }} />
                </div>
              ) : (
                <div ref={trEditor} className="editor" contentEditable suppressContentEditableWarning />
              )}
              {tr.html != null && !tr.loading && (
                <div className="tr-panel-actions">
                  <button className="btn sm" onClick={backTranslate} title="把译文再翻回中文，检查意思对不对">
                    {tr.backLoading ? <LoaderCircle size={13} className="spin" /> : null}
                    回译检查
                  </button>
                  <button className="btn sm" onClick={() => applyTr('both')} title="译文在上，原文在下">
                    中外双语
                  </button>
                  <button className="btn soft sm" onClick={() => applyTr('replace')}>
                    用译文替换正文
                  </button>
                </div>
              )}
              {tr.back && (
                <div className="tr-back">
                  <b>回译：</b>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{tr.back}</span>
                </div>
              )}
            </div>
          )}

          {c.quoteHtml && (
            <div className="quote-toggle">
              <button className="btn sm" onClick={() => update({ includeQuote: !c.includeQuote })}>
                <ChevronDown size={14} style={{ transform: c.includeQuote ? 'none' : 'rotate(-90deg)' }} />
                {c.includeQuote ? '附带原邮件' : '不附带原邮件'}
              </button>
              {c.includeQuote && <div className="quote-box" dangerouslySetInnerHTML={{ __html: c.quoteHtml }} />}
            </div>
          )}
        </div>

        {c.attachments.length > 0 && (
          <div className="composer-atts">
            {c.attachments.map((a, i) => (
              <span key={i} className="r-chip" title={a.path ?? a.filename}>
                <Paperclip size={13} />
                <span className="ellipsis" style={{ maxWidth: 220 }}>
                  {a.filename}
                </span>
                {a.size ? <span className="faint" style={{ fontSize: 11.5 }}>{formatSize(a.size)}</span> : null}
                <button type="button" onClick={() => update({ attachments: c.attachments.filter((_, k) => k !== i) })}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer-foot">
          <button className="btn primary" onClick={() => void send()} disabled={sending} title="发送 (Ctrl+Enter)" style={{ minWidth: 92 }}>
            {sending ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
            {sending ? '发送中' : '发送'}
          </button>
          <button
            className="btn icon"
            title="定时发送"
            disabled={sending}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setScheduleAt({ left: r.left, bottom: window.innerHeight - r.top + 6 })
            }}
          >
            <CalendarClock size={17} />
          </button>
          {scheduleAt && (
            <TimeMenu
              title="定时发送"
              presets={sendPresets()}
              style={{ position: 'fixed', left: scheduleAt.left, bottom: scheduleAt.bottom }}
              onPick={(ts) => void send(ts)}
              onClose={() => setScheduleAt(null)}
            />
          )}
          <button className="btn icon" title="添加附件" onClick={pick}>
            <Paperclip size={17} />
          </button>
          <span className="sep foot-sep" style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 6px' }} />
          {/* “翻译成”和语言选择放在一起，窄屏换行时不会被拆开 */}
          <span className="tr-group">
          <button className={cx('btn', showTr && 'active')} onClick={() => void translateDraft()} title="把正文翻译成外语">
            <Languages size={16} />
            翻译成
          </button>
          <select
            className="select"
            style={{ width: 112, height: 30 }}
            value={tr.lang}
            onChange={(e) => {
              setTr((t) => ({ ...t, lang: e.target.value }))
              if (showTr) void translateDraft(e.target.value)
            }}
          >
            {LANGS.filter((l) => l.code !== 'zh').map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          </span>
          <span className="grow" />
          <span className="faint kbd-hint" style={{ fontSize: 12, marginRight: 6 }}>
            Ctrl+Enter 发送
          </span>
          <button className="btn icon" title="放弃" onClick={discard}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function Composers() {
  const composers = useStore((s) => s.composers)
  const active = composers.find((c) => !c.minimized)
  const minimized = composers.filter((c) => c.minimized)
  return (
    <>
      {active && <Composer key={active.id} c={active} />}
      {minimized.length > 0 && (
        <div className="mini-composers">
          {minimized.map((c) => (
            <div
              key={c.id}
              className="mini-composer glass-strong"
              onClick={() =>
                useStore.setState((s) => ({ composers: s.composers.map((x) => ({ ...x, minimized: x.id !== c.id })) }))
              }
              title="继续编辑"
            >
              <Send size={14} />
              <span className="ellipsis" style={{ fontWeight: 600, fontSize: 13 }}>
                {c.subject || TITLES[c.mode]}
              </span>
              <button
                className="btn icon sm"
                onClick={(e) => {
                  e.stopPropagation()
                  closeComposer(c.id)
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

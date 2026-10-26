import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { Copy, Languages, LoaderCircle } from 'lucide-react'
import { attachSwipe } from '../gestures'
import { openComposer, toast, useStore } from '../store'
import { translateElement, translateText, type TranslateProgress } from '../translate-dom'
import { parseAddressInput, textToHtml } from '../util'

const BASE_CSS = `
html{overflow-y:hidden!important}
body{margin:0;padding:20px 24px;font-family:'Segoe UI','Microsoft YaHei','PingFang SC',system-ui,sans-serif;font-size:14px;line-height:1.6;color:#1f2328;word-wrap:break-word;overflow-wrap:break-word;height:auto!important;min-height:0!important;background:transparent}
img{max-width:100%;height:auto}
pre{white-space:pre-wrap}
blockquote{margin:6px 0;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}
p{margin:0 0 .8em}
a{color:#0b62d6}
::selection{background:#b7d3ff}
`

function buildDoc(html: string | null, text: string | null, allowImages: boolean): string {
  const body = html ?? `<div class="moyer-plain">${textToHtml(text ?? '')}</div>`
  const clean = DOMPurify.sanitize(body, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  }) as unknown as string
  const img = allowImages ? 'img-src data: cid: https: http:' : 'img-src data: cid:'
  const csp = `default-src 'none'; ${img}; style-src 'unsafe-inline' https: http:; font-src data: https:; media-src data: https:`
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${BASE_CSS}</style>`
  if (/<head[^>]*>/i.test(clean)) return '<!doctype html>' + clean.replace(/<head[^>]*>/i, (m) => m + head)
  return `<!doctype html><html><head>${head}</head><body>${clean}</body></html>`
}

export interface MailFrameHandle {
  translate(to: string, bilingual: boolean, onProgress: (p: TranslateProgress) => void, signal: { cancelled: boolean }): Promise<string | undefined>
  show(which: 'original' | 'translated'): void
}

interface SelState {
  x: number
  y: number
  text: string
  result?: string
  loading?: boolean
}

export const MailFrame = forwardRef<MailFrameHandle, { html: string | null; text: string | null; allowImages: boolean; onReady?: () => void }>(function MailFrame(
  { html, text, allowImages, onReady },
  ref
) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const original = useMemo(() => buildDoc(html, text, allowImages), [html, text, allowImages])
  const [src, setSrc] = useState(original)
  const translatedRef = useRef<string | null>(null)
  const [sel, setSel] = useState<SelState | null>(null)
  const targetLang = useStore((s) => s.settings?.translate.targetLang ?? 'zh')
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    setSrc(original)
    translatedRef.current = null
    setSel(null)
  }, [original])

  const fit = useCallback(() => {
    const f = frameRef.current
    const d = f?.contentDocument
    if (!f || !d?.documentElement) return
    const h = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0)
    f.style.height = `${h + 2}px`
    // 手机上在正文里右滑也能拉出侧栏（图片加载完宽度可能变，所以每次重新量）
    attachSwipe(d)
  }, [])

  const roRef = useRef<ResizeObserver | null>(null)
  useEffect(() => () => roRef.current?.disconnect(), [])

  const onLoad = useCallback(() => {
    const f = frameRef.current
    const d = f?.contentDocument
    if (!f || !d) return
    fit()
    roRef.current?.disconnect()
    const ro = new ResizeObserver(() => fit())
    roRef.current = ro
    if (d.body) ro.observe(d.body)
    d.addEventListener('load', fit, true)
    // 邮件里的 mailto 链接直接在本软件写信
    d.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a')
      const href = a?.getAttribute('href') ?? ''
      if (href.toLowerCase().startsWith('mailto:')) {
        e.preventDefault()
        const addr = decodeURIComponent(href.slice(7).split('?')[0])
        const parsed = parseAddressInput(addr)
        openComposer({ mode: 'new', to: parsed ? [parsed] : [] })
      }
    })
    // 划词翻译
    d.addEventListener('mousedown', () => setSel(null))
    d.addEventListener('mouseup', () => {
      setTimeout(() => {
        const s = d.getSelection()
        const t = s?.toString().trim() ?? ''
        if (!s || !t || t.length > 4000 || s.rangeCount === 0) return
        const r = s.getRangeAt(0).getBoundingClientRect()
        const fr = f.getBoundingClientRect()
        setSel({ x: fr.left + r.left + r.width / 2, y: fr.top + r.bottom + 8, text: t })
      }, 0)
    })
    readyRef.current?.()
  }, [fit])

  useImperativeHandle(
    ref,
    () => ({
      async translate(to, bilingual, onProgress, signal) {
        const d = frameRef.current?.contentDocument
        if (!d?.body) return undefined
        const detected = await translateElement(d.body, to, { bilingual, onProgress, signal })
        if (!signal.cancelled) translatedRef.current = '<!doctype html>' + d.documentElement.outerHTML
        fit()
        return detected
      },
      show(which) {
        if (which === 'original') setSrc(original)
        else if (translatedRef.current) setSrc(translatedRef.current)
      }
    }),
    [original, fit]
  )

  // 滚动时收起划词气泡
  useEffect(() => {
    if (!sel) return
    const close = () => setSel(null)
    const scroller = frameRef.current?.closest('.reader-scroll')
    scroller?.addEventListener('scroll', close, { once: true })
    return () => scroller?.removeEventListener('scroll', close)
  }, [sel])

  const doTranslateSel = async () => {
    if (!sel) return
    setSel({ ...sel, loading: true })
    try {
      const r = await translateText(sel.text, targetLang)
      setSel((s) => (s ? { ...s, loading: false, result: r.text } : s))
    } catch (err) {
      setSel(null)
      toast((err as Error).message, 'error')
    }
  }

  return (
    <div className="paper">
      <iframe
        ref={frameRef}
        title="邮件正文"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={src}
        onLoad={onLoad}
      />
      {sel && !sel.result && (
        <button
          className="btn primary sel-btn pop"
          style={{ left: Math.min(sel.x - 30, window.innerWidth - 90), top: Math.min(sel.y, window.innerHeight - 40) }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={doTranslateSel}
        >
          {sel.loading ? <LoaderCircle size={14} className="spin" /> : <Languages size={14} />}
          翻译
        </button>
      )}
      {sel?.result && (
        <div
          className="sel-pop glass-strong pop"
          style={{ left: Math.max(8, Math.min(sel.x - 170, window.innerWidth - 350)), top: Math.min(sel.y, window.innerHeight - 200) }}
        >
          <div style={{ whiteSpace: 'pre-wrap' }}>{sel.result}</div>
          <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(sel.result ?? '')
                toast('已复制', 'ok')
              }}
            >
              <Copy size={13} />
              复制
            </button>
            <button className="btn sm" onClick={() => setSel(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  )
})

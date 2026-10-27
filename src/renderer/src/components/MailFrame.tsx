import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { Copy, Languages, LoaderCircle } from 'lucide-react'
import { api } from '../api'
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

/** 缩小到这么小还放不下，就不再缩了（字太小没法看），剩下的部分左右拖着看 */
const MIN_FIT_ZOOM = 0.35

/**
 * 邮件比显示区域宽（很多邮件是固定 600～700 像素宽的表格，手机屏幕只有 300 多），
 * 就把整封邮件按比例缩小到刚好放下，不用左右拖。
 * 用 CSS zoom 而不是 transform：zoom 会参与排版，高度也跟着变小，正文框不会留出大片空白。
 */
function fitWidth(d: Document) {
  const root = d.documentElement
  const body = d.body
  if (!root || !body) return
  // 用户双指放大过，就按用户的来，不再自动缩回去
  if (userZoomOf(body) > 1) return
  // 缩放后排版会变（比如外面出现滚动条、显示区域窄了一点），所以量完再校正，最多三次
  for (let i = 0; i < 3; i++) {
    const avail = root.clientWidth
    if (!avail) return
    const current = fitZoomOf(body)
    const overflow = root.scrollWidth > avail + 1
    // 现在占的宽度除以当前缩放，就是不缩放时的宽度
    const natural = root.scrollWidth / current
    const want = Math.max(MIN_FIT_ZOOM, Math.min(1, (avail / natural) * 0.995))
    // 放得下时，变化很小就不动（免得和 ResizeObserver 来回触发）；放不下时一定缩
    if (!overflow && Math.abs(want - current) < 0.02) return
    if (Math.abs(want - current) < 0.001) return
    body.dataset.fitZoom = String(want)
    applyZoom(body)
  }
}

// ---------------- 双指缩放 ----------------
/** 双指放大最多到原始大小的 3 倍；最小就是自动适应屏幕宽度的大小 */
const MAX_ZOOM = 3

const fitZoomOf = (body: HTMLElement) => Number(body.dataset.fitZoom || 1)
const userZoomOf = (body: HTMLElement) => Number(body.dataset.userZoom || 1)

/** 实际缩放 = 自动适应宽度的缩放 × 用户双指缩放（都记在 body 上，切换原文 / 译文时跟着保留） */
function applyZoom(body: HTMLElement) {
  const z = fitZoomOf(body) * userZoomOf(body)
  body.style.zoom = Math.abs(z - 1) < 0.001 ? '' : String(z)
}

/**
 * 把用户缩放改成 user，并让手指中间（cx, cy，正文框里的坐标）那一点留在原处。
 * 横向由正文自己滚动（放大后比屏幕宽），纵向由外面的阅读区滚动（正文框高度跟着内容变）。
 */
function zoomAround(d: Document, frame: HTMLIFrameElement, user: number, cx: number, cy: number, relayout: () => void) {
  const body = d.body
  const se = d.scrollingElement
  if (!body || !se) return
  const fitZ = fitZoomOf(body)
  const next = Math.max(1, Math.min(user, MAX_ZOOM / fitZ))
  const before = fitZ * userZoomOf(body)
  const after = fitZ * next
  if (Math.abs(after - before) < 0.001) return
  // 手指下面那一点在“不缩放的邮件”里的位置
  const px = (se.scrollLeft + cx) / before
  const py = cy / before
  body.dataset.userZoom = String(next)
  applyZoom(body)
  relayout()
  se.scrollLeft = px * after - cx
  const outer = frame.closest('.reader-scroll')
  if (outer) outer.scrollTop += py * (after - before)
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
    fitWidth(d)
    // 用正文实际的下边缘算高度：scrollHeight 不会小于正文框当前的高度，缩小后的邮件量出来会偏高、下面留一大片空白
    const h = d.body ? Math.ceil(d.body.getBoundingClientRect().bottom + (d.defaultView?.scrollY ?? 0)) : d.documentElement.scrollHeight
    f.style.height = `${h + 2}px`
    // 手机上在正文里右滑也能拉出侧栏（图片加载完宽度可能变，所以每次重新量）
    attachSwipe(d)
  }, [])

  const roRef = useRef<ResizeObserver | null>(null)
  useEffect(() => () => roRef.current?.disconnect(), [])
  /** 已经挂好监听的正文文档（同一份文档只挂一次） */
  const setUp = useRef(new WeakSet<Document>())

  /**
   * 正文一解析完就调用（不等图片）：把高度撑到内容实际高度、挂上各种监听。
   * 以前要等 iframe 的 load 事件——它要等邮件里所有远程图片下载完，
   * 这期间正文框只有默认的 150 像素高，看起来就像“还在加载”。
   */
  const setUpDoc = useCallback((d: Document) => {
    const f = frameRef.current
    if (!f) return
    fit()
    if (setUp.current.has(d)) return
    setUp.current.add(d)
    roRef.current?.disconnect()
    // 图片陆续加载、字体换上时内容会变高，跟着调整
    const ro = new ResizeObserver(() => fit())
    roRef.current = ro
    if (d.body) ro.observe(d.body)
    d.addEventListener('load', fit, true)
    // 双指缩放（手机）：两根手指捏合 / 张开。手势自己处理，不交给浏览器（浏览器会把整个应用一起缩放）
    let pinch: { dist: number; user: number } | null = null
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    d.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2 && d.body) pinch = { dist: spread(e.touches) || 1, user: userZoomOf(d.body) }
      },
      { passive: true }
    )
    d.addEventListener(
      'touchmove',
      (e) => {
        if (!pinch || e.touches.length !== 2) return
        if (e.cancelable) e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        zoomAround(d, f, (pinch.user * spread(e.touches)) / pinch.dist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, fit)
      },
      { passive: false }
    )
    const endPinch = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
    }
    d.addEventListener('touchend', endPinch, { passive: true })
    d.addEventListener('touchcancel', endPinch, { passive: true })
    // 电脑：触控板双指捏合（浏览器里表现为按住 Ctrl 的滚轮），或者 Ctrl + 鼠标滚轮
    d.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey || !d.body) return
        e.preventDefault()
        // 触控板捏合每次只有很小的 deltaY；鼠标滚轮一格是 100 左右，限一下幅度，每格最多放大约 1.27 倍
        const step = Math.max(-30, Math.min(30, e.deltaY))
        zoomAround(d, f, userZoomOf(d.body) * Math.exp(-step * 0.008), e.clientX, e.clientY, fit)
      },
      { passive: false }
    )
    // 点邮件里的链接：mailto 直接在本软件写信，网址用系统浏览器打开。
    // （链接带 target=_blank，手机上的 WebView 不支持弹新窗口，不拦下来的话点了没反应）
    d.addEventListener('click', (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href], area[href]')
      if (!a) return
      let href = (a.getAttribute('href') ?? '').trim()
      if (href.startsWith('//')) href = 'https:' + href
      if (/^mailto:/i.test(href)) {
        e.preventDefault()
        const addr = decodeURIComponent(href.slice(7).split('?')[0])
        const parsed = parseAddressInput(addr)
        openComposer({ mode: 'new', to: parsed ? [parsed] : [] })
      } else if (/^https?:\/\//i.test(href)) {
        e.preventDefault()
        void api.openExternal(href).catch((err) => toast((err as Error).message, 'error'))
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

  // 换了正文（打开新邮件、切换原文 / 译文）后，等新文档解析出来就立刻排版，不等图片
  useEffect(() => {
    const before = frameRef.current?.contentDocument ?? null
    const start = performance.now()
    let raf = 0
    const check = () => {
      const d = frameRef.current?.contentDocument
      // 旧文档（已经排过版的那份）不算；第一次打开时文档可能已经先解析好了，也要接上
      const fresh = d && (d !== before || !setUp.current.has(d))
      if (d && fresh && d.URL === 'about:srcdoc' && d.readyState !== 'loading' && d.body) return setUpDoc(d)
      if (performance.now() - start < 5000) raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [src, setUpDoc])

  // 兜底：图片全部加载完时再量一次
  const onLoad = useCallback(() => {
    const d = frameRef.current?.contentDocument
    if (d) setUpDoc(d)
  }, [setUpDoc])

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

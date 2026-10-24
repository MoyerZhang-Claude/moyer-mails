import DOMPurify from 'dompurify'
import { api } from './api'

// 邮件 HTML 的“按段翻译”：把正文拆成一个个块（段落、单元格、列表项……），
// 每块连同其中的链接、加粗等标签一起翻译，再原地替换。这样排版不会乱。

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
  'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
])
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'SVG', 'HEAD', 'TITLE', 'TEXTAREA', 'SELECT', 'OPTION', 'IMG', 'VIDEO', 'AUDIO'])
const BLOCK_SELECTOR = [...BLOCK].map((t) => t.toLowerCase()).join(',')
const HAS_WORDS = /\p{L}{2,}/u

function containsBlock(el: Element) {
  return el.querySelector(BLOCK_SELECTOR) !== null
}

/** 找出所有待翻译的块 */
export function collectSegments(root: HTMLElement): HTMLElement[] {
  const doc = root.ownerDocument
  const out: HTMLElement[] = []

  const visit = (el: HTMLElement) => {
    if (SKIP.has(el.tagName) || el.hasAttribute('data-mt-tr')) return
    let run: Node[] = []
    const flush = () => {
      if (run.length && run.some((n) => HAS_WORDS.test(n.textContent ?? ''))) {
        const whole = run.length === el.childNodes.length && el !== root && BLOCK.has(el.tagName)
        if (whole) out.push(el)
        else {
          const wrap = doc.createElement('font')
          wrap.setAttribute('data-mt', '')
          el.insertBefore(wrap, run[0])
          for (const n of run) wrap.appendChild(n)
          out.push(wrap)
        }
      }
      run = []
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) run.push(child)
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as HTMLElement
        if (SKIP.has(c.tagName)) {
          if (c.tagName === 'IMG') run.push(c)
          else flush()
        } else if (BLOCK.has(c.tagName) || containsBlock(c)) {
          flush()
          visit(c)
        } else run.push(c)
      }
    }
    flush()
  }
  visit(root)
  return out
}

function chunkSegments(segs: HTMLElement[], maxChars: number): HTMLElement[][] {
  const groups: HTMLElement[][] = []
  let cur: HTMLElement[] = []
  let size = 0
  for (const s of segs) {
    const len = s.innerHTML.length
    if (cur.length && (size + len > maxChars || cur.length >= 40)) {
      groups.push(cur)
      cur = []
      size = 0
    }
    cur.push(s)
    size += len
  }
  if (cur.length) groups.push(cur)
  return groups
}

export interface TranslateProgress {
  done: number
  total: number
}

/**
 * 原地翻译一个文档（或编辑器节点）。分批并发请求，翻好一批显示一批。
 * 返回识别出的原文语言。
 */
export async function translateElement(
  root: HTMLElement,
  to: string,
  opts: { bilingual?: boolean; onProgress?: (p: TranslateProgress) => void; signal?: { cancelled: boolean } } = {}
): Promise<string | undefined> {
  const segs = collectSegments(root)
  const groups = chunkSegments(segs, 3500)
  let done = 0
  let detected: string | undefined
  opts.onProgress?.({ done, total: segs.length })
  let next = 0
  const worker = async () => {
    while (next < groups.length) {
      const g = groups[next++]
      if (opts.signal?.cancelled) return
      const res = await api.translate({ texts: g.map((s) => s.innerHTML), to, format: 'html' })
      if (opts.signal?.cancelled) return
      detected ??= res.detected
      g.forEach((seg, i) => {
        const html = DOMPurify.sanitize(res.texts[i] ?? '', { FORBID_TAGS: ['style', 'script', 'form', 'input'] })
        if (opts.bilingual) {
          const tr = seg.ownerDocument.createElement(seg.tagName === 'FONT' ? 'div' : 'div')
          tr.setAttribute('data-mt-tr', '')
          tr.setAttribute('style', 'color:#2f5fb3;border-left:3px solid #9db8ef;padding:2px 0 2px 8px;margin:4px 0 8px;font-size:0.96em')
          tr.innerHTML = html
          if (seg.tagName === 'FONT') seg.after(tr)
          else seg.appendChild(tr)
        } else seg.innerHTML = html
      })
      done += g.length
      opts.onProgress?.({ done, total: segs.length })
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return detected
}

/** 去掉翻译时加的临时包裹标签（写信时用，避免发出去的邮件里带多余标签） */
export function unwrapMarkers(root: HTMLElement) {
  root.querySelectorAll('font[data-mt]').forEach((el) => el.replaceWith(...Array.from(el.childNodes)))
}

/** 翻译一段纯文本（划词、标题用） */
export async function translateText(text: string, to: string) {
  const res = await api.translate({ texts: [text], to, format: 'text' })
  return { text: res.texts[0] ?? '', detected: res.detected }
}

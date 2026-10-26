// 手势（窄屏 / 手机）：右滑打开侧栏，侧栏打开时左滑关闭。
// 在列表上、读信时都可以（读信时在邮件正文里滑也行：MailFrame 会把正文 iframe 交给 attachSwipe）。
// 侧栏跟着手指走，松手时按滑动距离和速度决定开还是关。
// 返回上一级（关掉正在读的邮件）用手机系统自带的边缘返回手势，见 native.ts 的返回键处理。
import { useStore } from './store'

/** 侧栏变成抽屉的宽度（和 styles.css 里的断点一致） */
const DRAWER_QUERY = '(max-width: 860px)'
/** 阅读区盖住整个列表的宽度 */
const READER_OVERLAY_QUERY = '(max-width: 640px)'
/** 列表界面上这些地方的滑动留给它们自己 */
const IGNORE = 'input, textarea, select, [contenteditable="true"], .reader, .overlay, .composer-wrap, .mini-composers, .no-swipe'
const EDITABLE = 'input, textarea, select, [contenteditable="true"]'
/** 手指移动超过这么多像素才判断是横滑还是竖滑 */
const SLOP = 10
/** 甩得比这个快（像素 / 毫秒）就按甩的方向算，不看距离 */
const FLING = 0.35
/** 侧栏关闭时的位置：translateX(-110%)，和 CSS 一致 */
const CLOSED = 1.1

/** 一次横滑要拖的东西 */
interface Session {
  /** 1 = 只接受右滑，-1 = 只接受左滑 */
  dir: 1 | -1
  /** 确定是横滑时调用一次 */
  begin(): void
  /** dx：手指横向位移（像素） */
  move(dx: number): void
  /** 松手（或被系统打断）：velocity 像素 / 毫秒，正数往右 */
  end(velocity: number, cancelled: boolean): void
}

function styleOf(el: Element) {
  return (el.ownerDocument.defaultView ?? window).getComputedStyle(el)
}

/**
 * 手指下面有能横向滚动的东西（一排标签、很宽的邮件）就不抢它的滑动。
 * onlyIfScrolled：只在它已经往右滚过（还能往左滚）时才算——读信时用这个，
 * 很宽的邮件先滚回最左边，再右滑才拉出侧栏。
 */
function horizontalScroller(el: Element | null, onlyIfScrolled: boolean): boolean {
  for (let n = el; n; n = n.parentElement) {
    if (n === n.ownerDocument.documentElement) {
      // 邮件正文整页比屏幕宽（iframe 自己能横向滚动）
      const se = n.ownerDocument.scrollingElement
      return !!se && n.ownerDocument !== document && se.scrollWidth > se.clientWidth + 2 && (!onlyIfScrolled || se.scrollLeft > 2)
    }
    const s = styleOf(n)
    // 滚回最左边时常常停在 1 像素左右（小数像素），留 2 像素余量
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 2 && (!onlyIfScrolled || n.scrollLeft > 2)) return true
  }
  return false
}

// ---------------- 侧栏 ----------------
let drawerTimer = 0

/** reading：手机上正打开着一封邮件（阅读区盖住了列表），这时在阅读区里滑也能拉出侧栏 */
function drawerSession(target: Element, open: boolean, reading = false): Session | null {
  if (reading) {
    if (target.closest(EDITABLE) || target.closest('.no-swipe')) return null
    if (horizontalScroller(target, true)) return null
  } else {
    if (!open && target.closest(IGNORE)) return null
    if (horizontalScroller(target, false)) return null
  }
  const sidebar = document.querySelector<HTMLElement>('.sidebar')
  const scrim = document.querySelector<HTMLElement>('.drawer-scrim')
  if (!sidebar) return null
  let closedAt = 0 // 完全关闭时的位移（负数）
  let offset = 0 // 当前位移（0 = 完全打开）
  return {
    dir: open ? -1 : 1,
    begin() {
      window.clearTimeout(drawerTimer)
      closedAt = -sidebar.offsetWidth * CLOSED
      offset = open ? 0 : closedAt
      sidebar.style.transition = 'none'
      if (scrim) {
        scrim.style.transition = 'none'
        scrim.style.visibility = 'visible'
      }
    },
    move(dx) {
      offset = Math.min(0, Math.max(closedAt, open ? dx : closedAt + dx))
      sidebar.style.transform = `translateX(${offset}px)`
      if (scrim) scrim.style.opacity = String(1 - offset / closedAt)
    },
    end(velocity, cancelled) {
      const progress = 1 - offset / closedAt // 0 = 关，1 = 开
      let next = open
      if (!cancelled) {
        if (velocity > FLING) next = true
        else if (velocity < -FLING) next = false
        else next = open ? progress > 0.65 : progress > 0.35
      }
      // 先动画到最终位置（和 CSS 里开 / 关的位置一样），再交给样式类接管，不会闪
      sidebar.style.transition = ''
      sidebar.style.transform = next ? 'none' : `translateX(-${CLOSED * 100}%)`
      if (scrim) {
        scrim.style.transition = ''
        scrim.style.opacity = next ? '1' : '0'
      }
      useStore.setState({ sidebarOpen: next })
      drawerTimer = window.setTimeout(() => {
        sidebar.style.transform = ''
        if (scrim) {
          scrim.style.opacity = ''
          scrim.style.visibility = ''
        }
      }, 260)
    }
  }
}

// ---------------- 触摸跟踪（主页面和邮件正文 iframe 共用） ----------------
const drawerQuery = window.matchMedia(DRAWER_QUERY)
const readerOverlayQuery = window.matchMedia(READER_OVERLAY_QUERY)
let session: Session | null = null
let mode: 'idle' | 'pending' | 'drag' = 'idle'
let x0 = 0
let y0 = 0
let lastX = 0
let lastT = 0
let velocity = 0

/** 根据手指按下的位置决定这次滑动要不要开 / 关侧栏，不该响应就返回 null */
function pick(target: Element): Session | null {
  if (!drawerQuery.matches) return null
  const s = useStore.getState()
  if (!s.ready || s.dialog || s.composers.some((c) => !c.minimized)) return null
  const inMailBody = target.ownerDocument !== document
  if (s.sidebarOpen) return inMailBody ? null : drawerSession(target, true)
  // 手机上正在读信：阅读区盖住了列表，在上面右滑同样拉出侧栏
  if (s.selectedId != null && readerOverlayQuery.matches) return drawerSession(target, false, true)
  // 平板宽度时阅读区在旁边，在邮件正文里滑不开侧栏
  if (inMailBody) return null
  return drawerSession(target, false)
}

function onStart(e: TouchEvent) {
  mode = 'idle'
  session = null
  // 邮件正文里的元素属于 iframe，不能用 instanceof Element 判断
  const target = e.target as Element | null
  if (e.touches.length !== 1 || !target || target.nodeType !== 1) return
  session = pick(target)
  if (!session) return
  const t = e.touches[0]
  x0 = lastX = t.clientX
  y0 = t.clientY
  lastT = e.timeStamp
  velocity = 0
  mode = 'pending'
}

function onMove(e: TouchEvent) {
  if (mode === 'idle' || !session) return
  const t = e.touches[0]
  const dx = t.clientX - x0
  const dy = t.clientY - y0
  if (mode === 'pending') {
    if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
    // 竖着滑（翻列表、看邮件）或者方向不对：这次不管了
    if (Math.abs(dy) >= Math.abs(dx) || Math.sign(dx) !== session.dir) {
      mode = 'idle'
      return
    }
    mode = 'drag'
    session.begin()
  }
  // 横滑的时候不让内容跟着上下滚
  if (e.cancelable) e.preventDefault()
  const dt = e.timeStamp - lastT
  if (dt > 0) velocity = 0.7 * ((t.clientX - lastX) / dt) + 0.3 * velocity
  lastX = t.clientX
  lastT = e.timeStamp
  session.move(dx)
}

function finish(cancelled: boolean) {
  const s = session
  const dragging = mode === 'drag'
  mode = 'idle'
  session = null
  if (s && dragging) s.end(velocity, cancelled)
}

const onEnd = () => finish(false)
const onCancel = () => finish(true)

function listen(doc: Document) {
  doc.addEventListener('touchstart', onStart, { passive: true })
  doc.addEventListener('touchmove', onMove, { passive: false })
  doc.addEventListener('touchend', onEnd, { passive: true })
  doc.addEventListener('touchcancel', onCancel, { passive: true })
}

function unlisten(doc: Document) {
  doc.removeEventListener('touchstart', onStart)
  doc.removeEventListener('touchmove', onMove)
  doc.removeEventListener('touchend', onEnd)
  doc.removeEventListener('touchcancel', onCancel)
}

/** 在主页面上启用滑动手势；返回取消函数 */
export function setupGestures(): () => void {
  listen(document)
  return () => unlisten(document)
}

const attached = new WeakSet<Document>()

/**
 * 邮件正文在 iframe 里，触摸事件不会冒泡到主页面，所以单独挂上。
 * 正文不比屏幕宽时只让浏览器处理上下滚动和缩放，横滑交给这里（否则慢慢滑时会被浏览器当成滚动接走）。
 */
export function attachSwipe(doc: Document) {
  const root = doc.documentElement
  if (root) root.style.touchAction = root.scrollWidth > root.clientWidth + 2 ? '' : 'pan-y pinch-zoom'
  if (attached.has(doc)) return
  attached.add(doc)
  listen(doc)
}

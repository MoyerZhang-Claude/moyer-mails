// 手势：窄屏（手机）上左右滑动开关侧栏。
// 右滑打开、左滑关闭；侧栏跟着手指走，松手时按滑动距离和速度决定开还是关。
import { useStore } from './store'

/** 侧栏变成抽屉的宽度（和 styles.css 里的断点一致） */
const DRAWER_QUERY = '(max-width: 860px)'
/** 阅读区盖住整个列表的宽度 */
const READER_OVERLAY_QUERY = '(max-width: 640px)'
/** 这些地方的滑动留给它们自己 */
const IGNORE = 'input, textarea, select, [contenteditable="true"], .reader, .overlay, .composer-wrap, .mini-composers, .no-swipe'
/** 手指移动超过这么多像素才判断是横滑还是竖滑 */
const SLOP = 10
/** 关闭状态的位置：translateX(-110%)，和 CSS 一致 */
const CLOSED = 1.1

/** 手指下面有能横向滚动的东西（比如一排标签）就不抢它的滑动 */
function insideHorizontalScroller(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n)
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 2) return true
  }
  return false
}

export function setupDrawerSwipe(): () => void {
  const drawer = window.matchMedia(DRAWER_QUERY)
  const readerOverlay = window.matchMedia(READER_OVERLAY_QUERY)
  let mode: 'idle' | 'pending' | 'drag' = 'idle'
  let wasOpen = false
  let x0 = 0
  let y0 = 0
  let lastX = 0
  let lastT = 0
  let velocity = 0 // 像素 / 毫秒，正数表示往右
  let offset = 0 // 侧栏当前的位移（像素，0 = 完全打开）
  let closedAt = 0 // 完全关闭时的位移（负数）
  let sidebar: HTMLElement | null = null
  let scrim: HTMLElement | null = null
  let cleanupTimer = 0

  const onStart = (e: TouchEvent) => {
    mode = 'idle'
    if (!drawer.matches || e.touches.length !== 1) return
    const s = useStore.getState()
    if (!s.ready || s.dialog || s.composers.some((c) => !c.minimized)) return
    const target = e.target as Element
    wasOpen = s.sidebarOpen
    if (!wasOpen) {
      if (target.closest(IGNORE)) return
      // 手机上打开着一封邮件时，阅读区盖住了列表
      if (s.selectedId != null && readerOverlay.matches) return
    }
    if (insideHorizontalScroller(target)) return
    sidebar = document.querySelector<HTMLElement>('.sidebar')
    scrim = document.querySelector<HTMLElement>('.drawer-scrim')
    if (!sidebar) return
    const t = e.touches[0]
    x0 = lastX = t.clientX
    y0 = t.clientY
    lastT = e.timeStamp
    velocity = 0
    mode = 'pending'
  }

  const place = (px: number) => {
    offset = Math.min(0, Math.max(closedAt, px))
    sidebar!.style.transform = `translateX(${offset}px)`
    if (scrim) scrim.style.opacity = String(1 - offset / closedAt)
  }

  const onMove = (e: TouchEvent) => {
    if (mode === 'idle') return
    const t = e.touches[0]
    const dx = t.clientX - x0
    const dy = t.clientY - y0
    if (mode === 'pending') {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
      // 竖着滑（翻列表）或者方向不对：这次不管了
      if (Math.abs(dy) >= Math.abs(dx) || (wasOpen ? dx > 0 : dx < 0)) {
        mode = 'idle'
        return
      }
      mode = 'drag'
      window.clearTimeout(cleanupTimer)
      closedAt = -sidebar!.offsetWidth * CLOSED
      sidebar!.style.transition = 'none'
      if (scrim) {
        scrim.style.transition = 'none'
        scrim.style.visibility = 'visible'
      }
    }
    // 横滑的时候不让列表跟着上下滚
    if (e.cancelable) e.preventDefault()
    const dt = e.timeStamp - lastT
    if (dt > 0) velocity = 0.7 * ((t.clientX - lastX) / dt) + 0.3 * velocity
    lastX = t.clientX
    lastT = e.timeStamp
    place(wasOpen ? dx : closedAt + dx)
  }

  const finish = (cancelled: boolean) => {
    if (mode !== 'drag') {
      mode = 'idle'
      return
    }
    mode = 'idle'
    const progress = 1 - offset / closedAt // 0 = 关，1 = 开
    let open = wasOpen
    if (!cancelled) {
      if (velocity > 0.35) open = true
      else if (velocity < -0.35) open = false
      else open = wasOpen ? progress > 0.65 : progress > 0.35
    }
    // 先把侧栏动画到最终位置（和 CSS 里开 / 关的位置一样），再交给样式类接管，不会闪
    const el = sidebar!
    const sc = scrim
    el.style.transition = ''
    el.style.transform = open ? 'none' : `translateX(-${CLOSED * 100}%)`
    if (sc) {
      sc.style.transition = ''
      sc.style.opacity = open ? '1' : '0'
    }
    useStore.setState({ sidebarOpen: open })
    cleanupTimer = window.setTimeout(() => {
      el.style.transform = ''
      if (sc) {
        sc.style.opacity = ''
        sc.style.visibility = ''
      }
    }, 260)
  }

  const onEnd = () => finish(false)
  const onCancel = () => finish(true)

  document.addEventListener('touchstart', onStart, { passive: true })
  document.addEventListener('touchmove', onMove, { passive: false })
  document.addEventListener('touchend', onEnd, { passive: true })
  document.addEventListener('touchcancel', onCancel, { passive: true })
  return () => {
    document.removeEventListener('touchstart', onStart)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
    document.removeEventListener('touchcancel', onCancel)
  }
}

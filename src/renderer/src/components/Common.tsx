import { useEffect, useRef, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { findPreset } from '@shared/presets'
import type { Address } from '@shared/types'
import { useStore } from '../store'
import { avatarColor, cx, initial } from '../util'

export function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" className={cx('switch', on && 'on')} onClick={() => onChange(!on)} disabled={disabled} aria-pressed={on} />
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Avatar({ addr, size, unread }: { addr: Address | null; size?: number; unread?: boolean }) {
  const key = addr?.address || addr?.name || '?'
  return (
    <div className="avatar" style={{ background: avatarColor(key), ...(size ? { width: size, height: size, fontSize: size * 0.4 } : {}) }}>
      {initial(addr)}
      {unread && <span className="unread-dot" />}
    </div>
  )
}

export function ProviderLogo({ id, size = 38 }: { id: string; size?: number }) {
  const p = findPreset(id)
  return (
    <div className="logo" style={{ background: p.color, width: size, height: size, fontSize: p.short.length > 2 ? size * 0.3 : size * 0.38, borderRadius: size * 0.29 }}>
      {p.short}
    </div>
  )
}

/** 通用对话框：点遮罩或按 Esc 关闭 */
export function Modal({ title, onClose, children, footer, wide, icon }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; icon?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx('dialog pop', wide && 'wide')} role="dialog">
        <div className="dialog-head">
          {icon}
          <h3>{title}</h3>
          <button className="btn icon" onClick={onClose} title="关闭 (Esc)">
            <X size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog() {
  const dialog = useStore((s) => s.dialog)
  if (dialog?.kind !== 'confirm') return null
  const close = (v: boolean) => {
    useStore.setState({ dialog: null })
    dialog.resolve(v)
  }
  return (
    <Modal
      title="请确认"
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn outline" onClick={() => close(false)}>
            取消
          </button>
          <button className={cx('btn', dialog.danger ? 'danger filled' : 'primary')} onClick={() => close(true)} autoFocus>
            {dialog.ok}
          </button>
        </>
      }
    >
      <div className="dialog-body" style={{ fontSize: 14 }}>
        {dialog.text}
      </div>
    </Modal>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast glass-strong', t.kind)}>
          {t.kind === 'ok' ? <CircleCheck size={16} /> : t.kind === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

/** 右键菜单 */
export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  onClick: () => void
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | 'sep')[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', close)
    }
  }, [onClose])
  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - items.length * 34 - 16)
  return (
    <div className="suggest pop" style={{ position: 'fixed', left, top, width: 190, zIndex: 70 }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '4px 6px' }} />
        ) : (
          <div
            key={i}
            className="row"
            style={{ color: it.danger ? 'var(--danger)' : undefined, gap: 9 }}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon}
            {it.label}
          </div>
        )
      )}
    </div>
  )
}

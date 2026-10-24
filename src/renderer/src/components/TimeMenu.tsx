import { useEffect, useRef, useState } from 'react'
import { formatWhen } from '../store'

export interface TimePreset {
  label: string
  at: number
}

function at(daysFromToday: number, hour: number, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() + daysFromToday)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

/** 稍后提醒的常用时间 */
export function snoozePresets(): TimePreset[] {
  const now = new Date()
  const list: TimePreset[] = [{ label: '1 小时后', at: Date.now() + 3600_000 }]
  if (now.getHours() < 18) list.push({ label: '今天晚上', at: at(0, 20) })
  list.push({ label: '明天早上', at: at(1, 8) })
  list.push({ label: '明天下午', at: at(1, 14) })
  const dow = now.getDay()
  if (dow >= 1 && dow <= 4) list.push({ label: '这周六', at: at(6 - dow, 9) })
  list.push({ label: '下周一早上', at: at(((8 - dow) % 7) || 7, 8) })
  return list
}

/** 定时发送的常用时间 */
export function sendPresets(): TimePreset[] {
  const now = new Date()
  const list: TimePreset[] = []
  if (now.getHours() < 7) list.push({ label: '今天早上', at: at(0, 8) })
  list.push({ label: '明天早上', at: at(1, 8) })
  list.push({ label: '明天下午', at: at(1, 14) })
  const dow = now.getDay()
  list.push({ label: '下周一早上', at: at(((8 - dow) % 7) || 7, 8) })
  return list
}

function toLocalInput(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 选择时间的小弹窗：常用时间 + 自定义 */
export function TimeMenu({
  title,
  presets,
  onPick,
  onClose,
  style,
  extra
}: {
  title: string
  presets: TimePreset[]
  onPick: (ts: number) => void
  onClose: () => void
  style?: React.CSSProperties
  extra?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [custom, setCustom] = useState(toLocalInput(Date.now() + 3 * 3600_000))
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  const pick = (ts: number) => {
    onClose()
    onPick(ts)
  }
  return (
    <div ref={ref} className="suggest pop time-menu" style={{ width: 250, zIndex: 70, ...style }}>
      <div className="time-menu-title">{title}</div>
      {presets.map((p) => (
        <div key={p.label} className="row" style={{ justifyContent: 'space-between' }} onClick={() => pick(p.at)}>
          <span>{p.label}</span>
          <span className="faint" style={{ fontSize: 12 }}>
            {formatWhen(p.at)}
          </span>
        </div>
      ))}
      <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '4px 6px' }} />
      <div className="row" style={{ cursor: 'default', gap: 6 }} onClick={(e) => e.stopPropagation()}>
        <input type="datetime-local" className="input" style={{ height: 30, fontSize: 12.5, padding: '0 6px' }} value={custom} onChange={(e) => setCustom(e.target.value)} />
        <button
          className="btn soft sm"
          onClick={() => {
            const ts = new Date(custom).getTime()
            if (Number.isFinite(ts) && ts > Date.now()) pick(ts)
          }}
        >
          确定
        </button>
      </div>
      {extra}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Address } from '@shared/types'
import { api } from '../api'
import { cx, formatAddress, isValidEmail, parseAddressInput } from '../util'

export function RecipientInput({ value, onChange, autoFocus, placeholder }: { value: Address[]; onChange: (v: Address[]) => void; autoFocus?: boolean; placeholder?: string }) {
  const [text, setText] = useState('')
  const [sugs, setSugs] = useState<Address[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => {
    const q = text.trim()
    if (!q) {
      setSugs([])
      return
    }
    const my = ++seq.current
    const t = setTimeout(async () => {
      const list = await api.suggestContacts(q).catch(() => [])
      if (my === seq.current) {
        setSugs(list.filter((a) => !value.some((v) => v.address.toLowerCase() === a.address.toLowerCase())))
        setActive(0)
      }
    }, 90)
    return () => clearTimeout(t)
  }, [text, value])

  const add = (list: Address[]) => {
    const seen = new Set(value.map((v) => v.address.toLowerCase()))
    const fresh = list.filter((a) => a.address && !seen.has(a.address.toLowerCase()))
    if (fresh.length) onChange([...value, ...fresh])
    setText('')
    setSugs([])
  }

  const commit = () => {
    const parts = text
      .split(/[,;，；\n]+/)
      .map(parseAddressInput)
      .filter((a): a is Address => !!a)
    if (parts.length) add(parts)
  }

  return (
    <div className="recips-input" onClick={() => inputRef.current?.focus()}>
      {value.map((a, i) => (
        <span key={a.address + i} className={cx('r-chip', !isValidEmail(a.address) && 'bad')} title={formatAddress(a)}>
          <span className="ellipsis">{a.name || a.address}</span>
          <button type="button" onClick={() => onChange(value.filter((_, k) => k !== i))}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={text}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value
          if (/[,;，；]$/.test(v)) {
            setText(v)
            setTimeout(() => {
              const parts = v.split(/[,;，；]+/).map(parseAddressInput).filter((a): a is Address => !!a)
              add(parts)
            })
          } else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && sugs.length) {
            e.preventDefault()
            setActive((a) => (a + 1) % sugs.length)
          } else if (e.key === 'ArrowUp' && sugs.length) {
            e.preventDefault()
            setActive((a) => (a - 1 + sugs.length) % sugs.length)
          } else if ((e.key === 'Enter' || e.key === 'Tab') && sugs.length && text.trim()) {
            e.preventDefault()
            add([sugs[active]])
          } else if (e.key === 'Enter' && text.trim()) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1))
          } else if (e.key === 'Escape' && sugs.length) {
            e.stopPropagation()
            setSugs([])
          }
        }}
        onBlur={() => setTimeout(commit, 120)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text')
          if (/[,;，；\n]/.test(t)) {
            e.preventDefault()
            add(t.split(/[,;，；\n]+/).map(parseAddressInput).filter((a): a is Address => !!a))
          }
        }}
      />
      {sugs.length > 0 && (
        <div className="suggest pop">
          {sugs.map((s, i) => (
            <div key={s.address} className={cx(i === active && 'on')} onMouseDown={(e) => (e.preventDefault(), add([s]))}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name || s.address.split('@')[0]}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                {s.address}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

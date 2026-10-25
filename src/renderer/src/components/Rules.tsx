import { useEffect, useState } from 'react'
import { LoaderCircle, Pencil, Play, Plus, Trash2, Wand, X } from 'lucide-react'
import type { AccountConfig, Rule, RuleCondition, RuleField, RuleOp } from '@shared/types'
import { api } from '../api'
import { confirmDialog, errorText, toast, useStore } from '../store'
import { Modal, Segmented, Switch } from './Common'

const FIELDS: { value: RuleField; label: string }[] = [
  { value: 'from', label: '发件人' },
  { value: 'to', label: '收件人' },
  { value: 'subject', label: '主题' }
]

const OPS: { value: RuleOp; label: string }[] = [
  { value: 'contains', label: '包含' },
  { value: 'notContains', label: '不包含' },
  { value: 'equals', label: '等于' },
  { value: 'startsWith', label: '开头是' },
  { value: 'endsWith', label: '结尾是' }
]

const MOVES: { value: string; label: string }[] = [
  { value: '', label: '不移动' },
  { value: 'archive', label: '移到归档' },
  { value: 'junk', label: '移到垃圾邮件' },
  { value: 'trash', label: '移到已删除' }
]

export function emptyRule(preset?: Partial<Rule>): Rule {
  return {
    id: '',
    name: '',
    enabled: true,
    accountId: null,
    match: 'all',
    conditions: [{ field: 'from', op: 'contains', value: '' }],
    actions: { markRead: true },
    ...preset
  }
}

/** 把规则写成一句话，方便在列表里一眼看懂 */
export function describeRule(rule: Rule, accounts: AccountConfig[]): string {
  const conds = rule.conditions
    .filter((c) => c.value.trim())
    .map((c) => `${FIELDS.find((f) => f.value === c.field)?.label}${OPS.find((o) => o.value === c.op)?.label}“${c.value.trim()}”`)
    .join(rule.match === 'all' ? ' 并且 ' : ' 或者 ')
  const acts: string[] = []
  if (rule.actions.markRead) acts.push('标为已读')
  if (rule.actions.flag) acts.push('加星标')
  if (rule.actions.move) acts.push(MOVES.find((m) => m.value === rule.actions.move)?.label ?? '')
  if (rule.actions.silent && !rule.actions.markRead && !rule.actions.move) acts.push('不弹通知')
  const acc = rule.accountId ? accounts.find((a) => a.id === rule.accountId)?.label : null
  return `${acc ? `[${acc}] ` : ''}${conds || '（没有条件）'} → ${acts.join('、') || '（没有动作）'}`
}

export function RuleEditor({ initial, onDone, onCancel }: { initial: Rule; onDone: (saved: Rule) => void; onCancel: () => void }) {
  const accounts = useStore((s) => s.accounts)
  const [rule, setRule] = useState<Rule>(initial)
  const [busy, setBusy] = useState<'save' | 'run' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const setCond = (i: number, patch: Partial<RuleCondition>) =>
    setRule((r) => ({ ...r, conditions: r.conditions.map((c, k) => (k === i ? { ...c, ...patch } : c)) }))

  const save = async (runNow: boolean) => {
    const conditions = rule.conditions.filter((c) => c.value.trim())
    if (!conditions.length) return setError('至少填写一个条件')
    const a = rule.actions
    if (!a.markRead && !a.flag && !a.move && !a.silent) return setError('至少选择一个动作')
    setBusy(runNow ? 'run' : 'save')
    setError(null)
    try {
      const saved = await api.saveRule({ ...rule, conditions, name: rule.name.trim() || describeRule({ ...rule, conditions }, []).split(' → ')[0] })
      if (runNow) {
        const n = await api.runRules(saved.id)
        toast(n ? `已处理收件箱里的 ${n} 封邮件` : '收件箱里暂时没有符合条件的邮件', n ? 'ok' : 'info')
      } else toast('规则已保存，之后收到的邮件会自动处理', 'ok')
      onDone(saved)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rule-editor">
      <div className="field">
        <label>规则名称</label>
        <input className="input" value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="例如：GitHub 通知" />
      </div>

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="muted">用于</span>
        <select className="select" style={{ width: 220 }} value={rule.accountId ?? ''} onChange={(e) => setRule({ ...rule, accountId: e.target.value || null })}>
          <option value="">所有邮箱</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="muted">收件箱里新到的邮件，满足</span>
        <Segmented
          value={rule.match}
          options={[
            { value: 'all', label: '全部条件' },
            { value: 'any', label: '任一条件' }
          ]}
          onChange={(match) => setRule({ ...rule, match })}
        />
      </div>

      <div className="rule-conds">
        {rule.conditions.map((c, i) => (
          <div className="row" key={i} style={{ gap: 6 }}>
            <select className="select" style={{ width: 100 }} value={c.field} onChange={(e) => setCond(i, { field: e.target.value as RuleField })}>
              {FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 100 }} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as RuleOp })}>
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              className="input grow"
              value={c.value}
              onChange={(e) => setCond(i, { value: e.target.value })}
              placeholder={c.field === 'subject' ? '例如：验证码' : '例如：@github.com'}
            />
            <button
              className="btn icon sm"
              title="删除这个条件"
              disabled={rule.conditions.length === 1}
              onClick={() => setRule({ ...rule, conditions: rule.conditions.filter((_, k) => k !== i) })}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          className="btn sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setRule({ ...rule, conditions: [...rule.conditions, { field: 'subject', op: 'contains', value: '' }] })}
        >
          <Plus size={14} />
          添加条件
        </button>
      </div>

      <div className="field">
        <label>然后</label>
        <div className="rule-actions">
          <label className="check">
            <input type="checkbox" checked={!!rule.actions.markRead} onChange={(e) => setRule({ ...rule, actions: { ...rule.actions, markRead: e.target.checked } })} />
            标为已读
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rule.actions.flag} onChange={(e) => setRule({ ...rule, actions: { ...rule.actions, flag: e.target.checked } })} />
            加星标
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rule.actions.silent} onChange={(e) => setRule({ ...rule, actions: { ...rule.actions, silent: e.target.checked } })} />
            不弹新邮件通知
          </label>
          <select
            className="select"
            style={{ width: 150 }}
            value={rule.actions.move ?? ''}
            onChange={(e) => setRule({ ...rule, actions: { ...rule.actions, move: (e.target.value || null) as Rule['actions']['move'] } })}
          >
            {MOVES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn outline" onClick={onCancel}>
          取消
        </button>
        <button className="btn outline" onClick={() => save(true)} disabled={!!busy} title="保存后，马上对收件箱里已有的邮件执行一次">
          {busy === 'run' ? <LoaderCircle size={15} className="spin" /> : <Play size={14} />}
          保存并处理现有邮件
        </button>
        <button className="btn primary" onClick={() => save(false)} disabled={!!busy}>
          {busy === 'save' ? <LoaderCircle size={15} className="spin" /> : null}
          保存
        </button>
      </div>
    </div>
  )
}

/** 设置 → 收信规则 */
export function RulesTab() {
  const accounts = useStore((s) => s.accounts)
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [running, setRunning] = useState(false)

  const load = () =>
    api
      .listRules()
      .then(setRules)
      .catch((e) => toast(errorText(e), 'error'))
  useEffect(() => {
    void load()
  }, [])

  if (editing) {
    return (
      <>
        <h4>{editing.id ? '编辑规则' : '新建规则'}</h4>
        <RuleEditor
          initial={editing}
          onCancel={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            void load()
          }}
        />
      </>
    )
  }

  const toggle = async (r: Rule, enabled: boolean) => {
    setRules((list) => list?.map((x) => (x.id === r.id ? { ...x, enabled } : x)) ?? null)
    await api.saveRule({ ...r, enabled }).catch((e) => toast(errorText(e), 'error'))
  }

  const remove = async (r: Rule) => {
    if (!(await confirmDialog(`删除规则“${r.name}”？`, '删除', true))) {
      useStore.setState({ dialog: { kind: 'settings', tab: 'rules' } })
      return
    }
    await api.removeRule(r.id)
    useStore.setState({ dialog: { kind: 'settings', tab: 'rules' } })
  }

  const runAll = async () => {
    setRunning(true)
    try {
      const n = await api.runRules()
      toast(n ? `已处理收件箱里的 ${n} 封邮件` : '收件箱里没有符合规则的邮件', n ? 'ok' : 'info')
    } catch (err) {
      toast(errorText(err), 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <h4>收信规则</h4>
      <div className="hint" style={{ marginBottom: 8, lineHeight: 1.7 }}>
        新邮件到达收件箱时自动处理：比如把各种通知标为已读并归档、给重要联系人加星标。也可以在邮件上右键 →“自动处理此发件人的邮件…”快速创建。
      </div>
      {rules === null ? (
        <LoaderCircle size={18} className="spin" />
      ) : rules.length === 0 ? (
        <div className="empty" style={{ padding: 24, flex: 'none' }}>
          <Wand size={32} />
          <div>还没有规则</div>
        </div>
      ) : (
        rules.map((r) => (
          <div className="acct-row" key={r.id}>
            <Switch on={r.enabled} onChange={(v) => void toggle(r, v)} />
            <div className="grow" style={{ minWidth: 0, opacity: r.enabled ? 1 : 0.55 }}>
              <div style={{ fontWeight: 600 }}>{r.name}</div>
              <div className="hint ellipsis" title={describeRule(r, accounts)}>
                {describeRule(r, accounts)}
              </div>
            </div>
            <button className="btn sm outline" onClick={() => setEditing(r)}>
              <Pencil size={13} />
              编辑
            </button>
            <button className="btn icon sm danger" title="删除" onClick={() => void remove(r)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))
      )}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <button className="btn soft" onClick={() => setEditing(emptyRule())}>
          <Plus size={15} />
          新建规则
        </button>
        {!!rules?.some((r) => r.enabled) && (
          <button className="btn outline" onClick={runAll} disabled={running}>
            {running ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}
            对收件箱现有邮件运行一次
          </button>
        )}
      </div>
    </>
  )
}

/** 从邮件右键菜单打开的独立弹窗 */
export function RuleDialog({ rule, preset }: { rule?: Rule; preset?: Partial<Rule> }) {
  const close = () => useStore.setState({ dialog: null })
  return (
    <Modal title={rule ? '编辑规则' : '新建收信规则'} onClose={close}>
      <div className="dialog-body">
        <RuleEditor initial={rule ?? emptyRule(preset)} onCancel={close} onDone={close} />
      </div>
    </Modal>
  )
}

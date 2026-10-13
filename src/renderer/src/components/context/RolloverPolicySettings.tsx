import { useState, type FormEvent } from 'react'
import { DEFAULT_ROLLOVER_POLICY, type RolloverPolicy } from '@shared/session-context'
import { Button } from '@/components/ui/Button'

const fields = [
  { key: 'contextRatio', label: 'Context threshold (%)', max: 100 },
  { key: 'compactions', label: 'Compactions', max: 1000000 },
  { key: 'wakeups', label: 'Wakeups', max: 1000000 },
  { key: 'turns', label: 'Turns', max: 1000000 },
  { key: 'maxAgeDays', label: 'Maximum context age (days)', max: 3650 }
] as const
function editValues(policy: RolloverPolicy) {
  return { contextRatio: String(policy.contextRatio * 100), compactions: String(policy.compactions), wakeups: String(policy.wakeups), turns: String(policy.turns), maxAgeDays: String(policy.maxAgeDays) }
}

export function RolloverPolicySettings({ policy, onSave }: { policy: RolloverPolicy; onSave: (policy: RolloverPolicy) => Promise<RolloverPolicy> }) {
  const [mode, setMode] = useState(policy.mode)
  const [values, setValues] = useState(() => editValues(policy))
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || !event.currentTarget.reportValidity()) return
    const next: RolloverPolicy = { mode, contextRatio: Number(values.contextRatio) / 100, compactions: Number(values.compactions), wakeups: Number(values.wakeups), turns: Number(values.turns), maxAgeDays: Number(values.maxAgeDays) }
    if (Object.values(values).some(value => !value.trim() || !Number.isFinite(Number(value)) || Number(value) <= 0)) { setFeedback('Enter a positive number for every threshold.'); setError(true); return }
    setSaving(true); setFeedback(''); setError(false)
    try { const saved = await onSave(next); setMode(saved.mode); setValues(editValues(saved)); setFeedback('Conversation continuation settings saved.') }
    catch { setError(true); setFeedback('The settings could not be saved. Check the thresholds and try again.') }
    finally { setSaving(false) }
  }
  return <form onSubmit={event => { void submit(event) }} className="space-y-3" aria-label="Conversation continuation settings">
    <p className="text-sm leading-relaxed text-muted-foreground">These limits control when Commander and Captain continue with fresh context. Conversation history is retained, and changes take effect when the conversation is ready.</p>
    <label className="flex flex-col gap-1 text-sm font-medium">Conversation continuation<select aria-label="Conversation continuation" disabled={saving} value={mode} onChange={event => { setMode(event.target.value as RolloverPolicy['mode']); setFeedback('') }} className="min-h-8 rounded-md border border-input bg-background px-2 py-1"><option value="off">Off</option><option value="observe">Observe</option><option value="on">On</option></select></label>
    <p className="text-sm leading-relaxed text-muted-foreground">{mode === 'off' ? 'Automatic continuation is off. Keep the current context.' : mode === 'observe' ? 'Show reached limits and keep the current context.' : 'Continue with fresh context when the limits are reached and the conversation is ready.'}</p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{fields.map(field => <label key={field.key} className="flex flex-col gap-1 text-sm font-medium">{field.label}<input type="number" aria-label={field.label} required min={field.key === 'contextRatio' || field.key === 'maxAgeDays' ? 0 : 1} max={field.max} step={field.key === 'contextRatio' || field.key === 'maxAgeDays' ? 'any' : 1} disabled={saving} value={values[field.key]} onChange={event => { setValues(current => ({ ...current, [field.key]: event.target.value })); setFeedback('') }} className="min-h-8 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-base" /></label>)}</div>
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button><Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => { setMode(DEFAULT_ROLLOVER_POLICY.mode); setValues(editValues(DEFAULT_ROLLOVER_POLICY)); setFeedback('Defaults restored in this form. Save to apply.'); setError(false) }}>Restore defaults</Button></div>
    {feedback && <p role={error ? 'alert' : 'status'} className={`text-sm leading-relaxed ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{feedback}</p>}
  </form>
}

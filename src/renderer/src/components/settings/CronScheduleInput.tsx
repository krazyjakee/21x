import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { describeCron, isCronShape } from '@shared/scheduled-coordination'

interface CronScheduleInputProps {
  id: string
  value: string
  /** Called only with a well-formed 5-field cron. */
  onChange: (cron: string) => void
  disabled?: boolean
  label?: string
}

/**
 * A 5-field cron text box (#67) with a plain-language reading under it. Only
 * well-formed expressions are passed up, so a half-typed one is never saved.
 */
export function CronScheduleInput({ id, value, onChange, disabled, label = 'Schedule (cron, local time)' }: CronScheduleInputProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const valid = isCronShape(draft)

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        className="font-mono"
        placeholder="0 9 * * 1-5"
        aria-invalid={!valid}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          if (isCronShape(next)) onChange(next.trim())
        }}
      />
      <p className={`text-[11px] ${valid ? 'text-muted-foreground' : 'text-destructive'}`}>
        {valid ? describeCron(draft) : 'Five fields: minute hour day-of-month month day-of-week, for example "0 9 * * 1-5".'}
      </p>
    </div>
  )
}

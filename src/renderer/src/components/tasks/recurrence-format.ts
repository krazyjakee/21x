import type { RecurrencePattern, RecurrencePatternObject } from '@/types'
import { parseCronWeekdays, splitCron } from '@shared/recurrence-cron'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  const last = n % 10
  if (last === 1) return `${n}st`
  if (last === 2) return `${n}nd`
  if (last === 3) return `${n}rd`
  return `${n}th`
}

type CronSchedule =
  | { kind: 'weekly'; days: string; time: string }
  | { kind: 'monthly'; day: number; time: string }
  | { kind: 'interval'; days: string; time: string }
  | { kind: 'daily'; time: string }

function parseCron(cron: string): CronSchedule | null {
  const fields = splitCron(cron)
  if (!fields) return null
  const { time, dayOfMonth, dayOfWeek } = fields

  if (dayOfWeek !== '*') {
    return { kind: 'weekly', days: parseCronWeekdays(dayOfWeek).map(d => DAY_NAMES[d]).join(', '), time }
  }
  if (dayOfMonth !== '*' && !dayOfMonth.startsWith('*/')) {
    return { kind: 'monthly', day: parseInt(dayOfMonth), time }
  }
  if (dayOfMonth.startsWith('*/')) {
    return { kind: 'interval', days: dayOfMonth.slice(2), time }
  }
  return { kind: 'daily', time }
}

/** Full sentence for the task detail view, e.g. "Weekly on Mon, Wed at 09:00". */
export function formatRecurrencePattern(pattern: RecurrencePattern): string {
  if (typeof pattern === 'string') {
    const cron = parseCron(pattern)
    if (!cron) return pattern
    switch (cron.kind) {
      case 'weekly': return `Weekly on ${cron.days} at ${cron.time}`
      case 'monthly': return `Monthly on the ${ordinal(cron.day)} at ${cron.time}`
      case 'interval': return `Every ${parseInt(cron.days)} days at ${cron.time}`
      case 'daily': return `Daily at ${cron.time}`
    }
  }

  const { type, interval, time, weekdays, monthDay } = pattern as RecurrencePatternObject
  let description: string
  if (type === 'daily') {
    description = interval === 1 ? 'Daily' : `Every ${interval} days`
  } else if (type === 'weekly') {
    description = `Weekly on ${weekdays?.map(d => DAY_NAMES[d]).join(', ') || ''}`
  } else if (type === 'monthly') {
    description = `Monthly on the ${ordinal(monthDay ?? 1)}`
  } else {
    description = `Every ${interval} days`
  }
  return `${description} at ${time}`
}

/** Compact label for task list rows, e.g. "Mon, Wed at 09:00". */
export function formatRecurrenceShort(pattern: RecurrencePattern): string {
  if (typeof pattern === 'string') {
    const cron = parseCron(pattern)
    if (!cron) return pattern
    switch (cron.kind) {
      case 'weekly': return `${cron.days} at ${cron.time}`
      case 'monthly': return `${ordinal(cron.day)} at ${cron.time}`
      case 'interval': return `Every ${cron.days}d at ${cron.time}`
      case 'daily': return `Daily at ${cron.time}`
    }
  }

  const p = pattern as RecurrencePatternObject
  if (p.type === 'weekly' && p.weekdays) {
    return `${p.weekdays.map(d => DAY_NAMES[d]).join(', ')} at ${p.time}`
  }
  if (p.type === 'monthly' && p.monthDay) {
    return `${ordinal(p.monthDay)} at ${p.time}`
  }
  if (p.type === 'daily' && p.interval > 1) {
    return `Every ${p.interval}d at ${p.time}`
  }
  return `Daily at ${p.time}`
}

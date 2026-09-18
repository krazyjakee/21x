export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly'

export interface RecurrenceState {
  type: RecurrenceFrequency
  interval: number
  time: string
  weekdays: number[]
  monthDay: number
}

export interface CronFields {
  time: string
  dayOfMonth: string
  dayOfWeek: string
}

/** Splits a 5-field cron string; returns null when it has fewer than 5 fields. */
export function splitCron(cron: string): CronFields | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return null
  const [minute, hour, dayOfMonth, , dayOfWeek] = parts
  return { time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, dayOfMonth, dayOfWeek }
}

/** Expands a cron day-of-week field such as "1-3,5" into day numbers (0 = Sunday). */
export function parseCronWeekdays(dayOfWeek: string): number[] {
  return dayOfWeek.split(',').flatMap(part => {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number)
      const days: number[] = []
      for (let i = start; i <= end; i++) days.push(i)
      return days
    }
    return [parseInt(part)]
  }).filter(n => !isNaN(n))
}

/** Maps a cron string onto the visual recurrence editor controls. */
export function parseCronToState(cron: string): RecurrenceState {
  const fields = splitCron(cron)
  if (!fields) {
    return { type: 'daily', interval: 1, time: '09:00', weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
  }
  const { time, dayOfMonth, dayOfWeek } = fields

  if (dayOfMonth !== '*' && !dayOfMonth.startsWith('*/') && dayOfWeek === '*') {
    return { type: 'monthly', interval: 1, time, weekdays: [1, 2, 3, 4, 5], monthDay: parseInt(dayOfMonth) || 1 }
  }

  if (dayOfWeek !== '*') {
    return { type: 'weekly', interval: 1, time, weekdays: parseCronWeekdays(dayOfWeek), monthDay: 1 }
  }

  const interval = dayOfMonth.startsWith('*/') ? parseInt(dayOfMonth.slice(2)) || 1 : 1
  return { type: 'daily', interval, time, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
}

export function buildCronExpression(
  type: RecurrenceFrequency,
  interval: number,
  time: string,
  weekdays: number[],
  monthDay: number
): string {
  const [hour, minute] = time.split(':').map(s => parseInt(s) || 0)

  switch (type) {
    case 'daily':
      return interval === 1
        ? `${minute} ${hour} * * *`
        : `${minute} ${hour} */${interval} * *`
    case 'weekly':
      return `${minute} ${hour} * * ${[...weekdays].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`
  }
}

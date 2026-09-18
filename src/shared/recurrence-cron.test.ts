import { describe, it, expect } from 'vitest'
import { buildCronExpression, parseCronToState, parseCronWeekdays, splitCron } from './recurrence-cron'

describe('splitCron', () => {
  it('pads time and returns day fields', () => {
    expect(splitCron(' 5 9 * * 1-5 ')).toEqual({ time: '09:05', dayOfMonth: '*', dayOfWeek: '1-5' })
  })

  it('returns null for fewer than five fields', () => {
    expect(splitCron('0 9 * *')).toBeNull()
  })
})

describe('parseCronWeekdays', () => {
  it('expands ranges and lists and drops invalid entries', () => {
    expect(parseCronWeekdays('1-3,5,x')).toEqual([1, 2, 3, 5])
  })
})

describe('parseCronToState', () => {
  it('falls back to weekday defaults for malformed input', () => {
    expect(parseCronToState('bad')).toEqual({ type: 'daily', interval: 1, time: '09:00', weekdays: [1, 2, 3, 4, 5], monthDay: 1 })
  })

  it('parses daily with interval', () => {
    expect(parseCronToState('30 8 */3 * *')).toEqual({ type: 'daily', interval: 3, time: '08:30', weekdays: [1, 2, 3, 4, 5], monthDay: 1 })
  })

  it('parses weekly', () => {
    expect(parseCronToState('0 9 * * 1-3,5')).toMatchObject({ type: 'weekly', time: '09:00', weekdays: [1, 2, 3, 5] })
  })

  it('parses monthly', () => {
    expect(parseCronToState('0 18 15 * *')).toMatchObject({ type: 'monthly', time: '18:00', monthDay: 15 })
  })

  it('prefers weekly when both day-of-month and day-of-week are set', () => {
    expect(parseCronToState('0 9 15 * 1')).toMatchObject({ type: 'weekly', weekdays: [1] })
  })
})

describe('buildCronExpression', () => {
  it('builds daily, interval, weekly and monthly expressions', () => {
    expect(buildCronExpression('daily', 1, '09:05', [], 1)).toBe('5 9 * * *')
    expect(buildCronExpression('daily', 2, '09:05', [], 1)).toBe('5 9 */2 * *')
    expect(buildCronExpression('monthly', 1, '18:00', [], 15)).toBe('0 18 15 * *')
  })

  it('sorts weekdays numerically without mutating the input', () => {
    const days = [5, 1, 10]
    expect(buildCronExpression('weekly', 1, '09:00', days, 1)).toBe('0 9 * * 1,5,10')
    expect(days).toEqual([5, 1, 10])
  })

  it('round-trips through parseCronToState', () => {
    const cron = '15 7 * * 1,3,5'
    const s = parseCronToState(cron)
    expect(buildCronExpression(s.type, s.interval, s.time, s.weekdays, s.monthDay)).toBe(cron)
  })
})

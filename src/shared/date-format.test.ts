import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SNOOZE_SOMEDAY,
  formatBytes,
  formatDate,
  formatDueDistance,
  formatFileSize,
  formatRelativeDate,
  formatRelativeFuture,
  isDueSoon,
  isOverdue,
  isSnoozed
} from './date-format'

// Local-time helper so day-based rules are independent of the host timezone.
const local = (y: number, m: number, d: number, h = 0, min = 0): string =>
  new Date(y, m - 1, d, h, min).toISOString()

// "Now" is 2024-06-15 12:00 local time for every time-dependent test.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2024, 5, 15, 12, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatDate()', () => {
  it('returns empty string for null', () => {
    expect(formatDate(null)).toBe('')
  })

  it('formats month, day and year', () => {
    expect(formatDate(local(2024, 3, 15, 12))).toBe('Mar 15, 2024')
  })
})

describe('formatRelativeDate()', () => {
  it('returns "Just now" for less than 1 minute ago', () => {
    expect(formatRelativeDate(local(2024, 6, 15, 11, 59))).toBe('1m ago')
    expect(formatRelativeDate(new Date(Date.now() - 30_000).toISOString())).toBe('Just now')
  })

  it('uses minutes, hours then days', () => {
    expect(formatRelativeDate(local(2024, 6, 15, 11, 30))).toBe('30m ago')
    expect(formatRelativeDate(local(2024, 6, 15, 6))).toBe('6h ago')
    expect(formatRelativeDate(local(2024, 6, 12, 12))).toBe('3d ago')
  })

  it('falls back to the full date after a week', () => {
    expect(formatRelativeDate(local(2024, 6, 1, 12))).toBe('Jun 1, 2024')
  })
})

describe('formatRelativeFuture()', () => {
  it('returns "soon" for past or current times', () => {
    expect(formatRelativeFuture(local(2024, 6, 15, 11))).toBe('soon')
    expect(formatRelativeFuture(local(2024, 6, 15, 12))).toBe('soon')
  })

  it('uses minutes then hours', () => {
    expect(formatRelativeFuture(new Date(Date.now() + 30_000).toISOString())).toBe('in <1m')
    expect(formatRelativeFuture(local(2024, 6, 15, 12, 45))).toBe('in 45m')
    expect(formatRelativeFuture(local(2024, 6, 15, 17))).toBe('in 5h')
  })

  it('falls back to the full date after a day', () => {
    expect(formatRelativeFuture(local(2024, 6, 20, 12))).toBe('Jun 20, 2024')
  })
})

describe('formatDueDistance()', () => {
  it('returns empty string for null', () => {
    expect(formatDueDistance(null)).toBe('')
  })

  it('describes past and future distances symmetrically', () => {
    expect(formatDueDistance(local(2024, 6, 15, 12, 30))).toBe('in <1h')
    expect(formatDueDistance(local(2024, 6, 15, 11, 30))).toBe('<1h ago')
    expect(formatDueDistance(local(2024, 6, 15, 15))).toBe('in 3h')
    expect(formatDueDistance(local(2024, 6, 15, 9))).toBe('3h ago')
    expect(formatDueDistance(local(2024, 6, 16, 12))).toBe('tomorrow')
    expect(formatDueDistance(local(2024, 6, 14, 12))).toBe('yesterday')
    expect(formatDueDistance(local(2024, 6, 20, 12))).toBe('in 5d')
    expect(formatDueDistance(local(2024, 6, 10, 12))).toBe('5d ago')
  })

  it('shows month and day beyond 30 days', () => {
    expect(formatDueDistance(local(2024, 8, 20, 12))).toBe('Aug 20')
  })
})

describe('isOverdue()', () => {
  it('returns false for null', () => {
    expect(isOverdue(null)).toBe(false)
  })

  it('is true once the due day has passed', () => {
    expect(isOverdue(local(2024, 6, 14, 23, 59))).toBe(true)
  })

  it('is false for any time earlier today (day-based, not timestamp-based)', () => {
    expect(isOverdue(local(2024, 6, 15, 8))).toBe(false)
    expect(isOverdue(local(2024, 6, 15, 0))).toBe(false)
  })

  it('is false for a future date', () => {
    expect(isOverdue(local(2024, 6, 16, 9))).toBe(false)
  })
})

describe('isDueSoon()', () => {
  it('returns false for null', () => {
    expect(isDueSoon(null)).toBe(false)
  })

  it('is true for today, including earlier today', () => {
    expect(isDueSoon(local(2024, 6, 15, 8))).toBe(true)
    expect(isDueSoon(local(2024, 6, 15, 23))).toBe(true)
  })

  it('is true for any time tomorrow', () => {
    expect(isDueSoon(local(2024, 6, 16, 23, 59))).toBe(true)
  })

  it('is false for past days and 2+ days out', () => {
    expect(isDueSoon(local(2024, 6, 14, 23))).toBe(false)
    expect(isDueSoon(local(2024, 6, 17, 0))).toBe(false)
  })

  it('never overlaps with isOverdue', () => {
    for (let day = 10; day <= 20; day++) {
      const due = local(2024, 6, day, 9)
      expect(isOverdue(due) && isDueSoon(due)).toBe(false)
    }
  })
})

describe('isSnoozed()', () => {
  it('returns false for null', () => {
    expect(isSnoozed(null)).toBe(false)
  })

  it('treats the someday sentinel as snoozed', () => {
    expect(isSnoozed(SNOOZE_SOMEDAY)).toBe(true)
  })

  it('compares other values against the current time', () => {
    expect(isSnoozed(local(2024, 6, 15, 13))).toBe(true)
    expect(isSnoozed(local(2024, 6, 15, 11))).toBe(false)
  })
})

describe('formatFileSize()', () => {
  it('uses binary units', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('returns a dash for unknown sizes', () => {
    expect(formatFileSize(0)).toBe('—')
    expect(formatFileSize(-1)).toBe('—')
    expect(formatFileSize(NaN)).toBe('—')
  })
})

describe('formatBytes()', () => {
  it('uses decimal units', () => {
    expect(formatBytes(42_000)).toBe('42 kB')
    expect(formatBytes(42_000_000)).toBe('42 MB')
    expect(formatBytes(1_200_000_000)).toBe('1.2 GB')
  })
})

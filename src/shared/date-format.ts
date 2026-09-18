// Framework-free date and size formatting shared by the desktop renderer and
// the mobile UI, so both show the same overdue / due-soon state for a task.

/** Sentinel `snoozed_until` value meaning "snoozed indefinitely". */
export const SNOOZE_SOMEDAY = '9999-12-31T00:00:00.000Z'

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function formatDate(dateString: string | null): string {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

/** Past timestamp relative to now, e.g. "5m ago"; a date after a week. */
export function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / DAY_MS)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return formatDate(dateString)
}

/** Future timestamp relative to now, e.g. "in 5m"; a date after a day. */
export function formatRelativeFuture(dateString: string): string {
  const date = new Date(dateString)
  const diffMs = date.getTime() - Date.now()

  if (diffMs <= 0) return 'soon'

  const diffMins = Math.ceil(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)

  if (diffMins <= 1) return 'in <1m'
  if (diffMins < 60) return `in ${diffMins}m`
  if (diffHours < 24) return `in ${diffHours}h`
  return formatDate(dateString)
}

/** Compact due-date distance in either direction, e.g. "in 3h", "yesterday", "5d ago". */
export function formatDueDistance(dateString: string | null): string {
  if (!dateString) return ''
  const date = new Date(dateString)
  const diffMs = Date.now() - date.getTime()
  const diffHours = Math.floor(Math.abs(diffMs) / 3600000)
  const isFuture = diffMs < 0

  if (diffHours < 1) return isFuture ? 'in <1h' : '<1h ago'
  if (diffHours < 24) return isFuture ? `in ${diffHours}h` : `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return isFuture ? 'tomorrow' : 'yesterday'
  if (diffDays < 30) return isFuture ? `in ${diffDays}d` : `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Overdue once the due date's calendar day (local time) has passed. */
export function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false
  return startOfDay(new Date(dueDate)) < startOfDay(new Date())
}

/** Due today or tomorrow (local calendar days), and not already overdue. */
export function isDueSoon(dueDate: string | null): boolean {
  if (!dueDate) return false
  const due = startOfDay(new Date(dueDate))
  const today = startOfDay(new Date())
  if (due < today) return false
  return due.getTime() - today.getTime() <= DAY_MS
}

export function isSnoozed(snoozedUntil: string | null): boolean {
  if (!snoozedUntil) return false
  if (snoozedUntil === SNOOZE_SOMEDAY) return true
  return new Date(snoozedUntil) > new Date()
}

/** Binary size for attachments, e.g. "12.3 KB"; "—" when the size is unknown. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Decimal (SI) size for downloads, e.g. "42 MB" or "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} kB`
}

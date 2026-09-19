// Date/size helpers and task-status colours are shared with the desktop
// renderer (`@shared/date-format`, `@shared/task-status-styles`) so both UIs
// agree on overdue / due-soon state and on status styling.
export {
  formatDate,
  formatRelativeDate,
  formatRelativeFuture,
  formatDueDistance,
  isOverdue,
  isDueSoon,
  isSnoozed,
  formatFileSize,
  formatBytes,
  SNOOZE_SOMEDAY
} from '@shared/date-format'

/** Merge class names, filtering out falsy values */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

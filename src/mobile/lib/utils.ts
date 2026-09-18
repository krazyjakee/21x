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

// Badge variant mappings — matches desktop Badge.tsx variants
export type BadgeVariant = 'default' | 'blue' | 'green' | 'yellow' | 'red' | 'teal' | 'cyan' | 'pink' | 'orange'

export const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: 'border-border/50 bg-muted text-muted-foreground',
  blue: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
  green: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
  yellow: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
  red: 'border-red-500/20 bg-red-500/10 text-red-400',
  teal: 'border-teal-500/20 bg-teal-500/10 text-teal-400',
  cyan: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400',
  pink: 'border-pink-500/20 bg-pink-500/10 text-pink-400',
  orange: 'border-orange-500/20 bg-orange-500/10 text-orange-400'
}

export const PRIORITY_VARIANT: Record<string, { label: string; variant: BadgeVariant }> = {
  critical: { label: 'Critical', variant: 'red' },
  high: { label: 'High', variant: 'orange' },
  medium: { label: 'Medium', variant: 'yellow' },
  low: { label: 'Low', variant: 'default' }
}

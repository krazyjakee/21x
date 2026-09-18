import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export {
  formatDate,
  formatRelativeDate,
  formatRelativeFuture,
  formatDueDistance,
  isOverdue,
  isDueSoon,
  isSnoozed,
  formatFileSize,
  formatBytes
} from '@shared/date-format'

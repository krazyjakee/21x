// One task-status style map, shared by the desktop renderer and the mobile UI.
// Colours use semantic tokens or the `*-400` accent shades that
// `styles/globals.css` darkens in light mode, so every status stays legible in
// both themes.

import { TaskStatus } from './constants'

export type TaskStatusBadgeVariant = 'default' | 'yellow' | 'pink' | 'blue' | 'green'

export interface TaskStatusStyle {
  /** Human label used by badges and board column headers. */
  label: string
  /** Badge variant (see ui/Badge). */
  variant: TaskStatusBadgeVariant
  /** Background class for the status dot. */
  dot: string
  /** Text colour for labels and counts. */
  text: string
  /** Tint behind a board column header / count pill. */
  headerBg: string
  /** Tint behind a board column. */
  columnBg: string
}

export const TASK_STATUS_STYLES: Record<TaskStatus, TaskStatusStyle> = {
  [TaskStatus.NotStarted]: {
    label: 'Not Started',
    variant: 'default',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    headerBg: 'bg-gray-500/8',
    columnBg: 'bg-gray-500/[0.03]'
  },
  [TaskStatus.Triaging]: {
    label: 'Triaging',
    variant: 'default',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    headerBg: 'bg-slate-500/8',
    columnBg: 'bg-slate-500/[0.03]'
  },
  [TaskStatus.AgentWorking]: {
    label: 'Agent Working',
    variant: 'yellow',
    dot: 'bg-amber-400',
    text: 'text-amber-400',
    headerBg: 'bg-amber-500/8',
    columnBg: 'bg-amber-500/[0.03]'
  },
  [TaskStatus.ReadyForReview]: {
    label: 'Ready for Review',
    variant: 'pink',
    dot: 'bg-pink-400',
    text: 'text-pink-400',
    headerBg: 'bg-pink-500/8',
    columnBg: 'bg-pink-500/[0.03]'
  },
  [TaskStatus.AgentLearning]: {
    label: 'Agent Learning',
    variant: 'blue',
    dot: 'bg-blue-400',
    text: 'text-blue-400',
    headerBg: 'bg-blue-500/8',
    columnBg: 'bg-blue-500/[0.03]'
  },
  [TaskStatus.Completed]: {
    label: 'Completed',
    variant: 'green',
    dot: 'bg-emerald-400',
    text: 'text-emerald-400',
    headerBg: 'bg-emerald-500/8',
    columnBg: 'bg-emerald-500/[0.03]'
  }
}

export function taskStatusStyle(status: string): TaskStatusStyle {
  return TASK_STATUS_STYLES[status as TaskStatus] ?? TASK_STATUS_STYLES[TaskStatus.NotStarted]
}

/** Dot classes for a status on its own — Triaging pulses while it is in flight. */
export function taskStatusDotClass(status: string): string {
  const { dot } = taskStatusStyle(status)
  return status === TaskStatus.Triaging ? `${dot} animate-pulse` : dot
}

/**
 * Dot classes for a task row, where a running agent session outranks the stored
 * status. Learning and triaging still win, matching the list UIs.
 */
export function taskListDotClass(status: string, hasActiveAgent = false): string {
  if (status === TaskStatus.AgentLearning) {
    return `${TASK_STATUS_STYLES[TaskStatus.AgentLearning].dot} animate-pulse`
  }
  if (status === TaskStatus.Triaging) {
    return `${TASK_STATUS_STYLES[TaskStatus.Triaging].dot} animate-pulse`
  }
  if (hasActiveAgent) {
    return `${TASK_STATUS_STYLES[TaskStatus.AgentWorking].dot} animate-pulse`
  }
  return taskStatusStyle(status).dot
}

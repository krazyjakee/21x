import type { Task } from '@/types'

/** No wall clock or updated_at: refreshing identical data cannot move a card. */
export function compareTaskActivity(a: Task, b: Task): number {
  const time = (value: string | null | undefined): number => Date.parse(value ?? '') || 0
  return time(b.last_activity_at ?? b.created_at) - time(a.last_activity_at ?? a.created_at)
    || time(b.created_at) - time(a.created_at)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Missing IDs are ignored; new cards follow the manually ranked cards. */
export function sortBoardColumn(tasks: Task[], manualOrder?: readonly string[]): Task[] {
  const ranks = new Map(manualOrder?.map((id, index) => [id, index]))
  return [...tasks].sort((a, b) =>
    (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || compareTaskActivity(a, b))
}

export function boardColumnKey(projectId: string, status: string): string {
  return JSON.stringify([projectId, status])
}

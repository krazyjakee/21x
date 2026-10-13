import { createHash } from 'crypto'
import type { TaskRecord } from '../../database/types'
import type { ProjectEvent } from '../../project-events'
import { isCoordinatorTask } from '../../../shared/task-roles'

/** Only project Captain rows enter this managed role. Task-agent admission,
 * approval authority and adapter-held conversation context remain unchanged. */
export function isManagedCaptain(task: TaskRecord | null | undefined, enabled: boolean): boolean {
  return enabled && isCoordinatorTask(task)
}

/** Event timestamps distinguish a repeated transport of one fact from a later
 * occurrence of the same kind. Sorting makes a batch identity order-independent. */
export function captainWakeIdentity(ownerId: string, events: ProjectEvent[]): string {
  const facts = events.map((event) => JSON.stringify([event.projectId, event.taskId, event.kind, event.at,
    event.title, event.detail ?? null, event.unassigned ?? false])).sort()
  return `captain-wake:${ownerId}:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`
}

export type CaptainWakeDisposition = 'delivered' | 'stale' | 'hourly_cap' | 'missing_agent' | 'missing_project' | 'failed' | 'excluded'

export function isLostCaptainSession(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return ['INCOMPATIBLE_SESSION_ID', 'SESSION_FILE_NOT_FOUND', 'No conversation found', 'Session no longer exists on server']
    .some((code) => message.includes(code))
}

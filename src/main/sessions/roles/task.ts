import type { TaskRecord } from '../../database/types'
import { isCoordinatorTask } from '../../../shared/task-roles'
import { isTriageSessionTask } from '../../agent-manager/session-config-core'

/** Pseudo-sessions and admission-exempt roles never enter task management. */
export function isManagedTask(taskId: string, task: TaskRecord | null | undefined, enabled: boolean): boolean {
  return enabled && !!task && !isCoordinatorTask(task) && !isTriageSessionTask(taskId, task)
    && !taskId.startsWith('heartbeat-') && !taskId.startsWith('triage-')
}

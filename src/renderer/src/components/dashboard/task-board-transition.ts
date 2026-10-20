import { getDesktopHost } from '@/lib/desktop-api'
import { TaskStatus } from '@/types'
import type { Task, UpdateTaskDTO } from '@/types'
import type { AgentTaskStartResult, QueuedAgentStart } from '@/types/electron'

export interface TaskBoardTransitionContext { assertCurrent: () => void; beforeEffect?: () => void }

export type TaskBoardTransitionPhase = 'starting' | 'queued' | 'failed' | 'working' | 'moved'

export interface TaskBoardTransitionResult {
  phase: Exclude<TaskBoardTransitionPhase, 'starting' | 'failed'>
  queuePosition?: number
}

interface TransitionDependencies {
  startTask: (taskId: string) => Promise<AgentTaskStartResult>
  stopByTaskId: (taskId: string) => Promise<unknown>
  getStartRecoveryState: (taskId: string) => Promise<QueuedAgentStart | null>
  updateTask: (taskId: string, data: UpdateTaskDTO) => Promise<unknown>
  exportUpdate?: (taskId: string, data: UpdateTaskDTO) => Promise<unknown>
  completeTask: (taskId: string, options?: { beforeComplete: () => Promise<void> }) => Promise<unknown>
}

const ACTIVE_QUEUE_STATES = new Set(['queued', 'retrying', 'claimed', 'starting'])

/** Command-first board transition. No destination status is written until the
 * runtime has acknowledged start/stop ownership. */
export async function transitionTaskFromBoard(
  task: Task,
  status: TaskStatus,
  deps: TransitionDependencies,
  context?: TaskBoardTransitionContext
): Promise<TaskBoardTransitionResult> {
  context?.assertCurrent()
  const native = getDesktopHost().kind === 'tauri'
  if (native && task.role && task.role !== 'task') throw new Error('Ordinary task transitions are unavailable here.')
  if (status === TaskStatus.Triaging || status === TaskStatus.AgentWorking) {
    context?.beforeEffect?.()
    const result = await deps.startTask(task.id)
    if (result.action === 'no_action') throw new Error('No configured agent is available to start this task')
    if (result.action === 'queued') {
      return { phase: 'queued', queuePosition: result.queuePosition }
    }
    return { phase: 'working' }
  }

  if (native) {
    // The production lifecycle owner already withdraws execution under its
    // task lock. A separate renderer Stop would create a second mutation.
    if (status === TaskStatus.Completed) await deps.completeTask(task.id, context ? { beforeComplete: async () => { context.assertCurrent(); context.beforeEffect?.() } } : undefined)
    else {
      if (task.source_id && !deps.exportUpdate) throw new Error('Source export is unavailable in this view.')
      context?.beforeEffect?.()
      const accepted = await deps.updateTask(task.id, { status }) as Partial<Task> | null | undefined
      if (!accepted || accepted.id !== task.id || accepted.status !== status || accepted.project_id !== task.project_id || (accepted.role ?? 'task') !== (task.role ?? 'task') || accepted.source_id !== task.source_id || accepted.external_id !== task.external_id) throw new Error('Task transition was not confirmed. Review the current task before another action.')
      context?.assertCurrent()
      if (task.source_id) { await deps.exportUpdate?.(task.id, { status }); context?.assertCurrent() }
    }
    return { phase: 'moved' }
  }

  const stopOwnedWork = async (): Promise<void> => {
    const recovery = await deps.getStartRecoveryState(task.id)
    if (
      task.status === TaskStatus.Triaging ||
      task.status === TaskStatus.AgentWorking ||
      (recovery !== null && ACTIVE_QUEUE_STATES.has(recovery.state))
    ) {
      await deps.stopByTaskId(task.id)
    }
  }

  if (status === TaskStatus.Completed) await deps.completeTask(task.id, { beforeComplete: stopOwnedWork })
  else {
    await stopOwnedWork()
    await deps.updateTask(task.id, { status })
  }
  return { phase: 'moved' }
}

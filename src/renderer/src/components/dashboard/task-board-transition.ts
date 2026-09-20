import { TaskStatus } from '@/types'
import type { Task, UpdateTaskDTO } from '@/types'
import type { AgentTaskStartResult, QueuedAgentStart } from '@/types/electron'

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
  completeTask: (taskId: string, options?: { beforeComplete: () => Promise<void> }) => Promise<unknown>
}

const ACTIVE_QUEUE_STATES = new Set(['queued', 'retrying', 'claimed', 'starting'])

/** Command-first board transition. No destination status is written until the
 * runtime has acknowledged start/stop ownership. */
export async function transitionTaskFromBoard(
  task: Task,
  status: TaskStatus,
  deps: TransitionDependencies
): Promise<TaskBoardTransitionResult> {
  if (status === TaskStatus.Triaging || status === TaskStatus.AgentWorking) {
    const result = await deps.startTask(task.id)
    if (result.action === 'no_action') throw new Error('No configured agent is available to start this task')
    if (result.action === 'queued') {
      return { phase: 'queued', queuePosition: result.queuePosition }
    }
    return { phase: 'working' }
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

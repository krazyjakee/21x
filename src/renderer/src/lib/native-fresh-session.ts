import { agentApi, taskApi } from '@/lib/ipc-client'
import { dispatchShortcutFeedback } from '@/lib/keyboard-shortcuts'
import { useAgentStore } from '@/stores/agent-store'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'
import type { QueuedAgentStart } from '@/types/electron'

/**
 * Why `agentSession:start` cannot give this task a fresh session on the native
 * host, or null when it can. That is the exact-task owner: it creates a session
 * and replaces `session_id`, which the native task codec refuses from a renderer.
 * It refuses a user-stopped start, returns a live session and resumes a Captain,
 * so those stay out of native Fresh until a restart owner exists.
 */
export function nativeFreshRefusal(task: Task, recovery: QueuedAgentStart | null, sessionId: string | null): string | null {
  if (task.role !== 'task') return 'Fresh-session restart is unavailable for this task in this native build.'
  if (task.status === TaskStatus.Completed) return 'Completed tasks cannot be started.'
  if (sessionId) return 'Fresh-session restart is unavailable while this session is live in this native build.'
  if (recovery?.state === 'cancelled' || recovery?.state === 'failed') return 'This session was stopped, so fresh-session restart is unavailable in this native build. Send a message to continue this task.'
  if (recovery && recovery.state !== 'started' && recovery.state !== 'recovered') return 'This task already has a start in progress.'
  return null
}

interface NativeFreshActions {
  /** False once the view that owns this action has been replaced. */
  current: () => boolean
  removeSession: (taskId: string) => void
  start: (agentId: string, taskId: string) => Promise<unknown>
}

/**
 * Starts a fresh session on the native host, or says why it cannot. Run it in the
 * caller's action lane. The task, its queue row and its session are all read again
 * here, because any of them can be newer than the render that offered the action,
 * and clearing the local transcript before the owner refuses would leave it empty.
 */
export async function startNativeFresh(taskId: string, { current, removeSession, start }: NativeFreshActions): Promise<void> {
  const recovery = await agentApi.getStartRecoveryState(taskId)
  const task = await taskApi.getById(taskId)
  if (!current()) throw new Error('Task view was replaced.')
  if (!task?.agent_id) { dispatchShortcutFeedback('This task no longer has an assigned agent.', true); return }
  const refusal = nativeFreshRefusal(task, recovery, useAgentStore.getState().sessions.get(taskId)?.sessionId ?? null)
  if (refusal) { dispatchShortcutFeedback(refusal, true); return }
  removeSession(taskId)
  await start(task.agent_id, taskId)
}

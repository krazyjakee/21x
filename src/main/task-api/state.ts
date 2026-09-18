/**
 * Wiring the task API routes read at call time. It lives apart from the
 * server module so route modules can import it without a cycle.
 */
import type { AgentManager } from '../agent-manager'
import type { DatabaseManager } from '../database'

type TaskApiAgentController = Pick<
  AgentManager,
  | 'startTask'
  | 'notifyParentOfSubtaskCompletion'
  | 'sendByTaskId'
  | 'respondToPermission'
  | 'stopByTaskId'
  | 'findSessionByTaskId'
  | 'getSessionStatus'
  | 'getActiveSessionsForTask'
  | 'cancelQueuedStart'
>

type TranscriptProvider = (taskId: string) => Promise<Array<{ role: string; text: string }>>

export let notifyRenderer: ((channel: string, data: unknown) => void) | null = null
export let transcriptProvider: TranscriptProvider | null = null
export let agentController: TaskApiAgentController | null = null

/**
 * What the renderer is showing. It is pushed on change and cached here, so a
 * tool call never has to wait for a round trip to the window.
 */
export let uiState: Record<string, unknown> = { available: false }

export function setTaskApiUiState(state: Record<string, unknown> | null): void {
  // Null clears it. A closed window must not keep reporting a stale screen.
  uiState = state ? { ...state, available: true, updatedAt: Date.now() } : { available: false }
}

export function setTaskApiNotifier(fn: (channel: string, data: unknown) => void): void {
  notifyRenderer = fn
}

export function setTranscriptProvider(fn: TranscriptProvider): void {
  transcriptProvider = fn
}

export function setTaskApiAgentController(controller: TaskApiAgentController | null): void {
  agentController = controller
}

/** A non-empty string param, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** The `task_id` param when it names a task that exists, else null. */
export function existingTaskId(db: DatabaseManager, params: Record<string, unknown>): string | null {
  const taskId = typeof params.task_id === 'string' ? params.task_id : ''
  return taskId && db.getTask(taskId) ? taskId : null
}

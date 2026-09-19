/**
 * Tracks the subagent / bash tasks Claude Code runs in the background.
 *
 * Claude Code backgrounds Task-tool subagents by default: the tool call returns
 * immediately, the assistant's turn ends (emitting `result`) and the subagent
 * keeps working, waking the session again via `task_notification`. While any
 * task is in flight the session is NOT done — it is paused waiting on children.
 */

import { ClaudeSystemSubtype } from './claude-code-message-converter'

type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage

export interface BackgroundTask {
  taskId: string
  /** SDK `task_type`, e.g. 'local_agent' (subagent) or 'local_bash'. */
  taskType?: string
  description?: string
  startedAt: number
}

/** Once a task reports one of these it no longer counts towards the session being BUSY. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped'])

/**
 * In-flight background work suppresses IDLE *and* exempts the session from
 * agent-manager's stuck-session watchdog, so a task whose terminal notification
 * is lost would pin the session BUSY forever. Generous enough that no
 * legitimate subagent hits it.
 */
const MAX_BACKGROUND_TASK_AGE_MS = 60 * 60 * 1000

/**
 * Updates `tasks` from the SDK's task lifecycle messages.
 *
 * The raw CLI also emits `background_tasks_changed` with the authoritative
 * in-flight list, but SDK >= 0.3.x filters it out (verified against 0.3.169
 * and 0.3.195), so the set is normally rebuilt from task_started plus
 * task_updated / task_notification. Older bundled SDKs pass it through, and
 * it is preferred when present since it cannot drift.
 */
export function trackBackgroundTask(sessionId: string, tasks: Map<string, BackgroundTask>, message: SDKMessage): void {
  const msg = message as unknown as {
    type?: string
    subtype?: string
    task_id?: string
    task_type?: string
    subagent_type?: string
    description?: string
    status?: string
    patch?: { status?: string }
    tasks?: Array<{ task_id?: string; task_type?: string; description?: string }>
  }
  if (msg.type !== 'system') return

  if (msg.subtype === ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED && Array.isArray(msg.tasks)) {
    const next = new Map<string, BackgroundTask>()
    for (const t of msg.tasks) {
      if (!t?.task_id) continue
      const existing = tasks.get(t.task_id)
      next.set(t.task_id, {
        taskId: t.task_id,
        taskType: t.task_type ?? existing?.taskType,
        description: t.description ?? existing?.description,
        // Keep the original start time so the staleness cap stays meaningful.
        startedAt: existing?.startedAt ?? Date.now(),
      })
    }
    tasks.clear()
    for (const [taskId, task] of next) tasks.set(taskId, task)
    console.log(
      `[ClaudeCodeAdapter] Background task list for ${sessionId} refreshed from ` +
      `background_tasks_changed — ${tasks.size} in flight`
    )
    return
  }

  if (!msg.task_id) return

  if (msg.subtype === ClaudeSystemSubtype.TASK_STARTED) {
    tasks.set(msg.task_id, {
      taskId: msg.task_id,
      taskType: msg.task_type || (msg.subagent_type ? 'local_agent' : undefined),
      description: msg.description,
      startedAt: Date.now(),
    })
    console.log(
      `[ClaudeCodeAdapter] Background task started for ${sessionId}: ${msg.task_id} ` +
      `(${msg.task_type || 'unknown'}) — ${tasks.size} in flight`
    )
    return
  }

  const terminalStatus =
    msg.subtype === ClaudeSystemSubtype.TASK_NOTIFICATION ? msg.status :
    msg.subtype === ClaudeSystemSubtype.TASK_UPDATED ? msg.patch?.status :
    undefined

  if (terminalStatus && TERMINAL_TASK_STATUSES.has(terminalStatus) && tasks.delete(msg.task_id)) {
    console.log(
      `[ClaudeCodeAdapter] Background task ${msg.task_id} ${terminalStatus} for ${sessionId} — ` +
      `${tasks.size} still in flight`
    )
  }
}

/** Drops tasks older than MAX_BACKGROUND_TASK_AGE_MS (see there). */
export function pruneStaleBackgroundTasks(sessionId: string, tasks: Map<string, BackgroundTask>): void {
  const now = Date.now()
  for (const [taskId, task] of tasks) {
    if (now - task.startedAt > MAX_BACKGROUND_TASK_AGE_MS) {
      tasks.delete(taskId)
      console.warn(
        `[ClaudeCodeAdapter] Background task ${taskId} for ${sessionId} exceeded ` +
        `${MAX_BACKGROUND_TASK_AGE_MS / 60000}min without a terminal notification — ` +
        `no longer counting it as in flight`
      )
    }
  }
}

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { TaskStatus } from '../../shared/constants'
import { isCoordinatorTask } from '../../shared/task-roles'
import { SessionStatusType } from '../adapters/coding-agent-adapter'
import { extractOutputFromMessages } from '../output-extraction'
import { finishSessionFeedback, updateTaskFromUser } from '../session-feedback'
import type { SessionPoller } from './polling'
import { yieldEventLoop } from './polling'
import { collectMissedParts } from './transcript-events'
import type { AgentSession, SessionHost } from './types'

type TurnHost = Pick<SessionHost,
  | 'db' | 'sessions' | 'sessionConfigFor' | 'emitStatus' | 'sendToRenderer' | 'updateTaskFromLocalAgent'
  | 'releaseAdapterSession' | 'schedulePowerSaveBlockerUpdate' | 'syncSkillsFromWorkspace' | 'getSyncManager'
  | 'notifyParentOfSubtaskCompletion'>

/**
 * Moves a session whose turn ended to idle and applies the task lifecycle:
 * triage returns the task to not_started, learning finishes the feedback flow,
 * work goes to review. Output field values are extracted BEFORE clients are
 * notified so their re-fetch sees them. The many yieldEventLoop() calls break
 * up the chain of synchronous DB calls.
 *
 * Idle is a state flag only: it never terminates the session or any
 * subagent/subtask work. Only the inactivity reaper or a user stop does.
 */
export async function transitionToIdle(host: TurnHost, poller: SessionPoller, sessionId: string, session: AgentSession): Promise<void> {
  const { db } = host
  if (session.status === 'idle') {
    console.log(`[AgentManager] transitionToIdle: session ${sessionId} already idle, skipping`)
    return
  }
  console.log(`[AgentManager] Session ${sessionId} preparing to transition idle`)

  if (session.isTriageSession) {
    session.status = 'idle'
    console.log(`[AgentManager] Triage session completed for task ${session.taskId}, reverting to NotStarted`)
    host.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.NotStarted, session_id: null })
    await yieldEventLoop()
    host.sendToRenderer('task:updated', {
      taskId: session.taskId,
      updates: db.getTask(session.taskId) || { status: TaskStatus.NotStarted, session_id: null }
    })
    host.emitStatus(sessionId, session, 'idle')

    // Release through the adapter first: otherwise the agent CLI process and
    // its task-management MCP child stay alive with no handle left to stop them.
    await host.releaseAdapterSession(sessionId, 'triage_completed')
    host.sessions.delete(sessionId)
    host.schedulePowerSaveBlockerUpdate()
    console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} reason=triage_completed`)
    return
  }

  const replayedPartCount = await replayMissedPartsBeforeIdle(host, sessionId, session)
  await yieldEventLoop()

  if (session.adapter) {
    try {
      const statusAfterReplay = await session.adapter.getStatus(sessionId, host.sessionConfigFor(session))
      if (statusAfterReplay.type !== SessionStatusType.IDLE) {
        console.log(
          `[AgentManager] Idle transition for ${sessionId} deferred after replay: replayed=${replayedPartCount}, adapterStatus=${statusAfterReplay.type}`
        )
        poller.resumeAfterPrematureIdle(sessionId, session)
        return
      }
    } catch (err) {
      console.error(`[AgentManager] Failed to re-check adapter status before idle for ${sessionId}:`, err)
    }
  }

  session.status = 'idle'
  session.lastActivityAt = Date.now()
  console.log(`[AgentManager] Session ${sessionId} → idle`)

  // Pseudo-tasks (heartbeat-*) have no DB row, and a coordinator row has no
  // lifecycle: neither goes to review, grows a heartbeat or wakes a parent.
  const task = db.getTask(session.taskId)
  await yieldEventLoop()
  if (!task || isCoordinatorTask(task)) {
    console.log(`[AgentManager] No lifecycle for ${session.taskId}, sending idle status only`)
    host.emitStatus(sessionId, session, 'idle')
    return
  }

  if (task.status === TaskStatus.AgentLearning) {
    console.log(`[AgentManager] Task in learning mode, syncing skills and marking as completed`)
    try {
      await host.syncSkillsFromWorkspace(sessionId)
    } catch (err) {
      console.error(`[AgentManager] Skill sync error:`, err)
      updateTaskFromUser(db, session.taskId, { status: TaskStatus.ReadyForReview })
      host.sendToRenderer('task:updated', { taskId: session.taskId, updates: db.getTask(session.taskId) })
      host.emitStatus(sessionId, session, 'idle')
      return
    }
    await yieldEventLoop()

    try {
      const completed = await finishSessionFeedback(db, host.getSyncManager(), session.taskId)
      if (completed?.parent_task_id) {
        await host.notifyParentOfSubtaskCompletion(completed.parent_task_id, session.taskId)
      }
      if (!completed && db.getTask(session.taskId)?.status !== TaskStatus.Completed) {
        host.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.ReadyForReview })
      }
    } catch (error) {
      host.sendToRenderer('task:source-action-failed', { taskId: session.taskId, taskTitle: task.title, error: error instanceof Error ? error.message : String(error) })
    }
    host.sendToRenderer('task:updated', { taskId: session.taskId, updates: db.getTask(session.taskId) })
    host.emitStatus(sessionId, session, 'idle')
    return
  }

  await extractOutputValues(host, sessionId)
  await yieldEventLoop()

  // The frontend may have completed the task during the feedback flow meanwhile.
  const taskAfterExtract = db.getTask(session.taskId)
  await yieldEventLoop()
  if (taskAfterExtract?.status === TaskStatus.AgentLearning || taskAfterExtract?.status === TaskStatus.Completed) {
    console.log(`[AgentManager] Task already in final state (${taskAfterExtract.status}), skipping status update`)
    host.emitStatus(sessionId, session, 'idle')
    return
  }

  // Desktop agent work is help: it goes to review. Only the server can accept completion.
  console.log(`[AgentManager] Updating task ${session.taskId} status to ReadyForReview`)
  host.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.ReadyForReview })
  await yieldEventLoop()
  autoEnableHeartbeat(host, session.taskId)
  await yieldEventLoop()

  const updatedTask = db.getTask(session.taskId)
  host.sendToRenderer('task:updated', {
    taskId: session.taskId,
    updates: {
      status: TaskStatus.ReadyForReview,
      output_fields: updatedTask?.output_fields,
      heartbeat_enabled: updatedTask?.heartbeat_enabled,
      heartbeat_interval_minutes: updatedTask?.heartbeat_interval_minutes,
      heartbeat_next_check_at: updatedTask?.heartbeat_next_check_at
    }
  })

  // The parent need not stay resident polling its children: it is resumed
  // exactly when there is something to act on.
  if (task.parent_task_id) {
    host.notifyParentOfSubtaskCompletion(task.parent_task_id, session.taskId).catch((err) => {
      console.error(`[AgentManager] Failed to wake parent ${task.parent_task_id} after subtask ${session.taskId} completed:`, err)
    })
  }

  host.emitStatus(sessionId, session, 'idle')
}

/**
 * Polling can observe IDLE in the same tick that the adapter persists the
 * final assistant message. Re-reads the full message list once and emits any
 * part not seen yet. Returns the number of parts replayed.
 */
async function replayMissedPartsBeforeIdle(host: TurnHost, sessionId: string, session: AgentSession): Promise<number> {
  if (!session.adapter?.getAllMessages) return 0
  try {
    const messages = await session.adapter.getAllMessages(sessionId, host.sessionConfigFor(session))
    // Loaded lazily: usually every part is already known by id or content key.
    const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
    let existingContent: Set<string> | undefined
    const isPersisted = (content: string): boolean => {
      existingContent ??= new Set(
        host.db.getTranscriptParts(session.taskId)
          .filter((p) => p.content)
          .map((p) => normalize(p.content))
      )
      return existingContent.has(normalize(content))
    }
    const missed = collectMissedParts(messages, {
      seenPartIds: session.seenPartIds,
      partContentLengths: session.partContentLengths,
      assistantTextKeys: (session.assistantTextKeys ??= new Set<string>())
    }, isPersisted)

    if (missed.length > 0) {
      console.log(`[AgentManager] Replaying ${missed.length} missed transcript part(s) for ${sessionId} before idle`)
      host.sendToRenderer('agent:output-batch', { sessionId, taskId: session.taskId, messages: missed })
    }
    return missed.length
  } catch (err) {
    console.error(`[AgentManager] replayMissedPartsBeforeIdle error for ${sessionId}:`, err)
    return 0
  }
}

/** Fills the task's output fields from the session's messages. */
async function extractOutputValues(host: TurnHost, sessionId: string): Promise<void> {
  const session = host.sessions.get(sessionId)
  if (!session?.adapter) return
  const task = host.db.getTask(session.taskId)
  if (!task?.output_fields || task.output_fields.length === 0) return

  console.log(`[AgentManager] Extracting output values for task ${session.taskId}`)
  if (!session.adapter.getAllMessages) {
    console.warn('[AgentManager] Adapter does not implement getAllMessages')
    return
  }
  try {
    const messages = await session.adapter.getAllMessages(sessionId, {
      agentId: session.agentId,
      taskId: session.taskId,
      workspaceDir: session.workspaceDir || process.cwd()
    })
    if (messages.length === 0) return
    host.updateTaskFromLocalAgent(session.taskId, { output_fields: extractOutputFromMessages(messages, task.output_fields) })
    console.log(`[AgentManager] Extracted output values for task ${session.taskId}`)
  } catch (error) {
    console.error(`[AgentManager] Error extracting output values:`, error)
  }
}

/** Turns the task's heartbeat on when its workspace has a non-empty heartbeat.md. */
function autoEnableHeartbeat(host: TurnHost, taskId: string): void {
  try {
    const heartbeatPath = join(host.db.getWorkspaceDir(taskId), 'heartbeat.md')
    if (!existsSync(heartbeatPath)) return
    const content = readFileSync(heartbeatPath, 'utf-8').trim()
    // Empty or headers-only files do not count.
    if (!content || /^(#[^\n]*\n?\s*)*$/.test(content)) return

    const interval = parseInt(host.db.getSetting('heartbeat_default_interval') || '30', 10)
    host.updateTaskFromLocalAgent(taskId, {
      heartbeat_enabled: true,
      heartbeat_interval_minutes: interval,
      heartbeat_next_check_at: new Date(Date.now() + interval * 60_000).toISOString()
    })
    console.log(`[AgentManager] Auto-enabled heartbeat for task ${taskId} (found heartbeat.md)`)
  } catch (err) {
    console.error(`[AgentManager] Error auto-enabling heartbeat for task ${taskId}:`, err)
  }
}

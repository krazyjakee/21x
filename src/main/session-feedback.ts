import type { DatabaseManager, TaskRecord, UpdateTaskData } from './database'
import type { SyncManager } from './sync-manager'
import { TaskStatus } from '../shared/constants'
import { getTaskCompletionAction } from '../shared/task-completion'

const feedbackKey = (taskId: string) => `session-feedback-completion:${taskId}`

/** The raw source attempt may have happened; withdrawal never authorizes a
 * rollback of newer task state or an automatic replay of that attempt. */
export class SessionFeedbackOwnershipChangedError extends Error {
  constructor(readonly originalError?: unknown) { super('Session feedback ownership changed before completion.') }
}

/** Called only by the desktop/mobile user write routes, not the agent task API. */
export function updateTaskFromUser(db: DatabaseManager, taskId: string, data: UpdateTaskData) {
  if (data.status === TaskStatus.AgentLearning && data.feedback_rating !== undefined) {
    if (!Number.isInteger(data.feedback_rating) || data.feedback_rating! < 1 || data.feedback_rating! > 5) {
      throw new Error('Select a rating from 1 to 5.')
    }
    const task = db.getTask(taskId)
    if (!task?.agent_id) throw new Error('An agent is required for session learning.')
    if (task.status === TaskStatus.Completed) throw new Error('This task is already completed.')
    if (task.source_id && typeof data.complete_at_source !== 'boolean') throw new Error('Select a source completion option.')
    const result = db.updateTask(taskId, data, 'session-feedback')
    db.setSetting(feedbackKey(taskId), JSON.stringify({ completeAtSource: data.complete_at_source !== false }))
    return result
  }
  if (data.status === TaskStatus.ReadyForReview && db.getSetting(feedbackKey(taskId))) {
    db.deleteSetting(feedbackKey(taskId))
    return db.updateTask(taskId, data, 'session-feedback')
  }
  return db.updateTask(taskId, data)
}

/** Consume the user's choice only after the learning session and skill sync finish. */
export async function finishSessionFeedback(db: DatabaseManager, sync: SyncManager | undefined, taskId: string, beforeLocalWrite?: () => void) {
  const pending = db.getSetting(feedbackKey(taskId))
  if (!pending) { if (beforeLocalWrite) throw new SessionFeedbackOwnershipChangedError(); return undefined }
  const task = db.getTask(taskId)
  if (!task || task.status !== TaskStatus.AgentLearning) { if (beforeLocalWrite) throw new SessionFeedbackOwnershipChangedError(); return undefined }
  const snapshot = JSON.stringify(task)
  let expectedIntent: string | undefined = pending
  const currentOwner = (): void => {
    if (!beforeLocalWrite) return
    try { beforeLocalWrite() } catch (error) { throw new SessionFeedbackOwnershipChangedError(error) }
    if (db.getSetting(feedbackKey(taskId)) !== expectedIntent) throw new SessionFeedbackOwnershipChangedError()
  }
  const current = (): void => {
    currentOwner()
    if (beforeLocalWrite && JSON.stringify(db.getTask(taskId)) !== snapshot) throw new SessionFeedbackOwnershipChangedError()
  }
  const { completeAtSource } = JSON.parse(pending) as { completeAtSource: boolean }
  if (beforeLocalWrite && typeof completeAtSource !== 'boolean') throw new SessionFeedbackOwnershipChangedError()
  current()
  db.deleteSetting(feedbackKey(taskId))
  expectedIntent = undefined
  try {
    if (db.getSubtasks(taskId).some(child => child.status !== TaskStatus.Completed && child.status !== TaskStatus.ReadyForReview)) {
      throw new Error('Subtasks must finish before this task can complete.')
    }
    if (task.source_id && completeAtSource) await completeTaskAtSource(sync, task, undefined, beforeLocalWrite ? current : undefined)
    currentOwner()
    // A successful source action may itself commit Completed through the
    // guarded SyncManager writer. Preserve that acknowledged row verbatim.
    if (beforeLocalWrite) {
      const completed = db.getTask(taskId)
      if (completed?.status === TaskStatus.Completed) return completed
    }
    current()
    return db.updateTask(taskId, { status: TaskStatus.Completed }, 'session-feedback')
  } catch (error) {
    if (error instanceof SessionFeedbackOwnershipChangedError) throw error
    try { current() } catch { throw new SessionFeedbackOwnershipChangedError(error) }
    db.updateTask(taskId, { status: TaskStatus.ReadyForReview }, 'session-feedback')
    throw error
  }
}

/** Sends the task's completion action to its source; throws unless the source accepts it. */
export async function completeTaskAtSource(sync: SyncManager | null | undefined, task: TaskRecord, origin?: 'task-group', beforeLocalWrite?: () => void): Promise<void> {
  if (!sync || !task.source_id) throw new Error('Task source is unavailable.')
  const action = getTaskCompletionAction(task.output_fields)
  beforeLocalWrite?.()
  const result = beforeLocalWrite
    ? await sync.executeAction(action, task, undefined, task.source_id, origin ?? 'task-source-action', { beforeEffect: beforeLocalWrite, beforeLocalWrite })
    : origin
    ? await sync.executeAction(action, task, undefined, task.source_id, origin)
    : await sync.executeAction(action, task, undefined, task.source_id)
  if (!result.success) throw new Error(result.error || 'Source completion failed.')
}

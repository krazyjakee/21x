/**
 * Project event bus (#57).
 *
 * The main process already has the places where something happens to a task:
 * the shared task-update side effects, the agent manager's session
 * transitions, the heartbeat scheduler and the task-source sync. Each of those
 * calls {@link emitTaskEvent} with a kind and a task id, and this module turns
 * it into a {@link ProjectEvent} for the task's project. The only consumer
 * today is the CaptainWaker (captain-waker.ts), which batches a
 * project's events into one wake-up for its Captain.
 *
 * Emitting is best effort: a missing task, a coordinator row (the Captain's
 * own session going to `waiting_approval` must never wake itself) or a
 * listener that throws never disturbs the caller.
 */
import { EventEmitter } from 'events'
import type { DatabaseManager, TaskRecord } from './database'
import { isCoordinatorTask } from '../shared/task-roles'
import type { ProjectEventKind } from '../shared/captain-wakeups'

export type { ProjectEventKind }

export interface ProjectEvent {
  kind: ProjectEventKind
  projectId: string
  taskId: string
  /** The task's title at the time of the event. */
  title: string
  /** Short free text: a routing issue, a heartbeat finding, a failure message. */
  detail?: string
  /** For `task_synced`: the new task has no agent yet. */
  unassigned?: boolean
  /** ISO time. */
  at: string
}

export type ProjectEventListener = (event: ProjectEvent) => void

const EVENT_NAME = 'project-event'

class ProjectEventBus extends EventEmitter {
  emitEvent(event: ProjectEvent): void {
    try {
      this.emit(EVENT_NAME, event)
    } catch (err) {
      console.error('[ProjectEvents] Listener failed:', err)
    }
  }

  /** Subscribes; returns the unsubscribe function. */
  onEvent(listener: ProjectEventListener): () => void {
    this.on(EVENT_NAME, listener)
    return () => { this.off(EVENT_NAME, listener) }
  }
}

/** The one bus of the main process. */
export const projectEvents = new ProjectEventBus()

/** What emitting needs from the database; a Pick so tests pass a small stub. */
export type ProjectEventStore = Pick<DatabaseManager, 'getTask'>

/** Longest `detail` kept on an event, so a wake-up stays bounded. */
export const PROJECT_EVENT_DETAIL_MAX_CHARS = 400

export function clipEventDetail(detail: string | null | undefined): string | undefined {
  const text = detail?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > PROJECT_EVENT_DETAIL_MAX_CHARS ? `${text.slice(0, PROJECT_EVENT_DETAIL_MAX_CHARS - 1)}…` : text
}

/**
 * Raises an event for a task's project. Returns the event, or null when
 * nothing was raised: the task does not exist, or it is a coordinator row.
 */
export function emitTaskEvent(
  db: ProjectEventStore,
  kind: ProjectEventKind,
  taskId: string,
  detail?: string | null,
  extra?: { unassigned?: boolean }
): ProjectEvent | null {
  let task: TaskRecord | undefined
  try {
    task = db.getTask(taskId)
  } catch (err) {
    console.error(`[ProjectEvents] Could not read task ${taskId} for ${kind}:`, err)
    return null
  }
  if (!task || isCoordinatorTask(task)) return null
  const event: ProjectEvent = {
    kind,
    projectId: task.project_id,
    taskId: task.id,
    title: task.title,
    at: new Date().toISOString()
  }
  const clipped = clipEventDetail(detail)
  if (clipped) event.detail = clipped
  if (extra?.unassigned) event.unassigned = true
  projectEvents.emitEvent(event)
  return event
}

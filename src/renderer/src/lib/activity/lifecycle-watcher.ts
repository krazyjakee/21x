import { create } from 'zustand'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@shared/constants'
import { activityNow } from './activity-clock'

/**
 * Observed task lifecycle completions (#95).
 *
 * A completion accent and a completion announcement are only for a transition
 * seen live: the same task present in two successive task-store states with
 * a different status. A task that first appears already in review (initial
 * load, project switch, a newly created row) is history, not an event.
 */

export interface LifecycleCompletion {
  taskId: string
  title: string
  to: TaskStatus.ReadyForReview | TaskStatus.Completed
  from: string
  at: number
  parentTaskId: string | null
}

interface LifecycleActivityState {
  /** Monotonic time of each task's latest observed completion. */
  finishedAt: Record<string, number>
}

export const useLifecycleActivityStore = create<LifecycleActivityState>(() => ({ finishedAt: {} }))

type Listener = (completion: LifecycleCompletion) => void
const listeners = new Set<Listener>()

export function onLifecycleCompletion(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

type TaskLike = { id: string; status: string; title?: string; parent_task_id?: string | null }

/** Compares two task lists and returns the completions observed between them. Pure. */
export function diffLifecycleCompletions(previous: readonly TaskLike[], next: readonly TaskLike[], now: number): LifecycleCompletion[] {
  if (previous.length === 0) return []
  const before = new Map<string, string>()
  for (const t of previous) before.set(t.id, t.status)
  const out: LifecycleCompletion[] = []
  for (const t of next) {
    const was = before.get(t.id)
    if (was === undefined || was === t.status) continue
    if (t.status !== TaskStatus.ReadyForReview && t.status !== TaskStatus.Completed) continue
    // Review → completed is the user's own action, not agent completion.
    if (was === TaskStatus.ReadyForReview && t.status === TaskStatus.Completed) continue
    out.push({
      taskId: t.id,
      title: t.title ?? 'Task',
      to: t.status as LifecycleCompletion['to'],
      from: was,
      at: now,
      parentTaskId: t.parent_task_id ?? null
    })
  }
  return out
}

let started = false

/** Starts watching the task store. Idempotent. */
export function ensureLifecycleWatcher(): void {
  if (started) return
  started = true
  useTaskStore.subscribe((state, prev) => {
    if (state.tasks === prev.tasks) return
    const completions = diffLifecycleCompletions(prev.tasks, state.tasks, activityNow())
    if (completions.length === 0) return
    const finishedAt = { ...useLifecycleActivityStore.getState().finishedAt }
    for (const c of completions) finishedAt[c.taskId] = c.at
    useLifecycleActivityStore.setState({ finishedAt })
    for (const c of completions) {
      for (const listener of listeners) {
        try {
          listener(c)
        } catch (err) {
          console.error('[activity] lifecycle listener failed:', err)
        }
      }
    }
  })
}

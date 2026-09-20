import { useEffect, useRef, useState } from 'react'
import { ACTIVITY_STALE_MS } from '@shared/activity'
import { ActivityAnnouncementQueue } from '@/lib/activity/announcer'
import { onSessionTransition, useSessionActivityStore, type SessionTransition } from '@/lib/activity/session-activity-adapter'
import { ensureLifecycleWatcher, onLifecycleCompletion, type LifecycleCompletion } from '@/lib/activity/lifecycle-watcher'
import { activityNow, scheduleActivityDeadline, useActivityClock } from '@/lib/activity/activity-clock'
import { getCaptainTaskId, useCoordinatorStore } from '@/stores/coordinator-store'
import { useTaskStore } from '@/stores/task-store'
import { getCurrentProjectId, isInProject, useProjectStore } from '@/stores/project-store'

/** Converts an observed session transition into an announcement, or null. Pure. */
export function announcementForTransition(
  t: SessionTransition,
  info: { title: string; isCaptain: boolean }
): Parameters<ActivityAnnouncementQueue['enqueue']>[0] | null {
  const who = info.isCaptain ? 'Captain' : info.title
  const entity = `task:${t.taskId}`
  if (t.to === 'waiting_approval') {
    return { key: `${entity}:waiting:${t.at}`, entity, kind: 'actionable', message: `${who} needs approval` }
  }
  if (t.to === 'error') {
    return { key: `${entity}:failed:${t.at}`, entity, kind: 'actionable', message: `${who} failed` }
  }
  if (info.isCaptain && t.from === 'working' && t.to === 'idle') {
    return { key: `${entity}:finished:${t.at}`, entity, kind: 'routine', message: 'Captain reply finished' }
  }
  return null
}

export function announcementForCompletion(c: LifecycleCompletion): Parameters<ActivityAnnouncementQueue['enqueue']>[0] {
  const entity = `task:${c.taskId}`
  const done = c.to === 'completed'
  return {
    key: `${entity}:${c.to}:${c.at}`,
    entity,
    kind: 'routine',
    message: `${c.title} ${done ? 'completed' : 'ready for review'}`,
    group: done ? 'completed' : 'review',
    aggregate: (n) => `${n} tasks ${done ? 'completed' : 'ready for review'}`
  }
}

/**
 * The single application activity announcer for tasks and Captains (#95).
 * One polite, atomic live region; region indicators stay silent. Commander
 * turns are left to #91's CallAnnouncer. Nothing is announced for heartbeats,
 * first sightings, hydration, tokens or tool steps.
 */
export function ActivityAnnouncer() {
  const [message, setMessage] = useState('')
  const queueRef = useRef<ActivityAnnouncementQueue | null>(null)
  const connectionRef = useRef(new Map<string, { lost: boolean; announcedLost: boolean }>())
  const sessions = useSessionActivityStore((s) => s.sessions)
  const tick = useActivityClock((s) => s.tick)
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const tasks = useTaskStore((s) => s.tasks)
  const captainTaskId = useCoordinatorStore((s) => s.captainTaskIds[currentProjectId] ?? null)

  useEffect(() => {
    ensureLifecycleWatcher()
    const queue = new ActivityAnnouncementQueue((text) => {
      // Clearing first makes a repeated identical message announce again.
      setMessage('')
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setMessage(text))
      else setMessage(text)
    })
    queueRef.current = queue
    const inCurrentProject = (taskId: string): { title: string; isCaptain: boolean } | null => {
      const projectId = getCurrentProjectId()
      const isCaptain = getCaptainTaskId(projectId) === taskId
      const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
      if (!isCaptain && (!task || !isInProject(task, projectId))) return null
      return { title: task?.title ?? 'Task', isCaptain }
    }
    const offTransition = onSessionTransition((t) => {
      const info = inCurrentProject(t.taskId)
      if (!info) return
      const a = announcementForTransition(t, info)
      if (a) queue.enqueue(a)
    })
    const offCompletion = onLifecycleCompletion((c) => {
      if (!inCurrentProject(c.taskId)) return
      queue.enqueue(announcementForCompletion(c))
    })
    return () => {
      offTransition()
      offCompletion()
      queue.dispose()
      queueRef.current = null
    }
  }, [])

  useEffect(() => {
    void tick
    const queue = queueRef.current
    if (!queue) return
    const now = activityNow()
    const relevant = new Map<string, { title: string; isCaptain: boolean }>()
    if (captainTaskId) relevant.set(captainTaskId, { title: 'Captain', isCaptain: true })
    for (const task of tasks) {
      if (isInProject(task, currentProjectId)) relevant.set(task.id, { title: task.title || 'Task', isCaptain: false })
    }

    // Switching projects removes the old project's watches silently.
    for (const taskId of [...connectionRef.current.keys()]) {
      if (!relevant.has(taskId)) connectionRef.current.delete(taskId)
    }

    for (const [taskId, info] of relevant) {
      const session = sessions[taskId]
      const previous = connectionRef.current.get(taskId)
      const active = session?.status === 'working' || session?.status === 'waiting_approval'
      if (!session) {
        // An epoch replacement clears old observations immediately. If this
        // was a known live connection, report the loss once.
        if (previous && !previous.lost) {
          queue.enqueue(connectionAnnouncement(taskId, info, 'lost', now))
          connectionRef.current.set(taskId, { lost: true, announcedLost: true })
        }
        continue
      }
      if (!active) {
        connectionRef.current.delete(taskId)
        continue
      }

      const expiresAt = session.observedAt + ACTIVITY_STALE_MS
      scheduleActivityDeadline(expiresAt)
      const fresh = session.observedAt <= now && now < expiresAt
      if (!previous) {
        // Hydration/first sighting establishes the baseline without speaking.
        connectionRef.current.set(taskId, { lost: !fresh, announcedLost: false })
      } else if (!fresh && !previous.lost) {
        queue.enqueue(connectionAnnouncement(taskId, info, 'lost', now))
        connectionRef.current.set(taskId, { lost: true, announcedLost: true })
      } else if (fresh && previous.lost) {
        if (previous.announcedLost) queue.enqueue(connectionAnnouncement(taskId, info, 'restored', session.observedAt))
        connectionRef.current.set(taskId, { lost: false, announcedLost: false })
      }
    }
  }, [sessions, tick, currentProjectId, tasks, captainTaskId])

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="activity-announcer">
      {message}
    </div>
  )
}

function connectionAnnouncement(
  taskId: string,
  info: { title: string; isCaptain: boolean },
  state: 'lost' | 'restored',
  at: number
): Parameters<ActivityAnnouncementQueue['enqueue']>[0] {
  const who = info.isCaptain ? 'Captain' : info.title
  const restored = state === 'restored'
  return {
    key: `task:${taskId}:connection-${state}:${at}`,
    // Loss and restoration use separate routine buckets so a quick recovery
    // is not suppressed by the per-entity routine limit.
    entity: `task:${taskId}:connection-${state}`,
    kind: 'routine',
    message: `${who} connection ${restored ? 'restored' : 'lost'}`,
    group: `connection-${state}`,
    aggregate: (n) => `${n} task connections ${restored ? 'restored' : 'lost'}`
  }
}

import { useEffect, useRef, useState } from 'react'
import { ActivityAnnouncementQueue } from '@/lib/activity/announcer'
import { onSessionTransition, type SessionTransition } from '@/lib/activity/session-activity-adapter'
import { ensureLifecycleWatcher, onLifecycleCompletion, type LifecycleCompletion } from '@/lib/activity/lifecycle-watcher'
import { getCaptainTaskId } from '@/stores/coordinator-store'
import { useTaskStore } from '@/stores/task-store'
import { getCurrentProjectId, isInProject } from '@/stores/project-store'

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

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="activity-announcer">
      {message}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { isRunningActivity } from '@shared/activity'
import { useTaskStore } from '@/stores/task-store'
import { activityNow, scheduleActivityDeadline, useActivityClock } from './activity-clock'
import { deriveActivity, type ActivityResult } from './derive-activity'
import {
  captainEvidence,
  queueFromState,
  retainQueueSource,
  taskEvidence,
  useSessionActivityStore
} from './session-activity-adapter'
import { ensureLifecycleWatcher, useLifecycleActivityStore } from './lifecycle-watcher'
import {
  commanderEvidence,
  ensureCommanderActivitySubscription,
  latestCommanderObservation,
  useCommanderActivityStore
} from './commander-activity-adapter'
import { ensureVoiceAttribution, useVoiceActivity } from './voice-activity-adapter'

/** Follows the user's reduced-motion preference. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const get = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [reduced, setReduced] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (): void => setReduced(mql.matches)
    onChange()
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

/** Re-derives at the result's own expiry through the shared scheduler. */
function useScheduledResult(result: ActivityResult): ActivityResult {
  useEffect(() => {
    scheduleActivityDeadline(result.expiresAt)
  }, [result.expiresAt])
  return result
}

/** Keeps the shared queue and lifecycle sources running while mounted. */
export function useActivitySources(): void {
  useEffect(() => {
    ensureLifecycleWatcher()
    return retainQueueSource()
  }, [])
}

/** Live activity of one ordinary task. */
export function useTaskActivity(taskId: string | null | undefined): ActivityResult {
  useActivitySources()
  const tick = useActivityClock((s) => s.tick)
  const session = useSessionActivityStore((s) => (taskId ? s.sessions[taskId] : undefined))
  const queueEntry = useSessionActivityStore((s) => (taskId ? s.queue[taskId] : undefined))
  const queueObservedAt = useSessionActivityStore((s) => s.queueObservedAt)
  const lifecycle = useTaskStore((s) => (taskId ? s.tasks.find((t) => t.id === taskId)?.status : undefined))
  const finishedAt = useLifecycleActivityStore((s) => (taskId ? s.finishedAt[taskId] : undefined))

  const result = useMemo(() => {
    void tick
    const queue = taskId ? queueFromState(taskId, queueEntry ? { [taskId]: queueEntry } : {}, queueObservedAt) : undefined
    return deriveActivity(taskEvidence({ session, queue, lifecycle, lifecycleFinishedAt: finishedAt ?? null }), activityNow())
  }, [tick, taskId, session, queueEntry, queueObservedAt, lifecycle, finishedAt])
  return useScheduledResult(result)
}

/** Live activity of a project's Captain, including verified speech. */
export function useCaptainActivity(captainTaskId: string | null | undefined): ActivityResult {
  const tick = useActivityClock((s) => s.tick)
  useEffect(() => {
    ensureVoiceAttribution()
  }, [])
  const session = useSessionActivityStore((s) => (captainTaskId ? s.sessions[captainTaskId] : undefined))
  const voiceTarget = useMemo(() => (captainTaskId ? { kind: 'captain' as const, id: captainTaskId } : null), [captainTaskId])
  const voice = useVoiceActivity(voiceTarget)
  const voiceState = voice?.state
  const micOpen = voice?.micOpen
  const result = useMemo(() => {
    void tick
    if (!captainTaskId) return deriveActivity({ entity: 'captain' }, activityNow())
    const evidence = captainEvidence(session)
    return deriveActivity({ ...evidence, voice: voiceState ? { state: voiceState, micOpen } : null }, activityNow())
  }, [tick, captainTaskId, session, voiceState, micOpen])
  return useScheduledResult(result)
}

/** Live activity of the Commander (its most recently active conversation). */
export function useCommanderActivity(): ActivityResult {
  const tick = useActivityClock((s) => s.tick)
  useEffect(() => {
    ensureCommanderActivitySubscription()
  }, [])
  const sessions = useCommanderActivityStore((s) => s.sessions)
  const subscribed = useCommanderActivityStore((s) => s.subscribed)
  const result = useMemo(() => {
    void tick
    return deriveActivity(commanderEvidence(latestCommanderObservation(sessions), subscribed), activityNow())
  }, [tick, sessions, subscribed])
  return useScheduledResult(result)
}

export interface ProjectActivitySummary {
  running: number
  needsInput: number
  queued: number
  failed: number
  /** Sessions whose last known state was active but whose evidence has expired. */
  unavailable: number
}

/**
 * Project-scoped counts for the status bar. Running counts only fresh
 * running/thinking/tool sessions; waits, queue, failures and unknown are
 * counted separately and never as running.
 */
export function summarizeProjectActivity(
  taskIds: ReadonlySet<string>,
  state: Pick<ReturnType<typeof useSessionActivityStore.getState>, 'sessions' | 'queue' | 'queueObservedAt'>,
  now: number
): { summary: ProjectActivitySummary; expiresAt: number | null } {
  const summary: ProjectActivitySummary = { running: 0, needsInput: 0, queued: 0, failed: 0, unavailable: 0 }
  let expiresAt: number | null = null
  const note = (at: number | null): void => {
    if (at != null && (expiresAt == null || at < expiresAt)) expiresAt = at
  }
  for (const taskId of taskIds) {
    const session = state.sessions[taskId]
    const queue = queueFromState(taskId, state.queue, state.queueObservedAt)
    if (!session && !queue) continue
    const r = deriveActivity(taskEvidence({ session, queue }), now)
    note(r.expiresAt)
    if (isRunningActivity(r.state)) summary.running++
    else if (r.state === 'waiting-for-user') summary.needsInput++
    else if (r.state === 'queued') summary.queued++
    else if (r.state === 'failed') summary.failed++
    else if (r.state === 'unknown' && r.lastKnown && r.lastKnown !== 'idle' && r.lastKnown !== 'failed') summary.unavailable++
  }
  return { summary, expiresAt }
}

export function useProjectActivitySummary(taskIds: ReadonlySet<string>): ProjectActivitySummary {
  useActivitySources()
  const tick = useActivityClock((s) => s.tick)
  const sessions = useSessionActivityStore((s) => s.sessions)
  const queue = useSessionActivityStore((s) => s.queue)
  const queueObservedAt = useSessionActivityStore((s) => s.queueObservedAt)
  const { summary, expiresAt } = useMemo(() => {
    void tick
    return summarizeProjectActivity(taskIds, { sessions, queue, queueObservedAt }, activityNow())
  }, [tick, taskIds, sessions, queue, queueObservedAt])
  useEffect(() => {
    scheduleActivityDeadline(expiresAt)
  }, [expiresAt])
  return summary
}

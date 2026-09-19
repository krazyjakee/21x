import { create } from 'zustand'
import { readAgentStatusActivityMeta, ACTIVITY_REVALIDATE_MS, type ActivityQueueReason } from '@shared/activity'
import { activityNow, revalidateActivityNow } from './activity-clock'
import type { ActivityEvidence, LiveObservation, LivePhase, OutcomeObservation, QueueObservation } from './derive-activity'

/**
 * Task and Captain session observations (#95).
 *
 * Fed by every `agent:status` push, including the freshness heartbeats main
 * sends after a successful adapter poll. Only a new, in-order observation
 * renews a deadline: replayed or out-of-order pushes are rejected by the
 * epoch/sequence check, and nothing here re-reads the agent store's cached
 * status. Kept separate from the agent store on purpose: that store's
 * `initSession` and transcript hydration invent statuses that are not
 * evidence of a live process.
 */

export interface SessionObservation {
  taskId: string
  sessionId: string
  agentId: string
  status: LivePhase
  /** Monotonic receipt time of the latest accepted observation. */
  observedAt: number
  /** The latest observed transition (never set by the first observation). */
  lastTransition?: { from: LivePhase; to: LivePhase; at: number }
}

export interface QueueEntryObservation {
  reason?: string
  position?: number
}

interface SessionActivityState {
  sessions: Record<string, SessionObservation>
  /** Latest successful StartQueue read, keyed by task id. */
  queue: Record<string, QueueEntryObservation>
  /** Monotonic time of the latest successful queue read, null before the first. */
  queueObservedAt: number | null
  /** Last accepted agent:status epoch/sequence. */
  epoch: string | null
  seq: number
}

export const useSessionActivityStore = create<SessionActivityState>(() => ({
  sessions: {},
  queue: {},
  queueObservedAt: null,
  epoch: null,
  seq: 0
}))

export interface SessionTransition {
  taskId: string
  from: LivePhase
  to: LivePhase
  at: number
}

type TransitionListener = (transition: SessionTransition) => void
const transitionListeners = new Set<TransitionListener>()

/** Subscribe to observed session transitions (not heartbeats, not first sightings). */
export function onSessionTransition(listener: TransitionListener): () => void {
  transitionListeners.add(listener)
  return () => transitionListeners.delete(listener)
}

const KNOWN_PHASES: ReadonlySet<string> = new Set(['idle', 'working', 'error', 'waiting_approval'])

/**
 * Records one `agent:status` push. Returns false when the push was rejected
 * (malformed, or older than one already accepted in this main-process epoch).
 */
export function recordAgentStatus(event: unknown, now: number = activityNow()): boolean {
  if (!event || typeof event !== 'object') return false
  const e = event as { taskId?: unknown; sessionId?: unknown; agentId?: unknown; status?: unknown }
  if (typeof e.taskId !== 'string' || !e.taskId) return false
  if (typeof e.status !== 'string' || !KNOWN_PHASES.has(e.status)) return false
  const meta = readAgentStatusActivityMeta(event)
  const state = useSessionActivityStore.getState()

  let epoch = state.epoch
  let seq = state.seq
  if (meta) {
    if (meta.epoch === state.epoch && meta.seq <= state.seq) return false
    epoch = meta.epoch
    seq = meta.seq
  }

  const taskId = e.taskId
  const status = e.status as LivePhase
  const previous = state.sessions[taskId]
  const sessionId = typeof e.sessionId === 'string' ? e.sessionId : previous?.sessionId ?? ''
  const changed = previous !== undefined && previous.status !== status
  const next: SessionObservation = {
    taskId,
    sessionId,
    agentId: typeof e.agentId === 'string' ? e.agentId : previous?.agentId ?? '',
    status,
    observedAt: now,
    ...(changed
      ? { lastTransition: { from: previous.status, to: status, at: now } }
      : previous?.lastTransition
        ? { lastTransition: previous.lastTransition }
        : {})
  }
  useSessionActivityStore.setState({ sessions: { ...state.sessions, [taskId]: next }, epoch, seq })
  if (changed) {
    const transition = { taskId, from: previous.status, to: status, at: now }
    for (const listener of transitionListeners) {
      try {
        listener(transition)
      } catch (err) {
        console.error('[activity] transition listener failed:', err)
      }
    }
  }
  return true
}

/** Records a successful StartQueue read or push. */
export function recordStartQueue(
  entries: Array<{ taskId: string; reason?: string; position?: number }> | null | undefined,
  now: number = activityNow()
): void {
  const queue: Record<string, QueueEntryObservation> = {}
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.taskId !== 'string') continue
    queue[entry.taskId] = {
      ...(typeof entry.reason === 'string' ? { reason: entry.reason as ActivityQueueReason } : {}),
      ...(typeof entry.position === 'number' ? { position: entry.position } : {})
    }
  }
  useSessionActivityStore.setState({ queue, queueObservedAt: now })
}

/** Test-only reset. */
export function __resetSessionActivity(): void {
  useSessionActivityStore.setState({ sessions: {}, queue: {}, queueObservedAt: null, epoch: null, seq: 0 })
  transitionListeners.clear()
}

// ── Evidence ────────────────────────────────────────────────

export function liveFromSession(session: SessionObservation | undefined): LiveObservation | null {
  return session ? { phase: session.status, observedAt: session.observedAt } : null
}

export function queueFromState(
  taskId: string,
  queue: Record<string, QueueEntryObservation>,
  queueObservedAt: number | null
): QueueObservation | null | undefined {
  if (queueObservedAt == null) return undefined
  const entry = queue[taskId]
  return entry ? { ...entry, observedAt: queueObservedAt } : null
}

/**
 * Evidence for an ordinary task: live session, queue, durable lifecycle and a
 * lifecycle completion observed in this renderer.
 */
export function taskEvidence(
  input: {
    session?: SessionObservation
    queue?: QueueObservation | null
    lifecycle?: string | null
    lifecycleFinishedAt?: number | null
  }
): ActivityEvidence {
  const session = input.session
  let outcome: OutcomeObservation | null = null
  if (input.lifecycleFinishedAt != null) outcome = { kind: 'finished', observedAt: input.lifecycleFinishedAt }
  if (session?.lastTransition && session.lastTransition.to === 'error' && session.status === 'error') {
    outcome = { kind: 'failed', observedAt: session.lastTransition.at }
  }
  return {
    entity: 'task',
    live: liveFromSession(session),
    queue: input.queue,
    lifecycle: input.lifecycle ?? null,
    outcome
  }
}

/**
 * Evidence for a Captain. A turn ending (working → idle) is "Reply finished",
 * never "Ready for review": the Captain row has no ordinary completion.
 */
export function captainEvidence(session: SessionObservation | undefined): ActivityEvidence {
  let outcome: OutcomeObservation | null = null
  const t = session?.lastTransition
  if (t && t.from === 'working' && t.to === 'idle' && session?.status === 'idle') {
    outcome = { kind: 'finished', observedAt: t.at }
  } else if (t && t.to === 'error' && session?.status === 'error') {
    outcome = { kind: 'failed', observedAt: t.at }
  }
  return { entity: 'captain', live: liveFromSession(session), outcome }
}

// ── Queue source (one shared revalidation loop) ─────────────

let queueConsumers = 0
let queueTimer: ReturnType<typeof setInterval> | null = null
let queuePushOff: (() => void) | null = null
let queueGeneration = 0

async function readQueue(): Promise<void> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.agents : undefined
  if (typeof api?.getStartQueue !== 'function') return
  const generation = ++queueGeneration
  try {
    const entries = await api.getStartQueue()
    // A slower, older read must not overwrite a newer one.
    if (generation !== queueGeneration) return
    recordStartQueue(entries)
  } catch {
    // A failed read renews nothing: queue claims expire to unknown.
  }
}

/**
 * Keeps the StartQueue observation fresh while at least one indicator needs
 * it and the window is visible. Returns the release function.
 */
export function retainQueueSource(): () => void {
  queueConsumers += 1
  if (queueConsumers === 1) {
    void readQueue()
    queueTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void readQueue()
    }, ACTIVITY_REVALIDATE_MS)
    try {
      const subscribe = window.electronAPI?.onAgentStartQueueChanged
      if (typeof subscribe === 'function') {
        queuePushOff = subscribe((event) => {
          queueGeneration += 1
          recordStartQueue(event?.queue)
        })
      }
    } catch {
      queuePushOff = null
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    queueConsumers -= 1
    if (queueConsumers === 0) {
      if (queueTimer) clearInterval(queueTimer)
      queueTimer = null
      queuePushOff?.()
      queuePushOff = null
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && queueConsumers > 0) {
      void readQueue().then(() => revalidateActivityNow())
    }
  })
}

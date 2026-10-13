import { desktopApi } from '@/lib/desktop-api'
import { create } from 'zustand'
import type { CommanderEvent } from '@shared/commander'
import { ACTIVITY_REVALIDATE_MS, readCommanderActivitySnapshot } from '@shared/activity'
import { activityNow, revalidateActivityNow } from './activity-clock'
import type { ActivityEvidence, LiveObservation, OutcomeObservation } from './derive-activity'

/**
 * Commander turn activity (#95).
 *
 * Reads `commander:event` pushes directly, so the state stays current while
 * the Commander view is closed (the view's own store unsubscribes when it
 * unmounts). Every event of the current turn is an observation; events of an
 * older turn are ignored. Commander has no heartbeat yet, so a turn that goes
 * quiet for 15 s shows as unknown ("Last seen replying") rather than as a
 * turn that is still running. A cached active turn id proves nothing about
 * provider health and is never read here.
 */

export interface CommanderTurnObservation {
  sessionId: string
  turnId: string
  phase: 'thinking' | 'working' | 'tool' | 'idle' | 'error'
  /** Unresolved tool calls of this turn, in start order. */
  openTools: Array<{ id: string; name: string }>
  hasText: boolean
  observedAt: number
  outcome?: OutcomeObservation
  error?: string
  unavailable?: boolean
  known?: boolean
}

interface CommanderActivityState {
  /** Per Commander session. */
  sessions: Record<string, CommanderTurnObservation>
  /** True once the event subscription is live. False means every result is unknown. */
  subscribed: boolean
  epoch: string | null
  sequences: Record<string, number>
}

export const useCommanderActivityStore = create<CommanderActivityState>(() => ({ sessions: {}, subscribed: false, epoch: null, sequences: {} }))
const retiredEpochs = new Set<string>()

/** A repeated active read retains its original source age. Snapshot hydration
 * never announces completion; only a real observed terminal event may do so. */
export function recordCommanderSnapshot(sessionId: string, value: unknown, now = activityNow(), lagMs = 0, liveEvent = false): boolean {
  const snapshot = readCommanderActivitySnapshot(value)
  if (!snapshot || retiredEpochs.has(snapshot.epoch)) return false
  const state = useCommanderActivityStore.getState()
  let sessions = state.sessions
  let sequences = state.sequences
  if (state.epoch && snapshot.epoch !== state.epoch) {
    retiredEpochs.add(state.epoch)
    sessions = {}; sequences = {}
  } else if (snapshot.sequence <= (sequences[sessionId] ?? 0)) return false
  const previous = sessions[sessionId]
  const observedAt = now - snapshot.ageMs - Math.max(0, lagMs)
  const matching = previous?.turnId === (snapshot.turnId ?? '')
  const next: CommanderTurnObservation = {
    sessionId, turnId: snapshot.turnId ?? '',
    phase: snapshot.phase === 'unknown' ? matching ? previous!.phase : 'working' : snapshot.phase,
    unavailable: snapshot.phase === 'unknown', openTools: snapshot.openTools, hasText: snapshot.hasText, observedAt,
    known: snapshot.phase !== 'unknown' || Boolean(matching && previous?.known !== false),
    ...(snapshot.reason ? { error: snapshot.reason } : {}),
    ...(liveEvent && matching && snapshot.outcome ? { outcome: { kind: snapshot.outcome, observedAt, reason: snapshot.reason } }
      : matching && (snapshot.phase === 'idle' || snapshot.phase === 'error') && previous?.outcome ? { outcome: previous.outcome } : {})
  }
  useCommanderActivityStore.setState({ sessions: { ...sessions, [sessionId]: next }, subscribed: true,
    epoch: snapshot.epoch, sequences: { ...sequences, [sessionId]: snapshot.sequence } })
  return true
}

/** Applies one Commander event. Pure over the previous observation. */
export function reduceCommanderEvent(
  previous: CommanderTurnObservation | undefined,
  event: CommanderEvent,
  now: number
): CommanderTurnObservation | undefined {
  if (event.type === 'turn_started') {
    return { sessionId: event.sessionId, turnId: event.turnId, phase: 'thinking', openTools: [], hasText: false, observedAt: now }
  }
  if (event.type !== 'turn_event') return previous
  // A late event from an earlier turn must not revive or overwrite the current one.
  if (previous && previous.turnId !== event.turnId) return previous
  const base: CommanderTurnObservation = previous ?? {
    sessionId: event.sessionId,
    turnId: event.turnId,
    phase: 'working',
    openTools: [],
    hasText: false,
    observedAt: now
  }
  // A finished turn stays finished; only a new turn_started reopens it.
  if (base.phase === 'idle' || base.phase === 'error') return base
  const inner = event.event
  switch (inner.type) {
    case 'text_delta': {
      const phase = base.openTools.length > 0 ? 'tool' : 'working'
      return { ...base, phase, hasText: true, observedAt: now }
    }
    case 'tool_call_start':
      return { ...base, phase: 'tool', openTools: [...base.openTools, { id: inner.id, name: inner.name }], observedAt: now }
    case 'tool_call_result': {
      const openTools = base.openTools.filter((t) => t.id !== inner.id)
      const phase = openTools.length > 0 ? 'tool' : base.hasText ? 'working' : 'thinking'
      return { ...base, phase, openTools, observedAt: now }
    }
    case 'done':
      return {
        ...base,
        phase: 'idle',
        openTools: [],
        observedAt: now,
        outcome: { kind: inner.stopReason === 'cancelled' ? 'stopped' : 'finished', observedAt: now }
      }
    case 'error':
      return { ...base, phase: 'error', openTools: [], observedAt: now, error: inner.message, outcome: { kind: 'failed', observedAt: now, reason: inner.message } }
    default:
      return base
  }
}

export function recordCommanderEvent(event: CommanderEvent, now: number = activityNow()): void {
  if (event.type !== 'turn_started' && event.type !== 'turn_event') return
  if (event.activity) {
    recordCommanderSnapshot(event.sessionId, event.activity, now, 0, true)
    return
  }
  const state = useCommanderActivityStore.getState()
  if (state.epoch) return
  const next = reduceCommanderEvent(state.sessions[event.sessionId], event, now)
  if (!next || next === state.sessions[event.sessionId]) return
  useCommanderActivityStore.setState({ sessions: { ...state.sessions, [event.sessionId]: next } })
}

/** Evidence for one Commander turn observation (the most recent when omitted). */
export function commanderEvidence(observation: CommanderTurnObservation | undefined, subscribed: boolean): ActivityEvidence {
  if (!subscribed || !observation || observation.known === false) return { entity: 'commander', live: null }
  const live: LiveObservation = {
    phase: observation.phase === 'working' ? 'working' : observation.phase,
    observedAt: observation.observedAt,
    ...(observation.phase === 'tool' && observation.openTools.length > 0
      ? { toolName: observation.openTools[observation.openTools.length - 1].name }
      : {}),
    ...(observation.error ? { reason: observation.error } : {})
  }
  return { entity: 'commander', live, outcome: observation.outcome ?? null, disconnected: observation.unavailable }
}

/** The most recently observed Commander session. */
export function latestCommanderObservation(sessions: Record<string, CommanderTurnObservation>): CommanderTurnObservation | undefined {
  let latest: CommanderTurnObservation | undefined
  for (const s of Object.values(sessions)) if (!latest || s.observedAt > latest.observedAt) latest = s
  return latest
}

let unsubscribe: (() => void) | null = null
const consumers = new Map<string, number>()
const requests = new Map<string, number>()
let sourceTimer: ReturnType<typeof setInterval> | null = null
let requestSequence = 0

async function readSource(sessionId: string): Promise<void> {
  const api = typeof window !== 'undefined' ? desktopApi?.commander : undefined
  if (typeof api?.getActivity !== 'function' || !consumers.has(sessionId) || requests.has(sessionId)) return
  const request = ++requestSequence
  requests.set(sessionId, request)
  const started = activityNow()
  try {
    const snapshot = await api.getActivity(sessionId)
    if (requests.get(sessionId) !== request || !consumers.has(sessionId)) return
    recordCommanderSnapshot(sessionId, snapshot, activityNow(), activityNow() - started)
  } catch {
    // A failed source read renews nothing; an explicit retired bridge cannot
    // claim activity while cached values await their expiry.
  } finally { if (requests.get(sessionId) === request) requests.delete(sessionId) }
}

/** One shared five-second source loop, independent of transcript hydration. */
export function retainCommanderSource(sessionId: string): () => void {
  ensureCommanderActivitySubscription()
  consumers.set(sessionId, (consumers.get(sessionId) ?? 0) + 1)
  if (consumers.get(sessionId) === 1) void readSource(sessionId)
  if (!sourceTimer) sourceTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    for (const id of consumers.keys()) void readSource(id)
  }, ACTIVITY_REVALIDATE_MS)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (consumers.get(sessionId) ?? 1) - 1
    if (count) consumers.set(sessionId, count)
    else { consumers.delete(sessionId); requests.delete(sessionId) }
    if (!consumers.size && sourceTimer) { clearInterval(sourceTimer); sourceTimer = null }
  }
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  revalidateActivityNow()
  if (!document.hidden) for (const id of consumers.keys()) void readSource(id)
})

/** Starts listening to Commander events. Idempotent; safe without a bridge. */
export function ensureCommanderActivitySubscription(): void {
  if (unsubscribe) return
  try {
    const onEvent = typeof window !== 'undefined' ? desktopApi?.commander?.onEvent : undefined
    if (typeof onEvent !== 'function') return
    unsubscribe = onEvent((event) => recordCommanderEvent(event))
    useCommanderActivityStore.setState({ subscribed: true })
  } catch {
    unsubscribe = null
  }
}

/** Test-only reset. */
export function __resetCommanderActivity(): void {
  unsubscribe?.()
  unsubscribe = null
  if (sourceTimer) clearInterval(sourceTimer)
  sourceTimer = null
  consumers.clear(); requests.clear(); retiredEpochs.clear()
  useCommanderActivityStore.setState({ sessions: {}, subscribed: false, epoch: null, sequences: {} })
}

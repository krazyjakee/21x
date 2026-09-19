import { create } from 'zustand'
import type { CommanderEvent } from '@shared/commander'
import { activityNow } from './activity-clock'
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
}

interface CommanderActivityState {
  /** Per Commander session. */
  sessions: Record<string, CommanderTurnObservation>
  /** True once the event subscription is live. False means every result is unknown. */
  subscribed: boolean
}

export const useCommanderActivityStore = create<CommanderActivityState>(() => ({ sessions: {}, subscribed: false }))

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
  const state = useCommanderActivityStore.getState()
  const next = reduceCommanderEvent(state.sessions[event.sessionId], event, now)
  if (!next || next === state.sessions[event.sessionId]) return
  useCommanderActivityStore.setState({ sessions: { ...state.sessions, [event.sessionId]: next } })
}

/** Evidence for one Commander turn observation (the most recent when omitted). */
export function commanderEvidence(observation: CommanderTurnObservation | undefined, subscribed: boolean): ActivityEvidence {
  if (!subscribed || !observation) return { entity: 'commander', live: null }
  const live: LiveObservation = {
    phase: observation.phase === 'working' ? 'working' : observation.phase,
    observedAt: observation.observedAt,
    ...(observation.phase === 'tool' && observation.openTools.length > 0
      ? { toolName: observation.openTools[observation.openTools.length - 1].name }
      : {}),
    ...(observation.error ? { reason: observation.error } : {})
  }
  return { entity: 'commander', live, outcome: observation.outcome ?? null }
}

/** The most recently observed Commander session. */
export function latestCommanderObservation(sessions: Record<string, CommanderTurnObservation>): CommanderTurnObservation | undefined {
  let latest: CommanderTurnObservation | undefined
  for (const s of Object.values(sessions)) if (!latest || s.observedAt > latest.observedAt) latest = s
  return latest
}

let unsubscribe: (() => void) | null = null

/** Starts listening to Commander events. Idempotent; safe without a bridge. */
export function ensureCommanderActivitySubscription(): void {
  if (unsubscribe) return
  try {
    const onEvent = typeof window !== 'undefined' ? window.electronAPI?.commander?.onEvent : undefined
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
  useCommanderActivityStore.setState({ sessions: {}, subscribed: false })
}

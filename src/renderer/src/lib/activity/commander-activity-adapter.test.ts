import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommanderEvent } from '@shared/commander'
import { ACTIVITY_STALE_MS } from '@shared/activity'
import { deriveActivity } from './derive-activity'
import { __resetCommanderActivity, commanderEvidence, recordCommanderSnapshot, reduceCommanderEvent, retainCommanderSource, useCommanderActivityStore, type CommanderTurnObservation } from './commander-activity-adapter'
import type { CommanderActivitySnapshot } from '@shared/activity'

beforeEach(() => __resetCommanderActivity())
afterEach(() => { __resetCommanderActivity(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

const snapshot = (over: Partial<CommanderActivitySnapshot> = {}): CommanderActivitySnapshot => ({
  epoch: 'main-1', sequence: 1, turnId: 't', phase: 'working', ageMs: 0, openTools: [], hasText: true, ...over
})

const ev = (turnId: string, event: Extract<CommanderEvent, { type: 'turn_event' }>['event']): CommanderEvent => ({
  type: 'turn_event',
  sessionId: 's',
  turnId,
  event
})

function run(events: CommanderEvent[]): CommanderTurnObservation | undefined {
  let obs: CommanderTurnObservation | undefined
  events.forEach((e, i) => {
    obs = reduceCommanderEvent(obs, e, i * 100)
  })
  return obs
}

const result = (obs: CommanderTurnObservation | undefined, now = 1_000) => deriveActivity(commanderEvidence(obs, true), now)

describe('Commander activity adapter', () => {
  it('a started turn awaiting its first text is thinking', () => {
    expect(result(run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }])).state).toBe('thinking')
  })

  it('text makes it running ("Replying"); an unresolved tool makes it a tool state', () => {
    const replying = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }, ev('t1', { type: 'text_delta', text: 'hi' })])
    expect(result(replying).label).toBe('Replying')
    const tool = run([
      { type: 'turn_started', sessionId: 's', turnId: 't1' },
      ev('t1', { type: 'tool_call_start', id: 'c1', name: 'list_tasks', input: {} })
    ])
    expect(result(tool)).toMatchObject({ state: 'tool', label: 'Using list_tasks' })
    const resolved = reduceCommanderEvent(tool, ev('t1', { type: 'tool_call_result', id: 'c1', name: 'list_tasks', content: '', isError: false }), 300)
    expect(result(resolved).state).toBe('thinking')
  })

  it('done is a brief "Reply finished", cancelled is Stopped, error is Failed', () => {
    const done = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }, ev('t1', { type: 'done', stopReason: 'end_turn' })])
    expect(result(done, 150)).toMatchObject({ state: 'finished', label: 'Reply finished' })
    const cancelled = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }, ev('t1', { type: 'done', stopReason: 'cancelled' })])
    expect(result(cancelled, 150)).toMatchObject({ state: 'idle', detail: 'Stopped' })
    const failed = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }, ev('t1', { type: 'error', message: 'rate limited' })])
    expect(result(failed, 150)).toMatchObject({ state: 'failed', detail: 'rate limited' })
  })

  it('late events from an earlier turn are ignored, and a finished turn is not revived', () => {
    const obs = run([
      { type: 'turn_started', sessionId: 's', turnId: 't1' },
      ev('t1', { type: 'done', stopReason: 'end_turn' }),
      { type: 'turn_started', sessionId: 's', turnId: 't2' },
      ev('t1', { type: 'text_delta', text: 'late' })
    ])
    expect(obs).toMatchObject({ turnId: 't2', phase: 'thinking', hasText: false })
    const finished = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }, ev('t1', { type: 'done', stopReason: 'end_turn' })])
    expect(reduceCommanderEvent(finished, ev('t1', { type: 'text_delta', text: 'x' }), 500)?.phase).toBe('idle')
  })

  it('a silent turn (missed done) goes unknown after 15 s', () => {
    const obs = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }, ev('t1', { type: 'text_delta', text: 'hi' })])
    const r = result(obs, 100 + ACTIVITY_STALE_MS)
    expect(r).toMatchObject({ state: 'unknown', detail: 'Last seen replying' })
  })

  it('without a live subscription every result is unknown', () => {
    const obs = run([{ type: 'turn_started', sessionId: 's', turnId: 't1' }])
    expect(deriveActivity(commanderEvidence(obs, false), 0).state).toBe('unknown')
  })

  it('retains source age and rejects repeated snapshots instead of renewing a silent provider', () => {
    expect(recordCommanderSnapshot('s', snapshot({ ageMs: 6_000 }), 10_000)).toBe(true)
    expect(recordCommanderSnapshot('s', snapshot({ ageMs: 9_000 }), 13_000)).toBe(false)
    const state = useCommanderActivityStore.getState()
    expect(state.sessions.s.observedAt).toBe(4_000)
    expect(deriveActivity(commanderEvidence(state.sessions.s, state.subscribed), 19_000).state).toBe('unknown')
    expect(recordCommanderSnapshot('s', snapshot({ sequence: 2, ageMs: 0 }), 20_000, 500)).toBe(true)
    expect(useCommanderActivityStore.getState().sessions.s.observedAt).toBe(19_500)
  })

  it('retires old main epochs and does not replay a finished accent from hydration', () => {
    recordCommanderSnapshot('s', snapshot({ sequence: 5 }), 0)
    recordCommanderSnapshot('s', snapshot({ epoch: 'main-2', phase: 'idle', outcome: 'finished' }), 100)
    expect(recordCommanderSnapshot('s', snapshot({ sequence: 6 }), 200)).toBe(false)
    const state = useCommanderActivityStore.getState()
    expect(state.epoch).toBe('main-2')
    expect(state.sessions.s.outcome).toBeUndefined()
    expect(deriveActivity(commanderEvidence(state.sessions.s, state.subscribed), 200).state).toBe('idle')
  })

  it('unknown snapshots and malformed metadata cannot produce a running claim', () => {
    recordCommanderSnapshot('s', snapshot({ phase: 'unknown' }), 0)
    const state = useCommanderActivityStore.getState()
    expect(deriveActivity(commanderEvidence(state.sessions.s, state.subscribed), 0).state).toBe('unknown')
    expect(recordCommanderSnapshot('s', snapshot({ sequence: 2, ageMs: -1 }), 1)).toBe(false)
  })

  it('uses one source loop and prevents hung reads or released late replies from refreshing evidence', async () => {
    vi.useFakeTimers()
    let resolve!: (value: CommanderActivitySnapshot) => void
    const pending = new Promise<CommanderActivitySnapshot>(done => { resolve = done })
    const getActivity = vi.fn(() => pending)
    vi.stubGlobal('window', { ...window, electronAPI: { ...window.electronAPI,
      commander: { getActivity, onEvent: () => () => {} } } })
    const release = retainCommanderSource('s')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getActivity).toHaveBeenCalledTimes(1)
    release()
    resolve(snapshot())
    await pending
    await Promise.resolve()
    expect(useCommanderActivityStore.getState().sessions.s).toBeUndefined()
  })
})

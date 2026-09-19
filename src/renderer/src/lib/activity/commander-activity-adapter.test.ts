import { describe, expect, it } from 'vitest'
import type { CommanderEvent } from '@shared/commander'
import { ACTIVITY_STALE_MS } from '@shared/activity'
import { deriveActivity } from './derive-activity'
import { commanderEvidence, reduceCommanderEvent, type CommanderTurnObservation } from './commander-activity-adapter'

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
})

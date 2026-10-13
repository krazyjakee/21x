import { describe, expect, it } from 'vitest'
import { CommanderActivityObservations } from './activity-observations'

describe('authoritative Commander activity observations', () => {
  it('does not renew a silent active provider by reading the runtime identity', () => {
    let now = 0
    const source = new CommanderActivityObservations(() => now)
    const first = source.record({ type: 'turn_started', sessionId: 's', turnId: 't' })!
    now = 10_000
    expect(source.read('s', 't')).toMatchObject({ sequence: first.sequence, ageMs: 10_000, phase: 'thinking' })
    now = 15_000
    expect(source.read('s', 't')).toMatchObject({ sequence: first.sequence, ageMs: 15_000, phase: 'unknown' })
    expect(source.record({ type: 'turn_event', sessionId: 's', turnId: 't', event: { type: 'text_delta', text: 'Reply' } })).toMatchObject({ phase: 'working', ageMs: 0 })
  })
  it('renews verified idle without manufacturing a finished transition', () => {
    let now = 0
    const source = new CommanderActivityObservations(() => now)
    expect(source.read('new', null)).toMatchObject({ phase: 'idle' })
    expect(source.read('new', null).outcome).toBeUndefined()
    source.record({ type: 'turn_started', sessionId: 's', turnId: 't' })
    source.record({ type: 'turn_event', sessionId: 's', turnId: 't', event: { type: 'done', stopReason: 'cancelled' } })
    now = 20_000
    expect(source.read('s', null)).toMatchObject({ phase: 'idle', ageMs: 0 })
    expect(source.read('s', null).outcome).toBeUndefined()
  })
  it('rejects old turn progress and isolates executing tools from completed history', () => {
    const source = new CommanderActivityObservations(() => 0)
    source.record({ type: 'turn_started', sessionId: 's', turnId: 'current' })
    expect(source.record({ type: 'turn_event', sessionId: 's', turnId: 'old', event: { type: 'text_delta', text: 'Late' } })).toBeUndefined()
    source.record({ type: 'turn_event', sessionId: 's', turnId: 'current', event: { type: 'tool_call_start', id: 'c', name: 'get_project', input: {} } })
    expect(source.read('s', 'current')).toMatchObject({ phase: 'tool', openTools: [{ id: 'c', name: 'get_project' }] })
    source.record({ type: 'turn_event', sessionId: 's', turnId: 'current', event: { type: 'tool_call_result', id: 'c', name: 'get_project', content: '{}', isError: false } })
    expect(source.read('s', 'current')).toMatchObject({ phase: 'thinking', openTools: [] })
    expect(source.read('s', 'other')).toMatchObject({ phase: 'unknown', turnId: 'other' })
    expect(source.read('s', 'current', true)).toMatchObject({ phase: 'unknown' })
  })
})

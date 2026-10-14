import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLLOVER_POLICY, type SessionContextSnapshot } from './session-context'
import { SESSION_CONTEXT_CODECS as codecs, SESSION_CONTEXT_LIMITS, isSessionContextPolicy, isSessionContextSnapshot } from './session-context-codecs'

const snapshot = (): SessionContextSnapshot => ({
  scope: { kind: 'commander', ownerId: 'conversation-one' }, generation: null,
  usage: { tokens: null, source: 'unknown', contextWindow: null, model: null, observedAt: null },
  counters: { compactions: 0, wakeups: 0, turns: 0, ageMs: 0 }, policy: { ...DEFAULT_ROLLOVER_POLICY }, reasons: [],
  warnings: ['Context usage is unavailable until the model reports its input size.'], summaries: [], handoff: null
})
describe('session context production codecs', () => {
  it('retains the two actual preload argument/result shapes with exact scopes and required results', () => {
    for (const kind of ['captain', 'commander'] as const) {
      const scope = { kind, ownerId: 'owner-one' }
      expect(codecs['sessionContext:getSnapshot'].encodeArguments([scope])).toEqual({ scope })
      expect(codecs['sessionContext:getSnapshot'].decodeArguments({ scope })).toEqual([scope])
    }
    expect(codecs['sessionContext:setPolicy'].encodeArguments([{ ...DEFAULT_ROLLOVER_POLICY }])).toEqual({ policy: DEFAULT_ROLLOVER_POLICY })
    expect(codecs['sessionContext:setPolicy'].decodeArguments({ policy: DEFAULT_ROLLOVER_POLICY })).toEqual([DEFAULT_ROLLOVER_POLICY])
    expect(codecs['sessionContext:getSnapshot'].encodeResult(snapshot())).toEqual({ defined: true, value: snapshot() })
    expect(codecs['sessionContext:getSnapshot'].validateWireResult({ defined: false })).toBe(false)
    expect(codecs['sessionContext:getSnapshot'].validateResult(null)).toBe(false)
    for (const scope of [{ kind: 'task', ownerId: 'one' }, { kind: 'captain', ownerId: '../foreign' }, { kind: 'commander', ownerId: '' }, { kind: 'captain', ownerId: 'one', projectId: 'caller-claim' }]) {
      expect(codecs['sessionContext:getSnapshot'].validateArguments([scope])).toBe(false)
    }
    expect(() => codecs['sessionContext:getSnapshot'].decodeArguments({ scope: { kind: 'captain', ownerId: 'one' }, caller: 'trusted' })).toThrow('arguments')
  })

  it('matches actual policy numeric boundaries without coercion or permissive extra keys', () => {
    for (const mode of ['off', 'observe', 'on']) expect(isSessionContextPolicy({ ...DEFAULT_ROLLOVER_POLICY, mode, contextRatio: 1, maxAgeDays: .5, compactions: 1_000_000 })).toBe(true)
    for (const [key, values] of Object.entries({ mode: ['enabled', null], contextRatio: [0, -1, 1.1, Infinity, NaN, '.7'], compactions: [0, 1.5, 1_000_001, '2'],
      wakeups: [-1, 0, '150'], turns: [Number.MAX_SAFE_INTEGER, 1.2], maxAgeDays: [0, -1, 3650.1, '7'] })) {
      for (const value of values) expect(isSessionContextPolicy({ ...DEFAULT_ROLLOVER_POLICY, [key]: value })).toBe(false)
    }
    expect(isSessionContextPolicy({ ...DEFAULT_ROLLOVER_POLICY, stageEnabled: true })).toBe(false)
    expect(codecs['sessionContext:setPolicy'].validateArguments([DEFAULT_ROLLOVER_POLICY, { bypass: true }])).toBe(false)
  })

  it('retains truthful unknown/estimated/reported occupancy and finite generation/handoff states', () => {
    const current = snapshot()
    current.generation = { id: 'generation-id', key: 'adapter:backend-id', engine: 'adapter', state: 'interrupted', createdAt: 100, backendId: 'backend-id' }
    current.scope.kind = 'captain'; current.handoff = { id: 'handoff-id', state: 'creation_unconfirmed' }
    for (const source of ['reported', 'estimated'] as const) {
      current.usage = { tokens: 0, source, contextWindow: 128000, model: 'gpt-4o', observedAt: 101 }
      expect(isSessionContextSnapshot(current)).toBe(true)
    }
    expect(isSessionContextSnapshot({ ...current, usage: { ...current.usage, tokens: null } })).toBe(false)
    expect(isSessionContextSnapshot({ ...current, usage: { ...current.usage, source: 'unknown' } })).toBe(false)
    expect(isSessionContextSnapshot({ ...current, usage: { ...current.usage, tokens: -1 } })).toBe(false)
    expect(isSessionContextSnapshot({ ...current, generation: { ...current.generation, state: 'provider-private-state' } })).toBe(false)
    expect(isSessionContextSnapshot({ ...current, handoff: { id: 'handoff-id', state: 'retry-external-effect' } })).toBe(false)
    expect(isSessionContextSnapshot({ ...current, counters: { ...current.counters, ageMs: NaN } })).toBe(false)
    expect(isSessionContextSnapshot({ ...current, reasons: ['context', 'context'] })).toBe(false)
  })

  it('keeps human Markdown/Unicode summaries and rejects private payloads, extras and byte overflow', () => {
    const current = snapshot()
    current.summaries = [{ id: 'summary:recovery-one', content: '# Continue\n\nKeep **the chosen task** and [reference](https://example.test). 雪', kind: 'recovery', createdAt: 100, source: 'fallback' }]
    const wire = codecs['sessionContext:getSnapshot'].encodeResult(current)
    expect(codecs['sessionContext:getSnapshot'].decodeResult(wire.defined ? wire.value : undefined)).toEqual(current)
    for (const result of [{ ...current, rawPayload: { api_key: 'private' } }, { ...current, usage: { ...current.usage, input: 'private input' } },
      { ...current, summaries: [{ ...current.summaries[0], sourceHistory: 'private' }] }, { ...current, handoff: { id: 'handoff', state: 'pending', source: 'private history' } },
      { ...current, summaries: [{ ...current.summaries[0], content: '雪'.repeat(21846) }] }, { ...current, warnings: ['\0raw'] }]) expect(isSessionContextSnapshot(result)).toBe(false)
    const many = Array.from({ length: SESSION_CONTEXT_LIMITS.summaries }, (_, index) => ({ ...current.summaries[0], id: `summary-${index}`, content: 'x'.repeat(60000) }))
    expect(isSessionContextSnapshot({ ...current, summaries: many })).toBe(false)
    expect(codecs['sessionContext:getSnapshot'].validateWireResult({ defined: true, value: current, internal: 'private' })).toBe(false)
  })
})

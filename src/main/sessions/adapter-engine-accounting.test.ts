import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../../test/helpers/fake-adapter'
import type { AdapterContextUsage, AdapterTokenUsage, SessionConfig } from '../adapters/coding-agent-adapter'
import { AdapterEngine } from './adapter-engine'
import { estimateTokens } from './token-estimator'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks() })
function fixture(role: 'captain' | 'task' = 'task') {
  const db = createPortableTestDb(); databases.push(db)
  const engine = new AdapterEngine(db.db, 'process-one', role)
  const adapter = Object.assign(new FakeAdapter(), {
    getUsage: vi.fn(async (): Promise<AdapterTokenUsage | null> => null),
    getContextUsage: vi.fn(async (): Promise<AdapterContextUsage | null> => null)
  })
  const config: SessionConfig = { taskId: 'owner', agentId: 'agent', workspaceDir: '/tmp', model: 'gpt-4o' }
  const usage = () => db.db.prepare('SELECT input_tokens, output_tokens, input_source, output_source, state FROM session_turn_usage').get()
  return { db, engine, adapter, config, usage }
}

describe('managed adapter accounting', () => {
  it.each(['captain', 'task'] as const)('keeps %s flags independent and records estimates without provider counters', async role => {
    const h = fixture(role)
    expect(h.engine.enabled).toBe(false)
    h.db.setSetting(`sessions.${role}_managed`, 'true')
    expect(h.engine.enabled).toBe(true)
    await h.engine.sendPrompt('owner', 'backend', 'intent', 0, 'A complete instruction', h.adapter, h.config, () => {})
    h.engine.recordOutput('owner', 'backend', 'intent', [{ id: 'answer', role: 'assistant', content: 'Partial answer' }])
    h.engine.recordOutput('owner', 'backend', 'intent', [{ id: 'answer', role: 'assistant', content: 'Partial answer extended' }])
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, null, () => true)
    await h.engine.finishTurn('owner', 'backend', 'intent', 'cancelled')
    expect(h.usage()).toEqual({ input_tokens: estimateTokens('A complete instruction'.length), output_tokens: estimateTokens('Partial answer extended'.length),
      input_source: 'estimated', output_source: 'estimated', state: 'cancelled' })
    expect(h.adapter.sendPrompt).toHaveBeenCalledOnce()
    h.engine.shutdown()
  })

  it('replaces repeated aggregate reports and never treats billing totals as context occupancy', async () => {
    const h = fixture()
    await h.engine.sendPrompt('owner', 'backend', 'intent', 0, 'Continue', h.adapter, h.config, () => {})
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 8000, outputTokens: 120, provenance: 'reported', turnId: 'intent' })
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, null, () => true)
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, null, () => true)
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 8100, outputTokens: 140, provenance: 'reported', turnId: 'intent' })
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, null, () => true)
    expect(h.usage()).toEqual({ input_tokens: 8100, output_tokens: 140, input_source: 'reported', output_source: 'reported', state: 'running' })
    expect(h.db.db.prepare('SELECT COUNT(*) AS count FROM session_usage_calls').get()).toEqual({ count: 1 })
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='context_usage'").get()).toEqual({ count: 0 })
    h.engine.shutdown()
  })

  it('accepts only a fresh matching native turn and fences late reads after a newer intent or shutdown', async () => {
    const h = fixture()
    const old: AdapterContextUsage = { backendSessionId: 'backend', eventKey: 'old', turnId: 'old-turn', tokens: 9, provenance: 'reported', observedAt: Date.now() }
    h.adapter.getContextUsage.mockResolvedValue(old)
    await h.engine.sendPrompt('owner', 'backend', 'intent', 0, 'Continue', h.adapter, h.config, () => {})
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 999, outputTokens: 999, provenance: 'reported', turnId: 'old-turn' })
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, old, () => true)
    expect(h.usage()).toMatchObject({ input_source: 'estimated', output_source: 'estimated' })
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config,
      { ...old, eventKey: 'late-old-counters', observedAt: Date.now() + 1 }, () => true)
    expect(h.usage()).toMatchObject({ input_source: 'estimated', output_source: 'estimated' })
    const fresh = { ...old, eventKey: 'new', turnId: 'new-turn', observedAt: Date.now() + 1 }
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 88, outputTokens: 20, provenance: 'reported', turnId: 'new-turn' })
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, fresh, () => true)
    expect(h.usage()).toMatchObject({ input_tokens: 88, output_tokens: 20, input_source: 'reported' })
    let finish!: (usage: AdapterTokenUsage) => void
    h.adapter.getUsage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, fresh, () => false)
    finish({ inputTokens: 1000, outputTokens: 1000, provenance: 'reported', turnId: 'intent' })
    await pending
    expect(h.usage()).toMatchObject({ input_tokens: 88, output_tokens: 20 })
    h.adapter.getUsage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const late = h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, fresh, () => true)
    h.engine.shutdown()
    const sql = vi.spyOn(h.db.db, 'prepare')
    finish({ inputTokens: 1000, outputTokens: 1000, provenance: 'reported', turnId: 'intent' })
    await late
    h.engine.recordOutput('owner', 'backend', 'intent', [{ id: 'late-output', role: 'assistant', content: 'Ignored after shutdown' }])
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    expect(h.usage()).toMatchObject({ state: 'interrupted', input_tokens: 88 })
  })

  it('uses the first native turn of a newly created backend but keeps an uncorrelated resumed report estimated', async () => {
    const h = fixture()
    const backend = await h.engine.createSession('owner', h.adapter, h.config)
    await h.engine.sendPrompt('owner', backend, 'intent', 0, 'New work', h.adapter, h.config, () => {})
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 80, outputTokens: 20, provenance: 'reported', turnId: 'native-first' })
    const context: AdapterContextUsage = { backendSessionId: backend, eventKey: 'native-input', tokens: 80,
      provenance: 'reported', observedAt: Date.now() + 1, turnId: 'native-first' }
    await h.engine.pollUsage('owner', backend, 'intent', h.adapter, h.config, context, () => true)
    expect(h.usage()).toMatchObject({ input_tokens: 80, output_tokens: 20, input_source: 'reported' })
    await h.engine.finishTurn('owner', backend, 'intent', 'end_turn')
    await h.engine.resumeSession('owner', backend, h.adapter, h.config)
    await h.engine.sendPrompt('owner', backend, 'new-intent', 0, 'Explicit next work', h.adapter, h.config, () => {})
    await h.engine.pollUsage('owner', backend, 'new-intent', h.adapter, h.config, { ...context, eventKey: 'late-read', observedAt: Date.now() + 1 }, () => true)
    expect(h.db.db.prepare("SELECT input_source, output_source FROM session_turn_usage WHERE state='running'").get())
      .toEqual({ input_source: 'estimated', output_source: 'estimated' })
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    h.engine.shutdown()
  })

  it('preserves paid partial attempts and reconciles a crashed process without dispatching', async () => {
    const h = fixture()
    await h.engine.sendPrompt('owner', 'backend', 'intent', 0, 'Original instruction', h.adapter, h.config, () => {})
    h.engine.recordOutput('owner', 'backend', 'intent', [{ id: 'partial', role: 'assistant', content: 'Persisted partial result' }])
    h.adapter.getUsage.mockResolvedValue({ inputTokens: 100, outputTokens: 10, provenance: 'reported', turnId: 'intent' })
    await h.engine.pollUsage('owner', 'backend', 'intent', h.adapter, h.config, null, () => true)
    await h.engine.sendPrompt('owner', 'backend', 'intent', 1, 'Inspect partial work; continue only unfinished work', h.adapter, h.config, () => {})
    const recovered = new AdapterEngine(h.db.db, 'process-two', 'task')
    h.db.setSetting('sessions.task_managed', 'true')
    await recovered.reconcileStartup()
    expect(h.adapter.sendPrompt).toHaveBeenCalledTimes(2)
    expect(h.db.db.prepare('SELECT call_index, reported_input_tokens, reported_output_tokens, state FROM session_usage_calls ORDER BY call_index').all())
      .toEqual([{ call_index: 1, reported_input_tokens: 100, reported_output_tokens: 10, state: 'error' },
        { call_index: 2, reported_input_tokens: null, reported_output_tokens: null, state: 'interrupted' }])
    expect(h.db.db.prepare('SELECT state FROM session_turns ORDER BY started_at, rowid').all()).toEqual([{ state: 'failed' }, { state: 'interrupted' }])
    h.engine.shutdown(); recovered.shutdown()
  })
})

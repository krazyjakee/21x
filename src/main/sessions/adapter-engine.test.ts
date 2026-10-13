import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../../test/helpers/fake-adapter'
import { AdapterEngine } from './adapter-engine'
import type { SessionConfig } from '../adapters/coding-agent-adapter'
import { MessagePartType } from '../adapters/coding-agent-adapter'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks() })
function fixture(run = 'process-a') {
  const db = createPortableTestDb()
  databases.push(db)
  const engine = new AdapterEngine(db.db, run)
  const adapter = new FakeAdapter({ sessionIds: ['backend-one'] })
  const config: SessionConfig = { agentId: 'agent', taskId: 'captain', workspaceDir: '/tmp', model: 'gpt-4o' }
  return { db, engine, adapter, config }
}

describe('managed AdapterEngine', () => {
  it('defaults off and preserves native context while durably recording starts and prompt intent before sending', async () => {
    const { db, engine, adapter, config } = fixture()
    expect(engine.enabled).toBe(false)
    db.setSetting('sessions.captain_managed', 'true')
    expect(engine.enabled).toBe(true)
    const backendId = await engine.createSession('captain', adapter, config)
    let sawDurableIntent = false
    adapter.sendPrompt.mockImplementation(async () => {
      sawDurableIntent = Boolean(db.db.prepare("SELECT 1 FROM session_turns WHERE turn_key='intent'").get())
    })
    await engine.sendPrompt('captain', backendId, 'intent', 0, 'Keep backend context', adapter, config, () => {})
    expect(sawDurableIntent).toBe(true)
    expect(adapter.sendPrompt.mock.calls[0][1]).toEqual([{ type: MessagePartType.TEXT, text: 'Keep backend context' }])
    expect(adapter.sendPrompt.mock.calls[0][2]).toBe(config)
    expect(db.db.prepare('SELECT generation_key, backend_id FROM session_generations').get()).toEqual({ generation_key: 'adapter:backend-one', backend_id: 'backend-one' })
    await engine.finishTurn('captain', backendId, 'intent', 'end_turn')
    engine.shutdown()
    expect(db.db.prepare('SELECT state FROM session_turns').get()).toEqual({ state: 'completed' })
  })

  it('reconciles interrupted intent without replay and resumes the same backend generation under the new lifetime', async () => {
    const { db, engine, adapter, config } = fixture()
    await engine.createSession('captain', adapter, config)
    await engine.sendPrompt('captain', 'backend-one', 'intent', 0, 'Do not replay', adapter, config, () => {})
    db.setSetting('sessions.captain_managed', '1')
    const restarted = new AdapterEngine(db.db, 'process-b')
    await restarted.reconcileStartup()
    await restarted.resumeSession('captain', 'backend-one', adapter, config)
    expect(adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(db.db.prepare('SELECT state, input FROM session_turns').get()).toEqual({ state: 'interrupted', input: 'Do not replay' })
    expect(db.db.prepare('SELECT process_run_id, state FROM session_generations').get()).toEqual({ process_run_id: 'process-b', state: 'open' })
    restarted.shutdown()
  })

  it('deduplicates receipt and disposition across generations without dispatching inbox work', async () => {
    const { db, engine, adapter } = fixture()
    await engine.recordWake('captain', undefined, 'wake-id', 'One wake')
    await engine.recordWake('captain', 'replacement', 'wake-id', 'A retransmitted wake envelope')
    await engine.recordWakeDisposition('captain', undefined, 'wake-id', 'stale', 2)
    await engine.recordWakeDisposition('captain', 'replacement', 'wake-id', 'stale', 2)
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_event_inbox WHERE event_type='wake_received'").get()).toEqual({ count: 1 })
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='wake_disposition'").get()).toEqual({ count: 1 })
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    engine.shutdown()
  })

  it('fences manual stop after persistence and performs no SQL after engine shutdown', async () => {
    const { db, engine, adapter, config } = fixture()
    await engine.createSession('captain', adapter, config)
    await expect(engine.sendPrompt('captain', 'backend-one', 'stopped-intent', 0, 'Stopped before send', adapter, config,
      () => { throw new Error('Manual stop') })).rejects.toThrow('Manual stop')
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    engine.shutdown()
    const sql = vi.spyOn(db.db, 'prepare')
    await engine.observe('captain', 'backend-one', 'late', 'late', {})
    await engine.recordWake('captain', 'backend-one', 'late-wake', 'Late')
    await engine.recordWakeDisposition('captain', 'backend-one', 'late-wake', 'failed', 1)
    await expect(engine.sendPrompt('captain', 'backend-one', 'late-intent', 0, 'Late', adapter, config, () => {})).rejects.toThrow('CAPTAIN_ENGINE_CLOSED')
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns').get()).toEqual({ state: 'interrupted', stop_reason: 'shutdown' })
  })

  it('rekeys temporary backend identity while retaining one generation and turn', async () => {
    const { db, engine, adapter, config } = fixture()
    await engine.createSession('captain', adapter, config)
    await engine.sendPrompt('captain', 'backend-one', 'intent', 0, 'Original intent', adapter, config, () => {})
    await engine.rekeySession('captain', 'backend-one', 'real-backend')
    await engine.finishTurn('captain', 'real-backend', 'intent', 'end_turn')
    expect(db.db.prepare('SELECT generation_key, backend_id FROM session_generations').all()).toEqual([{ generation_key: 'adapter:backend-one', backend_id: 'real-backend' }])
    expect(db.db.prepare('SELECT state FROM session_turns').all()).toEqual([{ state: 'completed' }])
    const restarted = new AdapterEngine(db.db, 'process-b')
    expect(restarted.generationKey('real-backend', 'captain')).toBe('adapter:backend-one')
    engine.shutdown(); restarted.shutdown()
  })
})

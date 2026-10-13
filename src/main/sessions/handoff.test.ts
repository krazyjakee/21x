import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { deterministicHandoffSummary, HandoffEngine, HANDOFF_SUMMARY_MAX_TOKENS, type HandoffCallbacks, type HandoffInput } from './handoff'
import { readCommanderMemory } from './memory'
import { estimateTokens } from './token-estimator'

const databases: ReturnType<typeof createPortableTestDb>[] = []
const paths: string[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
const input: HandoffInput = { ownerId: 'conversation', conversationId: 'conversation', engine: 'chat', generationKey: 'original',
  model: 'own-model', reasons: ['turns'], turns: [
    { id: 'user-one', role: 'user', content: 'Fix the failing payment check.' },
    { id: 'tool-one', role: 'tool', toolName: 'update_task', content: 'Task status changed.', state: 'completed' },
    { id: 'user-two', role: 'user', content: 'Then explain the result.' }
  ] }
function fixture() {
  const db = createPortableTestDb(); databases.push(db)
  const engine = new HandoffEngine(db.db, 'process', () => 10)
  const summarize = vi.fn<HandoffCallbacks['summarize']>(async () => 'The payment check was fixed. Explain the result next. Do not repeat the completed task update.')
  const createGeneration = vi.fn<HandoffCallbacks['createGeneration']>(async () => ({}))
  const bindGeneration = vi.fn<HandoffCallbacks['bindGeneration']>(async () => undefined)
  const callbacks: HandoffCallbacks = { summarize, createGeneration, bindGeneration }
  return { db, engine, summarize, createGeneration, bindGeneration, callbacks }
}
describe('durable planned handoff', () => {
  it('freezes the original source/model and completes once in the same Commander conversation', async () => {
    const { db, engine, callbacks, summarize, createGeneration, bindGeneration } = fixture()
    engine.begin(input)
    const record = await engine.run({ ...input, model: 'new-setting', turns: [] }, callbacks)
    expect(record.state).toBe('completed')
    expect(record.source).toEqual(input)
    expect(record.source.conversationId).toBe('conversation')
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({ model: 'own-model', source: input })
    expect(record.summary).toMatchObject({ source: 'model', sourceTurnIds: ['user-one', 'tool-one', 'user-two'], lastFoldedId: 'user-two' })
    expect(createGeneration.mock.calls[0]?.[0]).toMatchObject({ handoffId: record.id, nextGenerationKey: record.nextGenerationKey, summary: record.summary })
    await new HandoffEngine(db.db, 'restarted', () => 20).run(input, callbacks)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(createGeneration).toHaveBeenCalledTimes(1)
    expect(bindGeneration).toHaveBeenCalledTimes(1)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_summaries').get()).toEqual({ count: 1 })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual({ count: 2 })
    expect(readCommanderMemory(db.db)).toHaveLength(1)
  })

  it.each(['pending', 'summary', 'memory_written', 'memory', 'created', 'completed'] as const)('resumes a crash after %s without duplicate journal or generation', async (crashStep) => {
    const { db, engine, callbacks, createGeneration } = fixture()
    let crashed = false
    await expect(engine.run(input, { ...callbacks, afterStep(step) {
      if (!crashed && step === crashStep) { crashed = true; throw new Error('simulated crash') }
    } })).rejects.toThrow('simulated crash')
    const restarted = new HandoffEngine(db.db, 'restart', () => 20)
    const final = await restarted.run(input, callbacks)
    expect(final.state).toBe('completed')
    expect(createGeneration).toHaveBeenCalledTimes(1)
    expect(readCommanderMemory(db.db)).toHaveLength(1)
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'handoff_journal'").get()).toEqual({ count: 1 })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual({ count: 2 })
  })

  it('preserves file memory across a crash between file writes and durable journal projection', async () => {
    const { engine, db, callbacks, createGeneration } = fixture()
    const path = mkdtempSync(join(tmpdir(), '21x-handoff-')); paths.push(path)
    writeFileSync(join(path, 'MEMORY.md'), 'My personal memory\r\nKeep this exactly.\r\n')
    const captain: HandoffInput = { ...input, ownerId: 'captain', conversationId: undefined, engine: 'adapter', workspaceDir: path }
    const adapterCallbacks: HandoffCallbacks = { ...callbacks, createGeneration: vi.fn(async () => ({ backendId: 'native-next' })) }
    await expect(engine.run(captain, { ...adapterCallbacks, afterStep(step) { if (step === 'memory_written') throw new Error('file crash') } })).rejects.toThrow('file crash')
    expect(engine.get(captain.ownerId, captain.generationKey)?.state).toBe('summary')
    const final = await new HandoffEngine(db.db, 'restart').run(captain, adapterCallbacks)
    expect(final.nextGenerationKey).toBe('adapter:native-next')
    expect(final.targetBackendId).toBe('native-next')
    expect(readFileSync(join(path, 'MEMORY.md'), 'utf8').startsWith('My personal memory\r\nKeep this exactly.\r\n')).toBe(true)
    expect(readFileSync(join(path, '.21x', 'session-journal.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(adapterCallbacks.createGeneration).toHaveBeenCalledTimes(1)
    expect(createGeneration).not.toHaveBeenCalled()
  })

  it.each(['creating', 'creation_accepted'] as const)('does not repeat backend creation after ambiguous %s crash', async (crashStep) => {
    const { engine, db, callbacks, createGeneration } = fixture()
    await expect(engine.run(input, { ...callbacks, afterStep(step) { if (step === crashStep) throw new Error('ambiguous crash') } })).rejects.toThrow('ambiguous crash')
    const accepted = createGeneration.mock.calls.length
    const restarted = new HandoffEngine(db.db, 'restart')
    const record = await restarted.run(input, callbacks)
    expect(record.state).toBe('creation_unconfirmed')
    expect(record.notice).toMatch(/creation will not be repeated/)
    await restarted.run(input, callbacks)
    expect(createGeneration).toHaveBeenCalledTimes(accepted)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual({ count: 1 })
    restarted.confirmCreated(input.ownerId, input.generationKey, null)
    expect((await restarted.run(input, callbacks)).state).toBe('completed')
    expect(createGeneration).toHaveBeenCalledTimes(accepted)
  })

  it('keeps a bounded deterministic fallback and all original turn content durably retrievable', async () => {
    const { db, engine, callbacks, summarize } = fixture()
    const long = { ...input, turns: [{ id: 'large-tool', role: 'tool', content: 'A'.repeat(50000), state: 'completed' }, ...input.turns] }
    summarize.mockRejectedValue(new Error('provider unavailable'))
    const final = await engine.run(long, callbacks)
    expect(final.summarySource).toBe('fallback')
    expect(final.summary?.text).toContain('Then explain the result.')
    expect(final.summary?.text).toContain('omits older content')
    expect(estimateTokens(final.summary!.text.length)).toBeLessThanOrEqual(HANDOFF_SUMMARY_MAX_TOKENS)
    expect(final.source.turns[0].content).toHaveLength(50000)
    expect(final.summary?.sourceTurnIds).toEqual(long.turns.map((turn) => turn.id))
    expect(deterministicHandoffSummary(long)).toEqual(final.summary)
    expect(JSON.parse((db.db.prepare('SELECT source FROM session_handoffs').get() as { source: string }).source).turns).toEqual(long.turns)
  })

  it('falls back for oversized summaries and visibly pauses when the latest instruction cannot fit', async () => {
    const { engine, callbacks, summarize, createGeneration } = fixture()
    summarize.mockResolvedValue('x'.repeat(10000))
    expect((await engine.run(input, callbacks)).summarySource).toBe('fallback')
    const impossible = { ...input, ownerId: 'another', turns: [{ id: 'huge-user', role: 'user', content: 'instruction'.repeat(10000) }] }
    await expect(engine.run(impossible, callbacks)).rejects.toThrow('without truncation')
    expect(engine.get('another', input.generationKey)?.state).toBe('pending')
    expect(engine.get('another', input.generationKey)?.source.turns).toEqual(impossible.turns)
    expect(createGeneration).toHaveBeenCalledTimes(1)
  })

  it('records observe-only decisions idempotently without summary, memory or activation', () => {
    const { db, engine, createGeneration } = fixture()
    const decision = { mode: 'observe' as const, reasons: ['turns' as const], action: 'observe' as const, deferred: null }
    engine.recordDecision(input, decision)
    engine.recordDecision(input, decision)
    expect(engine.get(input.ownerId, input.generationKey)).toBeNull()
    expect(readCommanderMemory(db.db)).toEqual([])
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'rollover_decision'").get()).toEqual({ count: 1 })
    expect(createGeneration).not.toHaveBeenCalled()
  })

  it('does not turn shutdown/replacement into fallback or persist a late summary', async () => {
    const { engine, callbacks, createGeneration } = fixture()
    const controller = new AbortController()
    let resolve!: (value: string) => void
    const lateSummary = new Promise<string>((done) => { resolve = done })
    const work = engine.run(input, { ...callbacks, signal: controller.signal, summarize: () => lateSummary })
    await Promise.resolve()
    controller.abort('session replaced')
    resolve('Late summary from the replaced session')
    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(engine.get(input.ownerId, input.generationKey)?.state).toBe('pending')
    expect(engine.get(input.ownerId, input.generationKey)?.summary).toBeNull()
    expect(createGeneration).not.toHaveBeenCalled()
    expect((await engine.run(input, callbacks)).summarySource).toBe('model')
  })

  it('persists an accepted backend identity on cancellation without binding or creating again', async () => {
    const { engine, callbacks, bindGeneration } = fixture()
    const path = mkdtempSync(join(tmpdir(), '21x-handoff-cancel-')); paths.push(path)
    const captain: HandoffInput = { ...input, ownerId: 'captain', engine: 'adapter', workspaceDir: path }
    const controller = new AbortController()
    const create = vi.fn(async () => { controller.abort('shutdown'); return { backendId: 'accepted-native' } })
    await expect(engine.run(captain, { ...callbacks, signal: controller.signal, createGeneration: create })).rejects.toMatchObject({ name: 'AbortError' })
    expect(engine.get(captain.ownerId, captain.generationKey)).toMatchObject({ state: 'created', targetBackendId: 'accepted-native', nextGenerationKey: 'adapter:accepted-native' })
    expect(bindGeneration).not.toHaveBeenCalled()
    await engine.run(captain, { ...callbacks, createGeneration: create })
    expect(create).toHaveBeenCalledTimes(1)
    expect(bindGeneration).toHaveBeenCalledTimes(1)
  })

  it('refuses already-cancelled work before any durable mutation', async () => {
    const { engine, callbacks, db } = fixture()
    const controller = new AbortController(); controller.abort()
    await expect(engine.run(input, { ...callbacks, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_handoffs').get()).toEqual({ count: 0 })
  })
})

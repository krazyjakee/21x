import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dirname } from 'node:path'
import { rmSync } from 'node:fs'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { CommanderStore } from '../main/commander/commander-store'
import { SessionContextService } from '../main/sessions/context-service'
import { SessionLedger } from '../main/sessions/ledger'
import { TokenAccounting } from '../main/sessions/token-accounting'
import { DEFAULT_ROLLOVER_POLICY, type SessionContextScope } from '../shared/session-context'
import { SESSION_CONTEXT_CODECS, SESSION_CONTEXT_LIMITS, type SessionContextCodec, type SessionContextOperation } from '../shared/session-context-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { SessionContextBackend, type SessionContextBackendOptions, type SessionContextOwners } from './session-context-backend'

let db: ReturnType<typeof createPortableTestDb>, context: SessionContextService, backend: SessionContextBackend, options: SessionContextBackendOptions
let commander: CommanderStore, ledger: SessionLedger, accounting: TokenAccounting, clock: number
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'context-epoch', webviewId: 'main', origin: 'app://context' }
beforeEach(() => {
  db = createPortableTestDb(); clock = 100
  context = new SessionContextService(db, () => 1000); commander = new CommanderStore(db, { now: () => clock })
  ledger = new SessionLedger(db.db, () => clock); accounting = new TokenAccounting(db.db, () => {}, 'context-test-process', () => clock)
  const owners: SessionContextOwners = { database: db, context }
  options = { ...owners, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed fixture profile') },
    assertOwners(actual) { for (const key of Object.keys(owners) as Array<keyof SessionContextOwners>) if (actual[key] !== owners[key]) throw new Error('Wrong context owner') },
    isTrustedDesktop: identity => identity.webviewId === 'main' && identity.origin === caller.origin,
    canAccessTask: () => true, canAccessProject: () => true, canAccessAgent: () => true, canAccessSession: () => true,
    canAccessGlobalCommander: () => true, canManageConfiguration: () => true, canAccessSetting: () => true }
  backend = new SessionContextBackend(options)
})
afterEach(async () => {
  await backend.close(); accounting.shutdown()
  const root = dirname(dirname(db.getWorkspaceDir('fixture')))
  db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function call<K extends SessionContextOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = SESSION_CONTEXT_CODECS[operation] as SessionContextCodec<K>
  const result = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(result)).toBe(true)
  return codec.decodeResult((result as { value?: JsonValue }).value)
}
function snapshot(scope: SessionContextScope, signal?: AbortSignal) { return call('sessionContext:getSnapshot', [scope], signal) }
function captain() {
  const project = db.createProject({ name: 'Context project' })!, task = db.getCoordinatorTask(project.id)!
  const agent = db.createAgent({ name: 'Context Captain', config: { coding_agent: 'codex', model: 'gpt-4o' } })!
  db.updateTask(task.id, { agent_id: agent.id })
  return { project, task, agent, scope: { kind: 'captain' as const, ownerId: task.id } }
}
function observe(scope: SessionContextScope, generationKey: string, eventType: string, idempotencyKey: string, payload: unknown = {}, turnKey?: string) {
  ledger.apply({ ownerId: scope.ownerId, generationKey, engine: scope.kind === 'captain' ? 'adapter' : 'chat',
    eventType, idempotencyKey, payload, turnKey, ...(scope.kind === 'captain' ? { backendId: generationKey } : {}) }, 'context-test-process')
}
function counts() {
  return Object.fromEntries(['session_generations', 'session_turns', 'session_lifecycle_events', 'session_summaries', 'session_handoffs', 'commander_messages']
    .map(table => [table, db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]))
}
function addHandoff(ownerId: string, id: string, summary: string | null, source = 'Frozen source') {
  db.db.prepare(`INSERT INTO session_handoffs (id,owner_id,engine,generation_key,next_generation_key,model,source,state,summary,summary_source,created_at,updated_at)
    VALUES (?,?,'chat',?,?,?,?,'summary',?,'fallback',?,?)`).run(id, ownerId, `from:${id}`, `to:${id}`, 'fixture-model', source, summary, clock, clock)
}

describe('actual session context production boundary', () => {
  it('refuses colliding Captain and Commander owner IDs before projecting their shared ledger namespace', async () => {
    const { scope } = captain(), session = commander.createSession('Ambiguous historical ID')
    db.db.prepare('UPDATE commander_sessions SET id=? WHERE id=?').run(scope.ownerId, session.id)
    observe(scope, 'adapter:collision', 'session_started', 'collision', { model: 'private' })
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(snapshot({ kind: 'commander', ownerId: scope.ownerId })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('reads real Captain model/context and deduplicated counters without generation/session/provider writes', async () => {
    const { scope } = captain()
    observe(scope, 'adapter:one', 'session_started', 'start', { model: 'deployment-model' })
    observe(scope, 'adapter:one', 'context_usage', 'context', { tokens: 72000, source: 'reported', model: 'deployment-model', contextWindow: 100000, observedAt: 110, private: 'internal-not-exported' })
    observe(scope, 'adapter:one', 'compaction', 'compact'); observe(scope, 'adapter:one', 'compaction', 'compact')
    observe(scope, 'adapter:one', 'wake_disposition', 'wake', { disposition: 'delivered' })
    observe(scope, 'adapter:one', 'wake_disposition', 'stale', { disposition: 'stale' })
    observe(scope, 'adapter:one', 'turn_started', 'turn', { kind: 'captain', input: 'Private prompt' }, 'turn')
    options.canManageConfiguration = () => false; options.canAccessGlobalCommander = () => false
    const before = counts(), result = await snapshot(scope)
    expect(result.usage).toEqual({ tokens: 72000, source: 'reported', model: 'deployment-model', contextWindow: 100000, observedAt: 110 })
    expect(result.counters).toEqual({ compactions: 1, wakeups: 1, turns: 1, ageMs: 900 })
    expect(result.reasons).toContain('context'); expect(JSON.stringify(result)).not.toMatch(/Private prompt|internal-not-exported/)
    expect(await snapshot(scope)).toEqual(result); expect(counts()).toEqual(before)
    expect(db.getSetting('sessions.rollover')).toBeUndefined()
  })

  it('keeps latest-generation Commander occupancy distinct from billing totals/summary calls and late old-generation evidence', async () => {
    const scope = { kind: 'commander' as const, ownerId: commander.createSession('Context').id }
    const provider = { id: 'fixture', model: 'fixture-model', contextWindow: 100000 }
    const turn = (id: string, generation: string, tokens: number | null, kind: 'user' | 'summary' = 'user') => {
      observe(scope, generation, 'turn_started', `${id}:start`, { kind }, id)
      accounting.beginTurn(id, scope.ownerId, kind, provider, 700)
      db.db.prepare(`INSERT INTO session_usage_calls (turn_id,call_index,input_chars,estimated_input_tokens,reported_input_tokens,reported_output_tokens,state)
        VALUES (?,1,700,200,?,40000,'completed')`).run(id, tokens)
      accounting.finishTurn(id, 'completed')
    }
    turn('old-turn', 'old', 99000); clock = 200
    observe(scope, 'new', 'generation_started', 'new:start')
    expect((await snapshot(scope)).usage).toMatchObject({ tokens: null, source: 'unknown' })
    turn('new-turn', 'new', null)
    expect((await snapshot(scope)).usage).toMatchObject({ tokens: 200, source: 'estimated', contextWindow: 100000 })
    clock = 300; turn('summary-turn', 'new', 99999, 'summary'); clock = 400; turn('late-old', 'old', 100000)
    const before = counts(), result = await snapshot(scope)
    expect(result.generation?.key).toBe('new'); expect(result.counters.turns).toBe(1)
    expect(result.usage.tokens).toBe(200); expect(result.reasons).not.toContain('context'); expect(counts()).toEqual(before)
  })

  it.each(['task', 'project', 'agent', 'setting'] as const)('requires exact Captain %s read scope before materializing actual records', async denied => {
    const { scope, task, project, agent } = captain()
    const getTask = vi.spyOn(db, 'getTask'), getAgent = vi.spyOn(db, 'getAgent'), read = vi.spyOn(context, 'getSnapshot')
    if (denied === 'task') options.canAccessTask = id => id !== task.id
    if (denied === 'project') options.canAccessProject = id => id !== project.id
    if (denied === 'agent') options.canAccessAgent = id => id !== agent.id
    if (denied === 'setting') options.canAccessSetting = key => key !== 'sessions.rollover_thresholds'
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(read).not.toHaveBeenCalled(); expect(getTask).not.toHaveBeenCalled(); expect(getAgent).not.toHaveBeenCalled()
  })

  it('rejects ordinary/group/missing Captain rows and foreign Commander scopes', async () => {
    const ordinary = db.createTask({ title: 'Ordinary task' })!, scope = { kind: 'captain' as const, ownerId: ordinary.id }
    const read = vi.spyOn(context, 'getSnapshot')
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    db.db.prepare("UPDATE tasks SET role='task_group' WHERE id=?").run(ordinary.id)
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(snapshot({ kind: 'captain', ownerId: 'missing' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(snapshot({ kind: 'commander', ownerId: 'missing' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(read).not.toHaveBeenCalled()
  })

  it('scopes global Commander, its exact session and all referenced projects without hydrating transcripts', async () => {
    const scope = { kind: 'commander' as const, ownerId: commander.createSession('Project reports').id }, project = db.createProject({ name: 'Referenced project' })!
    commander.appendMessage(scope.ownerId, { role: 'report', content: 'Human report', projectId: project.id })
    const read = vi.spyOn(context, 'getSnapshot')
    options.canAccessGlobalCommander = () => false
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessGlobalCommander = () => true; options.canAccessSession = () => false
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessSession = () => true; options.canAccessProject = id => id !== project.id
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(read).not.toHaveBeenCalled()
    options.canAccessProject = () => true
    db.db.prepare('UPDATE commander_messages SET content=?,tool_calls=? WHERE session_id=?').run('x'.repeat(600000), 'malformed'.repeat(80000), scope.ownerId)
    expect((await snapshot(scope)).scope).toEqual(scope)
    expect((await snapshot(scope)).usage.source).toBe('unknown')
  })

  it('uses the actual policy writer and one transaction under both setting-write plus global-write grants', async () => {
    const policy = { ...DEFAULT_ROLLOVER_POLICY, mode: 'observe' as const, contextRatio: .8, maxAgeDays: .5 }
    const write = vi.spyOn(context, 'setPolicy')
    options.canAccessSetting = (key, _caller, access) => !(key === 'sessions.rollover_thresholds' && access === 'write')
    await expect(call('sessionContext:setPolicy', [policy])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    options.canAccessSetting = () => true; options.canManageConfiguration = (_caller, access) => access === 'read'
    await expect(call('sessionContext:setPolicy', [policy])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(write).not.toHaveBeenCalled()
    options.canManageConfiguration = (_caller, access) => access === 'write'
    expect(await call('sessionContext:setPolicy', [policy])).toEqual(policy)
    expect(db.getSetting('sessions.rollover')).toBe('observe')
    expect(JSON.parse(db.getSetting('sessions.rollover_thresholds')!)).toEqual({ contextRatio: .8, compactions: 2, wakeups: 150, turns: 300, maxAgeDays: .5 })
    expect(write).toHaveBeenCalledOnce()
    db.db.exec("CREATE TRIGGER fail_threshold BEFORE UPDATE ON settings WHEN NEW.key='sessions.rollover_thresholds' BEGIN SELECT RAISE(ABORT,'Controlled storage failure'); END")
    await expect(call('sessionContext:setPolicy', [{ ...policy, mode: 'on' }])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(db.getSetting('sessions.rollover')).toBe('observe'); expect(JSON.parse(db.getSetting('sessions.rollover_thresholds')!).contextRatio).toBe(.8)
  })

  it('rejects malformed/body-authority policy input before its actual transactional writer', async () => {
    const write = vi.spyOn(context, 'setPolicy')
    for (const policy of [{ ...DEFAULT_ROLLOVER_POLICY, turns: '300' }, { ...DEFAULT_ROLLOVER_POLICY, mode: 'enabled' }, { ...DEFAULT_ROLLOVER_POLICY, config: { bypass: true } }, { ...DEFAULT_ROLLOVER_POLICY, wakeups: 0 }]) {
      await expect(backend.registry.invoke('sessionContext:setPolicy', { policy } as JsonValue, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    }
    expect(write).not.toHaveBeenCalled(); expect(db.getSetting('sessions.rollover')).toBeUndefined()
  })

  it('freezes the submitted policy before the registry asynchronous authorization boundary', async () => {
    const policy = { ...DEFAULT_ROLLOVER_POLICY }, payload = SESSION_CONTEXT_CODECS['sessionContext:setPolicy'].encodeArguments([policy])
    const accepted = backend.registry.invoke('sessionContext:setPolicy', payload, caller, new AbortController().signal)
    policy.mode = 'on'; policy.turns = 999
    const wire = await accepted
    expect(SESSION_CONTEXT_CODECS['sessionContext:setPolicy'].decodeResult((wire as { value: JsonValue }).value)).toEqual(DEFAULT_ROLLOVER_POLICY)
    expect(db.getSetting('sessions.rollover')).toBe('off'); expect(JSON.parse(db.getSetting('sessions.rollover_thresholds')!).turns).toBe(300)
  })

  it('preserves accepted policy effects after cancellation and never retries a suppressed result', async () => {
    const controller = new AbortController(), actual = context.setPolicy.bind(context), write = vi.spyOn(context, 'setPolicy')
    write.mockImplementationOnce(value => { const saved = actual(value); controller.abort(); return saved })
    await expect(call('sessionContext:setPolicy', [{ ...DEFAULT_ROLLOVER_POLICY, mode: 'on' }], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(db.getSetting('sessions.rollover')).toBe('on'); expect(write).toHaveBeenCalledOnce(); expect(backend.inflightCount).toBe(0)
    await backend.close()
    await expect(call('sessionContext:setPolicy', [{ ...DEFAULT_ROLLOVER_POLICY, mode: 'off' }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(db.getSetting('sessions.rollover')).toBe('on'); expect(write).toHaveBeenCalledOnce()
  })

  it.each(['task', 'agent', 'settings', 'generation', 'context', 'wake', 'summary', 'handoff', 'recovery', 'model'] as const)('bounds huge stored %s before the actual context service parses it', async kind => {
    const fixture = captain(), scope = kind === 'model' ? { kind: 'commander' as const, ownerId: commander.createSession('Model bound').id } : fixture.scope
    observe(scope, 'generation', 'session_started', 'start')
    const huge = 'x'.repeat(SESSION_CONTEXT_LIMITS.storedBytes + 1)
    if (kind === 'task') db.db.prepare('UPDATE tasks SET description=? WHERE id=?').run(huge, scope.ownerId)
    if (kind === 'agent') db.db.prepare('UPDATE agents SET config=? WHERE id=?').run(JSON.stringify({ model: huge }), fixture.agent.id)
    if (kind === 'settings') db.setSetting('sessions.rollover_thresholds', JSON.stringify({ unrelated: huge }))
    if (kind === 'generation') db.db.prepare('UPDATE session_generations SET generation_key=? WHERE owner_id=?').run(huge, scope.ownerId)
    if (kind === 'context') observe(scope, 'generation', 'context_usage', 'huge-context', { tokens: 10, source: 'reported', private: huge })
    if (kind === 'wake') observe(scope, 'generation', 'wake_disposition', 'huge-wake', { disposition: 'delivered', private: huge })
    if (kind === 'summary') observe(scope, 'generation', 'summary_saved', 'huge-summary', { content: JSON.stringify({ text: huge }) })
    if (kind === 'handoff') addHandoff(scope.ownerId, 'huge-handoff', JSON.stringify({ text: huge }))
    if (kind === 'recovery') observe(scope, 'generation', 'replacement_seeded', 'huge-recovery', { recap: huge })
    if (kind === 'model') {
      observe(scope, 'generation', 'turn_started', 'usage-start', { kind: 'user' }, 'usage')
      accounting.beginTurn('usage', scope.ownerId, 'user', { id: 'fixture', model: huge, contextWindow: 100000 }, 700)
      db.db.prepare("INSERT INTO session_usage_calls (turn_id,call_index,input_chars,estimated_input_tokens,state) VALUES ('usage',1,700,200,'completed')").run()
    }
    const read = vi.spyOn(context, 'getSnapshot'), getTask = vi.spyOn(db, 'getTask'), getAgent = vi.spyOn(db, 'getAgent'), before = counts()
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(read).not.toHaveBeenCalled(); expect(getTask).not.toHaveBeenCalled(); expect(getAgent).not.toHaveBeenCalled(); expect(counts()).toEqual(before)
  })

  it('projects genuine human summaries only and leaves untouched frozen handoff histories unmaterialized', async () => {
    const scope = { kind: 'commander' as const, ownerId: commander.createSession('Summary context').id }
    observe(scope, 'generation', 'summary_saved', 'human-summary', { content: '# Legacy human summary\n\nNext task is retained.' })
    clock = 200
    observe(scope, 'generation', 'summary_saved', 'structured-summary', { content: JSON.stringify({ text: 'Human summary text', source: 'model', private: 'internal-only' }) })
    addHandoff(scope.ownerId, 'handoff', JSON.stringify({ text: 'Bounded continuation' }), JSON.stringify({ frozenHistory: 'x'.repeat(600000) }))
    clock = 300; observe(scope, 'generation', 'replacement_seeded', 'recovery', { summary: 'Actual recovery recap', internal: 'ignored-source-payload' })
    const result = await snapshot(scope)
    expect(result.summaries.map(row => row.content)).toContain('Human summary text'); expect(result.summaries.map(row => row.content)).toContain('Bounded continuation')
    expect(result.summaries.map(row => row.content)).toContain('Actual recovery recap'); expect(result.handoff).toEqual({ id: 'handoff', state: 'summary' })
    expect(JSON.stringify(result)).not.toMatch(/internal-only|ignored-source-payload|frozenHistory/)
    clock = 400; observe(scope, 'generation', 'summary_saved', 'private-object', { content: JSON.stringify({ toolInput: 'never export raw JSON', credentials: 'private' }) })
    const read = vi.spyOn(context, 'getSnapshot')
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' }); expect(read).not.toHaveBeenCalled()
    db.db.prepare('UPDATE session_summaries SET content=? WHERE idempotency_key=?').run('{"private": "broken internal payload', 'private-object')
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' }); expect(read).not.toHaveBeenCalled()
  })

  it('refuses invalid projected fields and cross-owner generation evidence without changing the durable source', async () => {
    const { scope } = captain()
    observe(scope, 'generation', 'context_usage', 'usage', { tokens: 10, source: 'reported', observedAt: -1 })
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    db.db.prepare('UPDATE session_lifecycle_events SET owner_id=? WHERE idempotency_key=?').run('foreign-owner', 'usage')
    const read = vi.spyOn(context, 'getSnapshot')
    await expect(snapshot(scope)).rejects.toMatchObject({ code: 'INVALID_RESULT' }); expect(read).not.toHaveBeenCalled()
    expect((db.db.prepare('SELECT owner_id FROM session_lifecycle_events WHERE idempotency_key=?').get('usage') as { owner_id: string }).owner_id).toBe('foreign-owner')
  })

  it('fails closed on stale/native-foreign/pre-cancelled calls and exact borrowed-owner mismatch', async () => {
    const { scope } = captain(), controller = new AbortController(), read = vi.spyOn(context, 'getSnapshot'); controller.abort()
    await expect(snapshot(scope, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(call('sessionContext:getSnapshot', [scope], undefined, { ...caller, engineEpoch: 'stale' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('sessionContext:getSnapshot', [scope], undefined, { ...caller, origin: 'foreign://context' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(() => new SessionContextBackend({ ...options, context: new SessionContextService(db) })).toThrow('owner')
    const foreign = createPortableTestDb()
    try {
      expect(() => new SessionContextBackend({ ...options, context: new SessionContextService(foreign), assertOwners() {} })).toThrow('owner')
    } finally { foreign.close() }
    expect(read).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { CommanderService } from './commander-service'
import { CommanderStore } from './commander-store'
import { SessionContextService } from '../sessions/context-service'
import type { ChatProvider, ChatProviderRequest } from '../chat/providers/types'
import { DEFAULT_ROLLOVER_POLICY } from '../../shared/session-context'
import type { CommanderEvent } from '../../shared/commander'
import { COMMANDER_MEMORY_KEY } from '../sessions/memory'
import { HandoffEngine, type HandoffInput } from '../sessions/handoff'

let db: ReturnType<typeof createPortableTestDb>
let service: CommanderService
let store: CommanderStore
let sessionId: string
let events: CommanderEvent[]
beforeEach(() => {
  db = createPortableTestDb()
  db.setSetting('sessions.commander_managed', 'true')
  db.setSetting('sessions.captain_managed', 'true')
  new SessionContextService(db).setPolicy({ ...DEFAULT_ROLLOVER_POLICY, mode: 'on', turns: 1 })
  store = new CommanderStore(db)
  sessionId = store.createSession('Named').id
  events = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => { await service?.close(); db.close(); vi.restoreAllMocks() })
function start(provider: ChatProvider, observationRunId = 'rollover-process') {
  service = new CommanderService({ store, createProvider: () => provider, emit: event => events.push(event), observationRunId })
}
describe('Commander planned rollover', () => {
  it('summarizes with its own model and keeps the transcript, archive, global memory and next request in the same conversation', async () => {
    const requests: ChatProviderRequest[] = []
    start({ id: 'test', model: 'session-model', contextWindow: 10000, async *stream(request) {
      requests.push(request)
      yield { type: 'text_delta', text: request.system?.startsWith('Retain historical context') ? 'Durable own-model context' : 'Answered once' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } })
    const first = service.sendUserMessage(sessionId, 'Finish this task')
    await first.done
    const handoff = db.db.prepare('SELECT * FROM session_handoffs').get() as { id: string; state: string; model: string; next_generation_key: string; source: string }
    expect(handoff).toMatchObject({ state: 'completed', model: 'session-model' })
    expect(JSON.parse(handoff.source).turns.map((turn: { content: string }) => turn.content)).toEqual(['Finish this task', 'Answered once'])
    expect(store.listSessions()).toHaveLength(1)
    const messages = store.listMessages(sessionId)
    expect(messages.filter(message => message.tool_name === 'session_rollover')).toHaveLength(1)
    expect(messages.find(message => message.role === 'summary')?.content).toBe('Durable own-model context')
    expect(JSON.parse(db.getSetting(COMMANDER_MEMORY_KEY)!).entries.map((entry: { ownerId: string }) => entry.ownerId)).toEqual([sessionId])
    expect(requests).toHaveLength(2)
    const snapshot = new SessionContextService(db).getSnapshot({ kind: 'commander', ownerId: sessionId })
    expect(snapshot.generation?.key).toBe(handoff.next_generation_key)
    expect(snapshot.usage.tokens).toBeNull()
    expect(snapshot.summaries.filter(summary => summary.kind === 'rollover')).toHaveLength(1)
    db.setSetting('sessions.rollover', 'off')
    await service.sendUserMessage(sessionId, 'Continue now').done
    expect(requests[2].system).toContain('Durable own-model context')
    expect(requests[2].messages).toEqual([{ role: 'user', content: 'Continue now' }])
    expect(store.listMessages(sessionId).filter(message => message.tool_name === 'session_rollover')).toHaveLength(1)
  })

  it.each(['observe', 'on'])('does not allocate a generation when activation is observational or Captain staging is absent (%s)', async mode => {
    db.setSetting('sessions.rollover', mode)
    if (mode === 'on') db.setSetting('sessions.captain_managed', 'false')
    const stream = vi.fn(async function* () { yield { type: 'text_delta' as const, text: 'Complete' }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const } })
    start({ id: 'test', model: 'own', stream })
    await service.sendUserMessage(sessionId, 'Observe only').done
    expect(stream).toHaveBeenCalledOnce()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_handoffs').get()).toEqual({ count: 0 })
    const decision = db.db.prepare("SELECT payload FROM session_lifecycle_events WHERE event_type = 'rollover_decision'").get() as { payload: string }
    expect(JSON.parse(decision.payload)).toMatchObject({ action: 'observe' })
    expect(store.listMessages(sessionId).map(message => message.role)).toEqual(['user', 'assistant'])
  })

  it('uses bounded deterministic fallback without rerunning tools when its own model summary fails', async () => {
    start({ id: 'test', model: 'own', async *stream(request) {
      if (request.system?.startsWith('Retain historical context')) throw new Error('Provider unavailable')
      yield { type: 'text_delta', text: 'The work is complete' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } })
    await service.sendUserMessage(sessionId, 'Keep the required configuration').done
    const row = db.db.prepare('SELECT state, summary_source, source FROM session_handoffs').get() as { state: string; summary_source: string; source: string }
    expect(row).toMatchObject({ state: 'completed', summary_source: 'fallback' })
    expect(JSON.parse(row.source).turns).toHaveLength(2)
    expect(store.listMessages(sessionId).find(message => message.role === 'summary')?.content).toContain('Keep the required configuration')
    expect(JSON.parse(store.listMessages(sessionId).find(message => message.tool_name === 'session_rollover')!.content).source).toBe('fallback')
  })

  it.each(['stop', 'off', 'stage_disabled'] as const)('%s cancels delayed continuation without binding a generation or accepting an unrecorded draft', async action => {
    let release!: () => void
    let entered!: () => void
    const summaryEntered = new Promise<void>(resolve => { entered = resolve })
    const summaryRelease = new Promise<void>(resolve => { release = resolve })
    start({ id: 'test', model: 'own', async *stream(request) {
      if (request.system?.startsWith('Retain historical context')) { entered(); await summaryRelease }
      yield { type: 'text_delta', text: 'Late summary' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } })
    const turn = service.sendUserMessage(sessionId, 'Original instruction')
    await summaryEntered
    expect(() => service.sendUserMessage(sessionId, 'Preserve this draft')).toThrow('draft is preserved')
    if (action === 'stop') expect(service.cancel(sessionId)).toBe(true)
    else if (action === 'off') db.setSetting('sessions.rollover', 'off')
    else db.setSetting('sessions.captain_managed', 'false')
    release(); await turn.done
    expect(db.db.prepare('SELECT state FROM session_handoffs').get()).toEqual({ state: 'pending' })
    expect(store.listMessages(sessionId).filter(message => message.role === 'summary' || message.tool_name === 'session_rollover')).toEqual([])
    expect(store.listMessages(sessionId).filter(message => message.role === 'user').map(message => message.content)).toEqual(['Original instruction'])
  })

  it('finishes a crash after same-conversation binding on restart without another summary or divider', async () => {
    const original = store.appendHumanMessage(sessionId, 'Original intent')
    const answer = store.appendMessage(sessionId, { role: 'assistant', content: 'Completed original work' })
    const engine = new HandoffEngine(db.db, 'crashed-process')
    const input: HandoffInput = { ownerId: sessionId, conversationId: sessionId, engine: 'chat', generationKey: 'original', model: 'session-model', reasons: ['turns'],
      turns: [{ id: original.id, role: original.role, content: original.content }, { id: answer.id, role: answer.role, content: answer.content }] }
    await expect(engine.run(input, {
      summarize: async () => 'Durable summary before crash', createGeneration: async () => ({}),
      bindGeneration: async record => {
        store.bindHandoff({ sessionId, handoffId: record.id, generationKey: record.nextGenerationKey, summary: record.summary!.text,
          source: record.summary!.source, lastFoldedId: record.summary!.lastFoldedId })
        throw new Error('crash after binding')
      }
    })).rejects.toThrow('crash after binding')
    expect(engine.get(sessionId, 'original')?.state).toBe('created')
    const stream = vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'New work answered once' }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const }
    })
    start({ id: 'test', model: 'session-model', stream })
    await service.sendUserMessage(sessionId, 'Continue after restart').done
    expect(engine.get(sessionId, 'original')?.state).toBe('completed')
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_handoffs').get()).toEqual({ count: 1 })
    expect(stream).toHaveBeenCalledOnce()
    expect(store.listMessages(sessionId).filter(message => message.tool_name === 'session_rollover')).toHaveLength(1)
    expect(store.listMessages(sessionId).filter(message => message.role === 'summary')).toHaveLength(1)
    expect(store.listMessages(sessionId).filter(message => message.role === 'user').map(message => message.content)).toEqual(['Original intent', 'Continue after restart'])
    expect(store.listSessions()).toHaveLength(1)
  })

  it('does not rewind a later generation when an older completed binding is repeated', async () => {
    const engine = new HandoffEngine(db.db, 'binding-test')
    const firstUser = store.appendHumanMessage(sessionId, 'First intent')
    const run = (generationKey: string, message: typeof firstUser, summary: string) => engine.run({ ownerId: sessionId, conversationId: sessionId,
      engine: 'chat', generationKey, model: 'session-model', reasons: ['turns'], turns: [{ id: message.id, role: 'user', content: message.content }] }, {
      summarize: async () => summary, createGeneration: async () => ({}), bindGeneration: async record => {
        store.bindHandoff({ sessionId, handoffId: record.id, generationKey: record.nextGenerationKey,
          summary: record.summary!.text, source: record.summary!.source, lastFoldedId: record.summary!.lastFoldedId })
      }
    })
    const first = await run('original', firstUser, 'First durable summary')
    const secondUser = store.appendHumanMessage(sessionId, 'Second intent')
    const second = await run(first.nextGenerationKey, secondUser, 'Second durable summary')
    const bound = store.bindHandoff({ sessionId, handoffId: first.id, generationKey: first.nextGenerationKey, summary: first.summary!.text,
      source: first.summary!.source, lastFoldedId: first.summary!.lastFoldedId })
    expect(bound.inserted).toBe(false)
    expect(db.getSetting(`sessions.commander_generation:${sessionId}`)).toBe(second.nextGenerationKey)
    expect(store.listMessages(sessionId).filter(message => message.tool_name === 'session_rollover')).toHaveLength(2)
    expect(() => store.bindHandoff({ sessionId, handoffId: first.id, generationKey: 'changed-generation', summary: first.summary!.text,
      source: first.summary!.source, lastFoldedId: first.summary!.lastFoldedId })).toThrow(/identity|generation|content/i)
    expect(() => store.bindHandoff({ sessionId, handoffId: first.id, generationKey: first.nextGenerationKey, summary: first.summary!.text,
      source: 'fallback', lastFoldedId: first.summary!.lastFoldedId })).toThrow(/identity|source|content/i)
    expect(db.getSetting(`sessions.commander_generation:${sessionId}`)).toBe(second.nextGenerationKey)
  })

  it('keeps its recorded generation stable across service restart without manufacturing another generation', async () => {
    const provider: ChatProvider = { id: 'test', model: 'own', async *stream(request) {
      yield { type: 'text_delta', text: request.system?.startsWith('Retain historical context') ? 'Durable context' : 'Answer' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } }
    start(provider)
    await service.sendUserMessage(sessionId, 'Initial work').done
    const key = db.getSetting(`sessions.commander_generation:${sessionId}`)
    const before = db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()
    await service.close()
    db.setSetting('sessions.rollover', 'off')
    start(provider, 'restarted-process')
    await service.sendUserMessage(sessionId, 'Continue').done
    expect(db.getSetting(`sessions.commander_generation:${sessionId}`)).toBe(key)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual(before)
    expect(new SessionContextService(db).getSnapshot({ kind: 'commander', ownerId: sessionId }).generation?.key).toBe(key)
    expect(store.listMessages(sessionId).filter(message => message.tool_name === 'session_rollover')).toHaveLength(1)
  })

  it('uses fallback instead of a changed model when resuming an unfinished summary', async () => {
    const original = store.appendHumanMessage(sessionId, 'Keep original model context')
    const engine = new HandoffEngine(db.db, 'crashed')
    const input: HandoffInput = { ownerId: sessionId, conversationId: sessionId, engine: 'chat', generationKey: 'original', model: 'original-model', reasons: ['turns'],
      turns: [{ id: original.id, role: 'user', content: original.content }] }
    engine.begin(input)
    const stream = vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'Current model answer' }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const }
    })
    start({ id: 'test', model: 'changed-model', stream })
    await service.sendUserMessage(sessionId, 'Continue with changed setting').done
    expect(engine.get(sessionId, 'original')).toMatchObject({ state: 'completed', model: 'original-model', summarySource: 'fallback' })
    expect(stream).toHaveBeenCalledOnce()
    expect(store.listMessages(sessionId).find(message => message.role === 'summary')?.content).toContain('Keep original model context')
  })

  it('retains a quiet report arriving during summary after the frozen fold boundary', async () => {
    let entered!: () => void
    let release!: () => void
    const summaryEntered = new Promise<void>(resolve => { entered = resolve })
    const summaryRelease = new Promise<void>(resolve => { release = resolve })
    const requests: ChatProviderRequest[] = []
    start({ id: 'test', model: 'own', async *stream(request) {
      requests.push(request)
      if (request.system?.startsWith('Retain historical context')) { entered(); await summaryRelease }
      yield { type: 'text_delta', text: request.system?.startsWith('Retain historical context') ? 'Frozen source summary' : 'Normal answer' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } })
    const turn = service.sendUserMessage(sessionId, 'Initial work')
    await summaryEntered
    const report = store.appendMessage(sessionId, { role: 'report', content: 'The build completed while context was retained.' })
    release(); await turn.done
    const handoff = db.db.prepare('SELECT source FROM session_handoffs').get() as { source: string }
    expect(JSON.parse(handoff.source).turns.some((message: { id: string }) => message.id === report.id)).toBe(false)
    expect(requests).toHaveLength(2)
    db.setSetting('sessions.rollover', 'off')
    await service.sendUserMessage(sessionId, 'Explain the latest report').done
    expect(requests[2].messages.some(message => message.content.includes(report.content))).toBe(true)
    expect(store.getMessage(report.id)?.content).toBe(report.content)
    expect(store.listMessages(sessionId).filter(message => message.tool_name === 'session_rollover')).toHaveLength(1)
  })

  it('drains shutdown summary work without post-close binding or a fallback generation', async () => {
    let entered!: () => void
    let release!: () => void
    const summaryEntered = new Promise<void>(resolve => { entered = resolve })
    const summaryRelease = new Promise<void>(resolve => { release = resolve })
    start({ id: 'test', model: 'own', async *stream(request) {
      if (request.system?.startsWith('Retain historical context')) { entered(); await summaryRelease }
      yield { type: 'text_delta', text: 'Late result' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } })
    const turn = service.sendUserMessage(sessionId, 'Keep this intent')
    await summaryEntered
    const closing = service.close()
    release()
    await Promise.all([closing, turn.done])
    expect(db.db.prepare('SELECT state, summary FROM session_handoffs').get()).toEqual({ state: 'pending', summary: null })
    expect(db.getSetting(COMMANDER_MEMORY_KEY)).toBeUndefined()
    expect(store.listMessages(sessionId).filter(message => message.role === 'summary' || message.tool_name === 'session_rollover')).toEqual([])
    expect(() => service.sendUserMessage(sessionId, 'Preserved user draft')).toThrow('COMMANDER_SERVICE_CLOSED')
  })
})

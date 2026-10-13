import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import type { ChatProvider, ChatProviderRequest } from '../chat/providers/types'
import type { ChatToolDefinition } from '../chat/tools'
import type { CommanderEvent } from '../../shared/commander'
import { CommanderService } from './commander-service'
import { CommanderStore } from './commander-store'
import { COMMANDER_SUMMARY_PROMPT } from './prompts'
import { DeliveryStore } from '../sessions/delivery-store'
import { ManagedSessionObserver } from '../sessions/managed-session'
import { chatMessageCharacters, managedVerbatimTokens } from './context'
import { estimateTokens } from '../sessions/token-estimator'

const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; service: CommanderService }> = []
afterEach(async () => {
  for (const { db, service } of resources.splice(0)) { await service.close(); db.close() }
  vi.restoreAllMocks()
})

function fixture(provider: ChatProvider, managed = true, tools: ChatToolDefinition[] = []) {
  const db = createPortableTestDb()
  if (managed) db.setSetting('sessions.commander_managed', 'true')
  const store = new CommanderStore(db)
  const session = store.createSession('Named')
  const events: CommanderEvent[] = []
  const createProvider = vi.fn(() => provider)
  const service = new CommanderService({ store, createProvider, getTools: () => tools,
    emit: (event) => events.push(event), observationRunId: 'managed-process' })
  resources.push({ db, service })
  return { db, store, session, service, events, createProvider }
}

describe('managed Commander integration', () => {
  it.each([false, true])('gates per-step persistence and forced ledger recording (managed=%s)', async (managed) => {
    let calls = 0
    let effects = 0
    let toolSawAssistant = false
    let nextCallSawTool = false
    let nextCallSawInboxStep = false
    const model: ChatProvider = { id: 'fixture', model: 'custom', async *stream() {
      if (++calls === 1) {
        yield { type: 'tool_call', id: 'write-1', name: 'write', input: {} }
        yield { type: 'message_end', stopReason: 'tool_use' }
      } else {
        nextCallSawTool = store.listMessages(session.id).some((message) => message.role === 'tool' && message.content === 'Written once')
        nextCallSawInboxStep = Boolean(db.db.prepare("SELECT 1 FROM session_lifecycle_events WHERE event_type='step_committed' AND turn_key=?").get(turn.turnId))
        yield { type: 'text_delta', text: 'Completed' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      }
    } }
    const { db, store, session, service } = fixture(model, managed, [{ name: 'write', description: 'Write', inputSchema: { type: 'object', properties: {} }, handler: async () => {
      effects++
      toolSawAssistant = store.listMessages(session.id).some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'write-1')
      return 'Written once'
    } }])
    const turn = service.sendUserMessage(session.id, 'Write once')
    await turn.done
    await service.close()
    expect(effects).toBe(1)
    expect(toolSawAssistant).toBe(managed)
    expect(nextCallSawTool).toBe(managed)
    expect(nextCallSawInboxStep).toBe(managed)
    expect(store.listMessages(session.id).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_turns WHERE turn_key=?').get(turn.turnId)).toEqual({ count: managed ? 1 : 0 })
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='step_committed' AND turn_key=?").get(turn.turnId)).toEqual({ count: managed ? 3 : 0 })
    if (managed) {
      const first = store.listMessages(session.id)[1]
      expect(store.appendRuntimeStepOnce(session.id, { role: 'assistant', content: first.content, toolCalls: first.tool_calls }, turn.turnId, 1)).toEqual({ message: first, inserted: false })
      expect(() => store.appendRuntimeStepOnce(session.id, { role: 'assistant', content: 'Changed' }, turn.turnId, 1)).toThrow()
    }
  })

  it('uses a hard D7 view with explicit omissions and rejects oversized drafts before storing them', async () => {
    const requests: ChatProviderRequest[] = []
    const model: ChatProvider = { id: 'fixture', model: 'custom', contextWindow: 1000, async *stream(request) {
      requests.push(request)
      yield { type: 'text_delta', text: 'Answer' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } }
    const { store, session, service, events } = fixture(model)
    for (let n = 0; n < 5; n++) {
      store.appendMessage(session.id, { role: 'user', content: `Question ${n}: ${'x'.repeat(700)}` })
      store.appendMessage(session.id, { role: 'assistant', content: 'Retained answer' })
    }
    await service.sendUserMessage(session.id, 'New protected instruction').done
    expect(estimateTokens(requests[0].messages.reduce((sum, message) => sum + chatMessageCharacters(message), 0))).toBeLessThanOrEqual(600)
    expect(requests[0].messages[0].content).toContain('summary pending')
    expect(store.listMessages(session.id).filter((message) => message.role === 'user')).toHaveLength(6)
    expect(events.some((event) => event.type === 'messages_appended' && event.messages.some((message) => message.content.startsWith('[21x context]')))).toBe(true)
    const before = store.listMessages(session.id).length
    expect(() => service.sendUserMessage(session.id, 'x'.repeat(3000))).toThrow('Newest turn exceeds')
    expect(store.listMessages(session.id)).toHaveLength(before)
    expect(managedVerbatimTokens('unknown')).toBe(16000)
  })

  it('retains partial steps and surfaces persistent overflow after one retry without replaying effects', async () => {
    let requests = 0
    let effects = 0
    const model: ChatProvider = { id: 'fixture', model: 'custom', async *stream() {
      if (++requests === 1) {
        yield { type: 'tool_call', id: 'side-effect', name: 'start', input: {} }
        yield { type: 'message_end', stopReason: 'tool_use' }
      } else throw new Error('context_length_exceeded')
    } }
    const { db, store, session, service, events } = fixture(model, true, [{ name: 'start', description: 'Start', inputSchema: { type: 'object', properties: {} }, handler: async () => { effects++; return 'Started' } }])
    const turn = service.sendUserMessage(session.id, 'Start once')
    await turn.done
    await service.close()
    expect(requests).toBe(3)
    expect(effects).toBe(1)
    expect(store.listMessages(session.id).filter((message) => message.role === 'tool').map((message) => message.content)).toEqual(['Started'])
    expect(store.listMessages(session.id).filter((message) => message.content.includes('Retrying once'))).toHaveLength(1)
    expect(events.some((event) => event.type === 'turn_event' && event.event.type === 'error')).toBe(true)
    expect(db.db.prepare('SELECT state FROM session_turns WHERE turn_key=?').get(turn.turnId)).toEqual({ state: 'failed' })
    const restarted = new ManagedSessionObserver(db.db, 'restart')
    expect(await restarted.reconcileStartup(true)).toEqual([])
    expect(effects).toBe(1)
  })

  it('records quiet correlated reports in the shared inbox once without starting model turns or speech', async () => {
    const stream = vi.fn(async function* () { yield { type: 'text_delta' as const, text: 'Unexpected' } })
    const { db, store, session, service, createProvider, events } = fixture({ id: 'fixture', model: 'custom', stream })
    const request = store.appendMessage(session.id, { role: 'user', content: 'Check the project' })
    const originalTime = request.created_at
    const delivery = new DeliveryStore(db).enqueue({ idempotencyKey: 'quiet-report', kind: 'captain_report', sourceSessionId: session.id, correlationId: 'request-1', payload: 'Project checked' }).record
    const input = { sessionId: session.id, content: 'Project checked', correlationId: 'request-1', deliveryId: delivery.id }
    expect(service.deliverReport(input).relayed).toBe(false)
    service.deliverReport(input)
    await service.close()
    expect(store.listMessages(session.id).filter((message) => message.role === 'report')).toHaveLength(1)
    expect(store.getMessage(request.id)?.created_at).toBe(originalTime)
    expect(store.listMessages(session.id).at(-1)?.correlation_id).toBe('request-1')
    expect(createProvider).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(events.every((event) => event.type !== 'turn_started' && event.type !== 'turn_event')).toBe(true)
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type='report_received'").get()).toEqual({ count: 1 })
  })

  it.each([false, true])('summarizes with the session model and retains the fold cursor on failure (failure=%s)', async (failure) => {
    const requests: ChatProviderRequest[] = []
    const model: ChatProvider = { id: 'own-provider', model: 'own-model', contextWindow: 1000, async *stream(request) {
      requests.push(request)
      if (failure) throw new Error('Summary provider unavailable')
      yield { type: 'text_delta', text: 'Own-model summary' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    } }
    const { store, session, service, createProvider } = fixture(model)
    for (let n = 0; n < 10; n++) {
      store.appendMessage(session.id, { role: 'user', content: `Question ${n} ${'x'.repeat(450)}` })
      store.appendMessage(session.id, { role: 'assistant', content: 'Answer' })
    }
    const original = store.listMessages(session.id)
    const summary = await service.foldHistory(session.id, model)
    expect(createProvider).not.toHaveBeenCalled()
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.system === COMMANDER_SUMMARY_PROMPT && request.maxTokens === 1500)).toBe(true)
    if (failure) {
      expect(summary).toBeNull()
      expect(store.listMessages(session.id)).toEqual(original)
      expect(service.foldFailure(session.id)).not.toBeNull()
    } else {
      expect(summary?.content).toBe('Own-model summary')
      expect(summary?.correlation_id).toBeTruthy()
      expect(store.listMessages(session.id).filter((message) => message.role === 'user')).toHaveLength(10)
    }
  })

  it('fences ignored-abort summary observers after shutdown while keeping the accepted partial usage', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = vi.fn()
    const model: ChatProvider = { id: 'fixture', model: 'custom', contextWindow: 1000, async *stream() {
      yield { type: 'text_delta', text: 'Partial summary kept in accounting' }
      entered()
      await gate
      yield { type: 'text_delta', text: 'Late summary' }
    } }
    const { db, store, session, service } = fixture(model)
    for (let n = 0; n < 5; n++) {
      store.appendMessage(session.id, { role: 'user', content: 'x'.repeat(1000) })
      store.appendMessage(session.id, { role: 'assistant', content: 'Answer' })
    }
    const folding = service.foldHistory(session.id, model)
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      service.shutdown()
      const sql = vi.spyOn(db.db, 'prepare')
      const closing = service.close()
      release()
      expect(await folding).toBeNull()
      await closing
      expect(sql).not.toHaveBeenCalled()
      sql.mockRestore()
      expect(db.db.prepare("SELECT state, output_tokens FROM session_turn_usage WHERE kind='summary'").get()).toEqual({ state: 'interrupted', output_tokens: estimateTokens('Partial summary kept in accounting'.length) })
      expect(store.listMessages(session.id).some((message) => message.role === 'summary')).toBe(false)
    } finally { release(); await folding }
  })

  it('rejects oversized stored or generated summaries without accepting a draft or advancing the fold', async () => {
    const stream = vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'x'.repeat(6000) }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const }
    })
    const { store, session, service } = fixture({ id: 'fixture', model: 'custom', contextWindow: 1000, stream })
    for (let n = 0; n < 5; n++) {
      store.appendMessage(session.id, { role: 'user', content: 'x'.repeat(1000) })
      store.appendMessage(session.id, { role: 'assistant', content: 'Answer' })
    }
    const original = store.listMessages(session.id)
    expect(await service.foldHistory(session.id)).toBeNull()
    expect(service.foldFailure(session.id)?.error).toContain('summary exceeds')
    expect(store.listMessages(session.id)).toEqual(original)
    store.appendMessage(session.id, { role: 'summary', content: 'x'.repeat(6000), correlationId: original[1].id })
    const before = store.listMessages(session.id)
    expect(() => service.sendUserMessage(session.id, 'Keep this draft')).toThrow('Stored summary exceeds')
    expect(store.listMessages(session.id)).toEqual(before)
  })
})

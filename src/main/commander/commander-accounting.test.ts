import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { CommanderService } from './commander-service'
import { CommanderStore } from './commander-store'
import { COMMANDER_SUMMARY_PROMPT, COMMANDER_TITLE_PROMPT } from './prompts'
import type { ChatProvider, ChatProviderEvent } from '../chat/providers/types'
import { ManagedSessionObserver } from '../sessions/managed-session'

const resources: Array<{ db: ReturnType<typeof createPortableTestDb>; service: CommanderService }> = []
afterEach(async () => {
  const pending = resources.splice(0)
  for (const { service } of pending) await service.close()
  for (const db of new Set(pending.map((resource) => resource.db))) db.close()
  vi.restoreAllMocks()
})

function fixture(ledger = false, reportUsage = false) {
  const db = createPortableTestDb()
  if (ledger) db.setSetting('sessions.ledger', 'true')
  const store = new CommanderStore(db)
  const session = store.createSession()
  const provider: ChatProvider = { id: 'fixture-provider', model: 'custom-context', async *stream(request) {
    const text = request.system === COMMANDER_TITLE_PROMPT ? 'Session title'
      : request.system === COMMANDER_SUMMARY_PROMPT ? 'Summary of completed work' : 'A complete response with enough history for folding.'
    yield { type: 'text_delta', text }
    yield { type: 'message_end', stopReason: 'end_turn', ...(reportUsage ? { usage: { inputTokens: 40, outputTokens: 9 } } : {}) }
  } }
  const events: unknown[] = []
  const service = new CommanderService({ store, createProvider: () => provider, emit: (event) => events.push(event), budget: { keepTurns: 1, maxChars: 80 }, observationRunId: 'current-process' })
  resources.push({ db, service })
  return { db, store, session, service, provider, events }
}

describe('Commander usage and observe-only ledger integration', () => {
  it('stores every user/title/summary turn without changing session context and logs estimates', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { db, store, session, service } = fixture()
    await service.sendUserMessage(session.id, 'First question about a sufficiently long project plan').done
    await service.sendUserMessage(session.id, 'Second question about the remaining work').done
    const usage = db.db.prepare('SELECT kind, state, input_source, output_source FROM session_turn_usage ORDER BY started_at').all() as Array<Record<string, unknown>>
    expect(usage.filter((row) => row.kind === 'user')).toHaveLength(2)
    expect(usage.some((row) => row.kind === 'title')).toBe(true)
    expect(usage.some((row) => row.kind === 'summary')).toBe(true)
    expect(usage.every((row) => row.state === 'end_turn' && row.input_source === 'estimated' && row.output_source === 'estimated')).toBe(true)
    expect(store.listMessages(session.id).filter((message) => message.role === 'user')).toHaveLength(2)
    expect(store.listMessages(session.id).some((message) => message.role === 'summary')).toBe(true)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_generations').get()).toEqual({ count: 0 })
    expect(log.mock.calls.filter((call) => String(call[0]).includes('turn_usage'))).toHaveLength(usage.length)
  })

  it('persists reported usage with provenance while ledger observes the existing tool lifecycle once', async () => {
    const { db, session, store } = fixture(true, true)
    store.renameSession(session.id, 'Named')
    let toolsRan = 0
    let request = 0
    const provider: ChatProvider = { id: 'tool-provider', model: 'custom', async *stream() {
      if (++request === 1) {
        yield { type: 'tool_call', id: 'tool-1', name: 'read', input: {} }
        yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 12, outputTokens: 4 } }
      } else {
        yield { type: 'text_delta', text: 'Read complete' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } }
      }
    } }
    const custom = new CommanderService({ store, createProvider: () => provider, emit: () => {}, observationRunId: 'current-process',
      getTools: () => [{ name: 'read', description: 'Read current state', inputSchema: { type: 'object', properties: {} }, handler: async () => { toolsRan++; return { content: 'Read once' } } }] })
    resources.push({ db, service: custom })
    const turn = custom.sendUserMessage(session.id, 'Read the state')
    await turn.done
    expect(db.db.prepare('SELECT input_tokens, output_tokens, input_source, output_source FROM session_turn_usage WHERE turn_id = ?').get(turn.turnId))
      .toEqual({ input_tokens: 32, output_tokens: 9, input_source: 'reported', output_source: 'reported' })
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'tool_call_result'").get()).toEqual({ count: 1 })
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns WHERE turn_key = ?').get(turn.turnId)).toEqual({ state: 'completed', stop_reason: 'end_turn' })
    expect(toolsRan).toBe(1)
    expect(await new ManagedSessionObserver(db.db, 'after-restart').reconcileStartup()).toEqual([])
    expect(toolsRan).toBe(1)
  })

  it('stores failed and cancelled model calls with estimates instead of silently omitting usage', async () => {
    const { db, store, session } = fixture(true)
    store.renameSession(session.id, 'Named')
    const provider: ChatProvider = { id: 'error-provider', model: 'custom', async *stream() {
      yield { type: 'text_delta', text: 'Partial response' }
      throw new Error('Temporary provider failure')
    } }
    const failed = new CommanderService({ store, createProvider: () => provider, emit: () => {}, observationRunId: 'current-process' })
    resources.push({ db, service: failed })
    const turn = failed.sendUserMessage(session.id, 'Question')
    await turn.done
    expect(db.db.prepare('SELECT state, input_source, output_tokens FROM session_turn_usage WHERE turn_id = ?').get(turn.turnId))
      .toMatchObject({ state: 'error', input_source: 'estimated', output_tokens: 5 })
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns WHERE turn_key = ?').get(turn.turnId)).toEqual({ state: 'failed', stop_reason: 'error' })
    const cancelProvider: ChatProvider = { id: 'cancel-provider', model: 'custom', async *stream(_request, signal): AsyncIterable<ChatProviderEvent> {
      signal.throwIfAborted()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      signal.throwIfAborted()
    } }
    const cancelled = new CommanderService({ store, createProvider: () => cancelProvider, emit: () => {}, observationRunId: 'current-process' })
    resources.push({ db, service: cancelled })
    const cancelling = cancelled.sendUserMessage(session.id, 'Cancel this')
    await Promise.resolve()
    cancelled.cancel(session.id)
    await cancelling.done
    expect(db.db.prepare('SELECT state, input_source FROM session_turn_usage WHERE turn_id = ?').get(cancelling.turnId)).toEqual({ state: 'cancelled', input_source: 'estimated' })
    expect(db.db.prepare('SELECT state, stop_reason FROM session_turns WHERE turn_key = ?').get(cancelling.turnId)).toEqual({ state: 'cancelled', stop_reason: 'cancelled' })
  })

  it('records changed same-timestamp session projections and deduplicates exact repeats', async () => {
    const { db, session, service } = fixture(true)
    const observe = service as unknown as { emit(event: { type: 'session_updated'; session: typeof session }): void }
    observe.emit({ type: 'session_updated', session })
    observe.emit({ type: 'session_updated', session: { ...session, unread_count: 1 } })
    observe.emit({ type: 'session_updated', session: { ...session, unread_count: 1 } })
    await service.close()
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE event_type = 'session_updated'").get()).toEqual({ count: 2 })
  })

  it('integrates startup reconciliation but never repeats interrupted model or tool work', async () => {
    const { db, store, session, service } = fixture(true)
    const observer = new ManagedSessionObserver(db.db, 'crashed-process')
    await observer.observe({ ownerId: session.id, generationKey: 'old-generation', engine: 'chat', turnKey: 'interrupted-turn',
      eventType: 'turn_started', idempotencyKey: 'interrupted-turn:start', payload: { kind: 'user', input: 'Keep the queued intent' } })
    await service.close()
    const createProvider = vi.fn(() => { throw new Error('Startup must not create a provider') })
    const restarted = new CommanderService({ store, createProvider, emit: () => {}, observationRunId: 'new-process' })
    resources.push({ db, service: restarted })
    await restarted.close()
    expect(createProvider).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT state, input FROM session_turns WHERE turn_key = ?').get('interrupted-turn')).toEqual({ state: 'interrupted', input: 'Keep the queued intent' })
  })
})

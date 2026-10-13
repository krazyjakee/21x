import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import { TokenAccounting } from './token-accounting'
import { estimateTokens, reportedTokenUsage, requestCharacters } from './token-estimator'
import { modelContextWindow } from './model-windows'
import type { ChatProvider, ChatProviderEvent, ChatProviderRequest } from '../chat/providers/types'

const databases: ReturnType<typeof createPortableTestDb>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const request: ChatProviderRequest = { system: 'System', messages: [{ role: 'user', content: 'Hello' }], tools: [], toolChoice: 'none' }

function fixture() {
  const db = createPortableTestDb()
  databases.push(db)
  const log = vi.fn()
  const accounting = new TokenAccounting(db.db, log, 'process-1')
  return { db, log, accounting }
}

describe('token accounting instrumentation', () => {
  it('estimates text with chars/3.5 and leaves unknown context windows unknown', () => {
    expect(estimateTokens(35)).toBe(10)
    expect(modelContextWindow('vendor/gpt-4o')).toBe(128_000)
    expect(modelContextWindow('custom-model')).toBeNull()
    expect(modelContextWindow('custom-model', { 'custom-model': 8192 })).toBe(8192)
    expect(reportedTokenUsage({})).toBeNull()
    expect(reportedTokenUsage({ input_tokens: 0, output_tokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(reportedTokenUsage({ input_tokens: -1, output_tokens: 2 })).toBeNull()
    expect(requestCharacters({ ...request, messages: [{ role: 'user', content: 'Hello', images: [{ name: 'x', mimeType: 'image/png', data: 'privatebytes'.repeat(100) }] }] })).toBe(requestCharacters(request))
  })

  it('stores/logs estimated usage while preserving request/event/signal identity', async () => {
    const { accounting, log } = fixture()
    const signal = new AbortController().signal
    const delta = { type: 'text_delta' as const, text: 'A private response' }
    const terminal = { type: 'message_end' as const, stopReason: 'end_turn' as const }
    const stream = vi.fn(async function* (actual: ChatProviderRequest, actualSignal: AbortSignal) {
      expect(actual).toBe(request)
      expect(actualSignal).toBe(signal)
      yield delta
      yield terminal
    })
    const provider: ChatProvider = { id: 'test', model: 'custom', stream }
    accounting.beginTurn('turn', 'owner', 'user', provider, requestCharacters(request))
    const events: ChatProviderEvent[] = []
    for await (const event of accounting.observeProvider(provider, () => 'turn').stream(request, signal)) events.push(event)
    accounting.finishTurn('turn', 'end_turn')
    expect(events[0]).toBe(delta)
    expect(events[1]).toBe(terminal)
    expect(accounting.get('turn')).toMatchObject({ state: 'end_turn', input_source: 'estimated', output_source: 'estimated', output_tokens: estimateTokens(delta.text.length) })
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).not.toContain('private response')
  })

  it('corrects estimates with late reported figures without adding usage twice', async () => {
    const { db, accounting } = fixture()
    const provider: ChatProvider = { id: 'test', model: 'custom', async *stream() { yield { type: 'text_delta', text: 'Reply' }; yield { type: 'message_end', stopReason: 'end_turn' } } }
    accounting.beginTurn('turn', 'owner', 'user', provider, requestCharacters(request))
    for await (const event of accounting.observeProvider(provider, () => 'turn').stream(request, new AbortController().signal)) void event
    accounting.finishTurn('turn', 'end_turn')
    accounting.correctReportedUsage('turn', 1, { outputTokens: 6 })
    expect(accounting.get('turn')).toMatchObject({ input_source: 'estimated', output_source: 'reported', output_tokens: 6 })
    accounting.correctReportedUsage('turn', 1, { inputTokens: 12, outputTokens: 6 })
    accounting.correctReportedUsage('turn', 1, { inputTokens: 12, outputTokens: 6 })
    expect(accounting.get('turn')).toMatchObject({ input_tokens: 12, output_tokens: 6, input_source: 'reported', output_source: 'reported' })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM session_usage_calls').get()).toEqual({ count: 1 })
    expect(db.db.prepare('SELECT input_tokens, output_tokens FROM session_token_calibration').get()).toEqual({ input_tokens: 12, output_tokens: 6 })
  })

  it('sums separate model calls with explicit mixed provenance and persists across restart', async () => {
    const { db, accounting } = fixture()
    let call = 0
    const provider: ChatProvider = { id: 'test', model: 'custom', async *stream() {
      yield { type: 'text_delta', text: 'Reply' }
      yield { type: 'message_end', stopReason: 'end_turn', ...(++call === 1 ? { usage: { inputTokens: 10, outputTokens: 2 } } : {}) }
    } }
    accounting.beginTurn('turn', 'owner', 'user', provider, requestCharacters(request))
    const observed = accounting.observeProvider(provider, () => 'turn')
    for (let i = 0; i < 2; i++) for await (const event of observed.stream(request, new AbortController().signal)) void event
    expect(accounting.get('turn')).toMatchObject({ input_source: 'mixed', output_source: 'mixed', reported_input_tokens: 10, reported_output_tokens: 2 })
    const restarted = new TokenAccounting(db.db, () => {}, 'process-2')
    expect(restarted.reconcileInterrupted()).toEqual(['turn'])
    expect(restarted.get('turn')).toMatchObject({ state: 'interrupted', input_source: 'mixed' })
    expect(restarted.reconcileInterrupted()).toEqual([])
  })

  it('preserves already-streamed output estimates when a process crashes before stream settlement', async () => {
    const { db, accounting } = fixture()
    const provider: ChatProvider = { id: 'test', model: 'custom', async *stream() { yield { type: 'text_delta', text: 'A partial response' } } }
    accounting.beginTurn('turn', 'owner', 'user', provider, requestCharacters(request))
    const stream = accounting.observeProvider(provider, () => 'turn').stream(request, new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const restarted = new TokenAccounting(db.db, () => {}, 'process-2')
    expect(restarted.reconcileInterrupted()).toEqual(['turn'])
    expect(restarted.get('turn')).toMatchObject({ state: 'interrupted', output_tokens: estimateTokens('A partial response'.length), output_source: 'estimated' })
    await stream.return?.()
    expect(restarted.get('turn')?.state).toBe('interrupted')
  })

  it('seals owned partial usage before shutdown and performs no late SQL while another observer remains live', async () => {
    const { db, accounting } = fixture()
    const sibling = new TokenAccounting(db.db, () => {}, 'process-1')
    const provider: ChatProvider = { id: 'test', model: 'custom', async *stream() {
      yield { type: 'text_delta', text: 'Retained partial output' }
      yield { type: 'text_delta', text: 'Late ignored-abort output' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50 } }
    } }
    accounting.beginTurn('owned', 'owner', 'title', provider, requestCharacters(request))
    sibling.beginTurn('sibling', 'owner', 'user', provider, requestCharacters(request))
    const stream = accounting.observeProvider(provider, () => 'owned').stream(request, new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    accounting.shutdown()
    expect(db.db.prepare('SELECT state, output_tokens FROM session_turn_usage WHERE turn_id = ?').get('owned'))
      .toEqual({ state: 'interrupted', output_tokens: estimateTokens('Retained partial output'.length) })
    expect(sibling.get('sibling')?.state).toBe('running')
    const sql = vi.spyOn(db.db, 'prepare')
    await stream.next()
    await stream.return?.()
    accounting.finishTurn('owned', 'end_turn')
    accounting.correctReportedUsage('owned', 1, { inputTokens: 100, outputTokens: 50 })
    accounting.shutdown()
    expect(sql).not.toHaveBeenCalled()
    sql.mockRestore()
    sibling.finishTurn('sibling', 'end_turn')
    expect(sibling.get('sibling')?.state).toBe('end_turn')
  })
})

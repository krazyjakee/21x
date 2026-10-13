/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpAdapter } from './acp-adapter'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { convertSDKMessageToParts } from './claude-code-message-converter'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { convertEventToMessageParts } from './codex-app-server-items'
import { OpencodeAdapter } from './opencode-adapter'
import { PiAdapter } from './pi-adapter'
import type { SessionConfig } from './coding-agent-adapter'

const config: SessionConfig = { agentId: 'agent', taskId: 'task', workspaceDir: '/workspace' }
afterEach(() => vi.restoreAllMocks())
function codexFixture() {
  const adapter = new CodexAppServerAdapter()
  const internal = adapter as any
  const session = { sessionId: 'thread', threadId: 'thread', lastTurnId: 'turn', status: 'busy',
    messageBuffer: [], permanentMessages: [], streamedTextByItemId: new Map(), assistantTextKeysByTurn: new Map(), runningTools: new Map() }
  internal.sessions.set('thread', session)
  return { adapter, session, emit: (method: string, params: any) => internal.handleNotification(session, { method, params }) }
}
async function claudeFixture(events: any[]) {
  const adapter = new ClaudeCodeAdapter()
  const internal = adapter as any
  const session = { sessionId: 'claude', status: 'busy', config, messageBuffer: [], messageCursor: 0,
    lastError: null, pendingApprovals: [], backgroundTasks: new Map(), sawResult: false, recoveryIntentId: 'turn',
    queryIterator: (async function* () { yield* events })() }
  internal.sessions.set('claude', session)
  await internal.consumeStream('claude', session)
  return adapter
}
function piFixture() {
  const adapter = new PiAdapter()
  const internal = adapter as any
  const session = { id: 'pi-file', nativeSessionId: 'pi-native', config, status: 'busy', lastError: null,
    pending: new Map(), parts: [], allMessages: [], textByBlock: new Map(), reasoningByBlock: new Map(), toolParts: new Map(),
    pendingUiRequests: new Map(), turn: 1, assistantMessageOrdinal: 1, pendingTurnError: null,
    pendingTurnErrorMonotonicTime: null, sawAgentActivity: true, promptMayBeCommandOnly: false, closing: false, stderrTail: '' }
  internal.sessions.set('pi-file', session)
  return { adapter, session, emit: (event: any) => internal.handleEvent(session, event) }
}

describe('backend compaction signals', () => {
  it('normalizes Claude compact_boundary once and filters subagent/foreign observations', async () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', session_id: 'claude', compact_metadata: { pre_tokens: 1000 } }
    const adapter = await claudeFixture([boundary, boundary,
      { ...boundary, uuid: 'subagent', parent_tool_use_id: 'tool' }, { ...boundary, uuid: 'foreign', session_id: 'other' }])
    expect(await adapter.getCompactionObservations('claude', config)).toMatchObject([
      { eventKey: 'explicit:boundary', signal: 'compact_boundary', beforeTokens: 1000, backendSessionId: 'claude' }
    ])
    expect(await adapter.getCompactionObservations('missing', config)).toEqual([])
    expect(convertSDKMessageToParts(boundary as any, new Set(), new Map())).toEqual([])
  })

  it('uses Claude assistant prompt/cache occupancy instead of aggregate result usage', async () => {
    const adapter = await claudeFixture([
      { type: 'assistant', message: { id: 'a', usage: { input_tokens: 100, cache_read_input_tokens: 900 } } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 10000 } },
      { type: 'assistant', message: { id: 'b', usage: { input_tokens: 200, cache_read_input_tokens: 100 } } }
    ])
    expect(await adapter.getCompactionObservations('claude', config)).toMatchObject([{ source: 'context_drop', beforeTokens: 1000, afterTokens: 300 }])
  })

  it('recognizes Codex compaction items without phantom tools or prior-turn signals', async () => {
    const { adapter, session, emit } = codexFixture()
    const params = { threadId: 'thread', turnId: 'turn', item: { type: 'contextCompaction', id: 'compact' } }
    emit('item/completed', params)
    emit('item/completed', params)
    emit('item/completed', { ...params, threadId: 'foreign', item: { ...params.item, id: 'foreign' } })
    emit('item/completed', { ...params, turnId: 'old', item: { ...params.item, id: 'old' } })
    expect(await adapter.getCompactionObservations('thread', config)).toMatchObject([{ eventKey: 'explicit:compact', signal: 'contextCompaction' }])
    expect(convertEventToMessageParts({ method: 'item/completed', params }, new Set(), new Map(), session)).toEqual([])
  })

  it('falls back to current Codex context occupancy while excluding cumulative totals and cached double counting', async () => {
    const { adapter, emit } = codexFixture()
    emit('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 900 } } })
    emit('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { total: { inputTokens: 1 } } })
    emit('thread/tokenUsage/updated', { turnId: 'old', tokenUsage: { last: { inputTokens: 1 } } })
    emit('thread/tokenUsage/updated', { turnId: 'turn', tokenUsage: { last: { inputTokens: 300, cachedInputTokens: 200 } } })
    expect(await adapter.getCompactionObservations('thread', config)).toMatchObject([{ source: 'context_drop', beforeTokens: 1000, afterTokens: 300 }])
  })

  it('recognizes known OpenCode sessions and reuses each native event key', async () => {
    vi.spyOn(OpencodeAdapter.prototype as any, 'loadSDK').mockResolvedValue(undefined)
    const adapter = new OpencodeAdapter()
    const internal = adapter as any
    internal.clients.set('oc', {})
    internal.handleServerEvent({ type: 'message.updated', properties: { info: { role: 'user', sessionID: 'oc', id: 'user' } } })
    const event = { type: 'session.compacted', properties: { sessionID: 'oc' } }
    internal.handleServerEvent(event)
    internal.handleServerEvent({ payload: event })
    internal.handleServerEvent({ ...event, properties: { sessionID: 'foreign' } })
    expect(await adapter.getCompactionObservations('oc', config)).toMatchObject([{ signal: 'session.compacted', eventKey: 'explicit:session.compacted:user' }])
    expect(await adapter.getCompactionObservations('foreign', config)).toEqual([])
  })

  it('uses the latest OpenCode assistant prompt occupancy without summing historical billing', async () => {
    vi.spyOn(OpencodeAdapter.prototype as any, 'loadSDK').mockResolvedValue(undefined)
    const adapter = new OpencodeAdapter()
    const internal = adapter as any
    internal.clients.set('oc', {})
    const fetch = vi.spyOn(internal, 'fetchMessages')
    fetch.mockResolvedValue([{ info: { role: 'user', id: 'user' } }, { info: { role: 'assistant', id: 'a', tokens: { input: 100, cache: { read: 900 } } } }])
    await adapter.getUsage('oc', config)
    fetch.mockResolvedValue([{ info: { role: 'user', id: 'user' } }, { info: { role: 'assistant', id: 'b', tokens: { input: 300 } } }])
    await adapter.getUsage('oc', config)
    await adapter.getUsage('oc', config)
    expect(await adapter.getCompactionObservations('oc', config)).toMatchObject([{ source: 'context_drop', beforeTokens: 1000, afterTokens: 300 }])
  })

  it.each(['compaction_end', 'auto_compaction_end'])('recognizes successful Pi %s, excluding starts, aborts, errors and foreign sessions', async (type) => {
    const { adapter, session, emit } = piFixture()
    const result = { firstKeptEntryId: 'native-entry', summary: 'retained backend context', tokensBefore: 1000, estimatedTokensAfter: 300 }
    emit({ type: 'compaction_start', reason: 'threshold' })
    emit({ type, aborted: true, result })
    emit({ type, errorMessage: 'failed' })
    emit({ type, sessionId: 'foreign', result })
    expect(await adapter.getCompactionObservations('pi-file', config)).toEqual([])
    emit({ type, sessionId: 'pi-native', result })
    emit({ type, sessionId: 'pi-native', result })
    expect(await adapter.getCompactionObservations('pi-file', config)).toMatchObject([{ signal: type, beforeTokens: 1000, afterTokens: 300 }])
    expect(session.parts.filter((part: any) => part.type === 'compaction')).toEqual([])
    expect(session.id).toBe('pi-file')
  })

  it('uses completed Pi assistant messages, ignoring partial streaming counters', async () => {
    const { adapter, emit } = piFixture()
    emit({ type: 'message_end', message: { role: 'assistant', timestamp: 1, usage: { input: 100, cacheRead: 900 } } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'start', partial: { usage: { input: 1 } } } })
    emit({ type: 'message_end', message: { role: 'assistant', timestamp: 2, usage: { input: 300 } } })
    emit({ type: 'message_end', message: { role: 'assistant', timestamp: 2, usage: { input: 300 } } })
    expect(await adapter.getCompactionObservations('pi-file', config)).toMatchObject([{ source: 'context_drop', beforeTokens: 1000, afterTokens: 300 }])
  })

  it('uses Cursor ACP current context used only and rejects foreign session notifications', async () => {
    const adapter = new AcpAdapter('cursor')
    const internal = adapter as any
    const session = { sessionId: 'cursor', acpSessionId: 'acp-native', status: 'busy', messageBuffer: [], permanentMessages: [],
      currentTurnId: 1, activeTurnId: 1, currentUserTurnId: 1, pendingAssistantTurnSplit: false, toolCallMetadata: new Map() }
    internal.sessions.set('cursor', session)
    const emit = (update: any, sessionId = 'acp-native') => internal.handleRpcMessage(session, { method: 'session/update', params: { sessionId, update } })
    emit({ sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: 1 } })
    emit({ sessionUpdate: 'usage_update', inputTokens: 1, totalTokens: 1 })
    emit({ sessionUpdate: 'usage_update', used: 1, size: 200000 }, 'foreign')
    emit({ sessionUpdate: 'usage_update', used: 300, size: 200000 })
    emit({ sessionUpdate: 'usage_update', used: 300, size: 200000 })
    expect(await adapter.getCompactionObservations('cursor', config)).toMatchObject([{ backend: 'cursor', backendSessionId: 'cursor', source: 'context_drop', beforeTokens: 1000, afterTokens: 300 }])
    expect(await adapter.getCompactionObservations('missing', config)).toEqual([])
    expect(session.activeTurnId).toBe(1)
  })

  it('keeps ACP text and tool ingestion before native ID assignment while isolating compaction samples', async () => {
    const adapter = new AcpAdapter('cursor')
    const internal = adapter as any
    const session = { sessionId: 'internal', acpSessionId: null as string | null, status: 'busy', messageBuffer: [], permanentMessages: [],
      currentTurnId: 1, activeTurnId: 1, currentUserTurnId: 1, pendingAssistantTurnSplit: false, toolCallMetadata: new Map() }
    internal.sessions.set('internal', session)
    const emit = (update: any, sessionId: string) => internal.handleRpcMessage(session, { method: 'session/update', params: { sessionId, update } })
    const first = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }
    emit(first, 'native-pending')
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } }, 'native-pending')
    emit({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'Output retained' }, 'native-pending')
    expect(session.messageBuffer).toHaveLength(3)
    expect(first.content.text).toBe('Hello')
    expect(session.permanentMessages).toHaveLength(2)
    // Unknown native IDs must not establish a fallback baseline.
    emit({ sessionUpdate: 'usage_update', used: 1000 }, 'foreign')
    emit({ sessionUpdate: 'usage_update', used: 300 }, 'foreign')
    expect(await adapter.getCompactionObservations('internal', config)).toEqual([])
    session.acpSessionId = 'native-pending'
    const buffered = session.messageBuffer.length
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign text' } }, 'foreign')
    expect(session.messageBuffer).toHaveLength(buffered)
    emit({ sessionUpdate: 'usage_update', used: 1000 }, 'native-pending')
    emit({ sessionUpdate: 'usage_update', used: 300 }, 'native-pending')
    expect(await adapter.getCompactionObservations('internal', config)).toMatchObject([{ beforeTokens: 1000, afterTokens: 300 }])
  })
})

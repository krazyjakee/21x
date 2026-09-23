import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { OpencodeAdapter } from './opencode-adapter'
import { SessionStatusType, type AdapterUsageReport } from './coding-agent-adapter'

/** Each adapter hands the usage its backend reports to `onUsage` (#97). */

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), AbortError: class AbortError extends Error {} }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn()
}))

describe('adapter usage wiring', () => {
  it('Claude Code reports a turn when its result arrives', async () => {
    const adapter = new ClaudeCodeAdapter()
    const reports: AdapterUsageReport[] = []
    adapter.onUsage = (report) => reports.push(report)
    const messages = [
      { type: 'system', subtype: 'init', model: 'claude-opus-4-6', session_id: 's1' },
      { type: 'assistant', parent_tool_use_id: null, session_id: 's1', message: { id: 'msg_1', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: 10, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 100, output_tokens: 1 } } },
      {
        type: 'result', subtype: 'success', is_error: false, uuid: 'result-1', session_id: 's1', stop_reason: 'end_turn', result: 'Hi',
        usage: { input_tokens: 10, output_tokens: 3 },
        modelUsage: { 'claude-opus-4-6': { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 5_000, cacheCreationInputTokens: 100, webSearchRequests: 0, costUSD: 0.004, contextWindow: 1_000_000, maxOutputTokens: 128_000 } }
      }
    ]
    let i = 0
    const session: Record<string, unknown> = {
      sessionId: 's1',
      queryIterator: { [Symbol.asyncIterator]() { return this }, async next() { return i < messages.length ? { done: false, value: messages[i++] } : { done: true, value: undefined } } },
      backgroundTasks: new Map(), sawResult: false, releasePrompt: null, pendingApprovals: [], abortController: null,
      status: 'busy', messageBuffer: [], messageCursor: 0, streamTask: null, lastError: null, config: {}
    }
    const internals = adapter as unknown as { sessions: Map<string, unknown>; consumeStream(id: string, s: unknown): Promise<void> }
    internals.sessions.set('s1', session)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await internals.consumeStream('s1', session)
    vi.restoreAllMocks()

    expect(reports).toEqual([{
      sessionId: 's1', turnKey: 'result-1', model: 'claude-opus-4-6',
      inputTokens: 10, outputTokens: 3, cacheReadTokens: 5_000, cacheWriteTokens: 100, reasoningTokens: 0,
      contextTokens: 5_110, contextWindow: 1_000_000, costUsd: 0.004, modelCalls: 1, stopReason: 'end_turn'
    }])
    // Usage never changes what the adapter does with the stream.
    expect(session.status).toBe('idle')
  })

  it('Codex reports thread/tokenUsage/updated against the active turn', () => {
    const adapter = new CodexAppServerAdapter()
    const reports: AdapterUsageReport[] = []
    adapter.onUsage = (report) => reports.push(report)
    const session = {
      sessionId: 'task-1', threadId: 'thread-1', activeTurnId: 'turn-9', process: { stdin: { write: vi.fn() } }, stdoutBuffer: '',
      status: SessionStatusType.BUSY, messageBuffer: [] as unknown[], permanentMessages: [] as unknown[], bufferedThreadItemIds: new Set(),
      pendingCompletionRefreshes: 0, sawThreadStatusNotification: false, pendingThreadIdle: false, pendingRequests: new Map(),
      pendingApproval: null, nextRequestId: 1, lastError: null, config: { model: 'gpt-5.1-codex', permissionMode: 'ask' },
      streamedTextByItemId: new Map(), assistantTextKeysByTurn: new Map(), runningTools: new Map(), codexUseApiKey: false, codexAuthSummary: ''
    }
    const internals = adapter as unknown as { handleRpcMessage(s: unknown, m: unknown): void }
    const breakdown = { totalTokens: 8_300, inputTokens: 8_000, cachedInputTokens: 6_000, outputTokens: 300, reasoningOutputTokens: 100 }
    internals.handleRpcMessage(session, {
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 272_000 } }
    })
    expect(reports).toEqual([{
      sessionId: 'thread-1', turnKey: 'turn-9', model: 'gpt-5.1-codex',
      inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 6_000, cacheWriteTokens: 0, reasoningTokens: 100,
      contextTokens: 8_000, contextWindow: 272_000, modelCalls: 1
    }])
    // The notification is still buffered as before.
    expect(session.messageBuffer).toHaveLength(1)
    expect(session.status).toBe(SessionStatusType.BUSY)
  })

  it('opencode reports finished assistant messages once, and not the history of a resumed session', async () => {
    const adapter = new OpencodeAdapter()
    const reports: AdapterUsageReport[] = []
    adapter.onUsage = (report) => reports.push(report)
    const now = Date.now()
    const assistant = (id: string, completed: number | undefined): Record<string, unknown> => ({
      info: {
        id, role: 'assistant', providerID: 'openai', modelID: 'gpt-5.1', cost: 0.01, finish: 'stop',
        time: { created: now - 10_000, ...(completed ? { completed } : {}) },
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 900, write: 0 } }
      },
      parts: [{ id: `${id}-text`, type: 'text', text: 'Done.' }]
    })
    let data: unknown[] = [assistant('old', now - 60_000), assistant('running', undefined)]
    const internals = adapter as unknown as { clients: Map<string, unknown>; usageSeen: Map<string, { since: number; reported: Set<string> }> }
    internals.clients.set('ses_1', { session: { messages: async () => ({ data }) } })
    internals.usageSeen.set('ses_1', { since: now - 1_000, reported: new Set() })
    const config = { agentId: 'a', taskId: 't', workspaceDir: '/tmp/ws' }

    await adapter.pollMessages('ses_1', new Set(), new Set(), new Map(), config)
    expect(reports).toEqual([])

    data = [assistant('old', now - 60_000), assistant('running', now)]
    await adapter.pollMessages('ses_1', new Set(), new Set(), new Map(), config)
    await adapter.pollMessages('ses_1', new Set(), new Set(), new Map(), config)
    expect(reports).toEqual([{
      sessionId: 'ses_1', turnKey: 'running', model: 'openai/gpt-5.1',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0, reasoningTokens: 0,
      contextTokens: 1_000, costUsd: 0.01, modelCalls: null, stopReason: 'stop'
    }])
  })
})

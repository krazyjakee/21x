/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerAdapter } from './codex-app-server-adapter'
import { ClaudeCodeAdapter } from './claude-code-adapter'
import { OpencodeAdapter } from './opencode-adapter'
import type { SessionConfig } from './coding-agent-adapter'

const config: SessionConfig = { agentId: 'agent', taskId: 'task', workspaceDir: '/workspace' }
afterEach(() => vi.restoreAllMocks())

describe('read-only adapter token usage', () => {
  it('reads Codex reported current-turn counters and ignores late prior-turn counters', async () => {
    const adapter = new CodexAppServerAdapter()
    const internal = adapter as any
    const session = { sessionId: 'thread', threadId: 'thread', lastTurnId: 'turn-2', status: 'busy',
      messageBuffer: [], permanentMessages: [], streamedTextByItemId: new Map(), assistantTextKeysByTurn: new Map(), runningTools: new Map() }
    internal.sessions.set('thread', session)
    expect(await adapter.getUsage('thread', config)).toBeNull()
    internal.handleNotification(session, { method: 'thread/tokenUsage/updated', params: { turnId: 'turn-2', tokenUsage: { last: { inputTokens: 20, outputTokens: 7, cachedInputTokens: 10 } } } })
    expect(await adapter.getUsage('thread', config)).toEqual({ inputTokens: 20, outputTokens: 7, cachedInputTokens: 10, provenance: 'reported', turnId: 'turn-2' })
    internal.handleNotification(session, { method: 'thread/tokenUsage/updated', params: { turnId: 'turn-1', tokenUsage: { last: { inputTokens: 999, outputTokens: 999 } } } })
    expect((await adapter.getUsage('thread', config))?.inputTokens).toBe(20)
    expect(session.status).toBe('busy')
  })

  it('captures Claude SDK terminal usage without changing the persisted session identity', async () => {
    const adapter = new ClaudeCodeAdapter()
    const internal = adapter as any
    const session = { sessionId: 'claude-session', status: 'busy', config, messageBuffer: [], messageCursor: 0,
      lastError: null, pendingApprovals: [], backgroundTasks: new Map(), sawResult: false, recoveryIntentId: 'turn-1',
      queryIterator: (async function* () { yield { type: 'result', subtype: 'success', usage: { input_tokens: 15, output_tokens: 6 } } })() }
    internal.sessions.set('claude-session', session)
    await internal.consumeStream('claude-session', session)
    expect(await adapter.getUsage('claude-session', config)).toEqual({ inputTokens: 15, outputTokens: 6, provenance: 'reported', turnId: 'turn-1' })
    expect(session.sessionId).toBe('claude-session')
    expect(await adapter.getUsage('missing', config)).toBeNull()
  })

  it('sums OpenCode assistant usage after the latest user input and leaves unknown usage absent', async () => {
    vi.spyOn(OpencodeAdapter.prototype as any, 'loadSDK').mockResolvedValue(undefined)
    const adapter = new OpencodeAdapter()
    const internal = adapter as any
    internal.clients.set('opencode-session', {})
    vi.spyOn(internal, 'fetchMessages').mockResolvedValue([
      { info: { role: 'assistant', tokens: { input: 999, output: 999 } } },
      { info: { role: 'user', id: 'current-user' } },
      { info: { role: 'assistant', tokens: { input: 10, output: 3 } } },
      { info: { role: 'assistant', tokens: { input: 12, output: 4 } } }
    ])
    expect(await adapter.getUsage('opencode-session', config)).toEqual({ inputTokens: 22, outputTokens: 7, provenance: 'reported', turnId: 'current-user' })
    internal.fetchMessages.mockResolvedValue([{ info: { role: 'user' } }, { info: { role: 'assistant', tokens: {} } }])
    expect(await adapter.getUsage('opencode-session', config)).toBeNull()
    expect(await adapter.getUsage('missing', config)).toBeNull()
  })
})

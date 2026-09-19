import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AcpAdapter } from './acp-adapter'
import { applyCursorAuthEnv } from './acp-agent-config'
import { SessionStatusType, MessagePartType, MessagePart } from './coding-agent-adapter'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(() => ({
    stdout: {
      on: vi.fn()
    },
    stderr: {
      on: vi.fn()
    },
    stdin: {
      write: vi.fn()
    },
    on: vi.fn(),
    kill: vi.fn()
  }))
}))

interface AcpAdapterPrivate {
  sessions: Map<string, AcpSessionForTest>
  convertAcpEventToMessageParts(
    event: unknown,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session?: AcpSessionForTest
  ): MessagePart[]
  handlePermissionRequest(session: AcpSessionForTest, request: JsonRpcRequestForTest): void
  sendRpcResponse(session: AcpSessionForTest, id: string | number, result: unknown): void
  updateSessionStatus(session: AcpSessionForTest, notification: unknown): void
  handleRpcMessage(session: AcpSessionForTest, message: unknown): void
  authenticateSession(session: AcpSessionForTest, initResult: unknown): Promise<void>
  sendRpcRequest(session: AcpSessionForTest, method: string, params?: unknown): Promise<unknown>
}

interface JsonRpcRequestForTest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface AcpSessionForTest {
  pendingSystemPrompt?: string
  sessionId: string
  acpSessionId: string | null
  process: ChildProcess
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  nextRequestId: number
  pendingApproval: unknown | null
  config: { permissionMode?: 'ask' | 'allow' }
  promptRequestId: number | null
  responseCounter: number
  currentUserTurnId: number
  lastChunkTime: number | null
  currentTurnId: number
  lastSessionUpdateType: string | null
  activeTurnId: number | null
  pendingAssistantTurnSplit: boolean
  toolCallMetadata: Map<string, { name: string; input: string; title?: string }>
  lastError: string | null
}

function adapterPrivate(adapter: AcpAdapter): AcpAdapterPrivate {
  return adapter as unknown as AcpAdapterPrivate
}

function createMockSession(sessionId: string): AcpSessionForTest {
  return {
    sessionId,
    acpSessionId: null,
    process: {} as unknown as ChildProcess,
    stdoutBuffer: '',
    status: SessionStatusType.IDLE,
    messageBuffer: [],
    permanentMessages: [],
    pendingRequests: new Map(),
    nextRequestId: 1,
    pendingApproval: null,
    config: { permissionMode: 'ask' },
    promptRequestId: null,
    responseCounter: 0,
    currentUserTurnId: 0,
    lastChunkTime: null,
    currentTurnId: 0,
    lastSessionUpdateType: null,
    activeTurnId: null,
    pendingAssistantTurnSplit: false,
    toolCallMetadata: new Map(),
    lastError: null
  }
}

describe('AcpAdapter - Turn Detection', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()

    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('Permission handling', () => {
    it('stores pending approval when permission mode is ask', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.config.permissionMode = 'ask'

      priv.handlePermissionRequest(session, {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'session/request_permission',
        params: {
          toolCall: {
            rawInput: { reason: 'Run ls' },
            toolCallId: 'tool-1',
            kind: 'shell'
          },
          options: [
            { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
            { optionId: 'abort', name: 'No', kind: 'deny' }
          ]
        }
      })

      expect(session.pendingApproval).toEqual({
        requestId: 'req-1',
        toolCallId: 'tool-1',
        question: 'Run ls',
        options: [
          { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
          { optionId: 'abort', name: 'No', kind: 'deny' }
        ]
      })
    })

    it('auto-approves when permission mode is allow', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.config.permissionMode = 'allow'
      const sendRpcResponseSpy = vi.spyOn(priv, 'sendRpcResponse')

      priv.handlePermissionRequest(session, {
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'session/request_permission',
        params: {
          toolCall: {
            rawInput: { reason: 'Run npm test' },
            toolCallId: 'tool-2',
            kind: 'shell'
          },
          options: [
            { optionId: 'approved-for-session', name: 'Always', kind: 'allow_session' },
            { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
            { optionId: 'abort', name: 'No', kind: 'deny' }
          ]
        }
      })

      expect(session.pendingApproval).toBeNull()
      expect(sendRpcResponseSpy).toHaveBeenCalledWith(session, 'req-2', {
        result: {
          outcome: {
            outcome: 'selected',
            optionId: 'approved-for-session'
          }
        }
      })
    })

    it('auto-approves Cursor permissions with allow-always', () => {
      const cursor = adapterPrivate(new AcpAdapter())
      const session = createMockSession('cursor-session')
      session.config.permissionMode = 'allow'
      const sendRpcResponseSpy = vi.spyOn(cursor, 'sendRpcResponse')

      cursor.handlePermissionRequest(session, {
        jsonrpc: '2.0',
        id: 'cursor-permission',
        method: 'session/request_permission',
        params: {
          toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'shell' },
          options: [
            { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
          ]
        }
      })

      expect(sendRpcResponseSpy).toHaveBeenCalledWith(session, 'cursor-permission', {
        result: { outcome: { outcome: 'selected', optionId: 'allow-always' } }
      })
    })
  })

  describe('Authentication', () => {
    it('authenticates with the first advertised method using the Cursor CLI login', async () => {
      const priv = adapterPrivate(adapter)
      const env: Record<string, string | undefined> = {
        CURSOR_API_KEY: 'ambient-key',
        CURSOR_AUTH_TOKEN: 'ambient-token'
      }
      const session = createMockSession('cursor-auth')
      const sendRpcRequestSpy = vi.spyOn(priv, 'sendRpcRequest').mockResolvedValue({})

      applyCursorAuthEnv(env, { authMethod: 'subscription' })
      await priv.authenticateSession(session, { authMethods: [{ id: 'cursor_login' }] })

      expect(env.CURSOR_API_KEY).toBeUndefined()
      expect(env.CURSOR_AUTH_TOKEN).toBeUndefined()
      expect(sendRpcRequestSpy).toHaveBeenCalledWith(session, 'authenticate', {
        methodId: 'cursor_login'
      })
    })

    it('skips authenticate when no method is advertised', async () => {
      const priv = adapterPrivate(adapter)
      const sendRpcRequestSpy = vi.spyOn(priv, 'sendRpcRequest').mockResolvedValue({})

      await priv.authenticateSession(createMockSession('cursor-auth'), { authMethods: [] })

      expect(sendRpcRequestSpy).not.toHaveBeenCalled()
    })

    it('uses the configured Cursor API key and rejects missing key auth', () => {
      const env: Record<string, string | undefined> = { CURSOR_API_KEY: 'ambient-key' }

      applyCursorAuthEnv(env, {
        authMethod: 'api_key',
        apiKeys: { cursor: 'configured-key' }
      })
      expect(env.CURSOR_API_KEY).toBe('configured-key')

      expect(() => applyCursorAuthEnv({}, { authMethod: 'api_key' }))
        .toThrow('Cursor API-key authentication requires a configured key or CURSOR_API_KEY')
    })
  })

  describe('Cursor extension requests', () => {
    it('returns non-blocking outcomes for unsupported questions and plans', () => {
      const cursor = adapterPrivate(new AcpAdapter())
      const session = createMockSession('cursor-extensions')
      const sendRpcResponseSpy = vi.spyOn(cursor, 'sendRpcResponse')

      cursor.handleRpcMessage(session, {
        jsonrpc: '2.0',
        id: 'question-1',
        method: 'cursor/ask_question',
        params: {}
      })
      cursor.handleRpcMessage(session, {
        jsonrpc: '2.0',
        id: 'plan-1',
        method: 'cursor/create_plan',
        params: {}
      })

      expect(sendRpcResponseSpy).toHaveBeenNthCalledWith(1, session, 'question-1', {
        result: { outcome: { outcome: 'skipped', reason: 'Cursor questions are not supported by 20x yet' } }
      })
      expect(sendRpcResponseSpy).toHaveBeenNthCalledWith(2, session, 'plan-1', {
        result: { outcome: { outcome: 'cancelled' } }
      })
    })
  })

  describe('Time-based turn detection', () => {
    it('should use same turn ID for messages arriving within 2 seconds', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1) // First turn
      expect(parts1[0].id).toBe('agent-response-1')

      vi.advanceTimersByTime(1000)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' World' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1) // Still turn 1
      expect(parts2[0].id).toBe('agent-response-1') // Same ID
    })

    it('should increment turn ID for messages arriving after 2+ seconds', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First message' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1)
      expect(parts1[0].id).toBe('agent-response-1')

      vi.advanceTimersByTime(3000)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second message' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(2) // New turn
      expect(parts2[0].id).toBe('agent-response-2') // Different ID
    })

    it('should keep same turn during long gaps when prompt-scoped turn is active', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      session.currentTurnId = 1
      session.activeTurnId = 1

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Long response part 1' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts1[0].id).toBe('agent-response-1')

      // Simulate a long pause between chunks (stream stall/network jitter)
      vi.advanceTimersByTime(3000)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' and part 2' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(session.currentTurnId).toBe(1)
      expect(parts2[0].id).toBe('agent-response-1')
      expect(parts2[0].text).toBe('Long response part 1 and part 2')
    })
  })

  describe('Resume buffer handling', () => {
    it('clears replayed messageBuffer after resumeSession loads history', async () => {
      const adapterAny = adapter as any
      const replayEvent = {
        method: 'session/update',
        params: {
          sessionId: 'persisted-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Replayed assistant message' }
          }
        }
      }

      vi.spyOn(adapterAny, 'sendRpcRequest').mockImplementation(async (...args: unknown[]) => {
        const session = args[0] as AcpSessionForTest
        const method = args[1] as string

        if (method === 'initialize' || method === 'authenticate') return {}
        if (method === 'session/load') {
          session.messageBuffer.push(replayEvent)
          session.permanentMessages.push(replayEvent)
          return {}
        }
        return {}
      })

      const messages = await adapter.resumeSession('persisted-session-id', {
        workspaceDir: '/tmp',
        permissionMode: 'default'
      } as any)

      expect(messages).toHaveLength(1)

      const session = adapterPrivate(adapter).sessions.get('persisted-session-id')
      expect(session).toBeTruthy()
      expect(session?.messageBuffer).toHaveLength(0)

      const polled = await adapter.pollMessages(
        'persisted-session-id',
        new Set(),
        new Set(),
        new Map(),
        {} as any
      )
      expect(polled).toHaveLength(0)
    })
  })

  describe('Tool call turn detection', () => {
    it('should start a new turn after a completed tool call within an active prompt turn', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      session.currentTurnId = 1
      session.activeTurnId = 1

      priv.sessions.set(sessionId, session)

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Before tool' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1)

      vi.advanceTimersByTime(500)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            status: 'completed',
            kind: 'bash',
            rawInput: { command: 'ls' },
            rawOutput: { stdout: 'file.txt' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        toolCall,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      // Next assistant chunk after a completed tool call should become a new turn
      vi.advanceTimersByTime(500)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'After tool' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(2)
      expect(parts2[0].id).toBe('agent-response-2')
    })

    it('should cache tool metadata from initial tool_call and use it on completion', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const toolCallStart = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            status: 'in_progress',
            kind: 'shell',
            title: 'ls -la',
            rawInput: { command: 'ls -la' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        toolCallStart,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.toolCallMetadata.has('tool-1')).toBe(true)
      expect(session.toolCallMetadata.get('tool-1')?.name).toBe('shell')
      expect(session.toolCallMetadata.get('tool-1')?.input).toBe('ls -la')

      // Completed tool_call_update without kind/rawInput (Codex format)
      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '{"files":[]}' } }],
            rawOutput: { content: [{ text: 'file.txt\ndir/', type: 'text' }], isError: false }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts.length).toBe(1)
      expect(parts[0].type).toBe(MessagePartType.TOOL)
      expect(parts[0].tool?.name).toBe('shell')
      expect(parts[0].tool?.title).toBe('ls -la')
      expect(parts[0].tool?.input).toBe('ls -la')
      expect(parts[0].tool?.output).toBe('file.txt\ndir/')

      expect(session.toolCallMetadata.has('tool-1')).toBe(false)
    })

    it('should normalize exec_command to command and use command as title', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            title: 'exec_command',
            rawInput: { command: 'pwd' },
            rawOutput: { stdout: '/tmp' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('command')
      expect(parts[0].tool?.title).toBe('pwd')
      expect(parts[0].tool?.input).toBe('pwd')
    })

    it('should use rawInput.cmd for exec_command title', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-cmd',
            status: 'completed',
            title: 'exec_command',
            rawInput: { cmd: 'pwd' },
            rawOutput: { stdout: '/tmp' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('command')
      expect(parts[0].tool?.title).toBe('pwd')
      expect(parts[0].tool?.input).toBe('pwd')
    })

    it('should normalize write_stdin and summarize chars as title', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-stdin',
            status: 'completed',
            title: 'write_stdin',
            rawInput: { chars: 'y\n' },
            rawOutput: { stdout: '' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('stdin')
      expect(parts[0].tool?.title).toBe('y')
    })

    it('should normalize update_plan and summarize first step as title', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-plan',
            status: 'completed',
            title: 'update_plan',
            rawInput: {
              plan: [
                { step: 'Trace replay messages', status: 'completed' },
                { step: 'Patch transcript labels', status: 'in_progress' }
              ]
            },
            rawOutput: { stdout: '' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts).toHaveLength(1)
      expect(parts[0].tool?.name).toBe('plan')
      expect(parts[0].tool?.title).toBe('2 steps: Trace replay messages')
    })

    it('should extract output from Codex rawOutput content array', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const toolCallComplete = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-2',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '{"resourceTemplates":[]}' } }],
            rawOutput: { content: [{ text: '{"resourceTemplates":[]}', type: 'text' }], isError: false }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        toolCallComplete,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts.length).toBe(1)
      expect(parts[0].tool?.output).toBe('{"resourceTemplates":[]}')
    })
  })

  describe('Message accumulation', () => {
    it('should accumulate chunks with same turn ID', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts1[0].text).toBe('Hello')
      expect(parts1[0].id).toBe('agent-response-1')

      vi.advanceTimersByTime(500)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' World' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts2[0].text).toBe('Hello World') // Accumulated
      expect(parts2[0].id).toBe('agent-response-1') // Same ID
      expect(parts2[0].update).toBe(true) // Marked as update
    })

    it('should create separate messages for different turn IDs', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(
        chunk1,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts1[0].text).toBe('First')
      expect(parts1[0].id).toBe('agent-response-1')

      vi.advanceTimersByTime(3000)

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(
        chunk2,
        new Set(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts2[0].text).toBe('Second') // Not accumulated with first
      expect(parts2[0].id).toBe('agent-response-2') // Different ID
      expect(parts2[0].update).toBe(false) // Not an update, new message
    })
  })

  describe('Thinking chunks', () => {
    it('should use same turn ID for thinking chunks', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const messageChunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(
        messageChunk,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1)

      vi.advanceTimersByTime(500)

      const thinkingChunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'I am thinking...' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        thinkingChunk,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(parts[0].id).toBe('agent-thinking-1') // Uses current turn ID
      expect(parts[0].type).toBe(MessagePartType.REASONING)
    })
  })

  describe('Resume session scenario', () => {
    it('should handle replayed messages with proper turn detection', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      // Simulate replayed messages arriving in quick succession
      // (as they would during session resume)

      const replay1a = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First reply chunk 1' }
          }
        }
      }

      const replay1b = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' chunk 2' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(replay1a, new Set(), seenPartIds, partContentLengths, session)
      vi.advanceTimersByTime(100) // Small delay
      const parts1 = priv.convertAcpEventToMessageParts(replay1b, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(1)
      expect(parts1[0].id).toBe('agent-response-1')
      expect(parts1[0].text).toContain('First reply chunk 1 chunk 2')

      // Simulate gap before next historical message (tool call or time)
      vi.advanceTimersByTime(3000)

      const replay2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second reply' }
          }
        }
      }

      const parts2 = priv.convertAcpEventToMessageParts(replay2, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(2) // New turn detected
      expect(parts2[0].id).toBe('agent-response-2') // Different ID
      expect(parts2[0].text).toBe('Second reply')
    })

    it('keeps separate replayed user and assistant turns even without time gaps', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const firstUser = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'First task prompt' }
          }
        }
      }

      const firstAssistant = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First assistant reply' }
          }
        }
      }

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'exec_command',
            status: 'completed',
            rawInput: { command: 'pwd' }
          }
        }
      }

      const secondUser = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Second task prompt' }
          }
        }
      }

      const secondAssistant = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second assistant reply' }
          }
        }
      }

      const firstUserParts = priv.convertAcpEventToMessageParts(firstUser, new Set(), seenPartIds, partContentLengths, session)
      const firstAssistantParts = priv.convertAcpEventToMessageParts(firstAssistant, new Set(), seenPartIds, partContentLengths, session)
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      const secondUserParts = priv.convertAcpEventToMessageParts(secondUser, new Set(), seenPartIds, partContentLengths, session)
      const secondAssistantParts = priv.convertAcpEventToMessageParts(secondAssistant, new Set(), seenPartIds, partContentLengths, session)

      expect(firstUserParts[0].id).toBe('user-message-1')
      expect(secondUserParts[0].id).toBe('user-message-2')
      expect(firstAssistantParts[0].id).toBe('agent-response-1')
      expect(secondAssistantParts[0].id).toBe('agent-response-2')
      expect(secondAssistantParts[0].text).toBe('Second assistant reply')
    })

    it('starts a new assistant turn after tool activity even with active prompt turn', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      session.currentTurnId = 1
      session.activeTurnId = 1
      session.lastSessionUpdateType = 'agent_message_chunk'
      priv.sessions.set(sessionId, session)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-active',
            title: 'exec_command',
            status: 'completed',
            rawInput: { cmd: 'pwd' }
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here is the result.' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(2)
      expect(session.activeTurnId).toBe(2)
      expect(afterToolParts[0].id).toBe('agent-response-2')
    })

    it('does NOT clear activeTurnId in updateSessionStatus (turn state managed only during polling)', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      session.currentTurnId = 1
      session.activeTurnId = 1
      session.lastSessionUpdateType = 'agent_message_chunk'
      priv.sessions.set(sessionId, session)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-live',
            title: 'exec_command',
            status: 'completed',
            rawInput: { cmd: 'pwd' }
          }
        }
      }

      // updateSessionStatus should NOT modify turn-related state (activeTurnId,
      // pendingAssistantTurnSplit) — that's handled by convertAcpEventToMessageParts
      // during polling to avoid race conditions with real-time event arrival.
      priv.updateSessionStatus(session, toolCall as never)
      expect(session.activeTurnId).toBe(1) // Preserved — turn state managed only during polling

      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here is the result.' }
          }
        }
      }

      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(session.currentTurnId).toBe(2)
      expect(session.activeTurnId).toBe(2) // Updated by getAssistantTurnId
      expect(afterToolParts[0].id).toBe('agent-response-2')
    })

    it('starts a new live assistant turn after usage_update follows a tool call', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      session.currentTurnId = 1
      session.activeTurnId = 1
      session.lastSessionUpdateType = 'agent_message_chunk'
      priv.sessions.set(sessionId, session)

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-live-usage',
            title: 'Run pwd',
            status: 'completed',
            rawInput: { command: ['pwd'] }
          }
        }
      }

      const usageUpdate = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'usage_update'
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'am2' }
          }
        }
      }

      priv.updateSessionStatus(session, toolCall as never)
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      priv.convertAcpEventToMessageParts(usageUpdate, new Set(), seenPartIds, partContentLengths, session)
      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(session.pendingAssistantTurnSplit).toBe(false)
      expect(session.currentTurnId).toBe(2)
      expect(afterToolParts[0].id).toBe('agent-response-2')
      expect(afterToolParts[0].text).toBe('am2')
    })

    it('starts a new assistant replay turn after tool activity', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const assistantBeforeTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Let me inspect that.' }
          }
        }
      }

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-2',
            title: 'exec_command',
            status: 'completed',
            rawInput: { command: 'ls' }
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'I found the issue.' }
          }
        }
      }

      const beforeToolParts = priv.convertAcpEventToMessageParts(assistantBeforeTool, new Set(), seenPartIds, partContentLengths, session)
      priv.convertAcpEventToMessageParts(toolCall, new Set(), seenPartIds, partContentLengths, session)
      const afterToolParts = priv.convertAcpEventToMessageParts(assistantAfterTool, new Set(), seenPartIds, partContentLengths, session)

      expect(beforeToolParts[0].id).toBe('agent-response-1')
      expect(afterToolParts[0].id).toBe('agent-response-2')
      expect(afterToolParts[0].text).toBe('I found the issue.')
    })
  })

  describe('Resume message grouping', () => {
    it('keeps assistant text after tool calls as a separate resumed message', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      const assistantBeforeTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Let me inspect that.' }
          }
        }
      }

      const toolCall = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-2',
            title: 'exec_command',
            status: 'completed',
            rawInput: { cmd: 'pwd' }
          }
        }
      }

      const assistantAfterTool = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'I found the issue.' }
          }
        }
      }

      session.permanentMessages.push(assistantBeforeTool, toolCall, assistantAfterTool)
      priv.sessions.set(sessionId, session)

      const messages = await adapter.getAllMessages(sessionId, {
        agentId: 'cursor',
        taskId: 'task-1',
        workspaceDir: '/tmp'
      })

      expect(messages).toHaveLength(3)
      expect(messages[0].parts[0].id).toBe('agent-response-1')
      expect(messages[1].parts[0].id).toBe('tool-2')
      expect(messages[2].parts[0].id).toBe('agent-response-2')
      expect(messages[2].parts[0].text).toBe('I found the issue.')
    })
  })

  describe('Edge cases', () => {
    it('converts non-chunk replayed user and agent messages', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const userMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'user_message',
            messageId: 'user-1',
            content: { type: 'text', text: 'Please run tests' }
          }
        }
      }

      const agentMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message',
            messageId: 'assistant-1',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'Running tests now.' }
              }
            ]
          }
        }
      }

      const userParts = priv.convertAcpEventToMessageParts(userMessage, new Set(), seenPartIds, partContentLengths, session)
      const agentParts = priv.convertAcpEventToMessageParts(agentMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(userParts).toHaveLength(1)
      expect(userParts[0].role).toBe('user')
      expect(userParts[0].type).toBe(MessagePartType.TEXT)
      expect(userParts[0].text).toBe('Please run tests')

      expect(agentParts).toHaveLength(1)
      expect(agentParts[0].role).toBe('assistant')
      expect(agentParts[0].type).toBe(MessagePartType.TEXT)
      expect(agentParts[0].text).toBe('Running tests now.')
    })

    it('converts alternate completed message aliases and array text shapes', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      priv.sessions.set(sessionId, session)

      const assistantMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'assistant_message',
            messageId: 'assistant-2',
            content: [
              { type: 'text', text: 'Done inspecting resume history.' },
              { type: 'text', text: 'Found the gap.' }
            ]
          }
        }
      }

      const humanMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'human_message',
            messageId: 'user-2',
            content: {
              type: 'wrapper',
              content: { type: 'text', text: 'Please keep digging.' }
            }
          }
        }
      }

      const assistantParts = priv.convertAcpEventToMessageParts(assistantMessage, new Set(), seenPartIds, partContentLengths, session)
      const humanParts = priv.convertAcpEventToMessageParts(humanMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(assistantParts).toHaveLength(1)
      expect(assistantParts[0].role).toBe('assistant')
      expect(assistantParts[0].text).toBe('Done inspecting resume history.\nFound the gap.')

      expect(humanParts).toHaveLength(1)
      expect(humanParts[0].role).toBe('user')
      expect(humanParts[0].text).toBe('Please keep digging.')
    })

    it('should handle first chunk when lastChunkTime is null', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)

      const session = priv.sessions.get(sessionId) || createMockSession(sessionId)

      priv.sessions.set(sessionId, session)

      const chunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First chunk ever' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        chunk,
        new Set(),
        new Set(),
        new Map(),
        session
      )

      expect(session.currentTurnId).toBe(1) // Should create turn 1
      expect(session.lastChunkTime).not.toBeNull() // Should set timestamp
      expect(parts[0].id).toBe('agent-response-1')
    })

    it('should not increment turn ID when session is undefined', async () => {
      const priv = adapterPrivate(adapter)

      const chunk = {
        method: 'session/update',
        params: {
          sessionId: 'unknown',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'No session' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(
        chunk,
        new Set(),
        new Set(),
        new Map(),
        undefined // No session
      )

      expect(parts[0].id).toBe('agent-response') // Default when turnId is 0
    })
  })
})

describe('AcpAdapter - sendPrompt buffer clearing', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
  })

  it('should clear messageBuffer on sendPrompt to prevent stale event duplication', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-buffer')
    session.process = {
      stdin: { write: vi.fn() }
    } as unknown as ChildProcess
    priv.sessions.set('sess-buffer', session)

    session.messageBuffer.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'stale text from old turn' }
        }
      }
    })

    await adapter.sendPrompt('sess-buffer', [{ type: MessagePartType.TEXT, text: 'New prompt' }], {} as never)

    expect(session.messageBuffer).toEqual([])
  })

  it('should store synthetic user_message in permanentMessages on sendPrompt', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-usermsg')
    session.process = {
      stdin: { write: vi.fn() }
    } as unknown as ChildProcess
    priv.sessions.set('sess-usermsg', session)

    await adapter.sendPrompt('sess-usermsg', [{ type: MessagePartType.TEXT, text: 'Hello agent' }], {} as never)

    const userEvent = session.permanentMessages.find((e: unknown) => {
      const params = (e as { params?: { update?: { sessionUpdate?: string } } }).params
      return params?.update?.sessionUpdate === 'user_message'
    })
    expect(userEvent).toBeDefined()

    const params = (userEvent as { params: { update: { content: { text: string } } } }).params
    expect(params.update.content.text).toBe('Hello agent')
  })

  it('synthetic user messages should appear in getAllMessages replay', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-replay')
    session.process = {
      stdin: { write: vi.fn() }
    } as unknown as ChildProcess
    priv.sessions.set('sess-replay', session)

    await adapter.sendPrompt('sess-replay', [{ type: MessagePartType.TEXT, text: 'Work on task' }], {} as never)

    session.permanentMessages.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I will work on it.' }
        }
      }
    })

    const messages = await adapter.getAllMessages('sess-replay', {} as never)
    const userParts = messages.flatMap(m => m.parts).filter(p => p.text?.includes('Work on task'))
    const agentParts = messages.flatMap(m => m.parts).filter(p => p.text?.includes('I will work on it'))

    expect(userParts.length).toBeGreaterThan(0)
    expect(agentParts.length).toBeGreaterThan(0)
  })
})

describe('AcpAdapter - In-progress tool call visibility', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should emit a running tool part for in_progress tool_call events', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool')
    const seenPartIds = new Set<string>()

    const inProgressEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-abc',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'ls -la' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      inProgressEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(parts.length).toBe(1)
    expect(parts[0].type).toBe(MessagePartType.TOOL)
    expect(parts[0].tool?.status).toBe('running')
    expect(parts[0].tool?.name).toBe('command')
    expect(parts[0].id).toBe('tool-abc')
    expect(seenPartIds.has('tool-abc')).toBe(true)
  })

  it('should update running tool to completed with output and update flag', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool2')
    const seenPartIds = new Set<string>()

    const inProgressEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-xyz',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'cat file.txt' }
        }
      }
    }
    priv.convertAcpEventToMessageParts(inProgressEvent, new Set(), seenPartIds, new Map(), session)

    expect(seenPartIds.has('tool-xyz')).toBe(true)

    const completedEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-xyz',
          status: 'completed',
          rawOutput: { stdout: 'file contents here' }
        }
      }
    }

    const completedParts = priv.convertAcpEventToMessageParts(
      completedEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(completedParts.length).toBe(1)
    expect(completedParts[0].type).toBe(MessagePartType.TOOL)
    expect(completedParts[0].tool?.status).toBe('completed')
    expect(completedParts[0].tool?.output).toBe('file contents here')
    expect(completedParts[0].update).toBe(true) // Should be marked as update
  })

  it('should create completed tool part even without prior in_progress event', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool3')
    const seenPartIds = new Set<string>()

    const completedEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-direct',
          kind: 'exec_command',
          status: 'completed',
          rawInput: { command: 'echo hello' },
          rawOutput: { stdout: 'hello' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      completedEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(parts.length).toBe(1)
    expect(parts[0].tool?.status).toBe('completed')
    expect(parts[0].tool?.output).toBe('hello')
    expect(parts[0].update).toBe(false) // No prior part, so not an update
  })
})

describe('AcpAdapter - sendPrompt clears stale messageBuffer', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
  })

  it('should clear messageBuffer on sendPrompt to prevent duplication on next poll', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-dedup')
    session.messageBuffer = [
      { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale' } } } },
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'old-tool', status: 'in_progress' } } }
    ]
    session.permanentMessages = []
    session.process = {
      stdin: { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) }) }
    } as unknown as ChildProcess

    priv.sessions.set('sess-dedup', session)

    await adapter.sendPrompt('sess-dedup', [{ type: MessagePartType.TEXT, text: 'new prompt' }], {} as never)

    expect(session.messageBuffer).toEqual([])
  })

  it('should add synthetic user_message to permanentMessages for resume', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-user')
    session.permanentMessages = []
    session.process = {
      stdin: { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) }) }
    } as unknown as ChildProcess

    priv.sessions.set('sess-user', session)

    await adapter.sendPrompt('sess-user', [{ type: MessagePartType.TEXT, text: 'Hello agent' }], {} as never)

    const userEvents = session.permanentMessages.filter((e) => {
      const params = (e as { params?: { update?: { sessionUpdate?: string } } }).params
      return params?.update?.sessionUpdate === 'user_message'
    })

    expect(userEvents.length).toBe(1)
    const event = userEvents[0] as { params: { update: { content: { text: string }; messageId: string } } }
    expect(event.params.update.content.text).toBe('Hello agent')
    expect(event.params.update.messageId).toMatch(/^user-prompt-/)
  })

  it('should NOT leave stale events that cause duplicated messages after idle+restart', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-idle')

    session.messageBuffer = [
      { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old text' } } } }
    ]
    session.process = {
      stdin: { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) }) }
    } as unknown as ChildProcess

    priv.sessions.set('sess-idle', session)

    await adapter.sendPrompt('sess-idle', [{ type: MessagePartType.TEXT, text: 'fresh prompt' }], {} as never)

    const parts = await adapter.pollMessages('sess-idle', new Set(), new Set(), new Map(), {} as never)
    expect(parts).toEqual([])
  })
})

describe('AcpAdapter - system prompt delivery', () => {
  it('sends the system prompt with the first prompt only and keeps it out of the transcript', async () => {
    const adapter = new AcpAdapter()
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-sys')
    session.permanentMessages = []
    session.pendingSystemPrompt = 'You are the Captain.'
    const write = vi.fn((_data: string, cb?: (err?: Error | null) => void) => { if (cb) cb(null) })
    session.process = { stdin: { write } } as unknown as ChildProcess
    priv.sessions.set('sess-sys', session)

    await adapter.sendPrompt('sess-sys', [{ type: MessagePartType.TEXT, text: 'Plan the release' }], {} as never)
    session.status = SessionStatusType.IDLE
    await adapter.sendPrompt('sess-sys', [{ type: MessagePartType.TEXT, text: 'Next step' }], {} as never)

    const prompts = write.mock.calls
      .map(([data]) => JSON.parse(String(data).trim()))
      .filter((msg) => msg.method === 'session/prompt')
      .map((msg) => msg.params.prompt[0].text as string)
    expect(prompts[0]).toBe('<system_instructions>\nYou are the Captain.\n</system_instructions>\n\nPlan the release')
    expect(prompts[1]).toBe('Next step')

    const transcript = JSON.stringify(session.permanentMessages)
    expect(transcript).not.toContain('You are the Captain.')
  })
})

describe('AcpAdapter - In-progress tool parts', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should emit in-progress tool part immediately when tool_call arrives', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool-progress')
    const seenPartIds = new Set<string>()

    const toolCallInProgress = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-ip-1',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'npm test' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      toolCallInProgress,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(parts.length).toBe(1)
    expect(parts[0].id).toBe('tool-ip-1')
    expect(parts[0].type).toBe(MessagePartType.TOOL)
    expect(parts[0].tool?.status).toBe('running')
    expect(parts[0].tool?.name).toBe('command')
  })

  it('should update in-progress tool part when completed', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool-update')
    const seenPartIds = new Set<string>()

    const inProgressEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-up-1',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'ls -la' }
        }
      }
    }

    priv.convertAcpEventToMessageParts(
      inProgressEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(seenPartIds.has('tool-up-1')).toBe(true)

    const completedEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-up-1',
          kind: 'exec_command',
          status: 'completed',
          rawInput: { command: 'ls -la' },
          rawOutput: { stdout: 'file1\nfile2' }
        }
      }
    }

    const completedParts = priv.convertAcpEventToMessageParts(
      completedEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )

    expect(completedParts.length).toBe(1)
    expect(completedParts[0].id).toBe('tool-up-1')
    expect(completedParts[0].tool?.status).toBe('completed')
    expect(completedParts[0].tool?.output).toBe('file1\nfile2')
    expect(completedParts[0].update).toBe(true) // marked as update since in-progress was already emitted
  })

  it('should NOT duplicate in-progress tool part when same toolCallId arrives twice', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-tool-nodup')
    const seenPartIds = new Set<string>()

    const toolCallEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-dup-1',
          kind: 'exec_command',
          status: 'in_progress',
          rawInput: { command: 'echo hi' }
        }
      }
    }

    const parts1 = priv.convertAcpEventToMessageParts(
      toolCallEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )
    expect(parts1.length).toBe(1)

    const parts2 = priv.convertAcpEventToMessageParts(
      toolCallEvent,
      new Set(),
      seenPartIds,
      new Map(),
      session
    )
    expect(parts2.length).toBe(0)
  })
})

describe('AcpAdapter - User message handling', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should convert user_message events to user-role parts', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-user-msg')

    const userMessageEvent = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message',
          messageId: 'user-msg-1',
          content: { type: 'text', text: 'Hello from user' }
        }
      }
    }

    const parts = priv.convertAcpEventToMessageParts(
      userMessageEvent,
      new Set(),
      new Set(),
      new Map(),
      session
    )

    expect(parts.length).toBe(1)
    expect(parts[0].role).toBe('user')
    expect(parts[0].text).toBe('Hello from user')
    expect(parts[0].id).toBe('user-msg-1')
  })

  it('should accumulate user_message_chunk events', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-user-chunks')
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const chunk1 = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'Hello ' }
        }
      }
    }

    const parts1 = priv.convertAcpEventToMessageParts(
      chunk1, new Set(), seenPartIds, partContentLengths, session
    )

    expect(parts1.length).toBe(1)
    expect(parts1[0].role).toBe('user')
    expect(parts1[0].text).toBe('Hello ')

    const chunk2 = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'world' }
        }
      }
    }

    const parts2 = priv.convertAcpEventToMessageParts(
      chunk2, new Set(), seenPartIds, partContentLengths, session
    )

    expect(parts2.length).toBe(1)
    expect(parts2[0].role).toBe('user')
    expect(parts2[0].text).toBe('Hello world')
    expect(parts2[0].update).toBe(true) // streaming update
  })

  it('synthetic user_message in permanentMessages survives getAllMessages', async () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-resume-user')

    session.permanentMessages.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message',
          content: { type: 'text', text: 'User prompt text' },
          messageId: 'user-prompt-1'
        }
      }
    })

    session.permanentMessages.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Agent response' }
        }
      }
    })

    priv.sessions.set('sess-resume-user', session)

    const messages = await adapter.getAllMessages('sess-resume-user', {} as never)

    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    expect(userMessages.length).toBe(1)
    expect(userMessages[0].parts[0].text).toBe('User prompt text')
    expect(assistantMessages.length).toBe(1)
    expect(assistantMessages[0].parts[0].text).toBe('Agent response')
  })
})

describe('AcpAdapter - Non-content events must not fragment assistant messages', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('available_commands_update between chunks should NOT start a new turn', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-cmd-update')
    session.currentTurnId = 1
    session.activeTurnId = 1
    session.lastSessionUpdateType = 'agent_message_chunk'
    priv.sessions.set('sess-cmd-update', session)

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const chunk1 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } }
    }
    priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)
    expect(session.currentTurnId).toBe(1)

    const cmdUpdate = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'available_commands_update' } }
    }
    priv.convertAcpEventToMessageParts(cmdUpdate, new Set(), seenPartIds, partContentLengths, session)

    const chunk2 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } }
    }
    const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

    expect(session.currentTurnId).toBe(1) // SAME turn — no split
    expect(parts2[0].id).toBe('agent-response-1') // same message ID
    expect(parts2[0].text).toBe('Hello world') // accumulated text
  })

  it('plan event between chunks should NOT start a new turn', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-plan')
    session.currentTurnId = 1
    session.activeTurnId = 1
    session.lastSessionUpdateType = 'agent_message_chunk'
    priv.sessions.set('sess-plan', session)

    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const chunk1 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Step 1: ' } } }
    }
    priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)

    const planEvent = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', entries: [{ content: 'step 1', priority: 'high', status: 'pending' }] } }
    }
    priv.convertAcpEventToMessageParts(planEvent, new Set(), seenPartIds, partContentLengths, session)

    const chunk2 = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'read file' } } }
    }
    const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

    expect(session.currentTurnId).toBe(1) // SAME turn
    expect(parts2[0].id).toBe('agent-response-1')
    expect(parts2[0].text).toBe('Step 1: read file')
  })

  it('updateSessionStatus should NOT modify turn state (activeTurnId, pendingAssistantTurnSplit)', () => {
    const priv = adapterPrivate(adapter)
    const session = createMockSession('sess-status')
    session.currentTurnId = 1
    session.activeTurnId = 1
    session.pendingAssistantTurnSplit = false
    priv.sessions.set('sess-status', session)

    const toolNotification = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', status: 'in_progress' } }
    }

    priv.updateSessionStatus(session, toolNotification as never)

    expect(session.status).toBe('busy')
    expect(session.activeTurnId).toBe(1)
    expect(session.pendingAssistantTurnSplit).toBe(false)
  })
})

describe('AcpAdapter - session creation', () => {
  it.each([
    ['composer-2.5', 'composer-2.5[fast=true]'],
    ['grok-4.5', 'grok-4.5[effort=high,fast=true]']
  ])('maps %s to Cursor ACP model configuration', async (model, value) => {
    const adapter = new AcpAdapter()
    const priv = adapterPrivate(adapter)
    const sendRpcRequestSpy = vi.spyOn(priv, 'sendRpcRequest')
      .mockResolvedValueOnce({ authMethods: [] })
      .mockResolvedValueOnce({ sessionId: 'cursor-session' })
      .mockResolvedValueOnce({})

    await adapter.createSession({
      agentId: 'agent-1',
      taskId: 'task-1',
      workspaceDir: '/tmp/workspace',
      model,
      authMethod: 'subscription'
    })

    expect(spawn).toHaveBeenCalledWith('cursor-agent', ['acp'], expect.objectContaining({ cwd: '/tmp/workspace' }))
    expect(sendRpcRequestSpy).toHaveBeenNthCalledWith(3, expect.anything(), 'session/set_config_option', {
      sessionId: 'cursor-session',
      configId: 'model',
      value
    })
  })

})

describe('AcpAdapter - Error handling', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
  })

  describe('handleRpcMessage error responses', () => {
    it('buffers an error response that answers no pending request', () => {
      const session = createMockSession('test-session')

      adapterPrivate(adapter).sessions.set('test-session', session)

      const genericErrorMessage = {
        jsonrpc: '2.0',
        id: 99,
        error: {
          code: -32603,
          message: 'Some generic error'
        }
      }

      adapterPrivate(adapter).handleRpcMessage(session, genericErrorMessage)

      expect(session.lastError).toBeNull()
      expect(session.messageBuffer).toHaveLength(1)
      const errorEvent = session.messageBuffer[0] as Record<string, unknown>
      expect(errorEvent._isError).toBe(true)
      expect(errorEvent.message).toBe('Some generic error')
    })
  })

  describe('getStatus with lastError', () => {
    it('should return lastError message when session is in error state', async () => {
      const session = createMockSession('test-session')
      session.status = SessionStatusType.ERROR
      session.lastError = 'Quota exceeded: Check your plan.'

      adapterPrivate(adapter).sessions.set('test-session', session)

      const status = await adapter.getStatus('test-session', {} as any)
      expect(status.type).toBe(SessionStatusType.ERROR)
      expect(status.message).toBe('Quota exceeded: Check your plan.')
    })

    it('should return generic Process error when no lastError', async () => {
      const session = createMockSession('test-session')
      session.status = SessionStatusType.ERROR

      adapterPrivate(adapter).sessions.set('test-session', session)

      const status = await adapter.getStatus('test-session', {} as any)
      expect(status.type).toBe(SessionStatusType.ERROR)
      expect(status.message).toBe('Process error')
    })

    it('should return no message when session is not in error state', async () => {
      const session = createMockSession('test-session')
      session.status = SessionStatusType.IDLE

      adapterPrivate(adapter).sessions.set('test-session', session)

      const status = await adapter.getStatus('test-session', {} as any)
      expect(status.type).toBe(SessionStatusType.IDLE)
      expect(status.message).toBeUndefined()
    })
  })

  describe('error rendering in convertAcpEventToMessageParts', () => {
    it('renders an error event with a clean message (no raw data)', () => {
      const session = createMockSession('test-session')
      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const errorEvent = {
        _isError: true,
        message: 'Quota exceeded: Check your plan.',
        data: null
      }

      const parts = adapterPrivate(adapter).convertAcpEventToMessageParts(
        errorEvent,
        new Set<string>(),
        seenPartIds,
        partContentLengths,
        session
      )

      expect(parts).toHaveLength(1)
      expect(parts[0].type).toBe(MessagePartType.TEXT)
      expect(parts[0].text).toBe('Error: Quota exceeded: Check your plan.')
    })
  })

  describe('verbose RPC logging toggle', () => {
    it('suppresses high-frequency RPC logs by default', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const session = createMockSession('test-session')

      adapterPrivate(adapter).handleRpcMessage(session, {
        jsonrpc: '2.0',
        method: 'agent/ping'
      })

      const loggedLines = logSpy.mock.calls.map((call) => String(call[0]))
      expect(loggedLines.some((line) => line.includes('Received RPC message'))).toBe(false)
      expect(loggedLines.some((line) => line.includes('<< Notification'))).toBe(false)
    })

    it('enables detailed RPC logs when LOG_LEVEL=debug', () => {
      const originalValue = process.env.LOG_LEVEL
      process.env.LOG_LEVEL = 'debug'

      try {
        const verboseAdapter = new AcpAdapter()
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const session = createMockSession('test-session')

        adapterPrivate(verboseAdapter).handleRpcMessage(session, {
          jsonrpc: '2.0',
          method: 'agent/ping'
        })

        const loggedLines = logSpy.mock.calls.map((call) => String(call[0]))
        expect(loggedLines.some((line) => line.includes('Received RPC message'))).toBe(true)
        expect(loggedLines.some((line) => line.includes('<< Notification: agent/ping'))).toBe(true)
      } finally {
        if (originalValue === undefined) {
          delete process.env.LOG_LEVEL
        } else {
          process.env.LOG_LEVEL = originalValue
        }
      }
    })

    it('suppresses per-chunk assistant logs by default', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      adapterPrivate(adapter).convertAcpEventToMessageParts(
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' }
            }
          }
        },
        new Set<string>(),
        new Set<string>(),
        new Map<string, string>()
      )

      const loggedLines = logSpy.mock.calls.map((call) => String(call[0]))
      expect(loggedLines.some((line) => line.includes('agent_message_chunk: turnId='))).toBe(false)
    })
  })

  describe('getAllMessages turn state isolation', () => {
    /**
     * When getAllMessages() is called from replayMissedTranscriptPartsBeforeIdle
     * after a follow-up response, the session's turn counters have already
     * advanced. If getAllMessages() processes permanent messages with that
     * advanced state, historical events get different turn-based IDs
     * (e.g. agent-response-5 instead of agent-response-1), bypassing
     * seenPartIds dedup and causing every old message to reappear.
     */
    it('getAllMessages produces stable IDs regardless of current session turn state', async () => {
      const session = createMockSession('test-session')
      adapterPrivate(adapter).sessions.set('test-session', session)

      const historyEvents = [
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello from history' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              kind: 'exec_command',
              status: 'in_progress',
              rawInput: { command: 'ls' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              kind: 'exec_command',
              status: 'completed',
              rawOutput: { stdout: 'file.txt' }
            }
          }
        },
        {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'After tool call' }
            }
          }
        }
      ]

      session.permanentMessages.push(...historyEvents)

      // First call: session is fresh (like during resumeSession)
      const firstResult = await adapter.getAllMessages('test-session', {} as any)
      const firstPartIds = firstResult.flatMap(m => m.parts.map(p => p.id))

      // Now simulate what happens after a follow-up: advance turn state
      // as if the agent had already responded to a second prompt
      session.currentTurnId = 5
      session.activeTurnId = 5
      session.currentUserTurnId = 2
      session.lastChunkTime = Date.now()
      session.lastSessionUpdateType = 'agent_message_chunk'
      session.pendingAssistantTurnSplit = true

      // Second call: session state is advanced (like during replayMissedTranscriptPartsBeforeIdle)
      const secondResult = await adapter.getAllMessages('test-session', {} as any)
      const secondPartIds = secondResult.flatMap(m => m.parts.map(p => p.id))

      expect(secondPartIds).toEqual(firstPartIds)
    })

    it('getAllMessages restores session turn state after processing', async () => {
      const session = createMockSession('test-session')
      adapterPrivate(adapter).sessions.set('test-session', session)

      session.permanentMessages.push({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Test message' }
          }
        }
      })

      session.currentTurnId = 7
      session.activeTurnId = 7
      session.currentUserTurnId = 3
      session.pendingAssistantTurnSplit = true
      session.lastSessionUpdateType = 'tool_call'

      await adapter.getAllMessages('test-session', {} as any)

      expect(session.currentTurnId).toBe(7)
      expect(session.activeTurnId).toBe(7)
      expect(session.currentUserTurnId).toBe(3)
      expect(session.pendingAssistantTurnSplit).toBe(true)
      expect(session.lastSessionUpdateType).toBe('tool_call')
    })
  })

  describe('agent_message dedup with streaming chunks', () => {
    it('should not duplicate when agent_message arrives after chunks for the same turn (no messageId)', () => {
      // Regression: agent_message with null messageId used randomUUID(),
      // bypassing seenPartIds and creating a duplicate message.
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.currentTurnId = 0
      session.activeTurnId = null
      session.lastSessionUpdateType = null
      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello ' }
          }
        }
      }

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world!' }
          }
        }
      }

      const parts1 = priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)
      session.lastSessionUpdateType = 'agent_message_chunk'
      const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

      expect(parts1).toHaveLength(1)
      expect(parts2).toHaveLength(1)
      expect(parts2[0].text).toBe('Hello world!')
      expect(parts2[0].id).toBe('agent-response-1')

      session.lastSessionUpdateType = 'agent_message_chunk'
      const finalMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message',
            messageId: null,
            content: { type: 'text', text: 'Hello world!' }
          }
        }
      }

      const finalParts = priv.convertAcpEventToMessageParts(finalMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(finalParts).toHaveLength(0)
    })

    it('should merge overlapping assistant chunks without repeating the shared boundary text', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'The matching UI' }
          }
        }
      }

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'matching UI looks like the transcript' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)
      const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

      expect(parts2).toHaveLength(1)
      expect(parts2[0].text).toBe('The matching UI looks like the transcript')
      expect(parts2[0].text).not.toContain('matching UImatching UI')
    })

    it('should handle cumulative assistant chunks by keeping the latest full text', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Error: streaming' }
          }
        }
      }

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Error: streaming failed after timeout' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)
      const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

      expect(parts2).toHaveLength(1)
      expect(parts2[0].text).toBe('Error: streaming failed after timeout')
    })

    it('should merge replayed assistant chunks that restart after the first character', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk1 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: "I'll use the pr-heartbeat-check workflow for this"
            }
          }
        }
      }

      const chunk2 = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: "'ll use the pr-heartbeat-check workflow for this, scoped to PR #380"
            }
          }
        }
      }

      priv.convertAcpEventToMessageParts(chunk1, new Set(), seenPartIds, partContentLengths, session)
      const parts2 = priv.convertAcpEventToMessageParts(chunk2, new Set(), seenPartIds, partContentLengths, session)

      expect(parts2).toHaveLength(1)
      expect(parts2[0].text).toBe("I'll use the pr-heartbeat-check workflow for this, scoped to PR #380")
      expect(parts2[0].text).not.toContain("workflow for this'll use")
    })

    it('should consolidate permanent history with overlap-aware chunk merging', async () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      priv.sessions.set(sessionId, session)

      priv.handleRpcMessage(session, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'some errors are shown' }
          }
        }
      })

      priv.handleRpcMessage(session, {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'errors are shown 3 times' }
          }
        }
      })

      expect(session.permanentMessages).toHaveLength(1)

      const messages = await adapter.getAllMessages(sessionId, {} as never)
      const text = messages.flatMap((message) => message.parts).map((part) => part.text).join('')

      expect(text).toBe('some errors are shown 3 times')
      expect(text).not.toContain('errors are shownerrors are shown')
    })

    it('should update existing entry when agent_message has more complete text than chunks', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.currentTurnId = 0
      session.activeTurnId = null
      session.lastSessionUpdateType = null
      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const chunk = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Partial' }
          }
        }
      }

      priv.convertAcpEventToMessageParts(chunk, new Set(), seenPartIds, partContentLengths, session)
      session.lastSessionUpdateType = 'agent_message_chunk'

      const finalMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message',
            messageId: null,
            content: { type: 'text', text: 'Partial response with full details here.' }
          }
        }
      }

      const finalParts = priv.convertAcpEventToMessageParts(finalMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(finalParts).toHaveLength(1)
      expect(finalParts[0].text).toBe('Partial response with full details here.')
      expect(finalParts[0].update).toBe(true)
      expect(finalParts[0].id).toBe('agent-response-1')
    })

    it('should still create new entries for agent_message with a stable messageId', () => {
      const sessionId = 'test-session'
      const priv = adapterPrivate(adapter)
      const session = createMockSession(sessionId)
      session.currentTurnId = 0
      session.activeTurnId = null
      session.lastSessionUpdateType = null
      priv.sessions.set(sessionId, session)

      const seenPartIds = new Set<string>()
      const partContentLengths = new Map<string, string>()

      const agentMessage = {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message',
            messageId: 'stable-id-from-backend',
            content: { type: 'text', text: 'A complete response.' }
          }
        }
      }

      const parts = priv.convertAcpEventToMessageParts(agentMessage, new Set(), seenPartIds, partContentLengths, session)

      expect(parts).toHaveLength(1)
      expect(parts[0].id).toBe('stable-id-from-backend')
      expect(parts[0].text).toBe('A complete response.')
    })
  })
})

// ─── Regression: live buffer / permanent history aliasing (scrambled message start) ───
//
// handleRpcMessage() pushes each notification object into BOTH session.messageBuffer
// (live polling) and session.permanentMessages (resume history). addToPermanentMessages()
// consolidates consecutive assistant chunks by MUTATING content.text on the last stored
// event — which, without a defensive copy, is the SAME object still sitting un-polled in
// messageBuffer. When several delta chunks arrive between polls (always the case at the
// start of a response: the first token burst lands before the first poll cycle), the first
// buffered chunk silently becomes the full accumulated text while the following buffered
// chunks stay raw deltas. pollMessages() then re-appends those middle deltas after the
// already-complete text, scrambling the beginning of the message
// ("Hello world, how world, how" style).
describe('AcpAdapter - live buffer vs permanent history aliasing', () => {
  let adapter: AcpAdapter

  beforeEach(() => {
    adapter = new AcpAdapter()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function chunkNotification(sessionId: string, text: string): unknown {
    return {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text }
        }
      }
    }
  }

  it('does not scramble the message start when several delta chunks arrive before the first poll', async () => {
    const sessionId = 'burst-session'
    const priv = adapterPrivate(adapter)
    const session = createMockSession(sessionId)
    priv.sessions.set(sessionId, session)

    // A burst of small delta chunks arrives on stdout before the polling
    // loop gets a chance to run (typical at the START of every response).
    priv.handleRpcMessage(session, chunkNotification(sessionId, 'Hello'))
    priv.handleRpcMessage(session, chunkNotification(sessionId, ' world'))
    priv.handleRpcMessage(session, chunkNotification(sessionId, ', how are you?'))

    const parts = await adapter.pollMessages(sessionId, new Set(), new Set(), new Map(), {} as never)

    expect(parts.length).toBeGreaterThan(0)
    const finalText = parts[parts.length - 1]?.text
    expect(finalText).toBe('Hello world, how are you?')
  })

  it('does not scramble longer delta bursts with short middle chunks', async () => {
    const sessionId = 'burst-session-2'
    const priv = adapterPrivate(adapter)
    const session = createMockSession(sessionId)
    priv.sessions.set(sessionId, session)

    const deltas = ['I', "'ll", ' check', ' the', ' logs', ' and', ' reproduce', ' the issue now.']
    for (const delta of deltas) {
      priv.handleRpcMessage(session, chunkNotification(sessionId, delta))
    }

    const parts = await adapter.pollMessages(sessionId, new Set(), new Set(), new Map(), {} as never)

    const finalText = parts[parts.length - 1]?.text
    expect(finalText).toBe("I'll check the logs and reproduce the issue now.")
  })

  it('keeps un-polled live chunks pristine when permanent history consolidates them', () => {
    const sessionId = 'pristine-session'
    const priv = adapterPrivate(adapter)
    const session = createMockSession(sessionId)
    priv.sessions.set(sessionId, session)

    priv.handleRpcMessage(session, chunkNotification(sessionId, 'Hello'))
    priv.handleRpcMessage(session, chunkNotification(sessionId, ' world'))

    // Permanent history consolidates into one event…
    expect(session.permanentMessages).toHaveLength(1)
    const permText = (session.permanentMessages[0] as { params: { update: { content: { text: string } } } })
      .params.update.content.text
    expect(permText).toBe('Hello world')

    // …but the live buffer must still hold the ORIGINAL raw deltas.
    const bufferTexts = session.messageBuffer.map((e) =>
      (e as { params: { update: { content: { text: string } } } }).params.update.content.text
    )
    expect(bufferTexts).toEqual(['Hello', ' world'])
  })

  it('does not truncate live tool output when capping permanent history', () => {
    const sessionId = 'truncate-session'
    const priv = adapterPrivate(adapter)
    const session = createMockSession(sessionId)
    priv.sessions.set(sessionId, session)

    const bigOutput = 'x'.repeat(150_000)
    priv.handleRpcMessage(session, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-big',
          status: 'completed',
          rawOutput: { stdout: bigOutput }
        }
      }
    })

    // Permanent history is capped at 100KB per tool output…
    const permStdout = (session.permanentMessages[0] as { params: { update: { rawOutput: { stdout: string } } } })
      .params.update.rawOutput.stdout
    expect(permStdout.length).toBeLessThan(bigOutput.length)
    expect(permStdout).toContain('truncated in history')

    // …but the live buffer must still carry the FULL output to the UI.
    const liveStdout = (session.messageBuffer[0] as { params: { update: { rawOutput: { stdout: string } } } })
      .params.update.rawOutput.stdout
    expect(liveStdout).toBe(bigOutput)
  })
})

describe('AcpAdapter - destroySession', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function fakeProcess(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
    const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> }
    child.kill = vi.fn(() => true)
    return child
  }

  it('rejects in-flight requests at once instead of leaving them on the RPC timeout', async () => {
    const adapter = new AcpAdapter()
    const session = createMockSession('destroy-session')
    session.process = fakeProcess()
    const inFlight = new Promise((resolve, reject) => session.pendingRequests.set(1, { resolve, reject }))
    adapterPrivate(adapter).sessions.set('destroy-session', session)

    await adapter.destroySession('destroy-session', {} as never)

    await expect(inFlight).rejects.toThrow('destroyed')
    expect(session.pendingRequests.size).toBe(0)
  })

  it('escalates to SIGKILL only when the process has not exited after the grace period', async () => {
    vi.useFakeTimers()
    const adapter = new AcpAdapter()
    const exiting = createMockSession('exits')
    const wedged = createMockSession('wedged')
    const exitingProcess = fakeProcess()
    const wedgedProcess = fakeProcess()
    exiting.process = exitingProcess
    wedged.process = wedgedProcess
    adapterPrivate(adapter).sessions.set('exits', exiting)
    adapterPrivate(adapter).sessions.set('wedged', wedged)

    await adapter.destroySession('exits', {} as never)
    await adapter.destroySession('wedged', {} as never)
    exitingProcess.emit('exit', null, 'SIGTERM')
    vi.advanceTimersByTime(1000)

    expect(exitingProcess.kill.mock.calls).toEqual([['SIGTERM']])
    expect(wedgedProcess.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })
})

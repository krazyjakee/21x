import { vi, type Mock } from 'vitest'
import {
  SessionStatusType,
  type CodingAgentAdapter,
  type MessagePart,
  type SessionConfig,
  type SessionMessage,
  type SessionStatus
} from '../../src/main/adapters/coding-agent-adapter'

export interface FakeAdapterOptions {
  /** Ids handed out by createSession, in order. Defaults to fake-session-1, -2, ... */
  sessionIds?: string[]
  /** Status the poller sees until setStatus() changes it. Defaults to BUSY. */
  status?: SessionStatusType
  /** Handle permission prompts (respondToApproval), like the ACP and OpenCode adapters. Default true. */
  approvals?: boolean
  /** Handle questions (respondToQuestion). Default false. */
  questions?: boolean
}

/**
 * In-memory coding agent backend for driving AgentManager through its public
 * session API (startSession, sendMessage, abortSession, stopSession, ...)
 * instead of reaching into private members.
 *
 * Tests queue the parts the next poll returns and set the status the poller
 * sees. Every adapter method is a vi.fn, so calls can be asserted on.
 *
 * Wire it in through the normal adapter factory, e.g. by making the mocked
 * ClaudeCodeAdapter constructor return the fake, so AgentManager resolves it
 * the same way it resolves a real backend.
 */
export class FakeAdapter implements CodingAgentAdapter {
  private readonly sessionIds: string[]
  private created = 0
  private queue: MessagePart[] = []
  private status: SessionStatus
  private history: SessionMessage[] = []

  /** Set by AgentManager when the session is registered for polling. */
  onDataAvailable?: (sessionId: string) => void

  readonly initialize = vi.fn(async (): Promise<void> => undefined)

  readonly createSession = vi.fn(async (_config: SessionConfig): Promise<string> => {
    const id = this.sessionIds[this.created] ?? `fake-session-${this.created + 1}`
    this.created += 1
    return id
  })

  readonly resumeSession = vi.fn(
    async (_sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> => this.history
  )

  readonly sendPrompt = vi.fn(
    async (_sessionId: string, _parts: MessagePart[], _config: SessionConfig): Promise<void> => undefined
  )

  readonly getStatus = vi.fn(
    async (_sessionId: string, _config: SessionConfig): Promise<SessionStatus> => this.status
  )

  readonly pollMessages = vi.fn(
    async (
      _sessionId: string,
      _seenMessageIds: Set<string>,
      _seenPartIds: Set<string>,
      _partContentLengths: Map<string, string>,
      _config: SessionConfig
    ): Promise<MessagePart[]> => {
      const parts = this.queue
      this.queue = []
      return parts
    }
  )

  readonly abortPrompt = vi.fn(async (_sessionId: string, _config: SessionConfig): Promise<void> => undefined)

  readonly destroySession = vi.fn(async (_sessionId: string, _config: SessionConfig): Promise<void> => undefined)

  readonly registerMcpServer = vi.fn(async (): Promise<void> => undefined)

  readonly checkHealth = vi.fn(async (): Promise<{ available: boolean; reason?: string }> => ({ available: true }))

  /** Present when the adapter handles permission prompts (see options.approvals). */
  respondToApproval?: Mock<(sessionId: string, approved: boolean, optionId?: string, requestId?: string) => Promise<boolean>>

  /** Present when the adapter handles questions (see options.questions). */
  respondToQuestion?: Mock<
    (sessionId: string, answers: Record<string, string>, config: SessionConfig, requestId?: string) => Promise<boolean>
  >

  constructor(options: FakeAdapterOptions = {}) {
    this.sessionIds = options.sessionIds ?? []
    this.status = { type: options.status ?? SessionStatusType.BUSY }
    if (options.approvals ?? true) {
      this.respondToApproval = vi.fn(async () => true)
    }
    if (options.questions) {
      this.respondToQuestion = vi.fn(async () => true)
    }
  }

  /** Parts returned by the next pollMessages call. */
  enqueueParts(...parts: MessagePart[]): void {
    this.queue.push(...parts)
  }

  /** Status reported by getStatus from now on. */
  setStatus(type: SessionStatusType, message?: string): void {
    this.status = message === undefined ? { type } : { type, message }
  }

  /** History returned by resumeSession. */
  setHistory(messages: SessionMessage[]): void {
    this.history = messages
  }

  /** Signals buffered data the way a real adapter does, which wakes the poller. */
  signalData(sessionId: string): void {
    this.onDataAvailable?.(sessionId)
  }
}

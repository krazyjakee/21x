import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  MessagePartType, MessageRole, SessionStatusType,
  type CodingAgentAdapter, type MessagePart, type SessionConfig, type SessionMessage
} from '../../main/adapters/coding-agent-adapter'

const SESSION_ID = 'synthetic-fixture-session-1'
interface State {
  version: 1
  taskId: string | null
  agentId: string | null
  nextRequest: number
  history: SessionMessage[]
  decisions: Array<{ requestId: string; approved: boolean }>
}

/** Test backend only. It never calls a model, tool, shell, browser or secret API. */
export class DeterministicAgentAdapter implements CodingAgentAdapter {
  onDataAvailable?: (sessionId: string) => void
  private readonly file: string
  private state: State = { version: 1, taskId: null, agentId: null, nextRequest: 1, history: [], decisions: [] }
  private queue: MessagePart[] = []
  private pendingRequest: string | null = null
  private status = SessionStatusType.IDLE
  public resumes = 0
  public destroyed = 0

  constructor(options: { fixtureMode: 'synthetic-only'; profileRoot: string }) {
    if (options.fixtureMode !== 'synthetic-only' || !isAbsolute(options.profileRoot)) throw new Error('Explicit synthetic fixture profile required')
    this.file = join(options.profileRoot, 'deterministic-agent-backend.json')
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 65_536) throw new Error('Fixture backend state exceeds its bound')
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as State
      if (state.version !== 1 || !Number.isSafeInteger(state.nextRequest) || state.nextRequest < 1 || state.nextRequest > 33 ||
          typeof state.taskId !== 'string' || typeof state.agentId !== 'string' || !state.taskId || !state.agentId ||
          !Array.isArray(state.history) || state.history.length > 96 || !Array.isArray(state.decisions) || state.decisions.length > 32) {
        throw new Error('Invalid fixture backend state')
      }
      this.state = state
    }
  }

  private verifySession(sessionId: string, config?: SessionConfig): void {
    if (sessionId !== SESSION_ID) throw new Error('Unknown fixture session')
    if (config && (config.taskId !== this.state.taskId || config.agentId !== this.state.agentId)) throw new Error('Fixture session identity mismatch')
  }

  private save(): void {
    const encoded = JSON.stringify(this.state)
    if (Buffer.byteLength(encoded) > 65_536) throw new Error('Fixture backend state exceeds its bound')
    writeFileSync(this.file, encoded, { mode: 0o600 })
  }

  private emit(...parts: MessagePart[]): void {
    for (const part of parts) {
      const id = `fixture-message-${part.id}`
      const existing = this.state.history.find(message => message.id === id)
      const message = { id, role: MessageRole.ASSISTANT, parts: [part] }
      if (existing) Object.assign(existing, message)
      else this.state.history.push(message)
      this.queue.push(structuredClone(part))
    }
    this.save()
    this.onDataAvailable?.(SESSION_ID)
  }

  async initialize(): Promise<void> {}
  async checkHealth(): Promise<{ available: boolean }> { return { available: true } }
  async createSession(config: SessionConfig): Promise<string> {
    if (this.state.taskId !== null || !config.taskId || !config.agentId) throw new Error('Fixture supports one persisted conversation')
    this.state.taskId = config.taskId
    this.state.agentId = config.agentId
    this.save()
    return SESSION_ID
  }
  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    this.verifySession(sessionId, config)
    this.resumes++
    // A persisted conversation is resumable; provider callbacks are not.
    this.pendingRequest = null
    this.status = SessionStatusType.IDLE
    return structuredClone(this.state.history)
  }
  async getAllMessages(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    this.verifySession(sessionId, config)
    return structuredClone(this.state.history)
  }
  async sendPrompt(sessionId: string, _parts: MessagePart[], config: SessionConfig): Promise<void> {
    this.verifySession(sessionId, config)
    if (this.pendingRequest || this.state.nextRequest > 32) throw new Error('Fixture turn is unavailable')
    if (Object.keys(config.mcpServers ?? {}).length || Object.values(config.apiKeys ?? {}).some(Boolean) ||
        config.secretSessionToken || Object.keys(config.secretEnvVars ?? {}).length) throw new Error('Native credentials/tools are forbidden in this fixture')
    const requestId = `fixture-approval-${this.state.nextRequest++}`
    this.pendingRequest = requestId
    this.status = SessionStatusType.WAITING_APPROVAL
    this.emit(
      { id: `planning-${requestId}`, type: MessagePartType.TEXT, content: `Planning synthetic change ${requestId}.` },
      { id: `question-${requestId}`, type: MessagePartType.QUESTION, content: 'Allow the synthetic change?',
        tool: { name: 'permission', status: 'running', requestId,
          questions: [{ header: 'Fixture permission', question: 'Allow the synthetic change?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }
    )
  }
  async getStatus(sessionId: string, config: SessionConfig) {
    this.verifySession(sessionId, config)
    return { type: this.status }
  }
  async pollMessages(sessionId: string, _seen: Set<string>, _parts: Set<string>, _lengths: Map<string, string>, config: SessionConfig): Promise<MessagePart[]> {
    this.verifySession(sessionId, config)
    const parts = this.queue
    this.queue = []
    return parts
  }
  async respondToApproval(sessionId: string, approved: boolean, _optionId?: string, requestId?: string): Promise<boolean> {
    this.verifySession(sessionId)
    if (!requestId || requestId !== this.pendingRequest) return false
    this.pendingRequest = null
    this.state.decisions.push({ requestId, approved })
    this.status = SessionStatusType.IDLE
    this.emit(
      { id: `question-${requestId}`, type: MessagePartType.QUESTION, content: approved ? 'Synthetic change approved.' : 'Synthetic change rejected.',
        tool: { name: 'permission', status: approved ? 'completed' : 'cancelled', requestId }, update: true },
      { id: `result-${requestId}`, type: MessagePartType.TEXT, content: approved ? 'Applied the approved synthetic change.' : 'Did not apply the rejected synthetic change.' }
    )
    return true
  }
  async abortPrompt(sessionId: string, config: SessionConfig): Promise<void> {
    this.verifySession(sessionId, config)
    this.pendingRequest = null
    this.status = SessionStatusType.IDLE
  }
  async destroySession(sessionId: string, config: SessionConfig): Promise<void> {
    await this.abortPrompt(sessionId, config)
    this.queue = []
    this.destroyed++
  }
  decisions(): State['decisions'] { return structuredClone(this.state.decisions) }
}

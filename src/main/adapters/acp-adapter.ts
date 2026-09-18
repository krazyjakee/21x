/**
 * Unified ACP (Agent Client Protocol) adapter for all ACP-compatible coding agents.
 * Supports: codex-acp and cursor-agent.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)
 * Spec: https://github.com/agentclientprotocol/typescript-sdk
 */

import { CLIENT_NAME } from '../app-identity'
import { spawn, ChildProcess } from 'child_process'
import { guardChildStreams } from '../child-stream-guards'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionMessage,
  SessionStatus,
  MessagePart
} from './coding-agent-adapter'
import { SessionStatusType } from './coding-agent-adapter'
import {
  acpModelValue,
  applyCursorAuthEnv,
  convertAcpMcpServers,
  getAcpAgentConfig,
  pickAcpAuthMethod,
  type AcpAgentConfig,
  type AcpAgentType
} from './acp-agent-config'
import {
  convertAcpEventToMessageParts,
  extractTextFromUpdateContent,
  isAssistantChunkUpdateType,
  mergeStreamingText,
  type AcpTurnState,
  type SessionUpdate
} from './acp-event-converter'
import { applyCodexAuthEnv } from './shared/codex-auth'
import { execFileAsync } from '../find-executable'
import {
  sendJsonRpcRequest,
  writeJsonRpc,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcPeer,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './shared/json-rpc'
import { onJsonLines } from './shared/jsonl'
import { groupPartsIntoMessages } from './shared/session-messages'

interface AcpPermissionRequest {
  requestId: string | number
  toolCallId: string
  question: string
  options: Array<{
    optionId: string
    name: string
    kind: string
  }>
}

interface AcpSession extends AcpTurnState, JsonRpcPeer {
  /** Our internal session ID */
  sessionId: string
  /** ACP protocol session ID */
  acpSessionId: string | null
  process: ChildProcess
  status: SessionStatusType
  /** Buffered ACP events (cleared after poll) */
  messageBuffer: unknown[]
  /** All messages (never cleared, replayed by getAllMessages) */
  permanentMessages: unknown[]
  /** Permission request awaiting user response */
  pendingApproval: AcpPermissionRequest | null
  config: SessionConfig
  /** ID of the current session/prompt request */
  promptRequestId: number | null
  /** Last error (e.g. quota exceeded) for status reporting */
  lastError: string | null
  /** True when Codex auth uses an API key (vs. ChatGPT subscription / CLI login) */
  codexUseApiKey: boolean
  /** Auth identity used, surfaced in provider errors for diagnostics */
  codexAuthSummary: string
  /**
   * System prompt still to deliver. ACP's session/new has no system-prompt
   * field, so it rides along with the first prompt of a new session.
   */
  pendingSystemPrompt?: string
}

/**
 * Maximum number of raw JSON-RPC messages kept for replay on resume. 1,000
 * events cover ~50-100 turns; each event can be multi-KB (tool outputs).
 */
const MAX_PERMANENT_MESSAGES = 1000
const MAX_HISTORY_OUTPUT_CHARS = 100_000

/** Prefixes the first prompt of a session with its system prompt, fenced so the agent can tell them apart. */
export function withSystemPrompt(systemPrompt: string | undefined, promptText: string): string {
  if (!systemPrompt) return promptText
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${promptText}`
}

export class AcpAdapter implements CodingAgentAdapter {
  private agentType: AcpAgentType
  private agentConfig: AcpAgentConfig
  private sessions = new Map<string, AcpSession>()
  private debugRpcLogs: boolean

  /** Callback set by agent-manager to trigger an immediate poll cycle */
  onDataAvailable?: (sessionId: string) => void

  constructor(agentType: AcpAgentType) {
    this.agentType = agentType
    this.agentConfig = getAcpAgentConfig(agentType)
    const logLevel = process.env.LOG_LEVEL?.trim().toLowerCase()
    this.debugRpcLogs = logLevel === 'debug' || logLevel === 'trace'
  }

  private get label(): string {
    return `AcpAdapter/${this.agentType}`
  }

  /** Returns true when Codex uses API-key auth; see applyCodexAuthEnv. */
  private configureCodexAuthEnv(env: Record<string, string | undefined>, config: SessionConfig): boolean {
    if (this.agentType !== 'codex') return false
    const { usesApiKey, summary } = applyCodexAuthEnv(env, config)
    console.log(`[${this.label}] Auth: ${summary}`)
    return usesApiKey
  }

  private configureCursorAuthEnv(env: Record<string, string | undefined>, config: SessionConfig): void {
    if (this.agentType === 'cursor') applyCursorAuthEnv(env, config)
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth()
    if (!health.available) {
      throw new Error(health.reason || 'ACP agent not available')
    }
    console.log(`[${this.label}] Initialized successfully`)
  }

  private async authenticateSession(session: AcpSession, initResult: unknown): Promise<void> {
    const initObj = initResult as Record<string, unknown> | undefined
    const authMethods = (Array.isArray(initObj?.authMethods) ? initObj.authMethods : []) as Array<{ id: string; [key: string]: unknown }>

    if (authMethods.length === 0) {
      console.log(`[${this.label}] No auth methods advertised by agent (already authenticated); codexUseApiKey=${session.codexUseApiKey}`)
      return
    }

    // Use the auth mode decided in configureCodexAuthEnv() rather than sniffing
    // env vars: an ambient OPENAI_API_KEY must not flip a subscription user into
    // API-key auth.
    const authMethod = pickAcpAuthMethod(this.agentType, authMethods, session.codexUseApiKey)
    console.log(`[${this.label}] Available auth methods: [${authMethods.map((m) => m.id).join(', ')}]; codexUseApiKey=${session.codexUseApiKey}`)

    if (!authMethod) {
      console.log(`[${this.label}] No usable auth method found; skipping authenticate`)
      return
    }

    // No `logout` first: with an API key, CODEX_HOME is a per-session temp
    // directory, so there are no stale disk credentials and keys can differ
    // per session.
    console.log(`[${this.label}] Authenticating with method: ${authMethod.id}`)
    session.codexAuthSummary = `${session.codexUseApiKey ? 'API key' : 'subscription'} via authenticate(${authMethod.id})`
    await this.sendRpcRequest(session, 'authenticate', { methodId: authMethod.id })
  }

  /**
   * Spawns the agent process, registers the session under `sessionId`, and runs
   * the ACP initialize + authenticate handshake.
   */
  private async startSession(sessionId: string, acpSessionId: string | null, config: SessionConfig): Promise<AcpSession> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.agentConfig.env,
      ...(config.apiKeys?.anthropic ? { ANTHROPIC_API_KEY: config.apiKeys.anthropic } : {}),
      ...config.secretEnvVars
    }

    // Auth is decided LAST so it is authoritative over injected secrets.
    const codexUseApiKey = this.configureCodexAuthEnv(env, config)
    this.configureCursorAuthEnv(env, config)
    const codexAuthSummary = this.agentType === 'codex'
      ? `${codexUseApiKey ? 'API key' : 'subscription'} (authMethod=${config.authMethod ?? 'legacy'}, CODEX_HOME=${env.CODEX_HOME ?? 'default'})`
      : ''

    // On Windows, .cmd/.bat wrappers need shell:true to resolve
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.agentConfig.command)
    const acpProcess = spawn(this.agentConfig.command, this.agentConfig.args, {
      cwd: config.workspaceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(needsShell ? { shell: true } : {})
    })

    // Every pipe needs an error listener before the first write. The agent can
    // exit at any moment, and an unhandled EPIPE on its stdin takes the whole
    // main process down with a crash dialog.
    guardChildStreams(acpProcess, this.label)

    const session: AcpSession = {
      sessionId,
      acpSessionId,
      process: acpProcess,
      status: SessionStatusType.IDLE,
      messageBuffer: [],
      permanentMessages: [],
      pendingRequests: new Map(),
      nextRequestId: 1,
      pendingApproval: null,
      config,
      promptRequestId: null,
      currentUserTurnId: 0,
      lastChunkTime: null,
      currentTurnId: 0,
      lastSessionUpdateType: null,
      activeTurnId: null,
      pendingAssistantTurnSplit: false,
      toolCallMetadata: new Map(),
      lastError: null,
      codexUseApiKey,
      codexAuthSummary
    }
    this.sessions.set(sessionId, session)

    onJsonLines(acpProcess.stdout, (line) => {
      try {
        this.handleRpcMessage(session, JSON.parse(line) as JsonRpcMessage)
      } catch (error) {
        console.error(`[${this.label}] Failed to parse JSON-RPC message:`, line, error)
      }
    })
    acpProcess.stderr?.on('data', (chunk: Buffer) => {
      console.log(`[${this.label}] stderr:`, chunk.toString())
    })
    acpProcess.on('exit', (code, signal) => {
      console.log(`[${this.label}] Process exited: code=${code}, signal=${signal}`)
      session.status = code === 0 ? SessionStatusType.IDLE : SessionStatusType.ERROR
    })

    const initResult = await this.sendRpcRequest(session, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: {
        name: CLIENT_NAME,
        version: '0.0.1'
      }
    })
    await this.authenticateSession(session, initResult)
    return session
  }

  /** Applies an optional session config option; the agent keeps its default on failure. */
  private async setConfigOption(session: AcpSession, configId: string, value: string): Promise<void> {
    try {
      await this.sendRpcRequest(session, 'session/set_config_option', {
        sessionId: session.acpSessionId,
        configId,
        value
      })
      console.log(`[${this.label}] ${configId} set to: ${value}`)
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.warn(`[${this.label}] Failed to set ${configId}: ${errMsg}`)
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.taskId
    console.log(`[${this.label}] Creating session ${sessionId}`)

    const session = await this.startSession(sessionId, null, config)

    // session/new only accepts cwd and mcpServers per the ACP spec.
    const mcpServers = convertAcpMcpServers(config.mcpServers)
    console.log(`[${this.label}] session/new mcpServers:`, JSON.stringify(mcpServers))
    const result = await this.sendRpcRequest(session, 'session/new', {
      cwd: config.workspaceDir,
      mcpServers
    })

    const acpSessionId = this.extractAcpSessionId(result)
    if (config.systemPrompt?.trim()) session.pendingSystemPrompt = config.systemPrompt.trim()
    if (acpSessionId) {
      session.acpSessionId = acpSessionId
      this.sessions.delete(sessionId)
      this.sessions.set(acpSessionId, session)

      if (config.model) {
        await this.setConfigOption(session, 'model', acpModelValue(this.agentType, config.model))
      }
      if (config.reasoningEffort && config.reasoningEffort !== 'max') {
        await this.setConfigOption(session, 'model_reasoning_effort', config.reasoningEffort)
      }
    }

    console.log(`[${this.label}] Session created: ${sessionId} (ACP: ${acpSessionId})`)
    // The ACP session ID is persisted and used for resuming.
    return acpSessionId || sessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    console.log(`[${this.label}] Resuming session ${sessionId}`)

    // sessionId is the ACP session ID returned by createSession.
    const session = await this.startSession(sessionId, sessionId, config)

    try {
      await this.sendRpcRequest(session, 'session/load', {
        sessionId,
        cwd: config.workspaceDir,
        mcpServers: convertAcpMcpServers(config.mcpServers)
      })
      console.log(`[${this.label}] Session loaded successfully: ${sessionId}`)

      // Notifications replayed during session/load become the returned history.
      // Without this, the renderer sees status:'idle' + messages:[] and hides the panel.
      const messages = await this.getAllMessages(sessionId, config)

      // Drain the replay from the live poll buffer, or the first poll after
      // resume would emit the whole old transcript again.
      session.messageBuffer = []
      return messages
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('not found') || errMsg.includes('does not exist')) {
        session.process.kill('SIGTERM')
        this.sessions.delete(sessionId)
        throw new Error(
          `INCOMPATIBLE_SESSION_ID: This ${this.agentType} session does not exist or has expired. Please start a new session.`
        )
      }
      throw error
    }
  }

  async sendPrompt(
    sessionId: string,
    parts: MessagePart[],
    _config: SessionConfig
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const promptText = parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in message parts')
    }

    console.log(`[${this.label}] Sending prompt to session ${sessionId} (${promptText.length} chars)`)

    // Clear stale buffered events from the previous turn. Notifications can
    // arrive between the last poll and idle detection; a fresh PollingEntry
    // (empty seenPartIds) would re-process them under a new turnId and
    // duplicate messages in the transcript.
    session.messageBuffer = []

    // Record the prompt in permanent history: during session/load the agent may
    // not echo user_message_chunk events, so resume would otherwise show only
    // agent responses.
    this.addToPermanentMessages(session, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'user_message',
          content: { type: 'text', text: promptText },
          messageId: `user-prompt-${session.currentTurnId + 1}`
        }
      }
    })

    session.status = SessionStatusType.BUSY
    session.lastError = null
    session.currentTurnId++
    session.activeTurnId = session.currentTurnId
    session.lastChunkTime = null

    // session/prompt is long-running and reports progress via session/update
    // notifications, so it is not awaited (it would hit the RPC timeout). Its
    // response is matched through promptRequestId in handleRpcMessage.
    const id = session.nextRequestId++
    session.promptRequestId = id
    const failPrompt = (err: Error): void => {
      if (session.promptRequestId !== id) return
      session.promptRequestId = null
      session.status = SessionStatusType.ERROR
      session.lastError = `Failed to send prompt: ${err.message}`
    }
    // The transcript keeps the user's own text; only the wire copy carries
    // the system prompt, once, at the start of a new session.
    const wireText = withSystemPrompt(session.pendingSystemPrompt, promptText)
    session.pendingSystemPrompt = undefined
    const sent = writeJsonRpc(session, {
      jsonrpc: '2.0',
      id,
      method: 'session/prompt',
      params: {
        sessionId: session.acpSessionId,
        prompt: [{ type: 'text', text: wireText }]
      }
    }, this.label, failPrompt)
    if (!sent) failPrompt(new Error('agent process is not running'))
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { type: SessionStatusType.ERROR, message: 'Session not found' }
    }

    return {
      type: session.status,
      message: session.status === 'error' ? (session.lastError || 'Process error') : undefined
    }
  }

  async pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    _config: SessionConfig
  ): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    const newParts = session.messageBuffer.flatMap((event) =>
      this.convertAcpEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
    )
    session.messageBuffer = []
    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    console.log(`[${this.label}] Sending session/cancel for ${sessionId}`)

    // session/cancel is a notification. The agent answers the original
    // session/prompt with stopReason: cancelled, which settles the status.
    writeJsonRpc(session, {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: session.acpSessionId }
    }, this.label)
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    console.log(`[${this.label}] Destroying session ${sessionId}`)

    session.process.kill('SIGTERM')
    setTimeout(() => {
      if (!session.process.killed) {
        session.process.kill('SIGKILL')
      }
    }, 1000)

    // Eagerly clear large data structures to free memory immediately
    session.permanentMessages.length = 0
    session.messageBuffer.length = 0
    session.toolCallMetadata.clear()
    session.pendingRequests.clear()

    this.sessions.delete(sessionId)
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // convertAcpEventToMessageParts() mutates the turn counters. When this runs
    // after a follow-up response (replayMissedTranscriptPartsBeforeIdle), the
    // live state has already advanced; replaying history with it yields
    // different turn-based IDs (agent-response-5 instead of agent-response-1)
    // that bypass seenPartIds dedup and duplicate the whole transcript. Replay
    // from a zeroed state and restore the live state afterwards so IDs are
    // deterministic.
    const savedTurnState: AcpTurnState = {
      currentTurnId: session.currentTurnId,
      activeTurnId: session.activeTurnId,
      currentUserTurnId: session.currentUserTurnId,
      lastChunkTime: session.lastChunkTime,
      lastSessionUpdateType: session.lastSessionUpdateType,
      pendingAssistantTurnSplit: session.pendingAssistantTurnSplit,
      toolCallMetadata: new Map(session.toolCallMetadata),
    }
    Object.assign(session, {
      currentTurnId: 0,
      activeTurnId: null,
      currentUserTurnId: 0,
      lastChunkTime: null,
      lastSessionUpdateType: null,
      pendingAssistantTurnSplit: false,
      toolCallMetadata: new Map(),
    } satisfies AcpTurnState)

    const allParts: MessagePart[] = []
    for (const event of session.permanentMessages) {
      const parts = this.convertAcpEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
      // Preserve the original arrival time for replay timestamps.
      const receivedAt = (event as Record<string, unknown>)?._receivedAt as number | undefined
      for (const part of parts) {
        if (receivedAt) part.receivedAt = receivedAt
        allParts.push(part)
      }
    }

    Object.assign(session, savedTurnState)
    return groupPartsIntoMessages(allParts)
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    if (this.agentType === 'cursor') {
      try {
        await execFileAsync(this.agentConfig.command, ['--version'], {
          timeout: 10000,
          windowsHide: true,
          shell: process.platform === 'win32'
        })
        return { available: true }
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return { available: false, reason: `Cursor Agent CLI is unavailable. Install it and run cursor-agent login. (${errMsg})` }
      }
    }

    // API keys are not checked here: they can come from the agent's UI
    // configuration at session creation time.
    try {
      require.resolve('@agentclientprotocol/codex-acp/dist/index.js')
      return { available: true }
    } catch {
      return {
        available: false,
        reason: '@agentclientprotocol/codex-acp not found. Install with: pnpm add @agentclientprotocol/codex-acp'
      }
    }
  }

  getPendingApproval(sessionId: string): AcpPermissionRequest | null {
    const session = this.sessions.get(sessionId)
    return session?.pendingApproval || null
  }

  async respondToApproval(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.pendingApproval) {
      console.warn(`[${this.label}] No pending approval for session ${sessionId}`)
      return
    }

    const approval = session.pendingApproval
    let selectedOptionId = approval.options.some((option) => option.optionId === optionId)
      ? optionId
      : undefined
    if (!selectedOptionId) {
      selectedOptionId = approved
        ? approval.options.find((option) => option.optionId === 'allow-once')?.optionId || 'approved'
        : approval.options.find((option) => option.optionId === 'reject-once')?.optionId || 'abort'
    }

    console.log(`[${this.label}] Responding to approval with: ${selectedOptionId}`)

    // The ACP TypeScript SDK nests the outcome: { outcome: { outcome, optionId } }
    this.sendRpcResponse(session, approval.requestId, {
      result: {
        outcome: {
          outcome: 'selected',
          optionId: selectedOptionId
        }
      }
    })

    session.pendingApproval = null
  }

  private convertAcpEventToMessageParts(
    event: unknown,
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session?: AcpSession
  ): MessagePart[] {
    return convertAcpEventToMessageParts(event, seenPartIds, partContentLengths, session, this.debugRpcLogs)
  }

  private handleRpcMessage(session: AcpSession, message: JsonRpcMessage): void {
    if (this.debugRpcLogs) {
      console.log(`[${this.label}] Received RPC message:`, JSON.stringify(message))
    }

    // Responses to our requests
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const response = message as JsonRpcResponse
      const pending = session.pendingRequests.get(message.id)
      if (pending) {
        session.pendingRequests.delete(message.id)
        if (response.error) {
          const errorInfo = this.extractCodexErrorInfo(response.error)
          if (errorInfo) {
            this.handleQuotaError(session, errorInfo)
          }
          pending.reject(new Error(response.error.message))
        } else if ('result' in response) {
          pending.resolve(response.result)
        }
        return
      }

      // No pending request: e.g. an error for a permission response.
      if (response.error) {
        const errorInfo = this.extractCodexErrorInfo(response.error)
        if (errorInfo) {
          this.handleQuotaError(session, errorInfo)
          return
        }

        console.error(`[${this.label}] Unexpected error response:`, response.error)
        const errorEvent = {
          _isError: true,
          message: response.error.message,
          data: response.error.data
        }
        session.messageBuffer.push(errorEvent)
        this.addToPermanentMessages(session, errorEvent)
        this.onDataAvailable?.(session.sessionId)
        return
      }

      if (session.promptRequestId === message.id && 'result' in response) {
        const result = response.result as Record<string, unknown> | undefined
        if (result?.stopReason) {
          console.log(`[${this.label}] Prompt completed with stopReason: ${result.stopReason}`)
          session.status = SessionStatusType.IDLE
          session.activeTurnId = null
          // promptRequestId is kept for late-arriving events; the next prompt replaces it.
        }
        return
      }
    }

    // Requests from the agent (e.g. session/request_permission)
    if ('method' in message && 'id' in message && message.id !== undefined) {
      const request = message as JsonRpcRequest
      if (this.debugRpcLogs) {
        console.log(`[${this.label}] << Request: ${request.method}`)
      }

      if (request.method === 'session/request_permission') {
        this.handlePermissionRequest(session, request)
        return
      }

      if (this.agentType === 'cursor' && request.method === 'cursor/ask_question') {
        this.sendRpcResponse(session, request.id, {
          result: { outcome: { outcome: 'skipped', reason: 'Cursor questions are not supported by 20x yet' } }
        })
        return
      }

      if (this.agentType === 'cursor' && request.method === 'cursor/create_plan') {
        this.sendRpcResponse(session, request.id, {
          result: { outcome: { outcome: 'cancelled' } }
        })
        return
      }

      this.sendRpcResponse(session, request.id, {
        error: { code: -32601, message: `Method not found: ${request.method}` }
      })
      return
    }

    // Notifications. Turn detection happens at poll time (time gaps and tool
    // calls), so notifications are buffered as-is.
    if ('method' in message && !('id' in message)) {
      const notification = message as JsonRpcNotification

      if (this.debugRpcLogs) {
        console.log(`[${this.label}] << Notification: ${notification.method}`)
        if (notification.method === 'session/update') {
          const params = notification.params as { update?: SessionUpdate } | undefined
          console.log(`[${this.label}]    sessionUpdate: ${params?.update?.sessionUpdate}`)
        }
      }

      session.messageBuffer.push(notification)
      this.addToPermanentMessages(session, notification)
      this.onDataAvailable?.(session.sessionId)
      this.updateSessionStatus(session, notification)
    }
  }

  /**
   * Maps a Codex-specific RPC error to a user-facing message, or returns null
   * for generic errors that should be handled normally.
   */
  private extractCodexErrorInfo(error: JsonRpcError): {
    errorType: string
    userMessage: string
  } | null {
    const data = error.data as Record<string, unknown> | undefined
    if (!data?.codex_error_info) return null

    const errorType = String(data.codex_error_info)
    const providerMessage = typeof data.message === 'string' ? data.message : error.message

    switch (errorType) {
      case 'usage_limit_exceeded':
        return {
          errorType,
          userMessage: `Quota exceeded: ${providerMessage}. Please check your Codex plan and billing details to continue.`
        }
      case 'rate_limit_exceeded':
        return {
          errorType,
          userMessage: `Rate limit reached: ${providerMessage}. Please wait a moment before trying again.`
        }
      default:
        return {
          errorType,
          userMessage: `Codex error (${errorType}): ${providerMessage}`
        }
    }
  }

  private handleQuotaError(session: AcpSession, errorInfo: { errorType: string; userMessage: string }): void {
    // Include the auth identity 20x used, so it is visible whether the limit
    // came from the subscription or an API key.
    const authNote = session.codexAuthSummary ? ` [20x auth: ${session.codexAuthSummary}]` : ''
    const userMessage = `${errorInfo.userMessage}${authNote}`

    console.warn(`[${this.label}] Provider error (${errorInfo.errorType}):`, userMessage)

    session.status = SessionStatusType.ERROR
    session.lastError = userMessage
    session.activeTurnId = null

    // LIVE buffer only. Quota/rate-limit errors are transient; permanentMessages
    // is replayed on every resume, so persisting them would show a stale
    // "Quota exceeded" at the end of the transcript forever, even after the
    // limit resets. lastError is cleared by the next sendPrompt().
    session.messageBuffer.push({
      _isError: true,
      message: userMessage,
      data: null  // Don't expose raw error data for known error types
    })
    this.onDataAvailable?.(session.sessionId)
  }

  private updateSessionStatus(session: AcpSession, notification: JsonRpcNotification): void {
    if (notification.method === 'session/update') {
      const update = (notification.params as { update?: SessionUpdate } | undefined)?.update
      if (!update) return

      // Do NOT touch turn state here. This runs when notifications arrive, but
      // pollMessages processes events later in buffer order; changing turn state
      // now would leak future state into earlier events and split/duplicate
      // turns. Turn state belongs to convertAcpEventToMessageParts().
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        session.status = SessionStatusType.BUSY
      } else if (update.sessionUpdate === 'error' || update.sessionUpdate === 'failed') {
        session.status = SessionStatusType.ERROR
      } else if (update.sessionUpdate === 'completed' || update.sessionUpdate === 'finished') {
        session.status = SessionStatusType.IDLE
      }
    } else if (notification.method.includes('completed') || notification.method.includes('finished')) {
      session.status = SessionStatusType.IDLE
    } else if (notification.method.includes('error') || notification.method.includes('failed')) {
      session.status = SessionStatusType.ERROR
    } else if (notification.method.includes('started') || notification.method.includes('working')) {
      session.status = SessionStatusType.BUSY
    }
  }

  /**
   * Adds an event to the permanent history, consolidating consecutive chunks
   * and pruning by count to prevent OOM.
   *
   * Events are stored as deep clones. The incoming event is the SAME object
   * handleRpcMessage() queued in messageBuffer for live polling, and history
   * mutates stored events (chunk consolidation rewrites content.text; tool
   * outputs are truncated). Without cloning, a burst of chunks arriving before
   * the first poll had its first buffered chunk rewritten to the accumulated
   * text while later deltas stayed raw, and polling appended them again
   * ("Hello world, how are you? world, how are you?").
   */
  private addToPermanentMessages(session: AcpSession, event: unknown): void {
    const notification = event as JsonRpcNotification
    const lastMsg = session.permanentMessages[session.permanentMessages.length - 1] as JsonRpcNotification | undefined
    let consolidated = false

    if (lastMsg?.method === 'session/update' && notification.method === 'session/update') {
      const lastUpdate = (lastMsg.params as { update?: SessionUpdate } | undefined)?.update
      const nextUpdate = (notification.params as { update?: SessionUpdate } | undefined)?.update

      if (lastUpdate && nextUpdate && lastUpdate.sessionUpdate === nextUpdate.sessionUpdate && isAssistantChunkUpdateType(nextUpdate.sessionUpdate)) {
        const lastText = extractTextFromUpdateContent(lastUpdate.content)
        const nextText = extractTextFromUpdateContent(nextUpdate.content)
        if (typeof lastUpdate.content === 'object' && lastUpdate.content !== null) {
          (lastUpdate.content as Record<string, unknown>).text = mergeStreamingText(lastText, nextText)
          consolidated = true
        }
      }
    }

    if (!consolidated) {
      const stored = structuredClone(notification)

      // Cap tool output in history; the live session still gets the full output.
      if (stored.method === 'session/update') {
        const update = (stored.params as { update?: SessionUpdate })?.update
        if (update?.rawOutput && typeof update.rawOutput === 'object') {
          const ro = update.rawOutput as Record<string, unknown>
          for (const key of ['stdout', 'formatted_output']) {
            const value = ro[key]
            if (typeof value === 'string' && value.length > MAX_HISTORY_OUTPUT_CHARS) {
              ro[key] = value.slice(0, MAX_HISTORY_OUTPUT_CHARS) + '\n... (truncated in history)'
            }
          }
        }
      }

      // Stamp with arrival time so replays can preserve original timing
      ;(stored as unknown as Record<string, unknown>)._receivedAt = Date.now()
      session.permanentMessages.push(stored)
    }

    // Discard the oldest 25% at once to amortise the pruning cost.
    if (session.permanentMessages.length > MAX_PERMANENT_MESSAGES) {
      session.permanentMessages.splice(0, Math.ceil(MAX_PERMANENT_MESSAGES * 0.25))
    }
  }

  private sendRpcRequest(session: AcpSession, method: string, params?: unknown): Promise<unknown> {
    return sendJsonRpcRequest(session, method, params, this.label)
  }

  private sendRpcResponse(
    session: AcpSession,
    id: string | number,
    response: { result?: unknown; error?: JsonRpcError }
  ): void {
    const payload = response.error
      ? { jsonrpc: '2.0', id, error: response.error }
      : { jsonrpc: '2.0', id, result: response.result }
    console.log(`[${this.label}] Sending RPC response:`, JSON.stringify(payload))
    writeJsonRpc(session, payload, this.label)
  }

  private handlePermissionRequest(session: AcpSession, request: JsonRpcRequest): void {
    const params = request.params as {
      toolCall?: {
        rawInput?: { reason?: string }
        content?: Array<{ content?: { text?: string } }>
        title?: string
        kind?: string
        toolCallId?: string
      }
      options?: Array<{ optionId: string; name: string; kind: string }>
    } | undefined

    const toolCall = params?.toolCall
    const approvalOptions = (params?.options || []).map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind
    }))

    console.log(`[${this.label}] Permission request for ${toolCall?.kind} ${toolCall?.toolCallId} (options: ${approvalOptions.map((o) => o.optionId).join(', ')})`)

    if (session.config.permissionMode === 'allow') {
      const offered = (optionId: string): string | undefined =>
        approvalOptions.find((option) => option.optionId === optionId)?.optionId
      const autoApprovedOptionId = offered('approved-for-session')
        || offered('allow-always')
        || offered('approved')
        || offered('allow-once')
        || (this.agentType === 'cursor' ? 'allow-once' : 'approved')

      console.log(`[${this.label}] Auto-approving permission with: ${autoApprovedOptionId}`)
      this.sendRpcResponse(session, request.id, {
        result: {
          outcome: {
            outcome: 'selected',
            optionId: autoApprovedOptionId
          }
        }
      })
      return
    }

    session.pendingApproval = {
      requestId: request.id,
      toolCallId: toolCall?.toolCallId || '',
      question: toolCall?.rawInput?.reason
        || toolCall?.content?.[0]?.content?.text
        || `Execute: ${toolCall?.title || 'unknown command'}`,
      options: approvalOptions
    }
    session.status = SessionStatusType.WAITING_APPROVAL
    console.log(`[${this.label}] Awaiting user approval...`)
  }

  private extractAcpSessionId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const obj = result as Record<string, unknown>
    return (obj.sessionId || obj.session_id || obj.id) as string | null
  }
}

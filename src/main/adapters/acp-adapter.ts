/**
 * ACP (Agent Client Protocol) adapter for Cursor (`cursor-agent acp`).
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)
 * Spec: https://github.com/agentclientprotocol/typescript-sdk
 */

import { CLIENT_NAME } from '../app-identity'
import type { ChildProcess } from 'child_process'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionMessage,
  SessionStatus,
  MessagePart
} from './coding-agent-adapter'
import { SessionStatusType } from './coding-agent-adapter'
import {
  applyCursorAuthEnv,
  convertAcpMcpServers,
  cursorModelValue,
  CURSOR_AGENT_COMMAND
} from './acp-agent-config'
import {
  convertAcpEventToMessageParts,
  extractTextFromUpdateContent,
  isAssistantChunkUpdateType,
  mergeStreamingText,
  type AcpTurnState,
  type SessionUpdate
} from './acp-event-converter'
import { execFileAsync } from '../find-executable'
import {
  sendJsonRpcRequest,
  settleJsonRpcResponse,
  spawnJsonRpcChild,
  terminateJsonRpcPeer,
  writeJsonRpc,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcPeer,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './shared/json-rpc'
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
  /** Last error, for status reporting */
  lastError: string | null
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
const LABEL = 'AcpAdapter/cursor'

/** Prefixes the first prompt of a session with its system prompt, fenced so the agent can tell them apart. */
export function withSystemPrompt(systemPrompt: string | undefined, promptText: string): string {
  if (!systemPrompt) return promptText
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${promptText}`
}

export class AcpAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, AcpSession>()
  private debugRpcLogs: boolean

  onDataAvailable?: (sessionId: string) => void

  constructor() {
    const logLevel = process.env.LOG_LEVEL?.trim().toLowerCase()
    this.debugRpcLogs = logLevel === 'debug' || logLevel === 'trace'
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth()
    if (!health.available) {
      throw new Error(health.reason || 'ACP agent not available')
    }
    console.log(`[${LABEL}] Initialized successfully`)
  }

  /**
   * Authenticates with the first advertised method. Which credential it uses
   * (CLI login or CURSOR_API_KEY) was already decided in the child's env by
   * applyCursorAuthEnv.
   */
  private async authenticateSession(session: AcpSession, initResult: unknown): Promise<void> {
    const initObj = initResult as Record<string, unknown> | undefined
    const authMethods = (Array.isArray(initObj?.authMethods) ? initObj.authMethods : []) as Array<{ id: string }>
    const authMethod = authMethods[0]
    if (!authMethod) {
      console.log(`[${LABEL}] No auth methods advertised by agent (already authenticated)`)
      return
    }
    console.log(`[${LABEL}] Authenticating with method: ${authMethod.id}`)
    await this.sendRpcRequest(session, 'authenticate', { methodId: authMethod.id })
  }

  /**
   * Spawns the agent process, registers the session under `sessionId`, and runs
   * the ACP initialize + authenticate handshake.
   */
  private async startSession(sessionId: string, acpSessionId: string | null, config: SessionConfig): Promise<AcpSession> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...(config.apiKeys?.anthropic ? { ANTHROPIC_API_KEY: config.apiKeys.anthropic } : {}),
      ...config.secretEnvVars
    }
    // Auth is decided LAST so it is authoritative over injected secrets.
    applyCursorAuthEnv(env, config)

    const acpProcess = spawnJsonRpcChild(CURSOR_AGENT_COMMAND, ['acp'], { cwd: config.workspaceDir, env }, LABEL,
      (message) => this.handleRpcMessage(session, message))
    acpProcess.on('exit', (code) => {
      session.status = code === 0 ? SessionStatusType.IDLE : SessionStatusType.ERROR
    })

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
      lastError: null
    }
    this.sessions.set(sessionId, session)

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
      console.log(`[${LABEL}] ${configId} set to: ${value}`)
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      console.warn(`[${LABEL}] Failed to set ${configId}: ${errMsg}`)
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.taskId
    console.log(`[${LABEL}] Creating session ${sessionId}`)

    const session = await this.startSession(sessionId, null, config)

    // session/new only accepts cwd and mcpServers per the ACP spec.
    const mcpServers = convertAcpMcpServers(config.mcpServers)
    console.log(`[${LABEL}] session/new mcpServers:`, JSON.stringify(mcpServers))
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
        await this.setConfigOption(session, 'model', cursorModelValue(config.model))
      }
      if (config.reasoningEffort && config.reasoningEffort !== 'max') {
        await this.setConfigOption(session, 'model_reasoning_effort', config.reasoningEffort)
      }
    }

    console.log(`[${LABEL}] Session created: ${sessionId} (ACP: ${acpSessionId})`)
    // The ACP session ID is persisted and used for resuming.
    return acpSessionId || sessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    console.log(`[${LABEL}] Resuming session ${sessionId}`)

    // sessionId is the ACP session ID returned by createSession.
    const session = await this.startSession(sessionId, sessionId, config)

    try {
      await this.sendRpcRequest(session, 'session/load', {
        sessionId,
        cwd: config.workspaceDir,
        mcpServers: convertAcpMcpServers(config.mcpServers)
      })
      console.log(`[${LABEL}] Session loaded successfully: ${sessionId}`)

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
        terminateJsonRpcPeer(session, `${LABEL}: session ${sessionId} not found`)
        this.sessions.delete(sessionId)
        throw new Error(
          'INCOMPATIBLE_SESSION_ID: This cursor session does not exist or has expired. Please start a new session.'
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

    console.log(`[${LABEL}] Sending prompt to session ${sessionId} (${promptText.length} chars)`)

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
    }, LABEL, failPrompt)
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

    console.log(`[${LABEL}] Sending session/cancel for ${sessionId}`)

    // session/cancel is a notification. The agent answers the original
    // session/prompt with stopReason: cancelled, which settles the status.
    writeJsonRpc(session, {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: session.acpSessionId }
    }, LABEL)
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    console.log(`[${LABEL}] Destroying session ${sessionId}`)

    terminateJsonRpcPeer(session, `${LABEL}: session ${sessionId} destroyed`)
    session.permanentMessages.length = 0
    session.messageBuffer.length = 0
    session.toolCallMetadata.clear()

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
    try {
      await execFileAsync(CURSOR_AGENT_COMMAND, ['--version'], {
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
      console.warn(`[${LABEL}] No pending approval for session ${sessionId}`)
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

    console.log(`[${LABEL}] Responding to approval with: ${selectedOptionId}`)

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
      console.log(`[${LABEL}] Received RPC message:`, JSON.stringify(message))
    }

    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const response = message as JsonRpcResponse
      if (settleJsonRpcResponse(session, response)) return

      // No pending request: e.g. an error for a permission response.
      if (response.error) {
        console.error(`[${LABEL}] Unexpected error response:`, response.error)
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
          console.log(`[${LABEL}] Prompt completed with stopReason: ${result.stopReason}`)
          session.status = SessionStatusType.IDLE
          session.activeTurnId = null
          // promptRequestId is kept for late-arriving events; the next prompt replaces it.
        }
        return
      }
    }

    if ('method' in message && 'id' in message && message.id !== undefined) {
      const request = message as JsonRpcRequest
      if (this.debugRpcLogs) {
        console.log(`[${LABEL}] << Request: ${request.method}`)
      }

      if (request.method === 'session/request_permission') {
        this.handlePermissionRequest(session, request)
        return
      }

      if (request.method === 'cursor/ask_question') {
        this.sendRpcResponse(session, request.id, {
          result: { outcome: { outcome: 'skipped', reason: 'Cursor questions are not supported by 20x yet' } }
        })
        return
      }

      if (request.method === 'cursor/create_plan') {
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
        console.log(`[${LABEL}] << Notification: ${notification.method}`)
        if (notification.method === 'session/update') {
          const params = notification.params as { update?: SessionUpdate } | undefined
          console.log(`[${LABEL}]    sessionUpdate: ${params?.update?.sessionUpdate}`)
        }
      }

      session.messageBuffer.push(notification)
      this.addToPermanentMessages(session, notification)
      this.onDataAvailable?.(session.sessionId)
      this.updateSessionStatus(session, notification)
    }
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
    return sendJsonRpcRequest(session, method, params, LABEL)
  }

  private sendRpcResponse(
    session: AcpSession,
    id: string | number,
    response: { result?: unknown; error?: JsonRpcError }
  ): void {
    const payload = response.error
      ? { jsonrpc: '2.0', id, error: response.error }
      : { jsonrpc: '2.0', id, result: response.result }
    console.log(`[${LABEL}] Sending RPC response:`, JSON.stringify(payload))
    writeJsonRpc(session, payload, LABEL)
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

    console.log(`[${LABEL}] Permission request for ${toolCall?.kind} ${toolCall?.toolCallId} (options: ${approvalOptions.map((o) => o.optionId).join(', ')})`)

    if (session.config.permissionMode === 'allow') {
      const offered = (optionId: string): string | undefined =>
        approvalOptions.find((option) => option.optionId === optionId)?.optionId
      const autoApprovedOptionId = offered('approved-for-session')
        || offered('allow-always')
        || offered('approved')
        || offered('allow-once')
        || 'allow-once'

      console.log(`[${LABEL}] Auto-approving permission with: ${autoApprovedOptionId}`)
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
    console.log(`[${LABEL}] Awaiting user approval...`)
  }

  private extractAcpSessionId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const obj = result as Record<string, unknown>
    return (obj.sessionId || obj.session_id || obj.id) as string | null
  }
}

/**
 * Pi coding-agent adapter.
 *
 * Pi exposes a JSONL RPC protocol over stdin/stdout. 20x keeps one Pi process
 * per live session and converts Pi events to the shared adapter message shape.
 */

import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type {
  CodingAgentAdapter,
  MessagePart,
  SessionConfig,
  SessionMessage,
  SessionStatus,
} from './coding-agent-adapter'
import { MessagePartType, SessionStatusType } from './coding-agent-adapter'
import {
  piInvocation,
  piProcessEnv,
  sanitizePiSessionName,
  splitPiModel,
  withProviderNameLimitHint,
} from './pi-config'
import { installPiPermissionExtension, removeLegacyGatewayProvider, writePiMcpConfig } from './pi-files'
import { convertPiHistory, piProvidersFromModels, piToolResultText, type PiMessage } from './pi-messages'
import { execFileAsync, findExecutable } from '../find-executable'
import { onJsonLines } from './shared/jsonl'

const RPC_TIMEOUT_MS = 15_000
const MAX_BUFFERED_PARTS = 1_000
const MINIMUM_PI_VERSION = [0, 80, 5] as const
const TERMINAL_ERROR_SETTLE_GRACE_MS = 1_000

interface PiRpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface PiSession {
  id: string
  process: ChildProcessWithoutNullStreams
  config: SessionConfig
  status: 'idle' | 'busy' | 'error'
  lastError: string | null
  pending: Map<string, PendingRequest>
  parts: MessagePart[]
  allMessages: SessionMessage[]
  textByBlock: Map<string, string>
  reasoningByBlock: Map<string, string>
  toolParts: Map<string, MessagePart>
  pendingUiRequests: Map<string, PiUiRequest>
  turn: number
  assistantMessageOrdinal: number
  pendingTurnError: string | null
  pendingTurnErrorMonotonicTime: number | null
  sawAgentActivity: boolean
  promptMayBeCommandOnly: boolean
  closing: boolean
  mcpConfigPath?: string
  /** Tail of everything Pi wrote to stderr, so an early exit can be explained. */
  stderrTail: string
}

interface PiUiRequest {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor'
  title: string
  message: string
  options: string[]
}

export class PiAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, PiSession>()
  private piExecutablePath: string | null = null
  onDataAvailable?: (sessionId: string) => void

  async initialize(): Promise<void> {
    await this.findPiExecutable()
  }

  private async findPiExecutable(): Promise<string> {
    if (this.piExecutablePath) return this.piExecutablePath
    const home = homedir()
    const fallbackPaths = process.platform === 'win32'
      ? [
          join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd'),
          join(home, 'AppData', 'Roaming', 'npm', 'pi.exe'),
        ]
      : [
          '/opt/homebrew/bin/pi',
          '/usr/local/bin/pi',
          join(home, '.local', 'bin', 'pi'),
          join(home, '.npm-global', 'bin', 'pi'),
          join(home, '.volta', 'bin', 'pi'),
        ]
    const found = await findExecutable('pi', fallbackPaths)
    if (!found) {
      throw new Error('Pi CLI not found. Install it with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent')
    }
    this.piExecutablePath = found
    removeLegacyGatewayProvider()
    return found
  }

  private createSessionState(
    id: string,
    child: ChildProcessWithoutNullStreams,
    config: SessionConfig,
    mcpConfigPath?: string,
  ): PiSession {
    return {
      id,
      process: child,
      config,
      status: 'idle',
      lastError: null,
      pending: new Map(),
      parts: [],
      allMessages: [],
      textByBlock: new Map(),
      reasoningByBlock: new Map(),
      toolParts: new Map(),
      pendingUiRequests: new Map(),
      turn: 0,
      assistantMessageOrdinal: 0,
      pendingTurnError: null,
      pendingTurnErrorMonotonicTime: null,
      sawAgentActivity: false,
      promptMayBeCommandOnly: false,
      closing: false,
      mcpConfigPath,
      stderrTail: '',
    }
  }

  private async applySelection(session: PiSession, config: SessionConfig): Promise<void> {
    if (config.model && config.model !== 'default') {
      const { provider, modelId } = splitPiModel(config.model)
      if (!provider || !modelId) {
        throw new Error(`Pi model must use provider/model format: ${config.model}`)
      }
      await this.command(session, { type: 'set_model', provider, modelId })
    }
    if (config.reasoningEffort) {
      await this.command(session, { type: 'set_thinking_level', level: config.reasoningEffort })
    }
  }

  private async spawnSession(config: SessionConfig, resumeId?: string): Promise<PiSession> {
    const executable = await this.findPiExecutable()
    const mcpConfigPath = writePiMcpConfig(config)
    const permissionExtension = installPiPermissionExtension()

    const args = ['--mode', 'rpc', '--approve', '--name', sanitizePiSessionName(config.taskId), '--extension', permissionExtension]
    if (config.systemPrompt?.trim()) {
      args.push('--append-system-prompt', config.systemPrompt.trim())
    }
    if (resumeId) args.push('--session', resumeId)
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)

    const child = this.spawnPi(executable, args, config)
    const tempId = resumeId || randomUUID()
    const session = this.createSessionState(tempId, child, config, mcpConfigPath)
    this.sessions.set(tempId, session)
    this.attachProcess(session)

    try {
      const state = await this.command(session, { type: 'get_state' })
      const realId = typeof state.data?.sessionFile === 'string'
        ? state.data.sessionFile
        : typeof state.data?.sessionId === 'string' ? state.data.sessionId : tempId
      session.id = realId
      if (realId !== tempId) {
        this.sessions.delete(tempId)
        this.sessions.set(realId, session)
      }
      await this.applySelection(session, config)
      return session
    } catch (error) {
      this.sessions.delete(tempId)
      this.sessions.delete(session.id)
      await this.terminateProcess(session)
      if (mcpConfigPath && existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath)
      throw error
    }
  }

  private spawnPi(executable: string, args: string[], config: SessionConfig): ChildProcessWithoutNullStreams {
    const invocation = piInvocation(executable, args, piProcessEnv(config))
    return spawn(invocation.command, invocation.args, {
      cwd: config.workspaceDir,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: invocation.shell,
      detached: process.platform !== 'win32',
    })
  }

  async createSession(config: SessionConfig): Promise<string> {
    const session = await this.spawnSession(config)
    return session.id
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    return this.loadHistory(await this.spawnSession(config, sessionId))
  }

  private async loadHistory(session: PiSession): Promise<SessionMessage[]> {
    const response = await this.command(session, { type: 'get_messages' })
    const messages = Array.isArray(response.data?.messages) ? response.data.messages as PiMessage[] : []
    session.allMessages = convertPiHistory(messages)
    return session.allMessages
  }

  private attachProcess(session: PiSession): void {
    onJsonLines(session.process.stdout, (line) => {
      try {
        this.handleEvent(session, JSON.parse(line) as Record<string, unknown>)
      } catch (error) {
        console.warn('[PiAdapter] Invalid RPC output:', error)
      }
    })
    session.process.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim()
      if (!text) return
      // Keep the tail for the exit error message, and log the actual content
      // rather than just its length — a silent early exit is useless to
      // diagnose when the only trace is "Pi wrote 35 character(s) to stderr".
      session.stderrTail = `${session.stderrTail}\n${text}`.slice(-4000)
      console.warn(`[PiAdapter/${session.id}] Pi stderr: ${text.slice(0, 1000)}`)
    })
    session.process.on('error', (error) => {
      session.status = 'error'
      session.lastError = error.message
      this.rejectPending(session, error)
      this.onDataAvailable?.(session.id)
    })
    session.process.on('exit', (code, signal) => {
      if (!session.closing && session.status === 'busy') {
        session.status = 'error'
        session.lastError = `Pi exited before the turn completed (${signal || `code ${code}`})`
      }
      // Surface what Pi actually printed when it died early (unknown model,
      // auth failure, bad flag...) instead of a bare "Pi process exited".
      const stderr = session.stderrTail.trim()
      const detail = stderr ? `: ${stderr.split('\n').slice(-3).join(' ').slice(-300)}` : ''
      // "Unknown option: --mcp-config" means the pi-mcp-adapter extension is
      // missing, so Pi's CLI never registered the flag. Point the user at the fix.
      const missingExtensionHint = stderr.includes('Unknown option: --mcp-config')
        ? ' Install the Pi MCP extension first with: pi install npm:pi-mcp-adapter' : ''
      this.rejectPending(session, new Error(session.lastError || (session.closing ? 'Pi process closed' : `Pi process exited${detail}${missingExtensionHint}`)))
      this.onDataAvailable?.(session.id)
    })
  }

  private rejectPending(session: PiSession, error: Error): void {
    for (const request of session.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    session.pending.clear()
  }

  private handleEvent(session: PiSession, event: Record<string, unknown>): void {
    if (event.type === 'response') {
      const response = event as unknown as PiRpcResponse
      if (response.id) {
        const pending = session.pending.get(response.id)
        if (pending) {
          clearTimeout(pending.timer)
          session.pending.delete(response.id)
          if (response.success) pending.resolve(response)
          else pending.reject(new Error(response.error || `Pi ${response.command} failed`))
          return
        }
      }
      if (response.command === 'prompt' && !response.success) {
        session.status = 'error'
        session.lastError = response.error || 'Pi rejected the prompt'
      } else if (
        response.command === 'prompt'
        && response.success
        && session.promptMayBeCommandOnly
        && !session.sawAgentActivity
      ) {
        void this.command(session, { type: 'get_state' }).then((state) => {
          const pendingMessageCount = typeof state.data?.pendingMessageCount === 'number'
            ? state.data.pendingMessageCount
            : 0
          if (state.data?.isStreaming !== true && pendingMessageCount === 0 && !session.sawAgentActivity) {
            session.status = session.pendingUiRequests.size > 0 ? 'busy' : 'idle'
            this.onDataAvailable?.(session.id)
          }
        }).catch(() => undefined)
      }
      this.onDataAvailable?.(session.id)
      return
    }

    switch (event.type) {
      case 'agent_start':
        session.status = 'busy'
        session.lastError = null
        session.pendingTurnError = null
        session.pendingTurnErrorMonotonicTime = null
        session.turn++
        session.assistantMessageOrdinal = 0
        session.sawAgentActivity = true
        break
      case 'agent_settled': {
        this.cancelPendingUiRequests(session, 'This request is no longer active.')
        if (session.pendingTurnError) this.settlePendingTurnError(session)
        else session.status = 'idle'
        session.promptMayBeCommandOnly = false
        break
      }
      case 'message_start': {
        const message = event.message as PiMessage | undefined
        if (message?.role === 'assistant') session.assistantMessageOrdinal++
        break
      }
      case 'message_update':
        this.handleMessageUpdate(session, event.assistantMessageEvent as Record<string, unknown> | undefined)
        break
      case 'message_end': {
        const message = event.message as PiMessage | undefined
        this.reconcileAssistantMessage(session, message)
        if (message?.role === 'assistant' && message.stopReason === 'error') {
          session.pendingTurnError = message.errorMessage || 'Pi model request failed'
          session.pendingTurnErrorMonotonicTime = performance.now()
        }
        break
      }
      case 'tool_execution_start':
        this.handleToolEvent(session, event, 'running')
        break
      case 'tool_execution_update':
        this.handleToolEvent(session, event, 'running')
        break
      case 'tool_execution_end':
        this.handleToolEvent(session, event, event.isError ? 'error' : 'completed')
        break
      case 'auto_retry_start':
        session.status = 'busy'
        session.pendingTurnErrorMonotonicTime = null
        break
      case 'auto_retry_end':
        session.pendingTurnError = event.success === true
          ? null
          : String(event.finalError || 'Pi retry failed')
        session.pendingTurnErrorMonotonicTime = event.success === true ? null : performance.now()
        break
      case 'compaction_end':
        if (event.result) session.pendingTurnError = null
        else if (event.aborted !== true && event.errorMessage) {
          session.parts.push({
            id: `pi-compaction-error-${session.turn}-${randomUUID()}`,
            type: MessagePartType.ERROR,
            text: String(event.errorMessage),
          })
        }
        break
      case 'extension_error':
        session.parts.push({
          id: `pi-extension-error-${randomUUID()}`,
          type: MessagePartType.ERROR,
          text: String(event.error || 'Pi extension failed'),
        })
        break
      case 'extension_ui_request':
        this.handleExtensionUiRequest(session, event)
        break
    }

    if (session.parts.length > MAX_BUFFERED_PARTS) {
      session.parts.splice(0, session.parts.length - MAX_BUFFERED_PARTS)
    }
    this.onDataAvailable?.(session.id)
  }

  private handleExtensionUiRequest(session: PiSession, event: Record<string, unknown>): void {
    const method = event.method
    const id = event.id
    if (method === 'notify') {
      const message = String(event.message || event.title || 'Pi notification')
      session.parts.push({
        id: `pi-notify-${randomUUID()}`,
        type: MessagePartType.TEXT,
        text: message,
      })
      return
    }
    if (
      typeof id !== 'string'
      || (method !== 'confirm' && method !== 'select' && method !== 'input' && method !== 'editor')
    ) return

    const request: PiUiRequest = {
      id,
      method,
      title: String(event.title || (method === 'confirm' ? 'Permission Required' : 'Input Required')),
      message: this.uiRequestMessage(method, event),
      options: Array.isArray(event.options) ? event.options.filter((option): option is string => typeof option === 'string') : [],
    }

    if (method === 'confirm' && session.config.permissionMode === 'allow') {
      this.sendRecord(session, { type: 'extension_ui_response', id, confirmed: true })
      return
    }

    session.pendingUiRequests.set(id, request)
    session.status = 'busy'
    if (method !== 'confirm') {
      session.parts.push({
        id: `pi-question-${id}`,
        type: MessagePartType.QUESTION,
        tool: {
          name: 'question',
          status: 'running',
          title: request.title,
          requestId: request.id,
          questions: [{
            header: request.title,
            question: request.message,
            options: request.options.map((label) => ({ label, description: label })),
          }],
        },
      })
    }
  }

  private uiRequestMessage(method: PiUiRequest['method'], event: Record<string, unknown>): string {
    const message = String(event.message || event.placeholder || event.title || 'Pi needs your response')
    const prefill = method === 'editor' && typeof event.prefill === 'string'
      ? event.prefill.slice(0, 2_000)
      : ''
    return prefill ? `${message}\n\nCurrent value:\n${prefill}` : message
  }

  private cancelPendingUiRequests(session: PiSession, output: string, notifyPi = false): void {
    for (const request of session.pendingUiRequests.values()) {
      if (notifyPi) {
        try {
          this.sendRecord(session, { type: 'extension_ui_response', id: request.id, cancelled: true })
        } catch {
          // The process may have closed while the turn was being stopped.
        }
      }
      session.parts.push({
        id: request.method === 'confirm' ? `question-${request.id}` : `pi-question-${request.id}`,
        type: MessagePartType.QUESTION,
        update: true,
        tool: {
          name: request.method === 'confirm' ? 'permission' : 'question',
          status: 'cancelled',
          requestId: request.id,
          output,
        },
      })
    }
    session.pendingUiRequests.clear()
  }

  private handleMessageUpdate(session: PiSession, update?: Record<string, unknown>): void {
    if (!update) return
    const index = String(update.contentIndex ?? 0)
    const key = `${session.turn}:${session.assistantMessageOrdinal}:${index}`
    if (update.type === 'text_delta') {
      const text = (session.textByBlock.get(key) || '') + String(update.delta || '')
      session.textByBlock.set(key, text)
      session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
    } else if (update.type === 'text_end') {
      const text = String(update.content ?? session.textByBlock.get(key) ?? '')
      session.textByBlock.set(key, text)
      session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
    } else if (update.type === 'thinking_delta') {
      const text = (session.reasoningByBlock.get(key) || '') + String(update.delta || '')
      session.reasoningByBlock.set(key, text)
      session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
    } else if (update.type === 'thinking_end') {
      const text = String(update.content ?? update.thinking ?? session.reasoningByBlock.get(key) ?? '')
      session.reasoningByBlock.set(key, text)
      session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
    }
  }

  private reconcileAssistantMessage(session: PiSession, message?: PiMessage): void {
    if (message?.role !== 'assistant') return
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : []
    blocks.forEach((block, index) => {
      const key = `${session.turn}:${session.assistantMessageOrdinal}:${index}`
      if (block.type === 'text') {
        const text = String(block.text ?? '')
        session.textByBlock.set(key, text)
        session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
      } else if (block.type === 'thinking') {
        const text = String(block.thinking ?? '')
        session.reasoningByBlock.set(key, text)
        session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
      }
    })
  }

  private handleToolEvent(session: PiSession, event: Record<string, unknown>, status: string): void {
    const id = String(event.toolCallId || randomUUID())
    const existing = session.toolParts.get(id)
    const output = piToolResultText(event.result ?? event.partialResult)
    const tool: NonNullable<MessagePart['tool']> = {
      name: String(event.toolName || existing?.tool?.name || 'tool'),
      status,
      input: event.args ?? existing?.tool?.input,
      output: output || existing?.tool?.output,
      error: status === 'error' ? output || 'Tool failed' : undefined,
    }
    const part: MessagePart = { id: `pi-tool-${id}`, type: MessagePartType.TOOL, tool, update: !!existing }
    session.toolParts.set(id, part)
    session.parts.push(part)
  }

  private command(session: PiSession, command: Record<string, unknown>): Promise<PiRpcResponse> {
    if (session.process.exitCode !== null || !session.process.stdin.writable) {
      return Promise.reject(new Error('Pi process is not running'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`Pi RPC command timed out: ${String(command.type)}`))
      }, RPC_TIMEOUT_MS)
      session.pending.set(id, { resolve, reject, timer })
      session.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        session.pending.delete(id)
        reject(error)
      })
    })
  }

  private sendRecord(session: PiSession, record: Record<string, unknown>): void {
    if (session.process.exitCode !== null || !session.process.stdin.writable) {
      throw new Error('Pi process is not running')
    }
    session.process.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
      if (!error) return
      session.status = 'error'
      session.lastError = error.message
      this.onDataAvailable?.(session.id)
    })
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const message = parts.filter((part) => part.type === MessagePartType.TEXT && part.text).map((part) => part.text).join('\n')
    if (!message) throw new Error('No text content in prompt parts')
    const wasBusy = session.status === 'busy'
    session.status = 'busy'
    session.lastError = null
    session.sawAgentActivity = false
    session.promptMayBeCommandOnly = message.trimStart().startsWith('/')
    this.sendRecord(session, {
      type: 'prompt',
      message,
      // A message sent from the task composer while Pi is already running is
      // user steering, not deferred work. Pi delivers `steer` after the current
      // tool finishes and before the next model call; `followUp` would wait for
      // the whole run to settle and lets a misdirected turn continue unchecked.
      ...(wasBusy ? { streamingBehavior: 'steer' } : {}),
    })
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: SessionStatusType.ERROR, message: 'Session not found' }
    // Some providers end the model stream with stopReason=error but omit the
    // final agent_settled event. Confirm Pi is no longer streaming so that a
    // terminal provider error cannot leave the task BUSY forever. A retry keeps
    // isStreaming=true (and auto_retry_start clears/replaces the pending error).
    if (
      session.pendingTurnError
      && session.pendingTurnErrorMonotonicTime !== null
      && performance.now() - session.pendingTurnErrorMonotonicTime >= TERMINAL_ERROR_SETTLE_GRACE_MS
      && session.status === 'busy'
    ) {
      try {
        const state = await this.command(session, { type: 'get_state' })
        const pendingMessageCount = typeof state.data?.pendingMessageCount === 'number'
          ? state.data.pendingMessageCount
          : 0
        if (state.data?.isStreaming !== true && pendingMessageCount === 0) {
          this.settlePendingTurnError(session)
        }
      } catch {
        // Keep polling; process exit/error handling remains authoritative.
      }
    }
    if (session.lastError) return { type: SessionStatusType.ERROR, message: session.lastError }
    if (session.pendingUiRequests.size > 0) {
      return { type: SessionStatusType.WAITING_APPROVAL, message: 'Pi is waiting for input' }
    }
    return { type: session.status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE }
  }

  private settlePendingTurnError(session: PiSession): void {
    if (!session.pendingTurnError) return
    const error = withProviderNameLimitHint(session.pendingTurnError)
    session.pendingTurnError = null
    session.pendingTurnErrorMonotonicTime = null
    session.lastError = error
    session.status = 'error'
    session.parts.push({
      id: `pi-error-${session.turn}`,
      type: MessagePartType.ERROR,
      text: error,
    })
  }

  async pollMessages(sessionId: string): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return session.parts.splice(0)
  }

  getPendingApproval(sessionId: string): {
    requestId: string
    toolCallId: string
    question: string
    options: Array<{ optionId: string; name: string; kind: string }>
  } | null {
    const session = this.sessions.get(sessionId)
    const request = session
      ? Array.from(session.pendingUiRequests.values()).find((item) => item.method === 'confirm')
      : undefined
    if (!request) return null
    return {
      requestId: request.id,
      toolCallId: request.id,
      question: [request.title, request.message].filter(Boolean).join('\n\n'),
      options: [
        { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
        { optionId: 'abort', name: 'No', kind: 'reject_once' },
      ],
    }
  }

  async respondToApproval(
    sessionId: string,
    approved: boolean,
    _optionId?: string,
    requestId?: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const request = requestId
      ? session.pendingUiRequests.get(requestId)
      : Array.from(session.pendingUiRequests.values()).find((item) => item.method === 'confirm')
    if (request?.method !== 'confirm') return false
    this.sendRecord(session, {
      type: 'extension_ui_response',
      id: request.id,
      confirmed: approved,
    })
    session.pendingUiRequests.delete(request.id)
    session.parts.push({
      id: `question-${request.id}`,
      type: MessagePartType.QUESTION,
      update: true,
      tool: {
        name: 'permission',
        status: approved ? 'completed' : 'cancelled',
        requestId: request.id,
        output: approved ? 'Approved' : 'Declined',
      },
    })
    session.status = 'busy'
    this.onDataAvailable?.(session.id)
    return true
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    _config: SessionConfig,
    requestId?: string,
  ): Promise<boolean | { handled: false; resolutionPart: MessagePart }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const request = requestId
      ? session.pendingUiRequests.get(requestId)
      : Array.from(session.pendingUiRequests.values()).find((item) => item.method !== 'confirm')
    // A restored transcript or another client can submit a response after Pi
    // has already consumed the request. Treat that response as stale.
    if (!request || request.method === 'confirm') {
      if (!request && requestId) {
        return {
          handled: false,
          resolutionPart: {
            id: `pi-question-${requestId}`,
            type: MessagePartType.QUESTION,
            update: true,
            tool: {
              name: 'question',
              status: 'cancelled',
              requestId,
              output: 'This request expired when the session ended. Restart the turn to continue.',
            },
          },
        }
      }
      return false
    }
    const value = answers[request.title] ?? answers[request.message] ?? answers.answer ?? Object.values(answers)[0] ?? ''
    this.sendRecord(session, {
      type: 'extension_ui_response',
      id: request.id,
      value,
    })
    session.pendingUiRequests.delete(request.id)
    session.parts.push({
      id: `pi-question-${request.id}`,
      type: MessagePartType.QUESTION,
      update: true,
      tool: {
        name: 'question',
        status: 'completed',
        title: request.title,
        requestId: request.id,
        output: value,
      },
    })
    session.status = 'busy'
    this.onDataAvailable?.(session.id)
    return true
  }

  async getRunningTools(sessionId: string): Promise<Array<{
    partId: string
    toolName: string
    input?: Record<string, unknown>
  }>> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return Array.from(session.toolParts.values()).flatMap((part) => {
      if (part.tool?.status !== 'running') return []
      return [{
        partId: part.id || `pi-tool-${part.tool.name}`,
        toolName: part.tool.name,
        ...(part.tool.input && typeof part.tool.input === 'object'
          ? { input: part.tool.input as Record<string, unknown> }
          : {}),
      }]
    })
  }

  async getAllMessages(sessionId: string): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    try {
      await this.loadHistory(session)
    } catch {
      // Use the last successful snapshot when the process has already ended.
    }
    return session.allMessages
  }

  async abortPrompt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.cancelPendingUiRequests(session, 'This request was cancelled when the turn stopped.', true)
    await this.command(session, { type: 'clear_queue' }).catch(() => undefined)
    await this.command(session, { type: 'abort' })
    session.status = 'idle'
  }

  private async terminateProcess(session: PiSession): Promise<void> {
    session.closing = true
    if (session.process.exitCode !== null || !session.process.pid) return
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(session.process.pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true,
      }).catch(() => session.process.kill())
      return
    }

    const processGroup = -session.process.pid
    try {
      process.kill(processGroup, 'SIGTERM')
    } catch {
      session.process.kill()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (session.process.exitCode !== null) return
    try {
      process.kill(processGroup, 'SIGKILL')
    } catch {
      // The process group exited during the grace period.
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const request of session.pendingUiRequests.values()) {
      try {
        this.sendRecord(session, { type: 'extension_ui_response', id: request.id, cancelled: true })
      } catch {
        break
      }
    }
    session.pendingUiRequests.clear()
    await this.terminateProcess(session)
    this.sessions.delete(sessionId)
    if (session.mcpConfigPath && existsSync(session.mcpConfigPath)) {
      unlinkSync(session.mcpConfigPath)
    }
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const executable = await this.findPiExecutable()
      const invocation = piInvocation(executable, ['--version'], { ...process.env })
      const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
        env: invocation.env,
        timeout: 10_000,
        shell: invocation.shell,
        windowsHide: true,
      })
      const match = `${stdout}\n${stderr}`.match(/(\d+)\.(\d+)\.(\d+)/)
      if (!match) return { available: false, reason: 'Could not determine the Pi version' }
      const installed = match.slice(1, 4).map(Number)
      for (let index = 0; index < MINIMUM_PI_VERSION.length; index++) {
        if (installed[index] > MINIMUM_PI_VERSION[index]) break
        if (installed[index] < MINIMUM_PI_VERSION[index]) {
          return {
            available: false,
            reason: `Pi ${MINIMUM_PI_VERSION.join('.')} or newer is required`,
          }
        }
      }
      return { available: true }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async getProviders(
    _serverUrl?: string,
    directory?: string,
  ): Promise<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; default: Record<string, string> }> {
    const executable = await this.findPiExecutable()
    const config: SessionConfig = {
      agentId: 'pi-discovery',
      taskId: 'pi-discovery',
      workspaceDir: directory || process.cwd(),
      permissionMode: 'allow',
    }
    const child = this.spawnPi(executable, ['--mode', 'rpc', '--no-session', '--approve'], config)
    const session = this.createSessionState(`pi-discovery-${randomUUID()}`, child, config)
    this.attachProcess(session)

    try {
      const [state, available] = await Promise.all([
        this.command(session, { type: 'get_state' }),
        this.command(session, { type: 'get_available_models' }),
      ])
      const models = Array.isArray(available.data?.models) ? available.data.models : []
      return piProvidersFromModels(models, state.data?.model)
    } finally {
      await this.terminateProcess(session)
    }
  }
}

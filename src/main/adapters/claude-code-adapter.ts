/**
 * CodingAgentAdapter for Claude Code via @anthropic-ai/claude-agent-sdk. The
 * SDK streams messages from a child `claude` process through an async
 * generator; sessions persist as files under ~/.claude/projects/.
 */

import { randomUUID } from 'crypto'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'
import { findClaudeExecutable } from './claude-code-executable'
import { cleanSessionFile, isValidClaudeSessionId, loadSessionHistory } from './claude-code-history'
import { buildToolTitle, convertSDKMessageToParts, resultErrorText } from './claude-code-message-converter'
import { claudeCodePermissionMode } from './permission-mode'
import {
  buildClaudeEnvironment,
  buildClaudeMcpServers,
  buildIsolationOptions,
  buildMcpToolLimitHooks,
  buildSecretHooks,
  mergeHooks
} from './claude-code-options'
import { pruneStaleBackgroundTasks, trackBackgroundTask, type BackgroundTask } from './claude-code-background-tasks'
import { ALWAYS_APPROVAL_OPTIONS } from './shared/approval-options'
import { lazySdk } from './shared/lazy-sdk'

type Query = import('@anthropic-ai/claude-agent-sdk').Query
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type Options = import('@anthropic-ai/claude-agent-sdk').Options
type CanUseTool = import('@anthropic-ai/claude-agent-sdk').CanUseTool
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult
type PermissionUpdate = import('@anthropic-ai/claude-agent-sdk').PermissionUpdate

const claudeSdk = lazySdk('Claude Agent SDK', () => import('@anthropic-ai/claude-agent-sdk'))

/** Older, already-polled messages are dropped past this size. */
const MAX_MESSAGE_BUFFER_SIZE = 500

/**
 * A Claude Code tool-permission request waiting for the user. Created by the
 * SDK's `canUseTool` callback when the agent's permission mode is 'ask', and
 * surfaced to the UI through getPendingApproval()/respondToApproval().
 */
interface PendingClaudeApproval {
  requestId: string
  toolCallId: string
  question: string
  options: Array<{ optionId: string; name: string; kind: string }>
  suggestions?: PermissionUpdate[]
  input: Record<string, unknown>
  resolve: (result: PermissionResult) => void
}

/** Option ids (and renderer answer labels mapped by agent-manager) that deny a request. */
const DENY_APPROVAL_OPTIONS = new Set(['abort', 'deny', 'reject', 'cancel', 'denied'])

interface ClaudeSession {
  /** Claude's internal session ID, known once the first stream message arrives */
  sessionId: string
  queryIterator: Query | null
  abortController: AbortController | null
  status: 'idle' | 'busy' | 'error'
  messageBuffer: SDKMessage[]
  /** Index of the first unprocessed message in messageBuffer (cursor-based tracking) */
  messageCursor: number
  streamTask: Promise<void> | null
  lastError: string | null
  config: SessionConfig
  /** True when the next query must `resume` the persisted session */
  isResumed?: boolean
  /** In-flight background tasks; while non-empty the session is paused, not done (see claude-code-background-tasks.ts). */
  backgroundTasks: Map<string, BackgroundTask>
  /** True once the current turn emitted a non-error `result` message. */
  sawResult: boolean
  /**
   * Adds a new user turn to the live Claude Code input stream. Keeping one
   * stream for the full adapter-session lifetime preserves harness events while
   * the current turn is idle.
   */
  enqueuePrompt: ((promptText: string) => void) | null
  /**
   * Closes the persistent streaming-input prompt generator. Normal IDLE never
   * calls this. Only abort, destroy, or unexpected process exit closes it.
   */
  releasePrompt: (() => void) | null
  /** Tool-permission requests awaiting the user, oldest first ('ask' mode only). */
  pendingApprovals: PendingClaudeApproval[]
}

function newClaudeSession(sessionId: string, config: SessionConfig, isResumed: boolean): ClaudeSession {
  return {
    sessionId,
    queryIterator: null,
    abortController: null,
    status: 'idle',
    messageBuffer: [],
    messageCursor: 0,
    streamTask: null,
    lastError: null,
    config,
    isResumed,
    backgroundTasks: new Map(),
    sawResult: false,
    enqueuePrompt: null,
    releasePrompt: null,
    pendingApprovals: [],
  }
}

export class ClaudeCodeAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, ClaudeSession>()

  /**
   * Callback set by agent-manager to trigger an immediate poll cycle
   * when new stream data is buffered.  Eliminates the up-to-2-second
   * latency of the fixed-interval polling heartbeat.
   */
  onDataAvailable?: (sessionId: string) => void

  /**
   * Routes Claude Code's tool-permission requests to the 21x approval UI.
   *
   * Only installed when the agent's permission mode is not 'allow'. Without a
   * canUseTool callback the SDK has nobody to ask, so every request that needs
   * approval (Bash, Edit, Write, ...) would be denied outright.
   */
  private buildCanUseTool(sessionKey: string, session: ClaudeSession): CanUseTool {
    return (toolName, input, { signal, suggestions, toolUseID, title }) => {
      // AskUserQuestion is answered through the question flow: the tool_use is
      // rendered as a question and the answer arrives as the next prompt (see
      // respondToQuestion). End the turn so the agent waits for it.
      if (toolName === 'AskUserQuestion') {
        return Promise.resolve({
          behavior: 'deny',
          message: 'The question has been shown to the user. Their answer will arrive as the next message.',
          interrupt: true,
        })
      }

      if (signal.aborted) {
        return Promise.resolve({ behavior: 'deny', message: 'The request was cancelled.', interrupt: true })
      }

      return new Promise<PermissionResult>((resolve) => {
        const detail = buildToolTitle(toolName, input)
        const approval: PendingClaudeApproval = {
          requestId: toolUseID,
          toolCallId: toolUseID,
          question: title || (detail ? `Allow ${toolName}: ${detail}` : `Allow ${toolName}?`),
          options: [
            { optionId: 'approved', name: 'Yes', kind: 'allow' },
            { optionId: 'approved-for-session', name: 'Always', kind: 'allow' },
            { optionId: 'abort', name: 'No', kind: 'reject' },
          ],
          suggestions,
          input,
          resolve,
        }

        signal.addEventListener('abort', () => {
          const index = session.pendingApprovals.indexOf(approval)
          if (index >= 0) session.pendingApprovals.splice(index, 1)
          resolve({ behavior: 'deny', message: 'The request was cancelled.', interrupt: true })
        }, { once: true })

        session.pendingApprovals.push(approval)
        console.log(`[ClaudeCodeAdapter] Permission requested for ${toolName} (${toolUseID}) in session ${sessionKey}`)
        this.onDataAvailable?.(sessionKey)
      })
    }
  }

  /** Deny every outstanding permission request, e.g. when the turn is torn down. */
  private rejectPendingApprovals(session: ClaudeSession, message: string): void {
    const pending = session.pendingApprovals.splice(0)
    for (const approval of pending) {
      approval.resolve({ behavior: 'deny', message, interrupt: true })
    }
  }

  async initialize(): Promise<void> {
    await claudeSdk.ready()
  }

  async createSession(config: SessionConfig): Promise<string> {
    await claudeSdk.ready()

    // Claude Code requires UUID-format session IDs. The real ID arrives with the
    // first stream message; the first sendPrompt starts the query.
    const sessionId = randomUUID()
    this.sessions.set(sessionId, newClaudeSession('', config, false))

    console.log(`[ClaudeCodeAdapter] Session created: ${sessionId}`)
    return sessionId
  }

  /**
   * Public, side-effect-free read of the persisted session history from the
   * on-disk JSONL — no CLI/SDK spawn, no live session required. Used to backfill
   * the durable transcript projection once. Returns [] if the file is missing.
   */
  async getPersistedMessages(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const workspaceDir = config.workspaceDir
    if (!workspaceDir) return []
    try {
      return loadSessionHistory(sessionId, workspaceDir)
    } catch {
      return []
    }
  }

  async resumeSession(
    sessionId: string,
    config: SessionConfig
  ): Promise<SessionMessage[]> {
    await claudeSdk.ready()

    if (!isValidClaudeSessionId(sessionId)) {
      console.warn(`[ClaudeCodeAdapter] Invalid session ID format: ${sessionId}`)
      throw new Error(
        'INCOMPATIBLE_SESSION_ID: This session was created with a different coding agent and cannot be resumed with Claude Code.'
      )
    }

    cleanSessionFile(sessionId, config.workspaceDir)

    // The query starts (with `resume`) when the user sends the next prompt.
    this.sessions.set(sessionId, newClaudeSession(sessionId, config, true))
    console.log(`[ClaudeCodeAdapter] Session resumed: ${sessionId} (waiting for user prompt)`)

    const messages = loadSessionHistory(sessionId, config.workspaceDir)

    console.log(`[ClaudeCodeAdapter] Session loaded with ${messages.length} messages`)

    return messages
  }

  async sendPrompt(
    sessionId: string,
    parts: MessagePart[],
    config: SessionConfig
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const sdk = await claudeSdk.ready()

    const promptText = parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in prompt parts')
    }

    // The user message is not buffered: agent-manager already shows it.

    const isFirstPrompt = !session.queryIterator

    // A live query owns a persistent prompt stream. Add the next turn to that
    // stream instead of closing and recreating the harness process at every
    // normal idle boundary.
    if (!isFirstPrompt && session.enqueuePrompt) {
      session.sawResult = false
      session.status = 'busy'
      session.lastError = null
      session.enqueuePrompt(promptText)
      return
    }

    // Recovery path for an old or incomplete live-session state which has no
    // prompt queue. Close that process before creating a correct persistent one.
    if (!isFirstPrompt && session.queryIterator) {
      session.releasePrompt?.()
      session.releasePrompt = null
      session.enqueuePrompt = null
      session.abortController?.abort()
      if (session.streamTask) {
        try {
          await session.streamTask
        } catch {
          // Ignore errors during cleanup (abort errors are expected)
        }
      }
    }

    const claudePath = await findClaudeExecutable()

    const abortController = new AbortController()
    session.abortController = abortController

    const hooks = mergeHooks(buildSecretHooks(config), buildMcpToolLimitHooks(config))
    const effort = config.reasoningEffort === 'minimal' ? undefined : config.reasoningEffort
    const claudePermissionMode = claudeCodePermissionMode(config)

    const options: Options = {
      cwd: config.workspaceDir,
      pathToClaudeCodeExecutable: claudePath,
      env: buildClaudeEnvironment(),
      mcpServers: buildClaudeMcpServers(config),
      model: config.model,
      effort,
      systemPrompt: config.systemPrompt,
      abortController,
      // The agent's own permission setting (see ./permission-mode.ts). Only an
      // explicit 'allow' bypasses permission checks; 'ask' and an unset mode
      // run in Claude Code's asking mode, with each request routed to the 21x
      // approval UI through canUseTool.
      permissionMode: claudePermissionMode,
      // The SDK requires this flag to honour 'bypassPermissions'. Passing it for
      // any other mode would make that mode decorative.
      ...(claudePermissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : { canUseTool: this.buildCanUseTool(sessionId, session) }),
      ...buildIsolationOptions(config),
      ...(hooks ? { hooks } : {}),
    }

    // resume and continue are mutually exclusive.
    if (isFirstPrompt && session.isResumed) {
      options.resume = sessionId
    } else if (isFirstPrompt && session.sessionId) {
      // Process exited (error recovery or idle timeout) but session has a
      // valid Claude Code UUID. Resume from persistence so the agent keeps
      // its full conversation history instead of starting from scratch.
      options.resume = session.sessionId
    } else if (!isFirstPrompt) {
      options.continue = true
    }

    console.log('[ClaudeCodeAdapter] Starting query with options:', {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      continue: options.continue,
      resume: options.resume,
      isFirstPrompt,
      isResumed: session.isResumed,
      promptLength: promptText.length,
      promptPreview: promptText.substring(0, 100),
      hasEnv: !!options.env,
      hasMcpServers: !!options.mcpServers,
      mcpServerNames: options.mcpServers ? Object.keys(options.mcpServers) : [],
    })

    // ── Streaming-input prompt ──
    // Passing a plain string puts the Claude Code CLI in one-shot mode: it closes
    // stdin, and as soon as the turn emits `result` the process tears down and
    // KILLS any background task still in flight (observed as
    // `task_updated {status:'killed'}` / `task_notification {status:'stopped'}`).
    // Since Claude Code backgrounds Task-tool subagents by default, that silently
    // killed subagents the moment the coordinator's turn went quiet.
    //
    // The queue stays open across normal idle boundaries. This matches the
    // lifecycle used by the other push-based harness adapters: polling can stop,
    // while the provider event stream remains subscribed and can wake it later.
    const promptQueue: string[] = [promptText]
    let wakePromptReader: (() => void) | null = null
    let promptStreamClosed = false

    session.enqueuePrompt = (nextPrompt: string) => {
      if (promptStreamClosed) return
      promptQueue.push(nextPrompt)
      wakePromptReader?.()
      wakePromptReader = null
    }
    session.releasePrompt = () => {
      if (promptStreamClosed) return
      promptStreamClosed = true
      wakePromptReader?.()
      wakePromptReader = null
    }
    session.backgroundTasks.clear()
    session.sawResult = false

    const promptStream = (async function* () {
      while (!promptStreamClosed) {
        if (promptQueue.length === 0) {
          await new Promise<void>((resolve) => {
            wakePromptReader = resolve
          })
          continue
        }
        const nextPrompt = promptQueue.shift()!
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: nextPrompt },
          parent_tool_use_id: null,
        }
      }
    })()

    const query = sdk.query({
      prompt: promptStream,
      options,
    })

    console.log('[ClaudeCodeAdapter] Query created, starting stream consumption')

    session.queryIterator = query
    session.status = 'busy'
    session.lastError = null // Clear any previous error (e.g., rate limit) for recovery
    if (!isFirstPrompt) {
      session.messageBuffer = [] // Clear buffer for new messages (but keep history for first prompt)
      session.messageCursor = 0
    }

    if (isFirstPrompt && session.isResumed) {
      session.isResumed = false
    }

    session.streamTask = this.consumeStream(sessionId, session)
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { type: SessionStatusType.ERROR, message: 'Session not found' }
    }

    if (session.lastError) {
      return { type: SessionStatusType.ERROR, message: session.lastError }
    }

    if (session.pendingApprovals.length > 0) {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    // getStatus is the 2s poll path, so it is also where a stalled background
    // task gets aged out and a turn that finished between stream messages gets
    // settled — otherwise a lost terminal notification would pin BUSY forever.
    this.settleTurnIfComplete(sessionId, session)

    // A turn that ended while subagents are still running in the background is
    // paused, not finished. Reporting IDLE here makes agent-manager mark the task
    // ready_for_review, unregister it from polling (so the subagents' output can
    // never be delivered) and eventually reap the session — killing them.
    if (session.backgroundTasks.size > 0) {
      return { type: SessionStatusType.BUSY }
    }

    return {
      type: session.status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE,
    }
  }

  /**
   * Exposes in-flight background subagents as "running tools" so agent-manager's
   * delegation-aware watchdogs (which look for tool names like `task`/`agent`)
   * stand down instead of aborting a coordinator that is waiting on children.
   */
  async getRunningTools(
    sessionId: string,
    _config: SessionConfig
  ): Promise<Array<{ partId: string; toolName: string; startTime?: number; input?: Record<string, unknown> }>> {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    // Every entry is reported as `task` — a name in agent-manager's
    // DELEGATION_TOOL_NAMES set. Backgrounded work (subagent *and* bash) is
    // long-running by design, so it must be exempt from BOTH the 90s stuck-tool
    // detector and the 5min stuck-session watchdog; naming a backgrounded bash
    // 'bash' would instead get the session aborted after 90 seconds.
    return [...session.backgroundTasks.values()].map((t) => ({
      partId: `task-${t.taskId}`,
      toolName: 'task',
      startTime: t.startedAt,
      input: { taskType: t.taskType ?? 'unknown', description: t.description ?? '' },
    }))
  }

  async pollMessages(
    sessionId: string,
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    _config: SessionConfig
  ): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    const newParts: MessagePart[] = []

    const bufferLen = session.messageBuffer.length
    for (let i = session.messageCursor; i < bufferLen; i++) {
      const sdkMsg = session.messageBuffer[i]
      const msgId = this.getMessageId(sdkMsg)
      if (!msgId) continue

      const parts = convertSDKMessageToParts(sdkMsg, seenPartIds, partContentLengths)
      newParts.push(...parts)
    }
    session.messageCursor = bufferLen

    // Lets agent-manager re-key the session under Claude's real id.
    if (session.sessionId && session.sessionId !== sessionId && newParts.length > 0) {
      newParts[0].realSessionId = session.sessionId
    }

    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    console.log(`[ClaudeCodeAdapter] Aborting session ${sessionId}`)
    // Close the streaming-input prompt first so the generator can't keep the
    // process alive while we wait for the stream task to unwind.
    session.releasePrompt?.()
    session.releasePrompt = null
    session.enqueuePrompt = null
    session.backgroundTasks.clear()
    this.rejectPendingApprovals(session, 'The session was stopped.')
    session.abortController?.abort()

    if (session.streamTask) {
      console.log(`[ClaudeCodeAdapter] Waiting for stream cleanup...`)
      try {
        await session.streamTask
      } catch {
        // Ignore abort errors
      }
      console.log(`[ClaudeCodeAdapter] Stream cleanup complete`)
    }

    session.status = 'idle'
    console.log(`[ClaudeCodeAdapter] Session ${sessionId} aborted and set to idle`)
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    session.releasePrompt?.()
    session.releasePrompt = null
    session.enqueuePrompt = null
    session.backgroundTasks.clear()
    this.rejectPendingApprovals(session, 'The session was stopped.')
    session.abortController?.abort()

    if (session.streamTask) {
      try {
        await session.streamTask
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Re-keying keeps both the temporary and the real id.
    const keysToDelete: string[] = []
    for (const [key, sess] of this.sessions.entries()) {
      if (sess === session) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.sessions.delete(key)
      console.log(`[ClaudeCodeAdapter] Removed session key: ${key}`)
    }
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    // Same conversion as the live stream, so replayed part ids match and
    // mobile dedup works on reconnect.
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const messages: SessionMessage[] = []
    let currentMessage: SessionMessage | null = null
    let messageIdCounter = 0

    for (const msg of session.messageBuffer) {
      const msgRecord = msg as unknown as Record<string, unknown>
      const roleStr = (msgRecord.role || (msg.type === 'user' ? 'user' : 'assistant')) as string
      const role = roleStr === 'user' ? MessageRole.USER :
                   roleStr === 'system' ? MessageRole.SYSTEM :
                   MessageRole.ASSISTANT

      const parts = convertSDKMessageToParts(msg, seenPartIds, partContentLengths)
      if (parts.length === 0) continue

      if (!currentMessage || currentMessage.role !== role) {
        if (currentMessage) {
          messages.push(currentMessage)
        }
        currentMessage = {
          id: `msg-${messageIdCounter++}`,
          role,
          parts: []
        }
      }

      currentMessage!.parts.push(...parts)
    }

    if (currentMessage) {
      messages.push(currentMessage)
    }

    return messages
  }

  /**
   * The oldest tool-permission request waiting for the user, in the shape
   * agent-manager renders as a permission card. Only 'ask' mode creates these.
   */
  getPendingApproval(sessionId: string): {
    requestId: string
    toolCallId: string
    question: string
    options: Array<{ optionId: string; name: string; kind: string }>
  } | null {
    const approval = this.sessions.get(sessionId)?.pendingApprovals[0]
    if (!approval) return null
    const { requestId, toolCallId, question, options } = approval
    return { requestId, toolCallId, question, options }
  }

  /**
   * Answers a permission request from the approval UI. Returns false when the
   * request no longer exists (the turn ended or the app restarted), so
   * agent-manager can mark the card as expired.
   */
  async respondToApproval(
    sessionId: string,
    approved: boolean,
    optionId?: string,
    requestId?: string
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    const index = requestId
      ? session.pendingApprovals.findIndex((approval) => approval.requestId === requestId)
      : 0
    const approval = index >= 0 ? session.pendingApprovals[index] : undefined
    if (!approval) return false
    session.pendingApprovals.splice(index, 1)

    const allow = approved && !(optionId && DENY_APPROVAL_OPTIONS.has(optionId))
    console.log(`[ClaudeCodeAdapter] Permission ${approval.requestId} ${allow ? 'approved' : 'denied'} (${optionId ?? 'no option'})`)

    if (!allow) {
      approval.resolve({ behavior: 'deny', message: 'The user denied this request.', interrupt: true })
    } else if (optionId && ALWAYS_APPROVAL_OPTIONS.has(optionId) && approval.suggestions?.length) {
      // "Always" lasts for this session only. Claude Code's suggestions may
      // target settings files; keep them in memory rather than write to disk.
      approval.resolve({
        behavior: 'allow',
        updatedInput: approval.input,
        updatedPermissions: approval.suggestions.map((update) => ({ ...update, destination: 'session' as const })),
      })
    } else {
      approval.resolve({ behavior: 'allow', updatedInput: approval.input })
    }

    this.onDataAvailable?.(sessionId)
    return true
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig
  ): Promise<void> {
    // Claude Code runs with bypassPermissions, so AskUserQuestion ends the
    // session turn (it appears in permission_denials in the result message).
    // Send the user's answer as a follow-up prompt to continue the conversation.
    const answerText = Object.values(answers).filter(Boolean).join('\n')
    if (!answerText) {
      console.warn(`[ClaudeCodeAdapter] respondToQuestion called with empty answers for session ${sessionId}`)
      return
    }

    console.log(`[ClaudeCodeAdapter] Sending question answer as follow-up prompt for session ${sessionId}`)
    await this.sendPrompt(
      sessionId,
      [{ type: MessagePartType.TEXT, text: answerText }],
      config
    )
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      await claudeSdk.ready()
      return { available: true }
    } catch (error: unknown) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Lightweight message logger — only logs type/subtype to avoid blocking
   * the event loop with expensive JSON serialization on every streaming chunk.
   */
  private safeLogMessage(msg: SDKMessage): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as unknown as Record<string, unknown>
    console.log(`[ClaudeCodeAdapter] msg: type=${m.type} subtype=${m.subtype || '-'}`)
  }

  /**
   * Tells a deliberate abort apart from a real stream failure.
   *
   * The SDK's own abort error is `class AbortError extends Error {}` with **no
   * `name` override**, so `error.name` is the plain string `'Error'`, and the
   * message it throws from `waitForExit()` is `'Operation aborted'` — neither
   * `name === 'AbortError'` nor `message.includes('aborted by user')` matches it.
   * Every user stop, watchdog abort and session teardown therefore fell through
   * to the generic branch, which set `lastError` and made `getStatus()` report
   * ERROR forever: the transcript showed a red "Operation aborted" message, the
   * task flipped to `error`, polling stopped and a false "agent run failed"
   * event was recorded.
   *
   * The signal is the authoritative source: if we asked for the abort, the
   * failure is expected. The constructor and string checks stay as a safety net
   * for the case where a new query already replaced the controller.
   */
  private isAbortError(error: unknown, session: ClaudeSession): boolean {
    if (session.abortController?.signal.aborted) return true

    // Older SDK builds do not export the class; the string checks below cover them.
    const AbortErrorCtor = (claudeSdk.current() as { AbortError?: new (msg?: string) => Error } | null)?.AbortError
    if (AbortErrorCtor && error instanceof AbortErrorCtor) return true

    if (!(error instanceof Error)) return false
    if (error.name === 'AbortError') return true
    return error.message.includes('aborted by user') || error.message.includes('Operation aborted')
  }

  /** Consumes the query stream in the background and buffers its messages. */
  private async consumeStream(sessionId: string, session: ClaudeSession): Promise<void> {
    if (!session.queryIterator) return

    console.log('[ClaudeCodeAdapter] Starting stream consumption')

    try {
      let messagesSinceYield = 0
      for await (const message of session.queryIterator) {
        // Happens on process crashes, lock acquisition failures and SDK bugs.
        if (!message || typeof message !== 'object') {
          console.warn('[ClaudeCodeAdapter] Received invalid message from SDK, skipping:', typeof message)
          continue
        }

        const msg = message as unknown as Record<string, unknown>

        // A burst of messages resolves each next() as a microtask without ever
        // yielding to the macrotask queue, starving IPC, timers and rendering
        // (the UI freezes). Yield every 5 messages.
        messagesSinceYield++
        if (messagesSinceYield >= 5) {
          messagesSinceYield = 0
          await new Promise<void>((r) => setImmediate(r))
        }

        this.safeLogMessage(message)

        if (!session.sessionId && 'session_id' in msg) {
          const realSessionId = msg.session_id as string
          session.sessionId = realSessionId
          console.log(`[ClaudeCodeAdapter] Claude Code session ID: ${realSessionId}`)

          if (realSessionId !== sessionId) {
            console.log(`[ClaudeCodeAdapter] Adding session under real ID: ${realSessionId} (keeping temp ID ${sessionId} until agent-manager updates)`)
            this.sessions.set(realSessionId as string, session)
            // The temporary key stays: agent-manager polls with it to learn the
            // real id. destroySession removes both.
          }
        }

        if (msg.type === 'result' && msg.subtype === 'error_during_execution' && msg.is_error) {
          const errors = Array.isArray(msg.errors) ? msg.errors : []
          const sessionNotFound = errors.some((err: string) =>
            err.includes('No conversation found') || err.includes('session ID')
          )

          if (sessionNotFound) {
            console.warn('[ClaudeCodeAdapter] Session not found on Claude Code server:', errors)
            throw new Error(
              'INCOMPATIBLE_SESSION_ID: This session does not exist on Claude Code servers. It may have been created with a different coding agent or has expired.'
            )
          }
        }

        if (msg.type === 'result' && msg.is_error) {
          const raw = msg as Record<string, unknown>
          const errorText = resultErrorText(raw)
            ?? (typeof raw.subtype === 'string' && raw.subtype ? `Error during ${raw.subtype}` : 'Unknown error (no details in result message)')

          console.warn('[ClaudeCodeAdapter] Received error result:', errorText)
          console.warn('[ClaudeCodeAdapter] Full error result message:', JSON.stringify(raw, null, 2))
          session.status = 'error'
          session.lastError = errorText
        }

        if (msg.type === 'assistant' && (msg as Record<string, unknown>).isApiErrorMessage === true) {
          const raw = msg as Record<string, unknown>
          const messageField = raw.message as { content?: unknown[] } | undefined
          const contentField = Array.isArray(messageField?.content)
            ? messageField.content
            : Array.isArray(raw.content) ? raw.content as unknown[] : []
          const text = contentField
            .map((part) => {
              const partRecord = part as { type?: string; text?: string }
              return partRecord.type === 'text' ? partRecord.text || '' : ''
            })
            .filter(Boolean)
            .join('\n')
          session.status = 'error'
          session.lastError = text || 'Claude Code API error'
        }

        session.messageBuffer.push(message)

        if (session.messageBuffer.length > MAX_MESSAGE_BUFFER_SIZE) {
          const drop = session.messageBuffer.length - MAX_MESSAGE_BUFFER_SIZE
          session.messageBuffer.splice(0, drop)
          session.messageCursor = Math.max(0, session.messageCursor - drop)
        }

        this.onDataAvailable?.(sessionId)

        trackBackgroundTask(sessionId, session.backgroundTasks, message)

        if (msg.type === 'status') {
          console.log(`[ClaudeCodeAdapter] Status update: ${msg.subtype}`)
          if (msg.subtype === 'busy') {
            session.status = 'busy'
            session.sawResult = false
          } else if (msg.subtype === 'idle') {
            session.status = 'idle'
          }
        } else if (msg.type === 'result' && !msg.is_error) {
          console.log('[ClaudeCodeAdapter] Received result message')
          session.sawResult = true
        } else if (msg.type === 'assistant' || msg.type === 'user') {
          // A new turn started (e.g. a background task woke the session back up)
          session.sawResult = false
        }

        // The turn is only really over when `result` arrived AND nothing is left
        // running in the background.
        this.settleTurnIfComplete(sessionId, session)

        if (msg.type === 'stream_event' && msg.stderr) {
          console.error('[ClaudeCodeAdapter] Claude stderr:', msg.stderr)
        }
        if (msg.type === 'stream_event' && msg.stdout) {
          console.log('[ClaudeCodeAdapter] Claude stdout:', msg.stdout)
        }
      }
      console.log('[ClaudeCodeAdapter] Stream consumption completed normally')
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      const errStack = error instanceof Error ? error.stack : undefined
      if (this.isAbortError(error, session)) {
        console.log('[ClaudeCodeAdapter] Stream aborted by user')
      } else if (errMsg.includes('INCOMPATIBLE_SESSION_ID')) {
        console.warn('[ClaudeCodeAdapter] Incompatible session error detected')
        session.status = 'error'
        session.lastError = errMsg
      } else if (errMsg.includes('exited with code 1')) {
        console.error('[ClaudeCodeAdapter] Claude Code process failed:', errMsg)
        // A specific error from the result message (e.g. a rate limit) wins.
        if (!session.lastError && session.isResumed) {
          console.warn('[ClaudeCodeAdapter] Resume failed - session may not exist on Claude servers')
          session.status = 'error'
          session.lastError = 'INCOMPATIBLE_SESSION_ID: Failed to resume session. The session may have expired or does not exist on Claude Code servers.'
        } else if (!session.lastError) {
          session.status = 'error'
          session.lastError = errMsg
        }
      } else {
        console.error('[ClaudeCodeAdapter] Stream error:', error)
        console.error('[ClaudeCodeAdapter] Error stack:', errStack)
        console.error('[ClaudeCodeAdapter] Error details:', JSON.stringify(error, error instanceof Error ? Object.getOwnPropertyNames(error) : undefined, 2))
        session.status = 'error'
        session.lastError = errMsg
      }
    } finally {
      console.log('[ClaudeCodeAdapter] Stream consumption ended')
      // The process exited. With a stale iterator the next sendPrompt would use
      // `--continue` (most recent conversation in the directory) instead of
      // `--resume <sessionId>`, and pick up another session's (heartbeat,
      // subtask) conversation — the intermittent context-loss bug.
      session.queryIterator = null
      session.backgroundTasks.clear()
      this.rejectPendingApprovals(session, 'The session ended.')
      session.releasePrompt?.()
      session.releasePrompt = null
      session.enqueuePrompt = null
      if (session.status !== 'error') {
        session.status = 'idle'
        session.isResumed = true
      }
    }
  }

  /**
   * Marks the current turn idle once it has produced a `result` AND no
   * background task is still running. The streaming-input prompt remains open
   * for the full session lifetime. Until background work is complete,
   * the session stays BUSY so agent-manager keeps polling instead of calling
   * transitionToIdle (which flips the task to ready_for_review and eventually
   * lets the inactivity reaper destroy the session out from under the subagents).
   */
  private settleTurnIfComplete(sessionId: string, session: ClaudeSession): void {
    if (session.status === 'error') return
    pruneStaleBackgroundTasks(sessionId, session.backgroundTasks)
    if (!session.sawResult) return
    if (session.backgroundTasks.size > 0) {
      // Paused waiting on background work — explicitly NOT idle.
      session.status = 'busy'
      return
    }
    if (session.status !== 'idle') {
      console.log(`[ClaudeCodeAdapter] Turn complete for ${sessionId}, no background tasks left → idle`)
    }
    session.status = 'idle'
  }

  private getMessageId(msg: SDKMessage): string | null {
    if ('uuid' in msg && msg.uuid) {
      return msg.uuid
    }
    if ('message_id' in msg && msg.message_id) {
      return msg.message_id as string
    }
    return null
  }
}

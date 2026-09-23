/**
 * Claude Code Adapter
 *
 * Implements CodingAgentAdapter for Claude Code using @anthropic-ai/claude-agent-sdk.
 *
 * Key differences from OpenCode:
 * - Uses AsyncGenerator streaming API instead of HTTP client
 * - File-based session persistence (~/.claude/projects/)
 * - Different message format (SDKMessage vs OpenCode messages)
 */

import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
  AdapterUsageReport,
  BackendModel
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'
import { findClaudeExecutable } from './claude-code-executable'
import { cleanSessionFile, isValidClaudeSessionId, loadSessionHistory } from './claude-code-history'
import { buildToolTitle, ClaudeSystemSubtype, convertSDKMessageToParts, resultErrorText } from './claude-code-message-converter'
import { claudeCodePermissionMode } from './permission-mode'
import { claudeServerPrefix, claudeToolIds, resolveDisallowedToolNames } from '../mcp-tool-limits'
import { buildShellExports } from './shared/shell-exports'
import { ClaudeUsageAccumulator } from './usage-reports'

type ClaudeSDK = typeof import('@anthropic-ai/claude-agent-sdk')
type Query = import('@anthropic-ai/claude-agent-sdk').Query
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type Options = import('@anthropic-ai/claude-agent-sdk').Options
type McpServerConfig = import('@anthropic-ai/claude-agent-sdk').McpServerConfig
type HookCallback = import('@anthropic-ai/claude-agent-sdk').HookCallback
type HookCallbackMatcher = import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher
type CanUseTool = import('@anthropic-ai/claude-agent-sdk').CanUseTool
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult
type PermissionUpdate = import('@anthropic-ai/claude-agent-sdk').PermissionUpdate
type ModelInfo = import('@anthropic-ai/claude-agent-sdk').ModelInfo

let ClaudeAgentSDK: ClaudeSDK | null = null

/** Maximum number of messages to keep in the buffer per session */
const MAX_MESSAGE_BUFFER_SIZE = 500

/**
 * Terminal states for a Claude Code background task. Once a task reports one of
 * these (via `task_updated.patch.status` or `task_notification.status`) it is no
 * longer in flight and stops counting towards the session being BUSY.
 */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped'])

/**
 * Safety cap on how long a background task may be considered "in flight".
 * Because in-flight background work suppresses IDLE *and* exempts the session
 * from agent-manager's stuck-session watchdog, a task whose terminal
 * notification is lost would otherwise pin the session BUSY forever. Generous
 * enough that no legitimate subagent hits it.
 */
const MAX_BACKGROUND_TASK_AGE_MS = 60 * 60 * 1000 // 60 minutes

/** A subagent/bash task that Claude Code is running in the background. */
interface BackgroundTask {
  taskId: string
  /** SDK `task_type`, e.g. 'local_agent' (subagent) or 'local_bash'. */
  taskType?: string
  description?: string
  startedAt: number
}

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
const ALWAYS_APPROVAL_OPTIONS = new Set(['approved-for-session', 'allow-always'])

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
  /**
   * Subagent / bash tasks Claude Code is currently running in the background.
   * Claude Code backgrounds Task-tool subagents by default: the tool call returns
   * immediately, the assistant's turn ends (emitting `result`) and the subagent
   * keeps working, waking the session again via `task_notification`.  While this
   * map is non-empty the session is NOT done — it is paused waiting on children.
   */
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
  /** Per-turn token usage read from the stream (#97); reset with each new query() process. */
  usage?: ClaudeUsageAccumulator
}

type HookMap = Partial<Record<string, HookCallbackMatcher[]>>

/** Combine hook maps, keeping every matcher from each event. */
function mergeHooks(...maps: Array<HookMap | undefined>): HookMap | undefined {
  const merged: HookMap = {}
  for (const map of maps) {
    if (!map) continue
    for (const [event, matchers] of Object.entries(map)) {
      if (!matchers) continue
      merged[event] = [...(merged[event] || []), ...matchers]
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
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
  private sdkLoading: Promise<void> | null = null

  /**
   * Callback set by agent-manager to trigger an immediate poll cycle
   * when new stream data is buffered.  Eliminates the up-to-2-second
   * latency of the fixed-interval polling heartbeat.
   */
  onDataAvailable?: (sessionId: string) => void
  /** Set by agent-manager: receives the token usage the backend reports (#97). */
  onUsage?: (report: AdapterUsageReport) => void

  constructor() {
    this.sdkLoading = this.loadSDK()
  }

  /**
   * The MCP servers handed to the SDK, without the 21x-only `enabledTools` /
   * `knownTools` fields. The limit is enforced through `disallowedTools` and a
   * PreToolUse hook instead.
   */
  private buildClaudeMcpServers(config: SessionConfig): Record<string, McpServerConfig> | undefined {
    if (!config.mcpServers) return undefined
    const cleaned: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(config.mcpServers)) {
      const rest: Record<string, unknown> = { ...server }
      delete rest.enabledTools
      delete rest.knownTools
      cleaned[name] = rest
    }
    return cleaned as Record<string, McpServerConfig>
  }

  /**
   * MCP isolation and per-agent tool limits.
   *
   * `strictMcpConfig` makes the SDK use only the servers 21x passes in, instead
   * of also loading project `.mcp.json`, user MCP settings, plugins and agent
   * frontmatter. Without it the agent's MCP server selection, and the tool
   * limits below, could be widened by a file in the repository being worked on.
   *
   * `disallowedTools` removes each tool the agent may not use from the model's
   * context. It can only name tools the server advertised when its tool list
   * was last refreshed, so the PreToolUse hook from buildMcpToolLimitHooks
   * also rejects any other tool on a restricted server. The key is omitted
   * when nothing is restricted.
   */
  private buildIsolationOptions(config: SessionConfig): Partial<Options> {
    const disallowedTools: string[] = []
    for (const [name, server] of Object.entries(config.mcpServers || {})) {
      for (const tool of resolveDisallowedToolNames({
        serverTools: (server.knownTools || []).map(toolName => ({ name: toolName })),
        limit: server.enabledTools
      })) {
        disallowedTools.push(...claudeToolIds(name, tool))
      }
    }
    return {
      strictMcpConfig: true,
      ...(disallowedTools.length > 0 ? { disallowedTools } : {})
    }
  }

  /**
   * PreToolUse hook that denies any tool on a restricted MCP server that is not
   * in the agent's allowlist. Hooks run in every permission mode, including
   * bypassPermissions, so this holds even for tools added to the server after
   * the limit was saved.
   */
  private buildMcpToolLimitHooks(config: SessionConfig): Partial<Record<string, HookCallbackMatcher[]>> | undefined {
    const allowedByPrefix = new Map<string, Set<string>>()
    for (const [name, server] of Object.entries(config.mcpServers || {})) {
      if (server.enabledTools === undefined) continue
      const prefix = claudeServerPrefix(name)
      const allowed = allowedByPrefix.get(prefix) ?? new Set<string>()
      for (const tool of server.enabledTools) {
        for (const id of claudeToolIds(name, tool)) allowed.add(id)
      }
      allowedByPrefix.set(prefix, allowed)
    }
    if (allowedByPrefix.size === 0) return undefined

    const hook: HookCallback = async (input) => {
      const toolName = 'tool_name' in input ? String(input.tool_name) : ''
      for (const [prefix, allowed] of allowedByPrefix) {
        if (toolName.startsWith(prefix) && !allowed.has(toolName)) {
          console.warn(`[ClaudeCodeAdapter] Blocked MCP tool outside this agent's tool limit: ${toolName}`)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `${toolName} is not enabled for this agent.`
            }
          }
        }
      }
      return {}
    }

    return {
      PreToolUse: [{
        matcher: 'mcp__.*',
        hooks: [hook]
      }]
    }
  }

  /**
   * Build PreToolUse hooks for secret injection.
   * Registers a hook that prepends `export KEY='value'` lines to each Bash command.
   * The LLM never sees the modified command — only the original tool call and
   * the output appear in conversation context.
   */
  private buildSecretHooks(config: SessionConfig): Partial<Record<string, HookCallbackMatcher[]>> | undefined {
    const secretEnvVars = config.secretEnvVars
    if (!secretEnvVars || Object.keys(secretEnvVars).length === 0) {
      return undefined
    }

    const exportLines = buildShellExports(secretEnvVars)

    console.log(`[ClaudeCodeAdapter] Registering PreToolUse hook for secrets: [${Object.keys(secretEnvVars).join(', ')}]`)

    const hook: HookCallback = async (input) => {
      const toolInput = ('tool_input' in input ? input.tool_input : undefined) as Record<string, unknown> | undefined
      if (!toolInput?.command) {
        return {}
      }

      const originalCommand = toolInput.command as string
      const modifiedCommand = exportLines + '\n' + originalCommand

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: {
            ...toolInput,
            command: modifiedCommand
          }
        }
      }
    }

    return {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [hook]
      }]
    }
  }

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

  private async loadSDK(): Promise<void> {
    try {
      ClaudeAgentSDK = await import('@anthropic-ai/claude-agent-sdk')
      console.log('[ClaudeCodeAdapter] SDK loaded successfully')
    } catch (error) {
      console.error('[ClaudeCodeAdapter] Failed to load SDK:', error)
      ClaudeAgentSDK = null
    } finally {
      this.sdkLoading = null
    }
  }

  private async ensureSDKLoaded(): Promise<void> {
    if (ClaudeAgentSDK) return
    if (this.sdkLoading) {
      await this.sdkLoading
    }
    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK failed to load')
    }
  }

  async initialize(): Promise<void> {
    await this.ensureSDKLoaded()
  }

  async createSession(config: SessionConfig): Promise<string> {
    await this.ensureSDKLoaded()
    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK not loaded')
    }

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
    await this.ensureSDKLoaded()
    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK not loaded')
    }

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

    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK not loaded')
    }

    const promptText = parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in prompt parts')
    }

    // Note: Don't add user message to buffer - agent-manager already shows it
    // to avoid duplicate messages in UI

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

    // Build options
    const hooks = mergeHooks(this.buildSecretHooks(config), this.buildMcpToolLimitHooks(config))
    const effort = config.reasoningEffort === 'minimal' ? undefined : config.reasoningEffort
    const claudePermissionMode = claudeCodePermissionMode(config)

    const options: Options = {
      cwd: config.workspaceDir,
      pathToClaudeCodeExecutable: claudePath,
      env: this.buildClaudeEnvironment(),
      mcpServers: this.buildClaudeMcpServers(config),
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
      ...this.buildIsolationOptions(config),
      ...(hooks ? { hooks } : {}),
    }

    // Determine session continuation mode
    if (isFirstPrompt && session.isResumed) {
      // First prompt after resume: use resume to load persisted session
      options.resume = sessionId
      // Don't use continue with resume - they're mutually exclusive
    } else if (isFirstPrompt && session.sessionId) {
      // Process exited (error recovery or idle timeout) but session has a
      // valid Claude Code UUID. Resume from persistence so the agent keeps
      // its full conversation history instead of starting from scratch.
      options.resume = session.sessionId
    } else if (!isFirstPrompt) {
      // Subsequent prompts: continue existing session in same process
      options.continue = true
    }
    // Otherwise: brand-new session, no continue/resume needed

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

    const query = ClaudeAgentSDK.query({
      prompt: promptStream,
      options,
    })

    console.log('[ClaudeCodeAdapter] Query created, starting stream consumption')

    session.queryIterator = query
    // Usage totals are per query() process: a new process starts them again.
    session.usage?.reset()
    session.status = 'busy'
    session.lastError = null // Clear any previous error (e.g., rate limit) for recovery
    if (!isFirstPrompt) {
      session.messageBuffer = [] // Clear buffer for new messages (but keep history for first prompt)
      session.messageCursor = 0
    }

    // After first prompt in a resumed session, clear the flag so subsequent prompts use continue
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

    // Process only NEW buffered messages using cursor (avoids re-scanning entire buffer)
    const bufferLen = session.messageBuffer.length
    for (let i = session.messageCursor; i < bufferLen; i++) {
      const sdkMsg = session.messageBuffer[i]
      const msgId = this.getMessageId(sdkMsg)
      if (!msgId) continue

      const parts = this.convertSDKMessageToParts(sdkMsg, seenPartIds, partContentLengths)
      newParts.push(...parts)
    }
    session.messageCursor = bufferLen

    // If we have the real Claude session ID and it's different from the map key,
    // include it in the first part so agent-manager can update the database
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

    // Remove all references to this session (both temp ID and real ID)
    // Since re-keying keeps both keys, we need to clean up both
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

    // Reuse the same convertSDKMessageToParts() that the live streaming path uses.
    // This ensures replay produces the same message structure (IDs, content, tool
    // fields) as the original live stream, which is critical for:
    //   - Correct content extraction from nested message.content[] arrays
    //   - Proper tool names (tool_name vs name), statuses, and titles
    //   - Consistent part IDs so mobile dedup works on reconnect
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

      const parts = this.convertSDKMessageToParts(msg, seenPartIds, partContentLengths)
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

  /**
   * Asks the installed Claude Code CLI which models it offers. The query never
   * gets a prompt, so no turn runs; it is closed once the list arrives.
   */
  async listModels(): Promise<BackendModel[]> {
    await this.ensureSDKLoaded()
    const q = ClaudeAgentSDK!.query({
      prompt: (async function* () { await new Promise<never>(() => {}) })(),
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: await findClaudeExecutable(),
        env: this.buildClaudeEnvironment()
      }
    })
    try {
      return claudeModelsFromInfo(await q.supportedModels())
    } finally {
      q.close()
    }
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.ensureSDKLoaded()
      if (!ClaudeAgentSDK) {
        return { available: false, reason: 'Claude Agent SDK not loaded' }
      }
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

    let AbortErrorCtor: (new (msg?: string) => Error) | undefined
    try {
      AbortErrorCtor = (ClaudeAgentSDK as { AbortError?: new (msg?: string) => Error } | null)
        ?.AbortError
    } catch {
      // Older SDK builds do not export the class; fall through to the string checks.
      AbortErrorCtor = undefined
    }
    if (AbortErrorCtor && error instanceof AbortErrorCtor) return true

    if (!(error instanceof Error)) return false
    if (error.name === 'AbortError') return true
    return error.message.includes('aborted by user') || error.message.includes('Operation aborted')
  }

  /**
   * Consumes the query stream in the background and buffers messages
   */
  /** Reports a turn's token usage when its `result` arrives (#97). Never throws. */
  private observeUsage(sessionId: string, session: ClaudeSession, message: unknown): void {
    try {
      session.usage ??= new ClaudeUsageAccumulator()
      const body = session.usage.observe(message)
      if (body && this.onUsage) this.onUsage({ sessionId, ...body })
    } catch (err) {
      console.warn('[ClaudeCodeAdapter] Could not read turn usage:', err instanceof Error ? err.message : err)
    }
  }

  private async consumeStream(sessionId: string, session: ClaudeSession): Promise<void> {
    if (!session.queryIterator) return

    console.log('[ClaudeCodeAdapter] Starting stream consumption')

    try {
      let messagesSinceYield = 0
      for await (const message of session.queryIterator) {
        // Guard against undefined/null messages from the SDK (can happen during
        // process crashes, lock acquisition failures, or SDK bugs)
        if (!message || typeof message !== 'object') {
          console.warn('[ClaudeCodeAdapter] Received invalid message from SDK, skipping:', typeof message)
          continue
        }

        const msg = message as unknown as Record<string, unknown>

        // ── Prevent microtask starvation ──
        // When the subprocess sends a burst of messages, the async iterator
        // resolves each next() as a microtask without ever yielding to the
        // macrotask queue.  This starves IPC, timers, and rendering callbacks,
        // making the UI completely unresponsive (loading cursor).
        // Yield every 5 messages so the event loop can process I/O.
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

          // Add the session under the real ID (keep old ID too until agent-manager updates)
          // This allows pollMessages to work with both IDs during transition
          if (realSessionId !== sessionId) {
            console.log(`[ClaudeCodeAdapter] Adding session under real ID: ${realSessionId} (keeping temp ID ${sessionId} until agent-manager updates)`)
            this.sessions.set(realSessionId as string, session)
            // Don't delete the old sessionId yet - agent-manager needs to poll with it
            // to receive the realSessionId. The old key will be deleted by destroySession
            // or when agent-manager explicitly removes it.
          }
        }

        // Check for session not found error BEFORE buffering
        if (msg.type === 'result' && msg.subtype === 'error_during_execution' && msg.is_error) {
          const errors = Array.isArray(msg.errors) ? msg.errors : []
          const sessionNotFound = errors.some((err: string) =>
            err.includes('No conversation found') || err.includes('session ID')
          )

          if (sessionNotFound) {
            console.warn('[ClaudeCodeAdapter] Session not found on Claude Code server:', errors)
            // Don't buffer this error message - throw immediately
            throw new Error(
              'INCOMPATIBLE_SESSION_ID: This session does not exist on Claude Code servers. It may have been created with a different coding agent or has expired.'
            )
          }
        }

        // Handle error result messages (e.g., rate limits) before treating as normal
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

        this.observeUsage(sessionId, session, message)

        session.messageBuffer.push(message)

        // Cap buffer size to prevent unbounded memory growth.
        // Drop already-processed messages from the front when limit is exceeded.
        if (session.messageBuffer.length > MAX_MESSAGE_BUFFER_SIZE) {
          const drop = session.messageBuffer.length - MAX_MESSAGE_BUFFER_SIZE
          session.messageBuffer.splice(0, drop)
          session.messageCursor = Math.max(0, session.messageCursor - drop)
        }

        // Notify the polling coordinator that new data is available so it can
        // deliver this message to the UI immediately instead of waiting for
        // the next 2-second heartbeat tick.
        if (this.onDataAvailable) {
          this.onDataAvailable(sessionId)
        }

        // Track background subagent/bash tasks so we never report the session as
        // finished while children are still running.
        this.trackBackgroundTask(sessionId, session, message)

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
        // Don't set error status - this is normal when sending a new message
      } else if (errMsg.includes('INCOMPATIBLE_SESSION_ID')) {
        // Store temporarily so resumeSession can detect and re-throw it
        console.warn('[ClaudeCodeAdapter] Incompatible session error detected')
        session.status = 'error'
        session.lastError = errMsg
      } else if (errMsg.includes('exited with code 1')) {
        // Claude Code process failed - could be rate limit, resume failure, or other error
        console.error('[ClaudeCodeAdapter] Claude Code process failed:', errMsg)
        // Only treat as incompatible session if this was a resumed session AND we
        // don't already have a specific error from the result message (e.g., rate limits).
        // Note: session.config is always set, so only check session.isResumed here.
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
      // Always reset queryIterator when the stream ends (process exited).
      // Previously only error paths did this, leaving a truthy-but-exhausted
      // iterator after normal completion.  That caused the next sendPrompt to
      // use `--continue` (most-recent conversation in directory) instead of
      // `--resume <sessionId>` (exact session).  If any other session
      // (heartbeat, subtask) ran in the same directory during idle, --continue
      // would pick up the wrong conversation — the intermittent context-loss bug.
      session.queryIterator = null
      // The process is gone, so nothing can still be running in the background.
      session.backgroundTasks.clear()
      this.rejectPendingApprovals(session, 'The session ended.')
      session.releasePrompt?.()
      session.releasePrompt = null
      session.enqueuePrompt = null
      if (session.status !== 'error') {
        session.status = 'idle'
        // Mark as resumed so the next sendPrompt uses --resume with the exact
        // session ID rather than --continue (which targets most-recent in dir).
        session.isResumed = true
      }
    }
  }

  /**
   * Maintains `session.backgroundTasks` from the SDK's task lifecycle messages.
   *
   * Note: the raw CLI also emits `background_tasks_changed` (which carries the
   * authoritative in-flight list), but the SDK filters it out — it is not part of
   * the `SDKMessage` union — so the set has to be rebuilt from task_started plus
   * task_updated / task_notification.
   */
  private trackBackgroundTask(sessionId: string, session: ClaudeSession, message: SDKMessage): void {
    const msg = message as unknown as {
      type?: string
      subtype?: string
      task_id?: string
      task_type?: string
      subagent_type?: string
      description?: string
      status?: string
      patch?: { status?: string }
      tasks?: Array<{ task_id?: string; task_type?: string; description?: string }>
    }
    if (msg.type !== 'system') return

    // `background_tasks_changed` carries the CLI's authoritative in-flight list.
    // SDK >= 0.3.x filters it out (verified against 0.3.169 and 0.3.195), but the
    // app has historically bundled older SDKs that do pass it through — prefer it
    // when available, since it cannot drift the way reconstruction can.
    if (msg.subtype === ClaudeSystemSubtype.BACKGROUND_TASKS_CHANGED && Array.isArray(msg.tasks)) {
      const next = new Map<string, BackgroundTask>()
      for (const t of msg.tasks) {
        if (!t?.task_id) continue
        const existing = session.backgroundTasks.get(t.task_id)
        next.set(t.task_id, {
          taskId: t.task_id,
          taskType: t.task_type ?? existing?.taskType,
          description: t.description ?? existing?.description,
          // Preserve the original start time so the staleness cap stays meaningful.
          startedAt: existing?.startedAt ?? Date.now(),
        })
      }
      session.backgroundTasks = next
      console.log(
        `[ClaudeCodeAdapter] Background task list for ${sessionId} refreshed from ` +
        `background_tasks_changed — ${next.size} in flight`
      )
      return
    }

    if (!msg.task_id) return

    if (msg.subtype === ClaudeSystemSubtype.TASK_STARTED) {
      session.backgroundTasks.set(msg.task_id, {
        taskId: msg.task_id,
        taskType: msg.task_type || (msg.subagent_type ? 'local_agent' : undefined),
        description: msg.description,
        startedAt: Date.now(),
      })
      console.log(
        `[ClaudeCodeAdapter] Background task started for ${sessionId}: ${msg.task_id} ` +
        `(${msg.task_type || 'unknown'}) — ${session.backgroundTasks.size} in flight`
      )
      return
    }

    const terminalStatus =
      msg.subtype === ClaudeSystemSubtype.TASK_NOTIFICATION ? msg.status :
      msg.subtype === ClaudeSystemSubtype.TASK_UPDATED ? msg.patch?.status :
      undefined

    if (terminalStatus && TERMINAL_TASK_STATUSES.has(terminalStatus)) {
      if (session.backgroundTasks.delete(msg.task_id)) {
        console.log(
          `[ClaudeCodeAdapter] Background task ${msg.task_id} ${terminalStatus} for ${sessionId} — ` +
          `${session.backgroundTasks.size} still in flight`
        )
      }
    }
  }

  /**
   * Drops background tasks that have outlived MAX_BACKGROUND_TASK_AGE_MS so a
   * lost terminal notification can't keep the session BUSY (and un-reapable)
   * indefinitely.
   */
  private pruneStaleBackgroundTasks(sessionId: string, session: ClaudeSession): void {
    if (session.backgroundTasks.size === 0) return
    const now = Date.now()
    for (const [taskId, task] of session.backgroundTasks) {
      if (now - task.startedAt > MAX_BACKGROUND_TASK_AGE_MS) {
        session.backgroundTasks.delete(taskId)
        console.warn(
          `[ClaudeCodeAdapter] Background task ${taskId} for ${sessionId} exceeded ` +
          `${MAX_BACKGROUND_TASK_AGE_MS / 60000}min without a terminal notification — ` +
          `no longer counting it as in flight`
        )
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
    this.pruneStaleBackgroundTasks(sessionId, session)
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

  /**
   * Extracts a unique message ID from SDKMessage
   */
  private getMessageId(msg: SDKMessage): string | null {
    if ('uuid' in msg && msg.uuid) {
      return msg.uuid
    }
    if ('message_id' in msg && msg.message_id) {
      return msg.message_id as string
    }
    return null
  }

  private convertSDKMessageToParts(
    msg: SDKMessage,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>
  ): MessagePart[] {
    return convertSDKMessageToParts(msg, seenPartIds, partContentLengths)
  }

  /**
   * Environment for the Claude process. CLAUDECODE is removed so the CLI does
   * not refuse to start as a nested session.
   */
  private buildClaudeEnvironment(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>
    delete env.CLAUDECODE
    return env
  }
}

/**
 * Turns the CLI's model rows into pinned ids. Aliases such as `opus` resolve
 * to a new model when Claude Code updates, so an alias row is offered by the
 * id it resolves to now. A row that already names a model keeps its value,
 * which can carry a context suffix (`[1m]`) its resolved id drops. The
 * `default` row repeats one of the others.
 */
export function claudeModelsFromInfo(rows: ModelInfo[]): BackendModel[] {
  const models: BackendModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.value === 'default') continue
    const id = row.value.startsWith('claude-') ? row.value : row.resolvedModel || row.value
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: `${row.displayName} (${id})` })
  }
  return models
}

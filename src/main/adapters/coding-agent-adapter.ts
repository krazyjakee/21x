import type { ReasoningEffort } from '../../shared/reasoning-effort'

export enum SessionStatusType {
  IDLE = 'idle',
  BUSY = 'busy',
  RETRY = 'retry',
  ERROR = 'error',
  WAITING_APPROVAL = 'waiting_approval'
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system'
}

export enum MessagePartType {
  TEXT = 'text',
  REASONING = 'reasoning',
  TOOL = 'tool',
  QUESTION = 'question',
  IMAGE = 'image',
  ERROR = 'error',
  /** Recoverable provider error: the backend is retrying the request itself. */
  RETRY = 'retry',
  TASK_PROGRESS = 'task_progress'
}

export interface McpServerConfig {
  name?: string
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /**
   * The tools this agent may use from this server (the per-agent limit set in
   * the agent form). `undefined` means every tool; an empty array means none.
   * Adapters must not forward this field to the backend as server config.
   */
  enabledTools?: string[]
  /**
   * Every tool the server advertised when its tool list was last refreshed, so
   * an adapter that can only express a deny list can compute one. Populated
   * alongside `enabledTools`; ignored when that is undefined.
   */
  knownTools?: string[]
}

export interface SessionConfig {
  agentId: string
  taskId: string
  workspaceDir: string
  serverUrl?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  systemPrompt?: string
  /**
   * Per-tool enable map, by tool name. Consumed by the OpenCode adapter, which
   * passes it straight through to `session.prompt`. Filled from the agent's
   * MCP tool limits.
   */
  tools?: Record<string, boolean>
  promptAbort?: AbortController
  mcpServers?: Record<string, McpServerConfig>
  /** Claude Code auth method: 'subscription' (OAuth/Pro/Max) or 'api_key' (pay-per-use). Defaults to 'subscription'. */
  authMethod?: 'subscription' | 'api_key'
  permissionMode?: 'ask' | 'allow'
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  apiKeys?: {
    openai?: string
    anthropic?: string
    cursor?: string
  }
  /** Port of the local secret broker HTTP server */
  secretBrokerPort?: number
  /** Per-session token for authenticating with the secret broker */
  secretSessionToken?: string
  /** Absolute path to the secret-shell.sh wrapper script */
  secretShellPath?: string
  /** Decrypted secret env vars to inject directly into the agent process env.
   *  Used when the agent runtime doesn't respect $SHELL (e.g. Claude Code). */
  secretEnvVars?: Record<string, string>
  /** Whether the OpenCode tillDone runtime plugin should enforce todo completion for this session. */
  tillDone?: boolean
}

export interface SessionStatus {
  type: SessionStatusType
  message?: string
}

export interface SessionMessage {
  id: string
  role: MessageRole
  parts: MessagePart[]
}

export interface MessagePart {
  id?: string
  type: MessagePartType
  text?: string
  content?: string
  role?: 'user' | 'assistant' | 'system'
  tool?: {
    name: string
    status?: string
    title?: string
    description?: string
    input?: unknown
    output?: unknown
    error?: string
    requestId?: string
    questions?: unknown
    todos?: unknown
  }
  state?: {
    status?: string
    title?: string
    input?: unknown
    output?: unknown
    error?: string
  }
  update?: boolean // Mark as update to existing message
  realSessionId?: string // Real session ID from backend (for updating database)
  receivedAt?: number // Unix ms when this event was originally received (for replay timestamp preservation)
  taskProgress?: {
    taskId: string
    status: 'started' | 'running' | 'completed' | 'failed' | 'stopped'
    description: string
    lastToolName?: string
    summary?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  }
}

export interface PendingApproval {
  requestId?: string | number
  toolCallId: string
  question: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

/** The interface every coding agent backend implements. */
export interface CodingAgentAdapter {
  initialize(): Promise<void>

  /** @returns the backend's session id */
  createSession(config: SessionConfig): Promise<string>

  /** Reattaches to a persisted session; returns its history. */
  resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>

  sendPrompt(
    sessionId: string,
    parts: MessagePart[],
    config: SessionConfig
  ): Promise<void>

  getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus>

  /**
   * Parts that are new or changed since the last poll. The adapter records
   * what it returned in the dedup structures it is given.
   */
  pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    config: SessionConfig
  ): Promise<MessagePart[]>

  /** The live session's full message list (output fields, idle replay, debug copy). */
  getAllMessages?(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>

  /**
   * Read the session's PERSISTED history from durable storage (e.g. the CLI's
   * on-disk session file) WITHOUT requiring a live/in-memory session or spawning
   * the agent. Used to backfill the durable transcript projection once for
   * sessions that predate write-through. Parts should carry `receivedAt` (real
   * event time) so the projection stores true timestamps.
   * @returns Persisted messages, or [] when unavailable.
   */
  getPersistedMessages?(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>

  abortPrompt(sessionId: string, config: SessionConfig): Promise<void>

  /**
   * Tools currently running. Used by the stuck-tool detector to abort tools
   * that hang without producing data (e.g. cross-workspace file reads that the
   * server silently blocks).
   */
  getRunningTools?(sessionId: string, config: SessionConfig): Promise<Array<{
    partId: string
    toolName: string
    startTime?: number // Unix ms when the tool started
    lastActivityTime?: number // Unix ms when the tool most recently produced output
    lastActivityMonotonicTime?: number // Monotonic ms when output was last observed
    input?: Record<string, unknown> // Tool input (e.g. { filePath: "..." })
  }>>

  destroySession(sessionId: string, config: SessionConfig): Promise<void>

  /**
   * Respond to a pending question (AskUserQuestion tool call).
   * Agent-manager passes structured answers; each adapter delivers them
   * in whatever format its backend expects.
   *
   * @param answers Map of question header/label → selected answer text
   */
  respondToQuestion?(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig,
    requestId?: string
  ): Promise<boolean | void | { handled: boolean; resolutionPart?: MessagePart }>

  /** The oldest tool-permission request waiting for the user, rendered as a permission card. */
  getPendingApproval?(sessionId: string): PendingApproval | null

  /**
   * Answers a permission request. `false` means no matching request exists
   * (the turn ended or the app restarted), so the card can be marked expired.
   */
  respondToApproval?(
    sessionId: string,
    approved: boolean,
    optionId?: string,
    requestId?: string
  ): Promise<boolean | void>

  /**
   * List available providers and their models from the backend.
   * Returns null if the backend doesn't support provider listing.
   */
  getProviders?(
    serverUrl?: string,
    directory?: string
  ): Promise<{
    providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
    default: Record<string, string>
  } | null>

  /**
   * Notify the adapter that provider/auth config has changed (e.g. user edited
   * agent settings, provider key was rotated).  Adapters that manage a shared
   * backend server (like OpenCode) should push the updated config.
   *
   * Only call this on actual config changes — NOT on every session creation,
   * as some backends (OpenCode) tear down all running sessions on config update.
   */
  notifyConfigChanged?(): Promise<void>

  checkHealth(): Promise<{ available: boolean; reason?: string }>

  /**
   * Optional callback invoked by the adapter when new data is buffered and
   * ready for consumption.  The polling coordinator uses this to trigger an
   * immediate poll cycle instead of waiting for the next 2-second heartbeat,
   * which dramatically reduces perceived latency during active streaming.
   *
   * Set by agent-manager when the session is registered for polling.
   *
   * Lifecycle contract: an IDLE status ends only the current turn. It must not
   * close the adapter session or disable this callback. Push transports and
   * subscriptions must stay open until destroySession() or an explicit abort
   * closes them. This lets late harness events wake an idle session without a
   * continuous polling loop.
   */
  onDataAvailable?: (sessionId: string) => void
}

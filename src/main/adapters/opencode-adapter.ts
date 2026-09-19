import { homedir } from 'os'
import type { DatabaseManager } from '../database'
import type {
  CodingAgentAdapter,
  McpServerConfig,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart
} from './coding-agent-adapter'
import { SessionStatusType } from './coding-agent-adapter'
import { attachAndVerifyMcpServers, disconnectMcpServers, type McpAttachResult } from './opencode-mcp'
import {
  removeRuntimePluginFiles,
  setTillDoneSession,
  writeRuntimePluginFiles
} from './opencode-runtime-plugins'
import { DEFAULT_SERVER_URL, OpencodeServer, type OpencodeClient } from './opencode-server'
import { runPromptWithRetry } from './opencode-prompt'
import {
  convertAllMessages,
  convertPolledParts,
  convertResumedMessages,
  findActiveToolInLastAssistantMessage,
  listRunningTools,
  type OpencodeMessage
} from './opencode-messages'
import { ALWAYS_APPROVAL_OPTIONS } from './shared/approval-options'

type V2QuestionRequest = import('@opencode-ai/sdk/v2/client').QuestionRequest

type SessionMcpConfig = Record<string, McpServerConfig>

interface ProvidersResult {
  providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
  default: Record<string, string>
}

/**
 * How long the history fetched by pollMessages is reused. One poll cycle calls
 * pollMessages, then getStatus and (when busy) getRunningTools, all of which
 * read the full session history; within a cycle they share one fetch.
 */
const POLL_CYCLE_CACHE_MS = 1_000

/** OpenCode permission replies: "once" (allow this time), "always" (remember), "reject" (deny). */
function permissionReply(approved: boolean, optionId?: string): 'once' | 'always' | 'reject' {
  if (!approved) return 'reject'
  return optionId && ALWAYS_APPROVAL_OPTIONS.has(optionId) ? 'always' : 'once'
}

/**
 * Adapter for the OpenCode backend. One shared `opencode serve` process (spawned
 * or adopted) serves every session over HTTP; permission prompts arrive over SSE.
 */
export class OpencodeAdapter implements CodingAgentAdapter {
  /** Set by agent-manager to trigger an immediate poll cycle. */
  onDataAvailable?: (sessionId: string) => void
  private server: OpencodeServer
  private clients: Map<string, OpencodeClient> = new Map()
  /** No-timeout clients, used ONLY for session.prompt(), which runs for the whole agent loop. */
  private promptClients: Map<string, OpencodeClient> = new Map()
  private promptAborts: Map<string, AbortController> = new Map()
  /** Prompt errors, surfaced by the next getStatus. */
  private promptErrors: Map<string, string> = new Map()
  private polledMessages: Map<string, { at: number; messages: OpencodeMessage[] }> = new Map()
  private pluginFilePaths: string[] = []
  private runtimeSupportFilePaths: string[] = []
  private tillDoneConfigPath: string | null = null
  /** Permission requests from SSE, per session (parallel tool calls can queue several). */
  private pendingPermissions: Map<string, Array<{ permissionId: string; permission: string; patterns: string[] }>> = new Map()
  private sessionPermissionModes: Map<string, 'ask' | 'allow'> = new Map()
  /** Needed for permission replies and other session-scoped calls started from global SSE events. */
  private sessionWorkspaceDirs: Map<string, string> = new Map()
  /** Kept to re-register MCP servers when OpenCode drops them (see handleInstanceDisposed). */
  private sessionMcpConfigs: Map<string, SessionMcpConfig> = new Map()
  /**
   * MCP servers that could not be attached, per session. Read by agent-manager
   * so the session documentation does not advertise tools that are not there.
   */
  private sessionMcpAttachFailures: Map<string, string[]> = new Map()
  /**
   * The MCP config already registered, as `directory -> name -> serialized
   * config`. Used to skip a re-add that would rebuild a server another session
   * is currently using. See attachAndVerifyMcpServers.
   */
  private directoryMcpConfigs: Map<string, Map<string, string>> = new Map()

  constructor(db?: Pick<DatabaseManager, 'getSetting'>) {
    this.server = new OpencodeServer({
      pluginFilePaths: () => this.pluginFilePaths,
      busyDirectories: () => this.promptAborts.size > 0 ? [...new Set(this.sessionWorkspaceDirs.values())] : null,
      onEvent: (event) => this.handleServerEvent(event)
    }, db)
  }

  async initialize(): Promise<void> {
    await this.server.loadSdk()
  }

  private getDirectoryMcpConfigs(workspaceDir: string | undefined): Map<string, string> {
    const key = workspaceDir ?? ''
    let entry = this.directoryMcpConfigs.get(key)
    if (!entry) {
      entry = new Map<string, string>()
      this.directoryMcpConfigs.set(key, entry)
    }
    return entry
  }

  /**
   * Re-attach the MCP servers of every live session after OpenCode threw away the
   * instance that held them.
   *
   * OpenCode disposes and re-creates the instance of a directory on its own — a
   * config patch on that directory is enough. The new instance starts from the
   * config files, so it keeps only the servers declared in
   * `.opencode/opencode.json`, and the running session loses the rest from its tool
   * list without any error. This handler is the second line of defence behind that
   * file: it re-registers the servers and, above all, it makes the drop visible.
   * Without it the first sign of trouble is the model calling a tool that the
   * session no longer has.
   */
  private async handleInstanceDisposed(directory: string | undefined, eventType: string): Promise<void> {
    // `global.disposed` carries no directory: every instance is gone.
    const affected: string[] = []
    for (const [sessionId, mcpServers] of this.sessionMcpConfigs.entries()) {
      if (Object.keys(mcpServers).length === 0) continue
      if (directory && this.sessionWorkspaceDirs.get(sessionId) !== directory) continue
      affected.push(sessionId)
    }
    if (affected.length === 0) return

    console.error(
      `[OpencodeAdapter] MCP DROPPED — OpenCode ${eventType}` +
      `${directory ? ` for ${directory}` : ' (all directories)'}. ` +
      `${affected.length} live session(s) lost their MCP tools mid-conversation; re-attaching: ${affected.join(', ')}`
    )

    for (const sessionId of affected) {
      const mcpServers = this.sessionMcpConfigs.get(sessionId)
      const ocClient = this.clients.get(sessionId)
      if (!mcpServers || !ocClient) continue

      try {
        const sessionDir = this.sessionWorkspaceDirs.get(sessionId)
        const result = await attachAndVerifyMcpServers(
          ocClient,
          mcpServers,
          sessionDir,
          `instanceDisposed session=${sessionId}`,
          this.getDirectoryMcpConfigs(sessionDir)
        )
        this.setMcpAttachFailures(sessionId, result.failed)
        if (result.failed.length === 0) {
          console.log(`[OpencodeAdapter] MCP re-attached after ${eventType} for session ${sessionId}`)
        }
      } catch (err) {
        console.error(
          `[OpencodeAdapter] MCP re-attach failed for session ${sessionId}:`,
          err instanceof Error ? err.message : err
        )
      }
    }
  }

  private setMcpAttachFailures(sessionId: string, failed: string[]): void {
    if (failed.length > 0) {
      this.sessionMcpAttachFailures.set(sessionId, [...failed])
    } else {
      this.sessionMcpAttachFailures.delete(sessionId)
    }
  }

  /** MCP servers configured for the session that are NOT attached, so none of their tools can be called. */
  getMcpAttachFailures(sessionId: string): string[] {
    return this.sessionMcpAttachFailures.get(sessionId) ?? []
  }

  /**
   * Disconnect the MCP servers that were attached for a session.
   *
   * Each attached stdio server is a child process of the shared `opencode serve`
   * process, and it lives as long as that server does — which is days, because
   * the server is shared and often adopted rather than spawned. Without this the
   * stdio children accumulate one per session (the task-management-mcp leak).
   * Servers still needed by another live session are kept.
   */
  private async disconnectSessionMcpServers(sessionId: string): Promise<void> {
    const ownConfig = this.sessionMcpConfigs.get(sessionId)
    const client = this.clients.get(sessionId)
    if (!ownConfig || !client) return

    const stillNeeded = new Set<string>()
    for (const [otherSessionId, otherConfig] of this.sessionMcpConfigs.entries()) {
      if (otherSessionId === sessionId) continue
      for (const name of Object.keys(otherConfig)) stillNeeded.add(name)
    }
    const names = Object.keys(ownConfig).filter((name) => !stillNeeded.has(name))
    const workspaceDir = this.sessionWorkspaceDirs.get(sessionId)
    await disconnectMcpServers(client, names, workspaceDir, sessionId, this.getDirectoryMcpConfigs(workspaceDir))
  }

  /**
   * Pushes changed provider config (e.g. after an agent settings edit) to the
   * running server. Do NOT call this on every session start: PATCH
   * /global/config aborts all running sessions.
   */
  async notifyConfigChanged(): Promise<void> {
    await this.server.pushMergedConfig()
  }

  async getProviders(serverUrl?: string, directory?: string, allowRecovery = true): Promise<ProvidersResult | null> {
    try {
      const client = await this.server.client(serverUrl, { quick: true })

      // getProviders can run before any session started (settings opened right
      // after launch); later changes go through notifyConfigChanged().
      if (this.server.needsConfigPush) {
        await this.server.pushMergedConfig(client)
      }

      // Always pass a writable directory: otherwise the server falls back to its
      // CWD, which is read-only on macOS when launched from /Applications, and
      // fails to create its SQLite DB there with "disk I/O error".
      const result = await client.config.providers({ directory: directory || homedir() })

      if (result.error) {
        const errorStr = JSON.stringify(result.error)

        // Corrupted DB, stale WAL files or a failed migration after an opencode
        // upgrade: kill the server, clear its DB and retry once.
        if (allowRecovery && errorStr.includes('SQLiteError')) {
          console.warn('[OpencodeAdapter] SQLite error from server, attempting recovery:', errorStr)
          this.pendingPermissions.clear()
          await this.server.recover()
          return this.getProviders(serverUrl, directory, false)
        }

        console.log('[OpencodeAdapter] No providers configured on server:', errorStr)
        return null
      }

      const data = result.data as Partial<ProvidersResult> | undefined
      return data ? { providers: data.providers || [], default: data.default || {} } : null
    } catch (error: unknown) {
      console.log('[OpencodeAdapter] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const client = await this.server.client(undefined, { quick: true })
      const result = await client.global.health()
      if (result.error) {
        return { available: false, reason: 'Server not responding' }
      }
      console.log('[OpencodeAdapter] Health check OK, version:', (result.data as { version: string }).version)
      return { available: true }
    } catch (error: unknown) {
      return { available: false, reason: error instanceof Error ? error.message : 'Server not accessible' }
    }
  }

  /**
   * Prepares the server side of a session: writes runtime plugins (BEFORE the
   * server starts, so they are discovered at startup), creates the session's
   * clients and attaches the MCP servers.
   *
   * Config is NOT pushed here: pushing on every session caused a storm of
   * PATCH /global/config calls that aborted all running sessions when parallel
   * tasks started.
   */
  private async connectSession(config: SessionConfig, context: string): Promise<{
    ocClient: OpencodeClient
    promptClient: OpencodeClient
    attachResult: McpAttachResult
  }> {
    this.writeRuntimePluginFiles(config)
    await this.server.ensureRunning(config.serverUrl || DEFAULT_SERVER_URL)
    const { ocClient, promptClient } = this.server.sessionClients(config.serverUrl)

    // Runtime plugins and MCP servers are declared in
    // `<workspaceDir>/.opencode/opencode.json`, written by writeRuntimePluginFiles()
    // above. Do NOT push them with config.update() — see the comment on
    // writeWorkspaceOpencodeConfig(): that call rewrites `<dir>/config.json`, which
    // makes OpenCode dispose and re-create the whole instance for that directory and
    // silently drop every MCP server that was registered at runtime.
    //
    // MCP servers are attached before session create so the session picks
    // them up. On resume after a 20x restart the stdio MCP processes are dead
    // and remote servers may have lost their SSE connections. Mid-session drops
    // are handled by handleInstanceDisposed().
    const attachResult = config.mcpServers
      ? await attachAndVerifyMcpServers(ocClient, config.mcpServers, config.workspaceDir, context, this.getDirectoryMcpConfigs(config.workspaceDir))
      : { attached: [], failed: [] }

    return { ocClient, promptClient, attachResult }
  }

  private registerSession(
    sessionId: string,
    config: SessionConfig,
    connection: { ocClient: OpencodeClient; promptClient: OpencodeClient; attachResult: McpAttachResult }
  ): void {
    setTillDoneSession(this.tillDoneConfigPath, sessionId, config.tillDone !== false)
    this.clients.set(sessionId, connection.ocClient)
    this.promptClients.set(sessionId, connection.promptClient)
    this.sessionPermissionModes.set(sessionId, config.permissionMode || 'ask')
    if (config.workspaceDir) this.sessionWorkspaceDirs.set(sessionId, config.workspaceDir)
    if (config.mcpServers) this.sessionMcpConfigs.set(sessionId, config.mcpServers)
    this.setMcpAttachFailures(sessionId, connection.attachResult.failed)
  }

  async createSession(config: SessionConfig): Promise<string> {
    const connection = await this.connectSession(config, `createSession task=${config.taskId}`)

    const result = await connection.ocClient.session.create({
      body: { title: `Task ${config.taskId}` },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (result.error) {
      const errData = result.error as { data?: { message?: string }; name?: string }
      throw new Error(errData.data?.message || errData.name || 'Failed to create session')
    }
    if (!result.data?.id) {
      throw new Error('No session ID returned from OpenCode')
    }

    this.registerSession(result.data.id, config, connection)
    return result.data.id
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const connection = await this.connectSession(config, `resumeSession session=${sessionId}`)
    const { ocClient } = connection
    const directoryQuery = config.workspaceDir ? { query: { directory: config.workspaceDir } } : {}

    const getResult = await ocClient.session.get({ path: { id: sessionId }, ...directoryQuery })
    if (getResult.error || !getResult.data) {
      throw new Error('Session no longer exists on server')
    }

    // Tool calls from the previous app instance can still be "running". The
    // server reports the session busy although nothing executes, which blocks
    // new prompts and aborts. An abort leaves those tool parts "running" for
    // good, so they are deleted with v2 part.delete (the only way to clear
    // them), then the session is aborted again to move it from busy to idle.
    try {
      await ocClient.session.abort({ path: { id: sessionId }, ...directoryQuery })
      console.log(`[OpencodeAdapter] Aborted any in-progress prompt on resume for session ${sessionId}`)
    } catch {
      // Session may already be idle
    }

    try {
      const v2 = this.server.v2()
      if (v2) {
        let zombieCount = 0
        for (const msg of await this.fetchMessages(ocClient, sessionId, config.workspaceDir)) {
          const msgId = msg.info?.id
          if (!msgId) continue
          for (const part of msg.parts || []) {
            if (part.type !== 'tool') continue
            if ((part.state as Record<string, unknown> | undefined)?.status !== 'running') continue
            try {
              await v2.part.delete({
                sessionID: sessionId,
                messageID: msgId,
                partID: part.id as string,
                ...(config.workspaceDir && { directory: config.workspaceDir }),
              })
              zombieCount++
            } catch {
              // Part may already have been cleaned up
            }
          }
        }
        if (zombieCount > 0) {
          console.log(`[OpencodeAdapter] Deleted ${zombieCount} zombie running tool part(s) on resume for session ${sessionId}`)
          try {
            await ocClient.session.abort({ path: { id: sessionId }, ...directoryQuery })
          } catch {
            // Non-fatal
          }
        }

        const listResult = await v2.permission.list({})
        if (Array.isArray(listResult.data)) {
          const stale = (listResult.data as Array<{ id: string; sessionID: string }>).filter(p => p.sessionID === sessionId)
          for (const perm of stale) {
            try {
              await v2.permission.reply({ requestID: perm.id, reply: 'always' })
              console.log(`[OpencodeAdapter] Auto-approved stale permission ${perm.id} on resume`)
            } catch {
              // Permission may have already expired
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] Failed to clean up stale session state on resume:`, err instanceof Error ? err.message : err)
    }

    this.registerSession(sessionId, config, connection)

    return convertResumedMessages(await this.fetchMessages(ocClient, sessionId, config.workspaceDir))
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    const ocClient = this.promptClients.get(sessionId) || this.clients.get(sessionId)
    if (!ocClient) {
      throw new Error(`No client found for session ${sessionId}`)
    }

    const promptAbort = new AbortController()
    this.promptAborts.set(sessionId, promptAbort)

    // Fire-and-forget: getStatus() reports BUSY while promptAborts holds this
    // entry, which stays in place across retries.
    console.log(`[OpencodeAdapter] Sending prompt for session ${sessionId} (model: ${config.model || 'default'})`)
    void runPromptWithRetry(ocClient, sessionId, parts, config, promptAbort.signal)
      .then((error) => {
        if (!error) return
        this.promptErrors.set(sessionId, error)
        this.onDataAvailable?.(sessionId)
      })
      .finally(() => {
        this.promptAborts.delete(sessionId)
      })
  }

  private async fetchMessages(ocClient: OpencodeClient, sessionId: string, workspaceDir?: string): Promise<OpencodeMessage[]> {
    const result = await ocClient.session.messages({
      path: { id: sessionId },
      ...(workspaceDir && { query: { directory: workspaceDir } })
    })
    return Array.isArray(result.data) ? result.data as unknown as OpencodeMessage[] : []
  }

  /** The history pollMessages fetched during this poll cycle, or a fresh fetch. */
  private async cycleMessages(ocClient: OpencodeClient, sessionId: string, workspaceDir?: string): Promise<OpencodeMessage[]> {
    const cached = this.polledMessages.get(sessionId)
    if (cached && Date.now() - cached.at < POLL_CYCLE_CACHE_MS) return cached.messages
    return this.fetchMessages(ocClient, sessionId, workspaceDir)
  }

  async getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return { type: SessionStatusType.ERROR, message: 'Client not found' }
    }

    // Checked before promptAborts: a pending permission blocks tool execution
    // while the prompt call is still open, so the session would look busy forever.
    if ((this.pendingPermissions.get(sessionId)?.length ?? 0) > 0) {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    // While session.prompt() is open the agent is working, whatever the status
    // API says: it briefly reports idle between tool rounds, and some models'
    // tool call formats are not reflected in it at all.
    if (this.promptAborts.has(sessionId)) {
      return { type: SessionStatusType.BUSY }
    }

    const statusResult = await ocClient.session.status({
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })
    const ocStatus = statusResult.data?.[sessionId]
    if (!ocStatus) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    const sdkType = (ocStatus.type || 'idle') as string
    if (sdkType === 'waiting_approval' || sdkType === 'waiting_input' || sdkType === 'waiting_user') {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    try {
      const listResult = await this.server.v2(config.serverUrl)?.question.list({
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })
      if (listResult && !listResult.error && listResult.data) {
        const questions = listResult.data as unknown as Array<Record<string, unknown>>
        if (questions.some((q) => q.id && (q.sessionID === sessionId || q.sessionId === sessionId))) {
          return { type: SessionStatusType.WAITING_APPROVAL }
        }
      }
    } catch {
      // Ignore errors when checking for questions
    }

    // Some models (e.g. featherless kimi k2.5) have tool calls in flight that
    // the status API does not reflect.
    if (sdkType === 'idle') {
      try {
        const activeTool = findActiveToolInLastAssistantMessage(await this.cycleMessages(ocClient, sessionId, config.workspaceDir))
        if (activeTool) {
          console.log(`[OpencodeAdapter] Status API says idle but tool part ${activeTool.id} is ${activeTool.status} — reporting BUSY`)
          return { type: SessionStatusType.BUSY }
        }
      } catch (err) {
        console.warn('[OpencodeAdapter] Failed to check messages for pending tools:', err)
      }
    }

    const resolvedType = SessionStatusType[sdkType.toUpperCase() as keyof typeof SessionStatusType] ?? SessionStatusType.IDLE
    if (resolvedType === SessionStatusType.IDLE) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    return {
      type: resolvedType,
      message: 'message' in ocStatus ? (ocStatus as { message: string }).message : undefined
    }
  }

  /** ERROR with the captured prompt error if there is one, otherwise IDLE. */
  private resolveIdleOrPromptError(sessionId: string): SessionStatus {
    const promptError = this.promptErrors.get(sessionId)
    if (promptError) {
      this.promptErrors.delete(sessionId)
      return { type: SessionStatusType.ERROR, message: promptError }
    }
    return { type: SessionStatusType.IDLE }
  }

  async pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    config: SessionConfig
  ): Promise<MessagePart[]> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return []
    }
    const messages = await this.fetchMessages(ocClient, sessionId, config.workspaceDir)
    this.polledMessages.set(sessionId, { at: Date.now(), messages })
    return convertPolledParts(messages, seenMessageIds, seenPartIds, partContentLengths)
  }

  async getRunningTools(sessionId: string, config: SessionConfig): Promise<Array<{
    partId: string
    toolName: string
    startTime?: number
    input?: Record<string, unknown>
  }>> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) return []

    try {
      return listRunningTools(await this.cycleMessages(ocClient, sessionId, config.workspaceDir))
    } catch (err) {
      console.warn(`[OpencodeAdapter] getRunningTools failed for ${sessionId}:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  async abortPrompt(sessionId: string, config: SessionConfig): Promise<void> {
    this.promptAborts.get(sessionId)?.abort()
    this.promptAborts.delete(sessionId)

    // Without a server-side abort the backend keeps running the old prompt
    // (generating tokens, running bash) and rejects or queues new prompts, so
    // the user could not recover by sending a follow-up message.
    const ocClient = this.clients.get(sessionId)
    if (ocClient) {
      try {
        await ocClient.session.abort({
          path: { id: sessionId },
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
        })
        console.log(`[OpencodeAdapter] Server-side abort sent for session ${sessionId}`)
      } catch (err) {
        // Fails when the session is already idle or gone; the local abort is enough.
        console.warn(`[OpencodeAdapter] Server-side abort failed for ${sessionId}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  async destroySession(sessionId: string, config: SessionConfig): Promise<void> {
    await this.abortPrompt(sessionId, config)
    // The stdio MCP children are children of the long-lived `opencode serve`
    // process, so nothing else would ever stop them.
    await this.disconnectSessionMcpServers(sessionId)
    this.clients.delete(sessionId)
    this.promptClients.delete(sessionId)
    this.polledMessages.delete(sessionId)
    this.pendingPermissions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.sessionWorkspaceDirs.delete(sessionId)
    this.sessionMcpConfigs.delete(sessionId)
    this.sessionMcpAttachFailures.delete(sessionId)
    setTillDoneSession(this.tillDoneConfigPath, sessionId, undefined)

    if (this.clients.size > 0) {
      return
    }

    removeRuntimePluginFiles({
      pluginFilePaths: this.pluginFilePaths,
      runtimeSupportFilePaths: this.runtimeSupportFilePaths,
      tillDoneConfigPath: this.tillDoneConfigPath
    })
    this.pluginFilePaths = []
    this.runtimeSupportFilePaths = []
    this.tillDoneConfigPath = null
  }

  /** Must run BEFORE the server starts so plugins are discovered at startup. */
  private writeRuntimePluginFiles(config: SessionConfig): void {
    const files = writeRuntimePluginFiles(config)
    this.pluginFilePaths = files.pluginFilePaths
    this.runtimeSupportFilePaths = files.runtimeSupportFilePaths
    this.tillDoneConfigPath = files.tillDoneConfigPath
  }

  async getAllMessages(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return []
    }

    try {
      return convertAllMessages(await this.fetchMessages(ocClient, sessionId, config.workspaceDir))
    } catch (error) {
      console.error('[OpencodeAdapter] Error fetching messages:', error)
      return []
    }
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig
  ): Promise<void> {
    const v2 = this.server.v2(config.serverUrl)
    if (!v2) throw new Error('OpenCode V2 SDK not loaded')

    try {
      const listResult = await v2.question.list({
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })
      if (listResult.error) {
        throw new Error(`question.list failed: ${JSON.stringify(listResult.error)}`)
      }

      const questions: V2QuestionRequest[] = listResult.data ?? []
      const question = questions.find(q => q.sessionID === sessionId || (q as unknown as { sessionId?: string }).sessionId === sessionId)
      if (!question?.id) {
        console.warn(`[OpencodeAdapter] No pending question found for session ${sessionId} (${questions.length} pending overall)`)
        return
      }

      // One answer list per question item, in the question's order.
      const questionItems = question.questions ?? []
      const answerKeys = Object.keys(answers)
      const formattedAnswers = questionItems.map((qItem, i) => {
        const matchKey = answerKeys.find(k => k === qItem.header || k === qItem.question)
        const answerValue = matchKey ? answers[matchKey] : Object.values(answers)[i]
        return answerValue ? [answerValue] : []
      })

      console.log(`[OpencodeAdapter] Replying to question ${question.id} (${questionItems.length} items) with:`, formattedAnswers)
      const replyResult = await v2.question.reply({
        requestID: question.id,
        answers: formattedAnswers,
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })
      if (replyResult.error) {
        throw new Error(`question.reply failed: ${JSON.stringify(replyResult.error)}`)
      }
    } catch (err) {
      console.error('[OpencodeAdapter] Question API failed:', err)
    }
  }

  /**
   * The first pending permission of a session, as an approval request for the
   * agent-manager to render. agent-manager duck-types for this method.
   */
  getPendingApproval(sessionId: string): {
    toolCallId: string
    question: string
    options: Array<{ optionId: string; name: string; kind: string }>
  } | null {
    const pending = this.pendingPermissions.get(sessionId)?.[0]
    if (!pending) return null

    const pathList = pending.patterns.length > 0 ? pending.patterns.join(', ') : 'requested path'
    return {
      toolCallId: pending.permissionId,
      question: `Allow ${pending.permission} access to: ${pathList}`,
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'option' },
        { optionId: 'allow-always', name: 'Always', kind: 'option' },
        { optionId: 'deny', name: 'No', kind: 'option' }
      ]
    }
  }

  async respondToApproval(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<boolean> {
    const queue = this.pendingPermissions.get(sessionId)
    if (!queue || queue.length === 0) {
      // The in-memory queue is lost after an app restart or a watchdog abort,
      // while the permission can still be pending in OpenCode.
      console.warn(`[OpencodeAdapter] No pending permission in memory for session ${sessionId}, trying V2 API fallback`)
      return await this.respondToPermissionViaV2(sessionId, approved, optionId)
    }

    const pending = queue.shift()!
    if (queue.length === 0) {
      this.pendingPermissions.delete(sessionId)
    }

    const reply = permissionReply(approved, optionId)
    console.log(`[OpencodeAdapter] Responding to permission ${pending.permissionId}: ${reply}`)
    try {
      await this.replyToPermission(sessionId, pending.permissionId, reply)
    } catch (err) {
      console.error(`[OpencodeAdapter] Failed to respond to permission ${pending.permissionId}:`, err)
    }

    // Poll now so agent-manager sees the next pending permission, if any
    this.onDataAvailable?.(sessionId)
    return true
  }

  /** Answers the session's first pending permission as listed by the V2 API (all sessions). */
  private async respondToPermissionViaV2(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<boolean> {
    try {
      const v2 = this.server.v2()
      if (!v2) {
        console.warn(`[OpencodeAdapter] Cannot fetch permissions — V2 SDK not loaded`)
        return false
      }

      const listResult = await v2.permission.list({})
      if (listResult.error || !listResult.data) {
        console.warn(`[OpencodeAdapter] V2 permission.list() failed or returned no data for session ${sessionId}`)
        return false
      }

      const allPending = listResult.data as Array<{ id: string; sessionID: string; permission: string; patterns: string[] }>
      const first = allPending.find(p => p.sessionID === sessionId)
      if (!first) {
        console.warn(`[OpencodeAdapter] No pending permissions found via V2 API for session ${sessionId}`)
        return false
      }

      const reply = permissionReply(approved, optionId)
      console.log(`[OpencodeAdapter] Responding to permission ${first.id} via V2 API: ${reply} (permission=${first.permission}, patterns=${first.patterns.join(', ')})`)
      await this.replyToPermission(sessionId, first.id, reply)

      this.onDataAvailable?.(sessionId)
      return true
    } catch (err) {
      console.error(`[OpencodeAdapter] V2 permission fallback failed for session ${sessionId}:`, err)
      return false
    }
  }

  /**
   * Handles one SSE event from the server. /global/event wraps events in a
   * `payload` envelope ({ payload: { id, type, properties } }); /event sends
   * them bare. Both are accepted.
   */
  private handleServerEvent(event: Record<string, unknown>): void {
    const inner = (event.payload || event) as Record<string, unknown>
    const type = inner.type as string | undefined

    if (type === 'server.instance.disposed' || type === 'global.disposed') {
      const props = (inner.properties || {}) as Record<string, unknown>
      const directory = (props.directory || event.directory) as string | undefined
      void this.handleInstanceDisposed(directory, type)
      return
    }

    if (type !== 'permission.asked') return

    const props = (inner.properties || inner) as Record<string, unknown>
    const permissionId = (props.id || props.permissionID) as string | undefined
    const sessionID = (props.sessionID || props.sessionId) as string | undefined
    const permission = (props.permission || props.name || 'unknown') as string
    const patterns = (props.patterns || []) as string[]

    if (!permissionId || !sessionID) {
      console.warn('[OpencodeAdapter] permission.asked event missing id or sessionID:', JSON.stringify(event).slice(0, 300))
      return
    }

    console.log(`[OpencodeAdapter] Permission requested: ${permission} for session ${sessionID} (${permissionId}) patterns=${patterns.join(', ')}`)

    if (this.sessionPermissionModes.get(sessionID) === 'allow') {
      console.log(`[OpencodeAdapter] Auto-approving permission ${permissionId} (permissionMode=allow)`)
      this.autoApprovePermission(sessionID, permissionId).catch(err => {
        console.error(`[OpencodeAdapter] Auto-approve failed for ${permissionId}:`, err)
      })
      return
    }

    let queue = this.pendingPermissions.get(sessionID)
    if (!queue) {
      queue = []
      this.pendingPermissions.set(sessionID, queue)
    }
    if (!queue.some(p => p.permissionId === permissionId)) {
      queue.push({ permissionId, permission, patterns })
    }

    this.onDataAvailable?.(sessionID)
  }

  private async autoApprovePermission(sessionId: string, permissionId: string): Promise<void> {
    try {
      await this.replyToPermission(sessionId, permissionId, 'always')
      console.log(`[OpencodeAdapter] Auto-approved permission ${permissionId}`)
    } catch (err) {
      console.error(`[OpencodeAdapter] Auto-approve failed for ${permissionId}:`, err)
    }
  }

  /**
   * Replies through the V2 endpoint (POST /permission/{requestID}/reply). The
   * V1 endpoint (POST /session/{id}/permissions/{permissionID}) returns 404
   * for permissions created by the V2 system. Permission events only arrive
   * once the server runs, which requires the SDK, so the V2 client exists here.
   */
  private async replyToPermission(
    sessionId: string,
    requestID: string,
    reply: ReturnType<typeof permissionReply>
  ): Promise<void> {
    const v2 = this.server.v2()
    if (!v2) throw new Error('OpenCode V2 SDK not loaded')
    const directory = this.sessionWorkspaceDirs.get(sessionId)
    await v2.permission.reply({ requestID, reply, ...(directory && { directory }) })
  }

  async stopServer(): Promise<void> {
    this.pendingPermissions.clear()
    await this.server.stop()
  }
}

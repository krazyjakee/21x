/**
 * Codex App Server adapter.
 *
 * Experimental replacement path for Codex ACP. This talks to `codex app-server`
 * over JSON-RPC stdio and maps the app-server thread/turn/item protocol onto
 * 20x's CodingAgentAdapter contract.
 */

import { CLIENT_NAME } from '../app-identity'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { guardChildStreams } from '../child-stream-guards'
import { parseProcessTable } from '../mcp-process-cleanup'
import { selectUntrackedAppServerPids } from '../codex-app-server-sweep'
import { isAbsolute, join, relative, resolve } from 'path'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
  McpServerConfig,
  AdapterUsageReport
} from './coding-agent-adapter'
import { MessagePartType, SessionStatusType } from './coding-agent-adapter'
import { CodexUsageAccumulator } from './usage-reports'
import {
  asString,
  computeThreadItemKey,
  convertEventToMessageParts,
  extractFailedTurnError,
  extractThreadId,
  isObject,
  summarizeAppServerError,
  type CodexItemState,
  type RunningTool
} from './codex-app-server-items'
import { applyCodexAuthEnv } from './shared/codex-auth'
import { execFileAsync, findExecutable } from '../find-executable'
import {
  sendJsonRpcRequest,
  writeJsonRpc,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcPeer,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './shared/json-rpc'
import { onJsonLines } from './shared/jsonl'
import { groupPartsIntoMessages } from './shared/session-messages'

const DEFAULT_CODEX_APP_SERVER_MODEL = 'gpt-6-astra'
const LABEL = 'CodexAppServerAdapter'

/**
 * How long an app-server gets to honour SIGTERM before it is killed outright.
 *
 * SIGTERM is the signal that matters, and it is enough: measured on a live
 * tree, terminating the node wrapper also removed the vendored `codex` binary
 * beneath it AND the `npm exec @google-cloud/observability-mcp` grandchild with
 * its own node child — four processes for one signal. The escalation exists for
 * a wrapper that is wedged rather than merely busy.
 */
const APP_SERVER_KILL_GRACE_MS = 1000

/**
 * How often to look for app-server children that escaped their session.
 *
 * The adapter now stops its children on every path that can drop one, so this
 * sweep is expected to find nothing. It runs anyway because the failure it
 * covers is silent and expensive — each escaped app-server was observed holding
 * 0.9-1.2 GB — and because a future path that forgets to tear down would
 * otherwise go unnoticed until the machine ran out of memory again.
 */
const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000

type CodexSandboxPolicy =
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; networkAccess: boolean; writableRoots: string[] }
  | { type: 'dangerFullAccess' }

interface PendingApproval {
  requestId: string | number
  toolCallId: string
  question: string
  options: Array<{
    optionId: string
    name: string
    kind: string
  }>
  responseKind: 'execCommand' | 'commandExecution' | 'fileChange' | 'permissions' | 'elicitation' | 'userInput' | 'generic'
}

interface AppServerSession extends CodexItemState, JsonRpcPeer {
  sessionId: string
  threadId: string | null
  activeTurnId: string | null
  process: ChildProcess
  status: SessionStatusType
  messageBuffer: unknown[]
  permanentMessages: unknown[]
  bufferedThreadItemIds: Set<string>
  pendingCompletionRefreshes: number
  sawThreadStatusNotification: boolean
  pendingThreadIdle: boolean
  pendingApproval: PendingApproval | null
  lastError: string | null
  config: SessionConfig
  /** Per-turn token usage from `thread/tokenUsage/updated` (#97). */
  usage?: CodexUsageAccumulator
  codexUseApiKey: boolean
  codexAuthSummary: string
  /**
   * Set once the child has been signalled, so a session that is destroyed twice
   * — a user stop racing the idle reaper, say — signals once and reports once.
   */
  terminated: boolean
}

/** The message of a thrown value, for a teardown log line. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeCodexMcpServerName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return normalized || 'mcp_server'
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.filter(Boolean).map((path) => resolve(path))))
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function summarizeApproval(params: Record<string, unknown>, fallback: string): string {
  const command = asString(params.command)
  const reason = asString(params.reason)
  const itemId = asString(params.itemId) || asString(params.callId)
  return [command || fallback, reason, itemId ? `id: ${itemId}` : ''].filter(Boolean).join('\n')
}

function normalizeDecisionName(decision: unknown): string {
  if (typeof decision === 'string') return decision
  if (isObject(decision)) {
    return Object.keys(decision)[0] || 'accept'
  }
  return 'accept'
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case 'accept':
    case 'approved':
      return 'Allow'
    case 'acceptForSession':
    case 'approved_for_session':
      return 'Allow for Session'
    case 'decline':
    case 'denied':
      return 'Deny'
    case 'cancel':
    case 'abort':
      return 'Deny and Stop'
    default:
      return decision
  }
}

export class CodexAppServerAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, AppServerSession>()
  /**
   * Every app-server child that has been started and not yet stopped.
   *
   * Deliberately NOT derived from `sessions`. That map is keyed by session id
   * and is re-keyed mid-flight (`thread/start` moves an entry from the task id
   * to the thread id), so a child can be absent from it while very much alive —
   * which is how the leak stayed invisible. This set is the spawn ledger: one
   * entry per live process, added at spawn, removed at exit or teardown, and it
   * is what tells the sweep which app-servers still have an owner.
   */
  private liveSessions = new Set<AppServerSession>()
  private orphanSweepTimer: NodeJS.Timeout | null = null
  private codexExecutablePath: string | null = null

  onDataAvailable?: (sessionId: string) => void
  /** Set by agent-manager: receives the token usage the backend reports (#97). */
  onUsage?: (report: AdapterUsageReport) => void

  async initialize(): Promise<void> {
    const health = await this.checkHealth()
    if (!health.available) {
      throw new Error(health.reason || 'Codex app-server not available')
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const session = await this.startAppServerProcess(config, config.taskId)
    this.trackSession(config.taskId, session)

    // From here on the child exists. Every exit from this method that is not a
    // thread id must take it with it: `initialize` and `thread/start` each
    // reject on a 30 s timeout, and the caller (agent-manager) answers a failed
    // start by STARTING ANOTHER SESSION. Without this the failed attempt's
    // app-server — and the MCP servers it has already spawned — stay resident
    // with nothing left to speak to them.
    try {
      return await this.startThread(session, config)
    } catch (error) {
      this.terminateSession(session, `create failed: ${errorText(error)}`)
      if (this.sessions.get(config.taskId) === session) this.sessions.delete(config.taskId)
      throw error
    }
  }

  private async startThread(session: AppServerSession, config: SessionConfig): Promise<string> {
    await this.initializeAppServer(session)

    const result = await this.sendRpcRequest(session, 'thread/start', {
      ...this.buildThreadParams(config),
      developerInstructions: config.systemPrompt || null
    })

    const threadId = extractThreadId(result)
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id')
    }

    // Starting a thread takes two awaits, and a SECOND create for the same task
    // can arrive across either of them and displace this one. The child is
    // already stopped by then, so returning its thread id would hand
    // agent-manager a session id backed by nothing — and adopting the thread
    // key would evict the live child that replaced us. Fail instead, and let
    // the caller's teardown run.
    if (session.terminated) {
      throw new Error('Codex app-server was stopped while its thread was starting')
    }

    session.threadId = threadId
    if (this.sessions.get(config.taskId) === session) this.sessions.delete(config.taskId)
    this.trackSession(threadId, session)
    void this.logMcpServerInventory(session, threadId, 'thread/start')
    return threadId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const session = await this.startAppServerProcess(config, sessionId)
    session.threadId = sessionId
    // `trackSession`, not `sessions.set`. Resuming a thread that is already
    // running spawns a SECOND app-server under the same key, and a plain `set`
    // overwrote the only handle to the first one — which then ran on, with its
    // MCP children, until the app quit. This was the larger half of the leak:
    // one workspace with a single live session was measured holding three.
    this.trackSession(sessionId, session)

    try {
      return await this.resumeThread(session, sessionId, config)
    } catch (error) {
      this.terminateSession(session, `resume failed: ${errorText(error)}`)
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
      throw error
    }
  }

  private async resumeThread(
    session: AppServerSession,
    sessionId: string,
    config: SessionConfig
  ): Promise<SessionMessage[]> {
    await this.initializeAppServer(session)

    await this.sendRpcRequest(session, 'thread/resume', {
      ...this.buildThreadParams(config),
      threadId: sessionId,
      developerInstructions: config.systemPrompt || null,
      initialTurnsPage: { limit: 50 }
    })

    void this.logMcpServerInventory(session, sessionId, 'thread/resume')

    try {
      await this.bufferAllThreadItems(session, sessionId)
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to list thread items after resume:', error)
    }

    const messages = await this.getAllMessages(sessionId, config)
    session.messageBuffer = []
    return messages
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    const session = this.requireSession(sessionId)
    if (!session.threadId) {
      throw new Error(`Codex app-server session has no thread id: ${sessionId}`)
    }

    const promptText = parts
      .filter((part) => part.type === MessagePartType.TEXT && part.text)
      .map((part) => part.text)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in message parts')
    }

    session.messageBuffer = []

    const userItem = {
      method: 'item/completed',
      params: {
        threadId: session.threadId,
        turnId: session.activeTurnId || `local-${Date.now()}`,
        item: {
          id: `user-${Date.now()}`,
          type: 'user_message',
          text: promptText
        }
      }
    }
    this.addEvent(session, userItem)

    session.status = SessionStatusType.BUSY
    session.lastError = null

    const result = await this.sendRpcRequest(session, 'turn/start', {
      ...this.buildThreadParams(config),
      threadId: session.threadId,
      input: [{ type: 'text', text: promptText }],
      effort: config.reasoningEffort && config.reasoningEffort !== 'max' ? config.reasoningEffort : null,
      sandboxPolicy: this.buildSandboxPolicy(config)
    })

    if (isObject(result)) {
      session.activeTurnId = asString(result.turnId) || asString(result.turn_id) || session.activeTurnId
    }
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { type: SessionStatusType.ERROR, message: 'Session not found' }
    }
    return {
      type: session.status,
      message: session.status === SessionStatusType.ERROR ? (session.lastError || 'Process error') : undefined
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
    if (!session) return []

    const parts = session.messageBuffer.flatMap((event) =>
      this.convertEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
    )
    session.messageBuffer = []
    return parts
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.requireSession(sessionId)
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const assistantTextKeysByTurn = session.assistantTextKeysByTurn
    session.assistantTextKeysByTurn = new Map()
    try {
      return groupPartsIntoMessages(session.permanentMessages.flatMap((event) =>
        this.convertEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
      ))
    } finally {
      session.assistantTextKeysByTurn = assistantTextKeysByTurn
    }
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.requireSession(sessionId)
    if (!session.threadId || !session.activeTurnId) return
    await this.sendRpcRequest(session, 'turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurnId
    })
    // An interrupted turn may never emit item/completed for its active tools.
    // Drop them here so the watchdog cannot repeatedly act on stale state.
    session.runningTools.clear()
    // Keep the session BUSY until Codex confirms settlement via turn/completed
    // or thread/status/changed. Marking it idle here races those notifications
    // and can make follow-up UI actions target a turn that is still settling.
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (!session) return
    this.terminateSession(session, `session ${sessionId} destroyed`)
  }

  /**
   * Puts `session` under `key`, stopping whatever child was there before.
   *
   * The map is the ONLY handle to an app-server child, so overwriting an entry
   * leaks the process it pointed at. Every write goes through here so that
   * cannot be forgotten again.
   */
  private trackSession(key: string, session: AppServerSession): void {
    const displaced = this.sessions.get(key)
    if (displaced && displaced !== session) {
      this.terminateSession(displaced, `replaced by a new app-server for ${key}`)
    }
    this.sessions.set(key, session)
  }

  /**
   * Stops one app-server child and releases everything it held.
   *
   * SIGTERM on the node wrapper is enough to take the whole tree: verified on a
   * live process group that the vendored `codex` binary and the
   * `npm exec @google-cloud/observability-mcp` grandchild beneath it both went
   * with it. SIGKILL follows only if the wrapper is still there after the grace
   * period — and it is scheduled against the child's own `exit`, not against
   * `ChildProcess.killed`, which reports that a SIGNAL WAS SENT rather than
   * that the process died and so was true immediately every time.
   */
  private terminateSession(session: AppServerSession, reason: string): void {
    if (session.terminated) return
    session.terminated = true
    this.liveSessions.delete(session)

    const child = session.process
    console.log(`[CodexAppServerAdapter] Stopping app-server pid ${child.pid ?? '?'} — ${reason}`)
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone. Nothing left to stop.
    }
    const escalation = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Exited during the grace period, which is the outcome we wanted.
      }
    }, APP_SERVER_KILL_GRACE_MS)
    escalation.unref()
    child.once('exit', () => clearTimeout(escalation))

    // An in-flight RPC would otherwise sit on its 30 s timeout against a pipe
    // that is already closed, holding its caller open for no reason.
    for (const pending of session.pendingRequests.values()) {
      pending.reject(new Error(`Codex app-server stopped: ${reason}`))
    }
    session.pendingRequests.clear()
    session.messageBuffer.length = 0
    session.permanentMessages.length = 0
    session.streamedTextByItemId.clear()
    session.assistantTextKeysByTurn.clear()
    session.runningTools.clear()
    session.bufferedThreadItemIds.clear()
  }

  /**
   * Kills app-server children of this process that no session is holding.
   *
   * The backstop described in `codex-app-server-sweep.ts`. It reads the process
   * table, so it runs on a timer rather than on every session change, and it is
   * scoped to our own descendants — another 20x instance's app-servers are its
   * own business.
   */
  private async sweepOrphanedAppServers(): Promise<void> {
    if (process.platform === 'win32') return // No cheap ancestry query on Windows.
    try {
      const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,command='], {
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024
      })
      const tracked = new Set<number>()
      for (const session of this.liveSessions) {
        if (typeof session.process.pid === 'number') tracked.add(session.process.pid)
      }
      const leaked = selectUntrackedAppServerPids(parseProcessTable(String(stdout)), process.pid, tracked)
      for (const pid of leaked) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Exited between the listing and the signal.
        }
      }
      if (leaked.length > 0) {
        console.warn(`[CodexAppServerAdapter] Swept ${leaked.length} orphaned app-server process(es): ${leaked.join(', ')}`)
      }
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Could not sweep orphaned app-servers:', error)
    }
  }

  /** Starts the orphan sweep on the first spawn, so a Codex-free run has no timer. */
  private startOrphanSweep(): void {
    if (this.orphanSweepTimer) return
    this.orphanSweepTimer = setInterval(() => void this.sweepOrphanedAppServers(), ORPHAN_SWEEP_INTERVAL_MS)
    this.orphanSweepTimer.unref()
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const executable = await this.findCodexExecutable()
      await execFileAsync(executable, ['app-server', '--help'], { timeout: 5000 })
      return { available: true }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  getPendingApproval(sessionId: string): PendingApproval | null {
    return this.sessions.get(sessionId)?.pendingApproval || null
  }

  async respondToApproval(sessionId: string, approved: boolean, optionId?: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const approval = session.pendingApproval
    if (!approval) return

    const selected = optionId || approval.options.find((option) =>
      approved
        ? ['acceptForSession', 'accept', 'approved_for_session', 'approved'].includes(option.optionId)
        : ['cancel', 'abort', 'decline', 'denied'].includes(option.optionId)
    )?.optionId || (approved ? 'accept' : 'cancel')
    const response = this.buildApprovalResponse(approval.responseKind, selected, approved)

    this.sendRpcResponse(session, approval.requestId, response)
    session.pendingApproval = null
    if (!approved) {
      session.status = SessionStatusType.IDLE
    }
  }

  async getRunningTools(sessionId: string, _config: SessionConfig): Promise<RunningTool[]> {
    return Array.from(this.sessions.get(sessionId)?.runningTools.values() || [])
  }

  private async startAppServerProcess(config: SessionConfig, sessionId: string): Promise<AppServerSession> {
    const executable = await this.findCodexExecutable()
    const authEnv = this.buildEnvironment(config)
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd: config.workspaceDir,
      env: authEnv.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(needsShell ? { shell: true } : {})
    })

    // Every pipe needs an error listener before the first write. The app server
    // can exit at any moment, and an unhandled EPIPE on its stdin crashes the
    // main process.
    guardChildStreams(child, LABEL)

    const session: AppServerSession = {
      sessionId,
      threadId: null,
      activeTurnId: null,
      process: child,
      status: SessionStatusType.IDLE,
      messageBuffer: [],
      permanentMessages: [],
      bufferedThreadItemIds: new Set(),
      pendingCompletionRefreshes: 0,
      sawThreadStatusNotification: false,
      pendingThreadIdle: false,
      pendingRequests: new Map(),
      pendingApproval: null,
      nextRequestId: 1,
      lastError: null,
      config,
      streamedTextByItemId: new Map(),
      assistantTextKeysByTurn: new Map(),
      runningTools: new Map(),
      codexUseApiKey: authEnv.usesApiKey,
      codexAuthSummary: authEnv.summary,
      terminated: false
    }

    // Recorded BEFORE anything can fail, and before the caller gets a chance to
    // put it in `sessions`. A child that is spawned but not yet owned is exactly
    // the state the leak lived in.
    this.liveSessions.add(session)
    this.startOrphanSweep()

    onJsonLines(child.stdout, (line) => {
      try {
        this.handleRpcMessage(session, JSON.parse(line) as JsonRpcMessage)
      } catch (error) {
        console.error('[CodexAppServerAdapter] Failed to parse JSON-RPC:', line, error)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      console.log('[CodexAppServerAdapter] stderr:', chunk.toString())
    })
    child.on('exit', (code, signal) => {
      console.log(`[CodexAppServerAdapter] process exited: code=${code}, signal=${signal}`)
      this.liveSessions.delete(session)
      if (code !== 0 && code !== null) {
        session.status = SessionStatusType.ERROR
        session.lastError = `Codex app-server exited with code ${code}`
      }
    })

    return session
  }

  private async initializeAppServer(session: AppServerSession): Promise<void> {
    await this.sendRpcRequest(session, 'initialize', {
      clientInfo: {
        name: CLIENT_NAME,
        title: CLIENT_NAME,
        version: '0.0.1'
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true
      }
    })
    this.sendRpcNotification(session, 'initialized', {})
  }

  private async findCodexExecutable(): Promise<string> {
    if (this.codexExecutablePath) return this.codexExecutablePath
    const found = await findExecutable(process.platform === 'win32' ? 'codex.cmd' : 'codex')
    if (!found) throw new Error('Codex CLI not found on PATH')
    this.codexExecutablePath = found
    return found
  }

  private buildEnvironment(config: SessionConfig): {
    env: NodeJS.ProcessEnv
    usesApiKey: boolean
    summary: string
  } {
    const env: NodeJS.ProcessEnv = { ...process.env, ...config.secretEnvVars }
    return { env, ...applyCodexAuthEnv(env, config) }
  }

  /** Parameters shared by thread/start, thread/resume and turn/start. */
  private buildThreadParams(config: SessionConfig): Record<string, unknown> {
    return {
      cwd: config.workspaceDir,
      model: config.model || DEFAULT_CODEX_APP_SERVER_MODEL,
      approvalPolicy: config.permissionMode === 'allow' ? 'never' : 'on-request',
      approvalsReviewer: 'user',
      sandbox: this.resolveSandboxMode(config),
      runtimeWorkspaceRoots: this.buildRuntimeWorkspaceRoots(config.workspaceDir),
      config: this.buildConfigOverrides(config)
    }
  }

  private buildConfigOverrides(config: SessionConfig): Record<string, unknown> {
    const overrides: Record<string, unknown> = {}
    if (config.reasoningEffort && config.reasoningEffort !== 'max') {
      overrides.model_reasoning_effort = config.reasoningEffort
    }
    if (this.resolveSandboxMode(config) === 'workspace-write') {
      overrides.sandbox_workspace_write = {
        network_access: true,
        writable_roots: this.buildRuntimeWorkspaceRoots(config.workspaceDir)
      }
    }
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      overrides.mcp_servers = this.convertMcpServers(config.mcpServers, config.permissionMode === 'allow')
    }
    return overrides
  }

  private buildRuntimeWorkspaceRoots(workspaceDir: string): string[] {
    return uniquePaths([workspaceDir, ...this.resolveExternalGitRoots(workspaceDir)])
  }

  private resolveExternalGitRoots(workspaceDir: string): string[] {
    const workspaceRoot = resolve(workspaceDir)
    const dotGitPath = join(workspaceRoot, '.git')
    if (!existsSync(dotGitPath)) return []

    try {
      const dotGitContent = readFileSync(dotGitPath, 'utf8').trim()
      if (!dotGitContent.startsWith('gitdir:')) return []

      const rawGitDir = dotGitContent.slice('gitdir:'.length).trim()
      if (!rawGitDir) return []

      const gitDir = isAbsolute(rawGitDir)
        ? resolve(rawGitDir)
        : resolve(workspaceRoot, rawGitDir)
      const commonDirPath = join(gitDir, 'commondir')
      const rawCommonDir = existsSync(commonDirPath)
        ? readFileSync(commonDirPath, 'utf8').trim()
        : ''
      const commonDir = rawCommonDir
        ? (isAbsolute(rawCommonDir) ? resolve(rawCommonDir) : resolve(gitDir, rawCommonDir))
        : gitDir

      return [commonDir, gitDir].filter((path) => !isSubpath(workspaceRoot, path))
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to resolve external git metadata roots:', error)
      return []
    }
  }

  /**
   * Codex asks before most MCP tool calls. Under approvalPolicy 'never' there
   * is nobody to ask, so it refuses them ("MCP tool call requires approval,
   * but approval policy is never") — every task-management call, including a
   * Captain's report_to_commander. An 'allow' agent has already been trusted
   * with everything, so its configured servers are approved up front; an 'ask'
   * agent keeps Codex's default and prompts through the approval flow.
   */
  private convertMcpServers(servers: Record<string, McpServerConfig>, approveTools: boolean): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [name, server] of Object.entries(servers)) {
      const codexName = normalizeCodexMcpServerName(name)
      let entry: Record<string, unknown>
      if (server.type === 'stdio') {
        entry = {
          command: server.command,
          args: server.args || [],
          env: server.env || {}
        }
      } else {
        entry = { url: server.url }
        if (server.headers && Object.keys(server.headers).length > 0) {
          entry.http_headers = server.headers
        }
      }
      if (approveTools) entry.default_tools_approval_mode = 'approve'
      result[codexName] = entry
    }
    return result
  }

  private async logMcpServerInventory(session: AppServerSession, threadId: string, context: string): Promise<void> {
    try {
      const result = await this.sendRpcRequest(session, 'mcpServerStatus/list', {
        threadId,
        detail: 'toolsAndAuthOnly',
        limit: 100
      })
      if (!isObject(result) || !Array.isArray(result.data)) return

      const servers = result.data
        .filter(isObject)
        .map((server) => {
          const tools = server.tools
          const toolNames = Array.isArray(tools)
            ? tools.map((tool) => isObject(tool) ? asString(tool.name) : undefined).filter(Boolean)
            : isObject(tools)
              ? Object.keys(tools)
              : []

          return {
            name: asString(server.name) || 'unknown',
            authStatus: asString(server.authStatus) || null,
            toolCount: toolNames.length,
            toolNames: toolNames.slice(0, 50)
          }
        })

      console.log('[CodexAppServerAdapter] MCP inventory', { context, threadId, servers })
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to list MCP inventory:', error)
    }
  }

  private handleRpcMessage(session: AppServerSession, message: JsonRpcMessage): void {
    if ('id' in message && 'method' in message) {
      this.handleServerRequest(session, message as JsonRpcRequest)
      return
    }

    if ('id' in message) {
      const pending = session.pendingRequests.get(message.id)
      if (!pending) return
      session.pendingRequests.delete(message.id)
      const response = message as JsonRpcResponse
      if (response.error) {
        pending.reject(new Error(response.error.message))
      } else {
        pending.resolve(response.result)
      }
      return
    }

    if ('method' in message) {
      this.handleNotification(session, message as JsonRpcNotification)
    }
  }

  private handleServerRequest(session: AppServerSession, request: JsonRpcRequest): void {
    const params = isObject(request.params) ? request.params : {}
    if (request.method.includes('Approval') || request.method.includes('requestApproval')) {
      this.handleApprovalRequest(session, request, params)
      return
    }

    if (request.method === 'mcpServer/elicitation/request' || request.method === 'item/tool/requestUserInput') {
      this.handleApprovalRequest(session, request, params)
      return
    }

    this.sendRpcResponse(session, request.id, {})
  }

  /** Reports the turn's token usage so far (#97). Never throws. */
  private observeUsage(session: AppServerSession, params: Record<string, unknown>): void {
    try {
      session.usage ??= new CodexUsageAccumulator(session.config?.model || DEFAULT_CODEX_APP_SERVER_MODEL)
      const body = session.usage.observe(params, session.activeTurnId)
      if (body && this.onUsage) this.onUsage({ sessionId: session.threadId || session.sessionId, ...body })
    } catch (err) {
      console.warn('[CodexAppServerAdapter] Could not read turn usage:', err instanceof Error ? err.message : err)
    }
  }

  private handleNotification(session: AppServerSession, notification: JsonRpcNotification): void {
    const params = isObject(notification.params) ? notification.params : {}

    if (notification.method === 'thread/status/changed') {
      const status = asString(params.status)
      session.status = status === 'running' || status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE
    }

    if (notification.method === 'turn/started') {
      session.status = SessionStatusType.BUSY
      session.activeTurnId = asString(params.turnId) || session.activeTurnId
      session.pendingThreadIdle = false
    }

    if (notification.method === 'thread/tokenUsage/updated') {
      this.observeUsage(session, params)
    }

    if (notification.method === 'turn/completed') {
      session.usage?.turnCompleted()
      session.activeTurnId = null
      // A failed turn reports `turn.status === 'failed'` with a `TurnError`.
      // Codex normally sends a non-retryable `error` notification first, but
      // this is the authoritative signal that the turn is over.
      const failure = extractFailedTurnError(params)
      if (failure) {
        session.status = SessionStatusType.ERROR
        session.lastError = failure.message
      }
      if (session.threadId) {
        session.pendingCompletionRefreshes += 1
        void this.reconcileCompletedTurn(session)
      } else {
        session.status = SessionStatusType.IDLE
      }
    }

    if (notification.method === 'thread/status/changed') {
      session.sawThreadStatusNotification = true
      const status = isObject(params.status) ? asString(params.status.type) : ''
      if (status === 'active') {
        session.status = SessionStatusType.BUSY
        session.pendingThreadIdle = false
      } else if (status === 'idle') {
        session.activeTurnId = null
        session.pendingThreadIdle = true
        this.markIdleIfSettled(session)
      } else if (status === 'systemError') {
        session.status = SessionStatusType.ERROR
        session.lastError = 'Codex app-server thread entered system error state'
      }
    }

    if (notification.method === 'error') {
      const failure = summarizeAppServerError(params)
      if (failure.willRetry) {
        // Recoverable (stream disconnect, transient 5xx, ...): Codex retries
        // the request itself and the turn keeps running. Flipping the session
        // to ERROR here made AgentManager stop polling and abandon a turn that
        // usually went on to complete.
        console.warn(`[CodexAppServerAdapter] Codex is retrying after a recoverable error: ${failure.message}`)
      } else {
        session.status = SessionStatusType.ERROR
        session.lastError = failure.message
      }
    }

    if (notification.method === 'serverRequest/resolved') {
      const requestId = params.requestId
      if (session.pendingApproval && String(session.pendingApproval.requestId) === String(requestId)) {
        session.pendingApproval = null
        if (session.status === SessionStatusType.WAITING_APPROVAL) {
          session.status = SessionStatusType.BUSY
        }
      }
    }

    this.addEvent(session, notification)
  }

  private handleApprovalRequest(
    session: AppServerSession,
    request: JsonRpcRequest,
    params: Record<string, unknown>
  ): void {
    if (session.config.permissionMode === 'allow') {
      const responseKind = this.getApprovalResponseKind(request.method)
      const selected = responseKind === 'execCommand' ? 'approved' : 'accept'
      this.sendRpcResponse(session, request.id, this.buildApprovalResponse(responseKind, selected, true))
      return
    }

    const toolCallId = asString(params.approvalId) || asString(params.itemId) || asString(params.callId) || String(request.id)
    const responseKind = this.getApprovalResponseKind(request.method)

    const rawDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
    const approvalOptions = rawDecisions.length > 0
      ? rawDecisions.map((decision) => {
          const optionId = normalizeDecisionName(decision)
          return {
            optionId,
            name: decisionLabel(optionId),
            kind: optionId.includes('accept') || optionId === 'approved' ? 'allow' : 'reject'
          }
        })
      : [
          { optionId: 'accept', name: 'Allow', kind: 'allow' },
          { optionId: 'cancel', name: 'Deny', kind: 'reject' }
        ]

    session.pendingApproval = {
      requestId: request.id,
      toolCallId,
      question: summarizeApproval(params, request.method),
      options: approvalOptions,
      responseKind
    }
    session.status = SessionStatusType.WAITING_APPROVAL
    this.onDataAvailable?.(session.threadId || session.sessionId)
  }

  private buildApprovalResponse(
    responseKind: PendingApproval['responseKind'],
    selected: string,
    approved: boolean
  ): unknown {
    switch (responseKind) {
      case 'execCommand':
        return { decision: approved ? (selected === 'approved_for_session' ? 'approved_for_session' : 'approved') : (selected === 'denied' ? 'denied' : 'abort') }
      case 'commandExecution':
        return { decision: selected }
      case 'fileChange':
      case 'permissions':
        return { decision: selected }
      case 'elicitation':
        return approved
          ? { action: 'accept', content: {} }
          : { action: 'decline' }
      case 'userInput':
        return approved
          ? { response: selected }
          : { response: null }
      default:
        return { decision: approved ? selected : 'cancel' }
    }
  }

  private getApprovalResponseKind(method: string): PendingApproval['responseKind'] {
    if (method === 'execCommandApproval') return 'execCommand'
    if (method.includes('commandExecution')) return 'commandExecution'
    if (method.includes('fileChange')) return 'fileChange'
    if (method.includes('permissions')) return 'permissions'
    if (method === 'mcpServer/elicitation/request') return 'elicitation'
    if (method === 'item/tool/requestUserInput') return 'userInput'
    return 'generic'
  }

  private resolveSandboxMode(config: SessionConfig): 'read-only' | 'workspace-write' | 'danger-full-access' {
    switch (config.sandboxMode) {
      case 'read-only':
      case 'workspace-write':
      case 'danger-full-access':
        return config.sandboxMode
      default:
        return 'danger-full-access'
    }
  }

  private buildSandboxPolicy(config: SessionConfig): CodexSandboxPolicy {
    switch (this.resolveSandboxMode(config)) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: true }
      case 'danger-full-access':
        return { type: 'dangerFullAccess' }
      case 'workspace-write':
      default:
        return {
          type: 'workspaceWrite',
          networkAccess: true,
          writableRoots: this.buildRuntimeWorkspaceRoots(config.workspaceDir)
        }
    }
  }

  private addEvent(session: AppServerSession, event: unknown): void {
    session.messageBuffer.push(event)
    session.permanentMessages.push(event)
    if (session.permanentMessages.length > 1000) {
      session.permanentMessages.splice(0, 250)
    }
    this.onDataAvailable?.(session.threadId || session.sessionId)
  }

  private bufferThreadItems(session: AppServerSession, result: unknown): void {
    const items = isObject(result) && Array.isArray(result.data) ? result.data : []
    for (const item of items) {
      this.bufferReconciledThreadItem(session, item, isObject(item) ? asString(item.turnId) : undefined)
    }
  }

  /**
   * Buffers a single thread item from a reconcile pass, skipping it if it has
   * already been buffered. reconcileCompletedTurn() re-lists the entire thread on
   * every turn/completed, so this MUST be idempotent for every item — including
   * the many Codex item types that carry no top-level `id` (function_call_output,
   * custom_tool_call_output, tool_search_output, user/developer messages). We key
   * off a stable identity (id/itemId/call_id) or, failing that, a deterministic
   * content hash, and forward that key as `itemId` so the derived part id stays
   * stable across passes. Without this, id-less items were re-emitted with a fresh
   * id on every idle and the transcript repeated older messages.
   */
  private bufferReconciledThreadItem(
    session: AppServerSession,
    item: unknown,
    turnId: string | undefined
  ): void {
    let stableItemId: string | undefined
    if (isObject(item)) {
      stableItemId = computeThreadItemKey(item, turnId)
      if (session.bufferedThreadItemIds.has(stableItemId)) return
      session.bufferedThreadItemIds.add(stableItemId)
    }
    this.addEvent(session, {
      method: 'item/completed',
      params: {
        threadId: session.threadId,
        turnId,
        item,
        ...(stableItemId ? { itemId: stableItemId } : {})
      }
    })
  }

  private async bufferAllThreadItems(session: AppServerSession, threadId: string): Promise<void> {
    try {
      let cursor: string | null = null
      for (let page = 0; page < 20; page++) {
        const result = await this.sendRpcRequest(session, 'thread/items/list', {
          threadId,
          cursor,
          limit: 200,
          sortDirection: 'asc'
        })
        this.bufferThreadItems(session, result)
        cursor = isObject(result) ? (asString(result.nextCursor) || null) : null
        if (!cursor) return
      }
      console.warn('[CodexAppServerAdapter] Stopped thread/items pagination after 20 pages')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('not supported')) throw error
      await this.bufferAllThreadTurns(session, threadId)
    }
  }

  private async bufferAllThreadTurns(session: AppServerSession, threadId: string): Promise<void> {
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      let result: unknown
      try {
        result = await this.sendRpcRequest(session, 'thread/turns/list', {
          threadId,
          cursor,
          limit: 100,
          sortDirection: 'asc',
          itemsView: 'full'
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('not materialized yet') || message.includes('before first user message')) {
          return
        }
        throw error
      }
      const turns = isObject(result) && Array.isArray(result.data) ? result.data : []
      for (const turn of turns) {
        if (!isObject(turn) || !Array.isArray(turn.items)) continue
        for (const item of turn.items) {
          this.bufferReconciledThreadItem(session, item, asString(turn.id))
        }
      }
      cursor = isObject(result) ? (asString(result.nextCursor) || null) : null
      if (!cursor) return
    }
    console.warn('[CodexAppServerAdapter] Stopped thread/turns pagination after 20 pages')
  }

  private async reconcileCompletedTurn(session: AppServerSession): Promise<void> {
    try {
      if (!session.threadId) return
      await this.bufferAllThreadItems(session, session.threadId)
    } catch (error) {
      console.warn('[CodexAppServerAdapter] Failed to reconcile completed turn items:', error)
    } finally {
      session.pendingCompletionRefreshes = Math.max(0, session.pendingCompletionRefreshes - 1)
      this.markIdleIfSettled(session)
    }
  }

  private markIdleIfSettled(session: AppServerSession): void {
    if (session.status === SessionStatusType.ERROR) return
    if (session.pendingCompletionRefreshes > 0) return
    if (session.activeTurnId) return
    if (session.sawThreadStatusNotification && !session.pendingThreadIdle) return

    session.pendingThreadIdle = false
    session.status = SessionStatusType.IDLE
    this.onDataAvailable?.(session.threadId || session.sessionId)
  }


  private sendRpcRequest(session: AppServerSession, method: string, params?: unknown): Promise<unknown> {
    // Writing to a stopped child's stdin is silent — the guard swallows the
    // EPIPE — so the request would sit on its 30 s timeout instead of
    // failing. Say so at once.
    if (session.terminated) {
      return Promise.reject(new Error(`Codex app-server is stopped, cannot send ${method}`))
    }
    return sendJsonRpcRequest(session, method, params, LABEL)
  }

  private sendRpcResponse(session: AppServerSession, id: string | number, result: unknown): void {
    writeJsonRpc(session, { jsonrpc: '2.0', id, result }, LABEL)
  }

  private sendRpcNotification(session: AppServerSession, method: string, params?: unknown): void {
    writeJsonRpc(session, { jsonrpc: '2.0', method, params }, LABEL)
  }

  private convertEventToMessageParts(
    event: unknown,
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session: AppServerSession
  ): MessagePart[] {
    return convertEventToMessageParts(event, seenPartIds, partContentLengths, session)
  }

  private requireSession(sessionId: string): AppServerSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }
}

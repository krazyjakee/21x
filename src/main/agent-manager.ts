import { DEFAULT_SERVER_URL } from './adapters/opencode-server'
import { guardedIpcSend } from './guarded-ipc-send'
import { transcriptDisplayPart } from './transcript-display'
import { finishSessionFeedback, updateTaskFromUser } from './session-feedback'
import { buildAgentSwitchRecap, INITIAL_PROMPT_PART_PREFIX } from './agent-handoff'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { powerSaveBlocker } from 'electron'
import type { BrowserWindow } from 'electron'
import type { AgentRecord, DatabaseManager, TaskRecord } from './database'
import { TaskStatus } from '../shared/constants'
import { isCoordinatorTask } from '../shared/task-roles'
import { emitTaskEvent } from './project-events'
import { findBlockingSibling, isSuccessorGraphInProgress, successorsFireOnReview } from '../shared/subtask-graph'
import type { WorktreeManager } from './worktree-manager'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { ForgejoManager } from './forgejo-manager'
import type { AcpAdapter } from './adapters/acp-adapter'
import type { CodingAgentAdapter, SessionConfig, SessionMessage, SessionStatus as AdapterSessionStatus } from './adapters/coding-agent-adapter'
import { SessionStatusType, MessagePartType } from './adapters/coding-agent-adapter'
import { randomUUID } from 'crypto'
import { registerSecretSession, unregisterSecretSession, getSecretBrokerPort } from './secret-broker'
import type { Artifact } from '../shared/artifacts'
import { extractOutputFromMessages } from './output-extraction'
import { CodingAgentType, createAdapter, getAgentProvider, isCodexAppServerAdapter } from './agent-manager/adapter-factory'
import { assembleSessionConfig, buildMcpServers, isTriageSessionTask, mcpOptionsForTask, type McpServerOptions } from './agent-manager/session-config'
import { getAdapterMcpAttachFailures, getMemoryFileName, writeSkillFiles } from './agent-manager/workspace-docs'
import { buildDisplayMessage, buildMessageWithAttachmentContext, syncAttachmentsToWorkspace, type MessageAttachmentRef } from './agent-manager/attachments'
import { emptySkillSyncResult, syncSkillsFromDirectory, type SkillSyncResult } from './agent-manager/skills-sync'
import { ARTIFACT_WORKSPACE_INSTRUCTIONS, HEARTBEAT_MONITORING_INSTRUCTIONS, buildSubtaskWakeMessage, buildTaskWorkPrompt, buildTillDoneNudge, buildTriagePrompt } from './agent-manager/prompts'
import { setupTaskWorktrees } from './agent-manager/worktree-setup'
import { listProjectRepos, taskProjectId } from './agent-manager/project-repos'
import { assistantTextKey, dedupStateFromHistory, hasMatchingErrorMessage, pruneDedup } from './agent-manager/output-dedup'
import { findCreditExhaustionMessage, normalizeFallbackAgentIds } from './agent-manager/credit-exhaustion'
import { STUCK_SESSION_TIMEOUT_MS, findStuckTool, hasGarbledOutput, isDelegationTool, isWaitingForUserInput, type RunningTool } from './agent-manager/watchdogs'
import { MAX_CONCURRENT_AGENT_SESSIONS_SETTING, StartQueue, checkAdmission, isExemptFromAdmission, isGlobalAdmissionReason, parseGlobalSessionLimit, type AdmissionDecision, type AdmissionLimits, type AdmissionReason, type CountedSession, type QueuedStartInfo } from './agent-manager/admission'
import { buildProjectLimitState, describeQueueReason, isAllProjectsPaused, projectAdmissionLimits, recordProjectSessionStart, setAllProjectsPaused, type ProjectLimitState } from './project-limits'
import { FINDINGS_BEGIN, FINDINGS_END, SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'
import { collectMissedParts, debugTranscript, emitArtifactUpdatesFromParts, textTranscript, type DebugTranscriptMessage, notifyStatusTransition, transcriptPartsFromEvent, transcriptPartsFromMessages, type OutputMessage } from './agent-manager/transcript-events'

// Default OpenCode server URL (matches database default)

const DONE_TODO_STATUSES = ['completed', 'cancelled', 'done', 'removed']

/** Yields to the event loop between bursts of synchronous DB / FS calls so IPC
 *  and rendering are not starved (better-sqlite3 calls block the main thread). */
const yieldEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Outcome of a session start that went through admission control. */
export type SessionStartOutcome =
  | { status: 'started'; sessionId: string }
  | { status: 'queued'; position: number; reason: AdmissionReason }

interface TodoItem {
  content: string
  status: string
}

interface AgentSession {
  id: string
  agentId: string
  taskId: string
  workspaceDir?: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  createdAt: Date
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  assistantTextKeys?: Set<string>
  isTriageSession?: boolean
  lastAssistantText?: string
  /** Latest todo list captured from todowrite tool calls during polling. */
  todos?: TodoItem[]
  adapter?: CodingAgentAdapter
  secretSessionToken?: string
  pollingStarted?: boolean
  /** True after an auto-abort notice has been shown for the current prompt.
   *  Reset when the user sends a new prompt or the adapter emits fresh output. */
  autoAbortNotified?: boolean
  /** Timestamp of the last observed activity (creation, new output, prompt,
   *  or idle transition). Used by the inactivity reaper to decide when an
   *  idle session's in-memory runtime can be released. Idle is only a state
   *  flag — a released session is always resumable from the persisted
   *  session_id, so nothing is lost. */
  lastActivityAt?: number
  /** Ordered automatic handoff candidates still available for this task run. */
  fallbackAgentIds: string[]
  /** Prevents fallback cycles such as Claude -> Codex -> Claude. */
  attemptedAgentIds: Set<string>
  fallbackInProgress?: boolean
}

interface AgentFallbackState {
  remainingAgentIds: string[]
  attemptedAgentIds: Set<string>
}

/** Entry tracked by the centralized polling coordinator */
interface PollingEntry {
  sessionId: string
  adapter: CodingAgentAdapter
  config: SessionConfig
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  assistantTextKeys?: Set<string>
  /** Start of this polling cycle; drives the IDLE grace period. */
  createdAt: number
  /** True once a non-IDLE status was seen in this cycle. */
  hasSeenWork?: boolean
  /** Last time data arrived; drives the post-data grace period and the watchdog. */
  lastPartReceivedAt?: number
  /** True when the adapter buffered new data after this cycle's pollMessages()
   *  call. The data is still behind the adapter's cursor, so the session must
   *  NOT be unregistered yet: the next cycle has to drain it first. */
  dataArrivedSincePoll?: boolean
  /** How many times the tillDone nudge has been sent for this polling cycle.
   *  Capped at MAX_TILLDONE_NUDGES to prevent infinite nudge loops. */
  tillDoneNudgeCount?: number
  /** True once the stuck-session watchdog has fired for this polling cycle.
   *  Prevents the abort message from spamming every poll tick while the
   *  backend is still transitioning from BUSY → IDLE after the abort. */
  watchdogFired?: boolean
  /** Count of consecutive poll cycles containing garbled model output
   *  (e.g. hallucinated `<｜DSML｜` tool-call markup as plain text).
   *  Once it exceeds the threshold the session is aborted immediately
   *  instead of waiting for the full watchdog timeout. */
  garbledOutputCount?: number
}

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  /** Maps old (temp) session IDs to their re-keyed (real) IDs so that
   *  stale IDs from the renderer still resolve after pollSingleSession re-keys. */
  private sessionIdRedirects: Map<string, string> = new Map()
  private db: DatabaseManager
  private mainWindow: BrowserWindow | null = null
  private adapters: Map<string, CodingAgentAdapter> = new Map()
  private worktreeManager: WorktreeManager | null = null
  private githubManager: GitHubManager | null = null
  private gitlabManager: GitLabManager | null = null
  private forgejoManager: ForgejoManager | null = null
  private oauthManager: import('./oauth/oauth-manager').OAuthManager | null = null
  private externalListeners: Array<(channel: string, data: unknown) => void> = []

  // ── Centralized Polling Coordinator ──
  // Instead of N independent setTimeout loops (one per session),
  // a single timer sequentially polls all active sessions, preventing
  // simultaneous sync DB calls from stacking up and starving the event loop.
  private pollingEntries: Map<string, PollingEntry> = new Map()
  private pollingTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly POLL_INTERVAL_MS = 2000
  // Maximum number of session ID redirects to keep (old temp IDs → real IDs).
  // Without a cap these grow forever across many session start/stop cycles.
  private static readonly MAX_SESSION_REDIRECTS = 200
  /** Maximum number of tillDone idle nudges per session before giving up. */
  private static readonly MAX_TILLDONE_NUDGES = 5
  /** No IDLE transition this soon after a prompt unless work was seen. */
  private static readonly IDLE_GRACE_PERIOD_MS = 15_000
  /** No IDLE transition this soon after the last received data. */
  private static readonly POST_DATA_GRACE_MS = 5_000

  // ── Idle-session inactivity reaper ──
  // Going idle NEVER terminates a session — idle is only a state flag, and
  // termination is decoupled from it. A separate low-frequency sweep releases
  // the in-memory runtime of sessions that have been idle for a long time.
  // This is safe because the conversation lives with the backend/CLI and the
  // persisted task.session_id lets sendMessage resume it on demand, so an
  // idle agent costs ~nothing and can always be woken later.
  /** How long a session must be continuously idle before its runtime is released. */
  private static readonly IDLE_SESSION_REAP_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes
  /** How often the reaper sweeps. Deliberately infrequent — idle sessions are
   *  not polled at all between sweeps. */
  private static readonly IDLE_REAP_SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
  private reaperTimer: ReturnType<typeof setInterval> | null = null

  /** Parents currently being woken after subtask completion (dedupe guard so
   *  several subtasks finishing at once produce a single wake-up). */
  private wakingParents: Set<string> = new Set()
  /** Completed subtasks whose explicit successor edges are being followed. */
  private routingCompletedSubtasks: Set<string> = new Set()

  /** Sessions currently being re-registered for polling after late adapter data
   *  (dedupe guard so a burst of buffered messages produces a single wake-up). */
  private wakingSessions: Set<string> = new Set()

  // ── App-suspension guard ──
  // Without this, macOS App Nap (and Windows efficiency mode) can suspend the
  // whole 20x process tree when the window is hidden/idle — pausing spawned
  // agent CLI processes mid-run, including their in-process background
  // subagents that legitimately keep working after a turn goes idle. Hold a
  // `prevent-app-suspension` blocker while ANY session runtime is alive (not
  // just non-idle ones, precisely because of those background children); the
  // idle-session reaper releases runtimes after 30 min, which drops the
  // blocker too. This does not keep the display awake or prevent lid-close
  // sleep — it only opts out of idle-time process suspension.
  private powerSaveBlockerId: number | null = null

  // ── Event-driven nudge ──
  // When an adapter buffers new stream data it calls onDataAvailable().
  // We debounce that into a short nudge timer so the coordinator delivers
  // the data to the UI within ~50ms instead of waiting up to 2 seconds.
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly NUDGE_DELAY_MS = 50
  /** Set when a nudge arrives while a cycle is already running. The cycle may
   *  have polled that session already, so the signal cannot simply be dropped;
   *  tick() re-raises it once the cycle ends. */
  private nudgeRequestedDuringTick = false
  private transcriptChangedTimer: ReturnType<typeof setTimeout> | null = null
  private pendingTranscriptChanged = new Map<string, { sinceRev: number; maxRev: number }>()
  private static readonly TRANSCRIPT_CHANGED_FLUSH_MS = 125
  private pollingInProgress = false  // Prevents overlapping tick() calls
  private pollTickFn: (() => Promise<void>) | null = null

  // Track last sent status per session to detect transitions for OS notifications
  private lastSentStatus: Map<string, string> = new Map()

  // ── Admission control (see agent-manager/admission.ts) ──
  /** Starts waiting for a free slot, FIFO, one per task. */
  private startQueue = new StartQueue()
  /** taskId → agentId of admitted starts whose session is not registered yet.
   *  They hold their slot so concurrent requests cannot all slip past. */
  private admittedStarts: Map<string, string> = new Map()
  private startQueueDrainScheduled = false
  /** `projectId:reason` pairs the project's Mastermind has been told about (#65),
   *  cleared when one of the project's queued starts runs. */
  private projectLimitNotices: Set<string> = new Set()

  constructor(db: DatabaseManager) {
    super()
    this.db = db
    this.startIdleSessionReaper()
  }

  /**
   * True when the task is coordinating subtasks that are still being worked on.
   * Child progress counts as parent activity: a coordinator session that is
   * silent while its subtask agents run is NOT stuck and must not be aborted
   * or reaped, otherwise the child work gets orphaned or cascaded-killed.
   */
  private hasActiveSubtaskWork(taskId: string): boolean {
    try {
      const subtasks = this.db.getSubtasks(taskId)
      return subtasks.some(
        (s) => s.status === TaskStatus.AgentWorking || s.status === TaskStatus.Triaging
      )
    } catch {
      return false
    }
  }

  /**
   * Low-frequency background sweep that releases the in-memory runtime of
   * long-idle sessions. Never touches sessions with an active turn, never
   * touches coordinators whose subtasks are still running, and never resets
   * task status — a released session is resumed transparently by sendMessage
   * via the persisted session_id.
   */
  private startIdleSessionReaper(): void {
    if (this.reaperTimer) return
    this.reaperTimer = setInterval(() => {
      this.reapInactiveSessions().catch((err) => {
        console.error('[AgentManager] Idle-session reaper sweep failed:', err)
      })
    }, AgentManager.IDLE_REAP_SWEEP_INTERVAL_MS)
    // Don't let the sweep timer keep the process alive on shutdown
    this.reaperTimer.unref?.()
  }

  /**
   * Start/stop the app-suspension blocker based on whether any agent session
   * runtime is alive. Called (via setImmediate, so the sessions map has
   * settled) after every session add/remove and status transition. Safe under
   * ELECTRON_RUN_AS_NODE (tests): powerSaveBlocker is unavailable there and
   * the method no-ops.
   */
  private updatePowerSaveBlocker(): void {
    if (typeof powerSaveBlocker?.start !== 'function') return
    try {
      const hasLiveRuntime = this.sessions.size > 0
      if (hasLiveRuntime && this.powerSaveBlockerId === null) {
        this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
        console.log('[AgentManager] App-suspension blocker started (agent session runtime alive)')
      } else if (!hasLiveRuntime && this.powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(this.powerSaveBlockerId)
        this.powerSaveBlockerId = null
        console.log('[AgentManager] App-suspension blocker stopped (no live session runtimes)')
      }
    } catch (err) {
      console.error('[AgentManager] Failed to update app-suspension blocker:', err)
    }
  }

  /** Schedule a blocker update once the current mutation of the sessions map
   *  has fully settled. */
  private schedulePowerSaveBlockerUpdate(): void {
    setImmediate(() => this.updatePowerSaveBlocker())
  }

  private async reapInactiveSessions(): Promise<void> {
    // Safety net for limits raised in settings or the agent form: nothing
    // else signals those, so re-check the queue on every sweep.
    this.scheduleStartQueueDrain()
    const now = Date.now()
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      // Only idle sessions are candidates — an active turn is never reaped.
      if (session.status !== 'idle') continue

      const idleForMs = now - (session.lastActivityAt ?? session.createdAt.getTime())
      if (idleForMs < AgentManager.IDLE_SESSION_REAP_THRESHOLD_MS) continue

      const task = this.db.getTask(session.taskId)
      // Pseudo-tasks (heartbeat-*) have no DB row — leave them alone. The
      // Mastermind has one, so it is released like any task and resumed by
      // the next message from its persisted session_id.
      if (!task) continue
      // No persisted resume anchor — releasing the runtime would lose the
      // conversation, so keep it in memory.
      if (!task.session_id) continue
      // Coordinator with running children — child completion will wake it, and
      // tearing it down mid-orchestration churns resume cycles for no benefit.
      if (this.hasActiveSubtaskWork(session.taskId)) continue
      // Same, for in-process background subagents (Claude Code Task tool). These
      // have no DB subtask row, so hasActiveSubtaskWork can't see them — but
      // destroying the session here aborts the query and kills them outright.
      if (await this.hasActiveDelegationTools(session)) continue

      console.log(
        `[AgentManager] Releasing runtime of idle session ${sessionId} (task ${session.taskId}, idle ${Math.round(idleForMs / 1000)}s). ` +
        `Resumable on demand from persisted session_id.`
      )
      try {
        // resetTaskStatus=false: reaping is a resource release, not a user stop.
        await this.stopSession(sessionId, false)
      } catch (err) {
        console.error(`[AgentManager] Failed to release idle session ${sessionId}:`, err)
      }
    }
  }

  /**
   * True when the session's adapter still reports a delegation tool (subagent
   * spawn / backgrounded task) in flight. Used to keep the inactivity reaper off
   * sessions whose in-process children are still working.
   */
  private async hasActiveDelegationTools(session: AgentSession): Promise<boolean> {
    const adapter = session.adapter
    if (!adapter || typeof adapter.getRunningTools !== 'function') return false
    try {
      const sessionId = this.findSessionIdFor(session)
      if (!sessionId) return false
      const tools = await adapter.getRunningTools(sessionId, this.sessionConfigFor(session))
      return tools.some((t) => isDelegationTool(t.toolName))
    } catch {
      return false
    }
  }

  /** Reverse lookup of the sessions-map key for a given session object. */
  private findSessionIdFor(session: AgentSession): string | undefined {
    for (const [id, s] of this.sessions.entries()) {
      if (s === session) return id
    }
    return undefined
  }

  /**
   * Set the sync manager for executing task source actions (e.g. completing tasks at the source).
   * Called after both AgentManager and SyncManager are created.
   */
  private syncManager?: import('./sync-manager').SyncManager

  setSyncManager(syncManager: import('./sync-manager').SyncManager): void {
    this.syncManager = syncManager
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setManagers(githubManager: GitHubManager, worktreeManager: WorktreeManager, gitlabManager?: GitLabManager, forgejoManager?: ForgejoManager): void {
    this.githubManager = githubManager
    this.worktreeManager = worktreeManager
    this.gitlabManager = gitlabManager ?? null
    this.forgejoManager = forgejoManager ?? null
  }

  setOAuthManager(manager: import('./oauth/oauth-manager').OAuthManager): void {
    this.oauthManager = manager
  }

  /**
   * The repos of a task's project, for the triage prompt. A failed read must
   * not stop triage: the agent can still call list_repos.
   */
  private projectRepoNames(task: TaskRecord): string[] {
    try {
      return listProjectRepos(this.db, taskProjectId(task)).map((repo) => repo.fullName)
    } catch (error) {
      console.warn(`[AgentManager] Could not read the project repos of task ${task.id} for triage:`, error)
      return []
    }
  }

  private setupWorktreeIfNeeded(taskId: string): Promise<string | undefined> {
    const { worktreeManager, githubManager, gitlabManager, forgejoManager } = this
    return setupTaskWorktrees(this.db, { worktreeManager, githubManager, gitlabManager, forgejoManager }, taskId)
  }

  private getAdapter(agentId: string): CodingAgentAdapter | null {
    const agent = this.db.getAgent(agentId)
    if (!agent) return null
    return this.getAdapterByType(getAgentProvider(agent))
  }

  /** Adapters are created lazily and cached per backend type. */
  private getAdapterByType(backendType: string): CodingAgentAdapter | null {
    const cached = this.adapters.get(backendType)
    if (cached) return cached
    const adapter = createAdapter(backendType, this.db)
    if (adapter) this.adapters.set(backendType, adapter)
    return adapter
  }

  private buildMcpServersForAdapter(agentId: string, opts?: McpServerOptions): ReturnType<typeof buildMcpServers> {
    return buildMcpServers(this.db, this.oauthManager, agentId, opts)
  }

  /** Session config for follow-up calls on an existing session (send, abort, stop). */
  private async buildSessionConfig(agentId: string, taskId: string, workspaceDir?: string): Promise<SessionConfig> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    const task = this.db.getTask(taskId)
    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(taskId, task, this.heartbeatScopeTask(taskId, task)))
    // Task context keeps follow-up messages after idle aware of the task;
    // without it doSendAdapterMessage sends a bare prompt. A coordinator row
    // is not work to describe.
    const taskContext = task && !isCoordinatorTask(task)
      ? `\n\n[Task Context]\nTask: "${task.title}"\n${task.description || ''}${ARTIFACT_WORKSPACE_INSTRUCTIONS}`
      : ''
    return assembleSessionConfig(this.db, agent, {
      agentId,
      taskId,
      task,
      workspaceDir: workspaceDir || this.db.getWorkspaceDir(taskId),
      mcpServers,
      systemPrompt: (agent.config?.system_prompt || '') + taskContext,
      secretToken: this.findSessionByTask(agentId, taskId)?.secretSessionToken
    })
  }

  /** Minimal adapter config for status/message reads on a live session. */
  private sessionConfigFor(session: AgentSession): SessionConfig {
    return {
      agentId: session.agentId,
      taskId: session.taskId,
      workspaceDir: session.workspaceDir || this.db.getWorkspaceDir(session.taskId)
    }
  }

  /**
   * Sets up a secret broker session for an agent, registering its secrets.
   * Returns the token, or undefined if no secrets are configured.
   */
  private setupSecretSession(agentId: string): string | undefined {
    const agent = this.db.getAgent(agentId)
    const secretIds = agent?.config?.secret_ids
    if (!secretIds || secretIds.length === 0) return undefined

    const brokerPort = getSecretBrokerPort()
    if (!brokerPort) {
      console.warn('[AgentManager] Secret broker not running — secrets will not be injected')
      return undefined
    }

    const token = randomUUID()
    registerSecretSession(token, agentId, secretIds)
    console.log(`[AgentManager] Secret session registered for agent ${agentId} with ${secretIds.length} secret(s)`)
    return token
  }

  private findSessionByTask(agentId: string, taskId: string): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId && session.taskId === taskId) {
        return session
      }
    }
    return undefined
  }

  /** Looks a session up by id, following a temp -> real re-key redirect. */
  private resolveSession(sessionId: string, caller?: string): { sessionId: string; session: AgentSession } | undefined {
    const session = this.sessions.get(sessionId)
    if (session) return { sessionId, session }
    const redirectedId = this.sessionIdRedirects.get(sessionId)
    const redirected = redirectedId ? this.sessions.get(redirectedId) : undefined
    if (!redirectedId || !redirected) return undefined
    if (caller) {
      console.log(`[SessionTracker] REDIRECT from=${sessionId} to=${redirectedId} reason=stale_id_in_${caller}`)
    }
    return { sessionId: redirectedId, session: redirected }
  }

  private emitStatus(sessionId: string, owner: { agentId: string; taskId: string }, status: AgentSession['status']): void {
    this.sendToRenderer('agent:status', { sessionId, agentId: owner.agentId, taskId: owner.taskId, status })
    // Every idle transition and every stop ends here: a slot may have freed.
    if (status === 'idle' || status === 'error') this.scheduleStartQueueDrain()
    // Project events (#57): an agent waiting on the user, or one that failed,
    // wakes the project's Mastermind. Pseudo-tasks and coordinator rows are
    // dropped by emitTaskEvent itself.
    if (status === 'waiting_approval') emitTaskEvent(this.db, 'approval_pending', owner.taskId)
    else if (status === 'error') emitTaskEvent(this.db, 'task_failed', owner.taskId)
  }

  private emitSystemError(sessionId: string, taskId: string, id: string, content: string): void {
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId,
      type: 'message',
      data: { id, role: 'system', content, partType: 'error' }
    })
  }

  private emitSystemNotice(sessionId: string, taskId: string, id: string, content: string): void {
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId,
      type: 'message',
      data: { id, role: 'system', content, partType: 'text' }
    })
  }

  async stopServer(): Promise<void> {
    const adapter = this.adapters.get(CodingAgentType.OPENCODE)
    if (adapter && 'stopServer' in adapter && typeof (adapter as { stopServer: () => Promise<void> }).stopServer === 'function') {
      console.log('[AgentManager] Delegating server stop to OpencodeAdapter')
      await (adapter as { stopServer: () => Promise<void> }).stopServer()
    }
  }

  /**
   * Starts a session using a coding agent adapter (Claude Code, etc.)
   *
   * @param handoffFromAgentName - Set when this session replaces a different
   * agent mid-task (see switchAgent). Prepends a recap of the existing
   * transcript to the initial prompt instead of starting from a blank slate,
   * since the new adapter's own session has no memory of what came before —
   * each coding agent backend has its own incompatible session format, so
   * there is no native way to "resume" across a switch.
   */
  private async startAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    taskId: string,
    workspaceDir?: string,
    skipInitialPrompt?: boolean,
    handoffFromAgentName?: string,
    inheritedFallbackState?: AgentFallbackState
  ): Promise<string> {
    const agent = this.db.getAgent(agentId)!
    workspaceDir ||= this.db.getWorkspaceDir(taskId)

    const task = this.db.getTask(taskId)
    const isTriageSession = isTriageSessionTask(taskId, task)
    await yieldEventLoop()

    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(taskId, task, this.heartbeatScopeTask(taskId, task)))

    // Written AFTER the MCP map is built so the documentation describes the
    // servers this session really gets, instead of the agent configuration,
    // which both over- and under-reports them.
    await writeSkillFiles(this.db, taskId, agentId, workspaceDir, mcpServers)
    await yieldEventLoop()

    const secretToken = this.setupSecretSession(agentId)
    const sessionConfig = assembleSessionConfig(this.db, agent, {
      agentId,
      taskId,
      task,
      workspaceDir,
      mcpServers,
      systemPrompt: agent.config?.system_prompt,
      secretToken,
      onModelNotice: (notice) => this.emitSystemError('', taskId, `skill-model-${Date.now()}`, notice)
    })
    await yieldEventLoop()

    console.log(`[AgentManager] startAdapterSession: agent=${agent.name}, coding_agent=${agent.config?.coding_agent || 'opencode'}, model=${agent.config?.model}, adapter=${adapter.constructor.name}`)
    await adapter.initialize()

    const adapterSessionId = await adapter.createSession(sessionConfig)
    console.log(`[AgentManager] Session created: ${adapterSessionId}, workspaceDir=${workspaceDir}`)

    // OpenCode receives its MCP servers through runtime calls, so attachment can
    // still fail after the documentation was written. Rewrite the documentation
    // without the servers that are not attached: an agent that is told it has 35
    // task-management tools it cannot call behaves far worse than one that knows
    // it has none.
    const attachFailures = getAdapterMcpAttachFailures(adapter, adapterSessionId)
    if (attachFailures.length > 0) {
      console.error(
        `[AgentManager] MCP servers NOT attached for session ${adapterSessionId}: ${attachFailures.join(', ')} — ` +
        `rewriting session documentation without them`
      )
      const attached = Object.fromEntries(
        Object.entries(mcpServers).filter(([name]) => !attachFailures.includes(name))
      )
      await writeSkillFiles(this.db, taskId, agentId, workspaceDir, attached)
    }

    this.schedulePowerSaveBlockerUpdate()
    // Keep one shared set across nested startup fallbacks. If a replacement
    // itself exhausts credits before startAdapterSession returns, the outer
    // handoff must see every agent the nested handoff already attempted.
    const attemptedAgentIds = inheritedFallbackState?.attemptedAgentIds ?? new Set<string>()
    attemptedAgentIds.add(agentId)
    const configuredFallbacks = normalizeFallbackAgentIds(agent.config?.fallback_agent_ids)
    const fallbackAgentIds = [
      ...(inheritedFallbackState?.remainingAgentIds ?? []),
      ...configuredFallbacks,
    ].filter((id, index, ids) => id !== agentId && !attemptedAgentIds.has(id) && ids.indexOf(id) === index)

    this.sessions.set(adapterSessionId, {
      id: adapterSessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'working',
      createdAt: new Date(),
      lastActivityAt: Date.now(),
      seenMessageIds: new Set(),
      seenPartIds: new Set(),
      partContentLengths: new Map(),
      assistantTextKeys: new Set(),
      adapter,
      isTriageSession,
      secretSessionToken: secretToken,
      fallbackAgentIds,
      attemptedAgentIds
    })

    this.updateTaskFromLocalAgent(taskId, { session_id: adapterSessionId })
    console.log(`[SessionTracker] CREATED session=${adapterSessionId} task=${taskId} agent=${agentId} reason=new_session`)

    // Triage sessions keep the Triaging status; coordinator rows have none.
    if (!isTriageSession && !isCoordinatorTask(task)) {
      this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.AgentWorking })
      this.sendToRenderer('task:updated', {
        taskId,
        updates: { status: TaskStatus.AgentWorking }
      })
    }
    await yieldEventLoop()

    this.emitStatus(adapterSessionId, { agentId, taskId }, 'working')

    this.startAdapterPolling(adapterSessionId, adapter, sessionConfig)

    if (!skipInitialPrompt) {
      let promptText: string
      if (isTriageSession && task) {
        promptText = buildTriagePrompt(task, this.projectRepoNames(task))
      } else {
        promptText = buildTaskWorkPrompt(this.db, taskId, task ?? this.db.getTask(taskId))
        const attachmentRefs = syncAttachmentsToWorkspace(this.db, taskId, workspaceDir)
        if (attachmentRefs.length > 0) {
          promptText += `\n\nAttached files (relative to your working directory):\n${attachmentRefs.join('\n')}`
        }
      }
      promptText += HEARTBEAT_MONITORING_INSTRUCTIONS
      // In the user message because agents follow it more reliably than the system prompt.
      promptText += `\n\nIMPORTANT: First, read the \`${getMemoryFileName(this.db, agentId)}\` file in the working directory — it has workspace config, skills, and project context.`

      // Agent handoff — prepend a recap of the existing conversation so the
      // new agent isn't starting from a blank slate. Comes last so it reads
      // first, right before the actual work instructions.
      if (handoffFromAgentName) {
        const recap = buildAgentSwitchRecap(this.db.getTranscriptParts(taskId))
        if (recap) {
          promptText = `## Picking up from ${handoffFromAgentName}\n\nThis task was previously being worked on by a different agent. Here is the conversation so far:\n\n${recap}\n\n---\n\n${promptText}`
        }
      }

      // Show the full prompt so the user can see the complete context sent to
      // the agent (repos, skills, secrets, heartbeat, etc.)
      this.sendToRenderer('agent:output', {
        sessionId: adapterSessionId,
        taskId,
        type: 'message',
        data: {
          id: `${INITIAL_PROMPT_PART_PREFIX}${Date.now()}`,
          role: 'user',
          content: promptText,
          partType: 'text'
        }
      })

      try {
        await adapter.sendPrompt(adapterSessionId, [{ type: MessagePartType.TEXT, text: promptText }], sessionConfig)
      } catch (sendError) {
        console.error(`[AgentManager] sendPrompt FAILED:`, sendError)
        const message = sendError instanceof Error ? sendError.message : String(sendError)
        const session = this.sessions.get(adapterSessionId)
        if (session && findCreditExhaustionMessage([message]) && await this.tryAutomaticFallback(adapterSessionId, session, message)) {
          return this.findSessionByTaskId(taskId)?.sessionId || adapterSessionId
        }
        throw sendError
      }
    }

    return adapterSessionId
  }

  // ── Centralized Polling Coordinator ──────────────────────────────
  //
  // Instead of N independent setTimeout loops (one per session that can fire
  // simultaneously, stacking sync DB calls and starving the event loop),
  // a SINGLE timer sequentially polls all registered sessions.

  /**
   * Registers a session for centralized polling and starts the coordinator
   * if it isn't already running.
   */
  private startAdapterPolling(
    initialSessionId: string,
    adapter: CodingAgentAdapter,
    config: SessionConfig,
    existingSession?: AgentSession
  ): void {
    const entry: PollingEntry = {
      sessionId: initialSessionId,
      adapter,
      config,
      seenMessageIds: existingSession?.seenMessageIds ?? new Set<string>(),
      seenPartIds: existingSession?.seenPartIds ?? new Set<string>(),
      partContentLengths: existingSession?.partContentLengths ?? new Map<string, string>(),
      assistantTextKeys: existingSession?.assistantTextKeys ?? new Set<string>(),
      createdAt: Date.now(),
      // Always start fresh: each call to startAdapterPolling corresponds to a
      // newly-sent (fire-and-forget) prompt.  The IDLE grace period must apply
      // to every new prompt — not only to brand-new sessions — because the
      // backend can briefly report IDLE after a follow-up prompt while it is
      // still ingesting the request.  Pre-setting this to true when resuming
      // with an existing session caused follow-up messages (especially on
      // opencode) to transition to idle before any response was produced.
      hasSeenWork: false
    }

    this.pollingEntries.set(initialSessionId, entry)
    console.log(`[AgentManager] Registered session ${initialSessionId} for polling (${this.pollingEntries.size} active)`)

    // Wire up event-driven nudge so the adapter can trigger an immediate
    // poll cycle when new stream data is buffered (instead of waiting for
    // the 2-second heartbeat).
    if (!adapter.onDataAvailable) {
      adapter.onDataAvailable = (dataSessionId: string) => {
        // A session whose polling was already stopped (it went idle) can still
        // produce data later — Claude Code backgrounds subagents, so the turn
        // ends first and the children report back afterwards. Re-register it,
        // otherwise nudgePollingCoordinator() is a no-op and the work is lost.
        this.wakeSessionOnAdapterData(dataSessionId)
        // Remember that data landed. If it landed after this cycle already
        // polled the session, the cycle must not unregister it — see the
        // IDLE branch of pollSingleSession().
        const dataEntry = this.pollingEntries.get(dataSessionId)
        if (dataEntry) dataEntry.dataArrivedSincePoll = true
        this.nudgePollingCoordinator()
      }
    }

    this.ensurePollingCoordinator()
  }

  /**
   * Re-registers a session for polling when its adapter buffers new data after
   * polling was already stopped.
   *
   * Claude Code runs Task-tool subagents in the background: the coordinator's
   * turn ends (and the session is unregistered from polling) while the children
   * keep working and report back minutes later.  Without this, that later output
   * is buffered in the adapter forever — `nudgePollingCoordinator()` bails out
   * when `pollingEntries` is empty, so `onDataAvailable` was a dead callback.
   *
   * Only wakes when the adapter itself reports it is busy again, so trailing
   * data from a genuinely-finished session doesn't ping-pong the task status.
   */
  private wakeSessionOnAdapterData(sessionId: string): void {
    if (this.pollingEntries.has(sessionId)) return
    if (this.wakingSessions.has(sessionId)) return

    const resolved = this.resolveSession(sessionId)
    const session = resolved?.session
    const adapter = session?.adapter
    if (!resolved || !session || !adapter) return

    // Do not use session.status as a guard here. The polling entry is removed
    // before transitionToIdle() completes, so there is a short interval where
    // the session still says "working" but no poller exists. A harness event in
    // that interval must re-register polling or its buffered data is stranded.

    const targetId = resolved.sessionId
    this.wakingSessions.add(targetId)
    void (async () => {
      try {
        if (this.pollingEntries.has(targetId)) return
        const status = await adapter.getStatus(targetId, this.sessionConfigFor(session))
        if (status.type !== SessionStatusType.BUSY && status.type !== SessionStatusType.WAITING_APPROVAL) {
          return
        }
        if (this.pollingEntries.has(targetId)) return

        console.log(
          `[AgentManager] Session ${targetId} produced data after going idle and is ${status.type} again ` +
          `(background subagent work) — resuming polling`
        )

        // transitionToIdle may already have flipped the task to ready_for_review;
        // put it back to working so the UI reflects the still-running children.
        const task = this.db.getTask(session.taskId)
        if (task && task.status === TaskStatus.ReadyForReview) {
          this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.AgentWorking })
          this.sendToRenderer('task:updated', {
            taskId: session.taskId,
            updates: { status: TaskStatus.AgentWorking }
          })
        }

        this.resumeAdapterPollingAfterPrematureIdle(targetId, session)
      } catch (err) {
        console.error(`[AgentManager] wakeSessionOnAdapterData failed for ${targetId}:`, err)
      } finally {
        this.wakingSessions.delete(targetId)
      }
    })()
  }

  private stopAdapterPolling(sessionId: string): void {
    this.pollingEntries.delete(sessionId)
    console.log(`[AgentManager] Unregistered session ${sessionId} from polling (${this.pollingEntries.size} remaining)`)

    if (this.pollingEntries.size === 0) {
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer)
        this.pollingTimer = null
      }
      if (this.nudgeTimer) {
        clearTimeout(this.nudgeTimer)
        this.nudgeTimer = null
      }
      console.log('[AgentManager] Polling coordinator stopped (no active sessions)')
    }
  }

  private sendAutoAbortMessageOnce(
    sessionId: string,
    session: AgentSession,
    taskId: string,
    idPrefix: string,
    content: string,
    suppressTranscript = false
  ): boolean {
    if (session.autoAbortNotified) return false
    session.autoAbortNotified = true
    if (suppressTranscript) return true
    this.emitSystemError(sessionId, taskId, `${idPrefix}-${Date.now()}`, content)
    return true
  }

  private ensurePollingCoordinator(): void {
    if (this.pollingTimer || this.pollingInProgress) return // Already running or executing

    const tick = async (): Promise<void> => {
      // Prevent overlapping tick() calls from nudge + heartbeat firing together
      if (this.pollingInProgress) return
      this.pollingInProgress = true

      // Clear the timer reference — this tick is now executing, not pending.
      // ensurePollingCoordinator checks this to know whether to start a new loop.
      this.pollingTimer = null

      try {
        const entries = [...this.pollingEntries.values()]

        // Poll each session SEQUENTIALLY — never concurrently — to avoid
        // stacking sync DB calls that starve the event loop.
        for (const entry of entries) {
          if (!this.pollingEntries.has(entry.sessionId)) continue
          await this.pollSingleSession(entry)
          await yieldEventLoop()
        }
      } catch (error) {
        console.error('[AgentManager] Polling coordinator error:', error)
      } finally {
        this.pollingInProgress = false
      }

      // ALWAYS reschedule if there are active sessions (even after errors).
      if (this.pollingEntries.size > 0) {
        this.pollingTimer = setTimeout(tick, AgentManager.POLL_INTERVAL_MS)
      }

      // Re-raise any nudge that arrived while this cycle was running, so data
      // buffered mid-cycle is delivered in ~50ms rather than at the next
      // heartbeat — or, for a session polled before the data landed, at all.
      if (this.nudgeRequestedDuringTick) {
        this.nudgeRequestedDuringTick = false
        this.nudgePollingCoordinator()
      }
    }

    this.pollTickFn = tick
    this.pollingTimer = setTimeout(tick, 1000)
    console.log('[AgentManager] Polling coordinator started')
  }

  /**
   * Nudges the polling coordinator to run a poll cycle within NUDGE_DELAY_MS
   * instead of waiting for the next 2-second heartbeat.  Called by adapters
   * (via onDataAvailable) when new stream data is buffered.
   *
   * The short debounce (50ms) batches rapid-fire stream events so we don't
   * run a poll cycle for every single streaming chunk.
   */
  private nudgePollingCoordinator(): void {
    if (this.nudgeTimer) return

    // A running tick only picks the data up if it has not polled this session
    // yet. Once it has, dropping the signal here leaves the data buffered with
    // nothing scheduled to collect it, so the request is re-raised instead.
    if (this.pollingInProgress) {
      this.nudgeRequestedDuringTick = true
      return
    }

    if (this.pollingEntries.size === 0) return

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null

      if (this.pollingEntries.size === 0 || this.pollingInProgress) return

      // Cancel the pending heartbeat timer — the nudge replaces it.
      // tick() will reschedule the heartbeat after it finishes.
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer)
        this.pollingTimer = null
      }

      // Run a poll cycle immediately (catch to avoid unhandled rejection on OOM)
      if (this.pollTickFn) {
        this.pollTickFn().catch((err) => {
          console.error('[AgentManager] Nudge tick error:', err)
        })
      }
    }, AgentManager.NUDGE_DELAY_MS)
  }

  /** Polls one session for new output and status changes. */
  private async pollSingleSession(entry: PollingEntry): Promise<void> {
    const { adapter, config } = entry

    try {
      let sessionId = this.resolvePollingSessionId(entry)
      const activeSession = this.sessions.get(sessionId)
      if (!activeSession) {
        console.log(`[AgentManager] Session ${sessionId} no longer exists, removing from polling`)
        this.stopAdapterPolling(entry.sessionId)
        return
      }

      // Cleared immediately before the poll, so anything the adapter buffers
      // from here on is known to be undelivered even if this poll returns it
      // (at worst that costs one extra cycle; it can never lose a message).
      entry.dataArrivedSincePoll = false

      const newParts = await adapter.pollMessages(
        sessionId,
        entry.seenMessageIds,
        entry.seenPartIds,
        entry.partContentLengths,
        config
      )
      pruneDedup(entry.seenMessageIds, entry.seenPartIds, entry.partContentLengths)

      const realSessionId = newParts.find(p => p.realSessionId)?.realSessionId
      if (realSessionId && realSessionId !== sessionId) {
        sessionId = this.rekeySession(entry, sessionId, realSessionId)
      }

      if (newParts.length > 0) {
        // Feeds the secondary IDLE grace period and the stuck-session watchdog.
        entry.lastPartReceivedAt = Date.now()
        activeSession.lastActivityAt = Date.now()
        // Reset the polling-entry watchdog because new data means this polling
        // cycle is alive. Keep the session-level one-shot guard intact: late
        // output from an interrupted turn must not re-arm the same abort.
        entry.watchdogFired = false
        if (await this.abortOnGarbledOutput(entry, sessionId, activeSession, newParts)) return
      }

      // hasSeenWork is set only by the BUSY / WAITING_APPROVAL handlers: message
      // content is unreliable (user echoes and stale updates from previous turns
      // can arrive before the backend has started on the new prompt).

      // One batched IPC call instead of one per part, so the renderer does a
      // single state update + re-render.
      const batchMessages = this.collectOutputBatch(entry, sessionId, newParts)
      const currentSession = this.sessions.get(sessionId)
      if (currentSession) this.captureSessionProgress(currentSession, batchMessages)
      if (batchMessages.length > 0) {
        this.sendToRenderer('agent:output-batch', {
          sessionId,
          taskId: config.taskId,
          messages: batchMessages
        })
      }

      const status = await adapter.getStatus(sessionId, config)
      const session = this.sessions.get(sessionId)

      if (status.type === SessionStatusType.ERROR) {
        await this.handleErrorStatus(sessionId, session, config, status, batchMessages)
      } else if (status.type === SessionStatusType.WAITING_APPROVAL && session) {
        this.handleWaitingApprovalStatus(sessionId, session, config)
      } else if (status.type === SessionStatusType.BUSY && session) {
        await this.handleBusyStatus(sessionId, session, adapter, config, batchMessages)
      } else if (status.type === SessionStatusType.IDLE && session) {
        this.handleIdleStatus(sessionId, session)
      }
    } catch (error: unknown) {
      console.error('[AgentManager] Adapter polling error:', error)
    }
  }

  /** Follows a re-key (temp -> real id) by task id and moves the polling entry with it. */
  private resolvePollingSessionId(entry: PollingEntry): string {
    if (this.sessions.has(entry.sessionId)) return entry.sessionId
    for (const [sid, sess] of this.sessions.entries()) {
      if (sess.taskId === entry.config.taskId) {
        this.pollingEntries.delete(entry.sessionId)
        entry.sessionId = sid
        this.pollingEntries.set(sid, entry)
        return sid
      }
    }
    return entry.sessionId
  }

  /** Re-keys a session under the real id the adapter reported; returns the id to use from now on. */
  private rekeySession(entry: PollingEntry, sessionId: string, realSessionId: string): string {
    console.log(`[AgentManager] Session ID updated: ${sessionId} -> ${realSessionId}`)
    console.log(`[SessionTracker] REKEYED old=${sessionId} new=${realSessionId} task=${entry.config.taskId} reason=adapter_provided_real_id`)
    this.updateTaskFromLocalAgent(entry.config.taskId, { session_id: realSessionId })

    const session = this.sessions.get(sessionId)
    if (!session) return sessionId
    this.sessions.delete(sessionId)
    this.sessions.set(realSessionId, session)

    // Record a redirect so stale IDs from the renderer still resolve, evicting
    // the oldest half once the cap is hit (Maps preserve insertion order).
    if (this.sessionIdRedirects.size >= AgentManager.MAX_SESSION_REDIRECTS) {
      let toEvict = Math.ceil(AgentManager.MAX_SESSION_REDIRECTS * 0.5)
      for (const oldKey of this.sessionIdRedirects.keys()) {
        if (toEvict-- <= 0) break
        this.sessionIdRedirects.delete(oldKey)
      }
    }
    this.sessionIdRedirects.set(sessionId, realSessionId)

    this.pollingEntries.delete(sessionId)
    entry.sessionId = realSessionId
    this.pollingEntries.set(realSessionId, entry)
    return realSessionId
  }

  /**
   * Some models hallucinate tool-call markup as plain text (e.g. emitting
   * `<｜DSML｜tool_calls>` character by character), which wastes tokens and never
   * resolves. Abort after 2 consecutive garbled cycles (fewer false positives)
   * instead of waiting for the full watchdog timeout. Returns true when aborted.
   */
  private async abortOnGarbledOutput(
    entry: PollingEntry,
    sessionId: string,
    session: AgentSession,
    newParts: Awaited<ReturnType<CodingAgentAdapter['pollMessages']>>
  ): Promise<boolean> {
    if (!hasGarbledOutput(newParts)) {
      entry.garbledOutputCount = 0
      return false
    }
    entry.garbledOutputCount = (entry.garbledOutputCount || 0) + 1
    if (entry.garbledOutputCount < 2 || entry.watchdogFired) return false

    entry.watchdogFired = true
    console.warn(
      `[AgentManager] Session ${sessionId}: garbled model output detected (${entry.garbledOutputCount} cycles). Aborting to prevent token waste.`
    )
    this.sendAutoAbortMessageOnce(
      sessionId,
      session,
      entry.config.taskId,
      'garbled-abort',
      'Session aborted: model is producing garbled output (hallucinated tool-call markup). You can send a new message to continue.'
    )
    try {
      await entry.adapter.abortPrompt(sessionId, entry.config)
    } catch (abortErr) {
      console.error(`[AgentManager] Failed to abort garbled session ${sessionId}:`, abortErr)
    }
    return true
  }

  /** Converts polled parts (plus any pending approval request) into renderer messages. */
  private collectOutputBatch(
    entry: PollingEntry,
    sessionId: string,
    newParts: Awaited<ReturnType<CodingAgentAdapter['pollMessages']>>
  ): OutputMessage[] {
    const batchMessages: OutputMessage[] = []
    for (const part of newParts) {
      // User messages are already shown (startAdapterSession / doSendAdapterMessage).
      // The adapter echoes them back with different IDs, so seenPartIds can't dedupe them.
      if (part.role === 'user' || (part.role as string) === 'human') continue
      const role = part.role || 'assistant'
      const content = part.content || part.text || ''
      const assistantKey = assistantTextKey(role, part.type, content, part.tool, part.taskProgress)
      if (assistantKey) {
        entry.assistantTextKeys ??= new Set<string>()
        entry.assistantTextKeys.add(assistantKey)
      }
      batchMessages.push({
        id: part.id || `part-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        content,
        partType: part.type,
        tool: part.tool,
        update: part.update,
        taskProgress: part.taskProgress,
        receivedAt: part.receivedAt
      })
    }

    const adapter = entry.adapter
    if ('getPendingApproval' in adapter && typeof adapter.getPendingApproval === 'function') {
      const approval = (adapter as unknown as AcpAdapter).getPendingApproval(sessionId)
      if (approval && !entry.seenPartIds.has(`approval-${approval.toolCallId}`)) {
        entry.seenPartIds.add(`approval-${approval.toolCallId}`)
        batchMessages.push({
          id: `question-${approval.toolCallId}`,
          role: 'assistant',
          content: approval.question,
          partType: 'question',
          tool: {
            name: 'permission',
            status: 'running',
            requestId: approval.requestId,
            questions: [{
              header: 'Permission Required',
              question: approval.question,
              options: approval.options.map((opt: { name: string }) => ({
                label: opt.name
              }))
            }]
          }
        })
      }
    }
    return batchMessages
  }

  /**
   * Records the last assistant text (read by HeartbeatScheduler) and the latest
   * todo list from todowrite calls (used for TillDone nudges; works for every
   * coding agent without adapter-specific hooks).
   */
  private captureSessionProgress(session: AgentSession, batchMessages: OutputMessage[]): void {
    const assistantTexts: string[] = []
    for (const msg of batchMessages) {
      if (msg.role === 'assistant' && msg.partType === 'text' && msg.content) {
        assistantTexts.push(msg.content)
      }
      const toolObj = msg.tool as { todos?: unknown } | undefined
      if (toolObj?.todos && Array.isArray(toolObj.todos)) {
        session.todos = (toolObj.todos as Array<Record<string, unknown>>)
          .filter(Boolean)
          .map((t) => ({
            content: String(t.content || t.text || t.title || ''),
            status: String(t.status || 'pending')
          }))
      }
    }
    if (assistantTexts.length > 0) {
      // Replace (not append) and cap at 50 KB to prevent unbounded string growth
      const joined = assistantTexts.join('\n')
      session.lastAssistantText = joined.length > 50_000 ? joined.slice(-50_000) : joined
    }
  }

  private async handleErrorStatus(
    sessionId: string,
    session: AgentSession | undefined,
    config: SessionConfig,
    status: AdapterSessionStatus,
    batchMessages: OutputMessage[]
  ): Promise<void> {
    if (status.message?.includes('INCOMPATIBLE_SESSION_ID')) {
      console.warn('[AgentManager] Incompatible session detected during polling:', sessionId)
      this.updateTaskFromLocalAgent(config.taskId, { session_id: null })
      this.sendToRenderer('agent:incompatible-session', {
        taskId: config.taskId,
        agentId: config.agentId,
        error: status.message.replace('INCOMPATIBLE_SESSION_ID: ', '')
      })
      this.stopAdapterPolling(sessionId)
      return
    }

    if (status.message?.includes('Client not found')) {
      console.log(`[AgentManager] Client not found for session ${sessionId}, stopping polling`)
      this.stopAdapterPolling(sessionId)
      return
    }

    // Regular error (e.g. rate limit). If the same poll already delivered the
    // provider error as a transcript part, do not inject a second copy.
    if (!hasMatchingErrorMessage(batchMessages, status.message)) {
      this.emitSystemError(sessionId, config.taskId, `error-${Date.now()}`, status.message || 'An unexpected error occurred. Check logs for details.')
    }

    const exhaustionMessage = findCreditExhaustionMessage([
      status.message,
      ...batchMessages
        .filter((message) => message.partType === MessagePartType.ERROR || message.role === 'system')
        .map((message) => message.content)
    ])
    if (session && exhaustionMessage && await this.tryAutomaticFallback(sessionId, session, exhaustionMessage)) {
      return
    }

    if (session) {
      session.status = 'error'
      session.pollingStarted = false
      this.emitStatus(sessionId, config, 'error')
    }
    this.stopAdapterPolling(sessionId)
  }

  /**
   * Moves an exhausted task to the next configured agent. The shared worktree
   * and durable transcript remain in place; switchAgentWithContext seeds the
   * new backend with the conversation recap and carries the rest of the chain.
   */
  private async tryAutomaticFallback(
    sessionId: string,
    session: AgentSession,
    exhaustionMessage: string
  ): Promise<boolean> {
    if (session.fallbackInProgress || session.fallbackAgentIds.length === 0) return false
    session.fallbackInProgress = true

    while (session.fallbackAgentIds.length > 0) {
      const fallbackAgentId = session.fallbackAgentIds.shift()!
      if (session.attemptedAgentIds.has(fallbackAgentId)) continue
      session.attemptedAgentIds.add(fallbackAgentId)

      const fallbackAgent = this.db.getAgent(fallbackAgentId)
      if (!fallbackAgent) {
        console.warn(`[AgentManager] Skipping deleted fallback agent ${fallbackAgentId} for task ${session.taskId}`)
        continue
      }

      const currentAgent = this.db.getAgent(session.agentId)
      const fromName = currentAgent?.name || 'the current agent'
      const detail = exhaustionMessage.replace(/\s+/g, ' ').trim().slice(0, 300)
      this.emitSystemNotice(
        sessionId,
        session.taskId,
        `automatic-fallback-${Date.now()}`,
        `${fromName} cannot continue because its credits or usage quota are exhausted. Automatically handing off to ${fallbackAgent.name}.${detail ? `\n\nProvider message: ${detail}` : ''}`
      )

      try {
        await this.switchAgentWithContext(session.taskId, fallbackAgentId, {
          remainingAgentIds: [...session.fallbackAgentIds],
          attemptedAgentIds: session.attemptedAgentIds
        })
        console.log(`[AgentManager] Automatic fallback succeeded for task ${session.taskId}: ${session.agentId} -> ${fallbackAgentId}`)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[AgentManager] Automatic fallback to ${fallbackAgent.name} failed:`, error)
        this.emitSystemError(
          '',
          session.taskId,
          `automatic-fallback-error-${Date.now()}`,
          `Could not start fallback agent ${fallbackAgent.name}: ${message}`
        )

        // A failure after createSession may leave a partially-created runtime.
        // Release it before trying the next candidate in the ordered chain.
        const partial = this.findSessionByTaskId(session.taskId)
        if (partial && partial.session.agentId === fallbackAgentId) {
          await this.stopSession(partial.sessionId, false)
          this.updateTaskFromLocalAgent(session.taskId, { session_id: null })
        }
      }
    }

    session.fallbackInProgress = false
    if (!this.findSessionByTaskId(session.taskId)) {
      this.updateTaskFromLocalAgent(session.taskId, { session_id: null })
    }
    this.emitSystemError(
      '',
      session.taskId,
      `automatic-fallback-exhausted-${Date.now()}`,
      'Every configured fallback agent was unavailable. The task has been stopped so you can review the agent configuration and retry.'
    )
    return false
  }

  private handleWaitingApprovalStatus(sessionId: string, session: AgentSession, config: SessionConfig): void {
    // The backend is actively processing, so the IDLE grace period no longer applies.
    const pollingEntry = this.pollingEntries.get(sessionId)
    if (pollingEntry) pollingEntry.hasSeenWork = true
    if (session.status !== 'waiting_approval') {
      session.status = 'waiting_approval'
      this.emitStatus(sessionId, config, 'waiting_approval')
    }
  }

  private async handleBusyStatus(
    sessionId: string,
    session: AgentSession,
    adapter: CodingAgentAdapter,
    config: SessionConfig,
    batchMessages: OutputMessage[]
  ): Promise<void> {
    const pollingEntry = this.pollingEntries.get(sessionId)
    if (pollingEntry) {
      // The backend is actively processing, so the IDLE grace period no longer applies.
      pollingEntry.hasSeenWork = true
      // Agent resumed work (possibly after a tillDone nudge) — reset the
      // nudge counter so the next idle cycle gets a fresh allowance.
      if (pollingEntry.tillDoneNudgeCount) pollingEntry.tillDoneNudgeCount = 0

      // Shared by the stuck-tool detector and the watchdog's delegation check.
      let runningTools: RunningTool[] = []
      if (typeof adapter.getRunningTools === 'function') {
        try {
          runningTools = await adapter.getRunningTools(sessionId, config)
        } catch {
          // Non-fatal — watchdogs fall back to their other signals
        }
      }

      if (!pollingEntry.watchdogFired && runningTools.length > 0) {
        if (await this.abortStuckTool(pollingEntry, sessionId, session, runningTools)) return
      }
      if (await this.runStuckSessionWatchdog(pollingEntry, sessionId, session, runningTools, batchMessages)) return
    }
    if (session.status !== 'working') {
      session.status = 'working'
      this.emitStatus(sessionId, config, 'working')
    }
  }

  /**
   * Fast stuck-tool detector: some tools (notably `read` on cross-workspace
   * files) silently hang without output or a permission request, and the
   * general watchdog waits 5 minutes. Delegation tools are exempt (see
   * isDelegationTool). Returns true when this poll cycle must stop.
   */
  private async abortStuckTool(
    pollingEntry: PollingEntry,
    sessionId: string,
    session: AgentSession,
    runningTools: RunningTool[]
  ): Promise<boolean> {
    const { adapter, config } = pollingEntry
    try {
      const reason = findStuckTool(runningTools, config.workspaceDir)
      if (!reason) return false

      pollingEntry.watchdogFired = true
      const shouldAbort = this.sendAutoAbortMessageOnce(
        sessionId,
        session,
        config.taskId,
        'stuck-tool',
        `Session auto-aborted: ${reason}. You can send a new message to continue.`,
        isCodexAppServerAdapter(adapter)
      )
      if (!shouldAbort) return true
      console.warn(`[AgentManager] Session ${sessionId}: ${reason}. Aborting.`)
      try {
        await adapter.abortPrompt(sessionId, config)
      } catch (abortErr) {
        console.error(`[AgentManager] Failed to abort stuck-tool session ${sessionId}:`, abortErr)
      }
      return true
    } catch {
      // Non-fatal — fall through to the general watchdog
      return false
    }
  }

  /**
   * Stuck-session watchdog: a session BUSY with no new data for
   * STUCK_SESSION_TIMEOUT_MS likely has a tool call hung inside the agent
   * process, so the prompt is aborted to let it recover.
   *
   * It stands down when the session is really waiting for user input, or
   * while delegation is active: a
   * coordinator whose subagents/subtasks are working produces no output itself,
   * and aborting it would cascade into the children. If the delegation ends and
   * the session is still silent, the abort fires on a later tick.
   *
   * Returns true when this poll cycle must stop.
   */
  private async runStuckSessionWatchdog(
    pollingEntry: PollingEntry,
    sessionId: string,
    session: AgentSession,
    runningTools: RunningTool[],
    batchMessages: OutputMessage[]
  ): Promise<boolean> {
    const { adapter, config } = pollingEntry
    const silentDuration = Date.now() - (pollingEntry.lastPartReceivedAt || pollingEntry.createdAt)
    if (silentDuration <= STUCK_SESSION_TIMEOUT_MS || pollingEntry.watchdogFired) return false
    const silentSeconds = Math.round(silentDuration / 1000)

    if (isWaitingForUserInput(session.status, batchMessages, adapter, sessionId)) {
      console.log(`[AgentManager] Session ${sessionId} BUSY for ${silentSeconds}s but has pending user input — not aborting`)
      return false
    }
    const hasActiveDelegation = runningTools.some((tool) => isDelegationTool(tool.toolName))
      || this.hasActiveSubtaskWork(config.taskId)
    if (hasActiveDelegation) {
      console.log(`[AgentManager] Session ${sessionId} BUSY for ${silentSeconds}s but has active delegation (subagents/subtasks in progress) — not aborting`)
      return false
    }
    if (runningTools.length > 0) {
      console.log(`[AgentManager] Session ${sessionId} BUSY for ${silentSeconds}s but has an active tool — using the tool-specific inactivity deadline`)
      return false
    }

    // Marked BEFORE the message/abort so the notice doesn't repeat every tick
    // while the backend transitions from BUSY to IDLE.
    pollingEntry.watchdogFired = true
    const shouldAbort = this.sendAutoAbortMessageOnce(
      sessionId,
      session,
      config.taskId,
      'stuck-abort',
      `Session auto-aborted: no activity for ${silentSeconds}s. A tool call may have hung. You can send a new message to continue.`,
      isCodexAppServerAdapter(adapter)
    )
    if (!shouldAbort) return true
    console.warn(`[AgentManager] Session ${sessionId} stuck: BUSY for ${silentSeconds}s with no new data. Aborting prompt.`)
    // The next poll cycle sees IDLE once executePromptWithRetry exits.
    try {
      await adapter.abortPrompt(sessionId, config)
    } catch (abortErr) {
      console.error(`[AgentManager] Failed to abort stuck session ${sessionId}:`, abortErr)
    }
    return true
  }

  private handleIdleStatus(sessionId: string, session: AgentSession): void {
    const pollingEntry = this.pollingEntries.get(sessionId)

    // The prompt is sent fire-and-forget and the backend may not have started
    // on it yet. Without this grace period polling sees IDLE immediately,
    // stops for good, and the agent appears stuck showing only the prompt.
    const sessionAge = pollingEntry ? Date.now() - pollingEntry.createdAt : Infinity
    if (!pollingEntry?.hasSeenWork && sessionAge < AgentManager.IDLE_GRACE_PERIOD_MS) return

    // Some models (e.g. featherless kimi k2.5) briefly report idle between
    // tool-call rounds, so wait a little after the last received data.
    if (pollingEntry?.lastPartReceivedAt && Date.now() - pollingEntry.lastPartReceivedAt < AgentManager.POST_DATA_GRACE_MS) return

    if (pollingEntry && this.sendTillDoneNudge(pollingEntry, sessionId, session)) return

    // The adapter buffered data after this cycle polled it, and the turn's
    // `result` came with that data — which is why the status now reads
    // IDLE. Unregistering here strands the buffered part: the nudge that
    // announced it was swallowed because a cycle was already running, and
    // stopAdapterPolling() cancels both the nudge and the heartbeat. The
    // part then sits in the adapter until the NEXT prompt polls it out,
    // which is how an agent's closing message ended up below the user's
    // following message. Give the next cycle a chance to drain it.
    if (pollingEntry?.dataArrivedSincePoll) {
      console.log(`[AgentManager] IDLE for ${sessionId} deferred: adapter buffered data after this poll`)
      return
    }

    console.log(`[AgentManager] Detected IDLE status for ${sessionId}, calling transitionToIdle`)
    // Keep what was already seen, so a follow-up message's polling does not re-send it.
    if (pollingEntry) {
      for (const id of pollingEntry.seenMessageIds) session.seenMessageIds.add(id)
      for (const id of pollingEntry.seenPartIds) session.seenPartIds.add(id)
      for (const [k, v] of pollingEntry.partContentLengths) session.partContentLengths.set(k, v)
      session.assistantTextKeys ??= new Set<string>()
      for (const key of pollingEntry.assistantTextKeys ?? []) session.assistantTextKeys.add(key)
      pruneDedup(session.seenMessageIds, session.seenPartIds, session.partContentLengths)
    }
    session.pollingStarted = false
    // Unregister FIRST so other sessions aren't starved while transitionToIdle
    // runs (it can be slow due to extractOutputValues); it is not awaited.
    this.stopAdapterPolling(sessionId)
    this.transitionToIdle(sessionId, session).catch((err) => {
      console.error(`[AgentManager] transitionToIdle error for ${sessionId}:`, err)
    })
  }

  /**
   * TillDone: an agent that goes idle with incomplete todos (captured from
   * polled todowrite calls, so it works for every coding agent) is prompted to
   * continue, up to MAX_TILLDONE_NUDGES times. Returns true when a nudge was sent.
   */
  private sendTillDoneNudge(pollingEntry: PollingEntry, sessionId: string, session: AgentSession): boolean {
    if (!session.todos || session.todos.length === 0) return false
    const incomplete = session.todos.filter(t => !DONE_TODO_STATUSES.includes(t.status))
    if (incomplete.length === 0) return false

    const nudgeCount = pollingEntry.tillDoneNudgeCount || 0
    if (nudgeCount >= AgentManager.MAX_TILLDONE_NUDGES) {
      console.log(`[AgentManager] TillDone nudge limit (${AgentManager.MAX_TILLDONE_NUDGES}) reached for ${sessionId}, transitioning to idle`)
      return false
    }

    pollingEntry.tillDoneNudgeCount = nudgeCount + 1
    console.log(`[AgentManager] TillDone nudge #${nudgeCount + 1} for ${sessionId}: ${incomplete.length} incomplete todo(s)`)
    // The standard message path resets status to 'working' and keeps polling alive.
    this.doSendAdapterMessage(session, sessionId, buildTillDoneNudge(session.todos, incomplete)).catch((err) => {
      console.error(`[AgentManager] TillDone nudge failed for ${sessionId}:`, err)
    })
    return true
  }

  private async resumeAdapterSession(
    adapter: CodingAgentAdapter,
    agentId: string,
    taskId: string,
    adapterSessionId: string
  ): Promise<string> {
    const agent = this.db.getAgent(agentId)!

    // Use the same workspace resolution as startSession: try git worktree first,
    // then fall back to the default workspace dir. This is critical because Claude
    // Code stores session files under ~/.claude/projects/<encoded-workspaceDir>/,
    // so resuming with a different workspaceDir produces a different path and the
    // session file won't be found.
    const workspaceDir = await this.setupWorktreeIfNeeded(taskId) || this.db.getWorkspaceDir(taskId)

    // Pick up attachments added since the session was started/last resumed.
    syncAttachmentsToWorkspace(this.db, taskId, workspaceDir)

    const task = this.db.getTask(taskId)
    await yieldEventLoop()

    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(taskId, task, this.heartbeatScopeTask(taskId, task)))
    // Task context in the system prompt survives context compaction.
    const taskContext = task && !isCoordinatorTask(task)
      ? `\n\n[Task Context]\nTask: "${task.title}"\n${task.description || ''}`
      : ''
    const secretToken = this.setupSecretSession(agentId)
    const sessionConfig = assembleSessionConfig(this.db, agent, {
      agentId,
      taskId,
      task,
      workspaceDir,
      mcpServers,
      systemPrompt: (agent.config?.system_prompt || '') + taskContext,
      secretToken
    })
    await yieldEventLoop()

    await adapter.initialize()

    let messages: SessionMessage[]
    try {
      console.log('[AgentManager] Calling adapter.resumeSession...')
      messages = await adapter.resumeSession(adapterSessionId, sessionConfig)
      console.log('[AgentManager] adapter.resumeSession completed successfully')
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.log('[AgentManager] adapter.resumeSession threw error:', errorMessage)

      if (
        errorMessage.includes('INCOMPATIBLE_SESSION_ID') ||
        errorMessage.includes('No conversation found') ||
        errorMessage.includes('SESSION_FILE_NOT_FOUND') ||
        errorMessage.includes('Session no longer exists on server')
      ) {
        console.warn(`[AgentManager] Session not found or incompatible: ${adapterSessionId}`)

        // For completed/review tasks, the session may have ended normally.
        // Don't show the alarming "incompatible" dialog — just clear the session_id
        // so the UI shows "Start" instead. This commonly happens with subtask sessions.
        const currentTask = this.db.getTask(taskId)
        // A coordinator conversation the backend no longer has is simply over;
        // the caller opens a new one. There is no task to ask the user about.
        if (isCoordinatorTask(currentTask)) {
          console.log(`[AgentManager] Coordinator session ${adapterSessionId} is gone — clearing session_id for ${taskId}`)
          this.updateTaskFromLocalAgent(taskId, { session_id: null })
          return ''
        }
        const pendingFeedback = currentTask?.status === TaskStatus.AgentLearning
          && this.db.getSetting(`session-feedback-completion:${taskId}`)
        if (currentTask && (currentTask.status === TaskStatus.ReadyForReview || currentTask.status === TaskStatus.Completed || pendingFeedback)) {
          console.log(`[AgentManager] Session ended normally for ${currentTask.status} task ${taskId} — clearing session_id`)
          this.updateTaskFromLocalAgent(taskId, { session_id: null })
          this.sendToRenderer('task:updated', { taskId, updates: { session_id: null } })
          // Return a sentinel value instead of throwing, so the IPC handler doesn't
          // log a noisy error. The public resumeSession() method returns empty string
          // which signals to the renderer that the session is gone.
          return ''
        }

        this.updateTaskFromLocalAgent(taskId, { session_id: null })

        let userMessage = 'Session not found. Would you like to start a new session?'
        if (errorMessage.includes('SESSION_FILE_NOT_FOUND')) {
          userMessage = 'Session file not found. The session may have been deleted or never synced. Would you like to start a new session?'
        } else if (errorMessage.includes('No conversation found')) {
          userMessage = 'Session not found on server. Would you like to start a new session?'
        } else {
          userMessage = errorMessage.replace('INCOMPATIBLE_SESSION_ID: ', '')
        }

        // The renderer asks the user whether to start fresh.
        console.log('[AgentManager] Emitting agent:incompatible-session event')
        this.sendToRenderer('agent:incompatible-session', {
          taskId,
          agentId,
          error: userMessage
        })

        throw new Error('SESSION_INCOMPATIBLE')
      }
      throw error
    }

    // Seed the dedup state from the resumed history so polling won't re-emit
    // historical parts as new output. Resume does NOT push the transcript to
    // clients: they render the durable projection (snapshot +
    // `transcript:changed` deltas), which the one-time backfill seeds.
    const dedupState = dedupStateFromHistory(messages)

    // Idle until the user sends a message.
    this.schedulePowerSaveBlockerUpdate()
    this.sessions.set(adapterSessionId, {
      id: adapterSessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'idle',
      createdAt: new Date(),
      lastActivityAt: Date.now(),
      ...dedupState,
      adapter,
      pollingStarted: false,
      secretSessionToken: secretToken,
      fallbackAgentIds: normalizeFallbackAgentIds(agent.config?.fallback_agent_ids)
        .filter((id) => id !== agentId),
      attemptedAgentIds: new Set([agentId])
    })

    // Persist the resumed session binding and tell the renderer BEFORE any
    // follow-up prompt starts. Without this, a silent main-process resume
    // (e.g. an event-driven wake-up after the runtime was released) leaves the
    // renderer bound to a stale session id and the wake turn's output renders
    // late or not at all.
    this.updateTaskFromLocalAgent(taskId, { session_id: adapterSessionId })
    this.sendToRenderer('task:updated', { taskId, updates: { session_id: adapterSessionId } })

    this.emitStatus(adapterSessionId, { agentId, taskId }, 'idle')

    return adapterSessionId
  }

  /**
   * A running agent must not pull a task back out of session learning, and a
   * coordinator row has no lifecycle at all: it is never working, in review or
   * done, only resumable. Its session_id still persists like any task's.
   */
  private updateTaskFromLocalAgent(taskId: string, updates: Parameters<DatabaseManager['updateTask']>[1]): TaskRecord | undefined {
    const fields = { ...updates }
    if (fields.status !== undefined) {
      const current = this.db.getTask(taskId)
      if (isCoordinatorTask(current)) delete fields.status
      else if (fields.status === TaskStatus.AgentWorking && current?.status === TaskStatus.AgentLearning) delete fields.status
    }
    if (Object.keys(fields).length === 0) return this.db.getTask(taskId)
    const before = fields.status !== undefined ? this.db.getTask(taskId)?.status : undefined
    const updated = this.db.updateTask(taskId, fields)
    // Project event (#57): an agent's own work reaching review bypasses
    // afterTaskUpdated (task-updates.ts), so the event is raised here.
    if (fields.status === TaskStatus.ReadyForReview && updated?.status === TaskStatus.ReadyForReview && before !== TaskStatus.ReadyForReview) {
      emitTaskEvent(this.db, 'task_ready_for_review', taskId)
    }
    return updated
  }

  /**
   * Creates an OpenCode session and returns the sessionId immediately.
   * Uses promptAsync to send the initial prompt without blocking.
   */
  async startSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string> {
    const outcome = await this.requestSession(agentId, taskId, workspaceDir, skipInitialPrompt)
    // '' = queued behind the concurrency limits; it starts on its own later.
    return outcome.status === 'started' ? outcome.sessionId : ''
  }

  /**
   * The admission-controlled start every entry point goes through. Starts the
   * session when it fits under the per-agent and global limits, otherwise
   * queues it (once per task) and reports its position. Coordinator,
   * heartbeat and triage sessions bypass the limits (see admission.ts).
   */
  async requestSession(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<SessionStartOutcome> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const task = this.db.getTask(taskId)
    if (!isExemptFromAdmission(taskId, task)) {
      const alreadyQueued = this.startQueue.list().find((entry) => entry.taskId === taskId)
      if (alreadyQueued) {
        return { status: 'queued', position: alreadyQueued.position, reason: alreadyQueued.reason }
      }
      const decision = checkAdmission({ agentId, taskId, task, agent }, this.countedSessions(), this.admissionLimits(task))
      if (!decision.admitted) {
        const { position } = this.startQueue.enqueue({
          taskId,
          agentId,
          workspaceDir,
          skipInitialPrompt,
          reason: decision.reason,
          queuedAt: new Date().toISOString()
        })
        console.log(
          `[AgentManager] Start of task ${taskId} queued at position ${position}: ${decision.reason} ` +
          `(${decision.running}/${decision.limit} running)`
        )
        this.emitStartQueueChanged()
        this.tellMastermindAboutLimit(task, decision)
        return { status: 'queued', position, reason: decision.reason }
      }
      this.recordCountedStart(task)
    }

    this.admittedStarts.set(taskId, agentId)
    try {
      return { status: 'started', sessionId: await this.startSessionNow(agentId, taskId, workspaceDir, skipInitialPrompt) }
    } catch (error) {
      // The reserved slot is free again (released in finally, before the
      // deferred drain runs).
      this.scheduleStartQueueDrain()
      throw error
    } finally {
      this.admittedStarts.delete(taskId)
    }
  }

  /** Starts without admission control — callers are exempt or already admitted. */
  private async startSessionNow(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string> {
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // A coordinator conversation outlives its runtime. Rejoin the live session
    // or resume the persisted one, so a restart (or a reaped runtime) continues
    // the same Mastermind conversation instead of opening a blank one.
    const task = this.db.getTask(taskId)
    if (isCoordinatorTask(task)) {
      const live = this.findSessionByTaskId(taskId)
      if (live) return live.sessionId
      if (task?.session_id) {
        const resumed = await this.resumeCoordinatorSession(agentId, taskId, task.session_id)
        if (resumed) return resumed
      }
    }

    if (!workspaceDir) {
      workspaceDir = await this.setupWorktreeIfNeeded(taskId)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }
    return this.startAdapterSession(adapter, agentId, taskId, workspaceDir, skipInitialPrompt)
  }

  /** The real task a heartbeat pseudo-session checks, used only to scope its MCP tools. */
  private heartbeatScopeTask(taskId: string, task: TaskRecord | null | undefined): TaskRecord | undefined {
    if (task || !taskId.startsWith('heartbeat-')) return undefined
    return this.db.getTask(taskId.slice('heartbeat-'.length)) ?? undefined
  }

  /** Resumes a coordinator's persisted session; '' when it cannot be continued. */
  private async resumeCoordinatorSession(agentId: string, taskId: string, sessionId: string): Promise<string> {
    const adapter = this.getAdapter(agentId)
    if (!adapter) return ''
    try {
      return await this.resumeAdapterSession(adapter, agentId, taskId, sessionId)
    } catch (error) {
      // Backend restarted, files gone, or a different backend than the one
      // that made it. The next session starts fresh; nothing to ask the user.
      console.warn(`[AgentManager] Could not resume coordinator session ${sessionId} for ${taskId}; starting a new one:`, error)
      this.updateTaskFromLocalAgent(taskId, { session_id: null })
      return ''
    }
  }

  /**
   * Switches a task to a different agent mid-conversation — e.g. Agent A (a
   * DeepSeek model) ran out of credits and the user wants Agent B (Claude) to
   * pick up the same task without restarting from scratch.
   *
   * Each coding agent backend (Claude Code, OpenCode, Codex, ...) has its own
   * incompatible native session format, so there is no way to hand off the
   * literal running session — instead, this stops the old agent's session if
   * one is active, then starts a fresh session with the new agent whose first
   * prompt is seeded with a recap of the existing transcript (see
   * buildAgentSwitchRecap) so the new agent has full context instead of a
   * blank slate.
   */
  async switchAgent(taskId: string, newAgentId: string): Promise<string> {
    return this.switchAgentWithContext(taskId, newAgentId)
  }

  private async switchAgentWithContext(
    taskId: string,
    newAgentId: string,
    fallbackState?: AgentFallbackState
  ): Promise<string> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const newAgent = this.db.getAgent(newAgentId)
    if (!newAgent) throw new Error(`Agent not found: ${newAgentId}`)

    const previousAgentId = task.agent_id
    const previousAgent = previousAgentId ? this.db.getAgent(previousAgentId) : undefined

    if (previousAgentId === newAgentId) {
      throw new Error(`Task is already assigned to ${newAgent.name}`)
    }

    // Resolve the adapter before touching anything so an unusable agent
    // leaves the outgoing session and the task assignment intact.
    const adapter = this.getAdapter(newAgentId)
    if (!adapter) throw new Error(`No adapter available for agent ${newAgentId}`)

    // Stop the outgoing agent's live session, if any — its process belongs to
    // a different backend and can't continue once we hand off.
    await this.stopByTaskId(taskId)

    this.updateTaskFromLocalAgent(taskId, { agent_id: newAgentId })
    this.sendToRenderer('task:updated', {
      taskId,
      updates: { agent_id: newAgentId }
    })

    // Same workspace resolution as startSession() — reuses the existing
    // worktrees, or repairs them if they went missing.
    const workspaceDir = await this.setupWorktreeIfNeeded(taskId)

    return this.startAdapterSession(
      adapter,
      newAgentId,
      taskId,
      workspaceDir,
      false,
      previousAgent?.name || 'a previous agent',
      fallbackState
    )
  }

  async startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean }): Promise<{
    /** `queued`: over a concurrency limit; it starts on its own when a slot frees. */
    action: 'task_started' | 'subtask_started' | 'triage_started' | 'already_running' | 'queued' | 'no_action'
    sessionId?: string
    startedTaskId?: string
    agentId?: string
    /** 1-based place in the start queue when `action` is `queued`. */
    queuePosition?: number
    queueReason?: AdmissionReason
  }> {
    const task = this.db.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    const preferSubtasks = opts?.preferSubtasks !== false
    const allowTriage = opts?.allowTriage !== false

    if (preferSubtasks) {
      const subtasks = this.db.getSubtasks(taskId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      // Same rule as the schedulers: only a running sibling blocks; one in
      // ready_for_review has finished its run and cannot accept itself.
      const activeSubtask = findBlockingSibling(subtasks)
      if (activeSubtask) {
        return {
          action: 'already_running',
          startedTaskId: activeSubtask.id,
          agentId: activeSubtask.agent_id ?? undefined
        }
      }

      // Once successor edges drive the run, never pick the next one by list order.
      const nextSubtask = isSuccessorGraphInProgress(subtasks)
        ? undefined
        : subtasks.find((subtask) => subtask.status === TaskStatus.NotStarted && !!subtask.agent_id)
      if (nextSubtask?.agent_id) {
        const outcome = await this.requestSession(nextSubtask.agent_id, nextSubtask.id)
        if (outcome.status === 'queued') {
          return { action: 'queued', startedTaskId: nextSubtask.id, agentId: nextSubtask.agent_id, queuePosition: outcome.position, queueReason: outcome.reason }
        }
        return {
          action: 'subtask_started',
          sessionId: outcome.sessionId,
          startedTaskId: nextSubtask.id,
          agentId: nextSubtask.agent_id
        }
      }
    }

    const runningSession = this.findSessionByTaskId(taskId)
    if (runningSession && runningSession.session.status !== 'idle' && runningSession.session.status !== 'error') {
      return {
        action: 'already_running',
        sessionId: runningSession.sessionId,
        startedTaskId: taskId,
        agentId: runningSession.session.agentId
      }
    }

    if (!task.agent_id) {
      if (!allowTriage || task.parent_task_id) {
        return { action: 'no_action', startedTaskId: taskId }
      }

      const defaultAgentId = this.defaultAgent()?.id
      if (!defaultAgentId) {
        return { action: 'no_action', startedTaskId: taskId }
      }

      this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.Triaging })
      this.sendToRenderer('task:updated', {
        taskId,
        updates: { status: TaskStatus.Triaging }
      })

      // Triage is exempt from the limits, so this never queues.
      const sessionId = await this.startSession(defaultAgentId, taskId)
      return {
        action: 'triage_started',
        sessionId,
        startedTaskId: taskId,
        agentId: defaultAgentId
      }
    }

    const outcome = await this.requestSession(task.agent_id, taskId)
    if (outcome.status === 'queued') {
      return { action: 'queued', startedTaskId: taskId, agentId: task.agent_id, queuePosition: outcome.position, queueReason: outcome.reason }
    }
    return {
      action: 'task_started',
      sessionId: outcome.sessionId,
      startedTaskId: taskId,
      agentId: task.agent_id
    }
  }

  /**
   * Send a heartbeat check via a dedicated heartbeat session for this task.
   * Uses a separate session (heartbeat-{taskId}) to keep checks out of the task's working session.
   * Each task gets its own heartbeat session so checks don't mix across tasks.
   * Uses the real task's workspace dir so the agent has repo context for gh commands.
   */
  async sendHeartbeatViaMastermind(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    const heartbeatTaskId = `heartbeat-${taskId}`

    let sessionId = this.findSessionByTaskId(heartbeatTaskId)?.sessionId
    if (!sessionId) {
      // The real task's workspace dir gives the agent repo context.
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      console.log(`[AgentManager] Heartbeat: creating heartbeat session for task ${taskId}`)
      sessionId = await this.startSessionNow(agentId, heartbeatTaskId, workspaceDir, true /* skipInitialPrompt */)
    }

    console.log(`[AgentManager] Heartbeat: sending check via heartbeat session ${sessionId} for task ${taskId}`)
    const result = await this.sendMessage(sessionId, heartbeatPrompt, heartbeatTaskId, agentId)
    return result.newSessionId || sessionId
  }

  /**
   * Send action findings to the task agent's own session.
   * Only called when mastermind detected something that needs the task agent to act on.
   */
  async startHeartbeatSession(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    const task = this.db.getTask(taskId)
    let sessionId = task?.session_id

    if (!sessionId) {
      console.log(`[AgentManager] Heartbeat: no session for task ${taskId}, creating new session`)
      // Heartbeat follow-ups act on work already under way; they bypass admission.
      sessionId = await this.startSessionNow(agentId, taskId, undefined, true /* skipInitialPrompt */)
    }

    console.log(`[AgentManager] Heartbeat: forwarding action to task session ${sessionId} for task ${taskId}`)
    // sendMessage resumes a dead session, sends the prompt and starts polling.
    const result = await this.sendMessage(sessionId, heartbeatPrompt, taskId, agentId)
    return result.newSessionId || sessionId
  }

  /**
   * Get a session's current state (used by HeartbeatScheduler to poll status).
   */
  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Remove a heartbeat session from memory after the check completes.
   * Prevents heartbeat-{taskId} sessions from accumulating indefinitely.
   */
  async cleanupHeartbeatSession(taskId: string): Promise<void> {
    const found = this.findSessionByTaskId(`heartbeat-${taskId}`)
    if (!found) return
    await this.stopSession(found.sessionId, false)
    console.log(`[AgentManager] Cleaned up heartbeat session ${found.sessionId} for task ${taskId}`)
  }

  /**
   * Find a session by its taskId. Returns the current session ID and session object.
   * Used by HeartbeatScheduler to recover from session ID re-keying: when the adapter
   * provides a real session ID, pollSingleSession re-keys the sessions map, but
   * waitForSessionResult still holds the old temp ID. This method looks up by taskId
   * which is stable across re-keying.
   */
  findSessionByTaskId(taskId: string): { sessionId: string; session: AgentSession } | undefined {
    for (const [id, session] of this.sessions.entries()) {
      if (session.taskId === taskId) {
        return { sessionId: id, session }
      }
    }
    return undefined
  }

  /**
   * Check if a task has a live (working) session in memory.
   * Used by HeartbeatScheduler to avoid interrupting active user sessions.
   */
  hasActiveSessionForTask(taskId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.taskId === taskId && session.status === 'working') {
        return true
      }
    }
    return false
  }

  /**
   * Event-driven coordinator wake-up.
   *
   * Called when a subtask reaches a terminal state (ready_for_review or
   * completed). If the parent coordinator's session is idle — or its runtime
   * has already been released — it is resumed with a summary prompt so it can
   * review outputs and continue orchestration.
   *
   * This inverts the old model where a parent had to stay resident (and be
   * polled) while blocking on subtask progress: the parent may go idle at any
   * time, and exactly one session is touched when there is new work to do.
   *
   * Guards:
   * - If the parent session is live and NOT idle (e.g. blocked inside a
   *   wait_for_subtasks call), nothing is injected — it will observe the
   *   subtask state itself.
   * - The wake-up fires once no subtask is still in agent_working (all
   *   terminal, or a mix where the last working child just finished), so a
   *   coordinator that went idle while creating children is resumed the moment
   *   the pipeline drains — it can start the next child or consolidate. A
   *   parent with several children still gets a single wake-up instead of one
   *   per child.
   * - A dedupe set prevents double-wakes when several children finish at once.
   * - A completed subtask with `next_subtask_ids` starts those siblings instead
   *   of waking the parent. The parent is woken at once (even mid-pipeline) if
   *   a selected successor is missing, has no agent, or fails to start.
   * - When the chain opts in ({@link successorsFireOnReview}), a subtask in
   *   ready_for_review starts its successors too. It stays in review: the
   *   chain advances, but accepting the result is still a human's call.
   */
  async notifyParentOfSubtaskCompletion(parentTaskId: string, subtaskId: string): Promise<void> {
    const parentTask = this.db.getTask(parentTaskId)
    if (!parentTask) return
    if (parentTask.status === TaskStatus.Completed) return

    const completedSubtask = this.db.getTask(subtaskId)
    const routesSuccessors =
      completedSubtask?.status === TaskStatus.Completed ||
      (completedSubtask?.status === TaskStatus.ReadyForReview && successorsFireOnReview(parentTask, completedSubtask))
    const nextSubtaskIds = routesSuccessors ? completedSubtask?.next_subtask_ids ?? [] : []
    let routingIssue: string | null = null

    if (nextSubtaskIds.length > 0) {
      if (this.routingCompletedSubtasks.has(subtaskId)) return
      this.routingCompletedSubtasks.add(subtaskId)
      try {
        const siblings = new Map(this.db.getSubtasks(parentTaskId).map((task) => [task.id, task]))
        let hasPendingSuccessor = false
        for (const nextSubtaskId of nextSubtaskIds) {
          const nextSubtask = siblings.get(nextSubtaskId)
          if (!nextSubtask) {
            routingIssue = `Selected successor ${nextSubtaskId} no longer exists.`
            continue
          }
          if (nextSubtask.status === TaskStatus.Completed) continue
          if (nextSubtask.status !== TaskStatus.NotStarted) {
            hasPendingSuccessor = true
            continue
          }
          if (!nextSubtask.agent_id) {
            routingIssue = `Selected successor ${nextSubtaskId} has no agent assigned.`
            continue
          }
          try {
            const result = await this.startTask(nextSubtaskId, { preferSubtasks: false, allowTriage: false })
            if (result.action === 'no_action') routingIssue = `Selected successor ${nextSubtaskId} could not start.`
            else hasPendingSuccessor = true
          } catch (err) {
            console.error(`[AgentManager] Failed to start successor ${nextSubtaskId} after subtask ${subtaskId}:`, err)
            routingIssue = `Selected successor ${nextSubtaskId} failed to start.`
          }
        }
        if (!hasPendingSuccessor && !routingIssue) {
          routingIssue = 'All selected successors are already completed.'
        }
      } finally {
        this.routingCompletedSubtasks.delete(subtaskId)
      }
      if (!routingIssue) return
      // Project event (#57): a chain that cannot advance on its own needs the
      // project's Mastermind, not only the parent coordinator.
      emitTaskEvent(this.db, 'chain_stuck', parentTaskId, `After subtask ${subtaskId}: ${routingIssue}`)
    }

    const live = this.findSessionByTaskId(parentTaskId)
    if (live && live.session.status !== 'idle') {
      console.log(
        `[AgentManager] Subtask ${subtaskId} terminal, but parent ${parentTaskId} session is ${live.session.status} — no wake-up needed`
      )
      return
    }

    const subtasks = this.db.getSubtasks(parentTaskId)
    if (subtasks.length === 0) return

    // Wake the parent once no subtask is still actively being worked on —
    // not only when every child is terminal. A coordinator that created
    // children and then went idle must be told the pipeline drained so it can
    // start the next not_started child, spawn follow-ups, or consolidate,
    // instead of being left suspended while work sits in not_started.
    // A successor-routing problem needs a decision now, even mid-pipeline.
    const stillWorking = subtasks.some(
      (s) => s.status === TaskStatus.AgentWorking || s.status === TaskStatus.Triaging
    )
    if (!routingIssue && stillWorking) {
      console.log(
        `[AgentManager] Subtask ${subtaskId} terminal, but parent ${parentTaskId} still has a subtask being worked on — deferring wake-up`
      )
      return
    }

    if (this.wakingParents.has(parentTaskId)) return
    this.wakingParents.add(parentTaskId)
    try {
      const message = buildSubtaskWakeMessage(parentTaskId, subtasks, routingIssue ? { subtaskId, issue: routingIssue } : undefined)
      console.log(`[AgentManager] Waking parent coordinator ${parentTaskId} after subtask ${subtaskId}${routingIssue ? ' (successor routing issue)' : ''}`)
      await this.sendByTaskId(parentTaskId, message)
    } finally {
      this.wakingParents.delete(parentTaskId)
    }
  }

  /** Tasks whose projection backfill is in flight (dedupe guard). */
  private backfillInFlight: Set<string> = new Set()
  /** Tasks whose full adapter history has already been ingested THIS app run. */
  private ingestedTasks: Set<string> = new Set()

  /**
   * Snapshot of the durable transcript projection for a task.
   * Clients (renderer, mobile) render from this instead of relying on having
   * observed every live event.
   *
   * On the first read per app run, if the projection is EMPTY, seed it from the
   * task's persisted session history (a one-time backfill for sessions that
   * predate the store). A task that already has parts is returned as-is — its
   * live write-through capture is authoritative and is never re-ingested.
   */
  async getTranscriptSnapshot(taskId: string, sinceSeq?: number): Promise<ReturnType<DatabaseManager['getTranscriptParts']>> {
    if (!this.ingestedTasks.has(taskId)) {
      await this.backfillTranscriptProjection(taskId)
    }
    return this.db.getTranscriptParts(taskId, sinceSeq)
  }

  /**
   * Delta query for the projection-cache client: parts changed since `sinceRev`,
   * plus the current maxRev. Ensures the one-time backfill has run so the first
   * delta after a fresh start is complete.
   */
  async getTranscriptDelta(taskId: string, sinceRev: number): Promise<ReturnType<DatabaseManager['getTranscriptDelta']>> {
    if (!this.ingestedTasks.has(taskId)) {
      await this.backfillTranscriptProjection(taskId)
    }
    return this.db.getTranscriptDelta(taskId, sinceRev)
  }

  /**
   * Idempotent ingest of a task's persisted session history into the durable
   * projection — runs once per app run per task. Reuses the adapter's
   * side-effect-free persisted-history read (no CLI spawn). Upsert-by-part-id +
   * created_at ordering means re-ingesting is safe, never duplicates, and fills
   * gaps (e.g. assistant messages missing from a partially-populated projection).
   * Best-effort: silently no-ops when unavailable.
   */
  private async backfillTranscriptProjection(taskId: string): Promise<void> {
    if (this.backfillInFlight.has(taskId) || this.ingestedTasks.has(taskId)) return

    // Seed EMPTY projections ONLY. If the task already has parts, the live
    // session was captured by write-through — re-ingesting the persisted session
    // history (whose part ids differ from the live-captured ids) would duplicate
    // messages under mismatched ids. And because every upsert broadcasts a
    // `transcript:changed` delta to ALL connected clients, those duplicates would
    // leak to the desktop view too: a mobile (or any) reader connecting to an
    // already-populated task must never mutate the projection. Backfill is a
    // one-time seed for sessions that predate the store, nothing more.
    if (this.db.hasTranscriptParts(taskId)) {
      this.ingestedTasks.add(taskId)
      return
    }

    const task = this.db.getTask(taskId)
    const sessionId = task?.session_id
    const agentId = task?.agent_id
    if (!sessionId || !agentId) return

    const adapter = this.getAdapter(agentId)
    if (!adapter || typeof adapter.getPersistedMessages !== 'function') return

    this.backfillInFlight.add(taskId)
    try {
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      const messages = await adapter.getPersistedMessages(sessionId, { agentId, taskId, workspaceDir })

      // The projection is empty here (guarded above), so this is a pure seed —
      // no dedup against existing parts is needed. Upsert-by-part-id keeps it
      // idempotent if two seeds ever race.
      const parts = transcriptPartsFromMessages(messages)
      if (parts.length > 0) {
        this.db.upsertTranscriptParts(taskId, parts)
        console.log(`[AgentManager] Backfilled ${parts.length} transcript part(s) into the projection for task ${taskId}`)
      }
    } catch (err) {
      console.error(`[AgentManager] Transcript projection backfill failed for task ${taskId}:`, err)
    } finally {
      this.backfillInFlight.delete(taskId)
      // A real ingest attempt ran (adapter + session present) — don't repeat the
      // full history read on every subsequent snapshot this app run. Write-through
      // keeps the projection current from here.
      this.ingestedTasks.add(taskId)
    }
  }

  /** Used by HeartbeatScheduler to read the heartbeat result. */
  getLastAssistantMessage(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    if (!session?.adapter) return null
    return session.lastAssistantText ?? null
  }

  /** Full message list of the task's live session; null when there is none. */
  private async getLiveMessages(taskId: string): Promise<SessionMessage[] | null> {
    const session = this.findSessionByTaskId(taskId)?.session
    if (!session?.adapter?.getAllMessages) return null
    return session.adapter.getAllMessages(session.id, this.sessionConfigFor(session))
  }

  /** Raw transcript for the renderer's hidden "Copy Debug Info" feature. */
  async getRawTranscriptForDebug(taskId: string): Promise<DebugTranscriptMessage[]> {
    try {
      return debugTranscript(await this.getLiveMessages(taskId) ?? [])
    } catch (err) {
      console.error(`[AgentManager] Failed to get raw transcript for task ${taskId}:`, err)
      return []
    }
  }

  /** Text-only transcript served to subtask MCP agents for sibling coordination. */
  async getTranscriptForTask(taskId: string): Promise<Array<{ role: string; text: string }>> {
    try {
      return textTranscript(await this.getLiveMessages(taskId) ?? [])
    } catch (err) {
      console.error(`[AgentManager] Failed to get transcript for task ${taskId}:`, err)
      return []
    }
  }

  /**
   * Reconnects to an existing session by its persisted session ID and resumes
   * it idle (history is not replayed; clients render the durable projection).
   */
  async resumeSession(agentId: string, taskId: string, sessionId: string): Promise<string> {
    console.log('[AgentManager] resumeSession called:', { agentId, taskId, sessionId })
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }

    return this.resumeAdapterSession(adapter, agentId, taskId, sessionId)
  }

  /**
   * Polling can observe IDLE in the same tick that the adapter persists the
   * final assistant message. Re-reads the full message list once and emits any
   * part the renderer has not seen. Returns the number of parts replayed.
   */
  private async replayMissedTranscriptPartsBeforeIdle(sessionId: string, session: AgentSession): Promise<number> {
    if (!session.adapter?.getAllMessages) return 0

    try {
      const messages = await session.adapter.getAllMessages(sessionId, this.sessionConfigFor(session))
      // Loaded lazily: usually every part is already known by id or content key.
      const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
      let existingContent: Set<string> | undefined
      const isPersisted = (content: string): boolean => {
        existingContent ??= new Set(
          this.db.getTranscriptParts(session.taskId)
            .filter((p) => p.content)
            .map((p) => normalize(p.content))
        )
        return existingContent.has(normalize(content))
      }
      const batchMessages = collectMissedParts(messages, {
        seenPartIds: session.seenPartIds,
        partContentLengths: session.partContentLengths,
        assistantTextKeys: (session.assistantTextKeys ??= new Set<string>())
      }, isPersisted)

      if (batchMessages.length > 0) {
        console.log(`[AgentManager] Replaying ${batchMessages.length} missed transcript part(s) for ${sessionId} before idle`)
        this.sendToRenderer('agent:output-batch', {
          sessionId,
          taskId: session.taskId,
          messages: batchMessages
        })
      }
      return batchMessages.length
    } catch (err) {
      console.error(`[AgentManager] replayMissedTranscriptPartsBeforeIdle error for ${sessionId}:`, err)
      return 0
    }
  }

  private resumeAdapterPollingAfterPrematureIdle(sessionId: string, session: AgentSession): void {
    if (!session.adapter) return

    session.status = 'working'
    session.pollingStarted = true
    this.startAdapterPolling(sessionId, session.adapter, this.sessionConfigFor(session), session)

    const pollingEntry = this.pollingEntries.get(sessionId)
    if (pollingEntry) {
      pollingEntry.hasSeenWork = true
      pollingEntry.lastPartReceivedAt = Date.now()
    }

    this.emitStatus(sessionId, session, 'working')
  }

  /** Local agents help a human owner; only that human can accept completion. */
  async completeTaskWithoutReview(taskId: string, knownTask?: TaskRecord): Promise<boolean> {
    const task = knownTask ?? this.db.getTask(taskId)
    if (!task) return false

    // Agent-owned work completes through agent-harness. Local help must not
    // use the human owner's token to accept its own result.
    return false
  }

  /**
   * Transitions a session to idle and notifies the renderer. Output field
   * values are extracted BEFORE notifying so the renderer's re-fetch sees them.
   */
  private async transitionToIdle(sessionId: string, session: AgentSession): Promise<void> {
    if (session.status === 'idle') {
      console.log(`[AgentManager] transitionToIdle: session ${sessionId} already idle, skipping`)
      return
    }
    console.log(`[AgentManager] Session ${sessionId} preparing to transition idle`)

    // transitionToIdle chains many sync DB calls, hence the yieldEventLoop() calls.

    // Triage done: back to NotStarted, now with agent_id assigned.
    if (session.isTriageSession) {
      session.status = 'idle'
      console.log(`[AgentManager] Triage session completed for task ${session.taskId}, reverting to NotStarted`)
      this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.NotStarted, session_id: null })
      await yieldEventLoop()

      this.sendToRenderer('task:updated', {
        taskId: session.taskId,
        updates: this.db.getTask(session.taskId) || { status: TaskStatus.NotStarted, session_id: null }
      })

      this.emitStatus(sessionId, session, 'idle')

      // Release through the adapter first: otherwise the agent CLI process and
      // its task-management MCP child stay alive with no handle left to stop them.
      await this.releaseAdapterSession(sessionId, 'triage_completed')
      this.sessions.delete(sessionId)
      this.schedulePowerSaveBlockerUpdate()
      console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} reason=triage_completed`)
      return
    }

    // Polling can observe IDLE in the same tick that the adapter persists the
    // final assistant message. Reconcile once against the stored transcript so
    // the UI doesn't miss the last response.
    const replayedPartCount = await this.replayMissedTranscriptPartsBeforeIdle(sessionId, session)
    await yieldEventLoop()

    if (session.adapter) {
      try {
        const statusAfterReplay = await session.adapter.getStatus(sessionId, this.sessionConfigFor(session))
        if (statusAfterReplay.type !== SessionStatusType.IDLE) {
          console.log(
            `[AgentManager] Idle transition for ${sessionId} deferred after replay: replayed=${replayedPartCount}, adapterStatus=${statusAfterReplay.type}`
          )
          this.resumeAdapterPollingAfterPrematureIdle(sessionId, session)
          return
        }
      } catch (err) {
        console.error(`[AgentManager] Failed to re-check adapter status before idle for ${sessionId}:`, err)
      }
    }

    // Idle is a state flag only — it never terminates the session or any
    // subagent/subtask work. Termination is decoupled and handled solely by
    // the inactivity reaper (long threshold) or an explicit user stop.
    session.status = 'idle'
    session.lastActivityAt = Date.now()
    console.log(`[AgentManager] Session ${sessionId} → idle`)

    // Pseudo-tasks (heartbeat-*) have no DB row, and a coordinator row has no
    // lifecycle: neither goes to review, grows a heartbeat or wakes a parent.
    const task = this.db.getTask(session.taskId)
    await yieldEventLoop()

    if (!task || isCoordinatorTask(task)) {
      console.log(`[AgentManager] No lifecycle for ${session.taskId}, sending idle status only`)
      this.emitStatus(sessionId, session, 'idle')
      return
    }

    console.log(`[AgentManager] transitionToIdle checking task status: ${task.status} (looking for ${TaskStatus.AgentLearning})`)
    if (task.status === TaskStatus.AgentLearning) {
      console.log(`[AgentManager] Task in learning mode, syncing skills and marking as completed`)

      try {
        await this.syncSkillsFromWorkspace(sessionId)
      } catch (err) {
        console.error(`[AgentManager] Skill sync error:`, err)
        updateTaskFromUser(this.db, session.taskId, {status: TaskStatus.ReadyForReview})
        this.sendToRenderer('task:updated', {taskId: session.taskId, updates: this.db.getTask(session.taskId)})
        this.emitStatus(sessionId, session, 'idle')
        return
      }
      await yieldEventLoop()

      try {
        const completed = await finishSessionFeedback(this.db, this.syncManager, session.taskId)
        if (completed?.parent_task_id) {
          await this.notifyParentOfSubtaskCompletion(completed.parent_task_id, session.taskId)
        }
        if (!completed && this.db.getTask(session.taskId)?.status !== TaskStatus.Completed) this.updateTaskFromLocalAgent(session.taskId, {status: TaskStatus.ReadyForReview})
      } catch (error) {
        this.sendToRenderer('task:source-action-failed', {taskId: session.taskId, taskTitle: task.title, error: error instanceof Error ? error.message : String(error)})
      }
      this.sendToRenderer('task:updated', {taskId: session.taskId, updates: this.db.getTask(session.taskId)})
      this.emitStatus(sessionId, session, 'idle')
      return
    }

    try {
      await this.extractOutputValues(sessionId)
    } catch (err) {
      console.error(`[AgentManager] extractOutputValues error:`, err)
    }
    await yieldEventLoop()

    // The frontend may have completed the task during the feedback flow meanwhile.
    const taskAfterExtract = this.db.getTask(session.taskId)
    await yieldEventLoop()

    if (taskAfterExtract?.status === TaskStatus.AgentLearning || taskAfterExtract?.status === TaskStatus.Completed) {
      console.log(`[AgentManager] Task already in final state (${taskAfterExtract.status}), skipping status update`)
      this.emitStatus(sessionId, session, 'idle')
      return
    }

    // Desktop agent work is help: it goes to review. Only the server can accept completion.
    console.log(`[AgentManager] Updating task ${session.taskId} status to ReadyForReview`)
    this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.ReadyForReview })
    await yieldEventLoop()

    this.autoEnableHeartbeat(session.taskId)
    await yieldEventLoop()

    const updatedTask = this.db.getTask(session.taskId)
    this.sendToRenderer('task:updated', {
      taskId: session.taskId,
      updates: {
        status: TaskStatus.ReadyForReview,
        output_fields: updatedTask?.output_fields,
        heartbeat_enabled: updatedTask?.heartbeat_enabled,
        heartbeat_interval_minutes: updatedTask?.heartbeat_interval_minutes,
        heartbeat_next_check_at: updatedTask?.heartbeat_next_check_at
      }
    })

    // Event-driven coordinator wake-up: the parent does not need to stay
    // resident polling for child status — it can go idle (or even have its
    // runtime released) and is resumed exactly when there is something to act on.
    if (task.parent_task_id) {
      this.notifyParentOfSubtaskCompletion(task.parent_task_id, session.taskId).catch((err) => {
        console.error(`[AgentManager] Failed to wake parent ${task.parent_task_id} after subtask ${session.taskId} completed:`, err)
      })
    }

    this.emitStatus(sessionId, session, 'idle')
  }

  /** Interrupts the current generation and stops polling; keeps the transcript and task status. */
  async abortSession(sessionId: string): Promise<void> {
    const resolved = this.resolveSession(sessionId, 'abortSession')
    if (!resolved) return
    const { session } = resolved
    sessionId = resolved.sessionId

    console.log(`[AgentManager] Aborting session ${sessionId}`)
    this.stopAdapterPolling(sessionId)

    const adapter = this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.abortPrompt(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error aborting adapter session:`, error)
      }
    }

    session.status = 'idle'
    this.emitStatus(sessionId, session, 'idle')
  }

  /**
   * Releases the backend session behind a tracked session, without touching task
   * status or renderer state.
   *
   * Dropping a session from `this.sessions` is not enough: the backend session
   * owns the agent CLI process and its MCP stdio children, and after the drop no
   * handle to them is left, so they run until the app quits. Callers that finish
   * a session on their own terms (triage, learning) use this to release it.
   */
  private async releaseAdapterSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.stopAdapterPolling(sessionId)
    const adapter = session.adapter ?? this.getAdapter(session.agentId)
    if (!adapter) return
    try {
      const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
      await adapter.destroySession(sessionId, sessionConfig)
      console.log(`[AgentManager] Released backend session ${sessionId} (${reason})`)
    } catch (error) {
      console.error(`[AgentManager] Error releasing backend session ${sessionId} (${reason}):`, error)
    }
  }

  /**
   * Fully destroys the session — stops polling, removes from map.
   * @param resetTaskStatus - If true, resets task status to NotStarted (default: true)
   */
  async stopSession(sessionId: string, resetTaskStatus: boolean = true): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[AgentManager] Session ${sessionId} not found`)
      return
    }

    console.log(`[AgentManager] Destroying session ${sessionId} (resetTaskStatus=${resetTaskStatus})`)

    this.stopAdapterPolling(sessionId)

    const adapter = this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.destroySession(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error destroying adapter session:`, error)
      }
    }

    if (session.secretSessionToken) {
      unregisterSecretSession(session.secretSessionToken)
      console.log(`[AgentManager] Unregistered secret session for ${sessionId}`)
    }

    // Eagerly clear dedup structures to free memory immediately (don't wait for GC)
    session.seenMessageIds.clear()
    session.seenPartIds.clear()
    session.partContentLengths.clear()

    this.sessions.delete(sessionId)
    this.lastSentStatus.delete(sessionId)
    this.schedulePowerSaveBlockerUpdate()
    console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} resetStatus=${resetTaskStatus} reason=stop_session`)

    for (const [oldId, newId] of this.sessionIdRedirects.entries()) {
      if (newId === sessionId) {
        this.sessionIdRedirects.delete(oldId)
      }
    }

    // Reset only on an explicit user stop (not app shutdown), and never a Completed task.
    if (resetTaskStatus) {
      const task = this.db.getTask(session.taskId)
      if (task?.status !== TaskStatus.Completed) {
        this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.NotStarted })
      }
    }

    this.emitStatus(sessionId, session, 'idle')
  }

  /**
   * Stops a session by taskId — used when the renderer's session mapping
   * is broken (Session: none) and the normal stop-by-sessionId path fails.
   */
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | null }> {
    // Stopping a task also withdraws a start still waiting for a slot.
    this.cancelQueuedStart(taskId)
    const found = this.findSessionByTaskId(taskId)
    if (!found) {
      console.log(`[AgentManager] stopByTaskId: no active session found for task ${taskId}`)
      return { sessionId: null }
    }
    console.log(`[AgentManager] stopByTaskId: found session ${found.sessionId} for task ${taskId}, stopping`)
    await this.stopSession(found.sessionId)
    return { sessionId: found.sessionId }
  }

  // ── Admission control: start queue ─────────────────────────────

  /** Starts waiting for a free slot, in queue order. */
  getStartQueue(): QueuedStartInfo[] {
    return this.startQueue.list()
  }

  /** Withdraws a queued start; true when one was waiting. */
  cancelQueuedStart(taskId: string): boolean {
    if (!this.startQueue.remove(taskId)) return false
    console.log(`[AgentManager] Queued start of task ${taskId} cancelled`)
    this.emitStartQueueChanged()
    return true
  }

  /** Sessions holding a slot: working real-task sessions plus admitted starts in flight. */
  private countedSessions(): CountedSession[] {
    const counted = new Map<string, CountedSession>()
    for (const session of this.sessions.values()) {
      if (session.status !== 'working' && session.status !== 'waiting_approval') continue
      if (session.isTriageSession) continue
      const task = this.db.getTask(session.taskId)
      if (isExemptFromAdmission(session.taskId, task)) continue
      counted.set(session.taskId, { taskId: session.taskId, agentId: session.agentId, projectId: taskProjectId(task) })
    }
    for (const [taskId, agentId] of this.admittedStarts) {
      if (!counted.has(taskId)) counted.set(taskId, { taskId, agentId, projectId: taskProjectId(this.db.getTask(taskId)) })
    }
    return [...counted.values()]
  }

  /** The global cap and pause, plus the requested task's project limits (#65). */
  private admissionLimits(task: TaskRecord | undefined): AdmissionLimits {
    return {
      globalLimit: parseGlobalSessionLimit(this.db.getSetting(MAX_CONCURRENT_AGENT_SESSIONS_SETTING)),
      globalPaused: isAllProjectsPaused(this.db),
      project: task ? projectAdmissionLimits(this.db, taskProjectId(task)) : undefined
    }
  }

  /** Counts an admitted start of a real task against its project's day (#65). */
  private recordCountedStart(task: TaskRecord | undefined): void {
    if (!task) return
    try {
      recordProjectSessionStart(this.db, taskProjectId(task))
    } catch (error) {
      console.warn(`[AgentManager] Could not record the daily session count for task ${task.id}:`, error)
    }
  }

  // ── Project limits and pause (#65) ─────────────────────────────

  /**
   * Stops new starts in every project (or lifts that). Running sessions are
   * untouched; lifting the pause drains the queue. For the Commander (#61)
   * and the project editor.
   */
  pauseAllProjects(paused: boolean): void {
    setAllProjectsPaused(this.db, paused)
    console.log(`[AgentManager] All projects ${paused ? 'paused' : 'unpaused'}`)
    if (!paused) this.scheduleStartQueueDrain()
  }

  isAllProjectsPaused(): boolean {
    return isAllProjectsPaused(this.db)
  }

  /**
   * Re-checks the queue after something outside a session changed the limits:
   * a project's settings were saved (pause lifted, cap raised). Idle sweeps do
   * the same every few minutes as a safety net.
   */
  recheckStartQueue(): void {
    this.scheduleStartQueueDrain()
  }

  /**
   * The project's limits, what they count right now and what is waiting (#65).
   * A `limits` field on the project status (#58) is the intended home once
   * that reads live session state; until then this is its own read.
   */
  getProjectLimitState(projectId: string): ProjectLimitState {
    const queued = this.startQueue.list().filter((entry) => taskProjectId(this.db.getTask(entry.taskId)) === projectId)
    return buildProjectLimitState(this.db, projectId, this.countedSessions(), queued)
  }

  /**
   * Tells the project's Mastermind why a start waits (#65): a short fenced
   * system message to its live, idle coordinator session. A Mastermind
   * mid-turn already sees the reason in its start_task result; one with no
   * live session is told nothing (the queue entry and the project's limit
   * state carry it). Once per project and reason until a queued start runs.
   */
  private tellMastermindAboutLimit(task: TaskRecord | undefined, decision: AdmissionDecision): void {
    if (!task || decision.admitted) return
    if (decision.reason === 'agent_limit' || decision.reason === 'global_limit') return
    const projectId = taskProjectId(task)
    const key = `${projectId}:${decision.reason}`
    if (this.projectLimitNotices.has(key)) return
    const coordinator = this.db.getCoordinatorTask(projectId)
    if (!coordinator) return
    const live = this.findSessionByTaskId(coordinator.id)
    if (!live || live.session.status !== 'idle') return
    this.projectLimitNotices.add(key)
    const message = [
      SYSTEM_MESSAGE_MARKER,
      `provenance: origin=admission-control project=${projectId} human_authored=false authorizes_actions=false`,
      '',
      'A start in your project was queued by admission control. No action is required; the queue drains by itself.',
      '',
      FINDINGS_BEGIN,
      `Task "${task.title}" (${task.id}) is waiting to start: ${describeQueueReason(decision.reason, decision.limit, decision.running)}`,
      FINDINGS_END
    ].join('\n')
    this.sendMessage(live.sessionId, message, coordinator.id, live.session.agentId).catch((error) => {
      console.warn(`[AgentManager] Could not tell the Mastermind of project ${projectId} about the queued start:`, error)
      this.projectLimitNotices.delete(key)
    })
  }

  private emitStartQueueChanged(): void {
    this.sendToRenderer('agent:startQueueChanged', { queue: this.startQueue.list() })
  }

  /** Deferred so the transition that freed the slot finishes first. */
  private scheduleStartQueueDrain(): void {
    if (this.startQueue.size === 0 || this.startQueueDrainScheduled) return
    this.startQueueDrainScheduled = true
    setImmediate(() => {
      this.startQueueDrainScheduled = false
      this.drainStartQueue()
    })
  }

  /**
   * Starts every queued entry that now fits, in FIFO order. An entry blocked
   * by its own agent's limit does not hold back entries for other agents.
   * Entries whose task is gone, finished, reassigned or already running are
   * dropped.
   */
  drainStartQueue(): void {
    let changed = false
    for (const entry of this.startQueue.snapshot()) {
      const agent = this.db.getAgent(entry.agentId)
      const task = this.db.getTask(entry.taskId)
      const stale =
        !agent ? 'agent deleted'
        : !task ? 'task deleted'
        : task.status === TaskStatus.Completed ? 'task completed'
        : task.agent_id && task.agent_id !== entry.agentId ? 'task reassigned'
        : this.hasActiveSessionForTask(entry.taskId) ? 'task already running'
        : null
      if (stale) {
        console.log(`[AgentManager] Dropping queued start of task ${entry.taskId}: ${stale}`)
        this.startQueue.remove(entry.taskId)
        changed = true
        continue
      }

      const decision = checkAdmission(
        { agentId: entry.agentId, taskId: entry.taskId, task, agent: agent! },
        this.countedSessions(),
        this.admissionLimits(task)
      )
      if (!decision.admitted) {
        // The queued reason follows the current limits: a project may have
        // gone from "at its limit" to "paused" while its start waited.
        if (entry.reason !== decision.reason) {
          entry.reason = decision.reason
          changed = true
        }
        if (isGlobalAdmissionReason(decision.reason)) break
        continue
      }

      this.startQueue.remove(entry.taskId)
      changed = true
      this.recordCountedStart(task)
      for (const key of this.projectLimitNotices) {
        if (key.startsWith(`${taskProjectId(task)}:`)) this.projectLimitNotices.delete(key)
      }
      // Reserve the slot now: the start below is async and the next entry's
      // check must already see it.
      this.admittedStarts.set(entry.taskId, entry.agentId)
      console.log(`[AgentManager] Starting queued task ${entry.taskId} (agent ${entry.agentId})`)
      void this.startSessionNow(entry.agentId, entry.taskId, entry.workspaceDir, entry.skipInitialPrompt)
        .catch((error) => {
          // Not re-queued: a start that throws would throw again. The task
          // stays not_started, so the automation sweep or the user can retry.
          console.error(`[AgentManager] Queued start of task ${entry.taskId} failed:`, error)
          this.sendToRenderer('agent:startQueueChanged', {
            queue: this.startQueue.list(),
            failed: { taskId: entry.taskId, error: error instanceof Error ? error.message : String(error) }
          })
        })
        .finally(() => {
          this.admittedStarts.delete(entry.taskId)
          this.scheduleStartQueueDrain()
        })
    }
    if (changed) this.emitStartQueueChanged()
  }

  /**
   * Sends a message by taskId — used when the renderer's session mapping
   * is broken and the normal send-by-sessionId path can't resolve a sessionId.
   * Tries to find a live in-memory session first, then falls back to
   * sendMessage's built-in resume/create logic.
   */
  async sendByTaskId(
    taskId: string,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<{ sessionId: string | null; newSessionId?: string }> {
    const found = this.findSessionByTaskId(taskId)
    if (found) {
      console.log(`[AgentManager] sendByTaskId: found live session ${found.sessionId} for task ${taskId}`)
      const result = await this.sendMessage(found.sessionId, message, taskId, found.session.agentId, attachments)
      return { sessionId: found.sessionId, ...result }
    }
    // sendMessage resumes from the persisted session_id or creates a new session.
    console.log(`[AgentManager] sendByTaskId: no live session for task ${taskId}, delegating to sendMessage for recovery`)
    const result = await this.sendMessage('', message, taskId, undefined, attachments)
    return { sessionId: null, ...result }
  }

  async sendMessage(
    sessionId: string,
    message: string,
    taskId?: string,
    agentId?: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<{ newSessionId?: string }> {
    const resolved = this.resolveSession(sessionId, 'sendMessage')
    let session = resolved?.session
    if (resolved) sessionId = resolved.sessionId

    // Session gone from memory: RESUME first (keeps the conversation), else start a new one.
    if (!session && taskId) {
      // Regular tasks carry their agent; the Mastermind (a coordinator row
      // with no agent_id) passes it in.
      const task = this.db.getTask(taskId)
      const resolvedAgentId = task?.agent_id || agentId

      if (resolvedAgentId) {
        const persistedSessionId = task?.session_id
        if (persistedSessionId) {
          try {
            console.log(`[AgentManager] Session ${sessionId} not found, attempting resume from ${persistedSessionId} for task ${taskId}`)
            console.log(`[SessionTracker] RESUME_ATTEMPT old=${sessionId} persisted=${persistedSessionId} task=${taskId} reason=session_not_in_memory`)
            const adapter = this.getAdapter(resolvedAgentId)
            if (adapter) {
              const resumedId = await this.resumeAdapterSession(adapter, resolvedAgentId, taskId, persistedSessionId)
              session = this.sessions.get(resumedId)
              if (session) {
                sessionId = resumedId
              }
            }
          } catch (error) {
            // An active writer means the conversation still exists. Starting a
            // replacement here would silently discard its context and overwrite
            // the persisted resume anchor.
            const resumeError = error instanceof Error ? error.message : String(error)
            if (resumeError.includes('already has an active writer') || resumeError.includes('thread-store conflict')) {
              throw new Error(`Cannot resume this conversation because its runtime is still active. The existing session has been preserved. Retry after the runtime has released it. ${resumeError}`)
            }
            console.warn(`[AgentManager] Resume failed, will create new session:`, error)
          }
        }

        if (!session) {
          console.log(`[AgentManager] Creating new session for task ${taskId}`)
          // A direct message continues existing work; it is not held back by
          // the concurrency limits.
          const newSessionId = await this.startSessionNow(resolvedAgentId, taskId, undefined, true)
          session = this.sessions.get(newSessionId)
          if (!session) throw new Error('Failed to restart session')
          sessionId = newSessionId
          console.log(`[SessionTracker] CREATED_FALLBACK session=${newSessionId} task=${taskId} reason=resume_failed_or_no_persisted_session`)
        }

        this.sendInBackground(session, sessionId, message, attachments)
        return { newSessionId: sessionId }
      }
    }

    if (!session) throw new Error(`Session not found: ${sessionId}`)
    this.sendInBackground(session, sessionId, message, attachments)
    return {}
  }

  /** Fire-and-forget, so the IPC response is not blocked and the renderer does not freeze. */
  private sendInBackground(session: AgentSession, sessionId: string, message: string, attachments?: MessageAttachmentRef[]): void {
    this.doSendAdapterMessage(session, sessionId, message, attachments).catch((err) => {
      console.error(`[AgentManager] doSendAdapterMessage failed for session ${sessionId}:`, err)
      return this.handleSessionError(sessionId, session, err)
    })
  }

  /**
   * Handles errors from fire-and-forget doSendAdapterMessage calls.
   * Sends error status AND the real message to the renderer so the transcript
   * shows why the send failed (instead of a generic "session did not start")
   * and the user can retry with "continue". The session stays recoverable:
   * the next send clears the error state (see doSendAdapterMessage).
   */
  private async handleSessionError(sessionId: string, session: AgentSession, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AgentManager] Session ${sessionId} error:`, message)
    if (findCreditExhaustionMessage([message]) && await this.tryAutomaticFallback(sessionId, session, message)) {
      return
    }
    session.status = 'error'
    this.emitSystemError(
      sessionId,
      session.taskId,
      `send-error-${Date.now()}`,
      `Could not send the message: ${message}\n\nThe session is still here — fix the issue and retry with "continue".`
    )
    this.emitStatus(sessionId, session, 'error')
  }

  private async doSendAdapterMessage(
    session: AgentSession,
    sessionId: string,
    message: string,
    attachments?: MessageAttachmentRef[]
  ): Promise<void> {
    session.autoAbortNotified = false

    if (session.status === 'error') {
      // An incompatible session is not recoverable; other errors (e.g. rate limits) are.
      if (session.adapter) {
        const adapterStatus = await session.adapter.getStatus(sessionId, {} as SessionConfig)
        if (adapterStatus.message?.includes('INCOMPATIBLE_SESSION_ID')) {
          throw new Error('Session is in error state: incompatible session')
        }
      }
      console.log(`[AgentManager] Clearing error state for session ${sessionId} to allow recovery`)
      session.status = 'working'
      session.pollingStarted = false
    }
    if (!session.adapter) throw new Error('Adapter not initialized')
    // Attachments added mid-session must be referenceable immediately.
    if (session.workspaceDir) {
      syncAttachmentsToWorkspace(this.db, session.taskId, session.workspaceDir)
    }

    // AgentLearning is preserved.
    session.status = 'working'
    session.lastActivityAt = Date.now()
    const currentTask = this.db.getTask(session.taskId)
    if (currentTask?.status !== TaskStatus.AgentLearning) {
      this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.AgentWorking })
    }
    this.emitStatus(sessionId, session, 'working')

    this.sendToRenderer('agent:output', {
      sessionId,
      taskId: session.taskId,
      type: 'message',
      data: {
        id: `user-message-${Date.now()}`,
        role: 'user',
        content: buildDisplayMessage(message, attachments),
        partType: 'text'
      }
    })

    const sessionConfig = await this.buildSessionConfig(
      session.agentId,
      session.taskId,
      session.workspaceDir || process.cwd()
    )

    const promptText = buildMessageWithAttachmentContext(session.workspaceDir, message, attachments)
    await session.adapter.sendPrompt(sessionId, [{ type: MessagePartType.TEXT, text: promptText }], sessionConfig)

    if (!session.pollingStarted) {
      console.log(`[AgentManager] Starting polling for session ${sessionId} (preserving dedup state)`)
      session.pollingStarted = true
      // Passing the session keeps its dedup state, so old messages are not re-sent.
      this.startAdapterPolling(sessionId, session.adapter, sessionConfig, session)
    }
  }

  async respondToPermission(
    sessionId: string,
    approved: boolean,
    message?: string,
    optionId?: string,
    responseType?: 'permission' | 'question',
    requestId?: string
  ): Promise<void> {
    const resolved = this.resolveSession(sessionId, 'respondToPermission')
    if (!resolved) throw new Error(`Session not found: ${sessionId}`)
    const { session } = resolved
    sessionId = resolved.sessionId

    const adapter = this.getAdapter(session.agentId)

    const approvalAdapter = adapter && 'respondToApproval' in adapter
      && typeof (adapter as unknown as AcpAdapter).respondToApproval === 'function'

    // --- Question responses: pass structured answers ---
    // OpenCode implements both response methods. The renderer must identify a
    // question response so it does not go to the permission endpoint first.
    if (adapter && typeof adapter.respondToQuestion === 'function'
      && (responseType === 'question' || !approvalAdapter)) {
      if (!approved) {
        console.log(`[AgentManager] Question rejected for session ${sessionId}`)
        session.status = 'idle'
        this.emitStatus(sessionId, session, 'idle')
        return
      }

      // The renderer sends "Header1: Answer1\nHeader2: Answer2" or a single answer.
      const answers: Record<string, string> = {}
      if (message) {
        const lines = message.split('\n')
        for (const line of lines) {
          const colonIdx = line.indexOf(':')
          if (colonIdx > 0) {
            answers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
          } else {
            answers['answer'] = line.trim()
          }
        }
      }

      console.log(`[AgentManager] Responding to question via adapter for session ${sessionId}`)

      const adapterConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
      const response = requestId
        ? await adapter.respondToQuestion(sessionId, answers, adapterConfig, requestId)
        : await adapter.respondToQuestion(sessionId, answers, adapterConfig)
      const handled = typeof response === 'object' ? response.handled : response
      if (handled === false) {
        console.log(`[AgentManager] Ignored stale question response for session ${sessionId}`)
        if (typeof response === 'object' && response.resolutionPart) {
          const part = response.resolutionPart
          this.sendToRenderer('agent:output', {
            sessionId,
            taskId: session.taskId,
            type: 'message',
            data: {
              id: part.id,
              role: part.role || 'assistant',
              content: part.content || part.text || '',
              partType: part.type,
              tool: part.tool,
              update: part.update,
            },
          })
        }
        return
      }

      // Update session and task state after the adapter accepts the response.
      session.status = 'working'
      const currentTask = this.db.getTask(session.taskId)
      if (currentTask?.status !== TaskStatus.AgentLearning) {
        this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.AgentWorking })
      }
      this.emitStatus(sessionId, session, 'working')

      if (message) {
        this.sendToRenderer('agent:output', {
          sessionId,
          taskId: session.taskId,
          type: 'message',
          data: {
            id: `user-answer-${Date.now()}`,
            role: 'user',
            content: message,
            partType: 'text'
          }
        })
      }

      // The session may have gone idle before the answer arrived.
      if (!session.pollingStarted && session.adapter) {
        console.log(`[AgentManager] Restarting polling after question answer for session ${sessionId}`)
        session.pollingStarted = true
        this.startAdapterPolling(sessionId, session.adapter, adapterConfig)
      }
      return
    }

    // --- ACP/OpenCode permission responses: use permission-style options ---
    if (approvalAdapter) {
      let selectedOption = optionId
      if (!selectedOption && message) {
        const answerMap: Record<string, string> = {
          'Always': 'approved-for-session',
          'Yes': 'approved',
          'No, provide feedback': 'abort',
          'No': 'abort'
        }
        selectedOption = answerMap[message] || (approved ? 'approved' : 'abort')
      }
      console.log(`[AgentManager] Responding to ACP adapter approval with: ${selectedOption}`)
      // OpenCode adapter returns boolean (true=handled, false=no permission found).
      // AcpAdapter returns void. Cast to boolean|void to handle both.
      const handled = await (adapter as unknown as {
        respondToApproval: (sid: string, approved: boolean, opt?: string, requestId?: string) => Promise<boolean | void>
      }).respondToApproval(sessionId, approved, selectedOption, requestId)

      // Provider callbacks do not survive a restored session. Resolve the old
      // card immediately instead of approving a newer request or sending a
      // continuation into a session that is already idle.
      if (handled === false && requestId) {
        console.log(`[AgentManager] Ignored stale approval response for session ${sessionId}`)
        this.sendToRenderer('agent:output', {
          sessionId,
          taskId: session.taskId,
          type: 'message',
          data: {
            id: `question-${requestId}`,
            role: 'assistant',
            content: '',
            partType: 'question',
            tool: {
              name: 'permission',
              status: 'cancelled',
              requestId,
              output: 'This request expired when the session ended. Restart the turn to continue.'
            },
            update: true
          }
        })
        return
      }

      // If no pending permission was found (stale prompt after watchdog abort
      // or app restart), send a continuation message so the session recovers.
      // AcpAdapter returns void (undefined), which won't match === false.
      if (handled === false && approved) {
        console.log(`[AgentManager] No pending permission found for ${sessionId}, sending continuation message to recover session`)
        this.sendInBackground(session, sessionId, 'continue')
      }
      return
    }

    console.warn(`[AgentManager] No adapter handler for permission response in session ${sessionId}`)
  }

  async stopAllSessions(): Promise<void> {
    console.log(`[AgentManager] Stopping all ${this.sessions.size} sessions`)

    // Shutdown: the stops below free slots, which must not start queued work.
    this.startQueue.clear()

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer)
      this.pollingTimer = null
    }
    this.pollingEntries.clear()

    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = null
    }

    await Promise.allSettled(
      // Shutdown preserves task status.
      [...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId, false))
    )
  }

  getSessionStatus(sessionId: string): { status: string; agentId: string; taskId: string } | null {
    const session = this.resolveSession(sessionId)?.session
    if (!session) return null
    return { status: session.status, agentId: session.agentId, taskId: session.taskId }
  }

  getActiveSessionsForTask(taskId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId && session.status !== 'error') {
        sessionIds.push(sessionId)
      }
    }
    return sessionIds
  }

  async getProviders(serverUrl?: string, directory?: string, backendType?: string): Promise<{ providers: { id: string; name: string; [key: string]: unknown }[]; default: Record<string, string> } | null> {
    try {
      const defaultAgent = this.defaultAgent()
      const baseUrl = serverUrl || defaultAgent?.server_url || DEFAULT_SERVER_URL
      const resolvedBackend = backendType || getAgentProvider(defaultAgent)

      // Only OpenCode and Pi expose configurable providers/models.
      if (resolvedBackend !== CodingAgentType.OPENCODE && resolvedBackend !== CodingAgentType.PI) {
        console.log(`[AgentManager] Backend "${resolvedBackend}" does not support provider listing, skipping`)
        return null
      }

      const adapter = this.getAdapterByType(resolvedBackend)
      if (!adapter?.getProviders) {
        console.log(`[AgentManager] Adapter for "${resolvedBackend}" does not support getProviders`)
        return null
      }

      // Push updated config to the server before querying providers. This is
      // user-initiated (settings UI) so it's safe to push even if sessions are
      // running — the user explicitly opened settings to change config.
      if (adapter.notifyConfigChanged) {
        try {
          await adapter.notifyConfigChanged()
        } catch {
          // notifyConfigChanged already logs; proceed with cached config
        }
      }

      return await adapter.getProviders(baseUrl, directory)
    } catch (error: unknown) {
      console.log('[AgentManager] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  private defaultAgent(): AgentRecord | undefined {
    const agents = this.db.getAgents()
    return agents.find((agent) => agent.is_default) || agents[0]
  }

  /** Fills the task's output fields from the session's messages on completion. */
  private async extractOutputValues(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.adapter) return

    const task = this.db.getTask(session.taskId)
    if (!task?.output_fields || task.output_fields.length === 0) return

    console.log(`[AgentManager] Extracting output values for task ${session.taskId}`)
    if (!session.adapter.getAllMessages) {
      console.warn('[AgentManager] Adapter does not implement getAllMessages')
      return
    }

    try {
      const messages: SessionMessage[] = await session.adapter.getAllMessages(sessionId, {
        agentId: session.agentId,
        taskId: session.taskId,
        workspaceDir: session.workspaceDir || process.cwd()
      })
      if (messages.length === 0) {
        console.log('[AgentManager] No messages found')
        return
      }
      this.updateTaskFromLocalAgent(session.taskId, { output_fields: extractOutputFromMessages(messages, task.output_fields) })
      console.log(`[AgentManager] Extracted output values for task ${session.taskId}`)
    } catch (error) {
      console.error(`[AgentManager] Error extracting output values:`, error)
    }
  }

  syncSkillsFromWorkspace(sessionId: string): SkillSyncResult {
    const session = this.sessions.get(sessionId)
    if (!session?.workspaceDir) {
      console.log(`[AgentManager] syncSkillsFromWorkspace: no session or workspaceDir for ${sessionId} (sessions count: ${this.sessions.size})`)
      return emptySkillSyncResult()
    }
    return syncSkillsFromDirectory(this.db, session.workspaceDir)
  }

  /**
   * Register an external listener that receives all events sent to the renderer.
   * Used by the mobile API server to broadcast via WebSocket.
   */
  addExternalListener(fn: (channel: string, data: unknown) => void): void {
    this.externalListeners.push(fn)
  }

  /**
   * Auto-enable heartbeat for a task if a heartbeat.md file exists in the workspace.
   * Called after a task transitions to ready_for_review.
   */
  private autoEnableHeartbeat(taskId: string): void {
    try {
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      const heartbeatPath = join(workspaceDir, 'heartbeat.md')

      if (existsSync(heartbeatPath)) {
        const content = readFileSync(heartbeatPath, 'utf-8').trim()
        // Empty or headers-only files do not count.
        if (content && !/^(#[^\n]*\n?\s*)*$/.test(content)) {
          const defaultInterval = parseInt(this.db.getSetting('heartbeat_default_interval') || '30', 10)
          const now = new Date()
          const nextCheck = new Date(now.getTime() + defaultInterval * 60_000)

          this.updateTaskFromLocalAgent(taskId, {
            heartbeat_enabled: true,
            heartbeat_interval_minutes: defaultInterval,
            heartbeat_next_check_at: nextCheck.toISOString()
          })

          console.log(`[AgentManager] Auto-enabled heartbeat for task ${taskId} (found heartbeat.md)`)
        }
      }
    } catch (err) {
      console.error(`[AgentManager] Error auto-enabling heartbeat for task ${taskId}:`, err)
    }
  }

  /**
   * Write-through persistence for the durable transcript projection. Every
   * agent:output / agent:output-batch emission passes through here — the
   * single chokepoint where live streaming output is ingested. Upserts are
   * keyed by stable part id, so re-emitting a persisted part is a no-op.
   * Sessions that predate the store are seeded by backfillTranscriptProjection.
   */
  private persistTranscriptEvent(channel: string, data: unknown): void {
    const event = transcriptPartsFromEvent(channel, data)
    if (!event || event.parts.length === 0) return
    const result = this.db.upsertTranscriptParts(event.taskId, event.parts)
    if (!result) return
    const { maxRev, changedPartIds } = result
    // Event-sourced push: notify clients of the delta (the parts just written),
    // applied idempotently by part id on the client. This is BOTH the durable
    // update and the low-latency streaming path — a single authoritative source.
    if (changedPartIds.length > 0) {
      this.emitTranscriptChanged(event.taskId, maxRev - changedPartIds.length, maxRev)
    }
  }

  /**
   * Emit a transcript delta directly to clients (NOT via sendToRenderer — that
   * would recurse through persistTranscriptEvent). The renderer/mobile apply
   * these parts into their projection cache by id; order/dedup are guaranteed by
   * the cache being keyed on part id and sorted by created_at.
   */
  private emitTranscriptChanged(taskId: string, sinceRev: number, maxRev: number): void {
    const pending = this.pendingTranscriptChanged.get(taskId)
    this.pendingTranscriptChanged.set(taskId, {
      sinceRev: pending ? Math.min(pending.sinceRev, sinceRev) : sinceRev,
      maxRev: pending ? Math.max(pending.maxRev, maxRev) : maxRev
    })

    if (this.transcriptChangedTimer) return
    this.transcriptChangedTimer = setTimeout(() => {
      this.transcriptChangedTimer = null
      this.flushTranscriptChanged()
    }, AgentManager.TRANSCRIPT_CHANGED_FLUSH_MS)
  }

  private flushTranscriptChanged(): void {
    const pending = this.pendingTranscriptChanged
    this.pendingTranscriptChanged = new Map()
    for (const [taskId, { sinceRev, maxRev: queuedMaxRev }] of pending) {
      const { parts, maxRev } = this.db.getTranscriptDelta(taskId, sinceRev)
      const effectiveMaxRev = Math.max(maxRev, queuedMaxRev)
      if (parts.length === 0 && effectiveMaxRev <= sinceRev) continue
      this.sendTranscriptChangedNow(taskId, parts, effectiveMaxRev)
    }
  }

  private sendTranscriptChangedNow(taskId: string, parts: ReturnType<DatabaseManager['getTranscriptParts']>, maxRev: number): void {
    const payload = { taskId, parts, maxRev }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // The window gets display previews of oversized records (stored data is
      // unchanged); external listeners keep the full payload.
      let sent = false
      try {
        sent = guardedIpcSend(this.mainWindow.webContents, 'transcript:changed', {
          ...payload, parts: parts.map(part => transcriptDisplayPart(part))
        })
      } catch (err) {
        console.error('[AgentManager] Could not prepare transcript update for display:', err)
      }
      if (!sent) {
        // Keep the client cursor unchanged; the renderer reconciles via a delta read.
        guardedIpcSend(this.mainWindow.webContents, 'transcript:changed', {
          taskId, parts: [], maxRev: 0, reloadRequired: true
        })
      }
    }
    this.notifyExternalListeners('transcript:changed', payload)
    emitArtifactUpdatesFromParts(this.db, taskId, parts, (artifact) => this.sendArtifactUpdated(artifact))
  }

  private sendArtifactUpdated(artifact: Artifact): void {
    this.broadcast('artifact:updated', { taskId: artifact.taskId, artifact })
  }

  /** Sends to the main window and to external listeners (mobile API WebSocket). */
  private broadcast(channel: string, payload: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      guardedIpcSend(this.mainWindow.webContents, channel, payload)
    }
    this.notifyExternalListeners(channel, payload)
  }

  private notifyExternalListeners(channel: string, payload: unknown): void {
    for (const fn of this.externalListeners) {
      try { fn(channel, payload) } catch { /* one failing listener must not block the rest */ }
    }
  }

  private sendToRenderer(channel: string, data: unknown): void {
    // Durable transcript projection: persist every transcript part BEFORE any
    // client sees it. The main process owns the source of truth; renderer and
    // mobile hydrate from snapshots (transcript:get) instead of depending on
    // catching live events, so output produced while no view is bound
    // (background wake-ups, silently resumed sessions) is never lost.
    if (channel === 'agent:output' || channel === 'agent:output-batch') {
      try {
        this.persistTranscriptEvent(channel, data)
      } catch (err) {
        console.error('[AgentManager] Failed to persist transcript parts:', err)
      }
    }

    this.broadcast(channel, data)

    if (channel === 'agent:status' && data && typeof data === 'object') {
      const { sessionId, status, taskId } = data as { sessionId?: string; status?: string; taskId?: string }
      if (sessionId && status) {
        const prevStatus = this.lastSentStatus.get(sessionId)
        this.lastSentStatus.set(sessionId, status)
        notifyStatusTransition(this.db, () => this.mainWindow, prevStatus, status, taskId)
      }
    }
  }
}

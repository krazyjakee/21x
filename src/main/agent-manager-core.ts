import { TaskGroupRequestScope } from './agent-manager/task-group-request-scope'
import { serializeTaskSend } from './task-send-lock'
import { DEFAULT_SERVER_URL } from './adapters/opencode-server'
import type { AgentAttachmentExecution, AgentManagerHost, AgentWindow } from './agent-manager/host'
import { transcriptDisplayPart } from './transcript-display'
import { finishSessionFeedback, SessionFeedbackOwnershipChangedError, updateTaskFromUser } from './session-feedback'
import { buildAgentSwitchRecap, buildLostSessionRecap, buildTokenBudgetedRecap, INITIAL_PROMPT_PART_PREFIX, LOST_SESSION_NOTICE, taskContextBudget } from './agent-handoff'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import type { AgentRecord, DatabaseManager, TaskRecord } from './database/manager'
import type { UpdateAgentData } from './database/types'
import type { ProductionCredentialMutation } from '../shared/production-credential-mutation'
import { TaskStatus } from '../shared/constants'
import { isCoordinatorTask } from '../shared/task-roles'
import { resolveCaptainAgentId } from './captain-waker'
import { emitTaskEvent } from './project-events'
import { findBlockingSibling, isSuccessorGraphInProgress, successorsFireOnReview } from '../shared/subtask-graph'
import type { WorktreeManager } from './worktree-manager-core'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { ForgejoManager } from './forgejo-manager'
import type { AcpAdapter } from './adapters/acp-adapter'
import type { BackendModel, CodingAgentAdapter, SessionConfig, SessionMessage, SessionStatus as AdapterSessionStatus } from './adapters/coding-agent-adapter'
import { SessionStatusType, MessagePartType } from './adapters/coding-agent-adapter'
import { createHash, randomUUID } from 'crypto'
import type { Artifact } from '../shared/artifacts'
import { extractOutputFromMessages } from './output-extraction'
import { CodingAgentType, getAgentProvider } from './agent-manager/agent-types'
import { assembleSessionConfig, buildMcpServers, isTriageSessionTask, mcpOptionsForTask, type McpServerOptions } from './agent-manager/session-config-core'
import { getAdapterMcpAttachFailures, getMemoryFileName, writeSkillFiles } from './agent-manager/workspace-docs'
import { buildDisplayMessage, buildMessageWithAttachmentContext, syncAttachmentsToWorkspace, type MessageAttachmentRef } from './agent-manager/attachments'
import { emptySkillSyncResult, syncSkillsFromDirectory, type SkillSyncResult } from './agent-manager/skills-sync'
import { ARTIFACT_WORKSPACE_INSTRUCTIONS, HEARTBEAT_MONITORING_INSTRUCTIONS, buildSubtaskWakeMessage, buildTaskWorkPrompt, buildTillDoneNudge, buildTriagePrompt } from './agent-manager/prompts'
import { setupTaskWorktrees } from './agent-manager/worktree-setup'
import { listProjectRepos, taskProjectId } from './agent-manager/project-repos'
import { assistantTextKey, dedupStateFromHistory, hasMatchingErrorMessage, pruneDedup } from './agent-manager/output-dedup'
import { normalizeFallbackAgentIds } from './agent-manager/credit-exhaustion'
import { STUCK_SESSION_TIMEOUT_MS, findStuckTool, hasGarbledOutput, isDelegationTool, isWaitingForUserInput, type RunningTool } from './agent-manager/watchdogs'
import { MAX_CONCURRENT_AGENT_SESSIONS_SETTING, checkAdmission, isExemptFromAdmission, isGlobalAdmissionReason, parseGlobalSessionLimit, type AdmissionDecision, type AdmissionLimits, type AdmissionReason, type CountedSession } from './agent-manager/admission'
import { buildProjectLimitState, describeQueueReason, isAllProjectsPaused, projectAdmissionLimits, recordProjectSessionStart, setAllProjectsPaused, type ProjectLimitState } from './project-limits'
import { FINDINGS_BEGIN, FINDINGS_END, SYSTEM_MESSAGE_MARKER } from '../shared/system-authority'
import { ActivityObservations, isKnownActivityDisconnect, shouldPublishHeartbeat } from './agent-manager/activity-observations'
import type { AgentActivityOutcome } from '../shared/activity'
import { BranchDiffCache, ResourceMonitor, agentCap, autoLowerForPressure, findFileOverlap, projectAgentLevel, readProjectConcurrency, setConcurrencyLevel, setUserConcurrency, type LevelChangeResult, type OverlapCandidate } from './concurrency-control'
import { effectiveLevel, recommendLevel, type ProjectConcurrencyState, type ResourcePressure } from '../shared/concurrency'
import { collectMissedParts, debugTranscript, emitArtifactUpdatesFromParts, textTranscript, type DebugTranscriptMessage, notifyStatusTransition, transcriptPartsFromEvent, transcriptPartsFromMessages, type OutputMessage } from './agent-manager/transcript-events-core'
import { CaptainRuntimeStore } from './sessions/runtime-store'
import { DeliveryStore, type DeliveryRecord } from './sessions/delivery-store'
import { DurableStartQueueStore, type DurableQueuedStartInfo } from './sessions/start-queue-store'
import type { CaptainRuntimeState } from '../shared/captain-runtime'
import { classifyProviderFailure, PROVIDER_CONTINUATION, PROVIDER_MAX_RETRIES, type ProviderFailure } from './agent-manager/provider-failure'
import { ProviderRecoveryStore, type ProviderRecovery } from './sessions/provider-recovery-store'
import { CompactionNormalizer } from './sessions/compaction'
import { ManagedSessionObserver } from './sessions/managed-session'
import { AdapterEngine } from './sessions/adapter-engine'
import { isManagedTask } from './sessions/roles/task'
import { estimateTokens } from './sessions/token-estimator'
import { isManagedCaptain, isLostCaptainSession, type CaptainWakeDisposition } from './sessions/roles/captain'
import type { SessionObservation } from './sessions/event-inbox'
import { modelContextWindow } from './sessions/model-windows'
import { CaptainRollover, captainRolloverSeed } from './sessions/captain-rollover'
import type { HandoffRecord, HandoffTurn } from './sessions/handoff'

// Default OpenCode server URL (matches database default)

const DONE_TODO_STATUSES = ['completed', 'cancelled', 'done', 'removed']

/** An actual poll observation; it cannot carry a lifecycle outcome. */
export interface AgentActivityObservation {
  sessionId: string
  agentId: string
  taskId: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  epoch: string
  seq: number
  heartbeat: true
  disconnected?: true
}

/** Yields to the event loop between bursts of synchronous DB / FS calls so IPC
 *  and rendering are not starved (better-sqlite3 calls block the main thread). */
const yieldEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Settings key: the agent whose runtime made a coordinator row's persisted session. */
const coordinatorSessionAgentKey = (taskId: string): string => `captain_session_agent:${taskId}`

/**
 * Explicit upper bounds for server, session and whole-start readiness. Worktree
 * preparation is included in the whole-start envelope so no renderer can be
 * left in "starting" forever.
 */
export const CAPTAIN_START_TIMEOUT_MS = 90_000
export const AGENT_START_TIMEOUT_MS = 120_000
export const AGENT_SERVER_START_TIMEOUT_MS = 30_000
export const AGENT_SESSION_START_TIMEOUT_MS = 60_000
export const AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS = 1000
const DELIVERY_CLAIM_MS = 60_000

/** A host must keep its DB/provider/profile lease until exit on this failure. */
export class AgentShutdownIncompleteError extends Error {
  readonly code = 'AGENT_SHUTDOWN_INCOMPLETE'
  constructor() { super('Agent lifecycle teardown did not finish before its shutdown deadline') }
}

/** A deadline whose late completion is fenced from the winning generation. */
export function withStartupDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onLate?: (value: T) => void | Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      const duration = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)} seconds`
      reject(new Error(`${label} timed out after ${duration}`))
    }, timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        if (!expired) resolve(value)
        else void onLate?.(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        if (!expired) reject(error)
      }
    )
  })
}

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
  /** Recap of a lost predecessor session, prepended (adapter-side only) to the next prompt sent. */
  pendingRecap?: string
  pendingLossId?: string
  managedCaptain?: boolean
  managedTask?: boolean
  managedIntentId?: string
  configuredModel?: string
  configuredAgent?: AgentRecord
  pendingHandoffSeedId?: string
}

interface AgentFallbackState {
  remainingAgentIds: string[]
  attemptedAgentIds: Set<string>
}

interface PendingTaskStop {
  sessionId: string
  session: AgentSession
  promise: Promise<void>
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

/** Trusted internal bounded readers for desktop projections. Never an RPC
 * parameter; the actual manager retains live sessions, queue and scheduling. */
export type ProjectRuntimeReadStore = Pick<DatabaseManager, 'getTask' | 'getTasks' | 'getSubtasks' | 'getProject' | 'getAgent' | 'getSetting' | 'setSetting' | 'listConcurrencyAudit'>
export type ProjectRuntimeMutationStore = Parameters<typeof setUserConcurrency>[0]

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  /** Maps old (temp) session IDs to their re-keyed (real) IDs so that
   *  stale IDs from the renderer still resolve after pollSingleSession re-keys. */
  private sessionIdRedirects: Map<string, string> = new Map()
  private db: DatabaseManager
  private mainWindow: AgentWindow | null = null
  private adapters: Map<string, CodingAgentAdapter> = new Map()
  private worktreeManager: WorktreeManager | null = null
  private githubManager: GitHubManager | null = null
  private gitlabManager: GitLabManager | null = null
  private forgejoManager: ForgejoManager | null = null
  private oauthManager: import('./oauth/oauth-manager-core').OAuthManager | null = null
  private externalListeners: Array<(channel: string, data: unknown) => void> = []
  private readonly activityListeners = new Set<(event: Readonly<AgentActivityObservation>) => void>()
  private readonly captainRuntimes: CaptainRuntimeStore
  private readonly captainEngine: AdapterEngine | null
  private readonly taskEngine: AdapterEngine | null
  private readonly captainRollover: CaptainRollover | null
  private readonly providerRecoveries: ProviderRecoveryStore
  private providerRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly providerRecoveryFlights = new Set<string>()
  private readonly deliveries: DeliveryStore
  private readonly deliveryFlights = new Map<string, Promise<{ newSessionId?: string }>>()
  /** Durable sends to one task reserve and activate authorization in outbox order. */
  private readonly deliveryTaskTails = new Map<string, Promise<void>>()
  /** A Stop owns its exact session generation before teardown awaits anything. */
  private readonly stoppingSessions = new WeakSet<AgentSession>()
  /** Task-addressable ownership retained until the backend acknowledges Stop.
   * The existing durable start row remains `started` for the same generation;
   * this index lets every in-process ownership consumer join that teardown. */
  private readonly taskStops = new Map<string, PendingTaskStop>()
  private readonly taskGroupMutations = new Set<string>()
  private readonly taskLifecycleMutations = new Set<string>()
  private readonly scopedApprovalFlights = new Set<string>()
  private deliveryRecoveryTimer: ReturnType<typeof setInterval> | null = null
  private readonly captainSwitches = new Map<string, { agentId: string; promise: Promise<CaptainRuntimeState> }>()
  private readonly deliveryOwner = `agent-manager:${process.pid}:${randomUUID()}`

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
  private reaperSweep: Promise<void> | null = null

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
  /** Epoch/sequence stamps and heartbeat rate limits for agent:status (#95). */
  private readonly activityObservations = new ActivityObservations()
  private readonly compactions = new CompactionNormalizer()
  private readonly compactionObserver: ManagedSessionObserver | null

  // ── Admission control (see agent-manager/admission.ts) ──
  /** Starts waiting for a free slot, one per task, priority-ordered per project (#150). */
  private startQueue: DurableStartQueueStore
  /** Unique to this main-process lifetime; persisted claims from any other
   * owner are interrupted work and are reconciled before schedulers start. */
  private readonly startQueueLeaseOwner = randomUUID()
  /** #150: the branch diff of running tasks, for file-overlap serialisation. */
  private branchDiffs = new BranchDiffCache()
  /** #150: free memory and CPU; confirmed pressure lowers Captain-controlled levels. */
  private resourceMonitor = new ResourceMonitor({
    onPressure: (pressure) => this.lowerLevelsForPressure(pressure)
  })
  /** taskId → agentId of admitted starts whose session is not registered yet.
   *  They hold their slot so concurrent requests cannot all slip past. */
  private admittedStarts: Map<string, string> = new Map()
  /** In-flight admitted starts, so a durable message accepted during warm-up
   * joins that start instead of opening a competing Captain session. */
  private sessionStarts: Map<string, Promise<string>> = new Map()
  private workspaceCleanupExclusion = false
  private readonly workspaceProcessWork = new Set<Promise<unknown>>()
  /** Actual task startup/cleanup receipts outlive bounded public deadlines. */
  private readonly rawTaskStarts = new Map<string, Set<Promise<unknown>>>()
  /** Raw flights stay owned even when their caller's startup deadline expires. */
  private readonly shutdownWork = new Set<Promise<unknown>>()
  private readonly taskGroupRequests = new TaskGroupRequestScope()
  private readonly scopedCleanupFailures = new Set<string>()
  private readonly scopedCleanupConflicts = new Set<string>()
  private readonly scopedRetirementConfigs = new WeakMap<AgentSession, SessionConfig>()
  private readonly agentConfigurationMutations = new Set<string>()
  private readonly backendConfigurationMutations = new Set<string>()
  private readonly failedBackendConfigurations = new Set<string>()
  private productionCredentialMutation = false
  private productionAdmissionMutation = false
  private sessionStops: Map<string, Promise<void>> = new Map()
  private startupReconciliation: Promise<void> | null = null
  private startQueueDrainScheduled = false
  private startQueueRetryTimer: ReturnType<typeof setTimeout> | null = null
  private shuttingDown = false
  private readonly attachmentExecution: AgentAttachmentExecution | undefined
  /** `projectId:reason` pairs the project's Captain has been told about (#65),
   *  cleared when one of the project's queued starts runs. */
  private projectLimitNotices: Set<string> = new Set()

  constructor(db: DatabaseManager, private readonly host: AgentManagerHost) {
    super()
    if (!host?.renderer || !host.notifications || !host.energy || !host.secrets || !host.managedTaskMcp || typeof host.createAdapter !== 'function' || typeof host.isCodexAppServerAdapter !== 'function') {
      throw new Error('Explicit agent manager host services are required')
    }
    this.db = db
    this.attachmentExecution = host.attachmentExecution
    this.compactionObserver = db.db && typeof db.db.prepare === 'function' ? new ManagedSessionObserver(db.db) : null
    this.taskEngine = db.db && typeof db.db.prepare === 'function' ? new AdapterEngine(db.db, undefined, 'task') : null
    this.captainEngine = db.db && typeof db.db.prepare === 'function' ? new AdapterEngine(db.db) : null
    this.captainRollover = db.db && typeof db.db.prepare === 'function' ? new CaptainRollover(db, host.captainSummaryProvider?.bind(host)) : null
    this.captainRuntimes = new CaptainRuntimeStore(db)
    this.deliveries = new DeliveryStore(db)
    this.providerRecoveries = new ProviderRecoveryStore(db)
    this.startQueue = new DurableStartQueueStore(db)
    this.startIdleSessionReaper()
    this.resourceMonitor.start(30_000, () => {
      this.refreshBranchDiffs()
      this.reconcileRuntimeDivergence()
    })
  }

  getCaptainRuntime(projectId: string): CaptainRuntimeState | null {
    return this.captainRuntimes.getByProject(projectId)
  }

  private managesCaptain(taskId: string): boolean {
    return !this.shuttingDown && isManagedCaptain(this.db.getTask(taskId), this.captainEngine?.enabled ?? false)
  }

  private managesTask(taskId: string): boolean {
    return !this.shuttingDown && isManagedTask(taskId, this.db.getTask(taskId), this.taskEngine?.enabled ?? false)
  }

  private managedEngine(session: AgentSession | undefined): AdapterEngine | null {
    return session?.managedCaptain ? this.captainEngine : session?.managedTask ? this.taskEngine : null
  }

  private taskRecap(taskId: string, model: string | undefined, lost: boolean, reservedTokens = 0): string {
    const parts = this.db.getTranscriptParts(taskId)
    if (!this.managesTask(taskId)) return lost ? buildLostSessionRecap(parts) : buildAgentSwitchRecap(parts)
    const result = buildTokenBudgetedRecap(parts, { model: model ?? '', kind: lost ? 'lost' : 'switch', reservedTokens })
    const backendId = this.db.getTask(taskId)?.session_id ?? undefined
    const identity = createHash('sha256').update(JSON.stringify([backendId, model, lost, result])).digest('hex')
    this.retainCaptainObservation(this.taskEngine!.observe(taskId, backendId,
      'recap_prepared', `task:${taskId}:recap:${identity}`, { ...result, text: undefined, source: 'estimated', losslessSource: 'transcript_parts' }))
    return result.text
  }

  private taskHandoffReservedTokens(taskId: string): number {
    return estimateTokens((buildTaskWorkPrompt(this.db, taskId, this.db.getTask(taskId)) + HEARTBEAT_MONITORING_INSTRUCTIONS).length + 1024)
  }

  private retainCaptainObservation(observation: Promise<void>): void {
    this.ownShutdownWork(observation.catch((error) => console.error('[AgentManager] Adapter managed observation failed:', error)))
  }

  /** The waker's stable identity is also the durable delivery identity. The
   * inbox is evidence; DeliveryStore retains sole acceptance/retry ownership. */
  async deliverCaptainWake(sessionId: string, message: string, taskId: string, agentId: string, identity: string, count: number): Promise<{ newSessionId?: string }> {
    if (!this.managesCaptain(taskId)) return this.sendMessage(sessionId, message, taskId, agentId)
    const originalBackend = this.db.getTask(taskId)?.session_id ?? undefined
    // Commit receipt and its delivery intent together before yielding. A
    // crash here leaves a pending outbox effect, never an acknowledged wake
    // whose requested send was only in memory.
    const received = this.db.db.transaction(() => {
      const observation = this.captainEngine!.recordWake(taskId, originalBackend, identity, message)
      const record = this.deliveries.enqueue({ idempotencyKey: identity, kind: 'agent_message', taskId, agentId,
        payload: JSON.stringify({ sessionId, message, taskId, agentId, attachments: [] }) }).record
      return { observation, record }
    })()
    await received.observation
    if (this.shuttingDown) throw new Error('Captain wake was cancelled before delivery.')
    const recovery = this.startQueue.get(taskId)
    const provider = this.providerRecoveries.get(taskId)
    if (this.taskStops.has(taskId) || this.retryExclusion(this.db.getTask(taskId)) || recovery?.state === 'cancelled' || provider?.state === 'failed' || provider?.state === 'cancelled') {
      if (this.deliveries.get(received.record.id)?.state === 'pending') this.deliveries.terminal(received.record.id, 'cancelled', 'Automatic Captain wake excluded by stop, approval or side-effect recovery controls.')
      await this.captainEngine!.recordWakeDisposition(taskId, originalBackend, identity, 'excluded', count)
      return {}
    }
    try {
      const result = await this.sendMessage(sessionId, message, taskId, agentId, undefined, identity)
      await this.captainEngine!.recordWakeDisposition(taskId, this.db.getTask(taskId)?.session_id ?? undefined, identity, 'delivered', count)
      return result
    } catch (error) {
      if (!this.shuttingDown) await this.captainEngine!.recordWakeDisposition(taskId, originalBackend, identity, 'failed', count)
      throw error
    }
  }

  async recordDroppedCaptainWake(taskId: string, identity: string, disposition: CaptainWakeDisposition, count: number): Promise<void> {
    if (this.managesCaptain(taskId)) await this.captainEngine!.recordWakeDisposition(taskId,
      this.db.getTask(taskId)?.session_id ?? undefined, identity, disposition, count)
  }

  /** True when stopping/moving a task must first withdraw runtime ownership. */
  hasTaskStartOwnership(taskId: string): boolean {
    if (this.taskStops.has(taskId) || this.sessionStarts.has(taskId) || this.admittedStarts.has(taskId) || this.rawTaskStarts.has(taskId)) return true
    const live = this.findSessionByTaskId(taskId)
    if (live && live.session.status !== 'error') return true
    const recovery = this.startQueue.get(taskId)
    return recovery !== null && ['queued', 'retrying', 'claimed', 'starting'].includes(recovery.state)
  }

  /**
   * Repair one manufactured execution status without waiting for a restart.
   * The durable queue remains the sole admission owner; this method only
   * restores the same row/start path used by normal starts and boot recovery.
   */
  reconcileTaskRuntime(taskId: string, cause = 'status_runtime_divergence'): boolean {
    taskId = this.taskGroupExecution(taskId)?.id ?? taskId
    const task = this.db.getTask(taskId)
    if (!task || (task.status !== TaskStatus.AgentWorking && task.status !== TaskStatus.Triaging)) return false
    if (this.taskStops.has(taskId) || this.sessionStarts.has(taskId) || this.admittedStarts.has(taskId) || this.rawTaskStarts.has(taskId)) return false

    const live = this.findSessionByTaskId(taskId)
    if (live && live.session.status !== 'error') {
      if (task.status === TaskStatus.AgentWorking && live.session.status === 'idle') {
        this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.ReadyForReview, session_id: live.sessionId })
        this.startQueue.markRecovered(taskId, live.sessionId, 'live_session_present', 'idle_session_moved_to_review')
        this.recordRecoveryAudit(task, cause, 'reclaim', 'idle_session_moved_to_review')
        this.sendToRenderer('task:updated', {
          taskId,
          updates: { status: TaskStatus.ReadyForReview, session_id: live.sessionId }
        })
        return true
      }
      return false
    }

    const existing = this.startQueue.get(taskId)
    if (existing && ['queued', 'retrying', 'claimed', 'starting'].includes(existing.state)) return false

    this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.NotStarted, session_id: null })
    this.sendToRenderer('task:updated', {
      taskId,
      updates: { status: TaskStatus.NotStarted, session_id: null }
    })

    // A terminal safety decision is not silently reset by a cosmetic status
    // write. Explicit user continuation remains the only way past it.
    if (existing?.state === 'failed' || existing?.state === 'cancelled') {
      this.recordRecoveryAudit(task, cause, 'rollback_status', `preserved_${existing.state}_recovery`)
      return true
    }

    if (task.status === TaskStatus.Triaging) {
      this.recordRecoveryAudit(task, cause, 'rollback_status', 'orphaned_triage_reset')
      this.emitSystemError('', taskId, `triage-divergence-${Date.now()}`, 'A triage status had no live session and was reset. Start triage again to continue.')
      return true
    }

    if (!task.agent_id) {
      this.startQueue.enqueue({
        taskId,
        projectId: taskProjectId(task),
        agentId: 'unassigned',
        reason: 'agent_unavailable',
        queuedAt: new Date().toISOString(),
        priority: task.priority
      })
      this.startQueue.fail(taskId, 'agent_missing', 'visible_terminal_failure', 'The task has no assigned agent.')
      this.recordRecoveryAudit(task, 'agent_missing', 'terminal_failure', 'visible_terminal_failure', 'Assign an agent before retrying.')
      this.emitStartQueueChanged()
      return true
    }

    const exclusion = this.retryExclusion(task)
    const queued = this.startQueue.enqueue({
      taskId,
      projectId: taskProjectId(task),
      agentId: task.agent_id,
      reason: 'recovery',
      queuedAt: new Date().toISOString(),
      priority: task.priority,
      dependencyReason: this.isSerialChainStart(taskId) ? 'predecessor_active' : null
    })
    if (exclusion) {
      this.startQueue.cancel(taskId, exclusion, 'excluded_orphan_not_retried')
      this.recordRecoveryAudit(task, exclusion, 'exclude_from_retry', 'excluded_orphan_not_retried')
    } else {
      this.recordRecoveryAudit(task, cause, 'requeue', `queued_at_position_${queued.position}`)
    }
    this.emitStartQueueChanged()
    this.scheduleStartQueueDrain()
    return true
  }

  /** Periodic defense for source/legacy writes that bypass command routes. */
  private reconcileRuntimeDivergence(): void {
    if (this.shuttingDown || this.startupReconciliation) return
    const rows = this.db.db.prepare(`
      SELECT id FROM tasks
      WHERE (role = 'task' AND group_id IS NULL OR role = 'task_group') AND status IN (?, ?)
    `).all(TaskStatus.AgentWorking, TaskStatus.Triaging) as Array<{ id: string }>
    for (const row of rows) this.reconcileTaskRuntime(row.id, 'periodic_runtime_reconciliation')
  }

  /** Repairs process-owned state after a crash before schedulers accept work. */
  async reconcileStartup(): Promise<void> {
    if (this.startupReconciliation) return this.startupReconciliation
    // Install the barrier before any adapter work can yield or emit idle.
    const reconciliation = Promise.resolve().then(() => this.reconcileStartupNow())
    this.startupReconciliation = reconciliation
    try {
      await reconciliation
    } finally {
      this.startupReconciliation = null
      this.scheduleProviderRecovery()
      this.scheduleStartQueueDrain()
    }
  }

  private async reconcileStartupNow(): Promise<void> {
    if (!this.shuttingDown) await this.compactionObserver?.reconcileStartup(true)
    if (!this.shuttingDown) await this.captainEngine?.reconcileStartup()
    if (!this.shuttingDown) await this.taskEngine?.reconcileStartup()
    if (this.shuttingDown) return
    // A crash while a wire send was in flight cannot prove rejection. A saved
    // backoff is different: its failed turn/rejection was already confirmed.
    for (const row of this.providerRecoveries.list(['sending', 'dispatching'])) {
      if (row.state === 'sending' || row.state === 'dispatching') {
        this.failProviderRecovery(row, 'The app restarted during provider delivery; acceptance is unknown. Inspect tool outcomes before continuing.')
      }
    }
    const inventory = {
      projects: this.db.getProjects().length,
      tasks: this.db.getTasks().length,
      agents: this.db.getAgents().length,
      sessions: this.sessions.size,
      queued: this.startQueue.active().length
    }
    console.log('[AgentManager] Recovery inventory:', inventory)

    // A process-scoped lease can never be valid in a different process. Move
    // every interrupted claim back to the same durable row before examining
    // task/session ownership. A reconnect below may then acknowledge it as
    // recovered instead of dispatching a second start.
    for (const claim of this.startQueue.interruptedClaims(this.startQueueLeaseOwner)) {
      if (this.sessionStarts.has(claim.taskId) || this.rawTaskStarts.has(claim.taskId)) continue
      const task = this.db.getTask(claim.taskId)
      if (task?.status === TaskStatus.Triaging) {
        // Triage can change assignment while it runs. Never replay a crashed
        // triage claim as an ordinary run under the newly selected agent.
        this.startQueue.fail(task.id, 'orphaned_triage', 'visible_terminal_failure', 'Triage was interrupted; explicitly continue to retry.')
        this.updateTaskFromLocalAgent(task.id, { status: TaskStatus.NotStarted, session_id: null })
        this.recordRecoveryAudit(task, 'orphaned_triage', 'terminal_failure', 'visible_terminal_failure')
        continue
      }
      const requeued = this.startQueue.requeueInterrupted(claim, claim.state === 'claimed' ? 'crash_after_claim' : 'crash_after_start')
      if (requeued && task) {
        this.recordRecoveryAudit(task, requeued.recoveryCause ?? 'interrupted_claim', 'retry', requeued.recoveryResult ?? 'requeued_after_restart')
      }
    }

    // No startup from the previous process can still own its persisted lease.
    const expired = this.captainRuntimes.expireStale(Date.now(), true)
    for (const state of expired) {
      if (!state.lastGoodAgentId) continue
      const candidateAgentId = state.candidateAgentId ?? state.agentId
      const staleDetail = state.errorDetail ?? 'A stale Captain start timed out and was rolled back.'
      this.db.updateProject(state.projectId, { captain_agent_id: state.lastGoodAgentId })
      this.captainRuntimes.transition(state.ownerId, state.generation, 'rolled_back', {
        agentId: state.lastGoodAgentId,
        candidateAgentId,
        deadlineAt: null,
        probeOk: false
      })
      this.emitSystemError('', state.ownerId, `startup-recovery-${state.generation}`, staleDetail)
      // Restoring a selection is not enough: verify (or recreate) the old
      // runtime before startup reconciliation declares the app usable. Keep
      // the rolled-back phase/cause visible even when that recovery succeeds.
      try {
        const recovered = await this.requestSession(state.lastGoodAgentId, state.ownerId, undefined, true)
        if (recovered.status !== 'started') throw new Error(`Recovery was queued at position ${recovered.position}.`)
        const latest = this.captainRuntimes.get(state.ownerId)
        if (latest) {
          this.captainRuntimes.transition(state.ownerId, latest.generation, 'rolled_back', {
            agentId: state.lastGoodAgentId,
            candidateAgentId,
            lastGoodAgentId: state.lastGoodAgentId,
            sessionId: recovered.sessionId,
            deadlineAt: null,
            lastProbeAt: Date.now(),
            probeOk: true,
            errorCode: 'STARTUP_TIMEOUT',
            errorDetail: staleDetail
          })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const latest = this.captainRuntimes.get(state.ownerId)
        if (latest) {
          this.captainRuntimes.transition(state.ownerId, latest.generation, 'failed', {
            deadlineAt: null,
            lastProbeAt: Date.now(),
            probeOk: false,
            errorCode: 'ROLLBACK_RECOVERY_FAILED',
            errorDetail: `The stale candidate was rolled back, but the last-known-good Captain could not be recovered: ${detail}`
          })
        }
      }
    }

    for (const state of this.captainRuntimes.list()) {
      if (state.phase !== 'healthy' && state.phase !== 'recovering') continue
      if (this.providerRecoveryOwnsTask(state.ownerId)) continue
      this.captainRuntimes.transition(state.ownerId, state.generation, 'recovering', {
        deadlineAt: Date.now() + CAPTAIN_START_TIMEOUT_MS,
        probeOk: null
      })
      try {
        await this.requestSession(state.agentId, state.ownerId, undefined, true)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.captainRuntimes.transition(state.ownerId, state.generation, 'failed', {
          deadlineAt: null,
          probeOk: false,
          errorCode: 'RECOVERY_FAILED',
          errorDetail: detail
        })
        this.emitSystemError('', state.ownerId, `startup-recovery-failed-${state.generation}`, `Captain recovery failed: ${detail}. Retry from the Captain panel.`)
      }
    }

    const staleTasks = this.db.db.prepare(`
      SELECT id, agent_id, session_id FROM tasks
      WHERE (role = 'task' AND group_id IS NULL OR role = 'task_group') AND (status = ? OR (status != 'completed' AND session_id IS NOT NULL
        AND id IN (SELECT task_id FROM agent_start_queue WHERE state IN ('queued', 'retrying', 'claimed', 'starting'))))
    `).all(TaskStatus.AgentWorking) as Array<{ id: string; agent_id: string | null; session_id: string | null }>
    for (const stale of staleTasks) {
      const task = this.db.getTask(stale.id)
      if (!task) continue
      if (this.sessionStarts.has(stale.id) || this.rawTaskStarts.has(stale.id) || this.providerRecoveryOwnsTask(stale.id)) continue
      const liveOwner = this.findSessionByTaskId(stale.id)
      if (liveOwner && liveOwner.session.status !== 'error') {
        this.updateTaskFromLocalAgent(stale.id, { session_id: liveOwner.sessionId })
        this.startQueue.markRecovered(stale.id, liveOwner.sessionId, 'live_session_present')
        continue
      }
      const previousRecovery = this.startQueue.get(stale.id)
      if (previousRecovery?.state === 'failed' || previousRecovery?.state === 'cancelled') {
        this.updateTaskFromLocalAgent(stale.id, { status: TaskStatus.NotStarted, session_id: null }, 'system')
        continue
      }
      if (!stale.agent_id) {
        this.updateTaskFromLocalAgent(stale.id, { status: TaskStatus.NotStarted, session_id: null }, 'system')
        this.startQueue.enqueue({
          taskId: stale.id,
          projectId: taskProjectId(task),
          agentId: 'unassigned',
          reason: 'agent_unavailable',
          queuedAt: new Date().toISOString(),
          priority: task.priority
        })
        this.startQueue.fail(stale.id, 'agent_missing', 'visible_terminal_failure', 'The task has no assigned agent.')
        this.recordRecoveryAudit(task, 'agent_missing', 'terminal_failure', 'visible_terminal_failure', 'Assign an agent before retrying.')
        this.emitSystemError('', stale.id, `stale-task-${Date.now()}`, 'Recovery stopped because the task has no assigned agent. Assign one before retrying.')
        continue
      }
      if (!stale.session_id) {
        this.updateTaskFromLocalAgent(stale.id, { status: TaskStatus.NotStarted, session_id: null }, 'system')
        const exclusion = this.retryExclusion(task)
        const queued = this.startQueue.enqueue({
          taskId: stale.id,
          projectId: taskProjectId(task),
          agentId: stale.agent_id,
          reason: 'recovery',
          queuedAt: new Date().toISOString(),
          priority: task.priority,
          dependencyReason: this.isSerialChainStart(stale.id) ? 'predecessor_active' : null
        })
        if (exclusion) {
          this.startQueue.cancel(stale.id, exclusion, 'excluded_orphan_not_retried')
          this.recordRecoveryAudit(task, exclusion, 'exclude_from_retry', 'excluded_orphan_not_retried')
        } else {
          this.recordRecoveryAudit(task, 'missing_session_ownership', 'requeue', `queued_at_position_${queued.position}`)
        }
        this.emitSystemNotice('', stale.id, `stale-task-${Date.now()}`, exclusion
          ? `Recovery did not retry this task because it is ${exclusion.replace(/_/g, ' ')}.`
          : 'The app restarted before session ownership was confirmed. The task was safely requeued and will restart automatically.')
        continue
      }
      try {
        const sessionId = await withStartupDeadline(
          this.resumeSession(stale.agent_id, stale.id, stale.session_id),
          AGENT_START_TIMEOUT_MS,
          'Stale session recovery'
        )
        const currentTask = this.db.getTask(stale.id)
        const currentRecovery = this.startQueue.get(stale.id)
        if (!currentTask || currentTask.status === TaskStatus.Completed
          || currentRecovery?.state === 'cancelled' || currentRecovery?.state === 'failed') {
          if (sessionId) await this.stopSession(sessionId, false)
          continue
        }
        const status = sessionId ? this.getSessionStatus(sessionId)?.status : undefined
        if (!sessionId || status === 'error') throw new Error('The saved backend session is not ready.')
        const queueBefore = this.startQueue.info(stale.id)
        const queueRecovered = this.startQueue.markRecovered(stale.id, sessionId, 'restart_live_reconnect')
        if (queueRecovered || queueBefore?.state !== 'recovered') {
          this.recordRecoveryAudit(task, 'restart_live_reconnect', 'reclaim', 'live_session_reclaimed')
        }
        if (status === 'idle') {
          this.updateTaskFromLocalAgent(stale.id, { status: TaskStatus.ReadyForReview })
          this.emitSystemNotice(sessionId, stale.id, `recovered-idle-${Date.now()}`, 'The app restarted while this task was marked running. Its session was recovered idle and moved to review; send a message to continue.')
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const currentTask = this.db.getTask(stale.id)
        const currentRecovery = this.startQueue.get(stale.id)
        if (!currentTask || currentTask.status === TaskStatus.Completed
          || currentRecovery?.state === 'cancelled' || currentRecovery?.state === 'failed'
          || (currentTask.session_id && currentTask.session_id !== stale.session_id)) continue
        this.updateTaskFromLocalAgent(stale.id, { status: TaskStatus.NotStarted, session_id: null }, 'system')
        const exclusion = this.retryExclusion(currentTask)
        const queued = this.startQueue.enqueue({
          taskId: stale.id,
          projectId: taskProjectId(task),
          agentId: stale.agent_id,
          reason: 'recovery',
          queuedAt: new Date().toISOString(),
          priority: task.priority,
          dependencyReason: this.isSerialChainStart(stale.id) ? 'predecessor_active' : null
        })
        if (exclusion) {
          this.startQueue.cancel(stale.id, exclusion, 'excluded_reconnect_failure_not_retried', detail)
          this.recordRecoveryAudit(task, exclusion, 'exclude_from_retry', 'excluded_reconnect_failure_not_retried', detail)
        } else {
          this.recordRecoveryAudit(task, 'backend_session_unavailable', 'requeue', `queued_at_position_${queued.position}`, detail)
        }
        this.emitSystemError('', stale.id, `stale-task-failed-${Date.now()}`, exclusion
          ? `The previous run could not be reclaimed and was not retried because it is ${exclusion.replace(/_/g, ' ')}: ${detail}`
          : `The previous run could not be reclaimed: ${detail}. It was safely requeued with bounded retry.`)
      }
    }

    if (!this.deliveryRecoveryTimer) {
      this.deliveryRecoveryTimer = setInterval(() => {
        void this.recoverAgentMessages().catch((error) => console.warn('[Delivery] Recovery failed:', error))
      }, 30_000)
      this.deliveryRecoveryTimer.unref?.()
    }
    await this.recoverAgentMessages()
    this.emitStartQueueChanged()
    this.scheduleStartQueueDrain()
  }

  private async recoverAgentMessages(): Promise<void> {
    for (const record of this.deliveries.listRecoverable('agent_message')) {
      // A heartbeat observes one captured task/instruction generation. Recovery
      // can acknowledge an accepted delivery but cannot create a new check from
      // an abandoned intent after its scheduler/request lifetime ended.
      if (record.state !== 'accepted' && !this.deliveryFlights.has(record.id) && record.taskId) {
        let heartbeat = false
        try { heartbeat = JSON.parse(record.payload).taskId === `heartbeat-${record.taskId}` } catch { /* normal malformed-delivery handling below */ }
        if (heartbeat) { this.deliveries.terminal(record.id, 'cancelled', 'Heartbeat checks are not replayed; run a new check against current instructions.'); continue }
      }
      const task = record.taskId ? this.db.getTask(record.taskId) : undefined
      const recovery = record.taskId ? this.startQueue.get(record.taskId) : null
      const exclusion = record.state === 'accepted' ? null
        : recovery?.state === 'cancelled' || recovery?.state === 'failed'
          ? recovery.recoveryCause ?? 'terminal_recovery'
          : record.taskId ? this.retryExclusion(task) : null
      if (exclusion) {
        this.deliveries.terminal(record.id, 'cancelled', `Recovery excluded delivery: ${exclusion}`)
        if (task) this.recordRecoveryAudit(task, exclusion, 'exclude_from_retry', 'outbox_delivery_not_replayed')
        continue
      }
      try {
        await this.dispatchAgentMessage(record)
      } catch (error) {
        console.warn(`[AgentManager] Deferred delivery ${record.id} remains pending:`, error)
      }
    }
  }

  private captainProject(task: TaskRecord | null | undefined): { id: string; captain_agent_id: string | null } | null {
    if (!isCoordinatorTask(task) || !task?.project_id) return null
    const project = this.db.getProject(task.project_id)
    return project ? { id: project.id, captain_agent_id: project.captain_agent_id } : null
  }

  private beginCaptainRuntime(task: TaskRecord | null | undefined, agentId: string, retry = false): CaptainRuntimeState | null {
    const project = this.captainProject(task)
    if (!project || !task) return null
    const previous = this.captainRuntimes.get(task.id)
    if (
      previous?.agentId === agentId
      && ['starting_server', 'starting_session', 'verifying', 'retrying', 'recovering'].includes(previous.phase)
      && (previous.deadlineAt ?? 0) > Date.now()
    ) return previous
    return this.captainRuntimes.begin({
      ownerId: task.id,
      projectId: project.id,
      agentId,
      lastGoodAgentId: previous?.lastGoodAgentId ?? project.captain_agent_id,
      deadlineAt: Date.now() + CAPTAIN_START_TIMEOUT_MS,
      retry
    })
  }

  private transitionCaptainRuntime(
    taskId: string,
    phase: Parameters<CaptainRuntimeStore['transition']>[2],
    patch?: Parameters<CaptainRuntimeStore['transition']>[3],
    generation?: number
  ): CaptainRuntimeState | null {
    if (!isCoordinatorTask(this.db.getTask(taskId))) return null
    const current = this.captainRuntimes.get(taskId)
    if (!current || (generation !== undefined && (current.generation !== generation
      || ['failed', 'timed_out', 'rolled_back'].includes(current.phase)))) return null
    return this.captainRuntimes.transition(taskId, current.generation, phase, patch)
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
    if (this.host.energy.kind !== 'native') return
    try {
      const hasLiveRuntime = this.sessions.size > 0
      if (hasLiveRuntime && this.powerSaveBlockerId === null) {
        this.powerSaveBlockerId = this.host.energy.start()
        console.log('[AgentManager] App-suspension inhibition requested (agent session runtime alive)')
      } else if (!hasLiveRuntime && this.powerSaveBlockerId !== null) {
        this.host.energy.stop(this.powerSaveBlockerId)
        this.powerSaveBlockerId = null
        console.log('[AgentManager] App-suspension inhibition release requested (no live session runtimes)')
      }
    } catch (err) {
      console.error('[AgentManager] Failed to update app-suspension blocker:', err)
    }
  }

  /** Schedule a blocker update once the current mutation of the sessions map
   *  has fully settled. */
  private schedulePowerSaveBlockerUpdate(): void {
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.schedulePowerSaveBlockerUpdate())
    setImmediate(() => this.updatePowerSaveBlocker())
  }

  private reapInactiveSessions(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve()
    if (this.reaperSweep) return this.reaperSweep
    const sweep = this.ownShutdownWork(this.reapInactiveSessionsNow())
    this.reaperSweep = sweep
    const settled = (): void => { if (this.reaperSweep === sweep) this.reaperSweep = null }
    void sweep.then(settled, settled)
    return sweep
  }

  private async reapInactiveSessionsNow(): Promise<void> {
    // Safety net for limits raised in settings or the agent form: nothing
    // else signals those, so re-check the queue on every sweep.
    this.scheduleStartQueueDrain()
    const now = Date.now()
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      if (this.shuttingDown) return
      // Only idle sessions are candidates — an active turn is never reaped.
      if (session.status !== 'idle') continue

      const idleForMs = now - (session.lastActivityAt ?? session.createdAt.getTime())
      if (idleForMs < AgentManager.IDLE_SESSION_REAP_THRESHOLD_MS) continue

      const task = this.db.getTask(session.taskId)
      // Pseudo-tasks (heartbeat-*) have no DB row — leave them alone. The
      // Captain has one, so it is released like any task and resumed by
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
      if (this.shuttingDown) return
      if (!this.ownsSessionGeneration(sessionId, session) || session.status !== 'idle' ||
          Date.now() - (session.lastActivityAt ?? session.createdAt.getTime()) < AgentManager.IDLE_SESSION_REAP_THRESHOLD_MS) continue
      if (this.hasActiveSubtaskWork(session.taskId)) continue

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

  setMainWindow(window: AgentWindow): void {
    this.mainWindow = window
  }

  setManagers(githubManager: GitHubManager, worktreeManager: WorktreeManager, gitlabManager?: GitLabManager, forgejoManager?: ForgejoManager): void {
    this.githubManager = githubManager
    this.worktreeManager = worktreeManager
    this.gitlabManager = gitlabManager ?? null
    this.forgejoManager = forgejoManager ?? null
  }

  setOAuthManager(manager: import('./oauth/oauth-manager-core').OAuthManager): void {
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

  private async setupWorktreeIfNeeded(taskId: string): Promise<string | undefined> {
    this.taskGroupRequests.assertCurrent()
    const { worktreeManager, githubManager, gitlabManager, forgejoManager } = this
    const result = await this.ownShutdownWork(setupTaskWorktrees(this.db, { worktreeManager, githubManager, gitlabManager, forgejoManager }, taskId, this.taskGroupRequests.capture()))
    this.taskGroupRequests.assertCurrent()
    return result
  }

  private getAdapter(agentId: string): CodingAgentAdapter | null {
    const agent = this.db.getAgent(agentId)
    if (!agent) return null
    return this.getAdapterByType(getAgentProvider(agent))
  }

  /** Adapters are created lazily and cached per backend type. */
  private getAdapterByType(backendType: string): CodingAgentAdapter | null {
    this.assertWorkspaceCleanupAvailable()
    const cached = this.adapters.get(backendType)
    if (cached) return cached
    const adapter = this.host.createAdapter(backendType, this.db)
    if (adapter) this.adapters.set(backendType, adapter)
    return adapter
  }

  private buildMcpServersForAdapter(agentId: string, opts?: McpServerOptions): ReturnType<typeof buildMcpServers> {
    this.taskGroupRequests.assertCurrent()
    return this.ownShutdownWork(buildMcpServers(this.db, this.oauthManager, agentId, opts, this.host, this.taskGroupRequests.capture()))
  }

  private attachmentGuard(beforeEffect: () => void): () => void {
    const request = this.taskGroupRequests.capture()
    return () => {
      request?.()
      if (this.shuttingDown) throw new Error('Attachment execution owner is stopping.')
      this.assertWorkspaceCleanupAvailable()
      beforeEffect()
    }
  }

  private async syncOwnedAttachments(taskId: string, workspaceDir: string, beforeEffect: () => void): Promise<string[]> {
    const guard = this.attachmentGuard(beforeEffect)
    guard()
    if (!this.attachmentExecution) return syncAttachmentsToWorkspace(this.db, taskId, workspaceDir)
    return this.ownShutdownWork(Promise.resolve().then(() => this.attachmentExecution!.sync(taskId, workspaceDir, guard)))
  }

  /** Session config for follow-up calls on an existing session (send, abort, stop). */
  private async buildSessionConfig(agentId: string, taskId: string, workspaceDir?: string): Promise<SessionConfig> {
    this.taskGroupRequests.assertCurrent()
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    const task = this.db.getTask(taskId)
    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(
      taskId, task, this.heartbeatScopeTask(taskId, task), agentId, this.db.getTaskMcpScopeNonce?.(taskId) ?? null
    ))
    this.taskGroupRequests.assertCurrent()
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
    }, this.host)
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

    if (this.host.secrets.kind !== 'broker') throw new Error('Secret sessions are unavailable in this host')
    const brokerPort = this.host.secrets.getPort()
    if (!brokerPort) {
      console.warn('[AgentManager] Secret broker not running — secrets will not be injected')
      return undefined
    }

    const token = randomUUID()
    this.host.secrets.register(token, agentId, secretIds)
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

  private ownsSessionGeneration(sessionId: string, session: AgentSession): boolean {
    return !this.stoppingSessions.has(session) && this.sessions.get(sessionId) === session
  }

  /** Polling tests use structural session copies; the synchronous Stop marker
   * is the authoritative guard for every runtime generation being torn down. */
  private mayPollSessionGeneration(session: AgentSession): boolean {
    return !this.stoppingSessions.has(session)
  }

  private assertSessionGeneration(sessionId: string, session: AgentSession): void {
    this.taskGroupRequests.assertCurrent()
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) {
      throw new Error('Message delivery was cancelled because the user stopped this task.')
    }
  }

  /** Caller authority follows the entire raw lifecycle, including bounded-start children. */
  withTaskGroupRequestGuard<T>(effect: () => Promise<T>, beforeEffect: () => void, signal: AbortSignal): Promise<T> {
    return this.ownShutdownWork(this.taskGroupRequests.run(effect, beforeEffect, signal))
  }

  /** Heartbeat admission carries the same retained authority as task starts. */
  withHeartbeatRequestGuard<T>(effect: () => Promise<T>, beforeEffect: () => void, signal: AbortSignal): Promise<T> {
    return this.withTaskGroupRequestGuard(effect, beforeEffect, signal)
  }

  /** Accepted heartbeat monitoring belongs to the application, after admission. */
  detachedHeartbeatWork<T>(effect: () => T): T { return this.taskGroupRequests.detached(effect) }

  /** Follow-ups of an accepted stored task belong to application schedulers,
   * not the lifetime of the request which committed that task. */
  runAcceptedTaskEffects<T>(effect: () => T): T { return this.taskGroupRequests.detached(effect) }

  /** A definition/review lease blocks new dispatches while source effects or
   * acknowledged idle teardown finish. Shutdown joins this work before SQLite. */
  async runTaskGroupMutation<T>(taskIds: string[], mutation: () => Promise<T>): Promise<T> {
    this.assertWorkspaceCleanupAvailable()
    if (this.shuttingDown) throw new Error('The app is shutting down.')
    if (this.productionAdmissionMutation) throw new Error('The agent configuration is being updated. Retry after it finishes.')
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 32 || taskIds.some(id => typeof id !== 'string' || !id))
      throw new Error('Select valid task-group members.')
    const ids = [...new Set(taskIds)]
    if (ids.some(id => this.taskGroupMutations.has(id) || this.taskLifecycleMutations.has(id))) throw new Error('This task group is already being updated.')
    for (const id of ids) this.assertAgentConfigurationAvailable(this.taskGroupExecution(id)?.agent_id ?? this.db.getTask(id)?.agent_id ?? this.findSessionByTaskId(id)?.session.agentId)
    for (const id of ids) this.taskGroupMutations.add(id)
    return this.ownShutdownWork((async () => {
      try {
        await Promise.all(ids.map(id => serializeTaskSend(this, id, async () => undefined)))
        if (this.shuttingDown) throw new Error('The app is shutting down.')
        this.taskGroupRequests.assertCurrent()
        return await mutation()
      } finally { for (const id of ids) this.taskGroupMutations.delete(id) }
    })())
  }

  /** Ordinary task writes join accepted sends before lifecycle side effects.
   * The domain owner validates scope/references before entering this lease. */
  async runTaskLifecycleMutation<T>(taskIds: string[], mutation: () => Promise<T>): Promise<T> {
    this.assertWorkspaceCleanupAvailable()
    if (this.shuttingDown) throw new Error('The app is shutting down.')
    if (this.productionAdmissionMutation) throw new Error('The agent configuration is being updated. Retry after it finishes.')
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 128 || taskIds.some(id => typeof id !== 'string' || !id) || typeof mutation !== 'function')
      throw new Error('Select valid tasks.')
    const ids = [...new Set(taskIds)]
    if (ids.some(id => this.taskGroupMutations.has(id) || this.taskLifecycleMutations.has(id))) throw new Error('The task is already being updated.')
    for (const id of ids) this.assertAgentConfigurationAvailable(this.db.getTask(id)?.agent_id ?? this.findSessionByTaskId(id)?.session.agentId)
    for (const id of ids) this.taskLifecycleMutations.add(id)
    return this.ownShutdownWork((async () => {
      try {
        await Promise.all(ids.map(id => serializeTaskSend(this, id, async () => undefined)))
        if (this.shuttingDown) throw new Error('The app is shutting down.')
        this.taskGroupRequests.assertCurrent()
        return await mutation()
      } finally {
        for (const id of ids) this.taskLifecycleMutations.delete(id)
        this.drainStartQueue(); this.scheduleProviderRecovery()
      }
    })())
  }

  /** Project editor changes borrow the Captain's existing task exclusion.
   * Candidate switches and ordinary Captain deliveries cannot race this lease. */
  runProjectConfigurationMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    const captain = this.db.getCoordinatorTask(projectId)
    if (!captain || this.captainSwitches.has(projectId)) return Promise.reject(new Error('The project Captain is being updated. Retry after it finishes.'))
    return this.runTaskLifecycleMutation([captain.id], mutation)
  }

  /** Production cleanup borrows the existing task leases, then excludes ALL
   * new managed work (including other task/captain/heartbeat namespaces).
   * No process is killed; an already owned process or raw start refuses. */
  withWorkspaceCleanupExclusion<T>(taskIds: readonly string[], effect: () => Promise<T>, isRetired: () => boolean = () => true): Promise<T> {
    this.taskGroupRequests.assertCurrent()
    if (this.shuttingDown || this.startupReconciliation || this.workspaceCleanupExclusion || this.productionAdmissionMutation || this.productionCredentialMutation ||
      this.agentConfigurationMutations.size || this.backendConfigurationMutations.size || this.workspaceProcessWork.size || this.sessions.size || this.sessionStarts.size || this.rawTaskStarts.size ||
      this.admittedStarts.size || this.taskStops.size || this.sessionStops.size || this.captainSwitches.size || this.providerRecoveryFlights.size ||
      this.taskGroupMutations.size || this.taskLifecycleMutations.size !== new Set(taskIds).size || !taskIds.length || taskIds.some(id => !this.taskLifecycleMutations.has(id))) return Promise.reject(new Error('WORKSPACE_CLEANUP_BUSY'))
    this.workspaceCleanupExclusion = true
    return this.ownShutdownWork((async () => {
      try { return await effect() }
      finally {
        // A rejected public wait is not a native retirement receipt. Failed or
        // uncertain observer teardown leaves admission fenced through shutdown.
        if (isRetired()) {
          this.workspaceCleanupExclusion = false
          this.drainStartQueue(); this.scheduleProviderRecovery()
        }
      }
    })())
  }

  private retainWorkspaceProcessWork<T>(effect: () => Promise<T>, cleanup = false): Promise<T> {
    if (!cleanup) this.assertWorkspaceCleanupAvailable()
    // Register before invoking any adapter. An ignored timeout/cancellation
    // keeps this exact raw initialization/model/config call counted until settle.
    let resolveRaw!: (value: T | PromiseLike<T>) => void
    let rejectRaw!: (reason: unknown) => void
    const raw = new Promise<T>((resolve, reject) => {
      resolveRaw = resolve
      rejectRaw = reject
    })
    this.workspaceProcessWork.add(raw)
    void raw.then(() => this.workspaceProcessWork.delete(raw), () => this.workspaceProcessWork.delete(raw))
    this.ownShutdownWork(raw)
    // Preserve synchronous adapter admission while making reentrant shutdown
    // or cleanup observe the retained receipt before the adapter can run.
    try { resolveRaw(effect()) }
    catch (error) { rejectRaw(error) }
    return raw
  }

  private assertWorkspaceCleanupAvailable(): void {
    if (this.workspaceCleanupExclusion) throw new Error('WORKSPACE_CLEANUP_BUSY')
  }

  /** Configuration changes join the actual lifecycle owner. Cap/name changes
   * leave live sessions intact; runtime edits and deletion acknowledge Stop
   * before committing. Shared backend adapters cannot disrupt another agent. */
  async runAgentConfigurationMutation<T>(agentId: string, kind: 'update' | 'delete', mutation: () => T | Promise<T>, changes?: UpdateAgentData): Promise<T> {
    this.taskGroupRequests.assertCurrent()
    this.assertWorkspaceCleanupAvailable()
    if (this.shuttingDown) throw new Error('The app is shutting down.')
    if (this.productionCredentialMutation) throw new Error('Wait for the credential change to finish before changing agents.')
    if (typeof agentId !== 'string' || !agentId || !['update', 'delete'].includes(kind) || typeof mutation !== 'function') throw new Error('Invalid agent configuration mutation.')
    if (this.agentConfigurationMutations.has(agentId)) throw new Error('This agent configuration is already being updated.')
    if ([...this.taskLifecycleMutations, ...this.taskGroupMutations].some(id => this.db.getTask(id)?.agent_id === agentId || this.findSessionByTaskId(id)?.session.agentId === agentId))
      throw new Error('Wait for task changes to finish before changing this agent.')
    if ([...this.captainSwitches.values()].some(flight => flight.agentId === agentId)) throw new Error('Wait for the Captain switch to finish before changing this agent.')
    const before = this.db.getAgent(agentId)
    if (!before) return this.ownShutdownWork(Promise.resolve().then(mutation))
    if (kind === 'delete' && this.db.db?.prepare && this.db.db.prepare("SELECT 1 FROM task_groups WHERE agent_id=? AND state='active' LIMIT 1").get(agentId))
      throw new Error('Dissolve this agent’s active task groups before deleting it.')
    const backend = getAgentProvider(before)
    const config = (value: AgentRecord['config']): string => JSON.stringify(Object.fromEntries(Object.keys(value).sort()
      .filter(key => !['max_parallel_sessions', 'concurrency_cap', 'fallback_agent_ids'].includes(key)).map(key => [key, value[key as keyof typeof value]])))
    const disruptive = kind === 'delete' || this.failedBackendConfigurations.has(backend) || !changes
      || changes.server_url !== undefined && changes.server_url !== before.server_url
      || changes.config !== undefined && config(changes.config) !== config(before.config)
    const nextBackend = changes?.config ? changes.config.coding_agent ?? CodingAgentType.OPENCODE : backend
    const backends = new Set(disruptive ? [backend, nextBackend] : [])
    if ([...backends].some(type => this.backendConfigurationMutations.has(type))) throw new Error('This backend configuration is already being updated.')
    const sharedBusy = [...this.sessions.values()].some(session => session.agentId !== agentId && backends.has(getAgentProvider(this.db.getAgent(session.agentId) ?? before)))
      || [...this.admittedStarts.values()].some(id => id !== agentId && backends.has(getAgentProvider(this.db.getAgent(id) ?? before)))
    if (sharedBusy) throw new Error('Stop other agents using this backend before changing its runtime configuration.')
    this.agentConfigurationMutations.add(agentId)
    for (const type of backends) this.backendConfigurationMutations.add(type)
    return this.ownShutdownWork((async () => {
      try {
        const taskIds = new Set<string>([
          ...[...this.sessions.values()].filter(session => session.agentId === agentId).map(session => session.taskId),
          ...[...this.admittedStarts.entries()].filter(([, id]) => id === agentId).map(([id]) => id),
          ...this.startQueue.active().filter(row => row.agentId === agentId).map(row => row.taskId),
          ...[...this.sessionStarts.keys()].filter(taskId => (this.admittedStarts.get(taskId) ?? this.db.getTask(taskId)?.agent_id
            ?? this.db.getSetting(coordinatorSessionAgentKey(taskId))) === agentId)
        ])
        if ([...taskIds].some(taskId => this.taskGroupMutations.has(taskId) || this.taskLifecycleMutations.has(taskId))) throw new Error('Wait for task-group review or membership changes to finish before changing this agent.')
        if (disruptive) {
          for (const taskId of taskIds) this.cancelQueuedStart(taskId)
          for (const taskId of taskIds) await this.stopByTaskId(taskId)
        }
        if (disruptive) await Promise.all([...taskIds].map(taskId => serializeTaskSend(this, taskId, async () => undefined)))
        if (this.shuttingDown) throw new Error('The app is shutting down.')
        this.taskGroupRequests.assertCurrent()
        const result = await mutation()
        if (disruptive) {
          // Every accepted backend must remain fenced until its own refresh
          // succeeds, even when an earlier notification refuses or loses scope.
          for (const type of backends) this.failedBackendConfigurations.add(type)
          for (const type of backends) {
            const adapter = this.adapters.get(type)
            if (adapter?.notifyConfigChanged) {
              try {
                this.taskGroupRequests.assertCurrent()
                await this.retainWorkspaceProcessWork(() => adapter.notifyConfigChanged!())
                this.taskGroupRequests.assertCurrent()
              }
              catch (error) { this.failedBackendConfigurations.add(type); throw error }
            }
            this.failedBackendConfigurations.delete(type)
          }
        }
        return result
      } finally {
        this.agentConfigurationMutations.delete(agentId)
        for (const type of backends) this.backendConfigurationMutations.delete(type)
        this.drainStartQueue()
        this.scheduleProviderRecovery()
      }
    })())
  }

  /** Scope derivation is shared by authorization and the actual mutation. A
   * cached global backend refresh may affect every agent using that backend. */
  getProductionCredentialAffectedAgents(input: ProductionCredentialMutation): string[] {
    if (input.kind !== 'secret' && input.kind !== 'mcp-server' && input.kind !== 'plugin-resources') return []
    const agents = this.db.getAgents()
    if (input.kind === 'plugin-resources' && input.skillIds.length) {
      // Bound legacy JSON before SQLite's actual affected-owner projection parses it.
      const sizes = this.db.db.prepare('SELECT COALESCE(MAX(length(CAST(skill_ids AS BLOB))),0) AS field, COALESCE(SUM(length(CAST(skill_ids AS BLOB))),0) AS bytes FROM tasks').get() as { field: number; bytes: number }
      if (sizes.field > 128 * 1024 || sizes.bytes > 4 * 1024 * 1024 || this.db.db.prepare('SELECT 1 FROM tasks WHERE skill_ids IS NOT NULL AND NOT json_valid(skill_ids) LIMIT 1').get()) throw new Error('Plugin task references require reconciliation.')
      const count = this.db.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(MAX(length(CAST(id AS BLOB)),COALESCE(length(CAST(agent_id AS BLOB)),0))),0) AS field FROM tasks WHERE EXISTS
        (SELECT 1 FROM json_each(tasks.skill_ids) WHERE value IN (${input.skillIds.map(() => '?').join(',')}))`).get(...input.skillIds) as { count: number; field: number }
      if (count.count > 512 || count.field > 128) throw new Error('Plugin task references exceed the supported bounds.')
    }
    const resourceTasks = input.kind === 'plugin-resources' && input.skillIds.length ? this.db.db.prepare(`SELECT id,agent_id FROM tasks WHERE EXISTS
      (SELECT 1 FROM json_each(tasks.skill_ids) WHERE value IN (${input.skillIds.map(() => '?').join(',')}))`).all(...input.skillIds) as Array<{ id: string; agent_id: string | null }> : []
    const taskAgents = new Set(resourceTasks.flatMap(task => {
      const id = task.agent_id ?? this.findSessionByTaskId(task.id)?.session.agentId ?? this.admittedStarts.get(task.id) ?? this.startQueue.get(task.id)?.agentId
      // An unassigned future task can be triaged onto any configured agent.
      return id ? [id] : agents.map(agent => agent.id)
    }))
    const referenced = agents.filter(agent => input.kind === 'secret'
      ? agent.config.secret_ids?.includes(input.secretId)
      : input.kind === 'mcp-server' ? agent.config.mcp_servers?.some(entry => (typeof entry === 'string' ? entry : entry.serverId) === input.serverId)
        : input.agentIds.includes(agent.id) || taskAgents.has(agent.id) || getAgentProvider(agent) === CodingAgentType.CLAUDE_CODE ||
          agent.config.skill_ids?.some(id => input.skillIds.includes(id)) || agent.config.mcp_servers?.some(entry => input.mcpServerIds.includes(typeof entry === 'string' ? entry : entry.serverId)))
    const shared = new Set(referenced.map(getAgentProvider).filter(type => !!this.adapters.get(type)?.notifyConfigChanged))
    return agents.filter(agent => referenced.some(row => row.id === agent.id) || shared.has(getAgentProvider(agent))).map(agent => agent.id).sort()
  }

  getMcpConfigurationAffectedAgents(serverId: string): string[] {
    return this.getProductionCredentialAffectedAgents({ kind: 'mcp-server', serverId })
  }

  /** Include implicit Captains and accepted start/session ownership, whose task
   * rows may not have agent_id. Authorization uses the same owners as Stop. */
  getAgentConfigurationProjectIds(agentId: string): string[] {
    const projects = new Set((this.db.db.prepare(`SELECT DISTINCT project_id AS id FROM tasks WHERE agent_id=? UNION
      SELECT id FROM projects WHERE default_agent_id=? OR captain_agent_id=?`).all(agentId, agentId, agentId) as Array<{ id: string }>).map(row => row.id))
    const agents = this.db.getAgents()
    const projectRows = this.db.db.prepare('SELECT id, captain_agent_id, default_agent_id FROM projects').all() as
      Array<{ id: string; captain_agent_id: string | null; default_agent_id: string | null }>
    for (const project of projectRows) if (resolveCaptainAgentId({ getAgents: () => agents }, project) === agentId) projects.add(project.id)
    const tasks = new Set([
      ...[...this.sessions.values()].filter(session => session.agentId === agentId).map(session => session.taskId),
      ...[...this.admittedStarts.entries()].filter(([, id]) => id === agentId).map(([id]) => id),
      ...this.startQueue.active().filter(row => row.agentId === agentId).map(row => row.taskId),
      ...[...this.sessionStarts.keys()].filter(taskId => (this.admittedStarts.get(taskId) ?? this.db.getTask(taskId)?.agent_id
        ?? this.db.getSetting(coordinatorSessionAgentKey(taskId))) === agentId)
    ])
    for (const id of tasks) { const task = this.db.getTask(id); if (task) projects.add(task.project_id) }
    return [...projects].sort()
  }

  private cliConfigurationTargets(clis: readonly ('claude-code' | 'opencode' | 'codex')[]): Set<string> {
    if (!Array.isArray(clis) || !clis.length || clis.length > 3 || clis.some(cli => !['claude-code', 'opencode', 'codex'].includes(cli)) || new Set(clis).size !== clis.length)
      throw new Error('Select valid CLI configuration targets.')
    return new Set(clis)
  }

  /** Scalars only: refuse an unbounded or malformed catalogue before JSON
   * projection, agent decoding, or any credential-bearing manager getter. */
  private cliConfigurationAgents(): Array<{ id: string; backend: string }> {
    const bounds = this.db.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(MAX(length(CAST(config AS BLOB))),0) AS field,
      COALESCE(SUM(length(CAST(config AS BLOB))),0) AS bytes,
      COALESCE(MAX(length(CAST(id AS BLOB))),0) AS id_bytes,
      COALESCE(SUM(CASE WHEN typeof(config)!='text' OR typeof(id)!='text' THEN 1 ELSE 0 END),0) AS invalid
      FROM agents`).get() as { count: number; field: number; bytes: number; id_bytes: number; invalid: number }
    if (Object.values(bounds).some(value => !Number.isSafeInteger(value) || value < 0) || bounds.count > 128 || bounds.field > 128 * 1024 || bounds.bytes > 4 * 1024 * 1024 || bounds.id_bytes > 128 || bounds.invalid)
      throw new Error('CLI agent metadata exceeds the supported bounds or requires reconciliation.')
    if (this.db.db.prepare("SELECT 1 FROM agents WHERE NOT json_valid(config) LIMIT 1").get()
      || this.db.db.prepare("SELECT 1 FROM agents WHERE json_type(config)!='object' LIMIT 1").get()
      || this.db.db.prepare("SELECT 1 FROM agents WHERE (SELECT COUNT(*) FROM json_each(agents.config) WHERE key='coding_agent')>1 LIMIT 1").get())
      throw new Error('CLI agent metadata requires reconciliation.')
    const rows = this.db.db.prepare(`SELECT id, json_type(config,'$.coding_agent') AS kind,
      CASE WHEN json_type(config,'$.coding_agent')='text' THEN json_extract(config,'$.coding_agent') ELSE NULL END AS backend
      FROM agents ORDER BY id LIMIT 129`).all() as Array<{ id: string; kind: string | null; backend: string | null }>
    return rows.map(row => {
      if (typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id) || row.kind !== null && row.kind !== 'text'
        || row.kind === 'text' && (typeof row.backend !== 'string' || !['claude-code', 'opencode', 'codex', 'cursor', 'pi'].includes(row.backend)))
        throw new Error('CLI agent metadata requires reconciliation.')
      return { id: row.id, backend: row.kind === null ? CodingAgentType.OPENCODE : row.backend! }
    })
  }

  getCliConfigurationAffectedAgents(clis: readonly ('claude-code' | 'opencode' | 'codex')[]): string[] {
    const targets = this.cliConfigurationTargets(clis)
    return this.cliConfigurationAgents().filter(agent => targets.has(agent.backend)).map(agent => agent.id)
  }

  private agentInstallationTargets(name: string): Set<string> {
    const mapping: Record<string, string> = { claudeCode: 'claude-code', opencode: 'opencode', codex: 'codex', cursor: 'cursor', pi: 'pi' }
    if (name === 'pnpm') return new Set(['claude-code', 'opencode', 'codex', 'cursor', 'pi'])
    if (!Object.hasOwn(mapping, name)) throw new Error('Select a supported agent installation target.')
    return new Set([mapping[name]])
  }
  getAgentInstallationAffectedAgents(name: string): string[] {
    const targets = this.agentInstallationTargets(name)
    return this.cliConfigurationAgents().filter(agent => targets.has(agent.backend)).map(agent => agent.id)
  }
  getAgentInstallationAffectedProjects(name: string): string[] {
    const ids = this.getAgentInstallationAffectedAgents(name)
    const bounds = this.db.db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(length(CAST(id AS BLOB))),0) AS id_bytes,
      COALESCE(MAX(length(CAST(captain_agent_id AS BLOB))),0) AS captain_bytes, COALESCE(MAX(length(CAST(default_agent_id AS BLOB))),0) AS default_bytes FROM projects`).get() as Record<string, number>
    if (Object.values(bounds).some(value => !Number.isSafeInteger(value) || value < 0) || bounds.count > 128 || bounds.id_bytes > 128 || bounds.captain_bytes > 128 || bounds.default_bytes > 128) throw new Error('Agent installation project metadata requires reconciliation.')
    const rows = this.db.db.prepare('SELECT id,captain_agent_id,default_agent_id FROM projects ORDER BY id LIMIT 129').all() as Array<{ id: string; captain_agent_id: string | null; default_agent_id: string | null }>
    const valid = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
    if (rows.some(row => !valid(row.id) || row.captain_agent_id !== null && !valid(row.captain_agent_id) || row.default_agent_id !== null && !valid(row.default_agent_id))) throw new Error('Agent installation project metadata requires reconciliation.')
    const fallback = this.db.db.prepare('SELECT id FROM agents WHERE is_default=1 ORDER BY id LIMIT 2').all() as Array<{ id: string }>
    if (fallback.length > 1 || fallback.some(row => !valid(row.id))) throw new Error('Agent installation default metadata requires reconciliation.')
    const settings = this.db.db.prepare("SELECT length(CAST(value AS BLOB)) AS bytes FROM settings WHERE key='default_agent_id'").get() as { bytes: number } | undefined
    if (settings && (!Number.isSafeInteger(settings.bytes) || settings.bytes > 128)) throw new Error('Agent installation default metadata requires reconciliation.')
    const configured = settings ? (this.db.db.prepare("SELECT value FROM settings WHERE key='default_agent_id'").get() as { value: string }).value : null
    if (configured && !valid(configured)) throw new Error('Agent installation default metadata requires reconciliation.')
    const globalDefault = configured || fallback[0]?.id || this.cliConfigurationAgents()[0]?.id
    const projects = new Set(rows.filter(row => ids.includes(row.captain_agent_id ?? row.default_agent_id ?? globalDefault ?? '') || row.default_agent_id && ids.includes(row.default_agent_id)).map(row => row.id))
    for (const id of ids) {
      const size = this.db.db.prepare('SELECT COALESCE(MAX(length(CAST(project_id AS BLOB))),0) AS bytes FROM tasks WHERE agent_id=?').get(id) as { bytes: number }
      if (!Number.isSafeInteger(size.bytes) || size.bytes > 128) throw new Error('Agent installation task metadata requires reconciliation.')
      const scopes = this.db.db.prepare('SELECT DISTINCT project_id FROM tasks WHERE agent_id=? LIMIT 129').all(id) as Array<{ project_id: string | null }>
      if (scopes.length > 128 || scopes.some(row => row.project_id === null || !valid(row.project_id) || !rows.some(project => project.id === row.project_id))) throw new Error('Agent installation task metadata requires reconciliation.')
      for (const scope of scopes) projects.add(scope.project_id!)
    }
    return [...projects].sort()
  }
  runAgentInstallationMutation<T extends { success: boolean }>(name: string, mutation: () => Promise<T>): Promise<T> {
    return this.runCliRuntimeMutation(this.agentInstallationTargets(name), mutation, true)
  }

  /** Actual configuration effects never stop a session implicitly. All
   * startup ownership must be settled before global CLI files are changed. */
  runCliConfigurationMutation<T>(clis: readonly ('claude-code' | 'opencode' | 'codex')[], mutation: () => Promise<T>): Promise<T> {
    this.taskGroupRequests.assertCurrent()
    if (typeof mutation !== 'function') return Promise.reject(new Error('A CLI configuration mutation is required.'))
    return this.runCliRuntimeMutation(this.cliConfigurationTargets(clis), mutation, false)
  }
  private runCliRuntimeMutation<T>(targets: Set<string>, mutation: () => Promise<T>, installation: boolean): Promise<T> {
    this.assertWorkspaceCleanupAvailable()
    this.taskGroupRequests.assertCurrent()
    if (typeof mutation !== 'function') return Promise.reject(new Error('A CLI mutation is required.'))
    if (this.shuttingDown || this.productionCredentialMutation || this.productionAdmissionMutation || this.agentConfigurationMutations.size || this.backendConfigurationMutations.size
      || this.rawTaskStarts.size || this.sessionStarts.size || this.captainSwitches.size || this.taskGroupMutations.size || this.taskLifecycleMutations.size || this.sessionStops.size)
      return Promise.reject(new Error('Wait for agent lifecycle work to finish before changing CLI configuration.'))
    const agents = this.cliConfigurationAgents(), allIds = new Set(agents.map(agent => agent.id))
    const ids = new Set(agents.filter(agent => targets.has(agent.backend)).map(agent => agent.id))
    if ([...this.sessions.values()].some(session => ids.has(session.agentId) || !allIds.has(session.agentId))
      || [...this.admittedStarts.values()].some(id => ids.has(id) || !allIds.has(id)))
      return Promise.reject(new Error('Stop affected agent sessions and admitted starts before changing CLI configuration.'))
    if ([...targets].some(backend => this.adapters.has(backend) && (installation || typeof this.adapters.get(backend)?.notifyConfigChanged !== 'function')))
      return Promise.reject(new Error('A cached affected adapter cannot acknowledge configuration refresh. Restart before changing this CLI configuration.'))
    // Read only bounded ownership scalars. Full queue getters also load saved
    // workspace/error payloads and are intentionally excluded from preflight.
    const queueBounds = this.db.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(MAX(MAX(length(CAST(agent_id AS BLOB)),length(CAST(task_id AS BLOB)))),0) AS field,
      COALESCE(SUM(CASE WHEN typeof(agent_id)!='text' OR typeof(task_id)!='text' THEN 1 ELSE 0 END),0) AS invalid
      FROM agent_start_queue WHERE state IN ('queued','retrying','claimed','starting')`).get() as { count: number; field: number; invalid: number }
    if (Object.values(queueBounds).some(value => !Number.isSafeInteger(value) || value < 0) || queueBounds.count > 128 || queueBounds.field > 128 || queueBounds.invalid)
      return Promise.reject(new Error('CLI configuration start queue exceeds the supported bounds or requires reconciliation.'))
    const queued = this.db.db.prepare("SELECT agent_id AS id,task_id AS taskId FROM agent_start_queue WHERE state IN ('queued','retrying','claimed','starting') LIMIT 129").all() as Array<{ id: string; taskId: string }>
    if (queued.some(row => typeof row.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.taskId))) return Promise.reject(new Error('CLI configuration start queue requires reconciliation.'))
    if (queued.some(row => !allIds.has(row.id) || ids.has(row.id))) return Promise.reject(new Error('Remove affected queued starts before changing CLI configuration.'))
    this.productionCredentialMutation = true
    this.productionAdmissionMutation = true
    for (const id of ids) this.agentConfigurationMutations.add(id)
    for (const backend of targets) this.backendConfigurationMutations.add(backend)
    return this.ownShutdownWork((async () => {
      let effectStarted = false
      try {
        this.taskGroupRequests.assertCurrent()
        if (this.shuttingDown) throw new Error('The app is shutting down.')
        effectStarted = true
        const result = await this.ownShutdownWork(mutation())
        this.taskGroupRequests.assertCurrent()
        if (installation && (typeof result !== 'object' || result === null || !('success' in result) || result.success !== true)) {
          for (const backend of targets) this.failedBackendConfigurations.add(backend)
          return result
        }
        this.taskGroupRequests.assertCurrent()
        if (this.shuttingDown) throw new Error('The app is shutting down.')
        for (const backend of targets) {
          this.taskGroupRequests.assertCurrent()
          const adapter = this.adapters.get(backend)
          if (adapter?.notifyConfigChanged) {
            try {
              await this.retainWorkspaceProcessWork(() => adapter.notifyConfigChanged!())
              this.taskGroupRequests.assertCurrent()
              if (this.shuttingDown) throw new Error('The app is shutting down.')
            } catch (error) { this.failedBackendConfigurations.add(backend); throw error }
          }
        }
        for (const backend of targets) this.failedBackendConfigurations.delete(backend)
        return result
      } catch (error) {
        // Publication may precede rejection; there is no fabricated rollback.
        // Even with an acknowledged file effect, a missing refresh is unsafe.
        if (effectStarted) for (const backend of targets) this.failedBackendConfigurations.add(backend)
        throw error
      } finally {
        this.productionCredentialMutation = false
        this.productionAdmissionMutation = false
        for (const id of ids) this.agentConfigurationMutations.delete(id)
        for (const backend of targets) this.backendConfigurationMutations.delete(backend)
        this.drainStartQueue(); this.scheduleProviderRecovery()
      }
    })())
  }

  runMcpConfigurationMutation<T>(serverId: string, mutation: () => T | Promise<T>): Promise<T> {
    return this.runProductionCredentialMutation({ kind: 'mcp-server', serverId }, mutation)
  }

  getPluginConfigurationAffectedAgents(resources: { agentIds: string[]; mcpServerIds: string[]; skillIds: string[] }): string[] {
    return this.getProductionCredentialAffectedAgents({ kind: 'plugin-resources', ...resources })
  }

  runPluginConfigurationMutation<T>(resources: { agentIds: string[]; mcpServerIds: string[]; skillIds: string[] }, mutation: () => T | Promise<T>): Promise<T> {
    return this.runProductionCredentialMutation({ kind: 'plugin-resources', ...structuredClone(resources) }, mutation)
  }

  runProductionCredentialMutation<T>(input: ProductionCredentialMutation, mutation: () => T | Promise<T>): Promise<T> {
    this.taskGroupRequests.assertCurrent()
    this.assertWorkspaceCleanupAvailable()
    if (this.shuttingDown || this.productionCredentialMutation || this.agentConfigurationMutations.size || this.backendConfigurationMutations.size)
      return Promise.reject(new Error('The credential lifecycle is unavailable. Retry after current changes finish.'))
    if (!input || !['provider-key', 'secret', 'mcp-server', 'default-agent', 'plugin-resources'].includes(input.kind) || typeof mutation !== 'function' ||
      input.kind === 'secret' && (typeof input.secretId !== 'string' || !input.secretId) ||
      input.kind === 'mcp-server' && (typeof input.serverId !== 'string' || !input.serverId) ||
      input.kind === 'provider-key' && !['openai_api_key', 'anthropic_api_key'].includes(input.key) ||
      input.kind === 'plugin-resources' && [input.agentIds, input.mcpServerIds, input.skillIds].some(ids => !Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== 'string' || !id || id.length > 128) || new Set(ids).size !== ids.length))
      return Promise.reject(new Error('Invalid credential mutation.'))
    const ids = new Set(this.getProductionCredentialAffectedAgents(input))
    const backends = new Set([...ids].map(id => getAgentProvider(this.db.getAgent(id)!)).filter(type => !!this.adapters.get(type)?.notifyConfigChanged))
    const taskIds = new Set<string>([
      ...[...this.sessions.values()].filter(session => ids.has(session.agentId)).map(session => session.taskId),
      ...[...this.admittedStarts.entries()].filter(([, id]) => ids.has(id)).map(([id]) => id),
      ...this.startQueue.active().filter(row => ids.has(row.agentId)).map(row => row.taskId),
      ...[...this.sessionStarts.keys()].filter(taskId => ids.has(this.admittedStarts.get(taskId) ?? this.db.getTask(taskId)?.agent_id
        ?? this.db.getSetting(coordinatorSessionAgentKey(taskId)) ?? ''))
    ])
    if ([...taskIds].some(id => this.taskGroupMutations.has(id) || this.taskLifecycleMutations.has(id)) ||
      [...this.captainSwitches.entries()].some(([projectId, flight]) => {
        const project = this.db.getProject(projectId)
        return ids.has(flight.agentId) || !!project && ids.has(resolveCaptainAgentId(this.db, project) ?? '')
      }))
      return Promise.reject(new Error('Wait for task or Captain changes to finish before changing credentials.'))
    this.productionCredentialMutation = true
    this.productionAdmissionMutation = input.kind === 'default-agent' || input.kind === 'plugin-resources'
    for (const id of ids) this.agentConfigurationMutations.add(id)
    for (const backend of backends) this.backendConfigurationMutations.add(backend)
    return this.ownShutdownWork((async () => {
      try {
        for (const id of taskIds) this.cancelQueuedStart(id)
        for (const id of taskIds) await this.stopByTaskId(id)
        await Promise.all([...taskIds].map(id => serializeTaskSend(this, id, async () => undefined)))
        if (this.shuttingDown) throw new Error('The app is shutting down.')
        const current = this.getProductionCredentialAffectedAgents(input)
        if (current.length !== ids.size || current.some(id => !ids.has(id))) throw new Error('Credential references changed. Retry with current scope.')
        this.taskGroupRequests.assertCurrent()
        const result = await mutation()
        for (const backend of backends) this.failedBackendConfigurations.add(backend)
        for (const backend of backends) {
          try {
            this.taskGroupRequests.assertCurrent()
            await this.retainWorkspaceProcessWork(() => this.adapters.get(backend)!.notifyConfigChanged!())
            this.taskGroupRequests.assertCurrent()
            this.failedBackendConfigurations.delete(backend)
          } catch (error) { this.failedBackendConfigurations.add(backend); throw error }
        }
        return result
      } finally {
        this.productionCredentialMutation = false
        this.productionAdmissionMutation = false
        for (const id of ids) this.agentConfigurationMutations.delete(id)
        for (const backend of backends) this.backendConfigurationMutations.delete(backend)
        this.drainStartQueue(); this.scheduleProviderRecovery()
      }
    })())
  }

  private assertAgentConfigurationAvailable(agentId: string | undefined): void {
    this.assertWorkspaceCleanupAvailable()
    this.taskGroupRequests.assertCurrent()
    if (!agentId) return
    const agent = this.db.getAgent(agentId)
    const backend = agent && getAgentProvider(agent)
    if (this.agentConfigurationMutations.has(agentId) || backend && this.backendConfigurationMutations.has(backend))
      throw new Error('The agent configuration is being updated. Retry after it finishes.')
    if (backend && this.failedBackendConfigurations.has(backend)) throw new Error('Backend configuration could not be refreshed. Retry the configuration change or restart before starting work.')
  }

  private agentConfigurationBlocked(agentId: string): boolean {
    const agent = this.db.getAgent(agentId)
    const backend = agent && getAgentProvider(agent)
    return this.agentConfigurationMutations.has(agentId) || !!backend && (this.backendConfigurationMutations.has(backend) || this.failedBackendConfigurations.has(backend))
  }

  /** Membership changes retire only their idle backend. Saved transcript and
   * the pending continuity seed survive until the next accepted instruction. */
  async retireTaskGroupContext(taskId: string): Promise<void> {
    this.taskGroupRequests.assertCurrent()
    const task = this.db.getTask(taskId)
    if (task?.role !== 'task_group') throw new Error('Task group execution was not found.')
    const live = this.findSessionByTaskId(taskId)
    if (live && ['working', 'waiting_approval'].includes(live.session.status)) throw new Error('Stop the group before changing its members.')
    const previousId = live?.sessionId ?? task.session_id
    if (live) await this.stopSession(live.sessionId, false, true)
    this.taskGroupRequests.assertCurrent()
    if (previousId) {
      const lossId = `session-loss-pending-${randomUUID()}`
      this.emitSystemNotice(previousId, taskId, lossId, 'Group membership changed. The previous shared transcript is retained; the next accepted instruction carries a continuity recap.')
      this.db.updateTask(taskId, { session_id: null })
    }
  }

  private taskGroupExecution(taskId: string): TaskRecord | undefined {
    return this.db.getTaskGroupExecution?.(taskId)
  }

  private assertNoTaskGroupMutation(taskId: string): void {
    this.assertWorkspaceCleanupAvailable()
    const pendingCleanup = this.findSessionByTaskId(taskId)
    if (pendingCleanup && this.scopedCleanupFailures.has(pendingCleanup.sessionId)) throw new Error('Accepted native cleanup must finish before this task can restart.')
    if (this.taskLifecycleMutations.has(taskId)) throw new Error('The task is being updated. Retry after its lifecycle change finishes.')
    if (this.taskGroupMutations.has(taskId)) throw new Error('The task group is being updated. Retry after its review or membership change finishes.')
    this.assertAgentConfigurationAvailable(this.db.getTask(taskId)?.agent_id ?? this.findSessionByTaskId(taskId)?.session.agentId)
  }

  private emitStatus(sessionId: string, owner: { agentId: string; taskId: string }, status: AgentSession['status'], activityOutcome: AgentActivityOutcome | undefined = status === 'error' ? 'failed' : undefined): void {
    const task = this.db.getTask(owner.taskId)
    if (sessionId && isCoordinatorTask(task) && task?.session_id && task.session_id !== sessionId) return
    const managed = this.sessions.get(sessionId)
    if (this.managedEngine(managed) && managed?.managedIntentId && (status === 'idle' || status === 'error')) {
      const intentId = managed.managedIntentId
      managed.managedIntentId = undefined
      this.retainCaptainObservation(this.managedEngine(managed)!.finishTurn(owner.taskId, sessionId, intentId,
        activityOutcome === 'cancelled' || activityOutcome === 'interrupted' ? activityOutcome : status === 'idle' ? 'end_turn' : 'error'))
    }
    for (const taskId of this.taskGroupActivityTargets(owner.taskId, status)) {
      if (sessionId) this.sendToRenderer('agent:status', {
        sessionId, agentId: owner.agentId, taskId, status,
        ...(activityOutcome ? { activityOutcome } : {}), ...this.activityObservations.stamp()
      })
      else if (this.db.getTask(taskId)) {
        // A rejected start has no runtime identity. Its durable transcript and
        // queue audit carry the error; invalidate the existing task so clients
        // reread those facts without inventing a session or provider status.
        this.sendToRenderer('task:updated', { taskId, updates: {} })
      }
    }
    // Every idle transition and every stop ends here: a slot may have freed.
    if (status === 'idle' || status === 'error') this.scheduleStartQueueDrain()
    // Project events (#57): an agent waiting on the user, or one that failed,
    // wakes the project's Captain. Pseudo-tasks and coordinator rows are
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

  private emitSystemNotice(sessionId: string, taskId: string, id: string, content: string, partType: MessagePartType = MessagePartType.TEXT): void {
    this.sendToRenderer('agent:output', {
      sessionId,
      taskId,
      type: 'message',
      data: { id, role: 'system', content, partType }
    })
  }

  /** Persist recovery intent before clearing the binding, using the existing
   * transcript projection so restart/reconnect cannot consume an unsent recap. */
  private markSessionLost(taskId: string, previousSessionId: string, reason: string | undefined): void {
    // Backend errors may contain request bodies, credentials or local paths.
    // Only fixed classifications enter recovery notices and logs.
    const why = ['INCOMPATIBLE_SESSION_ID', 'SESSION_FILE_NOT_FOUND', 'No conversation found', 'Session no longer exists on server']
      .find((code) => reason?.includes(code)) ?? 'Backend session unavailable'
    console.warn(`[AgentManager] Session ${previousSessionId} of task ${taskId} was lost (${why}); the next session starts with a recap`)
    const lossId = `session-loss-pending-${randomUUID()}`
    this.emitSystemNotice(previousSessionId, taskId, lossId, why)
    const engine = this.managesCaptain(taskId) ? this.captainEngine : this.managesTask(taskId) ? this.taskEngine : null
    if (engine) {
      this.retainCaptainObservation(engine.observe(taskId, previousSessionId, 'session_lost', `${lossId}:lost`, { reason: why, lossId }))
      const intent = this.providerRecoveries.get(taskId)
      if (intent?.sessionId === previousSessionId) this.retainCaptainObservation(engine.finishTurn(taskId, previousSessionId, intent.intentId, 'interrupted'))
      this.retainCaptainObservation(engine.observe(taskId, previousSessionId, 'owner_closed', `${lossId}:closed`, { reason: 'backend_session_lost' }))
    }
  }

  private pendingSessionLoss(taskId: string): { id: string; reason: string } | undefined {
    const parts = this.db.getTranscriptParts(taskId)
    const latest = parts.filter((part) => part.role === 'system' && part.partId.startsWith('session-loss-pending-')).at(-1)
    if (!latest || parts.some((part) => part.role === 'system' && part.partId === `session-loss-ack-${latest.partId}`)) return undefined
    return { id: latest.partId, reason: latest.content }
  }

  private announceLostSessionReplacement(taskId: string, newSessionId: string): string {
    const lost = this.pendingSessionLoss(taskId)
    if (!lost) return ''
    const recap = this.taskRecap(taskId, this.sessions.get(newSessionId)?.configuredModel, true)
    const session = this.sessions.get(newSessionId)
    if (session) {
      session.pendingRecap = recap
      session.pendingLossId = lost.id
    }
    this.emitSystemNotice(
      newSessionId, taskId, `session-lost-replacement-${lost.id}`,
      `${LOST_SESSION_NOTICE}${recap ? ', with a recap of the latest conversation pending delivery.' : '.'}\n\nReason: ${lost.reason}`
    )
    const engine = this.managedEngine(session)
    if (engine) this.retainCaptainObservation(engine.observe(taskId, newSessionId,
      'replacement_seeded', `${engine.role}:${taskId}:${lost.id}:${newSessionId}:seeded`, { lossId: lost.id, recapPending: true, recapCharacters: recap.length }))
    return recap
  }

  private acknowledgeSessionRecap(session: AgentSession, lossId: string | undefined): void {
    if (session.pendingHandoffSeedId) {
      const seedId = session.pendingHandoffSeedId
      this.db.db.transaction(() => {
        const seed = this.deliveries.get(seedId)
        if (!seed || seed.kind !== 'captain_handoff_seed' || seed.taskId !== session.taskId) throw new Error('Captain continuity seed belongs to another conversation')
        if (seed.state !== 'acknowledged') {
          const claim = this.deliveries.claim(seedId, this.deliveryOwner, DELIVERY_CLAIM_MS)
          if (!claim) throw new Error('Captain continuity acknowledgement could not claim its metadata')
          this.deliveries.accept(seedId, this.deliveryOwner, session.id)
          this.deliveries.acknowledge(seedId, this.deliveryOwner)
        }
      })()
      session.pendingHandoffSeedId = undefined
      if (!session.pendingLossId) session.pendingRecap = undefined
    }
    if (!lossId) return
    this.emitSystemNotice(session.id, session.taskId, `session-loss-ack-${lossId}`, 'Recovery context delivered to the replacement session.')
    if (session.pendingLossId === lossId) {
      session.pendingRecap = undefined
      session.pendingLossId = undefined
    }
  }

  private restoreCaptainHandoffSeed(session: AgentSession): void {
    if (!isCoordinatorTask(this.db.getTask(session.taskId)) || !this.db.db?.prepare) return
    const row = this.db.db.prepare("SELECT id FROM delivery_outbox WHERE task_id=? AND kind='captain_handoff_seed' AND state='pending' ORDER BY created_at DESC LIMIT 1")
      .get(session.taskId) as { id: string } | undefined
    if (!row) return
    const seed = this.deliveries.get(row.id)!
    session.pendingHandoffSeedId = seed.id
    session.pendingRecap = session.pendingRecap && session.pendingRecap !== seed.payload
      ? `${seed.payload}\n\n${session.pendingRecap}` : seed.payload
  }

  async stopServer(): Promise<void> {
    const adapter = this.adapters.get(CodingAgentType.OPENCODE)
    if (adapter && 'stopServer' in adapter && typeof (adapter as { stopServer: () => Promise<void> }).stopServer === 'function') {
      console.log('[AgentManager] Delegating server stop to OpencodeAdapter')
      await (adapter as { stopServer: () => Promise<void> }).stopServer()
    }
  }

  private async initializeAndProbeAdapter(adapter: CodingAgentAdapter, taskId: string, generation = this.captainRuntimes.get(taskId)?.generation): Promise<void> {
    this.taskGroupRequests.assertCurrent()
    const init = this.retainWorkspaceProcessWork(() => adapter.initialize())
    try {
      await withStartupDeadline(init, AGENT_SERVER_START_TIMEOUT_MS, 'Agent server startup')
      this.taskGroupRequests.assertCurrent()
      const health = typeof adapter.checkHealth === 'function'
        ? await withStartupDeadline(this.retainWorkspaceProcessWork(() => adapter.checkHealth()), AGENT_SERVER_START_TIMEOUT_MS, 'Agent health probe')
        : { available: true }
      this.taskGroupRequests.assertCurrent()
      if (!health.available) {
        this.transitionCaptainRuntime(taskId, 'unhealthy', {
          lastProbeAt: Date.now(),
          probeOk: false,
          errorCode: 'HEALTH_PROBE_FAILED',
          errorDetail: health.reason || 'Agent health probe failed'
        }, generation)
        throw new Error(health.reason || 'Agent health probe failed')
      }
      this.transitionCaptainRuntime(taskId, 'starting_session', {
        lastProbeAt: Date.now(),
        probeOk: true,
        errorCode: null,
        errorDetail: null
      }, generation)
    } catch (error) {
      const stoppable = adapter as CodingAgentAdapter & { stopServer?: () => Promise<void> }
      if (![...this.sessions.values()].some((session) => session.adapter === adapter) && typeof stoppable.stopServer === 'function') {
        void this.retainWorkspaceProcessWork(() => stoppable.stopServer!(), true).catch(() => {})
      }
      throw error
    }
  }

  private async verifyAdapterSession(
    adapter: CodingAgentAdapter,
    sessionId: string,
    sessionConfig: SessionConfig,
    taskId: string,
    markHealthy = true,
    generation = this.captainRuntimes.get(taskId)?.generation
  ): Promise<SessionStatusType> {
    this.taskGroupRequests.assertCurrent()
    this.transitionCaptainRuntime(taskId, 'verifying', { sessionId, lastProbeAt: Date.now() }, generation)
    const readiness = adapter as CodingAgentAdapter & {
      getSessionStatus?: (id: string, config: SessionConfig) => Promise<{ type: SessionStatusType; message?: string }>
    }
    // All production adapters implement getStatus. The compatibility branch
    // keeps old third-party/test doubles usable while still probing whenever
    // either supported status method exists.
    const statusPromise: Promise<{ type: SessionStatusType; message?: string }> = typeof adapter.getStatus === 'function'
      ? adapter.getStatus(sessionId, sessionConfig)
      : typeof readiness.getSessionStatus === 'function'
        ? readiness.getSessionStatus(sessionId, sessionConfig)
        : Promise.resolve({ type: SessionStatusType.IDLE })
    const status = await withStartupDeadline(
      this.ownShutdownWork(statusPromise),
      AGENT_SERVER_START_TIMEOUT_MS,
      'Agent session readiness probe'
    )
    this.taskGroupRequests.assertCurrent()
    if (status.type === SessionStatusType.ERROR && this.providerRecoveries.get(taskId)?.state === 'retrying'
      && this.providerRecoveries.get(taskId)?.sessionId === sessionId) return SessionStatusType.IDLE
    if (status.type === SessionStatusType.ERROR) {
      this.transitionCaptainRuntime(taskId, 'unhealthy', {
        lastProbeAt: Date.now(),
        probeOk: false,
        errorCode: 'SESSION_READINESS_FAILED',
        errorDetail: status.message || 'Agent session readiness probe failed'
      }, generation)
      throw new Error(status.message || 'Agent session readiness probe failed')
    }
    if (!markHealthy) {
      this.transitionCaptainRuntime(taskId, 'verifying', {
        sessionId,
        lastProbeAt: Date.now(),
        probeOk: true,
        errorCode: null,
        errorDetail: null
      }, generation)
      return status.type
    }
    const runtime = this.captainRuntimes.get(taskId)
    this.transitionCaptainRuntime(taskId, 'healthy', {
      sessionId,
      deadlineAt: null,
      lastProbeAt: Date.now(),
      probeOk: true,
      candidateAgentId: null,
      lastGoodAgentId: runtime?.agentId ?? null,
      errorCode: null,
      errorDetail: null
    }, generation)
    return status.type
  }

  private async retireScopedAdapterSession(adapter: CodingAgentAdapter, sessionId: string, config: SessionConfig): Promise<void> {
    const existing = this.sessions.get(sessionId)
    if (existing && (existing.taskId !== config.taskId || existing.agentId !== config.agentId || existing.adapter !== adapter)) {
      this.scopedCleanupFailures.add(sessionId)
      this.scopedCleanupConflicts.add(sessionId)
      throw new Error('Accepted native cleanup has conflicting ownership; retain the profile for reconciliation.')
    }
    if (!existing) this.sessions.set(sessionId, {
      id: sessionId, agentId: config.agentId!, taskId: config.taskId!, workspaceDir: config.workspaceDir,
      status: 'idle', createdAt: new Date(), seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map(),
      adapter, fallbackAgentIds: [], attemptedAgentIds: new Set([config.agentId!]), configuredModel: config.model, secretSessionToken: config.secretSessionToken
    })
    this.scopedCleanupFailures.add(sessionId)
    this.scopedRetirementConfigs.set(this.sessions.get(sessionId)!, config)
    await this.ownTaskStartup(config.taskId!, this.taskGroupRequests.detached(() => this.stopSession(sessionId, false, true)))
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
    inheritedFallbackState?: AgentFallbackState,
    deferCoordinatorBinding = false,
    mayStart: () => boolean = () => !this.shuttingDown
  ): Promise<string> {
    this.assertWorkspaceCleanupAvailable()
    this.taskGroupRequests.assertCurrent()
    if (this.productionAdmissionMutation) throw new Error('Wait for CLI configuration changes before starting a session.')
    const agent = this.db.getAgent(agentId)!
    workspaceDir ||= this.db.getWorkspaceDir(taskId)

    const task = this.db.getTask(taskId)
    const managedCaptain = isManagedCaptain(task, this.captainEngine?.enabled ?? false)
    const managedTask = isManagedTask(taskId, task, this.taskEngine?.enabled ?? false)
    const engine = managedCaptain ? this.captainEngine : managedTask ? this.taskEngine : null
    const runtimeGeneration = this.captainRuntimes.get(taskId)?.generation
    const isTriageSession = isTriageSessionTask(taskId, task)
    await yieldEventLoop()
    this.taskGroupRequests.assertCurrent()

    const mcpScopeNonce = task && !isCoordinatorTask(task) ? this.db.rotateTaskMcpScopeNonce?.(taskId) ?? null : null
    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(
      taskId, task, this.heartbeatScopeTask(taskId, task), agentId, mcpScopeNonce
    ))

    this.taskGroupRequests.assertCurrent()
    // Written AFTER the MCP map is built so the documentation describes the
    // servers this session really gets, instead of the agent configuration,
    // which both over- and under-reports them.
    await this.ownShutdownWork(writeSkillFiles(this.db, taskId, agentId, workspaceDir, mcpServers, this.taskGroupRequests.capture()))
    await yieldEventLoop()
    this.taskGroupRequests.assertCurrent()

    const secretToken = this.setupSecretSession(agentId)
    let acceptedSessionId: string | undefined
    let creationStarted = false
    let scopedSecretReleased = false
    let scopedRetirementAttempted = false
    try {
      const sessionConfig = assembleSessionConfig(this.db, agent, {
        agentId,
        taskId,
        task,
        workspaceDir,
        mcpServers,
        systemPrompt: agent.config?.system_prompt,
        secretToken,
        onModelNotice: (notice) => this.emitSystemError('', taskId, `skill-model-${Date.now()}`, notice)
      }, this.host)
      await yieldEventLoop()
      this.taskGroupRequests.assertCurrent()

      console.log(`[AgentManager] startAdapterSession: agent=${agent.name}, coding_agent=${agent.config?.coding_agent || 'opencode'}, model=${agent.config?.model}, adapter=${adapter.constructor.name}`)
      await this.initializeAndProbeAdapter(adapter, taskId, runtimeGeneration)

      if (managedTask && (handoffFromAgentName || this.pendingSessionLoss(taskId))) this.taskRecap(taskId, sessionConfig.model, !handoffFromAgentName,
        skipInitialPrompt ? 0 : this.taskHandoffReservedTokens(taskId))
      this.taskGroupRequests.assertCurrent()
      if (!mayStart()) throw new Error('Start ownership was withdrawn before session creation.')
      creationStarted = true
      const creating = this.ownTaskStartup(taskId, engine
        ? engine.createSession(taskId, adapter, sessionConfig) : adapter.createSession(sessionConfig))
      const adapterSessionId = await withStartupDeadline(
        creating,
        AGENT_SESSION_START_TIMEOUT_MS,
        'Agent session startup',
        (lateSessionId) => this.ownShutdownWork(this.taskGroupRequests.detached(() => this.retireScopedAdapterSession(adapter, lateSessionId, sessionConfig))).catch(error => console.error('[AgentManager] Late native cleanup remains owned:', error))
      )
      acceptedSessionId = adapterSessionId
      this.taskGroupRequests.assertCurrent()
      console.log(`[AgentManager] Session created: ${adapterSessionId}, workspaceDir=${workspaceDir}`)
      try {
        await this.verifyAdapterSession(adapter, adapterSessionId, sessionConfig, taskId, !deferCoordinatorBinding, runtimeGeneration)
      } catch (error) {
        if (this.taskGroupRequests.scoped) {
          scopedRetirementAttempted = true
          await this.retireScopedAdapterSession(adapter, adapterSessionId, sessionConfig)
          acceptedSessionId = undefined
          scopedSecretReleased = true
        } else await this.ownShutdownWork(adapter.destroySession(adapterSessionId, sessionConfig)).catch(() => {})
        throw error
      }

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
        await this.ownShutdownWork(writeSkillFiles(this.db, taskId, agentId, workspaceDir, attached, this.taskGroupRequests.capture()))
      }

      this.taskGroupRequests.assertCurrent()
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
        attemptedAgentIds,
        managedCaptain,
        managedTask,
        configuredModel: sessionConfig.model,
        configuredAgent: isCoordinatorTask(task) ? structuredClone(agent) : undefined
      })

      if (!mayStart()) {
        // Retain ownership if the backend refuses cleanup, so a pending user
        // stop cannot report success while an untracked session survives.
        await this.stopSession(adapterSessionId, false, true)
        throw new Error('Start ownership was withdrawn before session registration.')
      }

      if (!deferCoordinatorBinding) {
        this.updateTaskFromLocalAgent(taskId, { session_id: adapterSessionId })
        this.recordCoordinatorSessionAgent(taskId, agentId)
      }
      console.log(`[SessionTracker] CREATED session=${adapterSessionId} task=${taskId} agent=${agentId} reason=new_session`)

      // A replacement for a lost session is never started blank or silently.
      // A handoff already carries the full recap, so it only gets the notice.
      const lostSessionRecap = this.announceLostSessionReplacement(taskId, adapterSessionId)
      this.restoreCaptainHandoffSeed(this.sessions.get(adapterSessionId)!)
      const seedRecap = handoffFromAgentName ? '' : this.sessions.get(adapterSessionId)!.pendingRecap ?? lostSessionRecap

      // Triage sessions keep the Triaging status; coordinator rows have none.
      if (!isTriageSession && !isCoordinatorTask(task)) {
        this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.AgentWorking })
        this.sendToRenderer('task:updated', {
          taskId,
          updates: { status: TaskStatus.AgentWorking }
        })
      }
      await yieldEventLoop()
      this.taskGroupRequests.assertCurrent()

      if (!mayStart()) {
        await this.stopSession(adapterSessionId, false, true)
        throw new Error('Start ownership was withdrawn before prompt delivery.')
      }

      if (!deferCoordinatorBinding) {
        this.emitStatus(adapterSessionId, { agentId, taskId }, 'working')
        this.startAdapterPolling(adapterSessionId, adapter, sessionConfig)
      }

      if (!skipInitialPrompt) {
        let promptText: string
        if (isTriageSession && task) {
          promptText = buildTriagePrompt(task, this.projectRepoNames(task))
        } else {
          promptText = buildTaskWorkPrompt(this.db, taskId, task ?? this.db.getTask(taskId))
          const attachmentSession = this.sessions.get(adapterSessionId)!
          const attachmentRefs = await this.syncOwnedAttachments(taskId, workspaceDir, () => {
            if (!mayStart()) throw new Error('Start ownership was withdrawn before attachment publication.')
            this.assertSessionGeneration(adapterSessionId, attachmentSession)
          })
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
          const recap = this.taskRecap(taskId, sessionConfig.model, false, estimateTokens(promptText.length + 256))
          if (recap) {
            promptText = `## Picking up from ${handoffFromAgentName}\n\nThis task was previously being worked on by a different agent. Here is the conversation so far:\n\n${recap}\n\n---\n\n${promptText}`
          }
        } else if (seedRecap) {
          promptText = `${seedRecap}\n\n${promptText}`
        }

        if (managedTask && (handoffFromAgentName || seedRecap) && estimateTokens(promptText.length) > taskContextBudget(sessionConfig.model ?? ''))
          throw new Error('TASK_RECAP_INSTRUCTION_TOO_LARGE: task instructions and continuity do not fit intact; the transcript remains saved.')

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

        const startingSession = this.sessions.get(adapterSessionId)!
        const pendingLossId = startingSession.pendingLossId
        try {
          const send = () => this.sendTrackedPrompt(startingSession, adapterSessionId, promptText, sessionConfig)
          await serializeTaskSend(this, taskId, send)
          this.acknowledgeSessionRecap(startingSession, pendingLossId)
        } catch (sendError) {
          if (!this.taskGroupRequests.isCurrent()) throw sendError
          console.error(`[AgentManager] sendPrompt FAILED:`, sendError)
          const message = sendError instanceof Error ? sendError.message : String(sendError)
          const session = this.sessions.get(adapterSessionId)
          if (session && await this.tryProviderRecovery(adapterSessionId, session, classifyProviderFailure(sendError))) {
            return this.findSessionByTaskId(taskId)?.sessionId || adapterSessionId
          }
          if (task && this.startQueue.fail(taskId, 'unsafe_side_effect_unknown', 'prompt_delivery_unconfirmed', message)) {
            this.recordRecoveryAudit(task, 'unsafe_side_effect_unknown', 'terminal_failure', 'prompt_delivery_unconfirmed', message)
          }
          await this.stopSession(adapterSessionId, false)
          const currentTask = this.db.getTask(taskId)
          if (currentTask?.session_id === adapterSessionId && currentTask.status !== TaskStatus.Completed) {
            this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.NotStarted, session_id: null }, 'system')
          }
          throw sendError
        }
      }

      return adapterSessionId
    } catch (error) {
      if (!this.taskGroupRequests.isCurrent()) {
        if (acceptedSessionId && !scopedRetirementAttempted) {
          scopedRetirementAttempted = true
          await this.retireScopedAdapterSession(adapter, acceptedSessionId, { agentId, taskId, workspaceDir, secretSessionToken: secretToken })
          scopedSecretReleased = true
          const current = this.db.getTask(taskId)
          if (current?.session_id === acceptedSessionId) this.taskGroupRequests.detached(() => this.updateTaskFromLocalAgent(taskId, { session_id: null }, 'system'))
        }
        if (!creationStarted && !scopedRetirementAttempted && !scopedSecretReleased && secretToken && this.host.secrets.kind === 'broker') this.host.secrets.unregister(secretToken)
      }
      throw error
    }
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
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.startAdapterPolling(initialSessionId, adapter, config, existingSession))
    const owner = existingSession ?? this.sessions.get(initialSessionId)
    if (owner && !this.mayPollSessionGeneration(owner)) return
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
        if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => adapter.onDataAvailable?.(dataSessionId))
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
        if (!this.ownsSessionGeneration(targetId, session)) return
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
    this.activityObservations.forget(sessionId)
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

    const runTick = async (): Promise<void> => {
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

    const tick = (): Promise<void> => this.ownShutdownWork(runTick())

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
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.nudgePollingCoordinator())
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
    let polledSession: AgentSession | undefined

    try {
      let sessionId = this.resolvePollingSessionId(entry)
      const activeSession = this.sessions.get(sessionId)
      polledSession = activeSession
      if (!activeSession) {
        console.log(`[AgentManager] Session ${sessionId} no longer exists, removing from polling`)
        this.stopAdapterPolling(entry.sessionId)
        return
      }

      if (this.providerRecoveries.get(activeSession.taskId)?.state === 'retrying') return

      // Cleared immediately before the poll, so anything the adapter buffers
      // from here on is known to be undelivered even if this poll returns it
      // (at worst that costs one extra cycle; it can never lose a message).
      entry.dataArrivedSincePoll = false

      const polledIntentId = activeSession.managedIntentId
      const newParts = await adapter.pollMessages(
        sessionId,
        entry.seenMessageIds,
        entry.seenPartIds,
        entry.partContentLengths,
        config
      )
      // Stop/replacement may complete while the backend read is in flight.
      // An old lease cannot publish output or renew its successor's activity.
      sessionId = this.resolvePollingSessionId(entry)
      if (this.sessions.get(sessionId) !== activeSession || this.stoppingSessions.has(activeSession)) {
        if (this.managedEngine(activeSession)) await this.managedEngine(activeSession)!.observe(activeSession.taskId, activeSession.id,
          'stale_batch_dropped', `${this.managedEngine(activeSession)!.role}:${activeSession.taskId}:stale:${randomUUID()}`,
          { disposition: 'superseded_or_stopped', count: newParts.length, partIds: newParts.map((part) => part.id ?? null) })
        return
      }
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
      if (this.sessions.get(sessionId) !== activeSession || this.stoppingSessions.has(activeSession)) {
        if (this.managedEngine(activeSession)) await this.managedEngine(activeSession)!.observe(activeSession.taskId, activeSession.id,
          'stale_batch_dropped', `${this.managedEngine(activeSession)!.role}:${activeSession.taskId}:stale:${randomUUID()}`,
          { disposition: 'superseded_during_processing', count: newParts.length, partIds: newParts.map((part) => part.id ?? null) })
        return
      }
      const batchMessages = this.collectOutputBatch(entry, sessionId, newParts)
      const currentSession = this.sessions.get(sessionId)
      if (currentSession) this.captureSessionProgress(currentSession, batchMessages)
      if (batchMessages.length > 0) {
        this.sendToRenderer('agent:output-batch', {
          sessionId,
          taskId: config.taskId,
          messages: batchMessages
        })
        if (this.managedEngine(activeSession)) {
          if (polledIntentId && activeSession.managedIntentId === polledIntentId) this.managedEngine(activeSession)!.recordOutput(activeSession.taskId, sessionId, polledIntentId, batchMessages)
          const identity = createHash('sha256').update(JSON.stringify(batchMessages)).digest('hex')
          await this.managedEngine(activeSession)!.observe(activeSession.taskId, sessionId, 'output_batch',
            `${this.managedEngine(activeSession)!.role}:${activeSession.taskId}:${sessionId}:output:${identity}`,
            { parts: batchMessages.map((message) => ({ id: message.id, role: message.role, partType: message.partType })) }, polledIntentId)
          if (!this.ownsSessionGeneration(sessionId, activeSession) || this.shuttingDown) return
        }
      }

      const status = await adapter.getStatus(sessionId, config)
      const session = this.sessions.get(sessionId)
      if (session !== activeSession || this.stoppingSessions.has(activeSession)) return
      await this.pollCompactions(sessionId, activeSession, adapter, config)
      const contextUsage = await this.pollCaptainContextUsage(sessionId, activeSession, adapter, config)
      const managedIntentId = activeSession.managedIntentId === polledIntentId ? polledIntentId : undefined
      if (managedIntentId) await this.managedEngine(activeSession)?.pollUsage(activeSession.taskId, sessionId, managedIntentId, adapter, config, contextUsage,
        () => this.ownsSessionGeneration(sessionId, activeSession) && !this.shuttingDown && activeSession.managedIntentId === managedIntentId)
      if (this.shuttingDown || this.sessions.get(sessionId) !== activeSession || this.stoppingSessions.has(activeSession)) return

      if (status.type === SessionStatusType.ERROR) {
        await this.handleErrorStatus(sessionId, session, config, status, batchMessages, newParts.find((part) => part.type === MessagePartType.ERROR && part.providerFailure)?.providerFailure)
      } else if (status.type === SessionStatusType.WAITING_APPROVAL && session) {
        this.handleWaitingApprovalStatus(sessionId, session, config)
      } else if (status.type === SessionStatusType.BUSY && session) {
        await this.handleBusyStatus(sessionId, session, adapter, config, batchMessages)
      } else if (status.type === SessionStatusType.IDLE && session) {
        this.handleIdleStatus(sessionId, session)
      }

      // Both reads succeeded: the backend answered just now. Only this path
      // may renew the renderer's freshness deadline; a failed or hung poll
      // never reaches it (#95).
      this.publishActivityHeartbeat(sessionId)
    } catch (error: unknown) {
      console.error('[AgentManager] Adapter polling error:', error)
      const sessionId = this.resolvePollingSessionId(entry)
      const session = this.sessions.get(sessionId)
      if (session && session === polledSession && !this.shuttingDown && !this.stoppingSessions.has(session)) {
        if (isKnownActivityDisconnect(error)) this.publishActivityDisconnect(sessionId, session)
        this.handlePollingError(sessionId, session, error)
      }
    }
  }

  /** Backend compaction is an observational divider in this same backend
   * context. It never starts a replacement, recap, prompt or handoff. */
  private async pollCompactions(sessionId: string, session: AgentSession, adapter: CodingAgentAdapter, config: SessionConfig): Promise<void> {
    if (!adapter.getCompactionObservations || this.shuttingDown) return
    try {
      const observations = await adapter.getCompactionObservations(sessionId, config)
      if (this.shuttingDown || this.sessions.get(sessionId) !== session || this.stoppingSessions.has(session)) return
      const generationKey = this.managedEngine(session) ? this.managedEngine(session)!.generationKey(sessionId, session.taskId) : `adapter:${sessionId}`
      for (const observation of observations) {
        const effect = this.compactions.observe(observation, { ownerId: session.taskId, generationKey,
          backendSessionId: sessionId, backend: this.db.getAgent(session.agentId)?.config.coding_agent })
        if (!effect) continue
        const exists = this.db.db?.prepare('SELECT 1 FROM transcript_parts WHERE task_id = ? AND part_id = ?')
          .get(session.taskId, effect.part.id)
        if (!exists) {
          const messages: OutputMessage[] = [{ id: effect.part.id!, role: effect.part.role ?? 'system',
            content: effect.part.text ?? '', partType: effect.part.type, receivedAt: effect.part.receivedAt }]
          this.persistTranscriptEvent('agent:output-batch', { sessionId, taskId: session.taskId, messages })
        }
        if (this.compactionObserver) {
          // A historical signal may be read again after reconnect. Preserve
          // its original received timestamp/payload and projection identity.
          const prior = this.db.db.prepare('SELECT * FROM session_event_inbox WHERE idempotency_key = ?')
            .get(effect.idempotencyKey) as { owner_id: string; generation_key: string; backend_id: string | null;
              turn_key: string | null; event_type: string; engine: 'chat' | 'adapter'; payload: string; state: string } | undefined
          if (!prior || prior.state !== 'processed') {
            const input: SessionObservation = prior
              ? { ownerId: prior.owner_id, generationKey: prior.generation_key, backendId: prior.backend_id ?? undefined,
                  turnKey: prior.turn_key ?? undefined, engine: prior.engine, eventType: prior.event_type,
                  idempotencyKey: effect.idempotencyKey, payload: JSON.parse(prior.payload) }
              : { ownerId: session.taskId, generationKey, backendId: sessionId, engine: 'adapter',
                  eventType: effect.eventType, idempotencyKey: effect.idempotencyKey, payload: effect.payload }
            await this.compactionObserver.observe(input, true)
          }
        }
        this.compactions.acknowledge(effect.idempotencyKey)
        if (this.shuttingDown || this.sessions.get(sessionId) !== session || this.stoppingSessions.has(session)) return
      }
    } catch (error) {
      // Instrumentation failure retains the pending normalization for retry;
      // it cannot alter the existing provider/session recovery path.
      console.error('[AgentManager] Compaction observation failed:', error)
    }
  }

  private async pollCaptainContextUsage(sessionId: string, session: AgentSession, adapter: CodingAgentAdapter, config: SessionConfig): Promise<import('./adapters/coding-agent-adapter').AdapterContextUsage | null> {
    const engine = this.managedEngine(session)
    if (!engine || !adapter.getContextUsage || this.shuttingDown) return null
    try {
      const usage = await adapter.getContextUsage(sessionId, config)
      if (!usage || usage.backendSessionId !== sessionId || !this.ownsSessionGeneration(sessionId, session) || this.shuttingDown) return null
      await engine.observe(session.taskId, sessionId, 'context_usage',
        `${engine.role}:${session.taskId}:${sessionId}:context:${usage.eventKey}`,
        { tokens: usage.tokens, source: usage.provenance, model: config.model ?? null,
          contextWindow: modelContextWindow(config.model ?? ''), observedAt: usage.observedAt, turnId: usage.turnId ?? null })
      return usage
    } catch (error) { console.error('[AgentManager] Adapter context usage observation failed:', error); return null }
  }

  /**
   * Freshness heartbeat for an active session (#95): its current, unchanged
   * status, at most once per revalidation interval. Desktop observation sinks
   * bypass sendToRenderer and general external listeners, so notifications,
   * lastSentStatus, the voice bridge and mobile clients never see it.
   */
  private publishActivityHeartbeat(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !shouldPublishHeartbeat(session.status)) return
    if (!this.activityObservations.takeHeartbeat(sessionId)) return
    for (const taskId of this.taskGroupActivityTargets(session.taskId, session.status)) {
      const { epoch, seq } = this.activityObservations.stamp(true)
      this.sendActivityObservation({
        sessionId, agentId: session.agentId, taskId, status: session.status, epoch, seq, heartbeat: true
      })
    }
  }

  private publishActivityDisconnect(sessionId: string, session: AgentSession): void {
    this.activityObservations.forget(sessionId)
    for (const taskId of this.taskGroupActivityTargets(session.taskId, session.status)) {
      const { epoch, seq } = this.activityObservations.stamp(true)
      this.sendActivityObservation({ sessionId, agentId: session.agentId,
        taskId, status: session.status, epoch, seq, heartbeat: true, disconnected: true })
    }
  }

  private sendActivityObservation(event: AgentActivityObservation): void {
    if (this.shuttingDown) return
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.sendHostEvent(this.mainWindow.webContents, 'agent:status', event)
    for (const listener of [...this.activityListeners]) {
      try { listener(event) } catch { /* A detached desktop cannot interrupt polling. */ }
    }
  }

  private taskGroupActivityTargets(ownerId: string, status: AgentSession['status']): string[] {
    if (this.db.getTask(ownerId)?.role !== 'task_group') return [ownerId]
    const group = this.db.getTaskGroupByTask(ownerId)
    return [ownerId, ...(group ? this.db.getTaskGroupMembers(group.id)
      .filter(task => task.status !== TaskStatus.Completed && (status === 'idle'
        || [TaskStatus.AgentWorking, TaskStatus.Triaging, TaskStatus.AgentLearning].includes(task.status as TaskStatus)))
      .map(task => task.id) : [])]
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
    const intent = this.providerRecoveries.get(entry.config.taskId)
    if (intent?.sessionId === sessionId) this.providerRecoveries.change(intent, { sessionId: realSessionId })

    const session = this.sessions.get(sessionId)
    if (!session) return sessionId
    if (this.managedEngine(session)) this.retainCaptainObservation(this.managedEngine(session)!.rekeySession(session.taskId, sessionId, realSessionId))
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
            requestId: String(approval.requestId ?? approval.toolCallId),
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
    batchMessages: OutputMessage[],
    partFailure?: ProviderFailure
  ): Promise<void> {
    if (status.message?.includes('INCOMPATIBLE_SESSION_ID') || (this.managedEngine(session) && isLostCaptainSession(status.message))) {
      console.warn('[AgentManager] Incompatible session detected during polling:', sessionId)
      if (this.db.getTask(config.taskId)?.session_id !== sessionId) {
        this.stopAdapterPolling(sessionId)
        return
      }
      this.markSessionLost(config.taskId, sessionId, status.message)
      await this.stopSession(sessionId, false)
      if (this.db.getTask(config.taskId)?.session_id !== sessionId) return
      this.updateTaskFromLocalAgent(config.taskId, { session_id: null })
      if (session?.managedCaptain && !this.shuttingDown) {
        if (this.retryExclusion(this.db.getTask(config.taskId)) || this.startQueue.get(config.taskId)?.state === 'cancelled') return
        try { await this.recoverMessageSession(config.taskId, config.agentId) }
        catch { this.emitSystemError('', config.taskId, `captain-replacement-failed-${Date.now()}`,
          'The Captain conversation was lost. Its history and recap remain stored; retry from the Captain panel.') }
        return
      }
      this.sendToRenderer('agent:incompatible-session', {
        taskId: config.taskId,
        agentId: config.agentId,
        error: 'The backend session is no longer available. Start a new session to continue with a recap.'
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

    if (session && await this.tryProviderRecovery(sessionId, session,
      status.providerFailure ?? partFailure ?? classifyProviderFailure(status.message ?? 'Unknown provider failure'))) return

    if (session) {
      session.status = 'error'
      session.pollingStarted = false
      this.emitStatus(sessionId, config, 'error')
    }
    this.stopAdapterPolling(sessionId)
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
        this.host.isCodexAppServerAdapter(adapter)
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
      this.host.isCodexAppServerAdapter(adapter)
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
    const intent = this.providerRecoveries.get(session.taskId)
    if (intent?.state === 'accepted' && intent.sessionId === sessionId) this.providerRecoveries.change(intent, { state: 'completed', nextRetryAt: null })
    session.pollingStarted = false
    // Unregister FIRST so other sessions aren't starved while transitionToIdle
    // runs (it can be slow due to extractOutputValues); it is not awaited.
    this.stopAdapterPolling(sessionId)
    this.ownShutdownWork(this.transitionToIdle(sessionId, session)).catch((err) => {
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
    if (this.productionAdmissionMutation) throw new Error('Wait for CLI configuration changes before resuming a session.')
    this.assertAgentConfigurationAvailable(agentId)
    const agent = this.db.getAgent(agentId)!
    const originalTask = this.db.getTask(taskId)
    const managedCaptain = isManagedCaptain(originalTask, this.captainEngine?.enabled ?? false)
    const managedTask = isManagedTask(taskId, originalTask, this.taskEngine?.enabled ?? false)
    const engine = managedCaptain ? this.captainEngine : managedTask ? this.taskEngine : null
    const originalBinding = originalTask?.session_id
    const runtimeGeneration = this.captainRuntimes.get(taskId)?.generation

    // Use the same workspace resolution as startSession: try git worktree first,
    // then fall back to the default workspace dir. This is critical because Claude
    // Code stores session files under ~/.claude/projects/<encoded-workspaceDir>/,
    // so resuming with a different workspaceDir produces a different path and the
    // session file won't be found.
    const workspaceDir = await this.setupWorktreeIfNeeded(taskId) || this.db.getWorkspaceDir(taskId)

    this.taskGroupRequests.assertCurrent()
    // Pick up attachments added since the session was started/last resumed.
    await this.syncOwnedAttachments(taskId, workspaceDir, () => {
      this.assertAgentConfigurationAvailable(agentId)
      if (this.taskStops.has(taskId)) throw new Error('Resume attachment ownership was withdrawn.')
    })

    const task = this.db.getTask(taskId)
    await yieldEventLoop()
    this.taskGroupRequests.assertCurrent()

    const mcpScopeNonce = task && !isCoordinatorTask(task) ? this.db.rotateTaskMcpScopeNonce?.(taskId) ?? null : null
    const mcpServers = await this.buildMcpServersForAdapter(agentId, mcpOptionsForTask(
      taskId, task, this.heartbeatScopeTask(taskId, task), agentId, mcpScopeNonce
    ))
    this.taskGroupRequests.assertCurrent()
    // Resumed sessions must read current tool descriptions and assigned skills,
    // not workspace instructions left behind by an older app version.
    await this.ownShutdownWork(writeSkillFiles(this.db, taskId, agentId, workspaceDir, mcpServers, this.taskGroupRequests.capture()))
    // Task context in the system prompt survives context compaction.
    const taskContext = task && !isCoordinatorTask(task)
      ? `\n\n[Task Context]\nTask: "${task.title}"\n${task.description || ''}`
      : ''
    this.taskGroupRequests.assertCurrent()
    const secretToken = this.setupSecretSession(agentId)
    let resumedAccepted = false
    let resumptionStarted = false
    let resumedRetired = false
    try {
      const sessionConfig = assembleSessionConfig(this.db, agent, {
        agentId,
        taskId,
        task,
        workspaceDir,
        mcpServers,
        systemPrompt: (agent.config?.system_prompt || '') + taskContext,
        secretToken
      }, this.host)
      await yieldEventLoop()
      this.taskGroupRequests.assertCurrent()

      await this.initializeAndProbeAdapter(adapter, taskId, runtimeGeneration)

      let messages: SessionMessage[]
      try {
        this.taskGroupRequests.assertCurrent()
        console.log('[AgentManager] Calling adapter.resumeSession...')
        resumptionStarted = true
        messages = await withStartupDeadline(
          this.ownTaskStartup(taskId, engine
            ? engine.resumeSession(taskId, adapterSessionId, adapter, sessionConfig)
            : adapter.resumeSession(adapterSessionId, sessionConfig)),
          AGENT_SESSION_START_TIMEOUT_MS,
          'Agent session resume',
          () => this.ownShutdownWork(this.taskGroupRequests.detached(() => this.retireScopedAdapterSession(adapter, adapterSessionId, sessionConfig))).catch(error => console.error('[AgentManager] Late resume cleanup remains owned:', error))
        )
        resumedAccepted = true
        this.taskGroupRequests.assertCurrent()
        console.log('[AgentManager] adapter.resumeSession completed successfully')
      } catch (error: unknown) {
        this.taskGroupRequests.assertCurrent()
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.log('[AgentManager] adapter.resumeSession failed')

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
          if (this.shuttingDown || (originalTask && (!currentTask || currentTask.session_id !== originalBinding || currentTask.agent_id !== originalTask.agent_id || currentTask.project_id !== originalTask.project_id))) {
            throw new Error('Resume ownership changed before the backend reconnected.')
          }
          this.markSessionLost(taskId, adapterSessionId, errorMessage)
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
            userMessage = 'The backend session is incompatible. Start a new session to continue with a recap.'
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

      const readiness = await this.verifyAdapterSession(adapter, adapterSessionId, sessionConfig, taskId, true, runtimeGeneration)
      this.taskGroupRequests.assertCurrent()
      const currentTask = this.db.getTask(taskId)
      const runtime = this.captainRuntimes.get(taskId)
      const staleRuntime = runtimeGeneration !== undefined && (runtime?.generation !== runtimeGeneration
        || ['failed', 'timed_out', 'rolled_back'].includes(runtime.phase))
      if (this.shuttingDown || staleRuntime || (originalTask && (!currentTask || currentTask.session_id !== originalBinding))) {
        if (this.taskGroupRequests.scoped) {
          resumedRetired = true
          await this.retireScopedAdapterSession(adapter, adapterSessionId, sessionConfig)
        } else await this.ownShutdownWork(adapter.destroySession(adapterSessionId, sessionConfig)).catch(() => {})
        throw new Error('Resume ownership changed before the backend reconnected.')
      }
      const resumedStatus = readiness === SessionStatusType.WAITING_APPROVAL ? 'waiting_approval'
        : readiness === SessionStatusType.BUSY || readiness === SessionStatusType.RETRY ? 'working' : 'idle'

      // Seed the dedup state from the resumed history so polling won't re-emit
      // historical parts as new output. Resume does NOT push the transcript to
      // clients: they render the durable projection (snapshot +
      // `transcript:changed` deltas), which the one-time backfill seeds.
      const dedupState = dedupStateFromHistory(messages)

      // Reconnected busy/approval sessions still own capacity.
      this.schedulePowerSaveBlockerUpdate()
      this.sessions.set(adapterSessionId, {
        id: adapterSessionId,
        agentId,
        taskId,
        workspaceDir,
        status: resumedStatus,
        createdAt: new Date(),
        lastActivityAt: Date.now(),
        ...dedupState,
        adapter,
        pollingStarted: false,
        secretSessionToken: secretToken,
        fallbackAgentIds: normalizeFallbackAgentIds(agent.config?.fallback_agent_ids)
          .filter((id) => id !== agentId),
        attemptedAgentIds: new Set([agentId]),
        managedCaptain,
        managedTask,
        configuredModel: sessionConfig.model,
        configuredAgent: isCoordinatorTask(task) ? structuredClone(agent) : undefined
      })

      // A replacement may have restarted before its first prompt was accepted.
      this.announceLostSessionReplacement(taskId, adapterSessionId)
      this.restoreCaptainHandoffSeed(this.sessions.get(adapterSessionId)!)

      // Persist the resumed session binding and tell the renderer BEFORE any
      // follow-up prompt starts. Without this, a silent main-process resume
      // (e.g. an event-driven wake-up after the runtime was released) leaves the
      // renderer bound to a stale session id and the wake turn's output renders
      // late or not at all.
      this.updateTaskFromLocalAgent(taskId, { session_id: adapterSessionId })
      this.recordCoordinatorSessionAgent(taskId, agentId)
      this.sendToRenderer('task:updated', { taskId, updates: { session_id: adapterSessionId } })

      if (resumedStatus !== 'idle') {
        this.startAdapterPolling(adapterSessionId, adapter, sessionConfig, this.sessions.get(adapterSessionId))
        if (currentTask?.status !== TaskStatus.Completed) this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.AgentWorking })
      }
      this.emitStatus(adapterSessionId, { agentId, taskId }, resumedStatus)

      return adapterSessionId
    } catch (error) {
      if (this.taskGroupRequests.scoped && resumedAccepted && !resumedRetired) await this.retireScopedAdapterSession(adapter, adapterSessionId, { agentId, taskId, workspaceDir, secretSessionToken: secretToken })
      else if (!resumptionStarted && !resumedRetired && !this.taskGroupRequests.isCurrent() && secretToken && this.host.secrets.kind === 'broker') this.host.secrets.unregister(secretToken)
      throw error
    }
  }

  /**
   * A running agent must not pull a task back out of session learning, and a
   * coordinator row has no lifecycle at all: it is never working, in review or
   * done, only resumable. Its session_id still persists like any task's.
   */
  private updateTaskFromLocalAgent(taskId: string, updates: Parameters<DatabaseManager['updateTask']>[1], origin?: 'system'): TaskRecord | undefined {
    this.taskGroupRequests.assertCurrent()
    const fields = { ...updates }
    if (fields.status !== undefined) {
      const current = this.db.getTask(taskId)
      if (isCoordinatorTask(current)) delete fields.status
      else if (fields.status === TaskStatus.AgentWorking && current?.status === TaskStatus.AgentLearning) delete fields.status
    }
    if (Object.keys(fields).length === 0) return this.db.getTask(taskId)
    const before = fields.status !== undefined ? this.db.getTask(taskId)?.status : undefined
    const updated = origin ? this.db.updateTask(taskId, fields, origin) : this.db.updateTask(taskId, fields)
    if (updated?.role === 'task_group' && fields.status !== undefined) {
      const group = this.db.getTaskGroupByTask(taskId)
      if (group) for (const member of this.db.getTaskGroupMembers(group.id))
        this.sendToRenderer('task:updated', { taskId: member.id, updates: member })
    }
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
    if (this.productionAdmissionMutation) throw new Error('The agent configuration is being updated. Retry after it finishes.')
    this.taskGroupRequests.assertCurrent()
    const execution = this.taskGroupExecution(taskId)
    if (execution) { taskId = execution.id; agentId = execution.agent_id! }
    this.assertAgentConfigurationAvailable(agentId)
    this.assertNoTaskGroupMutation(taskId)
    return this.ownShutdownWork(this.requestSessionNow(agentId, taskId, workspaceDir, skipInitialPrompt))
  }

  private async requestSessionNow(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<SessionStartOutcome> {
    this.assertAgentConfigurationAvailable(agentId)
    this.assertNoTaskGroupMutation(taskId)
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
    const stopping = this.taskStops.get(taskId)
    if (stopping) {
      await stopping.promise
      throw new Error('The task finished stopping. Start it again to create a new session.')
    }
    const pending = this.sessionStarts.get(taskId)
    if (pending) return { status: 'started', sessionId: await pending }
    if (this.rawTaskStarts.has(taskId)) throw new Error('Native startup acknowledgement remains pending for this task.')
    const live = this.findSessionByTaskId(taskId)
    if (live && live.session.agentId === agentId && live.session.status !== 'idle' && live.session.status !== 'error') {
      return { status: 'started', sessionId: live.sessionId }
    }
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const task = this.db.getTask(taskId)
    let startClaim: ReturnType<DurableStartQueueStore['claim']> = null
    const recovery = this.startQueue.get(taskId)
    if (recovery?.state === 'failed' || recovery?.state === 'cancelled') {
      throw new Error(`Automatic start stopped: ${recovery.recoveryResult}. Send a message to explicitly continue this task.`)
    }
    if (task?.status === TaskStatus.Completed) throw new Error('Completed tasks cannot be started.')
    if (!isExemptFromAdmission(taskId, task)) {
      const alreadyQueued = this.startQueue.list().find((entry) => entry.taskId === taskId)
      if (alreadyQueued) {
        return { status: 'queued', position: alreadyQueued.position, reason: alreadyQueued.reason }
      }
      if (task && this.isSerialChainStart(taskId)) {
        const queued = this.startQueue.enqueue({
          taskId,
          agentId,
          workspaceDir,
          skipInitialPrompt,
          reason: 'dependency',
          queuedAt: new Date().toISOString(),
          projectId: taskProjectId(task),
          priority: task.priority,
          dependencyReason: 'predecessor_active'
        })
        this.emitStartQueueChanged()
        if (queued.added) this.recordRecoveryAudit(task, 'predecessor_active', 'queued', `queued_at_position_${queued.position}`)
        return { status: 'queued', position: queued.position, reason: 'dependency' }
      }
      const counted = this.countedSessions()
      const decision = checkAdmission({ agentId, taskId, task, agent }, counted, this.admissionLimits(task, agentId, counted))
      if (!decision.admitted) {
        const queued = this.startQueue.enqueue({
          taskId,
          agentId,
          workspaceDir,
          skipInitialPrompt,
          reason: decision.reason,
          queuedAt: new Date().toISOString(),
          projectId: taskProjectId(task),
          priority: task?.priority ?? null
        })
        const { position } = queued
        console.log(
          `[AgentManager] Start of task ${taskId} queued at position ${position}: ${decision.reason} ` +
          `(${decision.running}/${decision.limit} running)`
        )
        this.emitStartQueueChanged()
        if (queued.added && task) {
          this.recordRecoveryAudit(task, decision.reason, 'queued', `queued_at_position_${position}`)
        }
        this.tellCaptainAboutLimit(task, decision)
        return { status: 'queued', position, reason: decision.reason }
      }
      this.recordCountedStart(task)
      this.startQueue.markServed(task ? taskProjectId(task) : undefined)
    }

    // Triage remains exempt from capacity, but its initial prompt still needs
    // durable ownership so an unassigned task can be cancelled during startup.
    if (task && !isCoordinatorTask(task)) {
      this.startQueue.enqueue({ taskId, agentId, projectId: taskProjectId(task), workspaceDir,
        skipInitialPrompt, priority: task.priority, reason: 'recovery', queuedAt: new Date().toISOString() })
      startClaim = this.startQueue.claim(taskId, this.startQueueLeaseOwner)
      if (!startClaim || !this.startQueue.markStarting(startClaim.id, startClaim.generation)) {
        throw new Error('Start ownership could not be acquired.')
      }
      this.emitStartQueueChanged()
    }

    this.admittedStarts.set(taskId, agentId)
    const runtime = this.beginCaptainRuntime(task, agentId)
    let trackedStart: Promise<string> | undefined
    try {
      const starting = this.startSessionNow(agentId, taskId, workspaceDir, skipInitialPrompt)
      const timeout = isCoordinatorTask(task) ? CAPTAIN_START_TIMEOUT_MS : AGENT_START_TIMEOUT_MS
      const boundedStart = this.boundedSessionStart(starting, agent.name, taskId, timeout)
      trackedStart = boundedStart
      this.sessionStarts.set(taskId, boundedStart)
      const sessionId = await boundedStart
      // This is the receipt for an already accepted native start, not a new effect.
      if (startClaim && !this.startQueue.acknowledgeStarted(startClaim.id, startClaim.generation, sessionId)) {
        await this.stopSession(sessionId, false, true)
        throw new Error('Start ownership was withdrawn.')
      }
      if (startClaim) this.emitStartQueueChanged()
      return { status: 'started', sessionId }
    } catch (error) {
      if (!this.taskGroupRequests.isCurrent()) {
        if (startClaim) this.startQueue.cancel(taskId, 'caller_scope_withdrawn', 'request_cancelled_without_replay')
        throw error
      }
      // The reserved slot is free again (released in finally, before the
      // deferred drain runs).
      this.scheduleStartQueueDrain()
      // The renderer pre-registered a "starting" session before awaiting this
      // call, and the IPC rejection alone does not tell other bound views the
      // start failed. Surface the reason in the durable transcript and invalidate
      // the task so every view leaves "Agent is starting..." instead of sitting
      // there forever (e.g. the backend process died before it came up).
      const message = error instanceof Error ? error.message : String(error)
      if (runtime) {
        const timedOut = /timed out|did not come up/i.test(message)
        this.captainRuntimes.transition(taskId, runtime.generation, timedOut ? 'timed_out' : 'failed', {
          errorCode: timedOut ? 'STARTUP_TIMEOUT' : 'STARTUP_FAILED',
          errorDetail: message,
          probeOk: false,
          lastProbeAt: Date.now(),
          deadlineAt: null
        })
        if (runtime.lastGoodAgentId) {
          this.captainRuntimes.transition(taskId, runtime.generation, 'rolled_back', {
            agentId: runtime.lastGoodAgentId,
            candidateAgentId: agentId,
            errorCode: timedOut ? 'STARTUP_TIMEOUT' : 'STARTUP_FAILED',
            errorDetail: message,
            probeOk: false
          })
        }
      }
      console.error(`[AgentManager] Failed to start ${agent.name} for task ${taskId}:`, error)
      if (task && startClaim) {
        const current = this.startQueue.get(taskId)
        // A stopped or superseded attempt must not reset state or retry budgets.
        if (current?.generation === startClaim.generation && current.state === 'starting') {
          const exclusion = this.retryExclusion(this.db.getTask(taskId))
          if (exclusion) {
            this.startQueue.cancel(taskId, exclusion, 'excluded_failure_not_retried', message)
            this.recordRecoveryAudit(task, exclusion, 'exclude_from_retry', 'excluded_failure_not_retried', message)
          } else {
            this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.NotStarted, session_id: null }, 'system')
            if (task.status === TaskStatus.Triaging) {
              this.startQueue.fail(taskId, 'triage_start_failure', 'visible_terminal_failure', message)
              this.recordRecoveryAudit(task, 'triage_start_failure', 'terminal_failure', 'visible_terminal_failure', message)
            } else {
              const retried = this.startQueue.failOrRetry(startClaim.id, startClaim.generation, message)
              if (retried) this.recordRecoveryAudit(task, 'recoverable_start_failure', 'retry', retried.record.recoveryResult ?? 'retry_scheduled', message)
            }
          }
          this.emitStartQueueChanged()
          this.scheduleStartQueueDrain()
        }
      }
      this.emitSystemError('', taskId, `session-start-failed-${Date.now()}`, `Could not start ${agent.name}: ${message}`)
      this.emitStatus('', { agentId, taskId }, 'error')
      throw error
    } finally {
      this.admittedStarts.delete(taskId)
      if (this.sessionStarts.get(taskId) === trackedStart) this.sessionStarts.delete(taskId)
    }
  }

  /**
   * A Captain start that has not finished within CAPTAIN_START_TIMEOUT_MS is
   * reported as failed, so the drawer leaves "Agent is starting..." with the
   * reason and a retry instead of waiting forever. If the start does finish
   * later, that session is stopped: the caller has already been told it
   * failed and may be starting another.
   */
  private boundedSessionStart(starting: Promise<string>, agentName: string, taskId: string, timeoutMs: number): Promise<string> {
    this.ownTaskStartup(taskId, starting)
    return withStartupDeadline(starting, timeoutMs, `${agentName} startup`, (sessionId) => {
      console.warn(`[AgentManager] ${taskId} came up after its start timed out; stopping ${sessionId}`)
      if (sessionId) return this.ownShutdownWork(this.stopSession(sessionId, false))
      return undefined
    })
  }

  /** Starts without admission control — callers are exempt or already admitted. */
  private async startSessionNow(agentId: string, taskId: string, workspaceDir?: string, skipInitialPrompt?: boolean): Promise<string> {
    this.assertAgentConfigurationAvailable(agentId)
    this.assertNoTaskGroupMutation(taskId)
    const stopping = this.taskStops.get(taskId)
    if (stopping) {
      await stopping.promise
      throw new Error('The task finished stopping. Start it again to create a new session.')
    }
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const claim = this.startQueue.get(taskId)
    const runtime = this.captainRuntimes.get(taskId)
    const mayStart = (): boolean => {
      if (this.shuttingDown || this.taskLifecycleMutations.has(taskId) || this.taskGroupMutations.has(taskId)) return false
      if (this.agentConfigurationMutations.has(agentId) || this.backendConfigurationMutations.has(getAgentProvider(agent))) return false
      if (runtime) {
        const latest = this.captainRuntimes.get(taskId)
        if (latest?.generation !== runtime.generation || ['failed', 'timed_out', 'rolled_back'].includes(latest.phase)) return false
      }
      if (!claim || claim.state !== 'starting') return true
      const latest = this.startQueue.get(taskId)
      const task = this.db.getTask(taskId)
      return latest?.generation === claim.generation && latest.state === 'starting'
        && !!task && task.status !== TaskStatus.Completed
        && (!task.agent_id || task.agent_id === agentId)
        && !this.retryExclusion(task)
    }

    // A coordinator conversation outlives its runtime. Rejoin the live session
    // or resume the persisted one, so a restart (or a reaped runtime) continues
    // the same Captain conversation instead of opening a blank one.
    let task = this.db.getTask(taskId)
    if (isCoordinatorTask(task)) {
      this.beginCaptainRuntime(task, agentId)
      const retainedTarget = await this.recoverCreatedCaptainHandoff(taskId, agentId)
      if (retainedTarget) return retainedTarget
      const live = this.findSessionByTaskId(taskId)
      if (live && live.session.agentId === agentId) {
        if (!live.session.adapter) throw new Error(`Captain session ${live.sessionId} has no live adapter`)
        await this.verifyAdapterSession(live.session.adapter, live.sessionId, this.sessionConfigFor(live.session), taskId)
        return live.sessionId
      }
      // The Captain was switched to another agent: the old runtime must not
      // keep answering for it.
      if (live) {
        console.log(`[AgentManager] Captain ${taskId} switched from agent ${live.session.agentId} to ${agentId}; stopping ${live.sessionId}`)
        await this.stopSession(live.sessionId, false)
      }
      task = this.dropForeignCoordinatorSession(taskId, agentId)
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
    return this.startAdapterSession(adapter, agentId, taskId, workspaceDir, skipInitialPrompt, undefined, undefined, false, mayStart)
  }

  /** The real task a heartbeat pseudo-session checks, used only to scope its MCP tools. */
  private heartbeatScopeTask(taskId: string, task: TaskRecord | null | undefined): TaskRecord | undefined {
    if (task || !taskId.startsWith('heartbeat-')) return undefined
    return this.db.getTask(taskId.slice('heartbeat-'.length)) ?? undefined
  }

  /**
   * A Captain's persisted session belongs to the agent that made it. Another
   * agent cannot continue it: a different backend fails (Claude Code even
   * accepts a Codex thread id and only fails at the first message, losing it),
   * and the user switched agents on purpose. Clears it so a fresh session
   * starts; a session recorded before this binding existed is left to the
   * resume attempt. Returns the task as it is now.
   */
  private dropForeignCoordinatorSession(taskId: string, agentId: string): TaskRecord | undefined {
    const task = this.db.getTask(taskId) ?? undefined
    if (!isCoordinatorTask(task) || !task?.session_id) return task
    const owner = this.db.getSetting(coordinatorSessionAgentKey(taskId))
    if (!owner || owner === agentId) return task
    console.log(`[AgentManager] Captain ${taskId}: session ${task.session_id} was made by agent ${owner}, not ${agentId}; starting a new one`)
    return this.updateTaskFromLocalAgent(taskId, { session_id: null })
  }

  /** Records which agent a coordinator row's session runs on (see dropForeignCoordinatorSession). */
  private recordCoordinatorSessionAgent(taskId: string, agentId: string): void {
    if (isCoordinatorTask(this.db.getTask(taskId))) this.db.setSetting(coordinatorSessionAgentKey(taskId), agentId)
  }

  /**
   * The project's Captain agent changed (project editor, Captain drawer or the
   * Commander). Stops a live Captain session that runs on another agent, so
   * nothing keeps delivering to it; the next message or warm-up starts the new
   * agent. Returns whether a session was stopped.
   */
  async releaseCaptainIfAgentChanged(projectId: string): Promise<boolean> {
    const project = this.db.getProject(projectId)
    const coordinator = this.db.getCoordinatorTask(projectId)
    if (!project || !coordinator) return false
    const live = this.findSessionByTaskId(coordinator.id)
    const agentId = resolveCaptainAgentId(this.db, project)
    if (!live || !agentId || live.session.agentId === agentId) return false
    console.log(`[AgentManager] Captain agent of ${projectId} is now ${agentId}; stopping ${live.sessionId} on ${live.session.agentId}`)
    await this.stopSession(live.sessionId, false)
    return true
  }

  /**
   * Starts and verifies a Captain candidate without changing the project's
   * selected agent or stopping the last-known-good runtime. Only the final
   * SQLite transaction commits the candidate and its session binding.
   */
  switchCaptainAgent(projectId: string, candidateAgentId: string, retry = false): Promise<CaptainRuntimeState> {
    const captain = this.db.getCoordinatorTask(projectId)
    try { if (captain) this.assertNoTaskGroupMutation(captain.id) }
    catch (error) { return Promise.reject(error) }
    const active = this.captainSwitches.get(projectId)
    if (active) {
      if (active.agentId === candidateAgentId) return active.promise
      return Promise.reject(new Error('A Captain switch is already in progress. Wait for it or roll back.'))
    }
    const promise = this.switchCaptainAgentNow(projectId, candidateAgentId, retry)
      .finally(() => this.captainSwitches.delete(projectId))
    this.captainSwitches.set(projectId, { agentId: candidateAgentId, promise })
    return promise
  }

  private async switchCaptainAgentNow(projectId: string, candidateAgentId: string, retry: boolean): Promise<CaptainRuntimeState> {
    this.assertAgentConfigurationAvailable(candidateAgentId)
    const project = this.db.getProject(projectId)
    const coordinator = this.db.getCoordinatorTask(projectId)
    const candidate = this.db.getAgent(candidateAgentId)
    if (!project || !coordinator) throw new Error(`Project Captain not found: ${projectId}`)
    if (!candidate) throw new Error(`Agent not found: ${candidateAgentId}`)

    const currentAgentId = resolveCaptainAgentId(this.db, project)
    this.assertAgentConfigurationAvailable(currentAgentId ?? undefined)
    if (currentAgentId === candidateAgentId && !retry) {
      const existing = this.captainRuntimes.get(coordinator.id)
      if (existing) return existing
    }

    const oldLive = [...this.sessions.entries()].find(([, session]) =>
      session.taskId === coordinator.id && session.agentId === currentAgentId
    )
    const runtime = this.captainRuntimes.begin({
      ownerId: coordinator.id,
      projectId,
      agentId: candidateAgentId,
      lastGoodAgentId: currentAgentId,
      deadlineAt: Date.now() + CAPTAIN_START_TIMEOUT_MS,
      retry
    })

    let candidateSessionId = ''
    try {
      const mayStart = (): boolean => {
        const latest = this.captainRuntimes.get(coordinator.id)
        return !this.shuttingDown && latest?.generation === runtime.generation
          && !['failed', 'timed_out', 'rolled_back'].includes(latest.phase)
      }
      const starting = (async () => {
        const workspaceDir = await this.setupWorktreeIfNeeded(coordinator.id)
        if (!mayStart()) throw new Error('Captain switch ownership was withdrawn.')
        const adapter = this.getAdapter(candidateAgentId)
        if (!adapter) throw new Error(`No adapter available for agent ${candidateAgentId}`)
        return this.startAdapterSession(adapter, candidateAgentId, coordinator.id, workspaceDir, true, undefined, undefined, true, mayStart)
      })()
      candidateSessionId = await this.boundedSessionStart(
        starting,
        candidate.name,
        coordinator.id,
        CAPTAIN_START_TIMEOUT_MS
      )

      const latest = this.captainRuntimes.get(coordinator.id)
      if (!latest || latest.generation !== runtime.generation) {
        await this.stopSession(candidateSessionId, false)
        throw new Error('This Captain switch was superseded by a newer attempt.')
      }

      this.db.db.transaction(() => {
        const now = new Date().toISOString()
        this.db.db.prepare('UPDATE projects SET captain_agent_id = ?, updated_at = ? WHERE id = ?')
          .run(candidateAgentId, now, projectId)
        this.db.db.prepare('UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?')
          .run(candidateSessionId, now, coordinator.id)
        this.db.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .run(coordinatorSessionAgentKey(coordinator.id), candidateAgentId)
        this.captainRuntimes.transition(coordinator.id, runtime.generation, 'healthy', {
          agentId: candidateAgentId,
          candidateAgentId: null,
          lastGoodAgentId: candidateAgentId,
          sessionId: candidateSessionId,
          deadlineAt: null,
          lastProbeAt: Date.now(),
          probeOk: true,
          errorCode: null,
          errorDetail: null
        })
      })()

      const committed = this.sessions.get(candidateSessionId)!
      this.emitStatus(candidateSessionId, committed, 'working')
      this.startAdapterPolling(candidateSessionId, committed.adapter!, this.sessionConfigFor(committed))
      if (oldLive && oldLive[0] !== candidateSessionId) void this.stopSession(oldLive[0], false).catch((error) => console.warn('[Captain] Old runtime cleanup failed:', error))
      this.sendToRenderer('task:updated', { taskId: coordinator.id, updates: { session_id: candidateSessionId } })
      return this.captainRuntimes.get(coordinator.id)!
    } catch (error) {
      if (candidateSessionId && this.sessions.has(candidateSessionId)) await this.stopSession(candidateSessionId, false)
      const detail = error instanceof Error ? error.message : String(error)
      const timedOut = /timed out/i.test(detail)
      this.captainRuntimes.transition(coordinator.id, runtime.generation, timedOut ? 'timed_out' : 'failed', {
        errorCode: timedOut ? 'STARTUP_TIMEOUT' : 'STARTUP_FAILED',
        errorDetail: detail,
        probeOk: false,
        lastProbeAt: Date.now(),
        deadlineAt: null
      })
      if (currentAgentId) {
        const rolledBack = this.captainRuntimes.transition(coordinator.id, runtime.generation, 'rolled_back', {
          agentId: currentAgentId,
          candidateAgentId,
          lastGoodAgentId: currentAgentId,
          sessionId: oldLive?.[0] ?? coordinator.session_id ?? null,
          errorCode: timedOut ? 'STARTUP_TIMEOUT' : 'STARTUP_FAILED',
          errorDetail: detail,
          // Keeping the previous session is not a fresh readiness probe.
          probeOk: oldLive?.[1].status === 'error' ? false : null
        })
        if (rolledBack) return rolledBack
      }
      const failed = this.captainRuntimes.get(coordinator.id)
      if (failed) return failed
      throw error
    }
  }

  async retryCaptainSwitch(projectId: string): Promise<CaptainRuntimeState> {
    const runtime = this.captainRuntimes.getByProject(projectId)
    const candidate = runtime?.candidateAgentId
    if (!candidate) throw new Error('There is no failed Captain candidate to retry.')
    return this.switchCaptainAgent(projectId, candidate, true)
  }

  rollbackCaptainSwitch(projectId: string): CaptainRuntimeState {
    const runtime = this.captainRuntimes.getByProject(projectId)
    if (!runtime?.lastGoodAgentId) throw new Error('There is no last-known-good Captain to restore.')
    this.assertNoTaskGroupMutation(runtime.ownerId)
    const project = this.db.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    this.db.updateProject(projectId, { captain_agent_id: runtime.lastGoodAgentId })
    const cancelled = this.captainRuntimes.begin({ ownerId: runtime.ownerId, projectId,
      agentId: runtime.lastGoodAgentId, lastGoodAgentId: runtime.lastGoodAgentId, deadlineAt: Date.now() })
    return this.captainRuntimes.transition(runtime.ownerId, cancelled.generation, 'rolled_back', {
      sessionId: this.db.getTask(runtime.ownerId)?.session_id ?? null,
      deadlineAt: null,
      candidateAgentId: runtime.candidateAgentId,
      agentId: runtime.lastGoodAgentId,
      errorCode: runtime.errorCode ?? 'ROLLED_BACK',
      errorDetail: runtime.errorDetail ?? 'Restored the last-known-good Captain.'
    })!
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
      if (this.managesCaptain(taskId) && !isLostCaptainSession(error)) throw error
      console.warn(`[AgentManager] Could not resume coordinator session ${sessionId} for ${taskId}; starting a new one`)
      if (!this.pendingSessionLoss(taskId)) {
        this.markSessionLost(taskId, sessionId, error instanceof Error ? error.message : String(error))
      }
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
    this.assertAgentConfigurationAvailable(newAgentId)
    taskId = this.taskGroupExecution(taskId)?.id ?? taskId
    this.assertNoTaskGroupMutation(taskId)
    return this.switchAgentWithContext(taskId, newAgentId)
  }

  private async switchAgentWithContext(
    taskId: string,
    newAgentId: string,
    fallbackState?: AgentFallbackState
  ): Promise<string> {
    this.assertAgentConfigurationAvailable(newAgentId)
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

    if (this.managesTask(taskId)) this.taskRecap(taskId, newAgent.config.model, false, this.taskHandoffReservedTokens(taskId))

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

  /**
   * `resumeManualStop` lets an explicit start reverse an earlier explicit stop.
   * `explicitUserStart` is for a person's own start (desktop, mobile): it also
   * lifts an automatic start that recovery stopped, e.g. after a failure with
   * an unfinished tool call. The agent task API never sets it.
   */
  async startTask(taskId: string, opts?: { preferSubtasks?: boolean; allowTriage?: boolean; resumeManualStop?: boolean; explicitUserStart?: boolean }): Promise<{
    /** `queued`: over a concurrency limit; it starts on its own when a slot frees. */
    action: 'task_started' | 'subtask_started' | 'triage_started' | 'already_running' | 'queued' | 'no_action'
    sessionId?: string
    startedTaskId?: string
    agentId?: string
    /** 1-based place in the start queue when `action` is `queued`. */
    queuePosition?: number
    queueReason?: AdmissionReason
  }> {
    this.taskGroupRequests.assertCurrent()
    const execution = this.taskGroupExecution(taskId)
    if (execution && execution.id !== taskId) return this.startTask(execution.id, opts)
    this.assertNoTaskGroupMutation(taskId)
    const task = this.db.getTask(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    const stopping = this.taskStops.get(taskId)
    if (stopping) {
      return {
        action: 'already_running',
        sessionId: stopping.sessionId,
        startedTaskId: taskId,
        agentId: stopping.session.agentId
      }
    }

    // An explicit UI/API start may reverse an earlier explicit stop, and a
    // person's own start may also lift any stopped automatic start. Automatic
    // schedulers omit both flags, so those exclusions remain terminal until
    // the user actually asks to run the task again.
    const requestSelectedTask = (selected: TaskRecord, selectedAgentId = selected.agent_id!): Promise<SessionStartOutcome> => {
      const recovery = this.startQueue.get(selected.id)
      const stopped = recovery?.state === 'cancelled' || recovery?.state === 'failed'
      const lifted = opts?.explicitUserStart
        ? stopped
        : opts?.resumeManualStop && recovery?.state === 'cancelled' && recovery.recoveryCause === 'manual_stop'
      if (lifted) {
        const queued = this.startQueue.enqueue({
          taskId: selected.id,
          projectId: taskProjectId(selected),
          agentId: selectedAgentId,
          reason: 'recovery',
          queuedAt: new Date().toISOString(),
          priority: selected.priority,
          dependencyReason: this.isSerialChainStart(selected.id) ? 'predecessor_active' : null
        })
        this.recordRecoveryAudit(selected, 'explicit_user_restart', 'requeue', `queued_at_position_${queued.position}`)
        this.emitStartQueueChanged()
        this.scheduleStartQueueDrain()
      }
      return this.requestSession(selectedAgentId, selected.id)
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
        const outcome = await requestSelectedTask(nextSubtask)
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
      const outcome = await requestSelectedTask(task, defaultAgentId)
      const sessionId = outcome.status === 'started' ? outcome.sessionId : ''
      return {
        action: 'triage_started',
        sessionId,
        startedTaskId: taskId,
        agentId: defaultAgentId
      }
    }

    const outcome = await requestSelectedTask(task)
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
  async sendHeartbeatViaCaptain(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    this.assertWorkspaceCleanupAvailable()
    this.taskGroupRequests.assertCurrent()
    const heartbeatTaskId = `heartbeat-${taskId}`

    let sessionId = this.findSessionByTaskId(heartbeatTaskId)?.sessionId
    if (!sessionId) {
      // The real task's workspace dir gives the agent repo context.
      const workspaceDir = this.db.getWorkspaceDir(taskId)
      this.taskGroupRequests.assertCurrent()
      console.log(`[AgentManager] Heartbeat: creating heartbeat session for task ${taskId}`)
      sessionId = await this.startSessionNow(agentId, heartbeatTaskId, workspaceDir, true /* skipInitialPrompt */)
      this.taskGroupRequests.assertCurrent()
    }

    console.log(`[AgentManager] Heartbeat: sending check via heartbeat session ${sessionId} for task ${taskId}`)
    const result = await this.sendMessage(sessionId, heartbeatPrompt, heartbeatTaskId, agentId, undefined, undefined, taskId)
    this.taskGroupRequests.assertCurrent()
    return result.newSessionId || sessionId
  }

  /**
   * Send action findings to the task agent's own session.
   * Only called when captain detected something that needs the task agent to act on.
   */
  async startHeartbeatSession(agentId: string, taskId: string, heartbeatPrompt: string): Promise<string> {
    this.assertWorkspaceCleanupAvailable()
    this.taskGroupRequests.assertCurrent()
    const task = this.db.getTask(taskId)
    let sessionId = task?.session_id

    if (!sessionId) {
      console.log(`[AgentManager] Heartbeat: no session for task ${taskId}, creating new session`)
      // Heartbeat follow-ups act on work already under way; they bypass admission.
      sessionId = await this.startSessionNow(agentId, taskId, undefined, true /* skipInitialPrompt */)
      this.taskGroupRequests.assertCurrent()
    }

    console.log(`[AgentManager] Heartbeat: forwarding action to task session ${sessionId} for task ${taskId}`)
    // sendMessage resumes a dead session, sends the prompt and starts polling.
    const result = await this.sendMessage(sessionId, heartbeatPrompt, taskId, agentId)
    this.taskGroupRequests.assertCurrent()
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
  async cleanupHeartbeatSession(taskId: string, requireAcknowledgement = false): Promise<void> {
    const found = this.findSessionByTaskId(`heartbeat-${taskId}`)
    if (!found) return
    await this.stopSession(found.sessionId, false, requireAcknowledgement)
    console.log(`[AgentManager] Cleaned up heartbeat session ${found.sessionId} for task ${taskId}`)
  }

  /**
   * Find a session by its taskId. Returns the current session ID and session object.
   * Used by HeartbeatScheduler to recover from session ID re-keying: when the adapter
   * provides a real session ID, pollSingleSession re-keys the sessions map, but
   * waitForSessionResult still holds the old temp ID. This method looks up by taskId
   * which is stable across re-keying.
   */
  findSessionByTaskId(taskId: string, store: Pick<DatabaseManager, 'getTask'> = this.db): { sessionId: string; session: AgentSession } | undefined {
    const task = store.getTask(taskId)
    if (isCoordinatorTask(task) && task?.session_id) {
      const bound = this.sessions.get(task.session_id)
      if (bound?.taskId === taskId) return { sessionId: task.session_id, session: bound }
    }
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
    if (this.taskStops.has(taskId)) return true
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
    this.scheduleStartQueueDrain()
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
      // project's Captain, not only the parent coordinator.
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
    return this.ownShutdownWork(this.readTranscriptSnapshot(taskId, sinceSeq))
  }

  private async readTranscriptSnapshot(taskId: string, sinceSeq?: number): Promise<ReturnType<DatabaseManager['getTranscriptParts']>> {
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
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
    return this.ownShutdownWork(this.readTranscriptDelta(taskId, sinceRev))
  }

  private async readTranscriptDelta(taskId: string, sinceRev: number): Promise<ReturnType<DatabaseManager['getTranscriptDelta']>> {
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
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
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
    const session = this.findSessionByTaskId(taskId)?.session
    if (!session?.adapter?.getAllMessages) return null
    return this.ownShutdownWork(session.adapter.getAllMessages(session.id, this.sessionConfigFor(session)))
  }

  /** Raw transcript for the renderer's hidden "Copy Debug Info" feature. */
  async getRawTranscriptForDebug(taskId: string, options: { requireAvailable?: boolean } = {}): Promise<DebugTranscriptMessage[]> {
    try {
      return debugTranscript(await this.getLiveMessages(taskId) ?? [])
    } catch (err) {
      if (options.requireAvailable) throw err
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
   * its provider status (history is not replayed; clients render the durable projection).
   */
  async resumeSession(agentId: string, taskId: string, sessionId: string): Promise<string> {
    this.taskGroupRequests.assertCurrent()
    if (this.productionAdmissionMutation) throw new Error('Wait for CLI configuration changes before starting work.')
    const execution = this.taskGroupExecution(taskId)
    if (execution) {
      if (execution.session_id !== sessionId) throw new Error('The native session does not belong to this task group.')
      taskId = execution.id; agentId = execution.agent_id!
    }
    this.assertNoTaskGroupMutation(taskId)
    return this.ownShutdownWork(this.resumeSessionNow(agentId, taskId, sessionId))
  }

  private async resumeSessionNow(agentId: string, taskId: string, sessionId: string): Promise<string> {
    this.assertAgentConfigurationAvailable(agentId)
    this.assertNoTaskGroupMutation(taskId)
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
    console.log('[AgentManager] resumeSession called:', { agentId, taskId, sessionId })
    const stopping = this.taskStops.get(taskId)
    if (stopping) {
      await stopping.promise
      throw new Error('The task finished stopping. Start it again to resume its session.')
    }
    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const adapter = this.getAdapter(agentId)
    if (!adapter) {
      throw new Error(`No adapter available for agent ${agentId}`)
    }

    const pending = this.sessionStarts.get(taskId)
    if (pending) return pending
    if (this.rawTaskStarts.has(taskId)) throw new Error('Native startup acknowledgement remains pending for this task.')
    if (isCoordinatorTask(this.db.getTask(taskId))) {
      const retainedTarget = await this.recoverCreatedCaptainHandoff(taskId, agentId)
      if (retainedTarget) return retainedTarget
    }
    const live = this.findSessionByTaskId(taskId)
    if (live && live.session.status !== 'error') return live.sessionId
    const resumed = this.ownTaskStartup(taskId, this.resumeAdapterSession(adapter, agentId, taskId, sessionId))
    this.sessionStarts.set(taskId, resumed)
    try {
      return await resumed
    } finally {
      if (this.sessionStarts.get(taskId) === resumed) this.sessionStarts.delete(taskId)
      this.scheduleStartQueueDrain()
    }
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
    if (!session.adapter || !this.mayPollSessionGeneration(session)) return

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
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return
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
      this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.NotStarted, session_id: null }, 'system')
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
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return

    if (session.adapter) {
      try {
        const statusAfterReplay = await session.adapter.getStatus(sessionId, this.sessionConfigFor(session))
        if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return
        if (statusAfterReplay.type === SessionStatusType.ERROR) {
          await this.handleErrorStatus(sessionId, session, this.sessionConfigFor(session), statusAfterReplay, [])
          return
        }
        if (statusAfterReplay.type !== SessionStatusType.IDLE) {
          console.log(
            `[AgentManager] Idle transition for ${sessionId} deferred after replay: replayed=${replayedPartCount}, adapterStatus=${statusAfterReplay.type}`
          )
          this.resumeAdapterPollingAfterPrematureIdle(sessionId, session)
          return
        }
      } catch (err) {
        console.error(`[AgentManager] Failed to re-check adapter status before idle for ${sessionId}:`, err)
        if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return
        if (isKnownActivityDisconnect(err)) this.publishActivityDisconnect(sessionId, session)
        this.resumeAdapterPollingAfterPrematureIdle(sessionId, session)
        return
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
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return

    if (!task || isCoordinatorTask(task)) {
      console.log(`[AgentManager] No lifecycle for ${session.taskId}, sending idle status only`)
      this.emitStatus(sessionId, session, 'idle', 'completed')
      if (task && isCoordinatorTask(task)) await this.maybeRolloverCaptain(sessionId, session)
      return
    }

    console.log(`[AgentManager] transitionToIdle checking task status: ${task.status} (looking for ${TaskStatus.AgentLearning})`)
    if (task.status === TaskStatus.AgentLearning) {
      console.log(`[AgentManager] Task in learning mode, syncing skills and marking as completed`)
      if (task.session_id !== sessionId || task.agent_id !== session.agentId) return
      const intentKey = `session-feedback-completion:${session.taskId}`
      const learningIntent = this.db.getSetting(intentKey)
      const binding = { projectId: task.project_id, agentId: task.agent_id, sourceId: task.source_id, sessionId: task.session_id }
      const currentLearningTask = (): TaskRecord | undefined => {
        if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return undefined
        const current = this.db.getTask(session.taskId)
        return current && current.project_id === binding.projectId && current.agent_id === binding.agentId && current.source_id === binding.sourceId && current.session_id === binding.sessionId ? current : undefined
      }

      try {
        await this.syncSkillsFromWorkspace(sessionId)
      } catch (err) {
        console.error(`[AgentManager] Skill sync error:`, err)
        const current = currentLearningTask()
        if (!current || current.status !== TaskStatus.AgentLearning || this.db.getSetting(intentKey) !== learningIntent) return
        updateTaskFromUser(this.db, session.taskId, {status: TaskStatus.ReadyForReview})
        const saved = currentLearningTask()
        if (!saved) return
        this.sendToRenderer('task:updated', { taskId: session.taskId, updates: { status: saved.status, updated_at: saved.updated_at, last_activity_at: saved.last_activity_at ?? null } })
        if (!currentLearningTask()) return
        this.emitStatus(sessionId, session, 'idle')
        return
      }
      await yieldEventLoop()

      const beforeFeedback = currentLearningTask()
      if (!beforeFeedback || beforeFeedback.status !== TaskStatus.AgentLearning || this.db.getSetting(intentKey) !== learningIntent) return
      try {
        const completed = await finishSessionFeedback(this.db, this.syncManager, session.taskId, () => {
          this.assertSessionGeneration(sessionId, session)
          if (!currentLearningTask()) throw new SessionFeedbackOwnershipChangedError()
        })
        if (!currentLearningTask()) return
        if (completed?.parent_task_id) {
          await this.notifyParentOfSubtaskCompletion(completed.parent_task_id, session.taskId)
        }
        if (!completed) {
          const current = currentLearningTask()
          if (!current || current.status !== TaskStatus.AgentLearning || this.db.getSetting(intentKey) !== learningIntent) return
          this.updateTaskFromLocalAgent(session.taskId, {status: TaskStatus.ReadyForReview})
        }
      } catch (error) {
        if (error instanceof SessionFeedbackOwnershipChangedError) return
        const currentTask = currentLearningTask()
        if (!currentTask) return
        this.sendToRenderer('task:source-action-failed', {taskId: session.taskId, taskTitle: currentTask.title, error: error instanceof Error ? error.message : String(error)})
      }
      const saved = currentLearningTask()
      if (!saved) return
      this.sendToRenderer('task:updated', { taskId: session.taskId, updates: { status: saved.status, updated_at: saved.updated_at, last_activity_at: saved.last_activity_at ?? null } })
      if (!currentLearningTask()) return
      this.emitStatus(sessionId, session, 'idle')
      return
    }

    try {
      await this.extractOutputValues(sessionId)
    } catch (err) {
      console.error(`[AgentManager] extractOutputValues error:`, err)
    }
    await yieldEventLoop()
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return

    // The frontend may have completed the task during the feedback flow meanwhile.
    const taskAfterExtract = this.db.getTask(session.taskId)
    await yieldEventLoop()
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return

    if (taskAfterExtract?.status === TaskStatus.AgentLearning || taskAfterExtract?.status === TaskStatus.Completed) {
      console.log(`[AgentManager] Task already in final state (${taskAfterExtract.status}), skipping status update`)
      this.emitStatus(sessionId, session, 'idle')
      return
    }

    // Desktop agent work is help: it goes to review. Only the server can accept completion.
    console.log(`[AgentManager] Updating task ${session.taskId} status to ReadyForReview`)
    this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.ReadyForReview })
    await yieldEventLoop()
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return

    this.autoEnableHeartbeat(session.taskId)
    await yieldEventLoop()
    if (this.shuttingDown || !this.ownsSessionGeneration(sessionId, session)) return

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
  private captainHandoffTurns(taskId: string): HandoffTurn[] {
    return this.db.getTranscriptParts(taskId).map((part) => {
      const tool = part.tool as { name?: string; status?: string } | undefined
      return { ...part, id: part.partId,
        ...(tool?.name ? { toolName: tool.name } : {}), ...(tool?.status ? { state: tool.status } : {}) }
    })
  }

  /** A saved rollover create wins over generic lost-session recovery. The
   * source may already have been torn down before its binding transaction
   * committed; recreating from that missing source would duplicate a backend. */
  private async recoverCreatedCaptainHandoff(taskId: string, agentId: string): Promise<string | null> {
    const record = this.captainRollover?.pendingCreation(taskId)
    if (!record) return null
    if (record.state !== 'created' || !record.targetBackendId)
      throw new Error('Captain rollover creation is unconfirmed. Reconcile its native identity before starting another backend; source history is retained.')
    const saved = record.source as typeof record.source & { agentId?: string; codingAgent?: string }
    const ownerAgent = saved.agentId ?? this.db.getSetting(coordinatorSessionAgentKey(taskId))
    const agent = this.db.getAgent(agentId)
    if (!agent || (ownerAgent && ownerAgent !== agentId) || (saved.codingAgent && saved.codingAgent !== agent.config.coding_agent))
      throw new Error('The accepted Captain rollover belongs to another agent. Its native identity is retained for reconciliation.')
    if (!this.captainRollover!.activationEnabled || this.startQueue.get(taskId)?.state === 'cancelled' || this.retryExclusion(this.db.getTask(taskId)))
      throw new Error('The accepted Captain rollover is retained behind the managed-session or manual-stop controls.')
    const binding = this.db.getTask(taskId)?.session_id
    const live = this.findSessionByTaskId(taskId)
    if (live && live.session.status !== 'idle') return null
    const adapter = live?.session.adapter ?? this.getAdapter(agentId)
    if (!adapter) throw new Error('The saved Captain rollover adapter is unavailable')
    const sourceId = binding ?? record.source.backendId ?? ''
    const source: AgentSession = live?.session ?? { id: sourceId, taskId, agentId, workspaceDir: record.source.workspaceDir,
      status: 'idle', createdAt: new Date(), seenMessageIds: new Set(), seenPartIds: new Set(), partContentLengths: new Map(),
      adapter, fallbackAgentIds: [], attemptedAgentIds: new Set([agentId]), managedCaptain: true,
      configuredModel: record.model, configuredAgent: structuredClone(agent) }
    const safe = (): boolean => !this.shuttingDown && !this.taskStops.has(taskId)
      && this.startQueue.get(taskId)?.state !== 'cancelled' && !this.retryExclusion(this.db.getTask(taskId))
      && (this.db.getTask(taskId)?.session_id === binding || this.db.getTask(taskId)?.session_id === record.targetBackendId)
    const result = await serializeTaskSend(this, taskId, () => this.captainRollover!.consider({ ...record.source, agent,
      agentId, codingAgent: agent.config.coding_agent }, {
      mayContinue: safe,
      createGeneration: async () => { throw new Error('An accepted Captain rollover must never create another backend') },
      bindGeneration: (savedRecord, signal) => this.bindCaptainRollover(sourceId, source, savedRecord, signal),
      notice: (savedRecord, message) => { if (!this.shuttingDown) this.emitSystemNotice(sourceId, taskId, `captain-rollover-pending-${savedRecord?.id ?? record.id}`, message) }
    }))
    if (result?.state !== 'completed') throw new Error('Captain rollover binding remains pending; its accepted native identity and source history are retained.')
    return this.db.getTask(taskId)?.session_id ?? record.targetBackendId
  }

  private async maybeRolloverCaptain(sessionId: string, session: AgentSession): Promise<void> {
    if (!this.captainRollover || !this.captainEngine || this.shuttingDown || !session.adapter || session.status !== 'idle') return
    const task = this.db.getTask(session.taskId)
    if (!task || !isCoordinatorTask(task)) return
    const agent = session.configuredAgent ?? this.db.getAgent(session.agentId)
    if (!agent) return
    const safe = (): boolean => {
      const current = this.db.getTask(session.taskId)
      const project = current?.project_id ? this.db.getProject(current.project_id) : null
      return !this.shuttingDown && this.ownsSessionGeneration(sessionId, session) && session.status === 'idle'
        && current?.session_id === sessionId && !this.taskStops.has(session.taskId)
        && this.startQueue.get(session.taskId)?.state !== 'cancelled' && !this.retryExclusion(current)
        && (!project || resolveCaptainAgentId(this.db, project) === session.agentId)
    }
    await serializeTaskSend(this, session.taskId, async () => {
      if (!safe()) return
      const model = session.configuredModel ?? agent.config.model ?? 'backend-default'
      const workspaceDir = session.workspaceDir ?? this.db.getWorkspaceDir(session.taskId)
      await this.captainRollover!.consider({ ownerId: session.taskId, engine: 'adapter', backendId: sessionId,
        generationKey: this.captainEngine!.generationKey(sessionId, session.taskId), model, workspaceDir,
        reasons: [], turns: this.captainHandoffTurns(session.taskId), agent, agentId: session.agentId, codingAgent: agent.config.coding_agent }, {
        mayContinue: safe,
        verifyIdle: async () => {
          try {
            const config = await this.buildSessionConfig(session.agentId, session.taskId, workspaceDir)
            if ((await session.adapter!.getStatus(sessionId, config)).type !== SessionStatusType.IDLE) return false
            return !session.adapter!.getRunningTools || !(await session.adapter!.getRunningTools(sessionId, config)).length
          } catch { return false }
        },
        createGeneration: async ({ source }) => {
          const config = await this.buildSessionConfig(session.agentId, session.taskId, source.workspaceDir)
          if (!safe()) throw new DOMException('Captain rollover cancelled', 'AbortError')
          if ((await session.adapter!.getStatus(sessionId, config)).type !== SessionStatusType.IDLE)
            throw new DOMException('Captain is no longer idle', 'AbortError')
          if (session.adapter!.getRunningTools && (await session.adapter!.getRunningTools(sessionId, config)).length)
            throw new DOMException('Captain tools are still running', 'AbortError')
          if (!safe()) throw new DOMException('Captain rollover cancelled', 'AbortError')
          const backendId = await this.ownShutdownWork(session.adapter!.createSession({ ...config,
            model: source.model === 'backend-default' ? undefined : source.model }))
          return { backendId }
        },
        bindGeneration: (record, signal) => this.bindCaptainRollover(sessionId, session, record, signal),
        notice: (record, message) => {
          if (!this.shuttingDown) this.emitSystemNotice(sessionId, session.taskId,
            `captain-rollover-pending-${record?.id ?? sessionId}`, message)
        }
      })
    })
  }

  private async bindCaptainRollover(sourceSessionId: string, sourceSession: AgentSession, record: HandoffRecord, signal: AbortSignal): Promise<void> {
    const guard = (): void => {
      signal.throwIfAborted()
      if (this.shuttingDown || !this.captainRollover?.activationEnabled) throw new DOMException('Captain rollover activation ended', 'AbortError')
    }
    guard()
    const canonical = this.db.db.prepare('SELECT backend_id FROM session_generations WHERE owner_id=? AND generation_key=?')
      .get(record.ownerId, record.nextGenerationKey) as { backend_id: string | null } | undefined
    const target = canonical?.backend_id ?? record.targetBackendId
    if (!target || !sourceSession.adapter) throw new Error('Captain rollover has no accepted backend identity')
    const existing = this.sessions.get(target)
    if (existing && (existing.taskId !== record.ownerId || existing.agentId !== sourceSession.agentId))
      throw new Error('The accepted Captain rollover target belongs to another task or agent')
    if (this.db.db.prepare('SELECT id FROM tasks WHERE session_id=? AND id!=? LIMIT 1').get(target, record.ownerId))
      throw new Error('The accepted Captain rollover target is durably bound to another task')
    const seedKey = `${record.id}:seed`
    let seed = this.deliveries.getByKey(seedKey)
    const message = seed?.payload ?? captainRolloverSeed(record, this.captainHandoffTurns(record.ownerId))
    const config = await this.buildSessionConfig(sourceSession.agentId, record.ownerId, record.source.workspaceDir)
    config.model = record.model === 'backend-default' ? undefined : record.model
    config.systemPrompt = `${config.systemPrompt ?? ''}\n\n${message}`
    guard()
    const token = existing?.secretSessionToken ?? this.setupSecretSession(sourceSession.agentId)
    const allocatedToken = token !== undefined && token !== existing?.secretSessionToken
    config.secretSessionToken = token
    try {
      const history = await this.ownShutdownWork(sourceSession.adapter.resumeSession(target, config))
      guard()
      if ((await this.verifyAdapterSession(sourceSession.adapter, target, config, record.ownerId, false)) !== SessionStatusType.IDLE
        && (!seed || !['accepted', 'acknowledged'].includes(seed.state))) throw new Error('The accepted replacement is not idle; its identity is retained')
      guard()
      if (sourceSessionId !== target) await this.stopSession(sourceSessionId, false, true, true)
      guard()
      if (this.shuttingDown) throw new DOMException('Captain rollover cancelled', 'AbortError')
      seed = this.db.db.transaction(() => {
        const stored = seed ?? this.deliveries.enqueue({ idempotencyKey: seedKey, kind: 'captain_handoff_seed', taskId: record.ownerId,
          sourceSessionId: target, agentId: sourceSession.agentId, payload: message }).record
        this.updateTaskFromLocalAgent(record.ownerId, { session_id: target })
        this.recordCoordinatorSessionAgent(record.ownerId, sourceSession.agentId)
        return stored
      })()
      const next: AgentSession = existing ?? { ...sourceSession, id: target, workspaceDir: record.source.workspaceDir,
        status: 'idle', createdAt: new Date(), lastActivityAt: Date.now(), ...dedupStateFromHistory(history),
        secretSessionToken: token, pendingRecap: seed.payload, pendingHandoffSeedId: seed.id, pendingLossId: undefined, managedIntentId: undefined,
        managedCaptain: true, configuredModel: config.model }
      if (existing && token && !existing.secretSessionToken) existing.secretSessionToken = token
      if (existing && seed.state === 'pending') {
        existing.pendingRecap = seed.payload
        existing.pendingHandoffSeedId = seed.id
      }
      this.sessions.set(target, next)
      const runtime = this.captainRuntimes.get(record.ownerId)
      this.transitionCaptainRuntime(record.ownerId, 'healthy', { sessionId: target, deadlineAt: null, lastProbeAt: Date.now(),
        probeOk: true, candidateAgentId: null, lastGoodAgentId: runtime?.agentId ?? sourceSession.agentId, errorCode: null, errorDetail: null })
      if (sourceSessionId !== target) this.sessionIdRedirects.set(sourceSessionId, target)
      await this.captainEngine!.observe(record.ownerId, target, 'session_started', `${record.id}:native-bound`,
        { model: record.model, contextWindow: modelContextWindow(record.model), handoffId: record.id, contextOwner: 'backend' })
      guard()
      const noteId = `handoff-divider-${record.id}`
      const note = JSON.stringify({ kind: 'rollover', title: 'Captain conversation continued in a new generation',
        summary: record.summary?.text ?? '', source: record.summarySource })
      // A handoff cannot complete unless its divider is durable. The ordinary
      // streaming helper logs persistence failures, so commit/verify strictly
      // first; the later publication remains an idempotent projection.
      if (!this.db.getTranscriptParts(record.ownerId).some((part) => part.partId === noteId && part.partType === MessagePartType.GENERATION)) {
        this.persistTranscriptEvent('agent:output', { sessionId: target, taskId: record.ownerId, type: 'message',
          data: { id: noteId, role: 'system', content: note, partType: MessagePartType.GENERATION } })
        if (!this.db.getTranscriptParts(record.ownerId).some((part) => part.partId === noteId && part.partType === MessagePartType.GENERATION))
          throw new Error('Captain generation divider could not be committed')
      }
      this.emitSystemNotice(target, record.ownerId, noteId, note, MessagePartType.GENERATION)
      this.sendToRenderer('task:updated', { taskId: record.ownerId, updates: { session_id: target } })
      this.emitStatus(target, next, next.status)
    } finally {
      if (allocatedToken && token && this.sessions.get(target)?.secretSessionToken !== token && this.host.secrets.kind === 'broker') this.host.secrets.unregister(token)
    }
  }

  async abortSession(sessionId: string, options: { requireAcknowledgement?: boolean } = {}): Promise<void> {
    this.taskGroupRequests.assertCurrent()
    return this.ownShutdownWork(this.abortSessionNow(sessionId, options))
  }

  private async abortSessionNow(sessionId: string, options: { requireAcknowledgement?: boolean } = {}): Promise<void> {
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
    if (options.requireAcknowledgement && !this.sessions.has(sessionId)) throw new Error('The native session is no longer owned.')
    const resolved = this.resolveSession(sessionId, 'abortSession')
    if (!resolved) return
    const { session } = resolved
    sessionId = resolved.sessionId
    this.captainRollover?.cancel(session.taskId)
    this.assertSessionGeneration(sessionId, session)

    this.providerRecoveries.cancel(session.taskId)
    console.log(`[AgentManager] Aborting session ${sessionId}`)
    this.stopAdapterPolling(sessionId)

    const adapter = session.adapter ?? this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        this.assertSessionGeneration(sessionId, session)
        await adapter.abortPrompt(sessionId, sessionConfig)
        if (options.requireAcknowledgement) {
          const status = await adapter.getStatus(sessionId, sessionConfig)
          this.assertSessionGeneration(sessionId, session)
          if (status.type !== SessionStatusType.IDLE) throw new Error('The backend has not confirmed that cancellation settled. Read status or use Stop.')
        }
      } catch (error) {
        if (options.requireAcknowledgement) {
          if (this.ownsSessionGeneration(sessionId, session)) {
            session.pollingStarted = true
            this.startAdapterPolling(sessionId, adapter, this.sessionConfigFor(session), session)
          }
          throw error
        }
        console.error(`[AgentManager] Error aborting adapter session:`, error)
      }
    } else if (options.requireAcknowledgement) {
      throw new Error('The native adapter is unavailable.')
    }

    this.assertSessionGeneration(sessionId, session)
    if (this.managedEngine(session) && session.managedIntentId) {
      const intentId = session.managedIntentId
      session.managedIntentId = undefined
      await this.managedEngine(session)!.finishTurn(session.taskId, sessionId, intentId, 'cancelled')
      this.assertSessionGeneration(sessionId, session)
    }
    session.status = 'idle'
    this.emitStatus(sessionId, session, 'idle', 'cancelled')
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
  async stopSession(sessionId: string, resetTaskStatus: boolean = true, requireAcknowledgement = false, rolloverInternal = false): Promise<void> {
    this.taskGroupRequests.assertCurrent()
    if (!rolloverInternal) {
      const owner = this.sessions.get(sessionId)
      if (owner) this.captainRollover?.cancel(owner.taskId)
    }
    const pending = this.sessionStops.get(sessionId)
    if (pending) return pending
    const owner = this.sessions.get(sessionId)
    const pendingForTask = owner ? this.taskStops.get(owner.taskId) : undefined
    if (pendingForTask) return pendingForTask.promise
    this.taskGroupRequests.assertCurrent()
    const cleanupConfig = owner ? this.scopedRetirementConfigs.get(owner) ?? (this.taskGroupRequests.scoped ? this.sessionConfigFor(owner) : undefined) : undefined
    const stopping = this.ownShutdownWork(this.taskGroupRequests.detached(() => this.stopSessionNow(sessionId, resetTaskStatus, requireAcknowledgement, cleanupConfig)))
    this.sessionStops.set(sessionId, stopping)
    const retainTaskOwnership = owner && (resetTaskStatus || requireAcknowledgement)
    if (retainTaskOwnership) this.taskStops.set(owner.taskId, { sessionId, session: owner, promise: stopping })
    try {
      await stopping
      this.scopedCleanupFailures.delete(sessionId)
      if (owner) this.scopedRetirementConfigs.delete(owner)
    } finally {
      this.sessionStops.delete(sessionId)
      if (retainTaskOwnership && this.taskStops.get(owner.taskId)?.promise === stopping) this.taskStops.delete(owner.taskId)
    }
  }

  private async stopSessionNow(sessionId: string, resetTaskStatus: boolean, requireAcknowledgement: boolean, cleanupConfig?: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[AgentManager] Session ${sessionId} not found`)
      return
    }

    if (resetTaskStatus) this.providerRecoveries.cancel(session.taskId)
    const restorePollingOnRefusal = session.pollingStarted || this.pollingEntries.has(sessionId)

    // Fence this exact runtime synchronously. Adapter teardown can be slow and
    // in-flight sends retain a reference to the session object while it awaits.
    this.stoppingSessions.add(session)
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)

    // Stop is the authority boundary for typed deliveries even when backend
    // teardown is slow (or later refuses). The durable start row is cancelled
    // only after an acknowledged teardown below, so the same live owner remains
    // retryable on refusal.
    if (resetTaskStatus && this.db.db && typeof this.db.db.prepare === 'function') {
      this.deliveries.cancelUnacceptedForTask(session.taskId, 'Delivery cancelled because the user stopped this task before backend acceptance.')
    }

    console.log(`[AgentManager] Destroying session ${sessionId} (resetTaskStatus=${resetTaskStatus})`)

    if (resetTaskStatus && !requireAcknowledgement) this.cancelQueuedStart(session.taskId)

    this.stopAdapterPolling(sessionId)

    const adapter = session.adapter ?? this.getAdapter(session.agentId)
    if (adapter) {
      try {
        const sessionConfig = cleanupConfig ?? await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
        await adapter.destroySession(sessionId, sessionConfig)
      } catch (error) {
        console.error(`[AgentManager] Error destroying adapter session:`, error)
        // A user move must fail while the backend still owns work. Keep its
        // session and polling intact so the user can observe it and retry.
        if (requireAcknowledgement) {
          this.stoppingSessions.delete(session)
          if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, session)
          if (restorePollingOnRefusal && adapter) {
            session.pollingStarted = true
            this.startAdapterPolling(sessionId, adapter, this.sessionConfigFor(session), session)
          }
          throw error
        }
      }
    }
    if (requireAcknowledgement) {
      // Only withdraw durable ownership after the backend confirms destruction.
      // A failed stop leaves both the live handle and its acknowledged start row
      // intact so a caller can retry without manufacturing a stopped state.
      if (resetTaskStatus) this.cancelQueuedStart(session.taskId)
    }
    if (this.managedEngine(session) && session.managedIntentId && !this.shuttingDown) {
      const intentId = session.managedIntentId
      session.managedIntentId = undefined
      await this.managedEngine(session)!.finishTurn(session.taskId, sessionId, intentId, resetTaskStatus ? 'cancelled' : 'interrupted')
    }

    if (session.secretSessionToken) {
      if (this.host.secrets.kind === 'broker') this.host.secrets.unregister(session.secretSessionToken)
      console.log(`[AgentManager] Unregistered secret session for ${sessionId}`)
    }

    // Eagerly clear dedup structures to free memory immediately (don't wait for GC)
    session.seenMessageIds.clear()
    session.seenPartIds.clear()
    session.partContentLengths.clear()

    const replacement = this.findSessionByTaskId(session.taskId)
    if (!this.sessions.has(sessionId)) this.lastSentStatus.delete(sessionId)
    this.schedulePowerSaveBlockerUpdate()
    console.log(`[SessionTracker] DESTROYED session=${sessionId} task=${session.taskId} resetStatus=${resetTaskStatus} reason=stop_session`)

    for (const [oldId, newId] of this.sessionIdRedirects.entries()) {
      if (!this.sessions.has(sessionId) && newId === sessionId) {
        this.sessionIdRedirects.delete(oldId)
      }
    }

    // Reset only on an explicit user stop (not app shutdown), and never a Completed task.
    if (resetTaskStatus && !replacement) {
      const task = this.db.getTask(session.taskId)
      if (task?.status !== TaskStatus.Completed) {
        this.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.NotStarted })
      }
    }

    if (!replacement) this.emitStatus(sessionId, session, 'idle', resetTaskStatus ? 'cancelled' : 'interrupted')
  }

  /**
   * Stops a session by taskId — used when the renderer's session mapping
   * is broken (Session: none) and the normal stop-by-sessionId path fails.
   */
  async stopByTaskId(taskId: string): Promise<{ sessionId: string | null }> {
    this.taskGroupRequests.assertCurrent()
    taskId = this.taskGroupExecution(taskId)?.id ?? taskId
    this.captainRollover?.cancel(taskId)
    const pending = this.taskStops.get(taskId)
    if (pending) {
      await pending.promise
      return { sessionId: pending.sessionId }
    }
    let found = this.findSessionByTaskId(taskId)
    if (!found) {
      // No backend exists yet, so cancel the durable generation first. Then
      // wait for an in-flight creation to acknowledge that fence and clean up
      // any late backend before the caller commits a destination status.
      this.cancelQueuedStart(taskId)
      const starting = this.sessionStarts.get(taskId)
      if (starting) {
        try { await starting } catch { /* The start path reports its own failure. */ }
      }
      await this.joinRawTaskStarts(taskId)
      this.taskGroupRequests.assertCurrent()
      found = this.findSessionByTaskId(taskId)
    }
    if (!found) {
      const task = this.db.getTask(taskId)
      if (task?.status === TaskStatus.AgentWorking || task?.status === TaskStatus.Triaging) {
        this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.NotStarted, session_id: null })
      }
      console.log(`[AgentManager] stopByTaskId: no active session found for task ${taskId}`)
      return { sessionId: null }
    }
    console.log(`[AgentManager] stopByTaskId: found session ${found.sessionId} for task ${taskId}, stopping`)
    await this.stopSession(found.sessionId, true, true)
    this.taskGroupRequests.assertCurrent()
    // A fenced start may have already initiated cleanup without resetting the
    // task. The explicit stop still owns the final rollback after it settles.
    const task = this.db.getTask(taskId)
    if (task?.status === TaskStatus.AgentWorking || task?.status === TaskStatus.Triaging) {
      this.updateTaskFromLocalAgent(taskId, { status: TaskStatus.NotStarted, session_id: null })
    }
    return { sessionId: found.sessionId }
  }

  // ── Admission control: start queue ─────────────────────────────

  /** Starts waiting for a free slot, in queue order. */
  getStartQueue(): DurableQueuedStartInfo[] {
    return this.startQueue.list()
  }

  /** Latest durable start/recovery state, including terminal outcomes. */
  getStartRecoveryState(taskId: string): DurableQueuedStartInfo | null {
    return this.startQueue.info(taskId)
  }

  /** Withdraws a queued start; true when one was waiting. */
  cancelQueuedStart(taskId: string): boolean {
    this.providerRecoveries.cancel(taskId)
    const task = this.db.getTask(taskId)
    const inFlightAgentId = this.admittedStarts.get(taskId) ?? this.taskStops.get(taskId)?.session.agentId
      ?? this.findSessionByTaskId(taskId)?.session.agentId
      ?? (isCoordinatorTask(task) ? this.db.getSetting(coordinatorSessionAgentKey(taskId)) : undefined)
    const ownerAgentId = task?.agent_id ?? inFlightAgentId
    if (this.db.db && typeof this.db.db.prepare === 'function') {
      this.deliveries.cancelUnacceptedForTask(taskId, 'Delivery cancelled because the user stopped this task before backend acceptance.')
    }
    if (!this.startQueue.get(taskId) && task && ownerAgentId) {
      this.startQueue.enqueue({ taskId, agentId: ownerAgentId, projectId: taskProjectId(task),
        priority: task.priority, reason: 'recovery', queuedAt: new Date().toISOString() })
    }
    if (!this.startQueue.cancel(taskId, 'manual_stop', 'manual_stop_not_retried')) return false
    console.log(`[AgentManager] Queued start of task ${taskId} cancelled`)
    if (task) this.recordRecoveryAudit(task, 'manual_stop', 'exclude_from_retry', 'manual_stop_not_retried')
    this.emitStartQueueChanged()
    return true
  }

  /** Sessions holding a slot: working real-task sessions plus admitted starts in flight. */
  private countedSessions(store: Pick<DatabaseManager, 'getTask'> = this.db): CountedSession[] {
    const counted = new Map<string, CountedSession>()
    for (const session of this.sessions.values()) {
      if (session.status !== 'working' && session.status !== 'waiting_approval') continue
      if (session.isTriageSession) continue
      const task = store.getTask(session.taskId)
      if (isExemptFromAdmission(session.taskId, task)) continue
      counted.set(session.taskId, { taskId: session.taskId, agentId: session.agentId, projectId: taskProjectId(task) })
    }
    for (const [taskId, stopping] of this.taskStops) {
      const task = store.getTask(taskId)
      if (stopping.session.isTriageSession || isExemptFromAdmission(taskId, task)) continue
      counted.set(taskId, { taskId, agentId: stopping.session.agentId, projectId: taskProjectId(task) })
    }
    for (const { taskId, agentId } of this.providerRecoveries.owners()) {
      const task = store.getTask(taskId)
      if (!task || isExemptFromAdmission(taskId, task)) continue
      if (!counted.has(taskId)) counted.set(taskId, { taskId, agentId, projectId: taskProjectId(task) })
    }
    for (const [taskId, agentId] of this.admittedStarts) {
      if (!counted.has(taskId)) counted.set(taskId, { taskId, agentId, projectId: taskProjectId(store.getTask(taskId)) })
    }
    return [...counted.values()]
  }

  /**
   * The global cap and pause, the requested task's project limits (#65), and
   * for the requested agent the project's working level and any file overlap
   * with the project's running jobs (#150).
   */
  private admissionLimits(task: TaskRecord | undefined, agentId?: string, counted?: CountedSession[]): AdmissionLimits {
    const limits: AdmissionLimits = {
      globalLimit: parseGlobalSessionLimit(this.db.getSetting(MAX_CONCURRENT_AGENT_SESSIONS_SETTING)),
      globalPaused: isAllProjectsPaused(this.db),
      project: task ? projectAdmissionLimits(this.db, taskProjectId(task)) : undefined
    }
    if (task && agentId) {
      // A task whose project row is gone is bounded by the hard cap alone.
      const agent = this.db.getAgent(agentId)
      const projectId = taskProjectId(task)
      if (agent && this.db.getProject(projectId)) limits.concurrencyLevel = projectAgentLevel(this.db, projectId, agent).level
      limits.fileOverlap = this.fileOverlapFor(task, counted ?? this.countedSessions())
    }
    return limits
  }

  // ── Concurrency control (#150) ─────────────────────────────────

  /** A task's touched files: what it declared plus what its branch has changed. */
  private touchesOf(task: TaskRecord): OverlapCandidate {
    const declared = this.db.getTaskTouches(task.id)
    const diff = this.branchDiffs.get(task.id)
    return { taskId: task.id, repos: task.repos ?? [], touches: [...new Set([...declared, ...diff])] }
  }

  private fileOverlapFor(task: TaskRecord, counted: CountedSession[]): { taskId: string; path: string } | null {
    const projectId = taskProjectId(task)
    const mine = this.touchesOf(task)
    if (mine.touches.length === 0) return null
    const running: OverlapCandidate[] = []
    for (const session of counted) {
      if (session.taskId === task.id || session.projectId !== projectId) continue
      const other = this.db.getTask(session.taskId)
      if (other) running.push(this.touchesOf(other))
    }
    return findFileOverlap(mine, running)
  }

  /** Re-reads the branch diff of every working task session (resource monitor tick). */
  private refreshBranchDiffs(): void {
    const owners = new Map<string, AgentSession>()
    for (const session of this.sessions.values()) owners.set(session.taskId, session)
    for (const [taskId, stopping] of this.taskStops) owners.set(taskId, stopping.session)
    for (const session of owners.values()) {
      if (session.status !== 'working' && session.status !== 'waiting_approval') continue
      if (session.isTriageSession || isExemptFromAdmission(session.taskId, this.db.getTask(session.taskId))) continue
      const dir = session.workspaceDir || this.db.getWorkspaceDir(session.taskId)
      void this.branchDiffs.refresh(session.taskId, dir).catch(() => undefined)
    }
    // Finished or deleted tasks never run again; their diffs are dropped.
    for (const taskId of this.branchDiffs.taskIds()) {
      const task = this.db.getTask(taskId)
      if (!task || (task.status === TaskStatus.Completed && !this.taskStops.has(taskId))) this.branchDiffs.forget(taskId)
    }
    // A diff can clear an overlap as well as create one.
    this.scheduleStartQueueDrain()
  }

  private lowerLevelsForPressure(pressure: ResourcePressure): void {
    const rows = autoLowerForPressure(this.db, pressure)
    for (const projectId of new Set(rows.map((row) => row.project_id))) this.emitConcurrencyChanged(projectId)
  }

  private emitConcurrencyChanged(projectId: string): void {
    this.sendToRenderer('concurrency:changed', { projectId })
    this.sendToRenderer('project:statusChanged', { projectId })
  }

  /** The latest resource reading, sampling once if there is none yet. */
  getResourcePressure(): ResourcePressure {
    return this.resourceMonitor.current() ?? this.resourceMonitor.tick()
  }

  /**
   * The Captain's `set_concurrency`: moves the project's working level for
   * one agent within its hard cap. A raise drains the queue; a lower never
   * stops running work.
   */
  setConcurrencyLevel(input: { projectId: string; agentId: string; level: unknown; reason: unknown; actor?: 'captain' | 'user' | 'system' }): LevelChangeResult | { error: string } {
    const runningInProject = this.countedSessions().filter((s) => s.agentId === input.agentId && s.projectId === input.projectId).length
    const result = setConcurrencyLevel(this.db, { ...input, pressure: this.getResourcePressure(), runningInProject })
    if ('success' in result) {
      this.emitConcurrencyChanged(input.projectId)
      if (result.level > result.previous_level) this.scheduleStartQueueDrain()
    }
    return result
  }

  /** The user's pin / Captain-control switch from the project editor. */
  setUserConcurrency(projectId: string, change: { captainControl: boolean } | { agentId: string; pinnedLevel: number | null }, reason?: string, store: ProjectRuntimeMutationStore = this.db): { success: true } | { error: string } {
    const result = setUserConcurrency(store, projectId, change, reason)
    if ('success' in result) {
      this.emitConcurrencyChanged(projectId)
      this.scheduleStartQueueDrain()
    }
    return result
  }

  /** Declares the files a task will change; overlapping starts in its project wait. */
  setTaskTouches(taskId: string, paths: string[]): string[] {
    const stored = this.db.setTaskTouches(taskId, paths)
    // Fewer touches can free a waiting start.
    this.scheduleStartQueueDrain()
    return stored
  }

  /**
   * Caps, levels, load and a suggested level per agent, for the Captain's
   * `get_concurrency` and the project editor. Lists every agent that has
   * running or queued work in the project, or a level/pin set there, plus the
   * project's default and Captain agents.
   */
  getConcurrencyState(projectId: string, auditLimit = 10, store: ProjectRuntimeReadStore = this.db): ProjectConcurrencyState {
    const settings = readProjectConcurrency(store, projectId)
    const counted = this.countedSessions(store)
    const queue = this.startQueue.snapshot()
    const project = store.getProject(projectId)
    // Agents with open tasks in the project stay listed, so a level can be
    // pinned before anything runs and does not vanish when a pin is removed.
    const openTaskAgents = store.getTasks({ projectId })
      .filter((t) => t.agent_id && t.status !== TaskStatus.Completed && !isCoordinatorTask(t))
      .map((t) => t.agent_id as string)
    const agentIds = new Set<string>([
      ...openTaskAgents,
      ...Object.keys(settings.levels),
      ...Object.keys(settings.pinned),
      ...counted.filter((s) => s.projectId === projectId).map((s) => s.agentId),
      ...queue.filter((e) => taskProjectId(store.getTask(e.taskId)) === projectId).map((e) => e.agentId)
    ])
    if (project?.default_agent_id) agentIds.add(project.default_agent_id)
    const pressure = this.getResourcePressure()
    const agents = [...agentIds].flatMap((agentId) => {
      const agent = store.getAgent(agentId)
      if (!agent) return []
      const cap = agentCap(agent)
      const { level, source } = effectiveLevel(settings, agentId, cap)
      const runningInProject = counted.filter((s) => s.agentId === agentId && s.projectId === projectId).length
      const runningTotal = counted.filter((s) => s.agentId === agentId).length
      const queued = queue.filter((e) => e.agentId === agentId && taskProjectId(store.getTask(e.taskId)) === projectId)
      const serialChainQueued = queued.filter((e) => this.isSerialChainStart(e.taskId, store)).length
      const overlapQueued = queued.filter((e) => e.reason === 'file_overlap').length
      return [{
        agentId,
        agentName: agent.name,
        cap,
        level,
        source,
        runningInProject,
        runningTotal,
        queuedInProject: queued.length,
        recommendation: recommendLevel({ cap, level, queued: queued.length, running: runningInProject, serialChainQueued, overlapQueued, underPressure: pressure.underPressure })
      }]
    })
    return {
      projectId,
      captainControl: settings.captain_control,
      agents,
      pressure,
      recentChanges: store.listConcurrencyAudit(projectId, auditLimit)
    }
  }

  /** A queued subtask whose parent sequences its children and has one still running. */
  private isSerialChainStart(taskId: string, store: Pick<DatabaseManager, 'getTask' | 'getSubtasks'> = this.db): boolean {
    const task = store.getTask(taskId)
    if (!task?.parent_task_id) return false
    const siblings = store.getSubtasks(task.parent_task_id)
    const parent = store.getTask(task.parent_task_id)
    return siblings.some((predecessor) => predecessor.next_subtask_ids?.includes(taskId)
      && predecessor.status !== TaskStatus.Completed
      && !(predecessor.status === TaskStatus.ReadyForReview && successorsFireOnReview(parent, predecessor)))
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
  getProjectLimitState(projectId: string, store: ProjectRuntimeReadStore = this.db): ProjectLimitState {
    const queued = this.startQueue.list().filter((entry) => taskProjectId(store.getTask(entry.taskId)) === projectId)
    return buildProjectLimitState(store, projectId, this.countedSessions(store), queued)
  }

  /**
   * Tells the project's Captain why a start waits (#65): a short fenced
   * system message to its live, idle coordinator session. A Captain
   * mid-turn already sees the reason in its start_task result; one with no
   * live session is told nothing (the queue entry and the project's limit
   * state carry it). Once per project and reason until a queued start runs.
   */
  private tellCaptainAboutLimit(task: TaskRecord | undefined, decision: AdmissionDecision): void {
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
      decision.reason === 'concurrency_level'
        ? 'A start in your project waits for your working concurrency level. If it can run in parallel with what is running (no shared files, not the next step of a serial chain) and the machine is not under pressure, raise the level with `set_concurrency` (never above the hard cap). Otherwise nothing is needed; it starts when a job finishes.'
        : decision.reason === 'file_overlap'
          ? 'A start in your project waits because it touches the same files as a running job. It starts when that job finishes; no action is required.'
          : 'A start in your project was queued by admission control. No action is required; the queue drains by itself.',
      '',
      FINDINGS_BEGIN,
      `Task "${task.title}" (${task.id}) is waiting to start: ${describeQueueReason(decision.reason, decision.limit, decision.running)}`,
      FINDINGS_END
    ].join('\n')
    this.sendMessage(live.sessionId, message, coordinator.id, live.session.agentId).catch((error) => {
      console.warn(`[AgentManager] Could not tell the Captain of project ${projectId} about the queued start:`, error)
      this.projectLimitNotices.delete(key)
    })
  }

  private emitStartQueueChanged(): void {
    this.sendToRenderer('agent:startQueueChanged', { queue: this.startQueue.list() })
  }

  /** Durable recovery vocabulary shared by the queue, project journal and UI. */
  private recordRecoveryAudit(task: TaskRecord, cause: string, action: string, result: string, error?: string): void {
    const summary = `Recovery ${action} for "${task.title}": ${result}.`
    try {
      this.db.appendProjectStatusJournal(taskProjectId(task), {
        summary,
        blockers: error ? [error] : [],
        decisions: [`cause=${cause}`, `action=${action}`, `result=${result}`]
      }, { source: 'system_recovery' })
    } catch (auditError) {
      console.warn(`[AgentManager] Could not append recovery audit for task ${task.id}:`, auditError)
    }
    this.sendToRenderer('agent:recoveryStateChanged', { taskId: task.id, cause, action, result, error: error ?? null })
    this.sendToRenderer('project:statusChanged', { projectId: taskProjectId(task) })
  }

  /** Automatic recovery is deliberately conservative for user or unsafe work. */
  private retryExclusion(task: TaskRecord | undefined): string | null {
    if (!task) return 'task_deleted'
    if (task.status === TaskStatus.Completed) return 'task_completed'
    const labels = (task.labels ?? []).map((label) => label.trim().toLowerCase())
    const excluded = labels.find((label) => [
      'cancelled', 'canceled', 'deleted', 'manual-stop', 'manual_stop',
      'awaiting-approval', 'approval-required', 'unsafe', 'destructive',
      'irreversible', 'external-side-effect'
    ].includes(label))
    if (excluded) return excluded.replace(/-/g, '_')
    const unresolved = this.db.getTranscriptParts(task.id).filter((part) => {
      if (part.partType !== 'question' && part.partType !== 'tool') return false
      const tool = part.tool as { status?: unknown } | undefined
      return typeof tool?.status === 'string' && ['running', 'pending', 'waiting'].includes(tool.status.toLowerCase())
    })
    if (unresolved.some((part) => part.partType === 'question' || (part.tool as { name?: unknown })?.name === 'permission')) {
      return 'awaiting_approval'
    }
    if (unresolved.length > 0) return 'unsafe_side_effect_unknown'

    return null
  }

  /** Deferred so the transition that freed the slot finishes first. */
  private scheduleStartQueueDrain(): void {
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.scheduleStartQueueDrain())
    if (this.shuttingDown || this.startQueue.size === 0 || this.startQueueDrainScheduled) return
    if (this.startQueueRetryTimer) {
      clearTimeout(this.startQueueRetryTimer)
      this.startQueueRetryTimer = null
    }
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
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.drainStartQueue())
    if (this.shuttingDown || this.startupReconciliation || this.productionAdmissionMutation || this.workspaceCleanupExclusion) return
    let changed = false
    let nextRetryAt: number | null = null
    // #150: a priority changed while waiting reorders the queue now.
    this.startQueue.refresh((taskId) => {
      const task = this.db.getTask(taskId)
      return task ? { projectId: taskProjectId(task), priority: task.priority } : undefined
    })
    for (const entry of this.startQueue.snapshot()) {
      if (this.agentConfigurationBlocked(entry.agentId) || this.taskLifecycleMutations.has(entry.taskId)) continue
      const agent = this.db.getAgent(entry.agentId)
      const task = this.db.getTask(entry.taskId)
      const exclusion = this.retryExclusion(task)
      const stale =
        !agent ? 'agent deleted'
        : !task ? 'task deleted'
        : exclusion
          ? exclusion.replace(/_/g, ' ')
        : task.agent_id && task.agent_id !== entry.agentId ? 'task reassigned'
        : null
      if (stale) {
        console.log(`[AgentManager] Dropping queued start of task ${entry.taskId}: ${stale}`)
        this.startQueue.cancel(entry.taskId, stale.replace(/ /g, '_'), 'ineligible_task_not_retried')
        if (task) this.recordRecoveryAudit(task, stale.replace(/ /g, '_'), 'exclude_from_retry', 'ineligible_task_not_retried')
        changed = true
        continue
      }
      if (this.sessionStarts.has(entry.taskId) || this.rawTaskStarts.has(entry.taskId)) continue
      if (this.hasActiveSessionForTask(entry.taskId)) {
        const live = this.findSessionByTaskId(entry.taskId)
        if (live) {
          this.startQueue.markRecovered(entry.taskId, live.sessionId, 'live_session_present', 'duplicate_start_prevented')
          this.recordRecoveryAudit(task!, 'live_session_present', 'reclaim', 'duplicate_start_prevented')
        }
        changed = true
        continue
      }
      if (entry.nextRetryAt !== null && entry.nextRetryAt > Date.now()) {
        nextRetryAt = nextRetryAt === null ? entry.nextRetryAt : Math.min(nextRetryAt, entry.nextRetryAt)
        continue
      }
      if (this.isSerialChainStart(entry.taskId)) {
        changed = this.startQueue.updateReason(entry.id, 'dependency', 'predecessor_active') || changed
        continue
      }

      const counted = this.countedSessions()
      const decision = checkAdmission(
        { agentId: entry.agentId, taskId: entry.taskId, task, agent: agent! },
        counted,
        this.admissionLimits(task, entry.agentId, counted)
      )
      if (!decision.admitted) {
        // The queued reason follows the current limits: a project may have
        // gone from "at its limit" to "paused" while its start waited.
        if (entry.reason !== decision.reason) {
          changed = this.startQueue.updateReason(entry.id, decision.reason, null) || changed
        }
        if (isGlobalAdmissionReason(decision.reason)) break
        continue
      }

      const claim = this.startQueue.claim(entry.taskId, this.startQueueLeaseOwner)
      if (!claim) continue
      changed = true
      this.recordCountedStart(task)
      this.startQueue.markServed(entry.projectId)
      for (const key of this.projectLimitNotices) {
        if (key.startsWith(`${taskProjectId(task)}:`)) this.projectLimitNotices.delete(key)
      }
      // Reserve the slot now: the start below is async and the next entry's
      // check must already see it.
      this.admittedStarts.set(entry.taskId, entry.agentId)
      console.log(`[AgentManager] Starting queued task ${entry.taskId} (agent ${entry.agentId})`)
      if (!this.startQueue.markStarting(claim.id, claim.generation)) {
        this.admittedStarts.delete(entry.taskId)
        continue
      }
      const starting = this.startSessionNow(entry.agentId, entry.taskId, entry.workspaceDir, entry.skipInitialPrompt)
      const trackedStart = this.boundedSessionStart(starting, agent!.name, entry.taskId, AGENT_START_TIMEOUT_MS)
      this.sessionStarts.set(entry.taskId, trackedStart)
      void trackedStart
        .then(async (sessionId) => {
          if (!this.startQueue.acknowledgeStarted(claim.id, claim.generation, sessionId)) {
            console.warn(`[AgentManager] Fenced late/duplicate start ${sessionId} for queue ${claim.id} generation ${claim.generation}`)
            await this.stopSession(sessionId, false, true)
            return
          }
          this.recordRecoveryAudit(task!, claim.recoveryCause ?? 'capacity_available', 'start', 'session_acknowledged')
          this.emitStartQueueChanged()
        })
        .catch((error) => {
          console.error(`[AgentManager] Queued start of task ${entry.taskId} failed:`, error)
          const detail = error instanceof Error ? error.message : String(error)
          const current = this.startQueue.get(entry.taskId)
          if (current?.generation !== claim.generation || current.state !== 'starting') return
          const latestTask = this.db.getTask(entry.taskId)
          const exclusion = this.retryExclusion(latestTask)
          if (exclusion) {
            this.startQueue.cancel(entry.taskId, exclusion, 'excluded_failure_not_retried', detail)
            if (latestTask) this.recordRecoveryAudit(latestTask, exclusion, 'exclude_from_retry', 'excluded_failure_not_retried', detail)
          } else {
            if (latestTask?.status !== TaskStatus.Completed) {
              this.updateTaskFromLocalAgent(entry.taskId, { status: TaskStatus.NotStarted, session_id: null }, 'system')
            }
            const retried = this.startQueue.failOrRetry(claim.id, claim.generation, detail)
            if (retried && latestTask) {
              this.recordRecoveryAudit(latestTask, 'recoverable_start_failure', retried.state === 'retrying' ? 'retry' : 'terminal_failure', retried.record.recoveryResult ?? retried.state, detail)
            }
          }
          this.sendToRenderer('agent:startQueueChanged', {
            queue: this.startQueue.list(),
            failed: { taskId: entry.taskId, error: detail }
          })
        })
        .finally(() => {
          this.admittedStarts.delete(entry.taskId)
          if (this.sessionStarts.get(entry.taskId) === trackedStart) this.sessionStarts.delete(entry.taskId)
          this.scheduleStartQueueDrain()
        })
    }
    if (changed) this.emitStartQueueChanged()
    if (nextRetryAt !== null && this.startQueue.size > 0) {
      const delay = Math.max(1, nextRetryAt - Date.now())
      this.startQueueRetryTimer = setTimeout(() => {
        this.startQueueRetryTimer = null
        this.scheduleStartQueueDrain()
      }, delay)
    }
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
    attachments?: MessageAttachmentRef[],
    deliveryId?: string
  ): Promise<{ sessionId: string | null; newSessionId?: string }> {
    this.taskGroupRequests.assertCurrent()
    const execution = this.taskGroupExecution(taskId)
    if (execution && execution.id !== taskId) {
      if (attachments?.length) throw new Error('Send attachments from the shared group conversation so they belong to its execution workspace.')
      const member = this.db.getTask(taskId)
      message = `For group member ${member?.title ?? taskId} (id: ${taskId}):\n${message}`
      taskId = execution.id
    }
    this.assertNoTaskGroupMutation(taskId)
    const found = this.findSessionByTaskId(taskId)
    if (found) {
      console.log(`[AgentManager] sendByTaskId: found live session ${found.sessionId} for task ${taskId}`)
      const result = await this.sendMessage(found.sessionId, message, taskId, found.session.agentId, attachments, deliveryId)
      return { sessionId: found.sessionId, ...result }
    }
    // sendMessage resumes from the persisted session_id or creates a new session.
    console.log(`[AgentManager] sendByTaskId: no live session for task ${taskId}, delegating to sendMessage for recovery`)
    const result = await this.sendMessage('', message, taskId, undefined, attachments, deliveryId)
    return { sessionId: null, ...result }
  }

  async sendMessage(
    sessionId: string,
    message: string,
    taskId?: string,
    agentId?: string,
    attachments?: MessageAttachmentRef[],
    deliveryId = `agent-message:${randomUUID()}`,
    heartbeatOwnerTaskId?: string
  ): Promise<{ newSessionId?: string }> {
    this.taskGroupRequests.assertCurrent()
    if (taskId) {
      this.taskGroupRequests.assertCurrent()
    const execution = this.taskGroupExecution(taskId)
      if (execution && execution.id !== taskId) {
        if (attachments?.length) throw new Error('Send attachments from the shared group conversation so they belong to its execution workspace.')
        message = `For group member ${this.db.getTask(taskId)?.title ?? taskId} (id: ${taskId}):\n${message}`
        taskId = execution.id; agentId = execution.agent_id!
      }
      this.assertNoTaskGroupMutation(taskId)
    } else {
      const ownerTaskId = this.resolveSession(sessionId)?.session.taskId
      if (ownerTaskId) this.assertNoTaskGroupMutation(ownerTaskId)
    }
    // A few focused unit tests use a structural DB double without SQLite.
    // The shipped DatabaseManager always has `db`, so every application call
    // takes the durable path below.
    if (!this.db.db || typeof this.db.db.prepare !== 'function') {
      return this.sendMessageNow(sessionId, message, taskId, agentId, attachments)
    }
    const owner = this.resolveSession(sessionId)?.session
    if (owner && taskId && owner.taskId !== taskId) throw new Error('Session belongs to a different task.')
    const targetTaskId = taskId ?? owner?.taskId
    const targetAgentId = agentId ?? owner?.agentId
    // Dedicated heartbeat sessions have virtual runtime IDs, while the durable
    // delivery belongs to their actual task row. No RPC argument exposes this
    // alias, and it cannot redirect another session's task ownership.
    if (heartbeatOwnerTaskId !== undefined && (targetTaskId !== `heartbeat-${heartbeatOwnerTaskId}` || owner?.taskId !== targetTaskId ||
      !this.db.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(heartbeatOwnerTaskId))) throw new Error('Heartbeat delivery belongs to a different task.')
    const record = this.db.db.transaction(() => {
      const { record } = this.deliveries.enqueue({
        idempotencyKey: deliveryId,
        kind: 'agent_message',
        taskId: heartbeatOwnerTaskId ?? targetTaskId ?? null,
        agentId: targetAgentId ?? null,
        payload: JSON.stringify({ sessionId, message, taskId: targetTaskId, agentId: targetAgentId, attachments: attachments ?? [] })
      })
      return record
    })()
    return this.dispatchAgentMessage(record)
  }

  private dispatchAgentMessage(record: DeliveryRecord): Promise<{ newSessionId?: string }> {
    const active = this.deliveryFlights.get(record.id)
    if (active) return active
    const taskKey = record.taskId ?? `delivery:${record.id}`
    const prior = this.deliveryTaskTails.get(taskKey)
    let release!: () => void
    const settled = new Promise<void>((resolve) => { release = resolve })
    this.deliveryTaskTails.set(taskKey, settled)
    const work = (async () => {
      if (prior) await prior
      return this.dispatchAgentMessageNow(record)
    })().finally(() => {
      release()
      if (this.deliveryTaskTails.get(taskKey) === settled) this.deliveryTaskTails.delete(taskKey)
      this.deliveryFlights.delete(record.id)
    })
    this.deliveryFlights.set(record.id, work)
    return work
  }

  private async dispatchAgentMessageNow(record: DeliveryRecord): Promise<{ newSessionId?: string }> {
    if (!this.taskGroupRequests.isCurrent()) {
      if (!['accepted', 'acknowledged'].includes(record.state)) this.deliveries.terminal(record.id, 'cancelled', 'Request authority was withdrawn before dispatch; this intent will not be replayed.')
      this.taskGroupRequests.assertCurrent()
    }
    if (['failed', 'timed_out', 'cancelled'].includes(record.state)) throw new Error(record.lastError ?? 'Delivery ended without acknowledgement.')
    if (record.state === 'acknowledged') return record.destinationId ? { newSessionId: record.destinationId } : {}
    if (record.state === 'accepted') {
      this.deliveries.acknowledge(record.id)
      return record.destinationId ? { newSessionId: record.destinationId } : {}
    }
    const claimed = this.deliveries.claim(record.id, this.deliveryOwner, DELIVERY_CLAIM_MS)
    if (!claimed) {
      const current = this.deliveries.get(record.id)
      if (current && ['failed', 'timed_out', 'cancelled'].includes(current.state)) {
        throw new Error(current.lastError ?? 'Delivery ended without acknowledgement.')
      }
      return {}
    }
    let payload: {
      sessionId: string
      message: string
      taskId?: string
      agentId?: string
      attachments?: MessageAttachmentRef[]
    }
    let heartbeatDelivery = false
    try {
      payload = JSON.parse(claimed.payload) as typeof payload
      heartbeatDelivery = !!claimed.taskId && payload.taskId === `heartbeat-${claimed.taskId}`
      this.taskGroupRequests.assertCurrent()
      const result = await withStartupDeadline(this.ownShutdownWork(this.sendMessageNow(
        payload.sessionId,
        payload.message,
        payload.taskId,
        payload.agentId,
        payload.attachments,
        `delivery-${claimed.id}`
      )), AGENT_START_TIMEOUT_MS + AGENT_SESSION_START_TIMEOUT_MS, 'Message handoff')
      // A heartbeat is a check against captured instructions, not a durable
      // ordinary message receipt. Stale checks stay cancelled without replay.
      if (heartbeatDelivery) this.taskGroupRequests.assertCurrent()
      const destination = result.newSessionId || payload.sessionId || claimed.taskId || claimed.id
      this.deliveries.accept(claimed.id, this.deliveryOwner, destination)
      this.deliveries.acknowledge(claimed.id, this.deliveryOwner)
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!this.taskGroupRequests.isCurrent()) {
        this.deliveries.terminal(claimed.id, 'cancelled', 'Request authority was withdrawn; this intent will not be replayed.')
      } else if (heartbeatDelivery) {
        this.deliveries.terminal(claimed.id, 'cancelled', 'Heartbeat acceptance is uncertain; this check will not be replayed.')
      } else if (detail.startsWith('Message handoff timed out')) {
        this.deliveries.terminal(claimed.id, 'timed_out', `${detail}; backend acceptance is unknown. Inspect the conversation before retrying.`)
        if (claimed.taskId) this.emitSystemError('', claimed.taskId, `delivery-timeout-${claimed.id}`,
          `${detail}. Backend acceptance is unknown; inspect the conversation before retrying.`)
      } else if (claimed.taskId && this.providerRecoveries.get(claimed.taskId)?.state === 'failed') {
        this.deliveries.terminal(claimed.id, 'failed', `${detail}; provider recovery requires review before any new delivery.`)
      } else if (claimed.attemptCount >= 5) {
        this.deliveries.terminal(claimed.id, 'failed', detail)
        if (claimed.taskId) this.emitSystemError('', claimed.taskId, `delivery-failed-${claimed.id}`,
          `Message delivery failed after five attempts: ${detail}. Send a new message to retry.`)
      } else this.deliveries.release(claimed.id, this.deliveryOwner, detail)
      throw error
    }
  }

  /** Direct messages share one bounded startup with prewarm and other sends. */
  private recoverMessageSession(taskId: string, agentId: string): Promise<string> {
    const stopping = this.taskStops.get(taskId)
    if (stopping) {
      return stopping.promise.then(() => {
        throw new Error('Message delivery was cancelled because the user stopped this task.')
      })
    }
    const active = this.sessionStarts.get(taskId)
    if (active) return active
    if (this.rawTaskStarts.has(taskId)) throw new Error('Native startup acknowledgement remains pending for this task.')
    const live = this.findSessionByTaskId(taskId)
    if (live && live.session.agentId === agentId) return Promise.resolve(live.sessionId)
    const task = this.db.getTask(taskId)
    const runtime = this.beginCaptainRuntime(task, agentId)
    const starting = (async () => {
      if (!isCoordinatorTask(task) && task?.session_id) {
        const adapter = this.getAdapter(agentId)
        if (adapter) {
          try { return await this.resumeAdapterSession(adapter, agentId, taskId, task.session_id) }
          catch (error) {
            this.taskGroupRequests.assertCurrent()
            const detail = error instanceof Error ? error.message : String(error)
            if (/already has an active writer|thread-store conflict/.test(detail)) {
              throw new Error(`Cannot resume this conversation because its runtime is still active. The existing session has been preserved. Retry after the runtime has released it. ${detail}`)
            }
          }
        }
      }
      return this.startSessionNow(agentId, taskId, undefined, true)
    })()
    const bounded = this.boundedSessionStart(starting, 'Message session', taskId,
      isCoordinatorTask(task) ? CAPTAIN_START_TIMEOUT_MS : AGENT_START_TIMEOUT_MS)
      .catch((error) => {
        if (runtime) this.captainRuntimes.transition(taskId, runtime.generation, 'failed', {
          deadlineAt: null, probeOk: false, errorCode: 'STARTUP_FAILED', errorDetail: String(error)
        })
        throw error
      }).finally(() => {
        if (this.sessionStarts.get(taskId) === bounded) this.sessionStarts.delete(taskId)
      })
    this.sessionStarts.set(taskId, bounded)
    return bounded
  }

  private async sendMessageNow(
    sessionId: string,
    message: string,
    taskId?: string,
    agentId?: string,
    attachments?: MessageAttachmentRef[],
    transcriptPartId?: string
  ): Promise<{ newSessionId?: string }> {
    const resolved = this.resolveSession(sessionId, 'sendMessage')
    let session = resolved?.session
    if (resolved) sessionId = resolved.sessionId

    // A renderer can send while its bounded warm-up IPC is still pending.
    // The message is already durable at this point; join that exact start so
    // we cannot create a second session for the same Captain.
    if (!session && taskId) {
      const starting = this.sessionStarts.get(taskId)
      if (starting) {
        sessionId = await starting
        this.taskGroupRequests.assertCurrent()
        session = this.sessions.get(sessionId)
        if (!session) throw new Error(`Started session was not registered: ${sessionId}`)
      }
    }

    let recovered = false
    if (!session && taskId) {
      const task = this.db.getTask(taskId)
      const project = task?.project_id ? this.db.getProject(task.project_id) : null
      const resolvedAgentId = isCoordinatorTask(task) && project
        ? resolveCaptainAgentId(this.db, project) : task?.agent_id || agentId
      if (resolvedAgentId) {
        if (isCoordinatorTask(task)) this.dropForeignCoordinatorSession(taskId, resolvedAgentId)
        sessionId = await this.recoverMessageSession(taskId, resolvedAgentId)
        this.taskGroupRequests.assertCurrent()
        session = this.sessions.get(sessionId)
        recovered = true
      }
    }

    if (!session) throw new Error(`Session not found: ${sessionId}`)
    try {
      await this.doSendAdapterMessage(session, sessionId, message, attachments, transcriptPartId)
    } catch (error) {
      if (!await this.handleSessionError(sessionId, session, error)) throw error
    }
    return recovered ? { newSessionId: sessionId } : {}
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
  private async handleSessionError(sessionId: string, session: AgentSession, err: unknown): Promise<boolean> {
    if (!this.taskGroupRequests.isCurrent()) return false
    if (!this.ownsSessionGeneration(sessionId, session)) return false
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[AgentManager] Session ${sessionId} error:`, message)
    if (await this.tryProviderRecovery(sessionId, session, classifyProviderFailure(err))) return true
    session.status = 'error'
    this.emitSystemError(
      sessionId,
      session.taskId,
      `send-error-${Date.now()}`,
      `Could not send the message: ${message}\n\nThe session is still here — fix the issue and retry with "continue".`
    )
    this.emitStatus(sessionId, session, 'error')
    this.stopAdapterPolling(sessionId)
    return false
  }

  /** Persists intent before crossing the wire. Acceptance cannot reset a retry
   * budget: the same intent owns the whole interrupted turn until idle. */
  private async sendTrackedPrompt(session: AgentSession, sessionId: string, prompt: string, config: SessionConfig, recovery?: ProviderRecovery): Promise<void> {
    this.assertNoTaskGroupMutation(session.taskId)
    this.assertSessionGeneration(sessionId, session)
    if (recovery) {
      const current = this.providerRecoveries.get(recovery.taskId)
      if (!current || current.intentId !== recovery.intentId || current.generation !== recovery.generation || current.state !== 'dispatching')
        throw new Error('Provider continuation was superseded or cancelled before delivery.')
    }
    const adapter = session.adapter!
    const task = this.db.getTask(session.taskId)
    const row = task ? recovery ?? this.providerRecoveries.begin({ taskId: session.taskId, sessionId,
      agentId: session.agentId, workspaceDir: session.workspaceDir, prompt,
      remainingAgentIds: session.fallbackAgentIds ?? [], attemptedAgentIds: [...session.attemptedAgentIds ?? [session.agentId]] }) : null
    try {
      const trackedConfig = { ...config, providerIntentId: row?.intentId }
      if (this.managedEngine(session) && row) {
        session.managedIntentId = row.intentId
        await this.managedEngine(session)!.sendPrompt(session.taskId, sessionId, row.intentId, row.attempt, prompt, adapter, trackedConfig,
          () => this.assertSessionGeneration(sessionId, session))
      } else await this.ownShutdownWork(adapter.sendPrompt(sessionId, [{ type: MessagePartType.TEXT, text: prompt }], trackedConfig))
    } catch (error) {
      if (!row) throw error
      const failure = classifyProviderFailure(error)
      throw Object.assign(new Error(failure.message), { providerFailure: { ...failure, intentId: row.intentId } })
    }
    if (row && this.ownsSessionGeneration(sessionId, session)) {
      const current = this.providerRecoveries.get(row.taskId)
      if (current?.intentId === row.intentId && ['sending', 'dispatching'].includes(current.state))
        this.providerRecoveries.change(current, { state: 'accepted', sessionId, agentId: session.agentId, nextRetryAt: null, delivery: 'unknown' })
    }
  }

  private providerRecoveryOwnsTask(taskId: string): boolean {
    const row = this.providerRecoveries.get(taskId)
    return !!row && ['retrying', 'dispatching', 'failed', 'cancelled'].includes(row.state)
  }

  /** Polling is read-only. Reconnect/re-read on a transient transport failure;
   * never infer a failed turn or send a new prompt from a disconnected read. */
  private handlePollingError(sessionId: string, session: AgentSession, error: unknown): void {
    if (!this.ownsSessionGeneration(sessionId, session)) return
    const row = this.providerRecoveries.get(session.taskId)
    if (!row || row.sessionId !== sessionId || ['retrying', 'failed', 'cancelled', 'completed'].includes(row.state)) return
    const failure = classifyProviderFailure(error)
    if (failure.kind !== 'transient') { this.failProviderRecovery(row, failure.message); return }
    const scheduled = this.providerRecoveries.schedule(row, failure, 'poll')
    if (!scheduled) return
    this.stopAdapterPolling(sessionId)
    session.pollingStarted = false
    this.emitSystemNotice(sessionId, session.taskId, `provider-poll-${scheduled.intentId}-${scheduled.generation}`,
      `Retrying… provider status read failed. Reconnecting at ${new Date(scheduled.nextRetryAt!).toISOString()}; the existing turn keeps ownership.`)
    this.scheduleProviderRecovery()
  }

  private async tryProviderRecovery(sessionId: string, session: AgentSession, failure: ProviderFailure): Promise<boolean> {
    if (!this.ownsSessionGeneration(sessionId, session)) return false
    const row = this.providerRecoveries.get(session.taskId)
    if (failure.intentId && row?.intentId !== failure.intentId) return false
    if (row?.state === 'retrying') return true // Error/poll/send can observe the same failure.
    if (!row || row.sessionId !== sessionId || ['completed', 'cancelled', 'failed'].includes(row.state)) return false
    if (failure.delivery === 'rejected' && (!['sending', 'dispatching'].includes(row.state) || failure.intentId !== row.intentId)) return false
    const task = this.db.getTask(session.taskId)
    const exclusion = this.retryExclusion(task)
      ?? (session.status === 'waiting_approval' ? 'awaiting_approval' : null)
    if (exclusion || failure.delivery === 'unknown' || failure.kind === 'terminal') {
      this.failProviderRecovery(row, exclusion ?? `${failure.message}; backend delivery or tool outcomes require review.`,
        failure.delivery === 'unknown' && row.state === 'sending' ? 'prompt_delivery_unconfirmed' : 'review_required')
      return false
    }
    const scheduled = this.providerRecoveries.schedule(row, failure)
    if (!scheduled) return false
    session.status = 'working' // Retain its admission slot and queue ownership.
    session.pollingStarted = false
    this.stopAdapterPolling(sessionId)
    this.emitStatus(sessionId, session, 'working')
    this.emitSystemNotice(sessionId, session.taskId, `provider-retry-${scheduled.intentId}-${scheduled.generation}`,
      `Retrying… ${failure.message}\nNext attempt ${scheduled.attempt}/${PROVIDER_MAX_RETRIES} at ${new Date(scheduled.nextRetryAt!).toISOString()}${failure.kind === 'exhausted' || scheduled.attempt > PROVIDER_MAX_RETRIES ? '; trying the next configured fallback.' : '.'}`)
    if (task) this.recordRecoveryAudit(task, failure.message, 'provider_retry', `attempt_${scheduled.attempt}_at_${scheduled.nextRetryAt}`)
    this.scheduleProviderRecovery()
    return true
  }

  private failProviderRecovery(row: ProviderRecovery, detail: string, result = 'review_required'): void {
    const failed = this.providerRecoveries.change(row, { state: 'failed', cause: detail, nextRetryAt: null })
    if (!failed) return
    const task = this.db.getTask(row.taskId)
    if (task && !this.startQueue.get(row.taskId)) this.startQueue.enqueue({
      taskId: row.taskId, agentId: row.agentId, projectId: taskProjectId(task),
      priority: task.priority, reason: 'recovery', queuedAt: new Date().toISOString()
    })
    this.startQueue.fail(row.taskId, result === 'prompt_delivery_unconfirmed' ? 'unsafe_side_effect_unknown' : 'provider_recovery_terminal', result, detail)
    const live = this.findSessionByTaskId(row.taskId)
    if (live) {
      live.session.status = 'error'
      live.session.pollingStarted = false
      this.stopAdapterPolling(live.sessionId)
      this.emitStatus(live.sessionId, live.session, 'error')
    }
    this.emitSystemError(live?.sessionId ?? row.sessionId, row.taskId, `provider-terminal-${row.intentId}`, detail)
    if (task && !live && !isCoordinatorTask(task) && task.status !== TaskStatus.Completed)
      this.updateTaskFromLocalAgent(task.id, { status: TaskStatus.NotStarted }, 'system')
    if (task) this.recordRecoveryAudit(task, detail, 'terminal_failure', result, detail)
  }

  private scheduleProviderRecovery(): void {
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.scheduleProviderRecovery())
    if (this.shuttingDown || this.startupReconciliation || this.workspaceCleanupExclusion) return
    if (this.providerRecoveryTimer) clearTimeout(this.providerRecoveryTimer)
    const pending = this.providerRecoveries.list(['retrying']).filter((row) => !this.providerRecoveryFlights.has(row.taskId) && !this.agentConfigurationBlocked(row.agentId) && !this.taskLifecycleMutations.has(row.taskId))
    if (!pending.length) { this.providerRecoveryTimer = null; return }
    const deadline = Math.min(...pending.map((row) => row.nextRetryAt ?? Date.now()))
    this.providerRecoveryTimer = setTimeout(() => {
      this.providerRecoveryTimer = null
      if (this.workspaceCleanupExclusion) return
      for (const row of this.providerRecoveries.list(['retrying'])) {
        if (row.state !== 'retrying' || (row.nextRetryAt ?? 0) > Date.now() || this.providerRecoveryFlights.has(row.taskId) || this.agentConfigurationBlocked(row.agentId) || this.taskLifecycleMutations.has(row.taskId)) continue
        this.providerRecoveryFlights.add(row.taskId)
        void this.ownShutdownWork(this.dispatchProviderRecovery(row)).finally(() => {
          this.providerRecoveryFlights.delete(row.taskId)
          this.scheduleProviderRecovery()
        }).catch((error) => console.error('[AgentManager] Provider recovery failed:', error))
      }
    }, Math.max(0, deadline - Date.now()))
  }

  private async dispatchProviderRecovery(original: ProviderRecovery): Promise<void> {
    if (this.shuttingDown || this.workspaceCleanupExclusion) return
    let row = this.providerRecoveries.get(original.taskId)
    if (!row || row.generation !== original.generation || row.state !== 'retrying') return
    const task = this.db.getTask(row.taskId)
    const exclusion = this.retryExclusion(task)
    if (exclusion) { this.failProviderRecovery(row, exclusion); return }
    let live = this.findSessionByTaskId(row.taskId)
    if (live?.session.status === 'waiting_approval') { this.failProviderRecovery(row, 'awaiting_approval'); return }
    if (row.mode === 'poll') {
      if (row.attempt > PROVIDER_MAX_RETRIES) { this.failProviderRecovery(row, 'Provider status reads failed repeatedly; delivery remains unknown. Inspect the live conversation before continuing.'); return }
      try {
        if (!live) {
          const adapter = this.getAdapter(row.agentId)
          if (!adapter) throw new Error('Provider adapter unavailable')
          const sessionId = await this.resumeAdapterSession(adapter, row.agentId, row.taskId, row.sessionId)
          if (!sessionId) throw new Error('INCOMPATIBLE_SESSION_ID: Interrupted conversation is unavailable')
          live = this.findSessionByTaskId(row.taskId)
        }
        if (!live) throw new Error('Recovery session ownership changed')
        const accepted = this.providerRecoveries.change(row, { state: 'accepted', nextRetryAt: null })
        if (!accepted || this.shuttingDown) return
        this.startAdapterPolling(live.sessionId, live.session.adapter!, this.sessionConfigFor(live.session), live.session)
        const entry = this.pollingEntries.get(live.sessionId)
        if (entry) await this.pollSingleSession(entry)
      } catch (error) {
        if (live) this.handlePollingError(live.sessionId, live.session, error)
        else this.failProviderRecovery(row, String(error))
      }
      return
    }
    const fallback = row.attempt > PROVIDER_MAX_RETRIES || row.failureKind === 'exhausted'
      || (row.selectedFallback !== null && !row.sessionId)
    try {
      if (fallback && (row.attempt > PROVIDER_MAX_RETRIES || row.failureKind === 'exhausted')) {
        const next = row.remainingAgentIds.find((id) => !row!.attemptedAgentIds.includes(id) && this.db.getAgent(id))
        if (!next) { this.failProviderRecovery(row, 'Provider retries and all configured fallbacks are exhausted. Review provider availability or agent configuration, then continue.'); return }
        row = this.providerRecoveries.change(row, { selectedFallback: next, agentId: next, sessionId: '', attempt: 0, failureKind: null,
          remainingAgentIds: row.remainingAgentIds.filter((id) => id !== next), attemptedAgentIds: [...row.attemptedAgentIds, next] })!
        this.emitSystemNotice(live?.sessionId ?? row.sessionId, row.taskId, `provider-fallback-${row.intentId}-${row.generation}`,
          `Retrying… handing off to ${this.db.getAgent(next)!.name}. Completed tool results are preserved.`)
        // Stop only the outgoing backend, preserving the active intent/start row.
        if (live) await this.stopSession(live.sessionId, false, true)
        const selected = this.providerRecoveries.get(row.taskId)
        if (this.shuttingDown || selected?.generation !== row.generation || selected.state !== 'retrying') return
        live = undefined
        this.updateTaskFromLocalAgent(row.taskId, { agent_id: next, session_id: null })
        if (isCoordinatorTask(task) && task?.project_id) this.db.updateProject(task.project_id, { captain_agent_id: next })
      }
      if (!live) {
        // Never substitute a fresh conversation for a same-agent continuation.
        // A failed resume is an explicit safety boundary; a fallback receives
        // a recap and a remaining-intent continuation, never the original turn.
        const adapter = this.getAdapter(row.agentId)
        if (!adapter) throw new Error('Agent adapter unavailable')
        let sessionId: string
        if (!fallback) {
          sessionId = await this.resumeAdapterSession(adapter, row.agentId, row.taskId, row.sessionId)
          if (!sessionId) throw new Error('INCOMPATIBLE_SESSION_ID: Interrupted conversation is unavailable')
        } else {
          const counted = this.countedSessions().filter((owner) => owner.taskId !== row!.taskId)
          const fallbackAgent = this.db.getAgent(row.agentId)
          if (!fallbackAgent) throw new Error('Fallback agent is no longer configured')
          const decision = checkAdmission({ agentId: row.agentId, taskId: row.taskId, task, agent: fallbackAgent }, counted,
            this.admissionLimits(task, row.agentId, counted))
          if (!decision.admitted) {
            const waiting = this.providerRecoveries.change(row, { nextRetryAt: Date.now() + 2000 })
            if (waiting) this.emitSystemNotice('', row.taskId, `provider-admission-${row.intentId}-${waiting.generation}`,
              `Retrying… fallback is waiting for admission (${decision.reason}); next check at ${new Date(waiting.nextRetryAt!).toISOString()}.`)
            return
          }
          sessionId = await this.boundedSessionStart(
            this.startAdapterSession(adapter, row.agentId, row.taskId, row.workspaceDir ?? await this.setupWorktreeIfNeeded(row.taskId), true,
              undefined, undefined, false, () => {
                const current = this.providerRecoveries.get(row!.taskId)
                return !this.shuttingDown && current?.intentId === row!.intentId
                  && current.generation === row!.generation && current.state === 'retrying'
              }),
            'Provider fallback', row.taskId, AGENT_START_TIMEOUT_MS)
        }
        live = this.findSessionByTaskId(row.taskId)
        if (!live || live.sessionId !== sessionId) throw new Error('Recovery session ownership changed')
      }
      const current = this.providerRecoveries.get(row.taskId)
      if (this.shuttingDown || !current || current.generation !== row.generation || current.state !== 'retrying') return
      if (live.session.status === 'waiting_approval') { this.failProviderRecovery(row, 'awaiting_approval'); return }
      // Re-check after reconnect/start, which can reveal unresolved tools.
      const latestExclusion = this.retryExclusion(this.db.getTask(row.taskId))
      if (latestExclusion) { this.failProviderRecovery(row, latestExclusion); return }
      if (live.session.status === 'working' && !fallback && live.sessionId !== original.sessionId) {
        this.failProviderRecovery(row, 'The backend still owns active work; inspect its outcomes before continuing.')
        return
      }
      const backendStatus = await live.session.adapter!.getStatus(live.sessionId, this.sessionConfigFor(live.session))
      if (!fallback && [SessionStatusType.BUSY, SessionStatusType.RETRY, SessionStatusType.WAITING_APPROVAL].includes(backendStatus.type)) {
        this.failProviderRecovery(row, 'The backend still owns work or awaits approval; inspect outcomes before continuing.')
        return
      }
      const dispatching = this.providerRecoveries.change(row, { state: 'dispatching', sessionId: live.sessionId })
      if (!dispatching) return
      row = dispatching
      const session = live.session
      session.fallbackAgentIds = row.remainingAgentIds
      session.attemptedAgentIds = new Set(row.attemptedAgentIds)
      const recap = fallback ? this.taskRecap(row.taskId, this.db.getAgent(row.agentId)?.config.model, false,
        estimateTokens(row.prompt.length + PROVIDER_CONTINUATION.length + 128)) : ''
      const prompt = row.delivery === 'rejected' && !fallback ? row.prompt
        : `${recap ? `Conversation recap:\n${recap}\n\n` : ''}${PROVIDER_CONTINUATION}\n\nRemaining intent:\n${row.prompt}`
      const config = await this.buildSessionConfig(row.agentId, row.taskId, session.workspaceDir)
      this.assertSessionGeneration(live.sessionId, session)
      const pendingLossId = session.pendingLossId
      await serializeTaskSend(this, row.taskId, () => this.sendTrackedPrompt(session, live!.sessionId, prompt, config, row!))
      if (!this.ownsSessionGeneration(live.sessionId, session)) return
      this.acknowledgeSessionRecap(session, pendingLossId)
      session.status = 'working'
      session.pollingStarted = true
      this.startAdapterPolling(live.sessionId, session.adapter!, config, session)
      this.emitSystemNotice(live.sessionId, row.taskId, `provider-recovered-${row.intentId}-${row.generation}`, 'Provider recovered. Continuing the interrupted work.')
    } catch (error) {
      const current = this.providerRecoveries.get(row.taskId)
      if (!current || current.intentId !== row.intentId || ['cancelled', 'failed'].includes(current.state)) return
      const failure = classifyProviderFailure(error)
      // Before send, unavailable fallback creation can safely advance the chain.
      // Once dispatching, only explicit rejection permits another send.
      if (current.state === 'retrying' && fallback) {
        this.providerRecoveries.change(current, { attempt: PROVIDER_MAX_RETRIES + 1, nextRetryAt: Date.now(), cause: failure.message })
      } else if (live && current.state === 'retrying' && failure.kind === 'transient') {
        this.providerRecoveries.schedule(current, { ...failure, delivery: current.delivery })
      } else if (live && current.state === 'dispatching' && failure.delivery !== 'unknown' && failure.kind !== 'terminal') {
        await this.tryProviderRecovery(live.sessionId, live.session, failure)
      } else this.failProviderRecovery(current, failure.message)
    }
  }

  private async doSendAdapterMessage(
    session: AgentSession,
    sessionId: string,
    message: string,
    attachments?: MessageAttachmentRef[],
    transcriptPartId?: string
  ): Promise<void> {
    this.assertSessionGeneration(sessionId, session)
    this.captainRollover?.cancel(session.taskId)
    session.autoAbortNotified = false

    if (session.status === 'error') {
      // An incompatible session is not recoverable; other errors (e.g. rate limits) are.
      if (session.adapter) {
        const adapterStatus = await this.ownShutdownWork(session.adapter.getStatus(sessionId, {} as SessionConfig))
        this.assertSessionGeneration(sessionId, session)
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
      await this.syncOwnedAttachments(session.taskId, session.workspaceDir, () => this.assertSessionGeneration(sessionId, session))
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
        id: transcriptPartId ?? `user-message-${Date.now()}`,
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
    this.assertSessionGeneration(sessionId, session)

    let promptText = this.attachmentExecution
      ? await this.ownShutdownWork(Promise.resolve().then(() => this.attachmentExecution!.context(session.taskId, session.workspaceDir, message, attachments,
        this.attachmentGuard(() => this.assertSessionGeneration(sessionId, session)))))
      : buildMessageWithAttachmentContext(session.workspaceDir, message, attachments)
    this.assertSessionGeneration(sessionId, session)
    // A session replacing a lost one starts from a recap, not blank. Only the
    // backend sees it: the transcript keeps the user's own words.
    const recap = session.pendingRecap
    const pendingLossId = session.pendingLossId
    if (recap) {
      if (session.managedTask && estimateTokens((recap + '\n\n' + promptText).length) > taskContextBudget(sessionConfig.model ?? ''))
        throw new Error('TASK_RECAP_INSTRUCTION_TOO_LARGE: the continuity seed and new instruction do not fit intact; both remain saved.')
      promptText = `${recap}\n\n${promptText}`
    }
    const send = (): Promise<void> => {
      this.assertSessionGeneration(sessionId, session)
      return this.sendTrackedPrompt(session, sessionId, promptText, sessionConfig)
    }
    await serializeTaskSend(this, session.taskId, send)
    // An admitted raw prompt acknowledgement still belongs to the durable
    // delivery after caller withdrawal. Return it for ledger acceptance while
    // suppressing new polling/state effects; the request owner refuses reply.
    if (!this.taskGroupRequests.isCurrent()) return
    // Stop may destroy the session while adapter acceptance is in flight.
    // The accepted call may finish, but it must not re-register polling or
    // otherwise revive the runtime after the explicit Stop boundary.
    if (!this.ownsSessionGeneration(sessionId, session)) return
    // Retry the recap until the adapter accepts a prompt.
    this.acknowledgeSessionRecap(session, pendingLossId)

    if (!session.pollingStarted) {
      console.log(`[AgentManager] Starting polling for session ${sessionId} (preserving dedup state)`)
      session.pollingStarted = true
      // Passing the session keeps its dedup state, so old messages are not re-sent.
      this.startAdapterPolling(sessionId, session.adapter, sessionConfig, session)
    }
  }

  /** Only the current native owner and live adapter callback grant approval. */
  async getSessionRequestScope(sessionId: string, requestId?: string, responseType?: 'permission' | 'question'): Promise<{
    sessionId: string; taskId: string; agentId: string; requestId: string; responseType: 'permission' | 'question'
  } | null> {
    const session = this.sessions.get(sessionId)
    if (!session || !this.ownsSessionGeneration(sessionId, session) || this.shuttingDown || !session.adapter?.getPendingRequests) return null
    const requests = await this.ownShutdownWork(session.adapter.getPendingRequests(sessionId, this.sessionConfigFor(session)))
    this.assertSessionGeneration(sessionId, session)
    if (!Array.isArray(requests) || requests.length > 256 || requests.some(request => !request || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 512 || !['permission', 'question'].includes(request.responseType)))
      throw new Error('The backend returned invalid pending requests.')
    const request = requests.find(row => (requestId === undefined || row.requestId === requestId) && (responseType === undefined || row.responseType === responseType))
    return request ? { sessionId, taskId: session.taskId, agentId: session.agentId, ...request } : null
  }

  async respondToScopedPermission(input: {
    sessionId: string; taskId: string; agentId: string; requestId: string; responseType: 'permission' | 'question'; approved: boolean; message?: string
  }): Promise<{ handled: boolean }> {
    if (!input || !input.requestId || !['permission', 'question'].includes(input.responseType) || typeof input.approved !== 'boolean') throw new Error('Select a current pending request.')
    const key = JSON.stringify([input.sessionId, input.requestId])
    if (this.scopedApprovalFlights.has(key)) throw new Error('This request already has a response in progress.')
    this.scopedApprovalFlights.add(key)
    return this.ownShutdownWork((async () => {
      try {
        const scope = await this.getSessionRequestScope(input.sessionId, input.requestId, input.responseType)
        if (!scope || scope.taskId !== input.taskId || scope.agentId !== input.agentId) return { handled: false }
        this.assertAgentConfigurationAvailable(scope.agentId)
        this.assertNoTaskGroupMutation(scope.taskId)
        if (input.responseType === 'question' && !input.approved) {
          await this.abortSession(input.sessionId, { requireAcknowledgement: true })
          return { handled: true }
        }
        return { handled: await this.respondToPermissionNow(input.sessionId, input.approved, input.message, undefined, input.responseType, input.requestId, true) }
      } finally { this.scopedApprovalFlights.delete(key) }
    })())
  }

  async respondToPermission(
    sessionId: string,
    approved: boolean,
    message?: string,
    optionId?: string,
    responseType?: 'permission' | 'question',
    requestId?: string
  ): Promise<void> {
    this.assertAgentConfigurationAvailable(this.resolveSession(sessionId)?.session.agentId)
    return this.ownShutdownWork(this.respondToPermissionNow(sessionId, approved, message, optionId, responseType, requestId).then(() => undefined))
  }

  private async respondToPermissionNow(
    sessionId: string,
    approved: boolean,
    message?: string,
    optionId?: string,
    responseType?: 'permission' | 'question',
    requestId?: string,
    requireAcknowledgement = false
  ): Promise<boolean> {
    if (this.shuttingDown) throw new Error('The app is shutting down; retry after restart.')
    const resolved = this.resolveSession(sessionId, 'respondToPermission')
    if (!resolved) throw new Error(`Session not found: ${sessionId}`)
    const { session } = resolved
    sessionId = resolved.sessionId
    this.assertSessionGeneration(sessionId, session)

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
        return false
      }

      // The renderer sends "Header1: Answer1\nHeader2: Answer2" or a single answer.
      // A free-form answer may include paragraphs and image attachment notes;
      // splitting those into fields loses all but the last unlabelled line.
      const answers: Record<string, string> = {}
      if (message) {
        const lines = message.split('\n').filter((line) => line.trim())
        if (lines.length > 0 && lines.every((line) => line.indexOf(':') > 0)) {
          for (const line of lines) {
            const colonIdx = line.indexOf(':')
            answers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
          }
        } else {
          answers['answer'] = message.trim()
        }
        // Question replies bypass doSendAdapterMessage. Make newly pasted
        // task images available before the adapter resumes the waiting turn.
        if (session.workspaceDir) {
          await this.syncOwnedAttachments(session.taskId, session.workspaceDir, () => this.assertSessionGeneration(sessionId, session))
        }
      }

      console.log(`[AgentManager] Responding to question via adapter for session ${sessionId}`)

      const adapterConfig = await this.buildSessionConfig(session.agentId, session.taskId, session.workspaceDir)
      this.assertSessionGeneration(sessionId, session)
      const response = requestId
        ? await adapter.respondToQuestion(sessionId, answers, adapterConfig, requestId)
        : await adapter.respondToQuestion(sessionId, answers, adapterConfig)
      this.assertSessionGeneration(sessionId, session)
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
        return false
      }

      if (requireAcknowledgement && handled !== true) throw new Error('The backend did not acknowledge this response.')

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
      return true
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
      this.assertSessionGeneration(sessionId, session)

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
        return false
      }

      // If no pending permission was found (stale prompt after watchdog abort
      // or app restart), send a continuation message so the session recovers.
      // AcpAdapter returns void (undefined), which won't match === false.
      if (handled === false && approved) {
        console.log(`[AgentManager] No pending permission found for ${sessionId}, sending continuation message to recover session`)
        this.sendInBackground(session, sessionId, 'continue')
      }
      return handled === true
    }

    console.warn(`[AgentManager] No adapter handler for permission response in session ${sessionId}`)
    return false
  }

  async stopAllSessions(): Promise<void> {
    if (this.deliveryRecoveryTimer) clearInterval(this.deliveryRecoveryTimer)
    this.deliveryRecoveryTimer = null
    console.log(`[AgentManager] Stopping all ${this.sessions.size} sessions`)

    this.resourceMonitor.stop()

    // Shutdown preserves the durable queue. The next process reconciles any
    // outstanding claim; stops below must not drain it in this process.
    this.shuttingDown = true
    this.taskGroupRequests.shutdown()
    this.captainRollover?.shutdown()
    this.captainEngine?.shutdown()
    this.taskEngine?.shutdown()
    this.compactionObserver?.shutdown()
    if (this.providerRecoveryTimer) clearTimeout(this.providerRecoveryTimer)
    this.providerRecoveryTimer = null
    if (this.startQueueRetryTimer) {
      clearTimeout(this.startQueueRetryTimer)
      this.startQueueRetryTimer = null
    }

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer)
      this.pollingTimer = null
    }
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer)
    this.nudgeTimer = null
    this.pollingEntries.clear()

    if (this.reaperTimer) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = null
    }

    await Promise.allSettled(
      // Shutdown preserves task status.
      [...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId, false))
    )
    // Don't wait for 60/120-second startup deadlines or declare lease release
    // safe while the underlying start can still touch this profile. The host
    // exits with DB/provider/lease held if this short drain cannot complete.
    await this.drainShutdownWork()
    await Promise.allSettled([...this.sessions.keys()].map(sessionId => this.stopSession(sessionId, false)))
    for (const id of this.scopedCleanupFailures) if (!this.sessions.has(id)) this.scopedCleanupFailures.delete(id)
    if (this.scopedCleanupFailures.size || this.scopedCleanupConflicts.size) throw new AgentShutdownIncompleteError()
    if (this.transcriptChangedTimer) clearTimeout(this.transcriptChangedTimer)
    this.transcriptChangedTimer = null
    this.flushTranscriptChanged()
  }

  private ownTaskStartup<T>(taskId: string, raw: Promise<T>): Promise<T> {
    const work = this.rawTaskStarts.get(taskId) ?? new Set<Promise<unknown>>()
    work.add(raw); this.rawTaskStarts.set(taskId, work)
    const settled = (): void => {
      work.delete(raw)
      if (!work.size && this.rawTaskStarts.get(taskId) === work) { this.rawTaskStarts.delete(taskId); this.scheduleStartQueueDrain() }
    }
    void raw.then(settled, settled)
    return this.ownShutdownWork(raw)
  }

  private async joinRawTaskStarts(taskId: string): Promise<void> {
    while (this.rawTaskStarts.has(taskId)) await Promise.allSettled([...this.rawTaskStarts.get(taskId)!])
  }

  private ownShutdownWork<T>(operation: Promise<T>): Promise<T> {
    this.taskGroupRequests.retainRaw(operation)
    this.shutdownWork.add(operation)
    void operation.then(() => { this.shutdownWork.delete(operation) }, () => { this.shutdownWork.delete(operation) })
    return operation
  }

  private async drainShutdownWork(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AgentShutdownIncompleteError()), AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS)
    })
    try {
      while (true) {
        const work = [...this.shutdownWork, ...this.sessionStarts.values(), ...this.sessionStops.values(),
          ...[...this.captainSwitches.values()].map(entry => entry.promise),
          ...(this.startupReconciliation ? [this.startupReconciliation] : [])]
        if (!work.length) {
          if (this.admittedStarts.size) throw new AgentShutdownIncompleteError()
          return
        }
        await Promise.race([Promise.allSettled(work), expired])
        // Map cleanup and a queued start's post-settlement handlers may await
        // an event-loop yield. Do not starve them or the bounded timer by
        // repeatedly awaiting an already-settled reservation promise.
        await Promise.race([yieldEventLoop(), expired])
      }
    } finally { if (timer) clearTimeout(timer) }
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
    const stopping = this.taskStops.get(taskId)
    if (stopping && stopping.session.status !== 'error' && !sessionIds.includes(stopping.sessionId)) {
      sessionIds.push(stopping.sessionId)
    }
    return sessionIds
  }

  async getProviders(serverUrl?: string, directory?: string, backendType?: string): Promise<{ providers: { id: string; name: string; [key: string]: unknown }[]; default: Record<string, string> } | null> {
    return this.retainWorkspaceProcessWork(() => this.getProvidersNow(serverUrl, directory, backendType))
  }

  private async getProvidersNow(serverUrl?: string, directory?: string, backendType?: string): ReturnType<AgentManager['getProviders']> {
    this.assertWorkspaceCleanupAvailable()
    if (this.shuttingDown) return null
    try {
      const defaultAgent = this.defaultAgent()
      const baseUrl = serverUrl || defaultAgent?.server_url || DEFAULT_SERVER_URL
      const resolvedBackend = backendType || getAgentProvider(defaultAgent)
      if (this.backendConfigurationMutations.has(resolvedBackend) || this.failedBackendConfigurations.has(resolvedBackend)) throw new Error('Backend configuration is unavailable while it is being refreshed.')

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

      // Enumeration is a read. Runtime configuration refresh belongs to the
      // explicit mutation fence, since a shared server refresh can stop work.
      if (this.shuttingDown) return null
      const providers = await adapter.getProviders(baseUrl, directory)
      return this.shuttingDown ? null : providers
    } catch (error: unknown) {
      console.log('[AgentManager] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Models the installed Claude Code or Codex CLI offers, or null when the
   * backend has no such listing or the CLI could not be asked.
   */
  async listModels(backendType: string): Promise<BackendModel[] | null> {
    return this.retainWorkspaceProcessWork(() => this.listModelsNow(backendType))
  }

  private async listModelsNow(backendType: string): Promise<BackendModel[] | null> {
    this.assertWorkspaceCleanupAvailable()
    if (this.shuttingDown) return null
    if (this.backendConfigurationMutations.has(backendType) || this.failedBackendConfigurations.has(backendType)) return null
    const adapter = this.getAdapterByType(backendType)
    if (!adapter?.listModels) return null
    try {
      const models = await adapter.listModels()
      return this.shuttingDown ? null : models
    } catch (error: unknown) {
      console.log(`[AgentManager] Could not list ${backendType} models:`, error instanceof Error ? error.message : error)
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
    // #74: what the session learned belongs to its task's project.
    const projectId = session.taskId ? this.db.getTask(session.taskId)?.project_id ?? null : null
    return syncSkillsFromDirectory(this.db, session.workspaceDir, { projectId })
  }

  /**
   * Register an external listener that receives all events sent to the renderer.
   * Used by the mobile API server to broadcast via WebSocket.
   */
  addExternalListener(fn: (channel: string, data: unknown) => void): void {
    this.externalListeners.push(fn)
  }

  /** Desktop freshness only. Never a transition, mobile or voice subscription.
   * The returned release removes exactly this registration. */
  addActivityListener(fn: (event: Readonly<AgentActivityObservation>) => void): () => void {
    const receive = (event: Readonly<AgentActivityObservation>): void => fn(event)
    this.activityListeners.add(receive)
    return () => { this.activityListeners.delete(receive) }
  }

  /** Releases exactly one registration without affecting other consumers. */
  removeExternalListener(fn: (channel: string, data: unknown) => void): void {
    const index = this.externalListeners.indexOf(fn)
    if (index >= 0) this.externalListeners.splice(index, 1)
  }

  /**
   * Auto-enable heartbeat for a task if a heartbeat.md file exists in the workspace.
   * Called after a task transitions to ready_for_review.
   */
  private autoEnableHeartbeat(taskId: string): void {
    if (this.db.getTask(taskId)?.role === 'task_group') return
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
    const result = this.db.upsertTranscriptParts(event.taskId, event.parts, 'live')
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
    if (this.taskGroupRequests.scoped) return this.taskGroupRequests.detached(() => this.emitTranscriptChanged(taskId, sinceRev, maxRev))
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
        sent = this.sendHostEvent(this.mainWindow.webContents, 'transcript:changed', {
          ...payload, parts: parts.map(part => transcriptDisplayPart(part))
        })
      } catch (err) {
        console.error('[AgentManager] Could not prepare transcript update for display:', err)
      }
      if (!sent) {
        // Keep the client cursor unchanged; the renderer reconciles via a delta read.
        this.sendHostEvent(this.mainWindow.webContents, 'transcript:changed', {
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
  private sendHostEvent(target: AgentWindow['webContents'], channel: string, ...args: unknown[]): boolean {
    return this.host.renderer.kind === 'native' && this.host.renderer.send(target, channel, ...args)
  }

  private broadcast(channel: string, payload: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.sendHostEvent(this.mainWindow.webContents, channel, payload)
    }
    this.notifyExternalListeners(channel, payload)
  }

  private notifyExternalListeners(channel: string, payload: unknown): void {
    for (const fn of [...this.externalListeners]) {
      try { fn(channel, payload) } catch { /* one failing listener must not block the rest */ }
    }
  }

  private sendToRenderer(channel: string, data: unknown): void {
    // Durable transcript projection: persist every transcript part BEFORE any
    // client sees it. The main process owns the source of truth; renderer and
    // mobile hydrate from snapshots (transcript:get) instead of depending on
    // catching live events, so output produced while no view is bound
    // (background wake-ups, silently resumed sessions) is never lost.
    //
    // Clients only read the `transcript:changed` delta that persisting emits,
    // which carries display previews of oversized records. The raw event is
    // never broadcast: nothing listens to it, and a single poll of large tool
    // output can run to tens of megabytes.
    if (channel === 'agent:output' || channel === 'agent:output-batch') {
      try {
        this.persistTranscriptEvent(channel, data)
      } catch (err) {
        console.error('[AgentManager] Failed to persist transcript parts:', err)
      }
      return
    }

    this.broadcast(channel, data)

    if (channel === 'agent:status' && data && typeof data === 'object') {
      const { sessionId, status, taskId } = data as { sessionId?: string; status?: string; taskId?: string }
      if (sessionId && status) {
        const prevStatus = this.lastSentStatus.get(sessionId)
        this.lastSentStatus.set(sessionId, status)
        notifyStatusTransition(this.db, () => this.mainWindow, prevStatus, status, taskId, this.host.notifications)
      }
    }
  }
}

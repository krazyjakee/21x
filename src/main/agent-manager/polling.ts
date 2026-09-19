import { TaskStatus } from '../../shared/constants'
import { MessagePartType, SessionStatusType } from '../adapters/coding-agent-adapter'
import type { CodingAgentAdapter, MessagePart, SessionConfig, SessionStatus } from '../adapters/coding-agent-adapter'
import { isCodexAppServerAdapter } from './adapter-factory'
import { findCreditExhaustionMessage } from './credit-exhaustion'
import { assistantTextKey, hasMatchingErrorMessage, pruneDedup } from './output-dedup'
import { buildTillDoneNudge } from './prompts'
import type { OutputMessage } from './transcript-events'
import type { AgentSession, PollingEntry, SessionHost } from './types'
import { STUCK_SESSION_TIMEOUT_MS, findStuckTool, hasGarbledOutput, isDelegationTool, isWaitingForUserInput, type RunningTool } from './watchdogs'

type PollingHost = Pick<SessionHost,
  | 'db' | 'sessions' | 'resolveSession' | 'rekeySession' | 'sessionConfigFor' | 'emitStatus' | 'emitSystemError'
  | 'sendToRenderer' | 'updateTaskFromLocalAgent' | 'hasActiveSubtaskWork' | 'tryAutomaticFallback'
  | 'transitionToIdle' | 'sendAdapterMessage'>

const POLL_INTERVAL_MS = 2000
const FIRST_POLL_DELAY_MS = 1000
/** Debounce for adapter data nudges: batches rapid stream events into one cycle. */
const NUDGE_DELAY_MS = 50
const MAX_TILLDONE_NUDGES = 5
/** No IDLE transition this soon after a prompt unless work was seen. */
const IDLE_GRACE_PERIOD_MS = 15_000
/** No IDLE transition this soon after the last received data. */
const POST_DATA_GRACE_MS = 5_000
const DONE_TODO_STATUSES = ['completed', 'cancelled', 'done', 'removed']

/** Yields between bursts of synchronous DB calls (better-sqlite3 blocks the main thread). */
export const yieldEventLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * Centralized polling coordinator. Instead of one timer per session (which
 * fire together, stack synchronous DB calls and starve the event loop), a
 * single timer polls every registered session SEQUENTIALLY every 2 seconds.
 * Adapters call onDataAvailable() when they buffer stream data; that nudges a
 * cycle within ~50ms which polls only the sessions that reported data.
 */
export class SessionPoller {
  readonly entries = new Map<string, PollingEntry>()
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null
  private cycleInProgress = false
  /** Requests that arrived while a cycle ran; the cycle re-raises them when it ends. */
  private sweepRequested = false
  private nudgeRequested = false
  /** Sessions being re-registered after late adapter data (dedupe guard). */
  private wakingSessions = new Set<string>()

  constructor(private readonly host: PollingHost) {}

  /**
   * Registers a session for the prompt just sent. Passing the session keeps
   * its dedup state, so already-delivered output is not sent again.
   */
  start(sessionId: string, adapter: CodingAgentAdapter, config: SessionConfig, existingSession?: AgentSession): void {
    this.entries.set(sessionId, {
      sessionId,
      adapter,
      config,
      seenMessageIds: existingSession?.seenMessageIds ?? new Set<string>(),
      seenPartIds: existingSession?.seenPartIds ?? new Set<string>(),
      partContentLengths: existingSession?.partContentLengths ?? new Map<string, string>(),
      assistantTextKeys: existingSession?.assistantTextKeys ?? new Set<string>(),
      createdAt: Date.now(),
      // Always false, also for an existing session: the backend can briefly
      // report IDLE after a follow-up prompt while still ingesting it, and the
      // grace period must cover every prompt.
      hasSeenWork: false
    })
    console.log(`[AgentManager] Registered session ${sessionId} for polling (${this.entries.size} active)`)

    adapter.onDataAvailable ??= (dataSessionId: string) => {
      // A session whose polling already stopped can still produce data (Claude
      // Code backgrounds subagents: the turn ends first and the children report
      // later), so re-register it or the data is never collected.
      this.wakeSessionOnAdapterData(dataSessionId)
      // Claude Code keeps reporting under its temporary id after the re-key.
      const entry = this.entries.get(dataSessionId) ?? this.entries.get(this.host.resolveSession(dataSessionId)?.sessionId ?? '')
      if (entry) entry.dataArrivedSincePoll = true
      this.nudge()
    }

    this.ensureCoordinator()
  }

  stop(sessionId: string): void {
    this.entries.delete(sessionId)
    console.log(`[AgentManager] Unregistered session ${sessionId} from polling (${this.entries.size} remaining)`)
    if (this.entries.size === 0) this.clearTimers()
  }

  stopAll(): void {
    this.clearTimers()
    this.entries.clear()
  }

  /** Puts a session that went idle too early back to work and polling. */
  resumeAfterPrematureIdle(sessionId: string, session: AgentSession): void {
    if (!session.adapter) return
    session.status = 'working'
    session.pollingStarted = true
    this.start(sessionId, session.adapter, this.host.sessionConfigFor(session), session)
    const entry = this.entries.get(sessionId)
    if (entry) {
      entry.hasSeenWork = true
      entry.lastPartReceivedAt = Date.now()
    }
    this.host.emitStatus(sessionId, session, 'working')
  }

  private clearTimers(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer)
    this.sweepTimer = null
    this.nudgeTimer = null
  }

  private ensureCoordinator(): void {
    // A running cycle schedules the next sweep when it ends.
    if (this.sweepTimer || this.cycleInProgress) return
    this.scheduleSweep(FIRST_POLL_DELAY_MS)
  }

  private scheduleSweep(delay = POLL_INTERVAL_MS): void {
    if (this.sweepTimer || this.entries.size === 0) return
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null
      this.runCycle(true).catch((err) => console.error('[AgentManager] Polling sweep error:', err))
    }, delay)
  }

  private nudge(): void {
    if (this.nudgeTimer || this.entries.size === 0) return
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null
      this.runCycle(false).catch((err) => console.error('[AgentManager] Nudge cycle error:', err))
    }, NUDGE_DELAY_MS)
  }

  /**
   * One poll cycle. A sweep polls every entry; a nudged cycle only the entries
   * whose adapter reported data since their last poll, so a streaming session
   * does not make every other session poll its backend at stream rate.
   */
  private async runCycle(sweep: boolean): Promise<void> {
    if (this.cycleInProgress) {
      // The running cycle may already have polled the session with new data,
      // so the request cannot be dropped.
      if (sweep) this.sweepRequested = true
      else this.nudgeRequested = true
      return
    }
    this.cycleInProgress = true
    try {
      for (const entry of [...this.entries.values()]) {
        if (!this.entries.has(entry.sessionId)) continue
        if (!sweep && !entry.dataArrivedSincePoll) continue
        await this.pollSingleSession(entry)
        await yieldEventLoop()
      }
    } catch (error) {
      console.error('[AgentManager] Polling coordinator error:', error)
    } finally {
      this.cycleInProgress = false
    }

    if (this.sweepRequested) {
      this.sweepRequested = false
      return this.runCycle(true)
    }
    this.scheduleSweep()
    if (this.nudgeRequested) {
      this.nudgeRequested = false
      this.nudge()
    }
  }

  /**
   * Re-registers a session whose adapter buffered data after polling stopped
   * (e.g. Claude Code Task-tool subagents reporting back after the turn
   * ended). Only when the adapter reports it is busy again, so trailing data
   * from a finished session does not ping-pong the task status.
   */
  private wakeSessionOnAdapterData(sessionId: string): void {
    if (this.entries.has(sessionId) || this.wakingSessions.has(sessionId)) return
    const resolved = this.host.resolveSession(sessionId)
    const adapter = resolved?.session.adapter
    if (!resolved || !adapter) return
    // session.status is not a usable guard: the entry is removed before
    // transitionToIdle() completes, so the session can still say "working"
    // while no poller exists, and data arriving then must still wake it.
    const { sessionId: targetId, session } = resolved
    this.wakingSessions.add(targetId)
    void (async () => {
      try {
        if (this.entries.has(targetId)) return
        const status = await adapter.getStatus(targetId, this.host.sessionConfigFor(session))
        if (status.type !== SessionStatusType.BUSY && status.type !== SessionStatusType.WAITING_APPROVAL) return
        if (this.entries.has(targetId)) return

        console.log(
          `[AgentManager] Session ${targetId} produced data after going idle and is ${status.type} again ` +
          `(background subagent work) — resuming polling`
        )
        // transitionToIdle may already have moved the task to review.
        if (this.host.db.getTask(session.taskId)?.status === TaskStatus.ReadyForReview) {
          this.host.updateTaskFromLocalAgent(session.taskId, { status: TaskStatus.AgentWorking })
          this.host.sendToRenderer('task:updated', { taskId: session.taskId, updates: { status: TaskStatus.AgentWorking } })
        }
        this.resumeAfterPrematureIdle(targetId, session)
      } catch (err) {
        console.error(`[AgentManager] wakeSessionOnAdapterData failed for ${targetId}:`, err)
      } finally {
        this.wakingSessions.delete(targetId)
      }
    })()
  }

  /** Polls one session for new output and status changes. */
  async pollSingleSession(entry: PollingEntry): Promise<void> {
    const { adapter, config } = entry
    try {
      let sessionId = this.resolveEntrySessionId(entry)
      const activeSession = this.host.sessions.get(sessionId)
      if (!activeSession) {
        console.log(`[AgentManager] Session ${sessionId} no longer exists, removing from polling`)
        this.stop(entry.sessionId)
        return
      }

      // Cleared right before the poll: anything buffered from here on is known
      // to be undelivered (at worst one extra cycle, never a lost message).
      entry.dataArrivedSincePoll = false
      const newParts = await adapter.pollMessages(sessionId, entry.seenMessageIds, entry.seenPartIds, entry.partContentLengths, config)
      pruneDedup(entry)

      const realSessionId = newParts.find(p => p.realSessionId)?.realSessionId
      if (realSessionId && realSessionId !== sessionId) {
        console.log(`[SessionTracker] REKEYED old=${sessionId} new=${realSessionId} task=${config.taskId} reason=adapter_provided_real_id`)
        this.host.rekeySession(sessionId, realSessionId, config.taskId)
        this.moveEntry(entry, realSessionId)
        sessionId = realSessionId
      }

      if (newParts.length > 0) {
        entry.lastPartReceivedAt = Date.now()
        activeSession.lastActivityAt = Date.now()
        // New data means this cycle is alive. The session-level one-shot guard
        // stays: late output from an interrupted turn must not re-arm the abort.
        entry.watchdogFired = false
        if (await this.abortOnGarbledOutput(entry, sessionId, activeSession, newParts)) return
      }

      // hasSeenWork is set only from BUSY / WAITING_APPROVAL: message content is
      // unreliable (user echoes and stale parts of previous turns arrive first).
      const batchMessages = this.collectOutputBatch(entry, sessionId, newParts)
      const currentSession = this.host.sessions.get(sessionId)
      if (currentSession) captureSessionProgress(currentSession, batchMessages)
      if (batchMessages.length > 0) {
        this.host.sendToRenderer('agent:output-batch', { sessionId, taskId: config.taskId, messages: batchMessages })
      }

      const status = await adapter.getStatus(sessionId, config)
      const session = this.host.sessions.get(sessionId)
      if (status.type === SessionStatusType.ERROR) {
        await this.handleErrorStatus(sessionId, session, config, status, batchMessages)
      } else if (!session) {
        return
      } else if (status.type === SessionStatusType.WAITING_APPROVAL) {
        entry.hasSeenWork = true
        if (session.status !== 'waiting_approval') {
          session.status = 'waiting_approval'
          this.host.emitStatus(sessionId, config, 'waiting_approval')
        }
      } else if (status.type === SessionStatusType.BUSY) {
        // Re-read the entry: an abort or stop during the awaits above removes
        // it, and the watchdogs and tillDone must not act on a stale one.
        await this.handleBusyStatus(this.entries.get(sessionId), sessionId, session, config, batchMessages)
      } else if (status.type === SessionStatusType.IDLE) {
        this.handleIdleStatus(this.entries.get(sessionId), sessionId, session)
      }
    } catch (error: unknown) {
      console.error('[AgentManager] Adapter polling error:', error)
    }
  }

  /** Follows a re-key (temp -> real id) by task id. */
  private resolveEntrySessionId(entry: PollingEntry): string {
    if (this.host.sessions.has(entry.sessionId)) return entry.sessionId
    for (const [sid, session] of this.host.sessions) {
      if (session.taskId === entry.config.taskId) {
        this.moveEntry(entry, sid)
        return sid
      }
    }
    return entry.sessionId
  }

  private moveEntry(entry: PollingEntry, sessionId: string): void {
    this.entries.delete(entry.sessionId)
    entry.sessionId = sessionId
    this.entries.set(sessionId, entry)
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
    if (!suppressTranscript) this.host.emitSystemError(sessionId, taskId, `${idPrefix}-${Date.now()}`, content)
    return true
  }

  private async abortPrompt(entry: PollingEntry, sessionId: string, what: string): Promise<void> {
    try {
      await entry.adapter.abortPrompt(sessionId, entry.config)
    } catch (abortErr) {
      console.error(`[AgentManager] Failed to abort ${what} session ${sessionId}:`, abortErr)
    }
  }

  /**
   * Some models hallucinate tool-call markup as plain text, which wastes
   * tokens and never resolves. Aborts after 2 consecutive garbled cycles
   * (fewer false positives) instead of waiting for the watchdog.
   */
  private async abortOnGarbledOutput(entry: PollingEntry, sessionId: string, session: AgentSession, newParts: MessagePart[]): Promise<boolean> {
    if (!hasGarbledOutput(newParts)) {
      entry.garbledOutputCount = 0
      return false
    }
    entry.garbledOutputCount = (entry.garbledOutputCount || 0) + 1
    if (entry.garbledOutputCount < 2 || entry.watchdogFired) return false

    entry.watchdogFired = true
    console.warn(`[AgentManager] Session ${sessionId}: garbled model output detected (${entry.garbledOutputCount} cycles). Aborting to prevent token waste.`)
    this.sendAutoAbortMessageOnce(
      sessionId,
      session,
      entry.config.taskId,
      'garbled-abort',
      'Session aborted: model is producing garbled output (hallucinated tool-call markup). You can send a new message to continue.'
    )
    await this.abortPrompt(entry, sessionId, 'garbled')
    return true
  }

  /** Converts polled parts (plus any pending approval request) into transcript messages. */
  private collectOutputBatch(entry: PollingEntry, sessionId: string, newParts: MessagePart[]): OutputMessage[] {
    const batchMessages: OutputMessage[] = []
    for (const part of newParts) {
      // User messages are emitted when sent; the adapter echoes them back under
      // different ids, so seenPartIds cannot dedupe them.
      if (part.role === 'user' || (part.role as string) === 'human') continue
      const role = part.role || 'assistant'
      const content = part.content || part.text || ''
      const assistantKey = assistantTextKey(role, part.type, content, part.tool, part.taskProgress)
      if (assistantKey) (entry.assistantTextKeys ??= new Set<string>()).add(assistantKey)
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

    const approval = entry.adapter.getPendingApproval?.(sessionId)
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
            options: approval.options.map((opt) => ({ label: opt.name }))
          }]
        }
      })
    }
    return batchMessages
  }

  private async handleErrorStatus(
    sessionId: string,
    session: AgentSession | undefined,
    config: SessionConfig,
    status: SessionStatus,
    batchMessages: OutputMessage[]
  ): Promise<void> {
    if (status.message?.includes('INCOMPATIBLE_SESSION_ID')) {
      console.warn('[AgentManager] Incompatible session detected during polling:', sessionId)
      this.host.updateTaskFromLocalAgent(config.taskId, { session_id: null })
      this.host.sendToRenderer('agent:incompatible-session', {
        taskId: config.taskId,
        agentId: config.agentId,
        error: status.message.replace('INCOMPATIBLE_SESSION_ID: ', '')
      })
      this.stop(sessionId)
      return
    }

    if (status.message?.includes('Client not found')) {
      console.log(`[AgentManager] Client not found for session ${sessionId}, stopping polling`)
      this.stop(sessionId)
      return
    }

    // A provider error the same poll already delivered as a part is not repeated.
    if (!hasMatchingErrorMessage(batchMessages, status.message)) {
      this.host.emitSystemError(sessionId, config.taskId, `error-${Date.now()}`, status.message || 'An unexpected error occurred. Check logs for details.')
    }

    const exhaustionMessage = findCreditExhaustionMessage([
      status.message,
      ...batchMessages
        .filter((message) => message.partType === MessagePartType.ERROR || message.role === 'system')
        .map((message) => message.content)
    ])
    if (session && exhaustionMessage && await this.host.tryAutomaticFallback(sessionId, session, exhaustionMessage)) return

    if (session) {
      session.status = 'error'
      session.pollingStarted = false
      this.host.emitStatus(sessionId, config, 'error')
    }
    this.stop(sessionId)
  }

  private async handleBusyStatus(
    entry: PollingEntry | undefined,
    sessionId: string,
    session: AgentSession,
    config: SessionConfig,
    batchMessages: OutputMessage[]
  ): Promise<void> {
    if (entry) {
      entry.hasSeenWork = true
      // Working again (possibly after a tillDone nudge): fresh nudge allowance.
      entry.tillDoneNudgeCount = 0

      let runningTools: RunningTool[] = []
      if (entry.adapter.getRunningTools) {
        try {
          runningTools = await entry.adapter.getRunningTools(sessionId, config)
        } catch {
          // Non-fatal — watchdogs fall back to their other signals
        }
      }

      if (!entry.watchdogFired && runningTools.length > 0 && await this.abortStuckTool(entry, sessionId, session, runningTools)) return
      if (await this.runStuckSessionWatchdog(entry, sessionId, session, runningTools, batchMessages)) return
    }
    if (session.status !== 'working') {
      session.status = 'working'
      this.host.emitStatus(sessionId, config, 'working')
    }
  }

  /**
   * Fast stuck-tool detector: some tools (notably `read` on cross-workspace
   * files) hang silently, and the session watchdog waits 5 minutes.
   * Returns true when this poll cycle must stop.
   */
  private async abortStuckTool(entry: PollingEntry, sessionId: string, session: AgentSession, runningTools: RunningTool[]): Promise<boolean> {
    const { adapter, config } = entry
    let reason: string | null
    try {
      reason = findStuckTool(runningTools, config.workspaceDir)
    } catch {
      return false // Non-fatal: the session watchdog still applies
    }
    if (!reason) return false

    entry.watchdogFired = true
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
    await this.abortPrompt(entry, sessionId, 'stuck-tool')
    return true
  }

  /**
   * A session BUSY with no new data for STUCK_SESSION_TIMEOUT_MS likely has a
   * tool call hung inside the agent process, so the prompt is aborted. Stands
   * down while the session waits for the user or delegates: a coordinator
   * whose subagents/subtasks work is silent itself, and aborting it would
   * cascade into the children. Returns true when this poll cycle must stop.
   */
  private async runStuckSessionWatchdog(
    entry: PollingEntry,
    sessionId: string,
    session: AgentSession,
    runningTools: RunningTool[],
    batchMessages: OutputMessage[]
  ): Promise<boolean> {
    const { adapter, config } = entry
    const silentDuration = Date.now() - (entry.lastPartReceivedAt || entry.createdAt)
    if (silentDuration <= STUCK_SESSION_TIMEOUT_MS || entry.watchdogFired) return false
    const silentSeconds = Math.round(silentDuration / 1000)

    if (isWaitingForUserInput(session.status, batchMessages, adapter, sessionId)) {
      console.log(`[AgentManager] Session ${sessionId} BUSY for ${silentSeconds}s but has pending user input — not aborting`)
      return false
    }
    if (runningTools.some((tool) => isDelegationTool(tool.toolName)) || this.host.hasActiveSubtaskWork(config.taskId)) {
      console.log(`[AgentManager] Session ${sessionId} BUSY for ${silentSeconds}s but has active delegation (subagents/subtasks in progress) — not aborting`)
      return false
    }
    if (runningTools.length > 0) {
      console.log(`[AgentManager] Session ${sessionId} BUSY for ${silentSeconds}s but has an active tool — using the tool-specific inactivity deadline`)
      return false
    }

    entry.watchdogFired = true
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
    await this.abortPrompt(entry, sessionId, 'stuck')
    return true
  }

  private handleIdleStatus(entry: PollingEntry | undefined, sessionId: string, session: AgentSession): void {
    if (entry && !this.shouldLeaveIdle(entry, sessionId, session)) return

    console.log(`[AgentManager] Detected IDLE status for ${sessionId}, calling transitionToIdle`)
    if (entry) {
      // Keep what was already seen, so a follow-up message's polling does not re-send it.
      for (const id of entry.seenMessageIds) session.seenMessageIds.add(id)
      for (const id of entry.seenPartIds) session.seenPartIds.add(id)
      for (const [k, v] of entry.partContentLengths) session.partContentLengths.set(k, v)
      session.assistantTextKeys ??= new Set<string>()
      for (const key of entry.assistantTextKeys ?? []) session.assistantTextKeys.add(key)
      pruneDedup(session)
    }
    session.pollingStarted = false
    // Unregister first so other sessions aren't starved while transitionToIdle
    // (slow: extracts output values) runs; it is not awaited.
    this.stop(sessionId)
    this.host.transitionToIdle(sessionId, session).catch((err) => {
      console.error(`[AgentManager] transitionToIdle error for ${sessionId}:`, err)
    })
  }

  /** False while an IDLE report must not end the turn yet. */
  private shouldLeaveIdle(entry: PollingEntry, sessionId: string, session: AgentSession): boolean {
    // The prompt is sent fire-and-forget and the backend may not have started
    // on it yet; without this grace period polling would stop for good.
    if (!entry.hasSeenWork && Date.now() - entry.createdAt < IDLE_GRACE_PERIOD_MS) return false
    // Some models briefly report idle between tool-call rounds.
    if (entry.lastPartReceivedAt && Date.now() - entry.lastPartReceivedAt < POST_DATA_GRACE_MS) return false
    if (this.sendTillDoneNudge(entry, sessionId, session)) return false

    // The adapter buffered data after this cycle polled it, and the turn's
    // result came with that data (hence IDLE). Unregistering now would strand
    // it until the NEXT prompt (an agent's closing message then appeared below
    // the user's following message), so the next cycle drains it first.
    if (entry.dataArrivedSincePoll) {
      console.log(`[AgentManager] IDLE for ${sessionId} deferred: adapter buffered data after this poll`)
      return false
    }
    return true
  }

  /**
   * TillDone: an agent that goes idle with incomplete todos (captured from
   * polled todowrite calls, so it works for every coding agent) is prompted
   * to continue, up to MAX_TILLDONE_NUDGES times. True when a nudge was sent.
   */
  private sendTillDoneNudge(entry: PollingEntry, sessionId: string, session: AgentSession): boolean {
    const incomplete = session.todos?.filter(t => !DONE_TODO_STATUSES.includes(t.status)) ?? []
    if (incomplete.length === 0) return false

    const nudgeCount = entry.tillDoneNudgeCount || 0
    if (nudgeCount >= MAX_TILLDONE_NUDGES) {
      console.log(`[AgentManager] TillDone nudge limit (${MAX_TILLDONE_NUDGES}) reached for ${sessionId}, transitioning to idle`)
      return false
    }

    entry.tillDoneNudgeCount = nudgeCount + 1
    console.log(`[AgentManager] TillDone nudge #${nudgeCount + 1} for ${sessionId}: ${incomplete.length} incomplete todo(s)`)
    // The standard message path resets status to 'working' and keeps polling alive.
    this.host.sendAdapterMessage(session, sessionId, buildTillDoneNudge(session.todos!, incomplete)).catch((err) => {
      console.error(`[AgentManager] TillDone nudge failed for ${sessionId}:`, err)
    })
    return true
  }
}

/**
 * Records the last assistant text (read by HeartbeatScheduler) and the latest
 * todo list from todowrite calls (used for TillDone nudges).
 */
function captureSessionProgress(session: AgentSession, batchMessages: OutputMessage[]): void {
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
    // Replaced, not appended, and capped at 50 KB.
    const joined = assistantTexts.join('\n')
    session.lastAssistantText = joined.length > 50_000 ? joined.slice(-50_000) : joined
  }
}

import { guardedIpcSend } from './guarded-ipc-send'
import { BrowserWindow, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { DatabaseManager, TaskRecord } from './database'
import type { AgentManager } from './agent-manager'
import { HeartbeatStatus, HEARTBEAT_OK_TOKEN, HEARTBEAT_INFO_TOKEN, HEARTBEAT_DEFAULTS, TaskStatus } from '../shared/constants'
import { buildSystemMessage, computeDeliveryId, evaluateAuthorityGate, SystemMessageOrigin } from '../shared/system-authority'
import { extractGitHubUrls, requiresCurrentStateChecks, runPreflightChecks } from './heartbeat-preflight'
import { emitTaskEvent } from './project-events'

/**
 * Periodic monitoring of tasks in ready_for_review status (OpenClaw's heartbeat
 * pattern). Every tick it picks tasks whose heartbeat is due, runs the checks
 * listed in the task's heartbeat.md, notifies the user only when attention is
 * needed, and logs each result to heartbeat_logs.
 *
 * ## heartbeat.md
 * A markdown file written by the agent when it finishes a task. Contains a checklist
 * of items to periodically monitor (e.g., PR comments, CI status, issue updates).
 *
 * ## Lifecycle
 * - Created: Agent writes heartbeat.md → auto-enabled on task completion
 * - Active: Runs while task is in ready_for_review status
 * - Terminated: Task moves to completed, or heartbeat.md is deleted
 */
export class HeartbeatScheduler {
  private dbManager: DatabaseManager
  private agentManager: AgentManager
  private intervalId: NodeJS.Timeout | null = null
  private mainWindow: BrowserWindow | null = null
  private readonly CHECK_INTERVAL = HEARTBEAT_DEFAULTS.checkIntervalMs
  private readonly MAX_CONSECUTIVE_ERRORS = HEARTBEAT_DEFAULTS.maxConsecutiveErrors

  private inProgress: Set<string> = new Set()
  /** In-progress skips already logged, so each is logged once rather than every tick. */
  private loggedInProgress: Set<string> = new Set()
  /**
   * Findings already forwarded to a task agent, keyed by delivery id → timestamp.
   * Makes forwarding idempotent: the same finding for the same task is delivered once,
   * even when two heartbeat runs (scheduled + Run Now) read the same captain reply.
   */
  private deliveredFindings: Map<string, number> = new Map()
  /** How long a delivery id suppresses an identical repeat delivery. */
  private readonly DELIVERY_DEDUPE_WINDOW_MS = 6 * 60 * 60_000

  constructor(dbManager: DatabaseManager, agentManager: AgentManager) {
    this.dbManager = dbManager
    this.agentManager = agentManager
  }

  start(mainWindow: BrowserWindow): void {
    this.stop() // clear any previous timer to prevent interval leaks
    this.mainWindow = mainWindow
    console.log('[HeartbeatScheduler] Starting scheduler...')

    this.checkHeartbeats()

    this.intervalId = setInterval(() => {
      this.checkHeartbeats()
    }, this.CHECK_INTERVAL)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('[HeartbeatScheduler] Scheduler stopped')
    }
  }

  enableHeartbeat(taskId: string, intervalMinutes?: number): void {
    const interval = intervalMinutes ?? this.getDefaultInterval()
    const nextCheck = new Date(Date.now() + interval * 60_000).toISOString()
    const updates = {
      heartbeat_enabled: true,
      heartbeat_interval_minutes: interval,
      heartbeat_next_check_at: nextCheck
    }
    this.dbManager.updateTask(taskId, updates)
    this.sendToRenderer('task:updated', { taskId, updates })
    console.log(`[HeartbeatScheduler] Enabled heartbeat for task ${taskId}, interval: ${interval}min, next: ${nextCheck}`)
  }

  disableHeartbeat(taskId: string): void {
    const updates = { heartbeat_enabled: false, heartbeat_next_check_at: null }
    this.dbManager.updateTask(taskId, updates)
    this.sendToRenderer('task:updated', { taskId, updates })
    console.log(`[HeartbeatScheduler] Disabled heartbeat for task ${taskId}`)
  }

  /**
   * Manual heartbeat check. Skips the pre-flight checks because the user asked
   * for it; the returned status is shown in the UI.
   */
  async runNow(taskId: string): Promise<'sent' | 'no_file' | 'no_agent' | 'in_progress' | 'error'> {
    const task = this.dbManager.getTask(taskId)
    if (!task) {
      console.warn(`[HeartbeatScheduler] runNow: task ${taskId} not found`)
      return 'error'
    }

    // A manual run must never race a scheduled run. Two concurrent runs share one
    // captain session, so both would read the same reply and forward it twice.
    if (this.inProgress.has(taskId)) {
      console.log(`[HeartbeatScheduler] runNow: heartbeat already in progress for task ${taskId}`)
      return 'in_progress'
    }

    const heartbeatContent = this.readHeartbeatFile(taskId)
    if (!heartbeatContent) {
      return 'no_file'
    }

    const agentId = this.resolveAgentId(task)
    if (!agentId) {
      return 'no_agent'
    }

    this.inProgress.add(taskId)

    try {
      const checkPrompt = this.buildHeartbeatPrompt(task, heartbeatContent)
      const captainSessionId = await this.agentManager.sendHeartbeatViaCaptain(agentId, task.id, checkPrompt)

      // Wait for the result in the background so the IPC call returns immediately.
      this.processRunNowResult(captainSessionId, task, agentId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[HeartbeatScheduler] runNow background error for task ${taskId}:`, message)
        this.logResult(taskId, HeartbeatStatus.Error, message)
      })

      return 'sent'
    } catch (err) {
      this.clearInProgress(taskId)
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[HeartbeatScheduler] runNow error for task ${taskId}:`, message)
      this.logResult(taskId, HeartbeatStatus.Error, message)
      return 'error'
    }
  }

  getHeartbeatFilePath(taskId: string): string {
    const workspaceDir = this.dbManager.getWorkspaceDir(taskId)
    return join(workspaceDir, 'heartbeat.md')
  }

  hasHeartbeatFile(taskId: string): boolean {
    return existsSync(this.getHeartbeatFilePath(taskId))
  }

  readHeartbeatFile(taskId: string): string | null {
    const filePath = this.getHeartbeatFilePath(taskId)
    if (!existsSync(filePath)) return null
    try {
      const content = readFileSync(filePath, 'utf-8').trim()
      // Skip empty files or files with only headers (OpenClaw pattern)
      if (!content || /^(#[^\n]*\n?\s*)*$/.test(content)) return null
      return content
    } catch {
      return null
    }
  }

  /** Changed instructions reset the check baseline so the next check sees everything. */
  writeHeartbeatFile(taskId: string, content: string): void {
    const filePath = this.getHeartbeatFilePath(taskId)
    const dir = dirname(filePath)
    const previousContent = this.readHeartbeatFile(taskId)
    const normalizedContent = content.trim()
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(filePath, content, 'utf-8')
    console.log(`[HeartbeatScheduler] Wrote heartbeat.md for task ${taskId} (${content.length} chars)`)

    if ((previousContent ?? '') !== normalizedContent) {
      const task = this.dbManager.getTask(taskId)
      const updates: Partial<TaskRecord> = {
        heartbeat_last_check_at: null
      }

      if (task?.heartbeat_enabled) {
        updates.heartbeat_next_check_at = new Date().toISOString()
      }

      this.dbManager.updateTask(taskId, updates)
      console.log(`[HeartbeatScheduler] Reset heartbeat baseline for task ${taskId} after instructions changed`)
    }
  }

  private async checkHeartbeats(): Promise<void> {
    try {
      const globalEnabled = this.dbManager.getSetting('heartbeat_enabled_global')
      if (globalEnabled === 'false') return

      if (!this.isWithinActiveHours()) return

      const dueTasks = this.dbManager.getHeartbeatDueTasks()

      if (dueTasks.length === 0) return

      for (const task of dueTasks) {
        if (this.inProgress.has(task.id) && !this.loggedInProgress.has(task.id)) {
          console.log(`[HeartbeatScheduler] Skipping task ${task.id} — heartbeat already in progress`)
          this.loggedInProgress.add(task.id)
        }
      }

      const actionableTasks = dueTasks.filter(t => !this.inProgress.has(t.id))

      if (actionableTasks.length === 0) return

      console.log(`[HeartbeatScheduler] Found ${actionableTasks.length} due heartbeat(s)`)

      // Process sequentially to avoid overloading agent quotas
      for (const task of actionableTasks) {
        // A live session means the user is working on the task.
        if (this.agentManager.hasActiveSessionForTask(task.id)) {
          console.log(`[HeartbeatScheduler] Skipping task ${task.id} — active agent session in progress`)
          continue
        }

        if (task.status === TaskStatus.Completed) {
          console.log(`[HeartbeatScheduler] Task ${task.id} is completed, disabling heartbeat`)
          this.disableHeartbeat(task.id)
          continue
        }

        // Skip subtasks whose parent has already been completed. A subtask
        // can sit in ready_for_review indefinitely (completing the parent
        // does not force its children to complete — see
        // finishSessionFeedback), so without this check its heartbeat would
        // keep polling/spawning sessions for a task the user already
        // considers done.
        if (task.parent_task_id) {
          const parentTask = this.dbManager.getTask(task.parent_task_id)
          if (parentTask?.status === TaskStatus.Completed) {
            console.log(`[HeartbeatScheduler] Task ${task.id}'s parent ${task.parent_task_id} is completed, disabling heartbeat`)
            this.disableHeartbeat(task.id)
            continue
          }
        }

        if (!this.hasHeartbeatFile(task.id)) {
          console.log(`[HeartbeatScheduler] No heartbeat.md for task ${task.id}, disabling heartbeat`)
          this.disableHeartbeat(task.id)
          continue
        }

        try {
          await this.runHeartbeat(task)
        } catch (err) {
          console.error(`[HeartbeatScheduler] Error running heartbeat for task ${task.id}:`, err)
        }
      }
    } catch (err) {
      console.error('[HeartbeatScheduler] Error in checkHeartbeats:', err)
    }
  }

  /**
   * Phased so the task agent's context is only touched when action is needed:
   * 1. Pre-flight: cheap `gh api` checks (no LLM)
   * 2. If changes detected → captain session evaluates findings
   * 3. If captain says action needed → spawn task agent with specific instructions
   * 4. If HEARTBEAT_OK → task agent is never touched
   */
  private async runHeartbeat(task: TaskRecord): Promise<void> {
    const heartbeatContent = this.readHeartbeatFile(task.id)
    if (!heartbeatContent) {
      this.advanceNextCheck(task)
      return
    }

    this.inProgress.add(task.id)

    try {
      console.log(`[HeartbeatScheduler] Running heartbeat for task "${task.title}" (${task.id})`)

      const preflightResult = await runPreflightChecks(heartbeatContent, task.heartbeat_last_check_at)
      if (preflightResult === 'no_changes') {
        console.log(`[HeartbeatScheduler] Pre-flight: no changes for task "${task.title}", skipping LLM`)
        this.logResult(task.id, HeartbeatStatus.Ok, 'Pre-flight: no changes detected (LLM skipped)')
        this.advanceNextCheck(task, true)
        return
      }

      const agentId = this.resolveAgentId(task)
      if (!agentId) {
        console.warn(`[HeartbeatScheduler] No agent available for task ${task.id}, skipping`)
        this.logResult(task.id, HeartbeatStatus.Error, 'No agent available for heartbeat check')
        this.advanceNextCheck(task)
        return
      }

      const checkPrompt = this.buildHeartbeatPrompt(task, heartbeatContent)
      const captainSessionId = await this.agentManager.sendHeartbeatViaCaptain(agentId, task.id, checkPrompt)
      const captainResult = await this.waitForSessionResult(captainSessionId, task.id)

      const classification = this.classifyCaptainResult(captainResult)

      if (classification === 'ok') {
        console.log(`[HeartbeatScheduler] ${HEARTBEAT_OK_TOKEN} for task "${task.title}" (captain check)`)
        this.logResult(task.id, HeartbeatStatus.Ok, this.extractSummary(captainResult, HeartbeatStatus.Ok), captainSessionId)
        this.advanceNextCheck(task, true)
      } else if (classification === 'info') {
        console.log(`[HeartbeatScheduler] Info for task "${task.title}": ${captainResult.substring(0, 100)}`)
        this.logResult(task.id, HeartbeatStatus.Info, this.extractSummary(captainResult, HeartbeatStatus.Info), captainSessionId)
        this.advanceNextCheck(task, true) // no action needed, treat like OK for interval
      } else {
        console.log(`[HeartbeatScheduler] Action needed for task "${task.title}", forwarding to task agent`)
        const taskSessionId = await this.forwardFindings(task, captainResult, agentId)
        if (!taskSessionId) {
          // Gated or duplicate — no agent turn was created, so there is nothing to wait for.
          this.advanceNextCheck(task, false)
          return
        }
        const taskResult = await this.waitForSessionResult(taskSessionId, task.id, task.id)
        this.handleResult(task, taskSessionId, taskResult)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[HeartbeatScheduler] Heartbeat error for task ${task.id}:`, message)
      this.logResult(task.id, HeartbeatStatus.Error, message)

      this.checkConsecutiveErrors(task.id)
      this.advanceNextCheck(task)
    } finally {
      this.clearInProgress(task.id)
      await this.agentManager.cleanupHeartbeatSession(task.id)
    }
  }

  private async processRunNowResult(captainSessionId: string, task: TaskRecord, agentId: string): Promise<void> {
    try {
      const captainResult = await this.waitForSessionResult(captainSessionId, task.id)
      const classification = this.classifyCaptainResult(captainResult)

      if (classification === 'action') {
        console.log(`[HeartbeatScheduler] runNow: captain found action needed, forwarding to task agent`)
        await this.forwardFindings(task, captainResult, agentId)
        this.advanceNextCheck(task, false)
      } else {
        const logStatus = classification === 'ok' ? HeartbeatStatus.Ok : HeartbeatStatus.Info
        console.log(`[HeartbeatScheduler] runNow: ${classification} for task "${task.title}"`)
        this.logResult(task.id, logStatus, this.extractSummary(captainResult, logStatus), captainSessionId)
        this.advanceNextCheck(task, classification === 'ok')
      }
    } finally {
      this.clearInProgress(task.id)
      await this.agentManager.cleanupHeartbeatSession(task.id)
    }
  }

  private clearInProgress(taskId: string): void {
    this.inProgress.delete(taskId)
    this.loggedInProgress.delete(taskId)
  }

  /** The Captain only evaluates the checks; it makes no changes. */
  private buildHeartbeatPrompt(task: TaskRecord, heartbeatContent: string): string {
    const globalInstructions = this.dbManager.getSetting('heartbeat_global_instructions') || ''
    const lastCheck = task.heartbeat_last_check_at
    const hasGitHubPullLink = extractGitHubUrls(heartbeatContent).some(url => url.type === 'pull')

    let prompt = `Heartbeat check for task: "${task.title}"\n\n`

    if (lastCheck) {
      prompt += `IMPORTANT: Only consider events after ${lastCheck}. Ignore anything older — it has already been handled.\n\n`
    }

    if (hasGitHubPullLink || requiresCurrentStateChecks(heartbeatContent)) {
      prompt += 'For checks about current state (for example merge conflicts, unresolved requested changes, or the latest CI status), inspect the current state even if the problem started before the last check.\n\n'
    }

    if (globalInstructions.trim()) {
      prompt += `${globalInstructions.trim()}\n\n`
    }

    prompt += `${heartbeatContent}\n\n`
    prompt += `Run the checks above. Reply with one of:\n`
    prompt += `- "${HEARTBEAT_OK_TOKEN}" — nothing new since last check\n`
    prompt += `- "${HEARTBEAT_INFO_TOKEN}: <summary>" — something new but no action needed (e.g. approval, positive comment)\n`
    prompt += `- Otherwise describe specific new findings that need action. Do NOT take action yourself — just report.\n\n`
    prompt += `You are a monitor, not an approver. Report observations only. Never write that any action is approved or authorized, and never instruct anyone to merge, deploy to production, replay, backfill, delete data, or message anyone outside this task — those need a human decision.`

    return prompt
  }

  /**
   * The findings are machine-generated and often quote untrusted external text
   * (PR comments, CI output). They are therefore fenced as DATA and carry an explicit
   * authority notice: a heartbeat message never authorizes a privileged operation.
   */
  private buildActionPrompt(task: TaskRecord, captainFindings: string, deliveryId: string): string {
    return buildSystemMessage(
      {
        origin: SystemMessageOrigin.Heartbeat,
        taskId: task.id,
        deliveryId,
        generatedAt: new Date().toISOString()
      },
      `A periodic heartbeat check of task "${task.title}" produced the findings below.`,
      captainFindings,
      `Address only what you may do without new human authorization, then end your message with "${HEARTBEAT_OK_TOKEN}". If the findings need a privileged operation, report what is needed and ask the human — do not perform it.`
    )
  }

  /**
   * Forward captain findings to the task agent. This is the ONLY place heartbeat
   * text enters a task agent's session, so both guards live here:
   *
   * 1. Idempotency — identical findings for a task are delivered once, so two heartbeat
   *    runs reading the same captain reply cannot create two user turns.
   * 2. Authority gate — findings that request a privileged operation (production deploy,
   *    merge/review bypass, replay, destructive data change, external message) are
   *    escalated to the human and never handed to the agent as an action directive.
   *
   * Returns the task session id when the findings were forwarded, otherwise null.
   */
  private async forwardFindings(task: TaskRecord, findings: string, agentId: string): Promise<string | null> {
    const now = Date.now()
    this.pruneDeliveredFindings(now)

    const deliveryId = computeDeliveryId(task.id, findings)
    if (this.deliveredFindings.has(deliveryId)) {
      console.log(`[HeartbeatScheduler] Duplicate finding for task ${task.id} (delivery ${deliveryId}), not forwarding again`)
      this.logResult(task.id, HeartbeatStatus.Info, `Duplicate heartbeat finding suppressed (delivery ${deliveryId})`)
      return null
    }
    this.deliveredFindings.set(deliveryId, now)

    // Project event (#57): every new finding, forwarded or escalated, reaches
    // the project's Captain once, after the same dedupe as the delivery.
    emitTaskEvent(this.dbManager, 'heartbeat_finding', task.id, findings)

    const gate = evaluateAuthorityGate(findings)
    if (gate.requiresHumanAuthorization) {
      console.log(`[HeartbeatScheduler] Findings for task ${task.id} need human authorization (${gate.categories.join(', ')}), escalating instead of forwarding`)
      const summary = `Human authorization required (${gate.categories.join(', ')}). Heartbeat did not act. Findings: ${findings}`
      this.logResult(task.id, HeartbeatStatus.AttentionNeeded, this.extractSummary(summary, HeartbeatStatus.AttentionNeeded))
      this.notifyAttentionNeeded(task, summary)
      return null
    }

    const actionPrompt = this.buildActionPrompt(task, findings, deliveryId)
    return await this.agentManager.startHeartbeatSession(agentId, task.id, actionPrompt)
  }

  /** Drop delivery ids older than the dedupe window so the map cannot grow forever. */
  private pruneDeliveredFindings(now: number): void {
    for (const [id, at] of this.deliveredFindings) {
      if (now - at > this.DELIVERY_DEDUPE_WINDOW_MS) {
        this.deliveredFindings.delete(id)
      }
    }
  }

  private classifyCaptainResult(result: string): 'ok' | 'info' | 'action' {
    if (result.includes(HEARTBEAT_OK_TOKEN)) return 'ok'
    if (result.includes(HEARTBEAT_INFO_TOKEN)) return 'info'
    return 'action'
  }

  /** Polls the session until it goes idle with a reply, and returns that reply. */
  private waitForSessionResult(sessionId: string, taskId: string, fallbackTaskId?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const INACTIVITY_TIMEOUT_MS = 5 * 60_000
      const POLL_MS = 3_000

      // The timeout only fires after a full window with no activity: long
      // multi-step sessions flicker between 'working' and 'idle' across tool calls.
      let lastActivityAt = Date.now()
      // The adapter may re-key the session, so it is also looked up by task id.
      // fallbackTaskId makes the task-agent phase find the task's session
      // rather than the Captain's heartbeat session.
      let currentSessionId = sessionId
      const lookupTaskId = fallbackTaskId || `heartbeat-${taskId}`

      const timer = setInterval(() => {
        let session = this.agentManager.getSession(currentSessionId)

        // pollSingleSession replaces a temporary id with the adapter's real one.
        if (!session) {
          const found = this.agentManager.findSessionByTaskId(lookupTaskId)
          if (found) {
            console.log(`[HeartbeatScheduler] Session ID re-keyed: ${currentSessionId} → ${found.sessionId}`)
            currentSessionId = found.sessionId
            session = found.session
          }
        }

        if (session?.status === 'working') {
          lastActivityAt = Date.now()
          return
        }

        if (session?.status === 'error') {
          clearInterval(timer)
          reject(new Error(`Heartbeat session ${currentSessionId} ended with error`))
          return
        }

        if (!session || session.status === 'idle') {
          // Guard against race condition: sendMessage fires doSendAdapterMessage
          // as fire-and-forget, so the adapter may report IDLE before the prompt
          // is even sent. Only treat idle as "done" if the session has actually
          // produced an assistant response (lastAssistantText is set during polling).
          const lastMessage = this.agentManager.getLastAssistantMessage(currentSessionId)
          if (lastMessage) {
            clearInterval(timer)
            resolve(lastMessage)
            return
          }

          const inactiveMs = Date.now() - lastActivityAt
          if (inactiveMs >= INACTIVITY_TIMEOUT_MS) {
            clearInterval(timer)
            reject(new Error(`Heartbeat session ${currentSessionId} timed out after ${Math.round(inactiveMs / 60_000)} minutes of inactivity`))
          }
        }
      }, POLL_MS)
    })
  }

  private handleResult(task: TaskRecord, sessionId: string, result: string): void {
    const isOk = result.includes(HEARTBEAT_OK_TOKEN)

    if (isOk) {
      console.log(`[HeartbeatScheduler] ${HEARTBEAT_OK_TOKEN} for task "${task.title}"`)
      this.logResult(task.id, HeartbeatStatus.Ok, this.extractSummary(result, HeartbeatStatus.Ok), sessionId)
      this.advanceNextCheck(task, true) // adaptive: may increase interval
    } else {
      console.log(`[HeartbeatScheduler] Attention needed for task "${task.title}": ${result.substring(0, 100)}`)
      this.logResult(task.id, HeartbeatStatus.AttentionNeeded, this.extractSummary(result, HeartbeatStatus.AttentionNeeded), sessionId)
      this.notifyAttentionNeeded(task, result)
      this.advanceNextCheck(task, false) // reset to base interval
    }
  }

  /** Compact log summary with the control tokens stripped. */
  private extractSummary(result: string, status: HeartbeatStatus): string {
    const infoTokenPattern = new RegExp(`^${HEARTBEAT_INFO_TOKEN}\\s*:\\s*`, 'i')
    const normalized = result
      .replace(HEARTBEAT_OK_TOKEN, '')
      .replace(infoTokenPattern, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (normalized.length > 0) {
      return normalized.substring(0, 500)
    }

    if (status === HeartbeatStatus.Ok) {
      return 'All checks passed (no new updates)'
    }

    if (status === HeartbeatStatus.Info) {
      return 'Checked: update found, but no action needed'
    }

    return 'Checked: action needed'
  }

  private notifyAttentionNeeded(task: TaskRecord, summary: string): void {
    try {
      const notification = new Notification({
        title: `Heartbeat Alert: ${task.title}`,
        body: summary.substring(0, 200)
      })
      notification.show()
    } catch (err) {
      console.error('[HeartbeatScheduler] Failed to show notification:', err)
    }

    this.sendToRenderer('heartbeat:alert', {
      taskId: task.id,
      title: task.title,
      summary: summary.substring(0, 500)
    })

    this.sendToRenderer('tasks:refresh', {})
  }

  private logResult(taskId: string, status: HeartbeatStatus, summary?: string, sessionId?: string): void {
    this.dbManager.createHeartbeatLog({
      task_id: taskId,
      status,
      summary: summary ?? null,
      session_id: sessionId ?? null
    })
  }

  /**
   * Adaptive interval: 2x the base after 3 consecutive OK results, 4x after 6.
   * Anything but OK resets to the configured base interval.
   */
  private advanceNextCheck(task: TaskRecord, isOk?: boolean): void {
    const baseInterval = task.heartbeat_interval_minutes ?? this.getDefaultInterval()
    let effectiveInterval = baseInterval

    if (isOk) {
      const consecutiveOks = this.countConsecutiveOks(task.id)
      if (consecutiveOks >= 6) {
        effectiveInterval = baseInterval * 4
      } else if (consecutiveOks >= 3) {
        effectiveInterval = baseInterval * 2
      }
    }

    const now = new Date()
    const nextCheck = new Date(now.getTime() + effectiveInterval * 60_000)

    this.dbManager.updateTask(task.id, {
      heartbeat_last_check_at: now.toISOString(),
      heartbeat_next_check_at: nextCheck.toISOString()
    })

    if (effectiveInterval !== baseInterval) {
      console.log(`[HeartbeatScheduler] Adaptive interval: ${effectiveInterval}min (base: ${baseInterval}min) for task ${task.id}`)
    }
  }

  private countConsecutiveOks(taskId: string): number {
    const logs = this.dbManager.getHeartbeatLogs(taskId, 10)
    let count = 0
    for (const log of logs) {
      if (log.status === HeartbeatStatus.Ok) count++
      else break
    }
    return count
  }

  private checkConsecutiveErrors(taskId: string): void {
    const consecutiveErrors = this.dbManager.getHeartbeatConsecutiveErrors(taskId)

    if (consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
      console.log(`[HeartbeatScheduler] Auto-disabling heartbeat for task ${taskId} after ${consecutiveErrors} consecutive errors`)
      this.disableHeartbeat(taskId)

      const task = this.dbManager.getTask(taskId)
      if (task) {
        try {
          const notification = new Notification({
            title: `Heartbeat Disabled: ${task.title}`,
            body: `Heartbeat was auto-disabled after ${consecutiveErrors} consecutive errors.`
          })
          notification.show()
        } catch {
          // Notifications are unavailable in some environments.
        }

        this.sendToRenderer('heartbeat:disabled', {
          taskId,
          reason: `${consecutiveErrors} consecutive errors`
        })
      }
    }
  }

  /** Heartbeats run on the task's own agent, else the default agent. */
  private resolveAgentId(task: TaskRecord): string | null {
    if (task.agent_id) return task.agent_id
    const agents = this.dbManager.getAgents()
    const defaultAgent = agents.find(a => a.is_default)
    return defaultAgent?.id ?? agents[0]?.id ?? null
  }

  private isWithinActiveHours(): boolean {
    const start = this.dbManager.getSetting('heartbeat_active_hours_start')
    const end = this.dbManager.getSetting('heartbeat_active_hours_end')

    if (!start || !end) return true

    const now = new Date()
    const [startH, startM] = start.split(':').map(Number)
    const [endH, endM] = end.split(':').map(Number)

    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const startMinutes = startH * 60 + startM
    const endMinutes = endH * 60 + endM

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes
    } else {
      // Overnight range, e.g. 22:00 - 06:00
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes
    }
  }

  private getDefaultInterval(): number {
    const setting = this.dbManager.getSetting('heartbeat_default_interval')
    return setting ? parseInt(setting, 10) : HEARTBEAT_DEFAULTS.intervalMinutes
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      guardedIpcSend(this.mainWindow.webContents, channel, data)
    }
  }
}

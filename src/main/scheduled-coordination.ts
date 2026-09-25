/**
 * Scheduled coordination (#67): per-project Captain reviews and the
 * Commander briefing, both on cron schedules, both off by default
 * (shared/scheduled-coordination.ts holds the settings shapes).
 *
 * It runs in the main process on a one-minute tick, so it works with the
 * window closed:
 *
 *  - Scheduled review: a project whose `settings.scheduled_review` is enabled
 *    gets one fenced "scheduled review" system message at each cron
 *    occurrence, delivered to its Captain row through
 *    AgentManager.sendMessage — the same rejoin-or-resume path the event
 *    waker uses (captain-waker.ts). A paused project (#65: its own pause
 *    or the global one) is skipped and logged. A Captain that is mid-turn
 *    is retried on the next tick while the occurrence is still recent.
 *  - Commander briefing: the `commander_briefing` app setting. At each
 *    occurrence a NEW Commander session "Briefing <date>" is created holding a
 *    briefing built deterministically from every active project's status
 *    record (summary, counts, blockers, pending approvals; never raw tasks).
 *    When a chat provider is configured, the Commander model also adds a
 *    short spoken-style summary; without one that step is skipped. The
 *    session is left unread, a desktop notification is raised, and with
 *    `speak` on and speech able to play, the summary is read aloud.
 *
 * No double fire: the last occurrence handled for each schedule is stored in
 * app settings (with the cron it belongs to) BEFORE the work starts, so a
 * restart finds it and does not fire again. A first run, a changed cron or a
 * re-enabled schedule starts from "now", so turning a schedule on never fires
 * a past occurrence. An occurrence missed while the app was closed fires once
 * on start-up if it is younger than `catchUpMs`, else it is skipped.
 */
import { CronExpressionParser } from 'cron-parser'
import type { AgentManager } from './agent-manager'
import type { DatabaseManager, ProjectRecord } from './database'
import type { ChatProvider } from './chat/providers/types'
import type { CommanderService } from './commander/commander-service'
import { completeText } from './commander/commander-service'
import { CommanderStore } from './commander/commander-store'
import { createChatProviderFromSettings } from './chat/provider-factory'
import { getCommanderService } from './ipc/commander'
import { resolveCaptainAgentId, type CaptainWakerAgents } from './captain-waker'
import { buildProjectStatus, type ProjectStatusAgents } from './project-status'
import { isAllProjectsPaused, localDayKey } from './project-limits'
import { projectLimitsFromSettings } from '../shared/project-policies'
import type { ProjectStatus } from '../shared/project-status'
import {
  COMMANDER_BRIEFING_SETTING,
  parseCommanderBriefingSettings,
  readScheduledReviewSettings
} from '../shared/scheduled-coordination'
import { buildSystemMessage, computeDeliveryId, SystemMessageOrigin } from '../shared/system-authority'

export type ScheduledCoordinationStore = Pick<
  DatabaseManager,
  'getProjects' | 'getProject' | 'getCoordinatorTask' | 'getAgents' | 'getSetting' | 'setSetting' | 'getProjectStatus' | 'getTasks'
> & { db: DatabaseManager['db'] }

export type ScheduledCoordinationAgents = CaptainWakerAgents & Partial<ProjectStatusAgents>

/** The part of the speech service the briefing uses. */
export interface BriefingSpeech {
  speak(request: { text: string; source: 'manual'; taskId?: string }): Promise<boolean>
}

export interface ScheduledCoordinationOptions {
  db: ScheduledCoordinationStore
  agents: ScheduledCoordinationAgents | null
  /** The running Commander service, when its handlers are registered; emits to the renderer. */
  getCommander?: () => Pick<CommanderService, 'appendReport'> | null
  /** Builds the Commander's chat provider; throws when none is configured. */
  createProvider?: () => ChatProvider
  /** Desktop notification. Default: Electron's Notification, when supported. */
  notify?: (title: string, body: string) => void
  /** Speech for a spoken briefing; null when voice is not available. */
  getSpeech?: () => BriefingSpeech | null
  /** True when a window exists to play speech in. */
  canPlayAudio?: () => boolean
  tickMs?: number
  /** A missed occurrence older than this is skipped rather than caught up. */
  catchUpMs?: number
  /** Timeout for the model's spoken-style summary. */
  summaryTimeoutMs?: number
  timezone?: string
  now?: () => number
}

export const SCHEDULED_COORDINATION_DEFAULTS = {
  tickMs: 60_000,
  catchUpMs: 6 * 60 * 60_000,
  summaryTimeoutMs: 30_000
} as const

/** App-settings key of a project's last handled review occurrence. */
export function reviewStateKey(projectId: string): string {
  return `scheduled_review_state:${projectId}`
}

export const BRIEFING_STATE_KEY = 'commander_briefing_state'

interface ScheduleState {
  /** The cron the stored occurrence belongs to; a different cron starts over. */
  cron: string
  /** Epoch ms of the last occurrence handled (or the baseline). */
  last: number
}

function readState(db: Pick<DatabaseManager, 'getSetting'>, key: string): ScheduleState | null {
  const raw = db.getSetting(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { cron?: unknown; last?: unknown }
    if (typeof parsed?.cron !== 'string' || typeof parsed?.last !== 'number' || !Number.isFinite(parsed.last)) return null
    return { cron: parsed.cron, last: parsed.last }
  } catch {
    return null
  }
}

function writeState(db: Pick<DatabaseManager, 'setSetting'>, key: string, state: ScheduleState): void {
  db.setSetting(key, JSON.stringify(state))
}

/** The newest occurrence at or before `now`; null for a cron cron-parser cannot read. */
export function latestOccurrence(cron: string, now: number, timezone?: string): number | null {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: new Date(now + 1000), ...(timezone ? { tz: timezone } : {}) })
    return interval.prev().getTime()
  } catch {
    return null
  }
}

type DueDecision =
  | { kind: 'idle' }
  | { kind: 'seeded' }
  | { kind: 'invalid' }
  | { kind: 'stale'; occurrence: number }
  | { kind: 'due'; occurrence: number }

// ── Message builders ──────────────────────────────────────────

/** The fenced wake-up a Captain gets for a scheduled review. */
export function buildScheduledReviewMessage(coordinatorTaskId: string, project: Pick<ProjectRecord, 'name'>, status: ProjectStatus | null, occurrence: number): string {
  const header = `Scheduled review of "${project.name}".`
  const lines: string[] = []
  if (status) {
    const c = status.counts
    lines.push(`Counts: running ${c.running}, queued ${c.queued}, awaiting review ${c.awaiting_review}, awaiting approval ${c.awaiting_approval}, blocked ${c.blocked}.`)
    lines.push(`Last status summary: ${status.summary.trim() || '(none written yet)'}`)
    if (status.top_blockers.length > 0) lines.push(`Last listed blockers: ${status.top_blockers.join('; ')}`)
    lines.push(`Status last updated: ${status.updated_at ?? 'never'}`)
  }
  const findings = lines.join('\n') || 'No status recorded yet.'
  const instructions = [
    'This is your scheduled review. Work through it with the task-management tools, then stop:',
    '- review the board: what is running, waiting for review, blocked, failed or stale;',
    '- re-plan: create, re-prioritise, re-assign or start tasks where the plan calls for it;',
    '- finish by calling `update_project_status` with a short summary, the blockers, and the next steps.',
    'Reply to the user only when a decision is needed.'
  ].join('\n')
  return buildSystemMessage(
    {
      origin: SystemMessageOrigin.Coordinator,
      taskId: coordinatorTaskId,
      deliveryId: computeDeliveryId(coordinatorTaskId, `scheduled-review ${occurrence}`),
      generatedAt: new Date(occurrence).toISOString()
    },
    header,
    findings,
    instructions
  )
}

export interface BriefingProjectEntry {
  project: Pick<ProjectRecord, 'id' | 'name'>
  status: ProjectStatus | null
  paused: boolean
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Needs the user: approvals, reviews or blockers. */
function needsAttention(entry: BriefingProjectEntry): boolean {
  const c = entry.status?.counts
  return !!c && (c.awaiting_approval > 0 || c.awaiting_review > 0 || c.blocked > 0) || (entry.status?.top_blockers.length ?? 0) > 0
}

/**
 * The briefing text, built only from status records: no model, no raw tasks.
 * Projects that need the user come first, then the rest, each in sidebar order.
 */
export function buildBriefingText(entries: BriefingProjectEntry[], day: string): string {
  const ordered = [...entries.filter(needsAttention), ...entries.filter((e) => !needsAttention(e))]
  const attention = entries.filter(needsAttention).length
  const lines: string[] = [
    `Briefing for ${day}: ${plural(entries.length, 'active project')}${attention > 0 ? `, ${attention} need${attention === 1 ? 's' : ''} attention` : ''}.`
  ]
  if (entries.length === 0) lines.push('', 'There are no active projects.')
  for (const entry of ordered) {
    const status = entry.status
    lines.push('', `## ${entry.project.name}${entry.paused ? ' (paused)' : ''}`)
    lines.push(status?.summary.trim() ? status.summary.trim() : 'No status summary written yet.')
    if (status) {
      const c = status.counts
      lines.push(`Running ${c.running} · queued ${c.queued} · awaiting review ${c.awaiting_review} · awaiting approval ${c.awaiting_approval} · blocked ${c.blocked}`)
    }
    if (status && status.counts.awaiting_approval > 0) {
      lines.push(`Pending approvals: ${plural(status.counts.awaiting_approval, 'agent step')} waiting for approval.`)
    }
    if (status && status.top_blockers.length > 0) {
      lines.push('Blockers:')
      for (const blocker of status.top_blockers) lines.push(`- ${blocker}`)
    }
    lines.push(`Status updated: ${status?.updated_at ?? 'never'}`)
  }
  return lines.join('\n')
}

export const BRIEFING_SUMMARY_PROMPT = [
  'You are the Commander, briefing the user on their projects.',
  'Below is a briefing built from each project\'s status record.',
  'Write a short spoken-style summary: three to five plain sentences, no markdown, no lists, no headings.',
  'Lead with what needs the user (approvals, reviews, blockers), then one line on overall progress.',
  'Use only facts from the briefing. Do not invent tasks or numbers.'
].join('\n')

/** The notification body: one line that says whether to look now. */
export function briefingNotificationBody(entries: BriefingProjectEntry[]): string {
  const attention = entries.filter(needsAttention)
  if (entries.length === 0) return 'No active projects.'
  if (attention.length === 0) return `${plural(entries.length, 'project')}, nothing needs you right now.`
  const names = attention.slice(0, 3).map((e) => e.project.name).join(', ')
  return `${plural(attention.length, 'project')} need${attention.length === 1 ? 's' : ''} attention: ${names}${attention.length > 3 ? '…' : ''}`
}

function defaultNotify(title: string, body: string): void {
  import('electron')
    .then(({ Notification }) => {
      if (!Notification.isSupported()) return
      new Notification({ title, body }).show()
    })
    .catch((error) => console.error('[ScheduledCoordination] OS notification failed:', error))
}

// ── The scheduler ─────────────────────────────────────────────

export interface BriefingResult {
  sessionId: string
  reportId: string
  summary: string | null
  spoken: boolean
}

export class ScheduledCoordination {
  private readonly tickMs: number
  private readonly catchUpMs: number
  private readonly summaryTimeoutMs: number
  private readonly timezone: string
  private readonly now: () => number
  private readonly store: CommanderStore
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  /** Invalid crons already logged, so the log does not repeat every minute. */
  private readonly invalidLogged = new Set<string>()
  /** Projects whose Captain is being woken right now. */
  private readonly waking = new Set<string>()

  constructor(private readonly options: ScheduledCoordinationOptions) {
    this.tickMs = options.tickMs ?? SCHEDULED_COORDINATION_DEFAULTS.tickMs
    this.catchUpMs = options.catchUpMs ?? SCHEDULED_COORDINATION_DEFAULTS.catchUpMs
    this.summaryTimeoutMs = options.summaryTimeoutMs ?? SCHEDULED_COORDINATION_DEFAULTS.summaryTimeoutMs
    this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    this.now = options.now ?? (() => Date.now())
    const db = options.db
    // The connection is read on use, like the Commander IPC store.
    this.store = new CommanderStore({ get db() { return db.db } })
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.tickMs)
    // Never keeps the process alive on its own.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass over every schedule. The interval calls this; tests may too. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.runReviews()
      await this.runBriefing()
    } catch (err) {
      console.error('[ScheduledCoordination] tick failed:', err)
    } finally {
      this.ticking = false
    }
  }

  /**
   * Whether a schedule has an occurrence to handle. Seeds the stored state
   * (without firing) on the first look, after a cron change, and when the
   * schedule was off.
   */
  private decide(key: string, enabled: boolean, cron: string): DueDecision {
    const db = this.options.db
    if (!enabled) {
      // Forget the baseline: turning it back on starts from then, not from the last run.
      if (db.getSetting(key)) db.setSetting(key, '')
      return { kind: 'idle' }
    }
    const now = this.now()
    const occurrence = latestOccurrence(cron, now, this.timezone)
    if (occurrence === null) {
      if (!this.invalidLogged.has(`${key}|${cron}`)) {
        this.invalidLogged.add(`${key}|${cron}`)
        console.warn(`[ScheduledCoordination] "${cron}" is not a cron expression this scheduler can read (${key}); skipping`)
      }
      return { kind: 'invalid' }
    }
    const state = readState(db, key)
    if (!state || state.cron !== cron) {
      writeState(db, key, { cron, last: now })
      return { kind: 'seeded' }
    }
    if (occurrence <= state.last) return { kind: 'idle' }
    if (now - occurrence > this.catchUpMs) return { kind: 'stale', occurrence }
    return { kind: 'due', occurrence }
  }

  private markHandled(key: string, cron: string, occurrence: number): void {
    writeState(this.options.db, key, { cron, last: occurrence })
  }

  // ── Scheduled reviews ───────────────────────────────────────

  private async runReviews(): Promise<void> {
    const db = this.options.db
    for (const project of db.getProjects()) {
      const review = readScheduledReviewSettings(project.settings)
      const key = reviewStateKey(project.id)
      const decision = this.decide(key, review.enabled, review.cron)
      if (decision.kind === 'stale') {
        console.log(`[ScheduledCoordination] Review of ${project.id} due at ${new Date(decision.occurrence).toISOString()} was missed by more than ${Math.round(this.catchUpMs / 3_600_000)}h; skipping it`)
        this.markHandled(key, review.cron, decision.occurrence)
        continue
      }
      if (decision.kind !== 'due') continue
      await this.reviewProject(project, review.cron, decision.occurrence)
    }
  }

  private async reviewProject(project: ProjectRecord, cron: string, occurrence: number): Promise<void> {
    const db = this.options.db
    const key = reviewStateKey(project.id)
    if (this.waking.has(project.id)) return

    if (projectLimitsFromSettings(project.settings).paused || isAllProjectsPaused(db)) {
      console.log(`[ScheduledCoordination] Project ${project.id} is paused; skipping its scheduled review`)
      this.markHandled(key, cron, occurrence)
      return
    }
    const agents = this.options.agents
    const coordinator = db.getCoordinatorTask(project.id)
    if (!agents || !coordinator) {
      console.warn(`[ScheduledCoordination] Project ${project.id} has no Captain to review with; skipping`)
      this.markHandled(key, cron, occurrence)
      return
    }
    const live = agents.findSessionByTaskId(coordinator.id)
    if (live && live.session.status !== 'idle') {
      // Mid-turn: try again next tick, while the occurrence is still recent (decide() drops it after catchUpMs).
      return
    }
    const agentId = resolveCaptainAgentId(db, project)
    if (!agentId) {
      console.warn(`[ScheduledCoordination] No agent to run the Captain of ${project.id}; skipping its scheduled review`)
      this.markHandled(key, cron, occurrence)
      return
    }
    // Not reused when it runs on an agent the Captain was switched away from.
    const liveSessionId = live?.session.agentId === agentId ? live.sessionId : ''

    const message = buildScheduledReviewMessage(coordinator.id, project, this.statusOf(project.id), occurrence)
    // Recorded before the send: a crash or restart mid-send must not fire it again.
    this.markHandled(key, cron, occurrence)
    this.waking.add(project.id)
    try {
      console.log(`[ScheduledCoordination] Waking the Captain of ${project.id} for its scheduled review`)
      await agents.sendMessage(liveSessionId, message, coordinator.id, agentId)
    } catch (err) {
      console.error(`[ScheduledCoordination] Could not wake the Captain of ${project.id}:`, err)
    } finally {
      this.waking.delete(project.id)
    }
  }

  private statusOf(projectId: string): ProjectStatus | null {
    const agents = this.options.agents
    const statusAgents = agents?.getStartQueue && agents.getSessionStatus ? (agents as ProjectStatusAgents) : null
    try {
      return buildProjectStatus(this.options.db, statusAgents, projectId)
    } catch (err) {
      console.warn(`[ScheduledCoordination] Could not read the status of ${projectId}:`, err)
      return null
    }
  }

  // ── Commander briefing ──────────────────────────────────────

  private async runBriefing(): Promise<void> {
    const settings = parseCommanderBriefingSettings(this.options.db.getSetting(COMMANDER_BRIEFING_SETTING))
    const decision = this.decide(BRIEFING_STATE_KEY, settings.enabled, settings.cron)
    if (decision.kind === 'stale') {
      console.log(`[ScheduledCoordination] Briefing due at ${new Date(decision.occurrence).toISOString()} was missed by too long; skipping it`)
      this.markHandled(BRIEFING_STATE_KEY, settings.cron, decision.occurrence)
      return
    }
    if (decision.kind !== 'due') return
    this.markHandled(BRIEFING_STATE_KEY, settings.cron, decision.occurrence)
    await this.runBriefingNow({ speak: settings.speak })
  }

  /** The briefing's inputs: every active project's status record. */
  collectBriefing(): BriefingProjectEntry[] {
    const db = this.options.db
    const globalPause = isAllProjectsPaused(db)
    return db.getProjects().map((project) => ({
      project: { id: project.id, name: project.name },
      status: this.statusOf(project.id),
      paused: globalPause || projectLimitsFromSettings(project.settings).paused
    }))
  }

  /** Builds and stores one briefing session now (the schedule calls this; tests may too). */
  async runBriefingNow(options: { speak?: boolean } = {}): Promise<BriefingResult | null> {
    const entries = this.collectBriefing()
    const day = localDayKey(new Date(this.now()))
    const briefing = buildBriefingText(entries, day)

    // The model's summary first, before anything is stored, so the session
    // is written in one go. No provider, no summary: the briefing stands alone.
    const summary = await this.modelSummary(briefing)

    let sessionId: string
    let reportId: string
    try {
      const session = this.store.createSession(`Briefing ${day}`)
      sessionId = session.id
      const commander = this.options.getCommander?.() ?? null
      // Through the service when it runs, so an open window sees the new
      // unread session; straight to the store otherwise.
      const report = commander
        ? commander.appendReport({ sessionId, content: briefing })
        : this.store.appendMessage(sessionId, { role: 'report', content: briefing })
      reportId = report.id
      if (summary) this.store.appendMessage(sessionId, { role: 'assistant', content: summary })
    } catch (err) {
      console.error('[ScheduledCoordination] Could not store the briefing:', err)
      return null
    }
    console.log(`[ScheduledCoordination] Briefing stored in Commander session ${sessionId}`)

    const notify = this.options.notify ?? defaultNotify
    try {
      notify(`Briefing ${day}`, briefingNotificationBody(entries))
    } catch (err) {
      console.error('[ScheduledCoordination] Briefing notification failed:', err)
    }

    let spoken = false
    if (options.speak) spoken = await this.speak(summary ?? briefing, sessionId)
    return { sessionId, reportId, summary, spoken }
  }

  private async modelSummary(briefing: string): Promise<string | null> {
    if (!this.options.createProvider) return null
    let provider: ChatProvider
    try {
      provider = this.options.createProvider()
    } catch (err) {
      console.log('[ScheduledCoordination] No Commander model configured; the briefing goes without a summary:', err instanceof Error ? err.message : err)
      return null
    }
    try {
      const text = await completeText(
        provider,
        { system: BRIEFING_SUMMARY_PROMPT, messages: [{ role: 'user', content: briefing }], maxTokens: 400 },
        AbortSignal.timeout(this.summaryTimeoutMs)
      )
      return text.trim() || null
    } catch (err) {
      console.warn('[ScheduledCoordination] Briefing summary failed; storing the briefing without it:', err instanceof Error ? err.message : err)
      return null
    }
  }

  private async speak(text: string, sessionId: string): Promise<boolean> {
    const speech = this.options.getSpeech?.() ?? null
    if (!speech || !(this.options.canPlayAudio?.() ?? false)) return false
    try {
      return await speech.speak({ text, source: 'manual', taskId: `commander:${sessionId}` })
    } catch (err) {
      console.warn('[ScheduledCoordination] Could not speak the briefing:', err)
      return false
    }
  }
}

// ── Wiring ────────────────────────────────────────────────────

export interface StartScheduledCoordinationDeps {
  db: DatabaseManager
  agents: AgentManager
  /** The voice session manager, once it exists; null when voice is unavailable. */
  getVoice?: () => { speech: BriefingSpeech } | null
  /** True when a window is open to play audio in. */
  canPlayAudio?: () => boolean
}

let running: ScheduledCoordination | null = null

/**
 * Starts the scheduler with the app's services (src/main/index.ts). The
 * Commander service and chat provider are looked up on use: the Commander
 * handlers register after this runs.
 */
export function startScheduledCoordination(deps: StartScheduledCoordinationDeps): ScheduledCoordination {
  running?.stop()
  const scheduler = new ScheduledCoordination({
    db: deps.db,
    agents: deps.agents,
    getCommander: () => getCommanderService(),
    createProvider: () => createChatProviderFromSettings(deps.db),
    getSpeech: () => deps.getVoice?.()?.speech ?? null,
    canPlayAudio: deps.canPlayAudio
  })
  scheduler.start()
  running = scheduler
  return scheduler
}

export function stopScheduledCoordination(): void {
  running?.stop()
  running = null
}

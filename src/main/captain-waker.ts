/**
 * Wakes a project's Captain on project events (#57).
 *
 * Parent tasks already get an event-driven wake-up when a subtask finishes
 * (AgentManager.notifyParentOfSubtaskCompletion). This does the same for the
 * project's Captain, from the project event bus (project-events.ts):
 *
 *  - events for a project are held for a short debounce window and delivered
 *    as ONE fenced system message, in the coordinator wake-up style, so a
 *    burst (a synced batch of tasks, three agents finishing together) causes
 *    a single Captain turn;
 *  - the message goes to the project's coordinator row through
 *    AgentManager.sendMessage, which rejoins the live session or resumes the
 *    persisted one (the coordinator path of startSessionNow), so the window
 *    does not have to be open and the runtime does not have to be resident;
 *  - a Captain that is mid-turn is not interrupted: its batch waits and is
 *    retried after the next window, until it goes idle (or the batch is too
 *    old to be worth delivering);
 *  - per project, `projects.settings.captain_wakeups` chooses the kinds
 *    that wake it, or turns wake-ups off (shared/captain-wakeups.ts;
 *    default on, all kinds);
 *  - events the Captain caused itself are skipped: the task-management
 *    MCP dispatch reports each of its calls (setToolCallObserver), and a task
 *    it touched in the last few seconds does not wake it;
 *  - at most `hourlyCap` wake-ups per project per hour, logged when hit, so
 *    an agent that keeps failing cannot spin the Captain.
 */
import type { AgentManager } from './agent-manager'
import type { DatabaseManager, ProjectRecord } from './database'
import { projectEvents, type ProjectEvent } from './project-events'
import { isCoordinatorScope, setToolCallObserver, type TaskMcpScope } from './mcp-servers/task-management-core'
import { readCaptainWakeupSettings, wakeupKindEnabled, type ProjectEventKind } from '../shared/captain-wakeups'
import { buildSystemMessage, computeDeliveryId, SystemMessageOrigin } from '../shared/system-authority'

export type CaptainWakerStore = Pick<DatabaseManager, 'getProject' | 'getCoordinatorTask' | 'getAgents'>
export type CaptainWakerAgents = Pick<AgentManager, 'findSessionByTaskId' | 'sendMessage'>

export interface CaptainWakerOptions {
  /** How long a project's first event waits for company before the wake-up. */
  debounceMs?: number
  /** Wake-ups per project per rolling hour. */
  hourlyCap?: number
  /** How long after the Captain touched a task its events count as self-caused. */
  selfCausedWindowMs?: number
  /** A batch older than this is dropped rather than delivered to a Captain that never went idle. */
  maxDeferMs?: number
  /** Events kept per batch; the rest are counted in the message, not listed. */
  maxEventsPerWake?: number
  /** Clock and timers, replaceable in tests. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const CAPTAIN_WAKE_DEFAULTS = {
  debounceMs: 3_000,
  hourlyCap: 12,
  selfCausedWindowMs: 20_000,
  maxDeferMs: 15 * 60_000,
  maxEventsPerWake: 40
} as const

const HOUR_MS = 60 * 60_000

interface PendingBatch {
  events: ProjectEvent[]
  /** When the first event of this batch arrived (for maxDeferMs). */
  since: number
  timer: unknown | null
}

/**
 * The agent a project's Captain runs on, resolved the way the renderer's
 * coordinator-store does it: the project's Captain agent, else its default
 * agent, else the app default, else the first agent. Ids that no longer name
 * an agent are skipped.
 */
export function resolveCaptainAgentId(db: Pick<DatabaseManager, 'getAgents'>, project: Pick<ProjectRecord, 'captain_agent_id' | 'default_agent_id'>): string | null {
  const agents = db.getAgents()
  const known = (id: string | null | undefined): string | null =>
    id && agents.some((agent) => agent.id === id) ? id : null
  return known(project.captain_agent_id) ?? known(project.default_agent_id) ?? agents.find((agent) => agent.is_default)?.id ?? agents[0]?.id ?? null
}

const KIND_LINE: Record<ProjectEventKind, string> = {
  task_ready_for_review: 'ready for review',
  task_failed: 'agent session failed',
  approval_pending: 'waiting for approval',
  chain_stuck: 'chain stuck',
  heartbeat_finding: 'heartbeat finding',
  task_synced: 'new task from a source'
}

function describeEvent(event: ProjectEvent): string {
  const parts = [`- [${KIND_LINE[event.kind]}] "${event.title}" (id: ${event.taskId})`]
  if (event.kind === 'task_synced' && event.unassigned) parts.push('— no agent assigned yet')
  if (event.detail) parts.push(`— ${event.detail}`)
  return parts.join(' ')
}

/**
 * One wake-up for a batch of project events. Titles and details are agent-
 * or source-authored text, so they are fenced as findings and the authority
 * boundary is stated, exactly like the subtask wake-up.
 */
export function buildCaptainWakeMessage(
  coordinatorTaskId: string,
  projectName: string,
  events: ProjectEvent[],
  omitted = 0
): string {
  const header = `${events.length + omitted} project event${events.length + omitted === 1 ? '' : 's'} in "${projectName}" since your last turn.`
  const lines = events.map(describeEvent)
  if (omitted > 0) lines.push(`- …and ${omitted} more; use \`get_recent_activity\` for the rest.`)
  const summary = lines.join('\n')
  const instructions = [
    'Act on each item through the task-management tools, then stop:',
    '- new tasks with no agent: look up similar tasks, assign an agent and skills, and `start_task` them, or ask the user if the plan is unclear;',
    '- tasks ready for review: read the result with `get_task` and `get_messages`, then complete them, create follow-ups, or start what comes next;',
    '- failed sessions and stuck chains: read what happened, fix the successor links or agent assignment, restart, or tell the user what you need;',
    '- approvals: answer with `respond_to_checkpoint` only when the step is routine and clearly safe; otherwise summarise it for the user;',
    '- heartbeat findings: decide whether the task agent needs steering (`send_message`) or the user needs to know.',
    'Finish by calling `update_project_status` with a short summary of where the project stands. Reply to the user only when a decision is needed.'
  ].join('\n')
  return buildSystemMessage(
    {
      origin: SystemMessageOrigin.Coordinator,
      taskId: coordinatorTaskId,
      deliveryId: computeDeliveryId(coordinatorTaskId, `${header}\n${summary}`),
      generatedAt: new Date().toISOString()
    },
    header,
    summary,
    instructions
  )
}

/** The task ids a tool call named or created, for the self-caused window. */
export function taskIdsTouchedByCall(args: Record<string, unknown>, result: unknown): string[] {
  const ids: string[] = []
  const push = (value: unknown): void => { if (typeof value === 'string' && value) ids.push(value) }
  push(args.task_id)
  push(args.parent_task_id)
  if (Array.isArray(args.subtask_ids)) for (const id of args.subtask_ids) push(id)
  if (result && typeof result === 'object') {
    const record = result as { id?: unknown; task_id?: unknown; task?: { id?: unknown } | null }
    push(record.id)
    push(record.task_id)
    push(record.task?.id)
  }
  return ids
}

export class CaptainWaker {
  private readonly debounceMs: number
  private readonly hourlyCap: number
  private readonly selfCausedWindowMs: number
  private readonly maxDeferMs: number
  private readonly maxEventsPerWake: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  private readonly pending = new Map<string, PendingBatch>()
  /** Wake-up times per project inside the rolling hour. */
  private readonly wakes = new Map<string, number[]>()
  /** Task id → when the Captain last touched it through its tools. */
  private readonly touched = new Map<string, number>()
  /** Projects whose cap was already logged for the current hour, so the log does not repeat per event. */
  private readonly capLogged = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private flushing = new Set<string>()

  constructor(
    private readonly db: CaptainWakerStore,
    private readonly agents: CaptainWakerAgents,
    options: CaptainWakerOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? CAPTAIN_WAKE_DEFAULTS.debounceMs
    this.hourlyCap = options.hourlyCap ?? CAPTAIN_WAKE_DEFAULTS.hourlyCap
    this.selfCausedWindowMs = options.selfCausedWindowMs ?? CAPTAIN_WAKE_DEFAULTS.selfCausedWindowMs
    this.maxDeferMs = options.maxDeferMs ?? CAPTAIN_WAKE_DEFAULTS.maxDeferMs
    this.maxEventsPerWake = options.maxEventsPerWake ?? CAPTAIN_WAKE_DEFAULTS.maxEventsPerWake
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  }

  /** Subscribes to the project event bus and the MCP tool-call observer. */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = projectEvents.onEvent((event) => this.handleEvent(event))
    setToolCallObserver((call) => this.observeToolCall(call.scope, call.args, call.result))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    setToolCallObserver(null)
    for (const batch of this.pending.values()) {
      if (batch.timer !== null) this.clearTimer(batch.timer)
    }
    this.pending.clear()
  }

  /** Records that the Captain itself just changed a task, so its own change does not wake it. */
  noteCoordinatorTouched(taskId: string): void {
    this.touched.set(taskId, this.now())
    // Keep the map small: entries outside the window are of no use.
    if (this.touched.size > 500) {
      const cutoff = this.now() - this.selfCausedWindowMs
      for (const [id, at] of this.touched) if (at < cutoff) this.touched.delete(id)
    }
  }

  /** The tool-call observer: a coordinator-shaped scope touching tasks. */
  observeToolCall(scope: TaskMcpScope, args: Record<string, unknown>, result: unknown): void {
    if (!isCoordinatorScope(scope)) return
    for (const id of taskIdsTouchedByCall(args, result)) this.noteCoordinatorTouched(id)
  }

  /** Events waiting for a project's next wake-up (for tests and diagnostics). */
  pendingEvents(projectId: string): ProjectEvent[] {
    return [...(this.pending.get(projectId)?.events ?? [])]
  }

  handleEvent(event: ProjectEvent): void {
    const project = this.db.getProject(event.projectId)
    if (!project || project.archived) return
    if (!wakeupKindEnabled(readCaptainWakeupSettings(project.settings), event.kind)) return

    const touchedAt = this.touched.get(event.taskId)
    if (touchedAt !== undefined && this.now() - touchedAt <= this.selfCausedWindowMs) {
      console.log(`[CaptainWaker] ${event.kind} on ${event.taskId} was caused by the Captain of ${event.projectId}; not waking it`)
      return
    }

    let batch = this.pending.get(event.projectId)
    if (!batch) {
      batch = { events: [], since: this.now(), timer: null }
      this.pending.set(event.projectId, batch)
    }
    // The same fact twice in one window (a status written by two paths) is one line.
    if (batch.events.some((e) => e.kind === event.kind && e.taskId === event.taskId)) return
    batch.events.push(event)
    if (batch.timer === null) this.arm(event.projectId, batch)
  }

  private arm(projectId: string, batch: PendingBatch): void {
    batch.timer = this.setTimer(() => {
      batch.timer = null
      void this.flush(projectId)
    }, this.debounceMs)
  }

  /** Delivers a project's batch now (the timer calls this; tests may too). */
  async flush(projectId: string): Promise<void> {
    const batch = this.pending.get(projectId)
    if (!batch || batch.events.length === 0) {
      this.pending.delete(projectId)
      return
    }
    if (batch.timer !== null) {
      this.clearTimer(batch.timer)
      batch.timer = null
    }
    // A send is still in flight for this project: this batch goes after it.
    if (this.flushing.has(projectId)) {
      this.arm(projectId, batch)
      return
    }

    const project = this.db.getProject(projectId)
    const coordinator = this.db.getCoordinatorTask(projectId)
    if (!project || !coordinator) {
      console.warn(`[CaptainWaker] Project ${projectId} has no Captain row; dropping ${batch.events.length} event(s)`)
      this.pending.delete(projectId)
      return
    }

    // Mid-turn: the message would land on top of the work in progress. Wait
    // for idle, but not forever.
    const live = this.agents.findSessionByTaskId(coordinator.id)
    if (live && live.session.status !== 'idle') {
      if (this.now() - batch.since > this.maxDeferMs) {
        console.warn(`[CaptainWaker] Captain of ${projectId} stayed ${live.session.status} for over ${Math.round(this.maxDeferMs / 60_000)} min; dropping ${batch.events.length} stale event(s)`)
        this.pending.delete(projectId)
        return
      }
      this.arm(projectId, batch)
      return
    }

    this.pending.delete(projectId)
    if (!this.underCap(projectId)) {
      if (!this.capLogged.has(projectId)) {
        this.capLogged.add(projectId)
        console.warn(`[CaptainWaker] Wake-up cap reached for project ${projectId} (${this.hourlyCap}/hour); dropping ${batch.events.length} event(s) until the hour rolls over`)
      }
      return
    }

    const agentId = live?.session.agentId ?? resolveCaptainAgentId(this.db, project)
    if (!agentId) {
      console.warn(`[CaptainWaker] No agent to run the Captain of ${projectId}; dropping ${batch.events.length} event(s)`)
      return
    }

    const listed = batch.events.slice(0, this.maxEventsPerWake)
    const message = buildCaptainWakeMessage(coordinator.id, project.name, listed, batch.events.length - listed.length)
    this.recordWake(projectId)
    this.flushing.add(projectId)
    try {
      console.log(`[CaptainWaker] Waking Captain of ${projectId} with ${batch.events.length} event(s)`)
      await this.agents.sendMessage(live?.sessionId ?? '', message, coordinator.id, agentId)
    } catch (err) {
      console.error(`[CaptainWaker] Could not wake the Captain of ${projectId}:`, err)
    } finally {
      this.flushing.delete(projectId)
    }
  }

  private underCap(projectId: string): boolean {
    const cutoff = this.now() - HOUR_MS
    const recent = (this.wakes.get(projectId) ?? []).filter((at) => at > cutoff)
    this.wakes.set(projectId, recent)
    if (recent.length < this.hourlyCap) {
      this.capLogged.delete(projectId)
      return true
    }
    return false
  }

  private recordWake(projectId: string): void {
    const recent = this.wakes.get(projectId) ?? []
    recent.push(this.now())
    this.wakes.set(projectId, recent)
  }
}

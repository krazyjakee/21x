/**
 * Captain-managed concurrency, main-process side (#150).
 *
 * The rules are in shared/concurrency.ts. This module reads and writes the
 * `concurrency` block of a project's settings, applies level changes (from
 * the Captain's `set_concurrency`, from the user in the project editor, and
 * automatically under resource pressure), and records each one twice: a row
 * in `concurrency_audit` (the project's concurrency activity feed) and a line
 * in the project status journal (#72).
 *
 * It also holds the two live inputs admission needs that are not in the
 * database: the machine's resource pressure ({@link ResourceMonitor}) and the
 * files each running task's branch has changed ({@link BranchDiffCache}).
 *
 * Lowering a level never stops running work. Admission only defers new starts
 * of that project and agent until fewer than the new level are running.
 */
import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { cpus, freemem, loadavg, totalmem } from 'os'
import { join } from 'path'
import type { AgentRecord, DatabaseManager } from './database'
import {
  DEFAULT_RESOURCE_THRESHOLDS,
  agentHardCap,
  concurrencyFromSettings,
  effectiveLevel,
  evaluateResourcePressure,
  findPathOverlap,
  validateLevelRequest,
  type ConcurrencyActor,
  type ConcurrencyAuditEntry,
  type EffectiveLevel,
  type ProjectConcurrencySettings,
  type ResourcePressure,
  type ResourceSample,
  type ResourceThresholds
} from '../shared/concurrency'

export type ConcurrencyStore = Pick<
  DatabaseManager,
  'getProject' | 'updateProject' | 'getAgent' | 'getAgents' | 'getProjects' | 'appendConcurrencyAudit' | 'appendProjectStatusJournal'
>

// ── Settings block ────────────────────────────────────────────

export function readProjectConcurrency(db: Pick<DatabaseManager, 'getProject'>, projectId: string): ProjectConcurrencySettings {
  return concurrencyFromSettings(db.getProject(projectId)?.settings)
}

function writeProjectConcurrency(db: Pick<DatabaseManager, 'getProject' | 'updateProject'>, projectId: string, block: ProjectConcurrencySettings): void {
  const project = db.getProject(projectId)
  if (!project) throw new Error('Project not found')
  db.updateProject(projectId, { settings: { ...(project.settings ?? {}), concurrency: block } })
}

export function agentCap(agent: Pick<AgentRecord, 'config'>): number {
  return agentHardCap(agent.config as unknown as { concurrency_cap?: unknown; max_parallel_sessions?: unknown })
}

/** The level admission applies to this project's jobs of this agent. */
export function projectAgentLevel(db: Pick<DatabaseManager, 'getProject'>, projectId: string, agent: Pick<AgentRecord, 'id' | 'config'>): EffectiveLevel {
  return effectiveLevel(readProjectConcurrency(db, projectId), agent.id, agentCap(agent))
}

// ── Audit ─────────────────────────────────────────────────────

const ACTOR_LABEL: Record<ConcurrencyActor, string> = { captain: 'The Captain', user: 'The user', system: '21x' }

function describeChange(entry: Omit<ConcurrencyAuditEntry, 'id' | 'created_at'>, agentName: string): string {
  const who = ACTOR_LABEL[entry.actor]
  switch (entry.kind) {
    case 'level':
      return `${who} set ${agentName}'s working level from ${entry.previous_level ?? '?'} to ${entry.level} (hard cap ${entry.cap})`
    case 'pin':
      return `${who} pinned ${agentName}'s level at ${entry.level} (hard cap ${entry.cap})`
    case 'unpin':
      return `${who} unpinned ${agentName}'s level; it is back at ${entry.level}`
    case 'control_on':
      return `${who} switched Captain control of concurrency on`
    case 'control_off':
      return `${who} switched Captain control of concurrency off; every agent runs up to its hard cap`
  }
}

/** Writes the audit row and its status-journal line. */
function audit(db: ConcurrencyStore, entry: Omit<ConcurrencyAuditEntry, 'id' | 'created_at'>, agentName: string): ConcurrencyAuditEntry | undefined {
  const row = db.appendConcurrencyAudit(entry)
  const line = describeChange(entry, agentName)
  try {
    db.appendProjectStatusJournal(entry.project_id, {
      summary: `Concurrency: ${line}. Reason: ${entry.reason}`,
      decisions: [`${line}: ${entry.reason}`]
    })
  } catch (error) {
    console.warn(`[Concurrency] Could not journal a change in project ${entry.project_id}:`, error)
  }
  console.log(`[Concurrency] ${entry.project_id}: ${line} (${entry.reason})`)
  return row
}

// ── Changes ───────────────────────────────────────────────────

export interface LevelChangeResult {
  success: true
  agent_id: string
  project_id: string
  previous_level: number
  level: number
  cap: number
  running_in_project: number
  audit_id?: string
  note: string
}

/**
 * The Captain's `set_concurrency` (or an internal caller). Refused above the
 * hard cap, below 1, on a pinned level, with Captain control off, without a
 * reason, and as a raise while the machine is under resource pressure.
 */
export function setConcurrencyLevel(
  db: ConcurrencyStore,
  input: {
    projectId: string
    agentId: string
    level: unknown
    reason: unknown
    actor?: ConcurrencyActor
    pressure?: ResourcePressure | null
    runningInProject?: number
  }
): LevelChangeResult | { error: string } {
  if (!db.getProject(input.projectId)) return { error: 'Project not found' }
  const agent = db.getAgent(input.agentId)
  if (!agent) return { error: `Agent not found: ${input.agentId}` }
  const cap = agentCap(agent)
  const settings = readProjectConcurrency(db, input.projectId)
  const checked = validateLevelRequest({ level: input.level, cap, settings, agentId: agent.id, reason: input.reason })
  if (!checked.ok) return { error: checked.error }
  const previous = effectiveLevel(settings, agent.id, cap).level
  if (checked.level > previous && input.pressure?.underPressure) {
    return { error: `Refused: the machine is under resource pressure (${input.pressure.reasons.join(', ')}). Hold the level at ${previous} or lower it; raise it once the pressure clears.` }
  }
  const running = input.runningInProject ?? 0
  const deferred = checked.level < running ? running - checked.level : 0
  const note = checked.level === previous
    ? `The level was already ${previous}; the reason is recorded.`
    : checked.level < previous
      ? deferred > 0
        ? `Lowered. ${running} job(s) keep running; no new start of this agent in this project until fewer than ${checked.level} run. Running work is never stopped.`
        : `Lowered. New starts of this agent in this project wait once ${checked.level} run.`
      : `Raised. Up to ${checked.level} of this project's jobs on this agent may run; queued starts begin now if slots are free.`

  writeProjectConcurrency(db, input.projectId, { ...settings, levels: { ...settings.levels, [agent.id]: checked.level } })
  const row = audit(db, {
    project_id: input.projectId,
    agent_id: agent.id,
    kind: 'level',
    previous_level: previous,
    level: checked.level,
    cap,
    actor: input.actor ?? 'captain',
    reason: String(input.reason).trim()
  }, agent.name)
  return {
    success: true,
    agent_id: agent.id,
    project_id: input.projectId,
    previous_level: previous,
    level: checked.level,
    cap,
    running_in_project: running,
    audit_id: row?.id,
    note
  }
}

/**
 * The user's controls in the project editor: switch Captain control on or
 * off, pin an agent's level (clamped to its cap) or remove the pin.
 */
export function setUserConcurrency(
  db: ConcurrencyStore,
  projectId: string,
  change: { captainControl: boolean } | { agentId: string; pinnedLevel: number | null },
  reason = 'Changed in the project editor'
): { success: true } | { error: string } {
  if (!db.getProject(projectId)) return { error: 'Project not found' }
  const settings = readProjectConcurrency(db, projectId)
  if ('captainControl' in change) {
    if (settings.captain_control === change.captainControl) return { success: true }
    writeProjectConcurrency(db, projectId, { ...settings, captain_control: change.captainControl })
    audit(db, {
      project_id: projectId,
      agent_id: '',
      kind: change.captainControl ? 'control_on' : 'control_off',
      previous_level: null,
      level: null,
      cap: 0,
      actor: 'user',
      reason
    }, '')
    return { success: true }
  }
  const agent = db.getAgent(change.agentId)
  if (!agent) return { error: `Agent not found: ${change.agentId}` }
  const cap = agentCap(agent)
  const before = effectiveLevel(settings, agent.id, cap)
  const pinned = { ...settings.pinned }
  if (change.pinnedLevel === null) {
    if (pinned[agent.id] === undefined) return { success: true }
    delete pinned[agent.id]
  } else {
    const level = Math.floor(Number(change.pinnedLevel))
    if (!Number.isFinite(level) || level < 1) return { error: 'A pinned level must be at least 1.' }
    if (level > cap) return { error: `A pinned level cannot exceed the agent's hard cap of ${cap}.` }
    if (pinned[agent.id] === level) return { success: true }
    pinned[agent.id] = level
  }
  const next = { ...settings, pinned }
  writeProjectConcurrency(db, projectId, next)
  const after = effectiveLevel(next, agent.id, cap)
  audit(db, {
    project_id: projectId,
    agent_id: agent.id,
    kind: change.pinnedLevel === null ? 'unpin' : 'pin',
    previous_level: before.level,
    level: after.level,
    cap,
    actor: 'user',
    reason
  }, agent.name)
  return { success: true }
}

/**
 * One step down for every Captain-controlled level above 1, in every
 * project, while the machine is under pressure. Pinned levels and projects
 * with Captain control off are the user's choice and are left alone.
 * Running work is untouched. Returns the audit rows written.
 */
export function autoLowerForPressure(db: ConcurrencyStore, pressure: ResourcePressure): ConcurrencyAuditEntry[] {
  if (!pressure.underPressure) return []
  const written: ConcurrencyAuditEntry[] = []
  const reason = `Resource pressure: ${pressure.reasons.join(', ')}`
  for (const project of db.getProjects()) {
    const settings = concurrencyFromSettings(project.settings)
    if (!settings.captain_control) continue
    const levels = { ...settings.levels }
    const changes: Array<{ agent: AgentRecord; from: number; to: number; cap: number }> = []
    for (const [agentId, stored] of Object.entries(settings.levels)) {
      if (settings.pinned[agentId] !== undefined) continue
      const agent = db.getAgent(agentId)
      if (!agent) continue
      const cap = agentCap(agent)
      const from = effectiveLevel(settings, agentId, cap).level
      if (from <= 1) continue
      levels[agentId] = Math.max(1, Math.min(stored, cap) - 1)
      changes.push({ agent, from, to: levels[agentId], cap })
    }
    if (changes.length === 0) continue
    writeProjectConcurrency(db, project.id, { ...settings, levels })
    for (const change of changes) {
      const row = audit(db, {
        project_id: project.id,
        agent_id: change.agent.id,
        kind: 'level',
        previous_level: change.from,
        level: change.to,
        cap: change.cap,
        actor: 'system',
        reason
      }, change.agent.name)
      if (row) written.push(row)
    }
  }
  return written
}

// ── Resource pressure ─────────────────────────────────────────

export function sampleResources(): ResourceSample {
  return { freeMemBytes: freemem(), totalMemBytes: totalmem(), loadAvg1: loadavg()[0] ?? 0, cpuCount: cpus().length || 1 }
}

export interface ResourceMonitorOptions {
  sample?: () => ResourceSample
  thresholds?: ResourceThresholds
  /** Consecutive samples under pressure before acting; filters out one-off spikes. */
  confirmSamples?: number
  /** Least time between two automatic lowerings. */
  cooldownMs?: number
  now?: () => number
  /** Called when the pressure is confirmed and the cooldown has passed. */
  onPressure: (pressure: ResourcePressure) => void
}

/**
 * Samples free memory and CPU load in main. Pressure seen on
 * `confirmSamples` samples in a row calls `onPressure` (which lowers the
 * levels), then not again until the cooldown has passed, so levels step
 * down gradually rather than collapse on one bad minute.
 */
export class ResourceMonitor {
  private last: ResourcePressure | null = null
  private streak = 0
  private lastActionAt = -Infinity
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly opts: Required<Omit<ResourceMonitorOptions, 'onPressure'>> & Pick<ResourceMonitorOptions, 'onPressure'>

  constructor(options: ResourceMonitorOptions) {
    this.opts = {
      sample: options.sample ?? sampleResources,
      thresholds: options.thresholds ?? DEFAULT_RESOURCE_THRESHOLDS,
      confirmSamples: options.confirmSamples ?? 2,
      cooldownMs: options.cooldownMs ?? 2 * 60_000,
      now: options.now ?? Date.now,
      onPressure: options.onPressure
    }
  }

  /** The latest reading; null before the first sample. */
  current(): ResourcePressure | null {
    return this.last
  }

  /** Takes one sample and acts on it. Returns the reading. */
  tick(): ResourcePressure {
    const pressure = evaluateResourcePressure(this.opts.sample(), this.opts.thresholds)
    this.last = pressure
    this.streak = pressure.underPressure ? this.streak + 1 : 0
    const now = this.opts.now()
    if (this.streak >= this.opts.confirmSamples && now - this.lastActionAt >= this.opts.cooldownMs) {
      this.lastActionAt = now
      try {
        this.opts.onPressure(pressure)
      } catch (error) {
        console.error('[Concurrency] Acting on resource pressure failed:', error)
      }
    }
    return pressure
  }

  start(intervalMs = 30_000, onTick?: () => void): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
        onTick?.()
      } catch (error) {
        console.error('[Concurrency] Resource sample failed:', error)
      }
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// ── Branch diffs ──────────────────────────────────────────────

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

/** The repo checkouts in a task workspace: the directory itself, or its direct children. */
function repoDirs(workspaceDir: string): string[] {
  if (!workspaceDir || !existsSync(workspaceDir)) return []
  if (existsSync(join(workspaceDir, '.git'))) return [workspaceDir]
  try {
    return readdirSync(workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(workspaceDir, entry.name, '.git')))
      .map((entry) => join(workspaceDir, entry.name))
  } catch {
    return []
  }
}

/** Files a checkout changed against its upstream default branch, committed or not. */
export async function changedFiles(repoDir: string): Promise<string[]> {
  const files = new Set<string>()
  let base: string | null = null
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      base = (await git(repoDir, ['merge-base', 'HEAD', ref])).trim()
      if (base) break
    } catch {
      // try the next ref
    }
  }
  const outputs = await Promise.allSettled([
    base ? git(repoDir, ['diff', '--name-only', base]) : Promise.resolve(''),
    git(repoDir, ['diff', '--name-only', 'HEAD']),
    git(repoDir, ['ls-files', '--others', '--exclude-standard'])
  ])
  for (const out of outputs) {
    if (out.status !== 'fulfilled') continue
    for (const line of out.value.split('\n')) if (line.trim()) files.add(line.trim())
  }
  return [...files]
}

/**
 * The branch diff of each running task, refreshed in the background on the
 * resource monitor's tick. Admission reads it synchronously; a task whose
 * diff has not been read yet contributes only its declared touches.
 */
export class BranchDiffCache {
  private files = new Map<string, string[]>()
  private inFlight = new Set<string>()

  constructor(private readonly read: (repoDir: string) => Promise<string[]> = changedFiles) {}

  get(taskId: string): string[] {
    return this.files.get(taskId) ?? []
  }

  set(taskId: string, files: string[]): void {
    this.files.set(taskId, files)
  }

  forget(taskId: string): void {
    this.files.delete(taskId)
  }

  taskIds(): string[] {
    return [...this.files.keys()]
  }

  async refresh(taskId: string, workspaceDir: string): Promise<void> {
    if (this.inFlight.has(taskId)) return
    this.inFlight.add(taskId)
    try {
      const all: string[] = []
      for (const dir of repoDirs(workspaceDir)) {
        try {
          all.push(...(await this.read(dir)))
        } catch {
          // an unreadable checkout contributes nothing
        }
      }
      this.files.set(taskId, all)
    } finally {
      this.inFlight.delete(taskId)
    }
  }
}

// ── File overlap ──────────────────────────────────────────────

export interface OverlapCandidate {
  taskId: string
  repos: string[]
  touches: string[]
}

/**
 * The first running task of the same project whose touched files overlap the
 * requested task's, or null. Tasks that name repos and share none never
 * overlap (paths are repo-relative).
 */
export function findFileOverlap(requested: OverlapCandidate, running: readonly OverlapCandidate[]): { taskId: string; path: string } | null {
  if (requested.touches.length === 0) return null
  for (const other of running) {
    if (other.taskId === requested.taskId || other.touches.length === 0) continue
    if (requested.repos.length > 0 && other.repos.length > 0 && !requested.repos.some((r) => other.repos.includes(r))) continue
    const hit = findPathOverlap(requested.touches, other.touches)
    if (hit) return { taskId: other.taskId, path: hit.mine }
  }
  return null
}

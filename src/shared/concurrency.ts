/**
 * Captain-managed agent concurrency under a user-set hard cap (#150).
 *
 * Two numbers bound how many jobs of one agent run at once:
 *
 *  - the **hard cap**, per agent, set by the user (`agent.config.concurrency_cap`,
 *    "Hard cap" in the agent form). It bounds the agent's jobs across every
 *    project and nothing may exceed it: not the Captain, not a pin.
 *  - the **working level**, per project and agent, at or below the cap. The
 *    project's Captain moves it (`set_concurrency`) as the work asks for it;
 *    the user may pin it or switch Captain control off, in which case the
 *    level is the cap.
 *
 * Both live in JSON the database already has: the cap in the agent's
 * `config`, the level block in `projects.settings.concurrency`:
 *
 * ```json
 * {
 *   "concurrency": {
 *     "captain_control": true,          // default true
 *     "levels": { "<agentId>": 2 },     // the Captain's working levels; missing = 1
 *     "pinned": { "<agentId>": 3 }      // the user's pins; win over levels
 *   }
 * }
 * ```
 *
 * Everything in this module is pure so the renderer, the main process and the
 * tests share it. The main-process side (audit, resource sampling, touches)
 * is in src/main/concurrency-control.ts.
 */

// ── Hard cap ──────────────────────────────────────────────────

/**
 * The cap an agent gets when none was set: the user's chosen 5 for 21x, or
 * the agent's older `max_parallel_sessions` when that is lower. Migration 21
 * writes exactly this onto every existing agent.
 */
export const DEFAULT_HARD_CAP_CEILING = 5

/** The largest cap the agent form offers (the old parallel-sessions range). */
export const MAX_HARD_CAP = 10

/** Where a project's working level starts when the Captain controls it. */
export const DEFAULT_CONCURRENCY_LEVEL = 1

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null
}

/** min(existing max_parallel_sessions, 5): the default for new and migrated agents. */
export function defaultHardCap(maxParallelSessions: unknown): number {
  return Math.min(positiveInt(maxParallelSessions) ?? 1, DEFAULT_HARD_CAP_CEILING)
}

/**
 * The agent's hard cap. An explicit `concurrency_cap` wins; an agent that
 * predates it (not yet migrated, or written by an old client) gets the
 * migration default, so the cap is never above 5 unless the user set it so.
 */
export function agentHardCap(config: { concurrency_cap?: unknown; max_parallel_sessions?: unknown } | null | undefined): number {
  const explicit = positiveInt(config?.concurrency_cap)
  if (explicit !== null) return Math.min(explicit, MAX_HARD_CAP)
  return defaultHardCap(config?.max_parallel_sessions)
}

// ── Project settings block ────────────────────────────────────

export interface ProjectConcurrencySettings {
  /** The Captain sets working levels. Off: every agent runs up to its cap in this project. */
  captain_control: boolean
  /** agentId → the Captain's working level. Missing = DEFAULT_CONCURRENCY_LEVEL. */
  levels: Record<string, number>
  /** agentId → a level the user pinned. The Captain cannot move a pinned level. */
  pinned: Record<string, number>
}

export const DEFAULT_PROJECT_CONCURRENCY: ProjectConcurrencySettings = {
  captain_control: true,
  levels: {},
  pinned: {}
}

function levelMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = positiveInt(value)
    if (agentId && n !== null) out[agentId] = n
  }
  return out
}

/** The `concurrency` block of a project's settings, defaults for whatever is missing. */
export function concurrencyFromSettings(settings: Record<string, unknown> | null | undefined): ProjectConcurrencySettings {
  const raw = settings?.concurrency
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { captain_control: true, levels: {}, pinned: {} }
  }
  const block = raw as Record<string, unknown>
  return {
    captain_control: block.captain_control !== false,
    levels: levelMap(block.levels),
    pinned: levelMap(block.pinned)
  }
}

/** Who decides the level right now. */
export type ConcurrencyLevelSource = 'captain' | 'pinned' | 'cap'

export interface EffectiveLevel {
  level: number
  source: ConcurrencyLevelSource
  cap: number
}

/**
 * The level admission applies to (project, agent). Always within [1, cap]:
 * a stored level above a cap the user lowered later reads as the cap.
 */
export function effectiveLevel(settings: ProjectConcurrencySettings, agentId: string, cap: number): EffectiveLevel {
  const clamp = (n: number): number => Math.max(1, Math.min(n, cap))
  const pinned = settings.pinned[agentId]
  if (pinned !== undefined) return { level: clamp(pinned), source: 'pinned', cap }
  if (!settings.captain_control) return { level: cap, source: 'cap', cap }
  return { level: clamp(settings.levels[agentId] ?? DEFAULT_CONCURRENCY_LEVEL), source: 'captain', cap }
}

/** Why a requested level is refused, or null when it may be applied. */
export function validateLevelRequest(input: {
  level: unknown
  cap: number
  settings: ProjectConcurrencySettings
  agentId: string
  reason: unknown
}): { ok: true; level: number } | { ok: false; error: string } {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (!reason) return { ok: false, error: 'reason is required: say why the level changes (queue depth, a serial chain, file overlap, resource pressure).' }
  const raw = typeof input.level === 'string' ? Number(input.level) : input.level
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error: 'level must be a whole number.' }
  if (raw < 1) return { ok: false, error: 'level must be at least 1. To stop new starts, pause the project instead.' }
  if (raw > input.cap) {
    return { ok: false, error: `Refused: level ${raw} is above this agent's hard cap of ${input.cap}. The user sets the cap; the level can be at most ${input.cap}.` }
  }
  if (input.settings.pinned[input.agentId] !== undefined) {
    return { ok: false, error: `Refused: the user pinned this agent's level at ${input.settings.pinned[input.agentId]} in this project.` }
  }
  if (!input.settings.captain_control) {
    return { ok: false, error: 'Refused: the user switched Captain control of concurrency off for this project.' }
  }
  return { ok: true, level: raw }
}

// ── Priority-aware queue order ────────────────────────────────

export const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

export function priorityRank(priority: string | null | undefined): number {
  return PRIORITY_RANK[String(priority ?? '').toLowerCase()] ?? PRIORITY_RANK.medium
}

export interface OrderableStart {
  taskId: string
  /** The task's project; '' for none. */
  projectId?: string
  priority?: string | null
  /** ISO time the start was queued. */
  queuedAt: string
  /** Tie-breaker: insertion order. */
  seq: number
}

/**
 * The order queued starts are tried in.
 *
 * Within a project: priority (critical > high > medium > low), FIFO within
 * the same priority, so an urgent ticket jumps its own project's queue.
 *
 * Across projects: round robin, one start per project per round. The project
 * served least recently goes first (`lastServed`, a counter bumped on every
 * admitted start of the project; never served = 0), then the one whose start
 * has waited longest. Priority never crosses a project boundary, so a busy
 * project full of critical tickets cannot starve another project's low one:
 * that one is at most one round away, and next once the busy project starts
 * something.
 */
export function orderStartQueue<T extends OrderableStart>(entries: readonly T[], lastServed: (projectId: string) => number = () => 0): T[] {
  const byProject = new Map<string, T[]>()
  for (const entry of entries) {
    const key = entry.projectId ?? ''
    const list = byProject.get(key)
    if (list) list.push(entry)
    else byProject.set(key, [entry])
  }
  const fifo = (a: T, b: T): number => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : a.seq - b.seq)
  const lanes = [...byProject.entries()].map(([projectId, list]) => ({
    served: lastServed(projectId),
    oldest: [...list].sort(fifo)[0],
    items: [...list].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || fifo(a, b))
  }))
  lanes.sort((a, b) => a.served - b.served || fifo(a.oldest, b.oldest))
  const ordered: T[] = []
  for (let round = 0; ordered.length < entries.length; round++) {
    for (const lane of lanes) {
      if (round < lane.items.length) ordered.push(lane.items[round])
    }
  }
  return ordered
}

// ── File overlap ──────────────────────────────────────────────

/** Repo-relative, forward slashes, no leading ./ or /; '' for nothing usable. */
export function normalizeTouchPath(path: string): string {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
}

/**
 * True when two touched paths collide: the same file, or one is a directory
 * (written with or without a trailing slash, or ending in `/**`) that holds
 * the other.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const strip = (p: string): string => normalizeTouchPath(p).replace(/\/\*\*$/, '').replace(/\/$/, '')
  const x = strip(a)
  const y = strip(b)
  if (!x || !y) return false
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** The first colliding pair between two sets of touched paths, or null. */
export function findPathOverlap(mine: readonly string[], theirs: readonly string[]): { mine: string; theirs: string } | null {
  for (const a of mine) {
    for (const b of theirs) {
      if (pathsOverlap(a, b)) return { mine: a, theirs: b }
    }
  }
  return null
}

// ── Resource pressure ─────────────────────────────────────────

export interface ResourceSample {
  freeMemBytes: number
  totalMemBytes: number
  /** One-minute load average; 0 where the OS has none (Windows). */
  loadAvg1: number
  cpuCount: number
}

export interface ResourceThresholds {
  /** Pressure when free memory falls below this share of the total... */
  minFreeMemRatio: number
  /** ...or below this many bytes. */
  minFreeMemBytes: number
  /** Pressure when the one-minute load per CPU exceeds this. */
  maxLoadPerCpu: number
}

export const DEFAULT_RESOURCE_THRESHOLDS: ResourceThresholds = {
  minFreeMemRatio: 0.1,
  minFreeMemBytes: 1024 * 1024 * 1024,
  maxLoadPerCpu: 1.5
}

export interface ResourcePressure {
  underPressure: boolean
  /** Human-readable, e.g. "free memory 0.6 GiB (4%)". Empty when fine. */
  reasons: string[]
  freeMemRatio: number
  loadPerCpu: number
}

export function evaluateResourcePressure(sample: ResourceSample, thresholds: ResourceThresholds = DEFAULT_RESOURCE_THRESHOLDS): ResourcePressure {
  const freeMemRatio = sample.totalMemBytes > 0 ? sample.freeMemBytes / sample.totalMemBytes : 1
  const loadPerCpu = sample.cpuCount > 0 ? sample.loadAvg1 / sample.cpuCount : 0
  const reasons: string[] = []
  const gib = (sample.freeMemBytes / 1024 ** 3).toFixed(1)
  if (sample.totalMemBytes > 0 && (freeMemRatio < thresholds.minFreeMemRatio || sample.freeMemBytes < thresholds.minFreeMemBytes)) {
    reasons.push(`free memory ${gib} GiB (${Math.round(freeMemRatio * 100)}%)`)
  }
  if (loadPerCpu > thresholds.maxLoadPerCpu) {
    reasons.push(`CPU load ${loadPerCpu.toFixed(2)} per core`)
  }
  return { underPressure: reasons.length > 0, reasons, freeMemRatio, loadPerCpu }
}

// ── What the Captain should consider ──────────────────────────

export interface LevelSignals {
  cap: number
  level: number
  /** This project's starts of this agent waiting in the queue. */
  queued: number
  /** This project's jobs of this agent running now. */
  running: number
  /** Queued starts that are next in a serial chain (a predecessor still runs). */
  serialChainQueued: number
  /** Queued starts held back by file overlap with running work. */
  overlapQueued: number
  underPressure: boolean
}

/**
 * A suggested level and why. Advice for the Captain, never applied by
 * itself (resource pressure is the one automatic change, see
 * concurrency-control.ts). Serial-chain and overlapping starts cannot use
 * extra slots, so they do not count as demand.
 */
export function recommendLevel(s: LevelSignals): { level: number; why: string } {
  if (s.underPressure) {
    const level = Math.max(1, Math.min(s.level, Math.max(1, s.running)))
    return { level, why: 'the machine is under resource pressure: hold or lower, do not raise' }
  }
  const parallelDemand = Math.max(0, s.queued - s.serialChainQueued - s.overlapQueued)
  const wanted = Math.max(1, Math.min(s.cap, s.running + parallelDemand))
  if (wanted > s.level) return { level: wanted, why: `${parallelDemand} queued start(s) could run in parallel` }
  if (s.queued === 0 && s.level > Math.max(1, s.running)) {
    return { level: Math.max(1, s.running), why: 'nothing is queued; a lower level frees the agent for other projects' }
  }
  if (s.serialChainQueued + s.overlapQueued > 0 && parallelDemand === 0) {
    return { level: s.level, why: 'what waits is serial (a chain or overlapping files); more slots would not help' }
  }
  return { level: s.level, why: 'the level fits the queue' }
}

// ── Audit and state shapes (renderer-safe) ────────────────────

export type ConcurrencyActor = 'captain' | 'user' | 'system'

export interface ConcurrencyAuditEntry {
  id: string
  project_id: string
  agent_id: string
  /** What changed: the working level, a pin, or Captain control. */
  kind: 'level' | 'pin' | 'unpin' | 'control_on' | 'control_off'
  previous_level: number | null
  level: number | null
  cap: number
  actor: ConcurrencyActor
  reason: string
  created_at: string
}

export interface AgentConcurrencyState {
  agentId: string
  agentName: string
  cap: number
  level: number
  source: ConcurrencyLevelSource
  /** This project's working jobs of this agent. */
  runningInProject: number
  /** The agent's working jobs in every project (bounded by the cap). */
  runningTotal: number
  queuedInProject: number
  recommendation: { level: number; why: string }
}

export interface ProjectConcurrencyState {
  projectId: string
  captainControl: boolean
  agents: AgentConcurrencyState[]
  pressure: ResourcePressure | null
  /** Newest first. */
  recentChanges: ConcurrencyAuditEntry[]
}

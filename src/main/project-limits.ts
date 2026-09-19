/**
 * Per-project limits and the global pause (#65).
 *
 * The limits live in `projects.settings.limits` (shared/project-policies.ts).
 * This module turns them into what admission control checks
 * (agent-manager/admission.ts, `AdmissionLimits.project`), keeps the daily
 * counters, and describes a project's limit state for the UI and the
 * Captain.
 *
 * ## Daily counters
 *
 * One settings row per project, `project_daily_usage:<projectId>`, holds
 * `{ date, sessions, tokens }` for the local calendar day. A read on a new day
 * sees zero; the first start of the day overwrites the row. Nothing is
 * scheduled at midnight: the queue is re-checked on every idle-session sweep,
 * so a project that hit its cap resumes within one sweep of the day change.
 *
 * ## Tokens
 *
 * `recordProjectTokenUsage` is the seam. No adapter reports a per-session
 * token total to AgentManager today (the only usage field, `taskProgress.usage`
 * on Claude Code output, is for background subagents), so `daily_token_cap`
 * is stored and displayed but the counter stays at zero until an adapter
 * calls the seam. The admission check treats an unreached token cap like no
 * cap at all.
 */
import type { DatabaseManager } from './database'
import type { CountedSession, ProjectAdmissionLimits, QueuedStartInfo } from './agent-manager/admission'
import { projectLimitsFromSettings, type ProjectLimitReason, type ProjectLimitsSettings } from '../shared/project-policies'
import type { ProjectLimitState } from '../shared/project-limit-types'

export type { ProjectLimitState }

/** Settings key of the global pause: '1' stops new starts in every project. */
export const GLOBAL_PAUSE_SETTING = 'all_projects_paused'

type LimitsStore = Pick<DatabaseManager, 'getSetting' | 'setSetting' | 'getProject'>

export function isAllProjectsPaused(db: Pick<DatabaseManager, 'getSetting'>): boolean {
  return db.getSetting(GLOBAL_PAUSE_SETTING) === '1'
}

export function setAllProjectsPaused(db: Pick<DatabaseManager, 'setSetting'>, paused: boolean): void {
  db.setSetting(GLOBAL_PAUSE_SETTING, paused ? '1' : '0')
}

/** The project's limits block with defaults; a missing project has the defaults. */
export function readProjectLimits(db: Pick<DatabaseManager, 'getProject'>, projectId: string): ProjectLimitsSettings {
  return projectLimitsFromSettings(db.getProject(projectId)?.settings)
}

// ── Daily counters ────────────────────────────────────────────

export interface ProjectDailyUsage {
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  sessions: number
  tokens: number
}

function dailyUsageKey(projectId: string): string {
  return `project_daily_usage:${projectId}`
}

/** Local calendar day: the cap is "per day" as the user sees days, not UTC. */
export function localDayKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getProjectDailyUsage(db: Pick<DatabaseManager, 'getSetting'>, projectId: string, now: Date = new Date()): ProjectDailyUsage {
  const today = localDayKey(now)
  const raw = db.getSetting(dailyUsageKey(projectId))
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ProjectDailyUsage>
      if (parsed && parsed.date === today) {
        return {
          date: today,
          sessions: Number.isFinite(Number(parsed.sessions)) ? Math.max(0, Number(parsed.sessions)) : 0,
          tokens: Number.isFinite(Number(parsed.tokens)) ? Math.max(0, Number(parsed.tokens)) : 0
        }
      }
    } catch {
      // A garbled row counts as a fresh day rather than blocking the project.
    }
  }
  return { date: today, sessions: 0, tokens: 0 }
}

function writeDailyUsage(db: Pick<DatabaseManager, 'setSetting'>, projectId: string, usage: ProjectDailyUsage): void {
  db.setSetting(dailyUsageKey(projectId), JSON.stringify(usage))
}

/** Counts one admitted start against the project's day. */
export function recordProjectSessionStart(db: Pick<DatabaseManager, 'getSetting' | 'setSetting'>, projectId: string, now: Date = new Date()): ProjectDailyUsage {
  const usage = getProjectDailyUsage(db, projectId, now)
  usage.sessions += 1
  writeDailyUsage(db, projectId, usage)
  return usage
}

/**
 * Seam for adapters that report usage: adds `tokens` to the project's day.
 * Nothing calls it yet (see the module comment).
 */
export function recordProjectTokenUsage(db: Pick<DatabaseManager, 'getSetting' | 'setSetting'>, projectId: string, tokens: number, now: Date = new Date()): ProjectDailyUsage {
  const usage = getProjectDailyUsage(db, projectId, now)
  usage.tokens += Math.max(0, Math.floor(tokens))
  writeDailyUsage(db, projectId, usage)
  return usage
}

// ── Admission input ───────────────────────────────────────────

/** What checkAdmission needs to know about the requested task's project. */
export function projectAdmissionLimits(db: LimitsStore, projectId: string, now: Date = new Date()): ProjectAdmissionLimits {
  const limits = readProjectLimits(db, projectId)
  const usage = getProjectDailyUsage(db, projectId, now)
  // The token cap joins the daily check only once something records tokens;
  // a cap nobody can reach must not read as "unlimited sessions" either.
  const tokenCapHit = limits.daily_token_cap !== null && usage.tokens >= limits.daily_token_cap && usage.tokens > 0
  return {
    projectId,
    maxConcurrent: limits.max_concurrent_agents,
    paused: limits.paused,
    dailyCap: tokenCapHit ? usage.sessions : limits.daily_session_cap,
    startedToday: usage.sessions
  }
}

// ── Describing the state ──────────────────────────────────────

// The state's shape lives in shared/project-limit-types.ts so the renderer can type it.

export function buildProjectLimitState(
  db: LimitsStore,
  projectId: string,
  running: CountedSession[],
  queued: QueuedStartInfo[],
  now: Date = new Date()
): ProjectLimitState {
  const limits = readProjectLimits(db, projectId)
  const usage = getProjectDailyUsage(db, projectId, now)
  const runningAgents = running.filter((s) => s.projectId === projectId).length
  const allProjectsPaused = isAllProjectsPaused(db)
  const blockedBy: ProjectLimitReason | null = allProjectsPaused
    ? 'global_pause'
    : limits.paused
      ? 'project_paused'
      : limits.daily_session_cap !== null && usage.sessions >= limits.daily_session_cap
        ? 'project_daily_cap'
        : limits.max_concurrent_agents !== null && runningAgents >= limits.max_concurrent_agents
          ? 'project_limit'
          : null
  return {
    projectId,
    paused: limits.paused,
    allProjectsPaused,
    maxConcurrentAgents: limits.max_concurrent_agents,
    runningAgents,
    dailySessionCap: limits.daily_session_cap,
    sessionsStartedToday: usage.sessions,
    dailyTokenCap: limits.daily_token_cap,
    tokensToday: usage.tokens,
    queued,
    blockedBy
  }
}

/** One sentence on why a start waits, for tool results and the Captain. */
export function describeQueueReason(reason: string, limit?: number, running?: number): string {
  switch (reason) {
    case 'global_pause':
      return 'all projects are paused. It starts when the pause is lifted; do not call start_task again for it.'
    case 'project_paused':
      return 'the project is paused. It starts when the project is unpaused; do not call start_task again for it.'
    case 'project_daily_cap':
      return `the project's daily cap of ${limit ?? '?'} agent sessions is used up (${running ?? '?'} started today). It starts tomorrow, or when the cap is raised; do not call start_task again for it.`
    case 'project_limit':
      return `the project's limit of ${limit ?? '?'} concurrent agents is reached. It starts automatically when one of the project's sessions finishes; do not call start_task again for it.`
    case 'concurrency_level':
      return `the project's working concurrency level of ${limit ?? '?'} for this agent is reached (${running ?? '?'} running). It starts automatically when one finishes, or sooner if the Captain raises the level; do not call start_task again for it.`
    case 'file_overlap':
      return 'it touches the same files as a running job in this project, so it waits for that job to finish; do not call start_task again for it.'
    case 'global_limit':
      return 'the global concurrent session limit is reached. It starts automatically when a running session finishes; do not call start_task again for it.'
    default:
      return "the agent's hard cap on concurrent jobs is reached. It starts automatically when a running session finishes; do not call start_task again for it."
  }
}

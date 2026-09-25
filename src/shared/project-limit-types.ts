/**
 * Renderer-safe shapes for the per-project limit state (#65). The main
 * process builds them in project-limits.ts; the bridge and the project
 * editor read them.
 */
import type { ProjectLimitReason } from './project-policies'

/** A start waiting in the admission queue, as clients see it (agent-manager/admission.ts). */
export interface QueuedStartSummary {
  taskId: string
  agentId: string
  reason: string
  queuedAt: string
  position: number
}

/** What the UI and the Captain see of a project's limits (#65). */
export interface ProjectLimitState {
  projectId: string
  paused: boolean
  /** The `all_projects_paused` setting; when true nothing starts anywhere. */
  allProjectsPaused: boolean
  maxConcurrentAgents: number | null
  /** Working sessions of real tasks in the project right now. */
  runningAgents: number
  dailySessionCap: number | null
  sessionsStartedToday: number
  dailyTokenCap: number | null
  tokensToday: number
  /** Starts of this project's tasks waiting in the queue, with why. */
  queued: QueuedStartSummary[]
  /** The reason the next start would wait for, or null when it would run. */
  blockedBy: ProjectLimitReason | null
}


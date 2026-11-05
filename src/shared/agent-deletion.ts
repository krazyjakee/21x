/**
 * What deleting an agent touches. The same shape answers the question before
 * the user confirms (`agent:deletionImpact`) and reports what really happened
 * afterwards (`agent:delete`), so the two can only differ by what changed in
 * between. Lists are capped for display; `total` is always the real count.
 */
export interface AgentDeletionItem { id: string; title: string }
export interface AgentDeletionList { total: number; items: AgentDeletionItem[] }

export interface AgentDeletionImpact {
  agent_id: string
  agent_name: string
  /** Work of this agent that is running now; it is stopped first. */
  running: AgentDeletionList
  /** Starts of this agent waiting for a slot; they are withdrawn. */
  queued: AgentDeletionList
  /** Unfinished tasks that lose their agent and stay on the board. */
  unassigned_tasks: AgentDeletionList
  /** Recurring schedules that lose their agent. */
  recurring_tasks: AgentDeletionList
  /** How many of those start themselves, so new runs would have no chosen agent. */
  recurring_auto_start: number
  /** Active task groups dissolved so their tasks return to the board. */
  dissolved_groups: AgentDeletionList
  /** Other agents that listed this one as an automatic fallback. */
  fallback_agents: AgentDeletionList
  /** Projects whose Captain moves to another agent. */
  captain_projects: AgentDeletionList
  /** Projects that used this agent as their default. */
  default_projects: AgentDeletionList
  /** Projects holding a concurrency level or pin for this agent. */
  concurrency_projects: AgentDeletionList
  /** The Commander was set to use this agent's model. */
  commander_cleared: boolean
  was_default: boolean
  /** The agent that becomes the app default; null when none remains. */
  replacement_default: { id: string; name: string } | null
  /** No agents remain once this one is gone. */
  last_agent: boolean
}

/**
 * A deletion that truly could not happen, in words naming what is in the way.
 * This is a result, not an exception: the service transport reports any other
 * error as a bare INTERNAL_ERROR, which would lose the name on Tauri.
 */
export interface AgentDeletionRefusal { refused: string }
export type AgentDeletionResult = AgentDeletionImpact | AgentDeletionRefusal | false
/** One report per agent the plugin owned; empty when it owned none. */
export type PluginUninstallResult = AgentDeletionImpact[] | AgentDeletionRefusal | false

/**
 * Thrown by the lifecycle owner; each host turns it into an AgentDeletionRefusal.
 * It carries what had already happened, because a stop does not roll back: when
 * one uninstall covers several agents, each layer adds its own count on the way out.
 */
export class AgentDeletionRefused extends Error {
  constructor(readonly sentence: string, readonly stopped = 0, readonly withdrawn = 0) {
    const done = [stopped ? `${plural(stopped, 'session')} stopped` : '', withdrawn ? `${plural(withdrawn, 'queued start')} withdrawn` : ''].filter(Boolean)
    super(done.length ? `${sentence} Already done: ${done.join(', ')}.` : sentence)
  }
  after(stopped: number, withdrawn: number): AgentDeletionRefused {
    return new AgentDeletionRefused(this.sentence, this.stopped + stopped, this.withdrawn + withdrawn)
  }
}

export const AGENT_DELETION_REFUSAL_LIMIT = 2048

export const refusalOf = (error: unknown): AgentDeletionRefusal => {
  if (error instanceof AgentDeletionRefused) return { refused: error.message.slice(0, AGENT_DELETION_REFUSAL_LIMIT) }
  throw error
}

/** Decided by the key alone: a length test here would read a long refusal as a report. */
export const isAgentDeletionRefusal = (value: unknown): value is AgentDeletionRefusal =>
  !!value && typeof value === 'object' && typeof (value as AgentDeletionRefusal).refused === 'string'

export const isPluginUninstallResult = (value: unknown): value is PluginUninstallResult => value === false || isAgentDeletionRefusal(value)
  || Array.isArray(value) && value.length <= 128 && value.every(isAgentDeletionImpact)

/** Task ids held by the agent's lifecycle owners at the moment of deletion. */
export interface AgentLiveWork { running: string[]; queued: string[] }
export const NO_AGENT_LIVE_WORK: AgentLiveWork = { running: [], queued: [] }

export const AGENT_DELETION_LIST_LIMIT = 20
export const AGENT_DELETION_TITLE_LIMIT = 200

/** Settings key naming the agent a Captain row's saved session was made by. */
export const captainSessionAgentKey = (taskId: string): string => `captain_session_agent:${taskId}`

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0
const isName = (value: unknown): boolean => typeof value === 'string' && value.length <= 1024
const isItem = (value: unknown): boolean => isRecord(value) && typeof value.id === 'string' && !!value.id && value.id.length <= 256 && isName(value.title)
const isList = (value: unknown): boolean => isRecord(value) && isCount(value.total) && Array.isArray(value.items)
  && value.items.length <= AGENT_DELETION_LIST_LIMIT && value.items.every(isItem)

const LISTS = ['running', 'queued', 'unassigned_tasks', 'recurring_tasks', 'dissolved_groups', 'fallback_agents',
  'captain_projects', 'default_projects', 'concurrency_projects'] as const

export function isAgentDeletionImpact(value: unknown): value is AgentDeletionImpact {
  return isRecord(value) && typeof value.agent_id === 'string' && !!value.agent_id && isName(value.agent_name)
    && LISTS.every(key => isList(value[key])) && isCount(value.recurring_auto_start)
    && typeof value.commander_cleared === 'boolean' && typeof value.was_default === 'boolean' && typeof value.last_agent === 'boolean'
    && (value.replacement_default === null || isRecord(value.replacement_default) && typeof value.replacement_default.id === 'string' && isName(value.replacement_default.name))
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
const named = (list: AgentDeletionList): string => {
  const titles = list.items.slice(0, 3).map(item => `“${item.title}”`).join(', ')
  return list.total > 3 ? `${titles} and ${list.total - 3} more` : titles
}

/**
 * The impact in plain words, split into what stops (which is what the user is
 * really confirming) and what is left unassigned. One wording for the
 * confirmation, the receipt and the project journal.
 */
export function describeAgentDeletion(impact: AgentDeletionImpact): { stops: string[]; changes: string[] } {
  const stops: string[] = [], changes: string[] = []
  if (impact.running.total) stops.push(`${plural(impact.running.total, 'running session')} of this agent: ${named(impact.running)}`)
  if (impact.queued.total) stops.push(`${plural(impact.queued.total, 'queued start')}: ${named(impact.queued)}`)
  if (impact.unassigned_tasks.total) changes.push(`${plural(impact.unassigned_tasks.total, 'task')} left without an agent, still on the board: ${named(impact.unassigned_tasks)}`)
  if (impact.recurring_tasks.total) {
    const count = impact.recurring_auto_start
    const warning = count ? ` ${count === 1 ? 'One starts itself' : `${count} start themselves`}, so new runs have no chosen agent until you pick one.` : ''
    changes.push(`${plural(impact.recurring_tasks.total, 'recurring task')} left without an agent: ${named(impact.recurring_tasks)}.${warning}`)
  }
  if (impact.dissolved_groups.total) changes.push(`${plural(impact.dissolved_groups.total, 'task group')} dissolved, its tasks returned to the board: ${named(impact.dissolved_groups)}`)
  if (impact.captain_projects.total) changes.push(`Captain moves to another agent in: ${named(impact.captain_projects)}`)
  if (impact.default_projects.total) changes.push(`Project default cleared in: ${named(impact.default_projects)}`)
  if (impact.fallback_agents.total) changes.push(`Removed from the fallback list of: ${named(impact.fallback_agents)}`)
  if (impact.concurrency_projects.total) changes.push(`Concurrency settings for this agent removed in: ${named(impact.concurrency_projects)}`)
  if (impact.commander_cleared) changes.push('The Commander moves to another configured model.')
  if (impact.was_default) {
    changes.push(impact.replacement_default
      ? `“${impact.replacement_default.name}” becomes the default agent.`
      : 'There will be no default agent.')
  }
  if (impact.last_agent) changes.push('This is your last agent. Nothing can run until you add another.')
  return { stops, changes }
}

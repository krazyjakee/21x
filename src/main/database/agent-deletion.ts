import type { DatabaseManager } from './manager'
import { TaskStatus } from '../../shared/constants'
import { CHAT_SETTING_KEYS } from '../../shared/chat'
import { concurrencyFromSettings } from '../../shared/concurrency'
import {
  AGENT_DELETION_LIST_LIMIT,
  AGENT_DELETION_TITLE_LIMIT,
  captainSessionAgentKey,
  describeAgentDeletion,
  NO_AGENT_LIVE_WORK,
  type AgentDeletionImpact,
  type AgentDeletionItem,
  type AgentDeletionList,
  type AgentLiveWork
} from '../../shared/agent-deletion'

const ACTIVE_QUEUE_STATES = "('queued','retrying','claimed','starting')"
const CAPTAIN_SESSION_PREFIX = captainSessionAgentKey('')

const toList = (rows: Array<{ id: string; title: string }>): AgentDeletionList => ({
  total: rows.length,
  items: rows.slice(0, AGENT_DELETION_LIST_LIMIT).map((row): AgentDeletionItem => ({ id: row.id, title: row.title.slice(0, AGENT_DELETION_TITLE_LIMIT) }))
})

/** Projects, archived ones included, that this agent is named in. */
function agentProjects(manager: DatabaseManager) {
  return manager.getProjects({ includeArchived: true })
}

function holdsConcurrency(settings: Record<string, unknown> | null | undefined, agentId: string): boolean {
  const block = concurrencyFromSettings(settings)
  return Object.hasOwn(block.levels, agentId) || Object.hasOwn(block.pinned, agentId)
}

/** Every project a deletion rewrites, for callers that must authorize each one. */
export function agentDeletionProjectIds(manager: DatabaseManager, agentId: string): string[] {
  return agentProjects(manager).filter(project => holdsConcurrency(project.settings, agentId)).map(project => project.id)
}

/** The agent that takes over as app default, or null when none remains. */
function replacementDefault(manager: DatabaseManager, agentId: string): { id: string; name: string } | null {
  const others = manager.getAgents().filter(agent => agent.id !== agentId)
  const configured = manager.getSetting('default_agent_id')
  const next = others.find(agent => agent.id === configured) ?? others.find(agent => agent.is_default) ?? others[0]
  return next ? { id: next.id, name: next.name } : null
}

export function readAgentDeletionImpact(manager: DatabaseManager, agentId: string, live: AgentLiveWork = NO_AGENT_LIVE_WORK): AgentDeletionImpact | null {
  const agent = manager.getAgent(agentId)
  if (!agent) return null
  const db = manager.db
  const titled = (ids: string[]): AgentDeletionList => toList(ids.map(id => ({ id, title: manager.getTask(id)?.title ?? 'Task' })))
  const recurring = "is_recurring = 1 AND recurrence_parent_id IS NULL"
  const projects = agentProjects(manager)
  const agents = manager.getAgents()
  const named = (project: { id: string; name: string }) => ({ id: project.id, title: project.name })
  const resolvesToThis = (project: { captain_agent_id: string | null; default_agent_id: string | null }): boolean => {
    const known = (id: string | null) => id && agents.some(row => row.id === id) ? id : null
    return (known(project.captain_agent_id) ?? known(project.default_agent_id) ?? agents.find(row => row.is_default)?.id ?? agents[0]?.id) === agentId
  }
  const others = agents.filter(row => row.id !== agentId)
  const wasDefault = agent.is_default || manager.getSetting('default_agent_id') === agentId
  return {
    agent_id: agent.id,
    agent_name: agent.name,
    running: titled(live.running),
    queued: titled(live.queued),
    unassigned_tasks: toList(db.prepare(`SELECT id, title FROM tasks WHERE agent_id = ? AND role = 'task' AND status <> ? AND NOT (${recurring}) ORDER BY created_at, id`)
      .all(agentId, TaskStatus.Completed) as Array<{ id: string; title: string }>),
    recurring_tasks: toList(db.prepare(`SELECT id, title FROM tasks WHERE agent_id = ? AND role = 'task' AND ${recurring} ORDER BY created_at, id`)
      .all(agentId) as Array<{ id: string; title: string }>),
    recurring_auto_start: (db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE agent_id = ? AND role = 'task' AND auto_start_agent = 1 AND ${recurring}`)
      .get(agentId) as { count: number }).count,
    dissolved_groups: toList(db.prepare("SELECT id, title FROM task_groups WHERE agent_id = ? AND state = 'active' ORDER BY created_at, id")
      .all(agentId) as Array<{ id: string; title: string }>),
    fallback_agents: toList(others.filter(row => row.config.fallback_agent_ids?.includes(agentId)).map(row => ({ id: row.id, title: row.name }))),
    captain_projects: toList(projects.filter(project => !project.archived && resolvesToThis(project)).map(named)),
    default_projects: toList(projects.filter(project => project.default_agent_id === agentId).map(named)),
    concurrency_projects: toList(projects.filter(project => holdsConcurrency(project.settings, agentId)).map(named)),
    commander_cleared: manager.getSetting(CHAT_SETTING_KEYS.agentId) === agentId,
    was_default: wasDefault,
    replacement_default: wasDefault ? replacementDefault(manager, agentId) : null,
    last_agent: others.length === 0
  }
}

/** Sessions are already stopped; these are rows no live owner will settle. */
function releaseAgentWork(manager: DatabaseManager, agentId: string): void {
  const db = manager.db, now = new Date().toISOString(), epoch = Date.now()
  manager.retireTaskGroupsOfAgent(agentId)
  // A session lost in a crash leaves its task claiming to be worked on. With
  // the agent gone nothing would ever move it, so it would look busy for ever.
  const settle = db.prepare('UPDATE tasks SET status = ?, session_id = NULL, updated_at = ? WHERE agent_id = ? AND status = ?')
  settle.run(TaskStatus.NotStarted, now, agentId, TaskStatus.AgentWorking)
  settle.run(TaskStatus.NotStarted, now, agentId, TaskStatus.Triaging)
  settle.run(TaskStatus.ReadyForReview, now, agentId, TaskStatus.AgentLearning)
  // Same terminal shape as StartQueueStore.cancel. A start left active for a
  // missing agent would otherwise refuse later CLI configuration changes.
  db.prepare(`UPDATE agent_start_queue SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, recovery_cause = 'agent_deleted',
    recovery_action = 'exclude_from_retry', recovery_result = 'agent_deleted', acknowledged_at = ?, updated_at = ?
    WHERE agent_id = ? AND state IN ${ACTIVE_QUEUE_STATES}`).run(epoch, epoch, agentId)
  // Forget the binding and the session together. With only the binding gone a
  // Captain would try to resume this agent's session on another backend.
  const bound = db.prepare('SELECT key FROM settings WHERE key LIKE ? AND value = ?').all(`${CAPTAIN_SESSION_PREFIX}%`, agentId) as Array<{ key: string }>
  for (const { key } of bound) {
    db.prepare('UPDATE tasks SET session_id = NULL, updated_at = ? WHERE id = ?').run(now, key.slice(CAPTAIN_SESSION_PREFIX.length))
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }
}

/** The pointers SQLite cannot see: ids held inside JSON and settings values. */
function clearAgentReferences(manager: DatabaseManager, agentId: string, impact: AgentDeletionImpact): void {
  for (const agent of manager.getAgents()) {
    if (agent.id !== agentId && agent.config.fallback_agent_ids?.includes(agentId)) {
      manager.updateAgent(agent.id, { config: { ...agent.config, fallback_agent_ids: agent.config.fallback_agent_ids.filter(id => id !== agentId) } })
    }
  }
  for (const project of agentProjects(manager)) {
    if (!holdsConcurrency(project.settings, agentId)) continue
    const block = concurrencyFromSettings(project.settings)
    delete block.levels[agentId]
    delete block.pinned[agentId]
    manager.updateProject(project.id, { settings: { ...(project.settings ?? {}), concurrency: block } })
  }
  if (impact.commander_cleared) manager.setSetting(CHAT_SETTING_KEYS.agentId, '')
  const replacement = impact.replacement_default
  if (manager.getSetting('default_agent_id') === agentId) manager.setSetting('default_agent_id', replacement?.id ?? '')
  if (replacement) manager.db.prepare('UPDATE agents SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(replacement.id)
}

/** A line in each affected project's journal, so the change outlives the dialog. */
function journalAgentDeletion(manager: DatabaseManager, impact: AgentDeletionImpact): void {
  const { stops, changes } = describeAgentDeletion(impact)
  if (!stops.length && !changes.length) return
  const projectIds = new Set<string>()
  const ids = [...impact.running.items, ...impact.queued.items, ...impact.unassigned_tasks.items, ...impact.recurring_tasks.items].map(item => item.id)
  for (const id of ids) { const task = manager.getTask(id); if (task?.project_id) projectIds.add(task.project_id) }
  for (const list of [impact.captain_projects, impact.default_projects, impact.concurrency_projects]) for (const item of list.items) projectIds.add(item.id)
  const decisions = [...stops, ...changes].map(line => line.slice(0, 280)).slice(0, 8)
  for (const projectId of projectIds) {
    manager.appendProjectStatusJournal(projectId, { summary: `Agent “${impact.agent_name}” was deleted by the user.`, decisions }, { source: 'system_recovery' })
  }
}

/**
 * The one way an agent row goes away. Everything is one transaction so a
 * failure leaves the agent and all its references exactly as they were.
 * Foreign keys cover tasks.agent_id, the project columns and the Captain
 * runtime; this covers everything they cannot. Dissolved groups, the
 * concurrency feed and PR review records keep the id on purpose: they are
 * history of what happened, and nothing resolves them back to an agent.
 */
export function removeAgent(manager: DatabaseManager, agentId: string, live: AgentLiveWork = NO_AGENT_LIVE_WORK): AgentDeletionImpact | false {
  return manager.db.transaction((): AgentDeletionImpact | false => {
    const impact = readAgentDeletionImpact(manager, agentId, live)
    if (!impact) return false
    releaseAgentWork(manager, agentId)
    clearAgentReferences(manager, agentId, impact)
    manager.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId)
    journalAgentDeletion(manager, impact)
    return impact
  })()
}

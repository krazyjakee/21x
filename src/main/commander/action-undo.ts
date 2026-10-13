import type { DatabaseManager } from '../database'
import type { CommanderStore } from './commander-store'
import type { CommanderAgents, ProjectChangeKind } from './project-tools'
import type { SkillChangeKind } from './skill-tools'
import type { CommanderActionChange, CommanderActionTarget } from '../../shared/commander-action'
import type { CommanderMessage } from '../../shared/commander'

const FIELDS: Record<string, readonly string[]> = {
  archive_project: ['archived'], restore_project: ['archived'], pause_all_projects: ['all_projects_paused'],
  update_project: ['name', 'description', 'captain_agent_id', 'default_agent_id', 'git_provider', 'git_org'],
  update_project_repo: ['name', 'provider', 'org', 'default_branch'],
  update_project_resource: ['label', 'url', 'notes'],
  update_skill: ['name', 'description', 'content', 'tags', 'preferred_model']
}
interface ActionRow { id: string; session_id: string; tool_name: string; target: string; changes: string; undone_at: number | null; undone_message_id: string | null }
export interface UndoCommanderActionResult { alreadyUndone: boolean; message: CommanderMessage }

/** Exact reversal of the recorded write. No model turn, guessed restoration or approval chain. */
export function undoCommanderAction(options: {
  db: DatabaseManager; store: CommanderStore; agents?: CommanderAgents | null
  sessionId: string; actionId: string
  onProjectChanged?: (projectId: string, kind: ProjectChangeKind) => void
  onSkillChanged?: (skillId: string, kind: SkillChangeKind) => void
}): UndoCommanderActionResult {
  const { db, store, sessionId, actionId, agents } = options
  const notices: { project: { id: string; kind: ProjectChangeKind } | null; skill: string | null; captain: string | null } = {
    project: null, skill: null, captain: null
  }
  const outcome = db.db.transaction(() => {
    const row = db.db.prepare('SELECT * FROM commander_actions WHERE id = ? AND session_id = ?').get(actionId, sessionId) as ActionRow | undefined
    if (!row || !store.getSession(sessionId)) throw new Error('Action not found in this conversation')
    if (row.undone_at !== null) {
      const message = row.undone_message_id ? store.getMessage(row.undone_message_id) : null
      if (!message) throw new Error('The saved Undo note is unavailable')
      return { alreadyUndone: true, message }
    }
    const fields = FIELDS[row.tool_name]
    if (!fields) throw new Error("Can't be undone here")
    const target = JSON.parse(row.target) as CommanderActionTarget
    const changes = JSON.parse(row.changes) as CommanderActionChange[]
    if (!Array.isArray(changes) || !changes.length || changes.some(change => !fields.includes(change.field))) throw new Error("Can't be undone here")
    let current: Record<string, unknown> | undefined
    switch (target.kind) {
      case 'project': current = db.getProject(target.id) as unknown as Record<string, unknown> | undefined; break
      case 'repo': {
        const repo = db.getProjectRepo(target.id)
        if (repo?.project_id === target.projectId) current = repo as unknown as Record<string, unknown>
        break
      }
      case 'resource': {
        const resource = db.getProjectResource(target.id)
        if (resource?.project_id === target.projectId) current = resource as unknown as Record<string, unknown>
        break
      }
      case 'skill': {
        const skill = db.getSkill(target.id)
        if (skill && (skill.project_id ?? null) === (target.projectId ?? null)) current = skill as unknown as Record<string, unknown>
        break
      }
      case 'all-projects':
        if (agents) current = { all_projects_paused: agents.isAllProjectsPaused() }
        break
    }
    if (!current) throw new Error('This target is no longer available; nothing was undone')
    if (changes.some(change => JSON.stringify(current![change.field] ?? null) !== JSON.stringify(change.after))) {
      throw new Error('The affected fields changed after this action; nothing was undone')
    }
    const before = Object.fromEntries(changes.map(change => [change.field, change.before]))
    if (row.tool_name === 'pause_all_projects') {
      agents!.pauseAllProjects(before.all_projects_paused === true)
    } else if (row.tool_name === 'archive_project' || row.tool_name === 'restore_project') {
      db.archiveProject(target.id, before.archived === true)
      notices.project = { id: target.id, kind: before.archived === true ? 'archived' : 'restored' }
    } else if (row.tool_name === 'update_project') {
      db.updateProject(target.id, before)
      notices.project = { id: target.id, kind: 'updated' }
      if ('captain_agent_id' in before || 'default_agent_id' in before) notices.captain = target.id
    } else if (row.tool_name === 'update_project_repo') {
      db.updateProjectRepo(target.id, before)
      notices.project = { id: target.projectId!, kind: 'repos' }
    } else if (row.tool_name === 'update_project_resource') {
      db.updateProjectResource(target.id, before)
      notices.project = { id: target.projectId!, kind: 'resources' }
    } else if (row.tool_name === 'update_skill') {
      if ('name' in before) {
        const taken = db.getSkillByName(String(before.name))
        if (taken && taken.id !== target.id) throw new Error('That skill name is now in use; nothing was undone')
      }
      db.updateSkill(target.id, { ...before, expected_version: Number(current.version) })
      notices.skill = target.id
    }
    const detail = changes.map(change => {
      const value = JSON.stringify(change.before)
      return `${change.field}: ${value.length > 320 ? value.slice(0, 319) + '… (excerpt)' : value}`
    }).join('; ')
    const note = store.appendMessage(sessionId, {
      role: 'assistant', content: `Undo applied directly: ${target.name}. Restored ${detail}.`,
      toolName: 'undo_action', toolCallId: actionId, projectId: target.projectId ?? (target.kind === 'project' ? target.id : null)
    })
    db.db.prepare('UPDATE commander_actions SET undone_at = ?, undone_message_id = ? WHERE id = ?').run(note.created_at, note.id, actionId)
    return { alreadyUndone: false, message: note }
  })()
  if (notices.project) options.onProjectChanged?.(notices.project.id, notices.project.kind)
  if (notices.skill) options.onSkillChanged?.(notices.skill, 'updated')
  if (notices.captain) agents?.releaseCaptainIfAgentChanged?.(notices.captain)?.catch(error => console.error('[Commander] Captain release after Undo failed:', error))
  return outcome
}

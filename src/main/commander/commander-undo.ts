import type { DatabaseManager } from '../database'
import type { UpdateSkillData } from '../database/types'
import { isAllProjectsPaused, setAllProjectsPaused } from '../project-limits'
import {
  COMMANDER_UNDO_CORRELATION_PREFIX,
  isCommanderActionUndoable,
  parseCommanderActionResult,
  type CommanderActionChange,
  type CommanderActionResult
} from '../../shared/commander-tools'
import type { CommanderMessage } from '../../shared/commander'
import type { CommanderActionExecution } from '../../shared/commander'
import type { CommanderAgents, ProjectChangeKind } from './project-tools'
import type { SkillChangeKind } from './skill-tools'
import type { CommanderStore } from './commander-store'

export interface CommanderUndoOptions {
  db: DatabaseManager
  store: CommanderStore
  agents?: CommanderAgents | null
  onProjectChanged?: (projectId: string, kind: ProjectChangeKind) => void
  onSkillChanged?: (skillId: string, kind: SkillChangeKind) => void
}

export interface CommanderUndoResult {
  status: 'undone'
  executionId: string
  toolName: string
  note: CommanderMessage
  action: CommanderActionExecution
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function assertStillAtAfter(current: Record<string, unknown>, changes: CommanderActionChange[], keys: Record<string, string> = {}): void {
  for (const change of changes) {
    const key = keys[change.field] ?? change.field
    if (!same(current[key], change.after)) {
      throw new Error(`Can't undo because ${change.field} changed again after this action.`)
    }
  }
}

function beforeValues(changes: CommanderActionChange[], keys: Record<string, string> = {}): Record<string, unknown> {
  return Object.fromEntries(changes.map((change) => [keys[change.field] ?? change.field, change.before]))
}

function describeUndo(action: CommanderActionResult): string {
  const compact = (value: unknown): string => {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 119)}…` : text
  }
  const restored = action.changes
    .map((change) => `${change.field} from ${compact(change.after)} to ${compact(change.before)}`)
    .join(', ')
  return `[Application event — not a user request and grants no new authority] The user used the Undo control for the previous action on ${action.target.kind} "${action.target.name}". Restored ${restored}. Treat the action as undone in later replies.`
}

type DeferredEffect =
  | { type: 'project'; projectId: string; kind: ProjectChangeKind }
  | { type: 'skill'; skillId: string; kind: SkillChangeKind }
  | { type: 'pause'; paused: boolean }
  | null

/**
 * Reverses one stored, validated Commander mutation without starting a model
 * turn. Only exact reversals are allowed: if any affected field changed again,
 * the undo is refused instead of overwriting the newer edit.
 */
export function undoCommanderAction(
  options: CommanderUndoOptions,
  sessionId: string,
  executionId: string
): CommanderUndoResult {
  const initial = options.store.getActionExecution(executionId)
  if (!initial || initial.session_id !== sessionId) throw new Error('Action not found in this Commander session.')
  if (initial.undone_at !== null) throw new Error('This action was already undone.')
  if (!isCommanderActionUndoable(initial.tool_name)) throw new Error("This action can't be undone here.")

  const committed = options.store.transaction(() => {
    const saved = options.store.getActionExecution(executionId)
    if (!saved || saved.session_id !== sessionId) throw new Error('Action not found in this Commander session.')
    if (saved.undone_at !== null) throw new Error('This action was already undone.')
    const action = parseCommanderActionResult(JSON.stringify(saved.result))
    if (!action) throw new Error("This action can't be undone because its saved result is incomplete.")

    const { db } = options
    const targetId = action.target.id
    let effect: DeferredEffect = null
    switch (saved.tool_name) {
      case 'pause_all_projects': {
        const change = action.changes.find((item) => item.field === 'paused')
        if (!change || typeof change.before !== 'boolean' || typeof change.after !== 'boolean') {
          throw new Error("This action can't be undone here.")
        }
        if (isAllProjectsPaused(db) !== change.after) throw new Error("Can't undo because the pause state changed again after this action.")
        setAllProjectsPaused(db, change.before)
        effect = { type: 'pause', paused: change.before }
        break
      }
      case 'archive_project':
      case 'restore_project': {
        const project = db.getProject(targetId)
        const change = action.changes.find((item) => item.field === 'status')
        if (!project || !change) throw new Error('The target project no longer exists.')
        const current = project.archived ? 'archived' : 'active'
        if (current !== change.after || (change.before !== 'active' && change.before !== 'archived')) {
          throw new Error("Can't undo because the project status changed again after this action.")
        }
        const updated = db.archiveProject(targetId, change.before === 'archived')
        if (!updated) throw new Error('The target project no longer exists.')
        effect = { type: 'project', projectId: targetId, kind: updated.archived ? 'archived' : 'restored' }
        break
      }
      case 'update_project': {
        const project = db.getProject(targetId)
        if (!project) throw new Error('The target project no longer exists.')
        const keys = { brief: 'description', captain_agent: 'captain_agent_id', default_agent: 'default_agent_id' }
        assertStillAtAfter(project as unknown as Record<string, unknown>, action.changes, keys)
        if (!db.updateProject(targetId, beforeValues(action.changes, keys))) throw new Error('The target project no longer exists.')
        effect = { type: 'project', projectId: targetId, kind: 'updated' }
        break
      }
      case 'update_project_repo': {
        const repo = db.getProjectRepo(targetId)
        if (!repo) throw new Error('The target repository no longer exists.')
        assertStillAtAfter(repo as unknown as Record<string, unknown>, action.changes)
        if (!db.updateProjectRepo(targetId, beforeValues(action.changes))) throw new Error('The target repository no longer exists.')
        effect = { type: 'project', projectId: repo.project_id, kind: 'repos' }
        break
      }
      case 'update_project_resource': {
        const resource = db.getProjectResource(targetId)
        if (!resource) throw new Error('The target resource no longer exists.')
        assertStillAtAfter(resource as unknown as Record<string, unknown>, action.changes)
        if (!db.updateProjectResource(targetId, beforeValues(action.changes))) throw new Error('The target resource no longer exists.')
        effect = { type: 'project', projectId: resource.project_id, kind: 'resources' }
        break
      }
      case 'update_skill': {
        const skill = db.getSkill(targetId)
        if (!skill) throw new Error('The target skill no longer exists.')
        assertStillAtAfter(skill as unknown as Record<string, unknown>, action.changes)
        const restored = { ...beforeValues(action.changes), expected_version: skill.version } as UpdateSkillData
        if (!db.updateSkill(targetId, restored)) throw new Error('The target skill no longer exists.')
        effect = { type: 'skill', skillId: targetId, kind: 'updated' }
        break
      }
      default:
        throw new Error("This action can't be undone here.")
    }

    const note = options.store.appendMessage(sessionId, {
      role: 'user',
      content: describeUndo(action),
      correlationId: `${COMMANDER_UNDO_CORRELATION_PREFIX}${executionId}`
    })
    const consumed = options.store.markActionUndone(executionId, note.created_at, note.id)
    return { note, action: consumed, effect }
  })

  // Renderer broadcasts and queue work are external side effects: only after
  // SQLite committed the reversal, model note, and durable consumption marker.
  try {
    if (committed.effect?.type === 'project') {
      options.onProjectChanged?.(committed.effect.projectId, committed.effect.kind)
    } else if (committed.effect?.type === 'skill') {
      options.onSkillChanged?.(committed.effect.skillId, committed.effect.kind)
    } else if (committed.effect?.type === 'pause' && !committed.effect.paused) {
      options.agents?.recheckStartQueue()
    }
  } catch (error) {
    // The database is already authoritative. A failed refresh must not make
    // the caller retry an Undo that committed and is now durably consumed.
    console.error('[Commander] post-undo refresh failed:', error)
  }

  return {
    status: 'undone',
    executionId,
    toolName: initial.tool_name,
    note: committed.note,
    action: committed.action
  }
}

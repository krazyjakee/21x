import type { DatabaseManager } from '../database'
import type { UpdateSkillData } from '../database/types'
import {
  COMMANDER_UNDO_CORRELATION_PREFIX,
  isCommanderActionUndoable,
  parseCommanderActionResult,
  type CommanderActionChange,
  type CommanderActionResult
} from '../../shared/commander-tools'
import type { CommanderMessage } from '../../shared/commander'
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
  toolCallId: string
  toolName: string
  note: CommanderMessage
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
  return `The user used Undo for the previous action on ${action.target.kind} "${action.target.name}". Restored ${restored}. Treat the action as undone in later replies.`
}

/**
 * Reverses one stored, validated Commander mutation without starting a model
 * turn. Only exact reversals are allowed: if any affected field changed again,
 * the undo is refused instead of overwriting the newer edit.
 */
export function undoCommanderAction(
  options: CommanderUndoOptions,
  sessionId: string,
  toolCallId: string
): CommanderUndoResult {
  const messages = options.store.listMessages(sessionId)
  if (messages.some((message) => message.correlation_id === `${COMMANDER_UNDO_CORRELATION_PREFIX}${toolCallId}`)) {
    throw new Error('This action was already undone.')
  }
  const toolMessage = messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === toolCallId && !message.is_error
  )
  const call = messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.tool_calls ?? [])
    .find((candidate) => candidate.id === toolCallId)
  if (!toolMessage || !call || toolMessage.tool_name !== call.name) throw new Error('Action not found in this Commander session.')
  if (!isCommanderActionUndoable(call.name)) throw new Error("This action can't be undone here.")
  const action = parseCommanderActionResult(toolMessage.content)
  if (!action) throw new Error("This action can't be undone because its saved result is incomplete.")

  const { db } = options
  const targetId = action.target.id
  switch (call.name) {
    case 'pause_all_projects': {
      const change = action.changes.find((item) => item.field === 'paused')
      if (!change || typeof change.before !== 'boolean' || typeof change.after !== 'boolean' || !options.agents) {
        throw new Error("This action can't be undone here.")
      }
      if (options.agents.isAllProjectsPaused() !== change.after) throw new Error("Can't undo because the pause state changed again after this action.")
      options.agents.pauseAllProjects(change.before)
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
      options.onProjectChanged?.(targetId, updated.archived ? 'archived' : 'restored')
      break
    }
    case 'update_project': {
      const project = db.getProject(targetId)
      if (!project) throw new Error('The target project no longer exists.')
      const keys = { brief: 'description', captain_agent: 'captain_agent_id', default_agent: 'default_agent_id' }
      assertStillAtAfter(project as unknown as Record<string, unknown>, action.changes, keys)
      const updated = db.updateProject(targetId, beforeValues(action.changes, keys))
      if (!updated) throw new Error('The target project no longer exists.')
      options.onProjectChanged?.(targetId, 'updated')
      break
    }
    case 'update_project_repo': {
      const repo = db.getProjectRepo(targetId)
      if (!repo) throw new Error('The target repository no longer exists.')
      assertStillAtAfter(repo as unknown as Record<string, unknown>, action.changes)
      if (!db.updateProjectRepo(targetId, beforeValues(action.changes))) throw new Error('The target repository no longer exists.')
      options.onProjectChanged?.(repo.project_id, 'repos')
      break
    }
    case 'update_project_resource': {
      const resource = db.getProjectResource(targetId)
      if (!resource) throw new Error('The target resource no longer exists.')
      assertStillAtAfter(resource as unknown as Record<string, unknown>, action.changes)
      if (!db.updateProjectResource(targetId, beforeValues(action.changes))) throw new Error('The target resource no longer exists.')
      options.onProjectChanged?.(resource.project_id, 'resources')
      break
    }
    case 'update_skill': {
      const skill = db.getSkill(targetId)
      if (!skill) throw new Error('The target skill no longer exists.')
      assertStillAtAfter(skill as unknown as Record<string, unknown>, action.changes)
      const restored = { ...beforeValues(action.changes), expected_version: skill.version } as UpdateSkillData
      if (!db.updateSkill(targetId, restored)) throw new Error('The target skill no longer exists.')
      options.onSkillChanged?.(targetId, 'updated')
      break
    }
    default:
      throw new Error("This action can't be undone here.")
  }

  const note = options.store.appendMessage(sessionId, {
    role: 'user',
    content: describeUndo(action),
    correlationId: `${COMMANDER_UNDO_CORRELATION_PREFIX}${toolCallId}`
  })
  return { status: 'undone', toolCallId, toolName: call.name, note }
}

import type { DatabaseManager } from '../database'
import { randomUUID } from 'node:crypto'
import type { ChatToolResult } from '../chat/tools'
import { commanderActionSeverity, type CommanderActionTarget, type CommanderActionChange } from '../../shared/commander-action'

export type ActionFields = Record<string, unknown>
export function createActionRecorder(db: DatabaseManager, context: { sessionId: string; deliveryScope?: string; userMessageId?: string }) {
  return <T>(tool: string, toolCallId: string, target: CommanderActionTarget | ((value: T) => CommanderActionTarget),
    before: ActionFields, write: () => T, after: (value: T) => ActionFields): ChatToolResult =>
    actionMutation({ db, sessionId: context.sessionId, scope: context.deliveryScope ?? context.userMessageId,
      tool, toolCallId, target, before, write, after })
}
const REVERSIBLE = new Set(['archive_project', 'restore_project', 'pause_all_projects', 'update_project',
  'update_project_repo', 'update_project_resource', 'update_skill'])
const MAX_RESULT_CHARS = 12_000
function displayValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 240) return value.slice(0, 239) + '…'
  if (Array.isArray(value)) return [...value.slice(0, 10).map(displayValue),
    ...(value.length > 10 ? [`… (${value.length} items total)`] : [])]
  return value === undefined ? null : value
}

/** The write, its exact undo snapshot and the result commit together. */
export function actionMutation<T>(options: {
  db: DatabaseManager; sessionId: string; toolCallId: string; scope?: string; tool: string
  target: CommanderActionTarget | ((value: T) => CommanderActionTarget)
  before: ActionFields; write: () => T; after: (value: T) => ActionFields
}): ChatToolResult {
  const { db, tool, sessionId, toolCallId } = options
  const callKey = `${options.scope ?? randomUUID()}:${toolCallId}`
  return db.db.transaction(() => {
    const previous = db.db.prepare('SELECT result FROM commander_actions WHERE session_id = ? AND tool_call_id = ?')
      .get(sessionId, callKey) as { result: string } | undefined
    if (previous) return { content: previous.result }
    const value = options.write()
    const target = typeof options.target === 'function' ? options.target(value) : options.target
    const after = options.after(value)
    const fields = [...new Set([...Object.keys(options.before), ...Object.keys(after)])]
    const exact: CommanderActionChange[] = fields.filter(field => JSON.stringify(options.before[field] ?? null) !== JSON.stringify(after[field] ?? null))
      .map(field => ({ field, before: options.before[field] ?? null, after: after[field] ?? null }))
    const actionId = `${sessionId}:${callKey}`
    const undoId = REVERSIBLE.has(tool) && exact.length > 0 ? actionId : null
    const metadata = { status: 'ok', target, changes: exact.map(change => ({ field: change.field,
      before: displayValue(change.before), after: displayValue(change.after) })), severity: commanderActionSeverity(tool), undoId }
    let content = JSON.stringify({ ...metadata, result: value })
    if (content.length > MAX_RESULT_CHARS) content = JSON.stringify({ ...metadata,
      result: { truncated: true, message: 'Full values are saved with the action; the card shows excerpts.' } })
    if (content.length > MAX_RESULT_CHARS) throw new Error('Action metadata exceeded the result limit')
    db.db.prepare(`INSERT INTO commander_actions
      (id, session_id, tool_call_id, tool_name, target, changes, result, created_at, undone_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(actionId, sessionId, callKey,
      tool, JSON.stringify(target), JSON.stringify(exact), content, Date.now())
    return { content }
  })()
}

export function pickActionFields(value: unknown, fields: readonly string[]): ActionFields {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(fields.map(field => [field, (value as ActionFields)[field] ?? null]))
}
export const PROJECT_ACTION_FIELDS = ['name', 'description', 'captain_agent_id', 'default_agent_id', 'git_provider', 'git_org', 'archived'] as const
export const REPO_ACTION_FIELDS = ['name', 'provider', 'org', 'default_branch'] as const
export const RESOURCE_ACTION_FIELDS = ['label', 'url', 'notes'] as const
export const SKILL_ACTION_FIELDS = ['name', 'description', 'content', 'tags', 'preferred_model', 'project_id', 'is_deleted'] as const

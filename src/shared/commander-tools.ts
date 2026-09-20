/**
 * Which Commander tools change something (#82, #84).
 *
 * Shared so the renderer can tell an executed change ("action taken") from a
 * read or a delegation without a round trip. Main's tool registries re-export
 * these lists, and their tests prove each listed tool writes on the first call.
 */

/** Project tools that write. */
export const MUTATING_COMMANDER_TOOLS = [
  'pause_all_projects', 'create_project', 'update_project',
  'add_project_repo', 'update_project_repo', 'remove_project_repo', 'reorder_project_repos',
  'add_project_resource', 'update_project_resource', 'remove_project_resource', 'reorder_project_resources',
  'archive_project', 'restore_project'
] as const

/** Skill tools that write. */
export const MUTATING_COMMANDER_SKILL_TOOLS = ['create_skill', 'update_skill', 'remove_skill', 'promote_skill', 'move_skill'] as const

export type CommanderToolSeverity = 'neutral' | 'wide-reaching' | 'destructive'
type MutatingCommanderTool = (typeof MUTATING_COMMANDER_TOOLS)[number] | (typeof MUTATING_COMMANDER_SKILL_TOOLS)[number]

/** Visual/announcement severity for every mutating Commander tool (#86). */
export const COMMANDER_TOOL_SEVERITY = {
  pause_all_projects: 'wide-reaching',
  create_project: 'neutral',
  update_project: 'neutral',
  add_project_repo: 'neutral',
  update_project_repo: 'neutral',
  remove_project_repo: 'destructive',
  reorder_project_repos: 'neutral',
  add_project_resource: 'neutral',
  update_project_resource: 'neutral',
  remove_project_resource: 'destructive',
  reorder_project_resources: 'neutral',
  archive_project: 'destructive',
  restore_project: 'neutral',
  create_skill: 'neutral',
  update_skill: 'neutral',
  remove_skill: 'destructive',
  promote_skill: 'wide-reaching',
  move_skill: 'wide-reaching'
} as const satisfies Record<MutatingCommanderTool, CommanderToolSeverity>

export interface CommanderActionChange {
  field: string
  before: unknown
  after: unknown
}

export interface CommanderActionTarget {
  kind: 'all_projects' | 'project' | 'repo' | 'resource' | 'skill'
  id: string
  name: string
  /** Parent project for repository/resource targets, used by Open target. */
  project_id?: string
}

export interface CommanderActionResult {
  status: 'ok'
  result: unknown
  changes: CommanderActionChange[]
  target: CommanderActionTarget
}

export const COMMANDER_UNDO_CORRELATION_PREFIX = 'undo:'

export function commanderUndoCallId(correlationId: string | null | undefined): string | null {
  if (!correlationId?.startsWith(COMMANDER_UNDO_CORRELATION_PREFIX)) return null
  return correlationId.slice(COMMANDER_UNDO_CORRELATION_PREFIX.length) || null
}

/** Every Commander tool that changes something. */
export const COMMANDER_ADMIN_TOOLS: ReadonlySet<string> = new Set<string>([...MUTATING_COMMANDER_TOOLS, ...MUTATING_COMMANDER_SKILL_TOOLS])

/** True when a Commander tool call changes something (an "action taken"). */
export function isCommanderAdminTool(name: string): boolean {
  return COMMANDER_ADMIN_TOOLS.has(name)
}

export function commanderToolSeverity(name: string): CommanderToolSeverity {
  return isCommanderAdminTool(name) ? COMMANDER_TOOL_SEVERITY[name as MutatingCommanderTool] : 'neutral'
}

/** Exact reversals implemented by commander:undoAction. */
export function isCommanderActionUndoable(name: string): boolean {
  return name === 'archive_project' || name === 'restore_project' || name === 'pause_all_projects' ||
    name === 'update_project' || name === 'update_project_repo' || name === 'update_project_resource' || name === 'update_skill'
}

/** Parse only a complete, successful structured mutation result. */
export function parseCommanderActionResult(content: string | undefined): CommanderActionResult | null {
  if (!content?.trim().startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const target = record.target
  const changes = record.changes
  if (record.status !== 'ok' || !target || typeof target !== 'object' || Array.isArray(target) || !Array.isArray(changes)) return null
  const t = target as Record<string, unknown>
  if (!['all_projects', 'project', 'repo', 'resource', 'skill'].includes(String(t.kind)) ||
      typeof t.id !== 'string' || !t.id || typeof t.name !== 'string') return null
  if (t.project_id !== undefined && typeof t.project_id !== 'string') return null
  if (changes.length === 0 || changes.some((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return true
    const c = change as Record<string, unknown>
    return typeof c.field !== 'string' || !c.field || !Object.hasOwn(c, 'before') || !Object.hasOwn(c, 'after')
  })) return null
  return value as CommanderActionResult
}

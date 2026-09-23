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

/** Every Commander tool that changes something. */
export const COMMANDER_ADMIN_TOOLS: ReadonlySet<string> = new Set<string>([...MUTATING_COMMANDER_TOOLS, ...MUTATING_COMMANDER_SKILL_TOOLS])

/** True when a Commander tool call changes something (an "action taken"). */
export function isCommanderAdminTool(name: string): boolean {
  return COMMANDER_ADMIN_TOOLS.has(name)
}

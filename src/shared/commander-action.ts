import { isCommanderAdminTool, commanderActionSeverity, type CommanderActionSeverity } from './commander-tools'
export { commanderActionSeverity, type CommanderActionSeverity } from './commander-tools'

export interface CommanderActionTarget {
  kind: 'project' | 'repo' | 'resource' | 'skill' | 'all-projects'
  id: string
  name: string
  projectId?: string
  projectName?: string
}
export interface CommanderActionChange { field: string; before: unknown; after: unknown }
export interface CommanderAction {
  target: CommanderActionTarget
  changes: CommanderActionChange[]
  severity: CommanderActionSeverity
  undoId: string | null
}

/** Only validated execution payloads produce cards; speech and tool requests never do. */
export function parseCommanderAction(tool: string, content: string, isError: boolean): CommanderAction | null {
  if (isError || !isCommanderAdminTool(tool)) return null
  try {
    const value = JSON.parse(content)
    if (value?.status !== 'ok' || !value.target || typeof value.target.id !== 'string' || !value.target.id ||
      typeof value.target.name !== 'string' || !['project', 'repo', 'resource', 'skill', 'all-projects'].includes(value.target.kind) ||
      !Array.isArray(value.changes) || value.changes.length > 24 ||
      value.changes.some((change: unknown) => !change || typeof change !== 'object' ||
        typeof (change as CommanderActionChange).field !== 'string' ||
        !Object.hasOwn(change, 'before') || !Object.hasOwn(change, 'after'))) return null
    return { target: value.target, changes: value.changes, severity: commanderActionSeverity(tool),
      undoId: typeof value.undoId === 'string' ? value.undoId : null }
  } catch { return null }
}

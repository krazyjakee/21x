import type Database from 'better-sqlite3'
import { isAbsolute } from 'path'
import { createId } from '@paralleldrive/cuid2'
import { TaskStatus } from '../../shared/constants'
import { TASK_ROLE_CAPTAIN } from '../../shared/task-roles'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'

/** First-run and every-startup rows the app relies on existing. */

export function seedDefaultAgent(db: Database.Database): void {
  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }
  if (agentCount.count > 0) return
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO agents (id, name, server_url, config, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(createId(), 'Default Agent', 'http://localhost:4096', '{}', now, now)
}

/**
 * The Captain rows: one per project (#55). Each is a task row so its
 * session_id and transcript persist and resume like any task's; `role` keeps
 * it out of every task list, `project_id` says which project it coordinates.
 *
 * Idempotent: a project that already has a row keeps it (the Default
 * project's row predates per-project Captains and is kept as it is; a
 * row written before projects existed is adopted by the Default project).
 * Archived projects keep theirs too, so restoring a project restores its
 * conversation. `createProject` calls `ensureProjectCaptain` for new rows.
 */
export function seedCaptainTasks(db: Database.Database): void {
  db.prepare('UPDATE tasks SET project_id = ? WHERE role = ? AND project_id IS NULL')
    .run(DEFAULT_PROJECT_ID, TASK_ROLE_CAPTAIN)
  const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[]
  for (const project of projects) ensureProjectCaptain(db, project.id)
}

/** The project's Captain row id, creating the row when the project has none. */
export function ensureProjectCaptain(db: Database.Database, projectId: string): string {
  const existing = db.prepare(
    'SELECT id FROM tasks WHERE role = ? AND project_id = ? ORDER BY created_at ASC LIMIT 1'
  ).get(TASK_ROLE_CAPTAIN, projectId) as { id: string } | undefined
  if (existing) return existing.id
  const id = createId()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, title, description, type, priority, status, assignee, labels, source, role, project_id, created_at, updated_at)
    VALUES (?, ?, ?, 'general', 'medium', ?, '', '[]', 'local', ?, ?, ?, ?)
  `).run(id, 'Captain', 'The Captain conversation. Not a task: never listed, never scheduled.', TaskStatus.NotStarted, TASK_ROLE_CAPTAIN, projectId, now, now)
  return id
}

/** Append `id` to an array in the default agent's config unless already present. */
function addToDefaultAgent(db: Database.Database, key: 'skill_ids' | 'mcp_servers', id: string, now: string): void {
  const defaultAgent = db.prepare('SELECT id, config FROM agents WHERE is_default = 1')
    .get() as { id: string; config: string } | undefined
  if (!defaultAgent) return

  let config: Record<string, unknown>
  try {
    config = JSON.parse(defaultAgent.config) as Record<string, unknown>
  } catch {
    config = {}
  }

  // mcp_servers entries may be plain ids or AgentMcpServerEntry objects.
  const entries = (config[key] as Array<string | { serverId: string }>) || []
  if (entries.some((entry) => typeof entry === 'string' ? entry === id : entry.serverId === id)) return
  entries.push(id)
  config[key] = entries
  db.prepare('UPDATE agents SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(config), now, defaultAgent.id)
}

/** Explicit host runtime data, supplied after host readiness. No process discovery. */
export interface ManagedTaskMcpRuntime {
  command: string
  /** Only the shipping Electron adapter may keep its legacy literal `node` lookup. */
  allowLegacySystemNode?: true
  /** Legacy rows have no reliable app-owned marker. Service defaults to rejection. */
  existingServer?: { policy: 'verified-id'; id: string } | { policy: 'electron-name-refresh' }
  args: readonly string[]
  environment: Readonly<Record<string, string>>
  tools: readonly { name: string; description: string }[]
}

export class AmbiguousManagedMcpServerError extends Error {
  readonly code = 'AMBIGUOUS_MANAGED_MCP_SERVER'

  constructor() {
    super('Managed task MCP row requires explicit ownership verification')
    this.name = 'AmbiguousManagedMcpServerError'
  }
}

/** Validate trusted runtime configuration before touching SQLite. */
export function validateManagedTaskMcpRuntime(runtime: ManagedTaskMcpRuntime): void {
  const safeString = (value: unknown): value is string => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value)
  if (!runtime || !safeString(runtime.command) || !runtime.command.trim() ||
      (!isAbsolute(runtime.command) && !(runtime.allowLegacySystemNode === true && runtime.command === 'node')) ||
      !Array.isArray(runtime.args) || !runtime.args.every(safeString) ||
      !runtime.environment || typeof runtime.environment !== 'object' || Array.isArray(runtime.environment) ||
      !Object.entries(runtime.environment).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')) ||
      !Array.isArray(runtime.tools) || !runtime.tools.every((tool) => tool && safeString(tool.name) && !!tool.name && typeof tool.description === 'string') ||
      (runtime.existingServer !== undefined && runtime.existingServer.policy !== 'electron-name-refresh' &&
        !(runtime.existingServer.policy === 'verified-id' && safeString(runtime.existingServer.id) && !!runtime.existingServer.id))) {
    throw new Error('Invalid managed task MCP runtime')
  }
}

/** Create or refresh the built-in task-management MCP server row (path, command
 * and tools change between releases) and attach it to the default agent. */
export function seedTaskManagementMcpServer(db: Database.Database, runtime: ManagedTaskMcpRuntime): void {
  validateManagedTaskMcpRuntime(runtime)
  const now = new Date().toISOString()

  const matches = db.prepare('SELECT id FROM mcp_servers WHERE name = ?')
    .all('task-management') as { id: string }[]
  // Preserve the legacy wrapper's first-name-match behavior, without silently
  // treating arbitrary imported/user rows as managed in the service.
  const existingServer = matches[0]
  if (matches.length && runtime.existingServer?.policy !== 'electron-name-refresh' &&
      !(matches.length === 1 && runtime.existingServer?.policy === 'verified-id' && runtime.existingServer.id === existingServer.id)) {
    throw new AmbiguousManagedMcpServerError()
  }
  if (!matches.length && runtime.existingServer?.policy === 'verified-id') throw new AmbiguousManagedMcpServerError()
  const tools = JSON.stringify(runtime.tools)

  const mcpServerId = existingServer?.id ?? createId()
  if (!existingServer) {
    db.prepare(`
      INSERT INTO mcp_servers (id, name, type, command, args, environment, tools, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mcpServerId, 'task-management', 'local', runtime.command,
      JSON.stringify(runtime.args), JSON.stringify(runtime.environment), tools, now, now
    )
  } else {
    db.prepare(`
      UPDATE mcp_servers SET command = ?, args = ?, environment = ?, tools = ?, updated_at = ? WHERE id = ?
    `).run(
      runtime.command, JSON.stringify(runtime.args), JSON.stringify(runtime.environment), tools, now, mcpServerId
    )
  }

  addToDefaultAgent(db, 'mcp_servers', mcpServerId, now)
}

import type Database from 'better-sqlite3'
import { join } from 'path'
import { createId } from '@paralleldrive/cuid2'
import { FULL_ACCESS_SCOPE, listToolsForScope } from '../mcp-servers/task-management-core'
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

/** The full-access tool set the server actually serves, in the row's {name, description} shape. */
export function taskManagementToolRecords(): { name: string; description: string }[] {
  return listToolsForScope(FULL_ACCESS_SCOPE).map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
}

/** Create or refresh the built-in task-management MCP server row (path, command
 * and tools change between releases) and attach it to the default agent. */
export function seedTaskManagementMcpServer(db: Database.Database): void {
  const now = new Date().toISOString()

  // __dirname = out/main/. When packaged the script is unpacked via asarUnpack,
  // so point at app.asar.unpacked for the real filesystem path.
  let mcpServerPath = join(__dirname, 'mcp-servers', 'task-management-mcp.js')
  if (mcpServerPath.includes('app.asar')) {
    mcpServerPath = mcpServerPath.replace('app.asar', 'app.asar.unpacked')
  }

  // Direct stdio use needs standalone Node on macOS and Windows. Agent
  // sessions use the in-process HTTP endpoint instead.
  const useSystemNode = process.platform === 'win32' || process.platform === 'darwin'
  const mcpCommand = useSystemNode ? 'node' : process.execPath
  const mcpEnv = useSystemNode ? {} : { ELECTRON_RUN_AS_NODE: '1' }

  const existingServer = db.prepare('SELECT id FROM mcp_servers WHERE name = ?')
    .get('task-management') as { id: string } | undefined
  const tools = JSON.stringify(taskManagementToolRecords())

  const mcpServerId = existingServer?.id ?? createId()
  if (!existingServer) {
    db.prepare(`
      INSERT INTO mcp_servers (id, name, type, command, args, environment, tools, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mcpServerId, 'task-management', 'local', mcpCommand,
      JSON.stringify([mcpServerPath]), JSON.stringify(mcpEnv), tools, now, now
    )
  } else {
    db.prepare(`
      UPDATE mcp_servers SET command = ?, args = ?, environment = ?, tools = ?, updated_at = ? WHERE id = ?
    `).run(
      mcpCommand, JSON.stringify([mcpServerPath]), JSON.stringify(mcpEnv), tools, now, mcpServerId
    )
  }

  addToDefaultAgent(db, 'mcp_servers', mcpServerId, now)
}

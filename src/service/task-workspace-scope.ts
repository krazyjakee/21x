import type { DatabaseManager } from '../main/database/manager'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { ServiceProtocolError } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'

export const TASK_WORKSPACE_SCOPE_LIMITS = { members: 128 } as const
export interface TaskWorkspaceScopeOptions {
  database: DatabaseManager
  assertAvailable(): void
  canAccessTask(id: string, caller: DesktopCallerContext, access: 'read'): boolean
  canAccessProject(id: string, caller: DesktopCallerContext, access: 'read'): boolean
}
export interface TaskWorkspaceTaskBinding { id: string; project_id: string; role: string; group_id: string | null; repos: string; agent_id: string | null; session_id: string | null }
export interface TaskWorkspaceScope { task: TaskWorkspaceTaskBinding; tasks: TaskWorkspaceTaskBinding[]; project: { id: string; archived: number }; repositories: unknown[]; group: unknown; memberships: unknown[] }

/** One shared bounded SQL/grant policy for literal task workspaces. Neither
 * artifacts nor shell-file reads alias current members to execution anchors.
 * This helper performs no filesystem effects or unrelated JSON deserialization. */
export class TaskWorkspaceScopeReader {
  constructor(private readonly options: TaskWorkspaceScopeOptions) {}
  private task(id: string, caller: DesktopCallerContext): TaskWorkspaceTaskBinding {
    if (!this.options.canAccessTask(id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    const db = this.options.database.db
    // Only these scalar bindings and repos are needed. Avoid DatabaseManager's
    // unrelated attachment/output/settings JSON deserializers entirely.
    const oversized = db.prepare(`SELECT 1 FROM tasks WHERE id=? AND
      (length(CAST(id AS BLOB))>128 OR length(CAST(project_id AS BLOB))>128 OR length(CAST(role AS BLOB))>32 OR
       COALESCE(length(CAST(group_id AS BLOB)),0)>128 OR COALESCE(length(CAST(agent_id AS BLOB)),0)>128 OR
       COALESCE(length(CAST(session_id AS BLOB)),0)>512 OR length(CAST(repos AS BLOB))>65536) LIMIT 1`).get(id)
    if (oversized) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const row = db.prepare('SELECT id,project_id,role,group_id,repos,agent_id,session_id FROM tasks WHERE id=?').get(id) as TaskWorkspaceTaskBinding | undefined
    if (!row || !isDatabaseId(row.id) || !isDatabaseId(row.project_id) || !['task', 'captain', 'task_group'].includes(row.role) || row.group_id !== null && !isDatabaseId(row.group_id) || row.agent_id !== null && !isDatabaseId(row.agent_id) || row.session_id !== null && (typeof row.session_id !== 'string' || /[\u0000-\u001f\u007f]/.test(row.session_id)) || typeof row.repos !== 'string' || !this.options.canAccessProject(row.project_id, caller, 'read')) throw new ServiceProtocolError('INVALID_REQUEST')
    let repos: unknown
    try { repos = JSON.parse(row.repos) } catch { throw new ServiceProtocolError('INVALID_REQUEST') }
    if (!Array.isArray(repos) || repos.length > 128 || repos.some(repo => typeof repo !== 'string' || !repo || Buffer.byteLength(repo) > 512 || /[\u0000-\u001f\u007f]/.test(repo))) throw new ServiceProtocolError('INVALID_REQUEST')
    return row
  }
  capture(id: string, caller: DesktopCallerContext): TaskWorkspaceScope {
    this.options.assertAvailable()
    if (!this.options.database.db.open) throw new ServiceProtocolError('DISCONNECTED')
    if (!isDatabaseId(id)) throw new ServiceProtocolError('INVALID_REQUEST')
    if (!caller.webviewId || !caller.origin) throw new ServiceProtocolError('INVALID_REQUEST')
    const db = this.options.database.db, task = this.task(id, caller)
    const project = db.prepare("SELECT id,CASE WHEN typeof(archived)='integer' AND archived IN (0,1) THEN archived ELSE NULL END AS archived FROM projects WHERE id=?").get(task.project_id) as TaskWorkspaceScope['project'] | undefined
    if (!project || !isDatabaseId(project.id) || ![0, 1].includes(project.archived)) throw new ServiceProtocolError('INVALID_REQUEST')
    const repoStats = db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(MAX(length(CAST(id AS BLOB)),length(CAST(provider AS BLOB)),length(CAST(org AS BLOB)),length(CAST(name AS BLOB)),COALESCE(length(CAST(default_branch AS BLOB)),0))),0) AS bytes FROM project_repos WHERE project_id=?`).get(project.id) as { count: number; bytes: number }
    if (repoStats.count > 128 || repoStats.bytes > 512) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const repositories = db.prepare('SELECT id,project_id,provider,org,name,default_branch FROM project_repos WHERE project_id=? ORDER BY id').all(project.id)
    const groups = db.prepare(`SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
      CASE WHEN length(CAST(project_id AS BLOB))<=128 THEN project_id ELSE NULL END AS project_id,
      CASE WHEN length(CAST(execution_task_id AS BLOB))<=128 THEN execution_task_id ELSE NULL END AS execution_task_id,
      CASE WHEN length(CAST(state AS BLOB))<=32 THEN state ELSE NULL END AS state
      FROM task_groups WHERE execution_task_id=? OR id=? LIMIT 2`).all(task.id, task.group_id) as Array<{ id: string; project_id: string; execution_task_id: string; state: string }>
    if (groups.length > 1 || task.role === 'task_group' && !groups.length || task.group_id && !groups.length) throw new ServiceProtocolError('INVALID_REQUEST')
    const group = groups[0] ?? null, tasks = [task]
    let memberships: TaskWorkspaceScope['memberships'] = []
    if (group) {
      if (!isDatabaseId(group.id) || !isDatabaseId(group.execution_task_id) || group.project_id !== project.id || !['active', 'dissolved'].includes(group.state) || task.role === 'captain') throw new ServiceProtocolError('INVALID_REQUEST')
      const rows = db.prepare(`SELECT CASE WHEN length(CAST(task_id AS BLOB))<=128 THEN task_id ELSE NULL END AS task_id,
        CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
        CASE WHEN typeof(position)='integer' AND position>=0 AND position<=9007199254740991 THEN position ELSE NULL END AS position,
        CASE WHEN length(CAST(joined_at AS BLOB))<=32 THEN joined_at ELSE NULL END AS joined_at,
        CASE WHEN left_at IS NULL OR length(CAST(left_at AS BLOB))<=32 THEN left_at ELSE '' END AS left_at
        FROM task_group_memberships WHERE group_id=? ORDER BY position,joined_at,id LIMIT 129`).all(group.id) as Array<{ id: string; task_id: string; position: number; joined_at: string; left_at: string | null }>
      if (rows.length > TASK_WORKSPACE_SCOPE_LIMITS.members) throw new ServiceProtocolError('FRAME_TOO_LARGE')
      if (rows.some(row => !isDatabaseId(row.id) || !isDatabaseId(row.task_id) || !Number.isSafeInteger(row.position) || row.position < 0 || typeof row.joined_at !== 'string' || !row.joined_at || row.left_at !== null && (typeof row.left_at !== 'string' || !row.left_at))) throw new ServiceProtocolError('INVALID_REQUEST')
      if (task.id !== group.execution_task_id && !rows.some(row => row.task_id === task.id && row.left_at === null) || task.role === 'task_group' && task.id !== group.execution_task_id) throw new ServiceProtocolError('INVALID_REQUEST')
      const ids = new Set([group.execution_task_id, ...rows.filter(row => task.id === group.execution_task_id || row.left_at === null).map(row => row.task_id)])
      for (const member of ids) {
        const owned = this.task(member, caller)
        if (owned.project_id !== project.id || member === group.execution_task_id && owned.role !== 'task_group' || rows.some(row => row.task_id === member && row.left_at === null) && owned.group_id !== group.id) throw new ServiceProtocolError('INVALID_REQUEST')
        if (member !== task.id) tasks.push(owned)
      }
      memberships = rows
    }
    return { task, tasks, project, repositories, group, memberships }
  }
}

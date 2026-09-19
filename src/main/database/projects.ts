// A project groups tasks and task sources and has zero, one or many repos
// plus context-only resources. Projects are archived, never deleted: tasks
// reference them without a cascade.
import { createId } from '@paralleldrive/cuid2'
import type { DatabaseManager } from '../database'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import { ensureProjectCaptain } from './seed'
import { deserializeProject } from './serializers'
import type {
  CreateProjectData, ProjectRecord, ProjectRow, UpdateProjectData,
  CreateProjectRepoData, ProjectRepoRecord, UpdateProjectRepoData,
  CreateProjectResourceData, ProjectResourceRecord, UpdateProjectResourceData
} from './types'

/** Active projects in sidebar order; `includeArchived` adds the archived ones. */
export function getProjects(m: DatabaseManager, opts?: { includeArchived?: boolean }): ProjectRecord[] {
  if (!m.db?.open) return []
  const where = opts?.includeArchived ? '' : ' WHERE archived = 0'
  const rows = m.prepare(
    `SELECT * FROM projects${where} ORDER BY sort_order ASC, created_at ASC`
  ).all() as ProjectRow[]
  return rows.map(deserializeProject)
}

export function getProject(m: DatabaseManager, id: string): ProjectRecord | undefined {
  if (!m.db?.open) return undefined
  const row = m.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  return row ? deserializeProject(row) : undefined
}

/** The project unassigned tasks and sources belong to; created by schema migration 15. */
export function getDefaultProject(m: DatabaseManager): ProjectRecord | undefined {
  return getProject(m, DEFAULT_PROJECT_ID)
}

export function createProject(m: DatabaseManager, data: CreateProjectData): ProjectRecord | undefined {
  const name = data.name?.trim()
  if (!name) throw new Error('A project needs a name.')
  const id = createId()
  const now = new Date().toISOString()
  const { next } = m.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects').get() as { next: number }
  m.prepare(`
    INSERT INTO projects (id, name, description, default_agent_id, captain_agent_id, git_provider, git_org, settings, sort_order, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    name,
    data.description ?? '',
    data.default_agent_id ?? null,
    data.captain_agent_id ?? null,
    data.git_provider || null,
    data.git_org || null,
    JSON.stringify(data.settings ?? {}),
    next,
    now,
    now
  )
  // A project is born with its Captain (#55); the conversation is ready
  // before the user opens the drawer.
  ensureProjectCaptain(m.db, id)
  return getProject(m, id)
}

export function updateProject(m: DatabaseManager, id: string, data: UpdateProjectData): ProjectRecord | undefined {
  const setClauses: string[] = []
  const values: (string | null)[] = []
  if (data.name !== undefined) {
    const name = data.name.trim()
    if (!name) throw new Error('A project needs a name.')
    setClauses.push('name = ?'); values.push(name)
  }
  if (data.description !== undefined) { setClauses.push('description = ?'); values.push(data.description) }
  if (data.default_agent_id !== undefined) { setClauses.push('default_agent_id = ?'); values.push(data.default_agent_id || null) }
  if (data.captain_agent_id !== undefined) { setClauses.push('captain_agent_id = ?'); values.push(data.captain_agent_id || null) }
  if (data.git_provider !== undefined) { setClauses.push('git_provider = ?'); values.push(data.git_provider || null) }
  if (data.git_org !== undefined) { setClauses.push('git_org = ?'); values.push(data.git_org || null) }
  if (data.settings !== undefined) { setClauses.push('settings = ?'); values.push(JSON.stringify(data.settings ?? {})) }
  if (setClauses.length === 0) return getProject(m, id)

  setClauses.push('updated_at = ?')
  values.push(new Date().toISOString(), id)
  m.db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
  return getProject(m, id)
}

/**
 * Archive (or restore) a project. The Default project always stays active.
 * The project's Captain row is left alone either way: archiving keeps
 * the conversation (its row is hidden anyway), restoring finds it again.
 */
export function archiveProject(m: DatabaseManager, id: string, archived = true): ProjectRecord | undefined {
  if (archived && id === DEFAULT_PROJECT_ID) throw new Error('The Default project cannot be archived.')
  m.prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, new Date().toISOString(), id)
  if (!archived && getProject(m, id)) ensureProjectCaptain(m.db, id)
  return getProject(m, id)
}

/** Index in `orderedIds` becomes each project's sort_order. */
export function reorderProjects(m: DatabaseManager, orderedIds: string[]): void {
  reorderRows(m, 'projects', null, orderedIds)
}

export function getProjectRepos(m: DatabaseManager, projectId: string): ProjectRepoRecord[] {
  if (!m.db?.open) return []
  return m.prepare(
    'SELECT * FROM project_repos WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(projectId) as ProjectRepoRecord[]
}

export function getProjectRepo(m: DatabaseManager, id: string): ProjectRepoRecord | undefined {
  return m.prepare('SELECT * FROM project_repos WHERE id = ?').get(id) as ProjectRepoRecord | undefined
}

export function addProjectRepo(m: DatabaseManager, projectId: string, data: CreateProjectRepoData): ProjectRepoRecord | undefined {
  const name = data.name?.trim()
  if (!name) throw new Error('A repo needs a name.')
  const id = createId()
  const { next } = m.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_repos WHERE project_id = ?'
  ).get(projectId) as { next: number }
  m.prepare(`
    INSERT INTO project_repos (id, project_id, provider, org, name, default_branch, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, data.provider || 'github', data.org?.trim() ?? '', name, data.default_branch || null, next, new Date().toISOString())
  return getProjectRepo(m, id)
}

export function updateProjectRepo(m: DatabaseManager, id: string, data: UpdateProjectRepoData): ProjectRepoRecord | undefined {
  const setClauses: string[] = []
  const values: (string | null)[] = []
  if (data.name !== undefined) {
    const name = data.name.trim()
    if (!name) throw new Error('A repo needs a name.')
    setClauses.push('name = ?'); values.push(name)
  }
  if (data.provider !== undefined) { setClauses.push('provider = ?'); values.push(data.provider || 'github') }
  if (data.org !== undefined) { setClauses.push('org = ?'); values.push(data.org.trim()) }
  if (data.default_branch !== undefined) { setClauses.push('default_branch = ?'); values.push(data.default_branch || null) }
  if (setClauses.length > 0) {
    values.push(id)
    m.db.prepare(`UPDATE project_repos SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
  }
  return getProjectRepo(m, id)
}

export function removeProjectRepo(m: DatabaseManager, id: string): boolean {
  return m.prepare('DELETE FROM project_repos WHERE id = ?').run(id).changes > 0
}

export function reorderProjectRepos(m: DatabaseManager, projectId: string, orderedIds: string[]): void {
  reorderRows(m, 'project_repos', projectId, orderedIds)
}

export function getProjectResources(m: DatabaseManager, projectId: string): ProjectResourceRecord[] {
  if (!m.db?.open) return []
  return m.prepare(
    'SELECT * FROM project_resources WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(projectId) as ProjectResourceRecord[]
}

export function getProjectResource(m: DatabaseManager, id: string): ProjectResourceRecord | undefined {
  return m.prepare('SELECT * FROM project_resources WHERE id = ?').get(id) as ProjectResourceRecord | undefined
}

export function addProjectResource(m: DatabaseManager, projectId: string, data: CreateProjectResourceData): ProjectResourceRecord | undefined {
  const label = data.label?.trim()
  if (!label) throw new Error('A resource needs a label.')
  const id = createId()
  const { next } = m.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_resources WHERE project_id = ?'
  ).get(projectId) as { next: number }
  m.prepare(`
    INSERT INTO project_resources (id, project_id, label, url, notes, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, label, data.url?.trim() || null, data.notes ?? '', next, new Date().toISOString())
  return getProjectResource(m, id)
}

export function updateProjectResource(m: DatabaseManager, id: string, data: UpdateProjectResourceData): ProjectResourceRecord | undefined {
  const setClauses: string[] = []
  const values: (string | null)[] = []
  if (data.label !== undefined) {
    const label = data.label.trim()
    if (!label) throw new Error('A resource needs a label.')
    setClauses.push('label = ?'); values.push(label)
  }
  if (data.url !== undefined) { setClauses.push('url = ?'); values.push(data.url?.trim() || null) }
  if (data.notes !== undefined) { setClauses.push('notes = ?'); values.push(data.notes) }
  if (setClauses.length > 0) {
    values.push(id)
    m.db.prepare(`UPDATE project_resources SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
  }
  return getProjectResource(m, id)
}

export function removeProjectResource(m: DatabaseManager, id: string): boolean {
  return m.prepare('DELETE FROM project_resources WHERE id = ?').run(id).changes > 0
}

export function reorderProjectResources(m: DatabaseManager, projectId: string, orderedIds: string[]): void {
  reorderRows(m, 'project_resources', projectId, orderedIds)
}

/** Index in `orderedIds` becomes sort_order; ids outside `projectId` are ignored. */
function reorderRows(m: DatabaseManager, table: 'projects' | 'project_repos' | 'project_resources', projectId: string | null, orderedIds: string[]): void {
  if (!m.db?.open) return
  const stmt = projectId === null
    ? m.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
    : m.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND project_id = ?`)
  m.db.transaction(() => {
    orderedIds.forEach((id, index) => {
      if (projectId === null) stmt.run(index, id)
      else stmt.run(index, id, projectId)
    })
  })()
}

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applySchema, createTables, runMigrations } from './database/schema'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { DEFAULT_PROJECT_ID } from '../shared/projects'
import { TASK_ROLE_CAPTAIN } from '../shared/task-roles'

type Db = InstanceType<typeof Database>
const NOW = '2026-01-01T00:00:00.000Z'

/**
 * A database at schema 14: the current tables minus everything migration 15
 * adds. tasks / task_sources are created from the current definitions with the
 * project_id column removed (createTables() then leaves them alone), and the
 * project tables are dropped again.
 */
function openSchema14(): Db {
  const current = new Database(':memory:')
  applySchema(current)
  const withoutProject = (table: string): string => {
    const { sql } = current.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }
    const stripped = sql.replace(/\s*project_id TEXT REFERENCES projects\(id\),/, '')
    expect(stripped).not.toContain('project_id')
    return stripped
  }
  const tasksSql = withoutProject('tasks')
  const sourcesSql = withoutProject('task_sources')
  current.close()

  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(tasksSql)
  db.exec(sourcesSql)
  createTables(db)
  db.exec('DROP TABLE project_resources; DROP TABLE project_repos; DROP TABLE projects;')
  db.prepare("INSERT INTO settings (key, value) VALUES ('__schema_version', '14')").run()
  return db
}

function insertTask(db: Db, id: string, repos: string[] | string, role = 'task', createdAt = NOW): void {
  db.prepare('INSERT INTO tasks (id, title, repos, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, typeof repos === 'string' ? repos : JSON.stringify(repos), role, createdAt, createdAt)
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

function repos(db: Db): Array<{ provider: string; org: string; name: string; sort_order: number }> {
  return db.prepare('SELECT provider, org, name, sort_order FROM project_repos WHERE project_id = ? ORDER BY sort_order')
    .all(DEFAULT_PROJECT_ID) as Array<{ provider: string; org: string; name: string; sort_order: number }>
}

describe('projects migration (14 → 15)', () => {
  function migrated(): Db {
    const db = openSchema14()
    setSetting(db, 'github_org', 'acme')
    setSetting(db, 'git_provider', 'gitlab')
    setSetting(db, 'repo_providers', JSON.stringify({ 'other/lib': 'forgejo' }))
    insertTask(db, 't1', ['acme/api', 'widget'], 'task', '2026-01-01T00:00:00.000Z')
    insertTask(db, 't2', ['ACME/API', 'other/lib', 'acme/widget'], 'task', '2026-01-02T00:00:00.000Z')
    insertTask(db, 't3', [], 'task', '2026-01-03T00:00:00.000Z')
    insertTask(db, 't4', 'not json', 'task', '2026-01-04T00:00:00.000Z')
    insertTask(db, 'mm', [], TASK_ROLE_CAPTAIN, '2026-01-05T00:00:00.000Z')
    db.prepare("INSERT INTO task_sources (id, name, list_tool, plugin_id, created_at, updated_at) VALUES ('src-1', 'Linear', 'list', 'linear', ?, ?)")
      .run(NOW, NOW)
    expect(applySchema(db)).toBe(true)
    return db
  }

  it('creates the Default project with the global git settings', () => {
    const db = migrated()
    const project = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown>>
    expect(project).toHaveLength(1)
    expect(project[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, name: 'Default', git_org: 'acme', git_provider: 'gitlab', archived: 0, settings: '{}' })
    expect((db.prepare("SELECT value FROM settings WHERE key = '__schema_version'").get() as { value: string }).value).toBe('27')
    // The global settings stay where they were.
    expect((db.prepare("SELECT value FROM settings WHERE key = 'github_org'").get() as { value: string }).value).toBe('acme')
  })

  it('moves every task (coordinators included) and task source into it', () => {
    const db = migrated()
    expect(db.prepare('SELECT id, project_id FROM tasks ORDER BY id').all()).toEqual([
      { id: 'mm', project_id: DEFAULT_PROJECT_ID },
      { id: 't1', project_id: DEFAULT_PROJECT_ID },
      { id: 't2', project_id: DEFAULT_PROJECT_ID },
      { id: 't3', project_id: DEFAULT_PROJECT_ID },
      { id: 't4', project_id: DEFAULT_PROJECT_ID }
    ])
    expect(db.prepare('SELECT project_id FROM task_sources').all()).toEqual([{ project_id: DEFAULT_PROJECT_ID }])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_project'").get()).toBeTruthy()
  })

  it('seeds deduplicated repos from tasks.repos, resolving bare names with github_org', () => {
    const db = migrated()
    expect(repos(db)).toEqual([
      { provider: 'gitlab', org: 'acme', name: 'api', sort_order: 0 },
      { provider: 'gitlab', org: 'acme', name: 'widget', sort_order: 1 },
      { provider: 'forgejo', org: 'other', name: 'lib', sort_order: 2 }
    ])
  })

  it('does not reseed or undo edits when migrations run again', () => {
    const db = migrated()
    db.prepare("DELETE FROM project_repos WHERE name = 'lib'").run()
    db.prepare("UPDATE projects SET git_org = 'edited' WHERE id = ?").run(DEFAULT_PROJECT_ID)
    runMigrations(db)
    expect(repos(db).map((r) => r.name)).toEqual(['api', 'widget'])
    expect((db.prepare('SELECT git_org FROM projects WHERE id = ?').get(DEFAULT_PROJECT_ID) as { git_org: string }).git_org).toBe('edited')
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 })
  })

  it('leaves git settings empty and repos unseeded when none were configured', () => {
    const db = openSchema14()
    insertTask(db, 't1', ['bare'])
    applySchema(db)
    expect(db.prepare('SELECT git_org, git_provider FROM projects').get()).toEqual({ git_org: null, git_provider: null })
    expect(repos(db)).toEqual([{ provider: 'github', org: '', name: 'bare', sort_order: 0 }])
  })
})

describe('projects on a fresh database', () => {
  it('has the Default project and no repos or resources', () => {
    const { db } = createTestDb()
    expect(db.getDefaultProject()).toMatchObject({ id: DEFAULT_PROJECT_ID, name: 'Default', archived: false, settings: {} })
    expect(db.getProjects().map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
    expect(db.getProjectRepos(DEFAULT_PROJECT_ID)).toEqual([])
    expect(db.getProjectResources(DEFAULT_PROJECT_ID)).toEqual([])
  })
})

describe('project CRUD', () => {
  it('creates, updates, archives, restores and reorders projects', () => {
    const { db } = createTestDb()
    expect(() => db.createProject({ name: '  ' })).toThrow()
    const a = db.createProject({ name: ' Alpha ', description: 'brief', git_org: 'acme', settings: { x: 1 } })!
    const b = db.createProject({ name: 'Beta' })!
    expect(a).toMatchObject({ name: 'Alpha', description: 'brief', git_org: 'acme', git_provider: null, settings: { x: 1 }, archived: false, sort_order: 1 })
    expect(b.sort_order).toBe(2)

    const updated = db.updateProject(a.id, { name: 'Alpha 2', git_org: '', default_agent_id: null, settings: { y: 2 } })!
    expect(updated).toMatchObject({ name: 'Alpha 2', git_org: null, settings: { y: 2 }, description: 'brief' })
    expect(() => db.updateProject(a.id, { name: '' })).toThrow()

    expect(db.archiveProject(a.id)!.archived).toBe(true)
    expect(db.getProjects().map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, b.id])
    expect(db.getProjects({ includeArchived: true }).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, a.id, b.id])
    expect(db.archiveProject(a.id, false)!.archived).toBe(false)
    expect(() => db.archiveProject(DEFAULT_PROJECT_ID)).toThrow()

    db.reorderProjects([b.id, a.id, DEFAULT_PROJECT_ID])
    expect(db.getProjects().map((p) => p.id)).toEqual([b.id, a.id, DEFAULT_PROJECT_ID])
  })

  it('adds, updates, reorders and removes repos and resources', () => {
    const { db, rawDb } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    const r1 = db.addProjectRepo(p.id, { name: 'api', org: 'acme' })!
    const r2 = db.addProjectRepo(p.id, { name: 'web', provider: 'gitlab', default_branch: 'develop' })!
    expect(r1).toMatchObject({ project_id: p.id, provider: 'github', org: 'acme', name: 'api', default_branch: null, sort_order: 0 })
    expect(r2).toMatchObject({ provider: 'gitlab', org: '', default_branch: 'develop', sort_order: 1 })
    expect(db.updateProjectRepo(r2.id, { org: 'grp/sub', default_branch: '' })).toMatchObject({ org: 'grp/sub', default_branch: null })
    db.reorderProjectRepos(p.id, [r2.id, r1.id])
    expect(db.getProjectRepos(p.id).map((r) => r.id)).toEqual([r2.id, r1.id])
    // Ids from another project are ignored.
    db.reorderProjectRepos(DEFAULT_PROJECT_ID, [r1.id, r2.id])
    expect(db.getProjectRepos(p.id).map((r) => r.id)).toEqual([r2.id, r1.id])
    expect(db.removeProjectRepo(r2.id)).toBe(true)
    expect(db.getProjectRepos(p.id).map((r) => r.id)).toEqual([r1.id])

    const s1 = db.addProjectResource(p.id, { label: 'Drive', url: ' https://drive.example ' })!
    const s2 = db.addProjectResource(p.id, { label: 'Runbook', notes: 'ask ops' })!
    expect(s1).toMatchObject({ label: 'Drive', url: 'https://drive.example', notes: '', sort_order: 0 })
    expect(s2).toMatchObject({ url: null, notes: 'ask ops', sort_order: 1 })
    expect(() => db.addProjectResource(p.id, { label: '' })).toThrow()
    expect(db.updateProjectResource(s1.id, { url: null, notes: 'n' })).toMatchObject({ url: null, notes: 'n', label: 'Drive' })
    db.reorderProjectResources(p.id, [s2.id, s1.id])
    expect(db.getProjectResources(p.id).map((r) => r.id)).toEqual([s2.id, s1.id])
    expect(db.removeProjectResource(s1.id)).toBe(true)
    expect(db.getProjectResources(p.id).map((r) => r.id)).toEqual([s2.id])

    // Repos and resources go with their project. Projects are archived, not
    // deleted, in the app; a raw delete first has to remove the project's own
    // Captain row (#55), which references it.
    rawDb.prepare('DELETE FROM tasks WHERE project_id = ?').run(p.id)
    rawDb.prepare('DELETE FROM projects WHERE id = ?').run(p.id)
    expect(db.getProjectRepos(p.id)).toEqual([])
    expect(db.getProjectResources(p.id)).toEqual([])
  })
})

describe('tasks always belong to a project', () => {
  it('defaults to the Default project, honours an explicit one and a source\'s project', () => {
    const { db } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    expect(db.createTask({ title: 'plain' })!.project_id).toBe(DEFAULT_PROJECT_ID)
    expect(db.createTask({ title: 'in P', project_id: p.id })!.project_id).toBe(p.id)

    const source = db.createTaskSource({ mcp_server_id: null, name: 'S', plugin_id: 'linear', project_id: p.id })!
    expect(source.project_id).toBe(p.id)
    expect(db.createTaskSource({ mcp_server_id: null, name: 'S2', plugin_id: 'linear' })!.project_id).toBe(DEFAULT_PROJECT_ID)
    expect(db.getTaskSources(p.id).map((s) => s.id)).toEqual([source.id])
    expect(db.createTask({ title: 'imported', source_id: source.id })!.project_id).toBe(p.id)
  })

  it('gives subtasks their parent\'s project, whatever was requested', () => {
    const { db, rawDb } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    const parent = db.createTask({ title: 'parent', project_id: p.id })!
    expect(db.createTask({ title: 'child', parent_task_id: parent.id, project_id: DEFAULT_PROJECT_ID })!.project_id).toBe(p.id)

    // Moving a task under a parent moves it into the parent's project.
    const loose = db.createTask({ title: 'loose' })!
    expect(db.updateTask(loose.id, { parent_task_id: parent.id })!.project_id).toBe(p.id)

    // Raw inserts (the recurrence scheduler) get the same rule from the trigger.
    rawDb.prepare('INSERT INTO tasks (id, title, recurrence_parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('instance', 'instance', parent.id, NOW, NOW)
    rawDb.prepare('INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('raw', 'raw', NOW, NOW)
    expect(db.getTask('instance')!.project_id).toBe(p.id)
    expect(db.getTask('raw')!.project_id).toBe(DEFAULT_PROJECT_ID)
  })

  it('getTasks lists every project by default and narrows with projectId', () => {
    const { db } = createTestDb()
    const p = db.createProject({ name: 'P' })!
    const a = db.createTask({ title: 'a' })!
    const b = db.createTask({ title: 'b', project_id: p.id })!
    const mm = db.createTask({ title: 'Captain', role: TASK_ROLE_CAPTAIN })!

    expect(db.getTasks().map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    expect(db.getTasks({ projectId: p.id }).map((t) => t.id)).toEqual([b.id])
    expect(db.getTasks({ projectId: DEFAULT_PROJECT_ID }).map((t) => t.id)).toEqual([a.id])
    expect(db.getTasks({ includeCoordinators: true, projectId: DEFAULT_PROJECT_ID }).map((t) => t.id).sort()).toEqual([a.id, mm.id].sort())
  })
})

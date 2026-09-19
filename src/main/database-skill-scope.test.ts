import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { DatabaseManager, SkillVersionConflictError } from './database'
import { createTestDb } from '../../test/helpers/db-test-helper'

/** Skill scope (#74): the 15 → 16 migration and the scope-aware CRUD. */
describe('skills.project_id migration (15 → 16)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '21x-skill-scope-migration-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds the column, keeps every existing skill global and intact, and is idempotent', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    // Roll back to schema 15: no project_id column, one existing skill.
    const raw = new RawDatabase(join(dir, '21x.db'))
    raw.exec('DROP INDEX IF EXISTS idx_skills_project')
    raw.exec('ALTER TABLE skills DROP COLUMN project_id')
    raw.prepare(`
      INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, preferred_model, is_deleted, created_at, updated_at)
      VALUES ('old-1', 'legacy-skill', 'Old skill', '# Body', 4, 0.8, 7, '2026-01-02T00:00:00Z', '["a","b"]', 'x/y', 0, '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z')
    `).run()
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('15')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    const skill = second.getSkill('old-1')
    const visibleEverywhere = second.getSkills({ visibleToProject: 'some-other-project' }).map((s) => s.id)
    const indexes = (second.db.pragma('index_list(skills)') as Array<{ name: string }>).map((i) => i.name)
    second.close?.()

    expect(skill).toMatchObject({
      id: 'old-1',
      name: 'legacy-skill',
      description: 'Old skill',
      content: '# Body',
      version: 4,
      confidence: 0.8,
      uses: 7,
      last_used: '2026-01-02T00:00:00Z',
      tags: ['a', 'b'],
      preferred_model: 'x/y',
      project_id: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-06-01T00:00:00Z'
    })
    expect(visibleEverywhere).toContain('old-1')
    expect(indexes).toContain('idx_skills_project')

    // A later schema bump re-runs runMigrations: nothing changes.
    const third = new DatabaseManager()
    third.initialize()
    expect(third.getSkill('old-1')?.project_id).toBeNull()
    third.close?.()
  })
})

describe('skill scope CRUD', () => {
  it('creates global by default, or in a project, and lists per scope', () => {
    const { db } = createTestDb()
    const a = db.createProject({ name: 'A' })!
    const b = db.createProject({ name: 'B' })!
    const global = db.createSkill({ name: 'pr-review', description: 'd', content: 'c' })!
    const ofA = db.createSkill({ name: 'a-release', description: 'd', content: 'c', project_id: a.id })!
    const ofB = db.createSkill({ name: 'b-release', description: 'd', content: 'c', project_id: b.id })!

    expect(global.project_id).toBeNull()
    expect(ofA.project_id).toBe(a.id)
    expect(db.getSkills().map((s) => s.id).sort()).toEqual([global.id, ofA.id, ofB.id].sort())
    expect(db.getSkills({ visibleToProject: a.id }).map((s) => s.name)).toEqual(['a-release', 'pr-review'])
    expect(db.getSkills({ visibleToProject: b.id }).map((s) => s.name)).toEqual(['b-release', 'pr-review'])
    expect(db.getSkills({ scope: null }).map((s) => s.name)).toEqual(['pr-review'])
    expect(db.getSkills({ scope: a.id }).map((s) => s.name)).toEqual(['a-release'])
    expect(db.getSkillsByIds([global.id, ofA.id, ofB.id], a.id).map((s) => s.name)).toEqual(['a-release', 'pr-review'])
  })

  it('changes scope only through setSkillProject, which bumps the version', () => {
    const { db } = createTestDb()
    const a = db.createProject({ name: 'A' })!
    const skill = db.createSkill({ name: 'local', description: 'd', content: 'c', project_id: a.id })!

    // A field update never touches the scope, even when a caller smuggles project_id in.
    const updated = db.updateSkill(skill.id, { content: 'c2', ...({ project_id: null } as object) })!
    expect(updated.project_id).toBe(a.id)

    const promoted = db.setSkillProject(skill.id, null)!
    expect(promoted.project_id).toBeNull()
    expect(promoted.version).toBe(updated.version + 1)
    expect(db.setSkillProject(skill.id, null)!.version).toBe(promoted.version)
    expect(db.setSkillProject(skill.id, a.id)!.project_id).toBe(a.id)
    expect(db.setSkillProject('missing', null)).toBeUndefined()
  })

  it('refuses a stale content write and reports the current version', () => {
    const { db } = createTestDb()
    const skill = db.createSkill({ name: 'shared', description: 'd', content: 'v1' })!
    const editorA = db.getSkill(skill.id)!
    const editorB = db.getSkill(skill.id)!

    expect(db.updateSkill(skill.id, { content: 'from A', expected_version: editorA.version })!.version).toBe(2)
    let conflict: unknown
    try {
      db.updateSkill(skill.id, { content: 'from B', expected_version: editorB.version })
    } catch (error) {
      conflict = error
    }
    expect(conflict).toBeInstanceOf(SkillVersionConflictError)
    expect((conflict as SkillVersionConflictError).currentVersion).toBe(2)
    expect(db.getSkill(skill.id)!.content).toBe('from A')

    // Usage updates are never version-checked; a matching version passes.
    expect(db.updateSkill(skill.id, { uses: 3, expected_version: 1 })!.uses).toBe(3)
    expect(db.updateSkill(skill.id, { content: 'v3', expected_version: 2 })!.version).toBe(3)
  })

  it('finds the tasks that use a skill, in any project', () => {
    const { db } = createTestDb()
    const a = db.createProject({ name: 'A' })!
    const skill = db.createSkill({ name: 'used', description: 'd', content: 'c' })!
    const other = db.createSkill({ name: 'unused', description: 'd', content: 'c' })!
    const inA = db.createTask({ title: 'in A', project_id: a.id })!
    const inDefault = db.createTask({ title: 'in default' })!
    db.updateTask(inA.id, { skill_ids: [skill.id] })
    db.updateTask(inDefault.id, { skill_ids: [other.id, skill.id] })
    db.updateTask(db.createTask({ title: 'none' })!.id, { skill_ids: [other.id] })

    const users = db.getTasksUsingSkill(skill.id)
    expect(users.map((t) => t.id).sort()).toEqual([inA.id, inDefault.id].sort())
    expect(users.find((t) => t.id === inA.id)?.project_id).toBe(a.id)
    expect(db.getTasksUsingSkill(other.id)).toHaveLength(2)
  })

  it('soft-deletes without touching the scope of the rest', () => {
    const { db } = createTestDb()
    const a = db.createProject({ name: 'A' })!
    const ofA = db.createSkill({ name: 'a-only', description: 'd', content: 'c', project_id: a.id })!
    db.createSkill({ name: 'kept', description: 'd', content: 'c', project_id: a.id })
    expect(db.deleteSkill(ofA.id)).toBe(true)
    expect(db.getSkills({ scope: a.id }).map((s) => s.name)).toEqual(['kept'])
    expect(db.getSkill(ofA.id)).toBeUndefined()
  })
})

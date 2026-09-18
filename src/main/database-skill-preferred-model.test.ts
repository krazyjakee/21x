import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import RawDatabase from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { DatabaseManager } from './database'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { writeSkillFiles } from './agent-manager/workspace-docs'
import { parseSkillMd, syncSkillsFromDirectory } from './agent-manager/skills-sync'

describe('skills.preferred_model migration (13 → 14)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), '20x-skill-model-migration-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds the column and keeps every existing skill field', () => {
    const first = new DatabaseManager()
    first.initialize()
    first.close?.()

    // Roll back to schema 13: no preferred_model column, one existing skill.
    const raw = new RawDatabase(join(dir, '21x.db'))
    raw.exec('ALTER TABLE skills DROP COLUMN preferred_model')
    raw.prepare(`
      INSERT INTO skills (id, name, description, content, version, confidence, uses, last_used, tags, is_deleted, created_at, updated_at)
      VALUES ('old-1', 'legacy-skill', 'Old skill', '# Body', 4, 0.8, 7, '2026-01-02T00:00:00Z', '["a","b"]', 0, '2025-01-01T00:00:00Z', '2025-06-01T00:00:00Z')
    `).run()
    raw.prepare("UPDATE settings SET value = ? WHERE key = '__schema_version'").run('13')
    raw.close()

    const second = new DatabaseManager()
    second.initialize()
    const skill = second.getSkill('old-1')
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
      preferred_model: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-06-01T00:00:00Z'
    })
  })
})

describe('skill preferred_model CRUD', () => {
  it('sets, changes and clears the preferred model', () => {
    const { db } = createTestDb()
    const created = db.createSkill({ name: 'fast-fix', description: 'd', content: 'c', preferred_model: ' anthropic/claude-haiku-4-5 ' })!
    expect(created.preferred_model).toBe('anthropic/claude-haiku-4-5')

    const changed = db.updateSkill(created.id, { preferred_model: 'openai/gpt-5.5' })!
    expect(changed.preferred_model).toBe('openai/gpt-5.5')
    expect(changed.version).toBe(created.version + 1)

    expect(db.updateSkill(created.id, { content: 'new' })!.preferred_model).toBe('openai/gpt-5.5')
    expect(db.updateSkill(created.id, { preferred_model: null })!.preferred_model).toBeNull()
    db.updateSkill(created.id, { preferred_model: 'x/y' })
    expect(db.updateSkill(created.id, { preferred_model: '' })!.preferred_model).toBeNull()
  })

  it('defaults to no preference', () => {
    const { db } = createTestDb()
    expect(db.createSkill({ name: 'plain', description: 'd', content: 'c' })!.preferred_model).toBeNull()
  })
})

describe('skill preferred_model in SKILL.md', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), '20x-skill-model-ws-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('round-trips through writeSkillFiles and syncSkillsFromDirectory', async () => {
    const { db } = createTestDb()
    const skill = db.createSkill({ name: 'reviewer', description: 'Reviews: code', content: '# Review', preferred_model: 'anthropic/claude-opus-5' })!
    const agent = db.createAgent({ name: 'oc', config: { coding_agent: 'opencode', skill_ids: [skill.id] } })!
    const task = db.createTask({ title: 't' })!

    await writeSkillFiles(db, task.id, agent.id, workspace)
    const file = readFileSync(join(workspace, '.agents', 'skills', 'reviewer', 'SKILL.md'), 'utf-8')
    expect(file).toContain('preferred_model: "anthropic/claude-opus-5"')
    expect(parseSkillMd(file)).toMatchObject({ name: 'reviewer', description: 'Reviews: code', preferred_model: 'anthropic/claude-opus-5' })

    // Unchanged file: nothing to update.
    expect(syncSkillsFromDirectory(db, workspace).unchanged).toContain('reviewer')

    // The agent changed the preference in the file: the DB follows.
    writeFileSync(join(workspace, '.agents', 'skills', 'reviewer', 'SKILL.md'), file.replace('anthropic/claude-opus-5', 'openai/gpt-5.5'))
    expect(syncSkillsFromDirectory(db, workspace).updated).toContain('reviewer')
    expect(db.getSkill(skill.id)!.preferred_model).toBe('openai/gpt-5.5')
  })

  it('leaves the preference alone when a file has no preferred_model line, and creates new skills without one', () => {
    const { db } = createTestDb()
    const skill = db.createSkill({ name: 'keeper', description: 'd', content: 'old', preferred_model: 'a/b' })!
    const dirPath = join(workspace, '.agents', 'skills')
    mkdirSync(join(dirPath, 'keeper'), { recursive: true })
    writeFileSync(join(dirPath, 'keeper', 'SKILL.md'), '---\nname: keeper\ndescription: d\n---\n\nnew')
    writeFileSync(join(dirPath, 'fresh.md'), '# no frontmatter')

    syncSkillsFromDirectory(db, workspace)
    expect(db.getSkill(skill.id)!).toMatchObject({ content: 'new', preferred_model: 'a/b' })
    expect(db.getSkillByName('fresh')!.preferred_model).toBeNull()
  })

  it('clears the preference when the file sets it empty', () => {
    const parsed = parseSkillMd('---\nname: x\ndescription: d\npreferred_model: ""\n---\n\nbody')
    expect(parsed?.preferred_model).toBeNull()
  })
})

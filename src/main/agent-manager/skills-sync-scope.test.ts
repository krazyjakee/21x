import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { syncSkillsFromDirectory } from './skills-sync'

/** The learning loop's ownership rules (#74). */
describe('syncSkillsFromDirectory scope', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), '21x-skill-sync-scope-'))
    mkdirSync(join(workspace, '.agents', 'skills'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  const write = (name: string, body: string): void => {
    mkdirSync(join(workspace, '.agents', 'skills', name), { recursive: true })
    writeFileSync(join(workspace, '.agents', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}`)
  }

  it('creates a learned skill in the task\'s project', () => {
    const { db } = createTestDb()
    const project = db.createProject({ name: 'Alpha' })!
    write('learned-here', 'lesson')

    const result = syncSkillsFromDirectory(db, workspace, { projectId: project.id })
    expect(result.created).toEqual(['learned-here'])
    expect(db.getSkillByName('learned-here')).toMatchObject({ project_id: project.id, content: 'lesson' })
  })

  it('updates the project\'s own skill but never a global or another project\'s', () => {
    const { db } = createTestDb()
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const own = db.createSkill({ name: 'own', description: 'd', content: 'old', project_id: alpha.id })!
    const global = db.createSkill({ name: 'shared', description: 'd', content: 'old', project_id: null })!
    const foreign = db.createSkill({ name: 'theirs', description: 'd', content: 'old', project_id: beta.id })!
    write('own', 'new')
    write('shared', 'new')
    write('theirs', 'new')

    const result = syncSkillsFromDirectory(db, workspace, { projectId: alpha.id })
    expect(result.updated).toEqual(['own'])
    expect([...(result.skipped ?? [])].sort()).toEqual(['shared', 'theirs'])
    expect(db.getSkill(own.id)!.content).toBe('new')
    expect(db.getSkill(global.id)!).toMatchObject({ content: 'old', version: 1 })
    expect(db.getSkill(foreign.id)!).toMatchObject({ content: 'old', version: 1 })
  })

  it('without a project (internal callers) keeps the old behaviour: global creates, any update', () => {
    const { db } = createTestDb()
    const global = db.createSkill({ name: 'shared', description: 'd', content: 'old' })!
    write('shared', 'new')
    write('fresh', 'body')

    const result = syncSkillsFromDirectory(db, workspace)
    expect(result).toMatchObject({ created: ['fresh'], updated: ['shared'], skipped: [] })
    expect(db.getSkill(global.id)!.content).toBe('new')
    expect(db.getSkillByName('fresh')!.project_id).toBeNull()
  })
})

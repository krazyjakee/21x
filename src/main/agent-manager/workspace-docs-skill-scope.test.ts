import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { writeSkillFiles } from './workspace-docs'

/** Only skills the task's project may see reach its workspace (#74). */
describe('writeSkillFiles scope', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), '21x-skill-files-scope-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('writes global and own-project skills, and drops another project\'s even when selected', async () => {
    const { db } = createTestDb()
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const global = db.createSkill({ name: 'pr-review', description: 'd', content: 'global body' })!
    const own = db.createSkill({ name: 'alpha-release', description: 'd', content: 'own body', project_id: alpha.id })!
    const foreign = db.createSkill({ name: 'beta-release', description: 'd', content: 'foreign body', project_id: beta.id })!
    // An agent default that is a project skill of Beta, reused by an Alpha task.
    const agent = db.createAgent({ name: 'oc', config: { coding_agent: 'opencode', skill_ids: [foreign.id, global.id] } })!
    const task = db.createTask({ title: 't', project_id: alpha.id })!
    db.updateTask(task.id, { skill_ids: [own.id, foreign.id] })

    await writeSkillFiles(db, task.id, agent.id, workspace)

    const dir = join(workspace, '.agents', 'skills')
    expect(readFileSync(join(dir, 'pr-review', 'SKILL.md'), 'utf-8')).toContain('global body')
    expect(readFileSync(join(dir, 'alpha-release', 'SKILL.md'), 'utf-8')).toContain('own body')
    expect(existsSync(join(dir, 'beta-release'))).toBe(false)
    const agentsMd = readFileSync(join(workspace, 'AGENTS.md'), 'utf-8')
    expect(agentsMd).toContain('alpha-release')
    expect(agentsMd).not.toContain('beta-release')
  })
})

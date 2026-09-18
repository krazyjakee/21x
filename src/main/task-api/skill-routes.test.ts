import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager, SkillRecord } from '../database'
import { handleRoute } from '../task-api-server'
import { SKILL_SCOPE_PARAM, validateSkillAssignment } from './skill-routes'

/**
 * Skill scope in the session-facing routes (#74): what a project scope sees,
 * who owns what it creates, and which writes are refused.
 */
let db: DatabaseManager
let projectA: string
let projectB: string
let globalSkill: SkillRecord
let skillA: SkillRecord
let skillB: SkillRecord

const asMastermind = (projectId: string): Record<string, unknown> => ({ [SKILL_SCOPE_PARAM]: { project_id: projectId, role: 'coordinator' } })
const asTaskAgent = (projectId: string): Record<string, unknown> => ({ [SKILL_SCOPE_PARAM]: { project_id: projectId, role: 'task' } })

async function route(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await handleRoute(db, name, params) as Record<string, unknown>
}

beforeEach(() => {
  ;({ db } = createTestDb())
  projectA = db.createProject({ name: 'Alpha' })!.id
  projectB = db.createProject({ name: 'Beta' })!.id
  globalSkill = db.createSkill({ name: 'pr-review', description: 'Reviews PRs', content: '# Review' })!
  skillA = db.createSkill({ name: 'alpha-release', description: 'Alpha release', content: '# A', project_id: projectA })!
  skillB = db.createSkill({ name: 'beta-release', description: 'Beta release', content: '# B', project_id: projectB })!
})

describe('visibility per scope', () => {
  it('a project scope lists global skills plus its own, with the scope spelled out', async () => {
    const listed = await handleRoute(db, '/list_skills', asMastermind(projectA)) as Array<Record<string, unknown>>
    expect(listed.map((s) => s.name).sort()).toEqual(['alpha-release', 'pr-review'])
    expect(listed.find((s) => s.name === 'pr-review')).toMatchObject({ scope: 'global', project_id: null, project_name: null })
    expect(listed.find((s) => s.name === 'alpha-release')).toMatchObject({ scope: 'project', project_id: projectA, project_name: 'Alpha' })
    expect(listed[0]).not.toHaveProperty('content')

    const asAgent = await handleRoute(db, '/list_skills', asTaskAgent(projectB)) as Array<Record<string, unknown>>
    expect(asAgent.map((s) => s.name).sort()).toEqual(['beta-release', 'pr-review'])
  })

  it('an unscoped caller sees everything and may filter by scope', async () => {
    const all = await handleRoute(db, '/list_skills', {}) as Array<Record<string, unknown>>
    expect(all).toHaveLength(3)
    expect((await handleRoute(db, '/list_skills', { scope: 'global' }) as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['pr-review'])
    expect((await handleRoute(db, '/list_skills', { project_id: projectB }) as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['beta-release'])
  })

  it('get_skill refuses another project\'s skill and a missing id the same way, even by id', async () => {
    expect(await route('/get_skill', { skill_id: skillA.id, ...asMastermind(projectA) })).toMatchObject({ name: 'alpha-release', content: '# A' })
    expect(await route('/get_skill', { skill_id: globalSkill.id, ...asTaskAgent(projectA) })).toMatchObject({ name: 'pr-review' })
    const foreign = await route('/get_skill', { skill_id: skillB.id, ...asMastermind(projectA) })
    const missing = await route('/get_skill', { skill_id: 'no-such-skill', ...asMastermind(projectA) })
    expect(foreign.error).toContain('Access denied')
    expect(missing).toEqual(foreign)
    expect(await route('/get_skill', { skill_id: skillB.id })).toMatchObject({ name: 'beta-release' })
  })
})

describe('default ownership per creator', () => {
  it('a Mastermind-created skill belongs to its project', async () => {
    const created = await route('/create_skill', { name: 'alpha-conventions', description: 'd', content: 'c', ...asMastermind(projectA) })
    expect(created.success).toBe(true)
    expect(created.skill).toMatchObject({ project_id: projectA, scope: 'project' })
    expect(db.getSkills({ visibleToProject: projectB }).map((s) => s.name)).not.toContain('alpha-conventions')
  })

  it('a task-agent-created skill belongs to the task\'s project', async () => {
    const created = await route('/create_skill', { name: 'learned', description: 'd', content: 'c', ...asTaskAgent(projectB) })
    expect(created.skill).toMatchObject({ project_id: projectB })
  })

  it('an unscoped create is global unless project_id names a project', async () => {
    expect((await route('/create_skill', { name: 'anywhere', description: 'd', content: 'c' })).skill).toMatchObject({ project_id: null, scope: 'global' })
    expect((await route('/create_skill', { name: 'for-beta', description: 'd', content: 'c', project_id: projectB })).skill).toMatchObject({ project_id: projectB })
    expect((await route('/create_skill', { name: 'nowhere', description: 'd', content: 'c', project_id: 'ghost' })).error).toContain('Project not found')
  })

  it('a project scope asking for a global skill is refused and told to ask the user', async () => {
    const refused = await route('/create_skill', { name: 'wants-global', description: 'd', content: 'c', global: true, ...asMastermind(projectA) })
    expect(refused.error).toMatch(/confirmation/i)
    expect(refused.error).toMatch(/Skills view|Commander/)
    expect(db.getSkillByName('wants-global')).toBeUndefined()
  })

  it('names are unique across scopes', async () => {
    const clash = await route('/create_skill', { name: 'beta-release', description: 'd', content: 'c', ...asMastermind(projectA) })
    expect(clash.error).toContain('unique across all projects')
    const own = await route('/create_skill', { name: 'alpha-release', description: 'd', content: 'c', ...asMastermind(projectA) })
    expect(own.error).toContain(skillA.id)
  })
})

describe('cross-project and global modification', () => {
  it('a project may update and delete only its own skills', async () => {
    expect((await route('/update_skill', { skill_id: skillA.id, content: 'edited', ...asMastermind(projectA) })).success).toBe(true)
    expect((await route('/update_skill', { skill_id: skillB.id, content: 'hijack', ...asMastermind(projectA) })).error).toContain('Access denied')
    expect(db.getSkill(skillB.id)!.content).toBe('# B')

    const global = await route('/update_skill', { skill_id: globalSkill.id, content: 'silently changed', ...asTaskAgent(projectA) })
    expect(global.error).toMatch(/confirmation/i)
    expect(db.getSkill(globalSkill.id)!.content).toBe('# Review')

    expect((await route('/delete_skill', { skill_id: skillB.id, ...asMastermind(projectA) })).error).toContain('Access denied')
    expect((await route('/delete_skill', { skill_id: globalSkill.id, ...asMastermind(projectA) })).error).toMatch(/confirmation/i)
    expect((await route('/delete_skill', { skill_id: skillA.id, ...asMastermind(projectA) })).success).toBe(true)
    expect(db.getSkills().map((s) => s.name).sort()).toEqual(['beta-release', 'pr-review'])
  })

  it('a stale expected_version is refused with the current version', async () => {
    const first = await route('/update_skill', { skill_id: skillA.id, content: 'one', expected_version: skillA.version, ...asMastermind(projectA) })
    expect((first.skill as SkillRecord).version).toBe(skillA.version + 1)
    const stale = await route('/update_skill', { skill_id: skillA.id, content: 'two', expected_version: skillA.version, ...asMastermind(projectA) })
    expect(stale).toMatchObject({ conflict: 'stale_version', current_version: skillA.version + 1 })
    expect(db.getSkill(skillA.id)!.content).toBe('one')
    expect((await route('/update_skill', { skill_id: skillA.id, content: 'x', expected_version: 0 })).error).toContain('expected_version')
  })

  it('a rename cannot take another skill\'s name', async () => {
    const taken = await route('/update_skill', { skill_id: skillA.id, name: 'pr-review', ...asMastermind(projectA) })
    expect(taken.error).toContain('unique across all projects')
  })
})

describe('skill assignment to tasks', () => {
  it('refuses another project\'s skill on create_task, create_subtask and update_task, naming it', async () => {
    const created = await route('/create_task', { title: 'T', project_id: projectA, skill_ids: [globalSkill.id, skillB.id] })
    expect(created.error).toContain('beta-release')

    const ok = await route('/create_task', { title: 'T', project_id: projectA, skill_ids: [globalSkill.id, skillA.id] })
    expect(ok.success).toBe(true)
    const taskId = (ok.task as { id: string }).id

    expect((await route('/update_task', { task_id: taskId, skill_ids: [skillB.id] })).error).toContain('beta-release')
    expect((await route('/create_subtask', { parent_task_id: taskId, title: 'child', skill_ids: [skillB.id] })).error).toContain('beta-release')
    expect((await route('/create_subtask', { parent_task_id: taskId, title: 'child', skill_ids: [skillA.id] })).success).toBe(true)
    expect(db.getTask(taskId)!.skill_ids).toEqual([globalSkill.id, skillA.id])
  })

  it('validateSkillAssignment lets unknown ids through and flags only foreign skills', () => {
    expect(validateSkillAssignment(db, undefined, projectA)).toBeNull()
    expect(validateSkillAssignment(db, ['not-a-skill'], projectA)).toBeNull()
    expect(validateSkillAssignment(db, [globalSkill.id, skillA.id], projectA)).toBeNull()
    expect(validateSkillAssignment(db, [skillB.id], projectA)?.error).toContain('beta-release')
  })
})

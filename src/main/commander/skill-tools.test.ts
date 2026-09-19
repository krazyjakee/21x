import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../database'
import type { ChatToolResult } from './tools'
import { ProjectMutationConfirmations } from './project-tools'
import { createCommanderSkillTools, MUTATING_COMMANDER_SKILL_TOOLS, type SkillChangeKind } from './skill-tools'

/** The Commander's skill administration (#74). */
let db: DatabaseManager
let confirmations: ProjectMutationConfirmations
let changes: Array<{ skillId: string; kind: SkillChangeKind }>

async function call(name: string, input: Record<string, unknown>, userMessage = 'do it'): Promise<ChatToolResult> {
  const tool = createCommanderSkillTools({
    db,
    context: { sessionId: 'session-1', userMessage },
    confirmations,
    onSkillChanged: (skillId, kind) => changes.push({ skillId, kind })
  }).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`Missing tool: ${name}`)
  const output = await tool.handler(input, { signal: new AbortController().signal, toolCallId: 'call-1' })
  return typeof output === 'string' ? { content: output } : output
}

function body(output: ChatToolResult): Record<string, unknown> {
  return JSON.parse(output.content) as Record<string, unknown>
}

async function confirmedCall(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const first = body(await call(name, input))
  expect(first.status, name).toBe('confirmation_required')
  const token = first.confirmation_token as string
  return body(await call(name, { ...input, confirmation_token: token }, `Confirm ${token}`))
}

function snapshot(): string {
  return JSON.stringify(db.getSkills())
}

beforeEach(() => {
  ;({ db } = createTestDb())
  confirmations = new ProjectMutationConfirmations()
  changes = []
})

describe('Commander skill reads', () => {
  it('lists metadata across scopes with counts, filters by scope and hides archived projects\' skills by default', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const gone = db.createProject({ name: 'Gone' })!
    db.createSkill({ name: 'pr-review', description: 'Reviews', content: 'long body' })
    db.createSkill({ name: 'alpha-release', description: 'd', content: 'c', project_id: alpha.id })
    db.createSkill({ name: 'old-release', description: 'd', content: 'c', project_id: gone.id })
    db.archiveProject(gone.id, true)

    const all = body(await call('list_skills', {}))
    const items = all.skills as Array<Record<string, unknown>>
    expect(items.map((s) => s.name)).toEqual(['pr-review', 'alpha-release'])
    expect(items[0]).toMatchObject({ scope: 'global', project_id: null })
    expect(items[1]).toMatchObject({ scope: 'project', project_id: alpha.id, project_name: 'Alpha' })
    expect(items[0]).not.toHaveProperty('content')
    expect(all.counts).toEqual({ global: 1, Alpha: 1 })

    const withArchived = body(await call('list_skills', { include_archived_projects: true }))
    expect((withArchived.skills as Array<Record<string, unknown>>).map((s) => s.name)).toContain('old-release')
    expect((body(await call('list_skills', { scope: 'global' })).skills as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['pr-review'])
    expect((body(await call('list_skills', { project: 'Alpha' })).skills as Array<Record<string, unknown>>).map((s) => s.name)).toEqual(['alpha-release'])
  })

  it('caps the list and clips get_skill content with truncation metadata', async () => {
    for (let i = 0; i < 120; i++) db.createSkill({ name: `skill-${String(i).padStart(3, '0')}`, description: 'x'.repeat(500), content: 'c' })
    const listed = body(await call('list_skills', {}))
    expect(listed.total).toBe(120)
    expect(listed.truncated).toBe(true)
    expect((listed.skills as unknown[]).length).toBeLessThanOrEqual(100)
    expect((await call('list_skills', {})).content.length).toBeLessThanOrEqual(12_000)

    const big = db.createSkill({ name: 'big', description: 'd', content: 'y'.repeat(20_000) })!
    const detail = body(await call('get_skill', { skill: 'big' }))
    expect(detail).toMatchObject({ id: big.id, content_chars: 20_000, content_truncated: true })
    expect((detail.content as string).length).toBe(8_000)
  })
})

describe('Commander skill mutations', () => {
  it('makes no write from any mutating skill tool until the user confirms', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const own = db.createSkill({ name: 'alpha-release', description: 'd', content: 'c', project_id: alpha.id })!
    db.createSkill({ name: 'pr-review', description: 'd', content: 'c' })
    const inputs: Record<(typeof MUTATING_COMMANDER_SKILL_TOOLS)[number], Record<string, unknown>> = {
      create_skill: { name: 'new-skill', description: 'd', content: 'c' },
      update_skill: { skill: own.id, changes: { content: 'changed' } },
      remove_skill: { skill: own.id },
      promote_skill: { skill: own.id },
      move_skill: { skill: 'pr-review', project: beta.id }
    }
    const before = snapshot()
    for (const name of MUTATING_COMMANDER_SKILL_TOOLS) {
      const first = body(await call(name, inputs[name]))
      expect(first.status, name).toBe('confirmation_required')
      expect(body(await call(name, { ...inputs[name], confirmation_token: 'made-up' })).status, name).toBe('confirmation_invalid')
      expect(body(await call(name, { ...inputs[name], confirmation_token: first.confirmation_token }, 'yes please')).status, name).toBe('confirmation_absent')
    }
    expect(snapshot()).toBe(before)
    expect(changes).toEqual([])
  })

  it('creates a global skill by default, and a project skill when a project is named', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const global = await confirmedCall('create_skill', { name: 'pr-review', description: 'Review PRs', content: '# Review' })
    expect(global.status).toBe('ok')
    expect(global.result).toMatchObject({ name: 'pr-review', scope: 'global', project_id: null })
    // Every project's session can now see it.
    expect(db.getSkills({ visibleToProject: alpha.id }).map((s) => s.name)).toContain('pr-review')

    const scoped = await confirmedCall('create_skill', { name: 'alpha-release', description: 'd', content: 'c', project: 'Alpha' })
    expect(scoped.result).toMatchObject({ scope: 'project', project_id: alpha.id })
    expect(changes.map((c) => c.kind)).toEqual(['created', 'created'])

    await expect(call('create_skill', { name: 'pr-review', description: 'd', content: 'c' })).rejects.toThrow(/unique across all projects/)
    await expect(call('create_skill', { name: 'Bad Name', description: 'd', content: 'c' })).rejects.toThrow(/lowercase/)
  })

  it('promotes a project skill to global only after confirmation', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const skill = db.createSkill({ name: 'alpha-release', description: 'd', content: 'c', project_id: alpha.id })!

    const first = body(await call('promote_skill', { skill: skill.id }))
    expect(first.status).toBe('confirmation_required')
    expect(db.getSkill(skill.id)!.project_id).toBe(alpha.id)
    expect(db.getSkills({ visibleToProject: beta.id }).map((s) => s.id)).not.toContain(skill.id)

    const token = first.confirmation_token as string
    const done = body(await call('promote_skill', { skill: skill.id, confirmation_token: token }, `Confirm ${token}`))
    expect(done.result).toMatchObject({ scope: 'global', previous_project_id: alpha.id })
    expect(db.getSkills({ visibleToProject: beta.id }).map((s) => s.id)).toContain(skill.id)
    expect(changes).toEqual([{ skillId: skill.id, kind: 'scope' }])

    await expect(call('promote_skill', { skill: skill.id })).rejects.toThrow(/already global/)
  })

  it('refuses to move a skill into a project while other projects\' tasks or agent defaults use it', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const skill = db.createSkill({ name: 'shared', description: 'd', content: 'c' })!
    const betaTask = db.createTask({ title: 'Beta work', project_id: beta.id })!
    db.updateTask(betaTask.id, { skill_ids: [skill.id] })

    await expect(call('move_skill', { skill: skill.id, project: alpha.id })).rejects.toThrow(/Beta work/)
    db.updateTask(betaTask.id, { skill_ids: [] })
    db.createAgent({ name: 'Everywhere', config: { coding_agent: 'opencode', skill_ids: [skill.id] } })
    await expect(call('move_skill', { skill: skill.id, project: alpha.id })).rejects.toThrow(/Everywhere/)
    expect(db.getSkill(skill.id)!.project_id).toBeNull()

    const free = db.createSkill({ name: 'free', description: 'd', content: 'c' })!
    const moved = await confirmedCall('move_skill', { skill: 'free', project: 'Alpha' })
    expect(moved.result).toMatchObject({ project_id: alpha.id })
    expect(db.getSkill(free.id)!.project_id).toBe(alpha.id)
  })

  it('updates after confirmation, refuses a stale version, and soft-deletes', async () => {
    const skill = db.createSkill({ name: 'guide', description: 'd', content: 'v1' })!
    const updated = await confirmedCall('update_skill', { skill: 'guide', changes: { content: 'v2' }, expected_version: skill.version })
    expect(updated.result).toMatchObject({ version: skill.version + 1, content: 'v2' })

    // Someone else wrote in between: the confirmed stale write is refused.
    const first = body(await call('update_skill', { skill: 'guide', changes: { content: 'v3' }, expected_version: skill.version }))
    const token = first.confirmation_token as string
    await expect(call('update_skill', { skill: 'guide', changes: { content: 'v3' }, expected_version: skill.version, confirmation_token: token }, `Confirm ${token}`))
      .rejects.toThrow(/Current version: 2/)
    expect(db.getSkill(skill.id)!.content).toBe('v2')

    await expect(call('update_skill', { skill: 'guide', changes: { project_id: null } })).rejects.toThrow(/changes may only contain/)

    const removed = await confirmedCall('remove_skill', { skill: skill.id })
    expect(removed.result).toMatchObject({ removed_skill_id: skill.id })
    expect(db.getSkill(skill.id)).toBeUndefined()
  })
})

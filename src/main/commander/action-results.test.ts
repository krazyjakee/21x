import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../../test/helpers/portable-db-test-helper'
import type { DatabaseManager } from '../database'
import { CommanderStore } from './commander-store'
import { createCommanderProjectTools, type CommanderAgents } from './project-tools'
import { createCommanderSkillTools } from './skill-tools'
import { actionMutation } from './action-results'
import { undoCommanderAction } from './action-undo'
import { parseCommanderAction } from '../../shared/commander-action'
import { MUTATING_COMMANDER_TOOLS, MUTATING_COMMANDER_SKILL_TOOLS } from '../../shared/commander-tools'
import { migrateCommanderActions } from '../database/commander-actions-migration'
import type { ChatToolResult } from '../chat/tools'

let db: DatabaseManager
let store: CommanderStore
let sessionId: string
let sequence: number
let paused: boolean
let agents: CommanderAgents
beforeEach(() => {
  db = createPortableTestDb()
  migrateCommanderActions(db.db)
  store = new CommanderStore(db)
  sessionId = store.createSession('Actions').id
  sequence = 0
  paused = false
  agents = { pauseAllProjects: value => { paused = value }, isAllProjectsPaused: () => paused } as CommanderAgents
})
afterEach(() => db.db.close())

async function execute(name: string, input: Record<string, unknown>, callId = `call-${++sequence}`): Promise<ChatToolResult> {
  const context = { sessionId, userMessage: 'Make the requested change', deliveryScope: 'test-turn' }
  const tool = [...createCommanderProjectTools({ db, context, agents }), ...createCommanderSkillTools({ db, context })].find(tool => tool.name === name)!
  const result = await tool.handler(input, { signal: new AbortController().signal, toolCallId: callId })
  return typeof result === 'string' ? { content: result } : result
}
function undo(output: ChatToolResult) {
  return undoCommanderAction({ db, store, agents, sessionId, actionId: JSON.parse(output.content).undoId })
}

describe('Commander executed action snapshots and exact Undo', () => {
  it('every registered mutating tool returns a validated card on its first call', async () => {
    const project = db.createProject({ name: 'Target' })!
    const repo = db.addProjectRepo(project.id, { name: 'api', org: 'acme' })!
    const resource = db.addProjectResource(project.id, { label: 'Runbook' })!
    const skill = db.createSkill({ name: 'review', description: 'Review work', content: 'Read the changes', project_id: project.id })!
    const inputs: Record<string, Record<string, unknown>> = {
      pause_all_projects: { paused: true }, create_project: { name: 'New project' },
      update_project: { project: project.id, changes: { name: 'Renamed' } },
      add_project_repo: { project: project.id, name: 'web' },
      update_project_repo: { project: project.id, repo_id: repo.id, changes: { name: 'backend' } },
      remove_project_repo: { project: project.id, repo_id: repo.id },
      add_project_resource: { project: project.id, label: 'Deployment notes' },
      update_project_resource: { project: project.id, resource_id: resource.id, changes: { label: 'Operations' } },
      remove_project_resource: { project: project.id, resource_id: resource.id },
      archive_project: { project: project.id }, restore_project: { project: project.id },
      create_skill: { name: 'new-skill', description: 'Use for tests', content: 'Check the result' },
      update_skill: { skill: skill.id, changes: { description: 'Review releases' } },
      promote_skill: { skill: skill.id }, move_skill: { skill: skill.id, project: project.id }, remove_skill: { skill: skill.id }
    }
    const skillTools = [...MUTATING_COMMANDER_SKILL_TOOLS.filter(name => name !== 'remove_skill'), 'remove_skill']
    for (const name of [...MUTATING_COMMANDER_TOOLS, ...skillTools]) {
      const input = name === 'reorder_project_repos' ? { project: project.id, ordered_ids: db.getProjectRepos(project.id).map(repo => repo.id).reverse() }
        : name === 'reorder_project_resources' ? { project: project.id, ordered_ids: db.getProjectResources(project.id).map(resource => resource.id).reverse() }
          : inputs[name]
      const output = await execute(name, input)
      const card = parseCommanderAction(name, output.content, Boolean(output.isError))
      expect(card, name).not.toBeNull()
      expect(card!.target.id, name).toBeTruthy()
      expect(card!.target.name, name).toBeTruthy()
      expect(JSON.parse(output.content).status).toBe('ok')
    }
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM commander_actions').get()).toEqual({ n: 18 })
  })

  it('reverses archive and pause directly, records one note, and repeated Undo is a no-op', async () => {
    const project = db.createProject({ name: 'Web' })!
    const archived = await execute('archive_project', { project: project.id })
    expect(db.getProject(project.id)!.archived).toBe(true)
    const first = undo(archived)
    expect(first.alreadyUndone).toBe(false)
    expect(db.getProject(project.id)!.archived).toBe(false)
    expect(first.message.tool_name).toBe('undo_action')
    expect(undo(archived)).toEqual({ alreadyUndone: true, message: first.message })
    expect(store.listMessages(sessionId)).toHaveLength(1)
    const pause = await execute('pause_all_projects', { paused: true })
    expect(paused).toBe(true)
    undo(pause)
    expect(paused).toBe(false)
  })

  it('refuses stale affected fields and cross-conversation requests while preserving unrelated edits', async () => {
    const project = db.createProject({ name: 'Before', description: 'Original brief' })!
    const edited = await execute('update_project', { project: project.id, changes: { name: 'After' } })
    const actionId = JSON.parse(edited.content).undoId
    const other = store.createSession('Other').id
    expect(() => undoCommanderAction({ db, store, sessionId: other, actionId })).toThrow('Action not found')
    db.updateProject(project.id, { name: 'Later edit' })
    expect(() => undo(edited)).toThrow('fields changed')
    expect(store.listMessages(sessionId)).toHaveLength(0)
    db.updateProject(project.id, { name: 'After', description: 'Unrelated later brief' })
    undo(edited)
    expect(db.getProject(project.id)).toMatchObject({ name: 'Before', description: 'Unrelated later brief' })
  })

  it('reverses repo/resource/skill field updates, retaining full values beyond displayed excerpts', async () => {
    const project = db.createProject({ name: 'Web' })!
    const repo = db.addProjectRepo(project.id, { name: 'api', org: 'acme' })!
    const resource = db.addProjectResource(project.id, { label: 'Runbook', notes: 'Original notes' })!
    const original = 'Original skill instructions. '.repeat(1500)
    const skill = db.createSkill({ name: 'review', description: 'Review', content: original })!
    undo(await execute('update_project_repo', { project: project.id, repo_id: repo.id, changes: { org: 'new-org' } }))
    expect(db.getProjectRepo(repo.id)!.org).toBe('acme')
    undo(await execute('update_project_resource', { project: project.id, resource_id: resource.id, changes: { notes: 'New notes' } }))
    expect(db.getProjectResource(resource.id)!.notes).toBe('Original notes')
    const edited = await execute('update_skill', { skill: skill.id, changes: { content: 'New instructions. '.repeat(2000) } })
    expect(edited.content.length).toBeLessThanOrEqual(12_000)
    expect(parseCommanderAction('update_skill', edited.content, false)!.changes[0].before).toContain('…')
    undo(edited)
    expect(db.getSkill(skill.id)!.content).toBe(original)
    expect(store.listMessages(sessionId).at(-1)!.content.length).toBeLessThan(4000)
  })

  it('removals and scope moves have no Undo, and failures/legacy/hosted claims produce no validated card', async () => {
    const skill = db.createSkill({ name: 'review', description: 'Review', content: 'Review' })!
    const removed = await execute('remove_skill', { skill: skill.id })
    const card = parseCommanderAction('remove_skill', removed.content, false)!
    expect(card.severity).toBe('destructive')
    expect(card.undoId).toBeNull()
    const row = db.db.prepare('SELECT id FROM commander_actions').get() as { id: string }
    expect(() => undoCommanderAction({ db, store, sessionId, actionId: row.id })).toThrow("Can't be undone here")
    expect(parseCommanderAction('remove_skill', removed.content, true)).toBeNull()
    expect(parseCommanderAction('remove_skill', '{"status":"ok","result":{"removed_skill_id":"old"}}', false)).toBeNull()
    expect(parseCommanderAction('ask_captain', removed.content, false)).toBeNull()
    expect(parseCommanderAction('remove_skill', 'I removed it', false)).toBeNull()
  })

  it('rolls the write back when snapshot persistence fails and replays a durable call without writing again', async () => {
    const project = db.createProject({ name: 'Before' })!
    expect(() => actionMutation({ db, sessionId, toolCallId: 'broken', scope: 'turn', tool: 'update_project',
      target: { kind: 'project', id: project.id, name: project.name }, before: { name: 'Before' },
      write: () => db.updateProject(project.id, { name: 'After' }), after: () => { throw new Error('snapshot failure') } })).toThrow('snapshot failure')
    expect(db.getProject(project.id)!.name).toBe('Before')
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM commander_actions').get()).toEqual({ n: 0 })
    const first = await execute('update_project', { project: project.id, changes: { name: 'After' } }, 'same-call')
    const second = await execute('update_project', { project: project.id, changes: { name: 'Unexpected replay edit' } }, 'same-call')
    expect(second).toEqual(first)
    expect(db.getProject(project.id)!.name).toBe('After')
  })
})

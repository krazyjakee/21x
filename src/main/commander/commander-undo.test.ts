import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../database'
import type { ChatToolDefinition, ChatToolResult } from '../chat/tools'
import { CommanderStore } from './commander-store'
import { undoCommanderAction } from './commander-undo'
import { createCommanderProjectTools, type CommanderAgents } from './project-tools'
import { createCommanderSkillTools } from './skill-tools'

let db: DatabaseManager
let store: CommanderStore

function fakeAgents(): CommanderAgents {
  let paused = false
  return {
    getStartQueue: () => [],
    findSessionByTaskId: () => undefined,
    getSessionStatus: () => null,
    getProjectLimitState: (projectId) => ({
      projectId, paused: false, allProjectsPaused: paused, maxConcurrentAgents: null,
      runningAgents: 0, dailySessionCap: null, sessionsStartedToday: 0,
      dailyTokenCap: null, tokensToday: 0, queued: [], blockedBy: null
    }),
    sendMessage: vi.fn(async () => ({})),
    pauseAllProjects: (value) => { paused = value },
    isAllProjectsPaused: () => paused
  }
}

beforeEach(() => {
  const created = createTestDb()
  db = created.db
  store = new CommanderStore(db)
})

async function perform(
  tools: ChatToolDefinition[],
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
  callId = `call-${name}`
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name)!
  const raw = await tool.handler(input, { signal: new AbortController().signal, toolCallId: callId })
  const result: ChatToolResult = typeof raw === 'string' ? { content: raw } : raw
  store.appendMessage(sessionId, { role: 'user', content: `Please ${name}`, inputMode: 'typed' })
  store.appendMessage(sessionId, { role: 'assistant', content: '', toolCalls: [{ id: callId, name, input }] })
  store.appendMessage(sessionId, { role: 'tool', content: result.content, toolCallId: callId, toolName: name })
  return callId
}

describe('Commander exact-reversal Undo', () => {
  it('reverses archive and records one hidden model note', async () => {
    const project = db.createProject({ name: 'Web' })!
    const session = store.createSession()
    const agents = fakeAgents()
    const tools = createCommanderProjectTools({ db, context: { sessionId: session.id }, agents })
    const callId = await perform(tools, session.id, 'archive_project', { project: project.id })
    expect(db.getProject(project.id)?.archived).toBe(true)

    const undone = undoCommanderAction({ db, store, agents }, session.id, callId)
    expect(db.getProject(project.id)?.archived).toBe(false)
    expect(undone.note).toMatchObject({ role: 'user', correlation_id: `undo:${callId}`, input_mode: null })
    expect(undone.note.content).toContain('Treat the action as undone')
    expect(() => undoCommanderAction({ db, store, agents }, session.id, callId)).toThrow(/already undone/i)
  })

  it('restores field updates only while the recorded after-values are still current', async () => {
    const project = db.createProject({ name: 'Before', description: 'Old brief' })!
    const session = store.createSession()
    const agents = fakeAgents()
    const tools = createCommanderProjectTools({ db, context: { sessionId: session.id }, agents })
    const callId = await perform(tools, session.id, 'update_project', {
      project: project.id,
      changes: { name: 'After', brief: 'New brief' }
    })
    expect(db.getProject(project.id)).toMatchObject({ name: 'After', description: 'New brief' })
    undoCommanderAction({ db, store, agents }, session.id, callId)
    expect(db.getProject(project.id)).toMatchObject({ name: 'Before', description: 'Old brief' })

    const next = await perform(tools, session.id, 'update_project', { project: project.id, changes: { name: 'Second' } }, 'call-drift')
    db.updateProject(project.id, { name: 'Third' })
    expect(() => undoCommanderAction({ db, store, agents }, session.id, next)).toThrow(/changed again/i)
    expect(db.getProject(project.id)?.name).toBe('Third')
  })

  it('reverses pause-all and skill field edits, but refuses removals and scope moves', async () => {
    const agents = fakeAgents()
    const project = db.createProject({ name: 'Alpha' })!
    const session = store.createSession()
    const projectTools = createCommanderProjectTools({ db, context: { sessionId: session.id }, agents })
    const pause = await perform(projectTools, session.id, 'pause_all_projects', { paused: true })
    expect(agents.isAllProjectsPaused()).toBe(true)
    undoCommanderAction({ db, store, agents }, session.id, pause)
    expect(agents.isAllProjectsPaused()).toBe(false)

    const skill = db.createSkill({ name: 'guide', description: 'Before', content: 'v1', project_id: project.id })!
    const skillTools = createCommanderSkillTools({ db, context: { sessionId: session.id } })
    const update = await perform(skillTools, session.id, 'update_skill', {
      skill: skill.id, changes: { description: 'After', content: 'v2' }, expected_version: skill.version
    })
    undoCommanderAction({ db, store }, session.id, update)
    expect(db.getSkill(skill.id)).toMatchObject({ description: 'Before', content: 'v1' })

    const promotedSkill = db.createSkill({ name: 'scoped', description: 'd', content: 'c', project_id: project.id })!
    const promote = await perform(skillTools, session.id, 'promote_skill', { skill: promotedSkill.id })
    expect(() => undoCommanderAction({ db, store }, session.id, promote)).toThrow(/can't be undone here/i)

    const repo = db.addProjectRepo(project.id, { name: 'api' })!
    const remove = await perform(projectTools, session.id, 'remove_project_repo', { project: project.id, repo_id: repo.id })
    expect(() => undoCommanderAction({ db, store, agents }, session.id, remove)).toThrow(/can't be undone here/i)
  })
})

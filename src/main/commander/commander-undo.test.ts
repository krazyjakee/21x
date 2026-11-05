import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { DatabaseManager } from '../database'
import type { ChatToolDefinition, ChatToolResult } from '../chat/tools'
import { parseCommanderActionResult } from '../../shared/commander-tools'
import { CommanderStore } from './commander-store'
import { undoCommanderAction } from './commander-undo'
import { createCommanderProjectTools, type CommanderAgents } from './project-tools'
import { createCommanderSkillTools } from './skill-tools'

let db: DatabaseManager
let store: CommanderStore
let executionSequence: number

function fakeAgents(): CommanderAgents {
  return {
    getStartQueue: () => [],
    findSessionByTaskId: () => undefined,
    getSessionStatus: () => null,
    getProjectLimitState: (projectId) => ({
      projectId, paused: false, allProjectsPaused: db.getSetting('all_projects_paused') === '1', maxConcurrentAgents: null,
      runningAgents: 0, dailySessionCap: null, sessionsStartedToday: 0,
      dailyTokenCap: null, tokensToday: 0, queued: [], blockedBy: null
    }),
    sendMessage: vi.fn(async () => ({})),
    pauseAllProjects: (value) => { db.setSetting('all_projects_paused', value ? '1' : '0') },
    isAllProjectsPaused: () => db.getSetting('all_projects_paused') === '1',
    recheckStartQueue: vi.fn()
  }
}

beforeEach(() => {
  const created = createTestDb()
  db = created.db
  store = new CommanderStore(db)
  executionSequence = 0
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
  const action = parseCommanderActionResult(result.content)!
  const executionId = `execution-${++executionSequence}`
  const request = store.appendMessage(sessionId, { role: 'user', content: `Please ${name}`, inputMode: 'typed' })
  store.appendMessage(sessionId, { role: 'assistant', content: '', toolCalls: [{ id: callId, execution_id: executionId, name, input }] })
  store.appendMessage(sessionId, { role: 'tool', content: result.content, toolCallId: callId, toolName: name })
  store.appendActionExecution({
    executionId,
    sessionId,
    turnId: `turn-${executionId}`,
    requestMessageId: request.id,
    providerCallId: callId,
    toolName: name,
    input,
    result: action
  })
  return executionId
}

describe('Commander exact-reversal Undo', () => {
  it('reverses archive and records one hidden model note', async () => {
    const project = db.createProject({ name: 'Web' })!
    const session = store.createSession()
    const agents = fakeAgents()
    const tools = createCommanderProjectTools({ db, context: { sessionId: session.id }, agents })
    const executionId = await perform(tools, session.id, 'archive_project', { project: project.id })
    expect(db.getProject(project.id)?.archived).toBe(true)

    const undone = undoCommanderAction({ db, store, agents }, session.id, executionId)
    expect(db.getProject(project.id)?.archived).toBe(false)
    expect(undone.note).toMatchObject({ role: 'user', correlation_id: `undo:${executionId}`, input_mode: null })
    expect(undone.note.content).toContain('grants no new authority')
    expect(undone.note.content).toContain('Treat the action as undone')
    expect(() => undoCommanderAction({ db, store, agents }, session.id, executionId)).toThrow(/already undone/i)
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

  it('binds repeated provider call ids to unique executions and refuses cross-session undo', async () => {
    const agents = fakeAgents()
    const alpha = db.createProject({ name: 'Alpha' })!
    const other = db.createProject({ name: 'Other' })!
    const sessionA = store.createSession()
    const sessionB = store.createSession()
    const toolsA = createCommanderProjectTools({ db, context: { sessionId: sessionA.id }, agents })
    const toolsB = createCommanderProjectTools({ db, context: { sessionId: sessionB.id }, agents })
    const alphaExecution = await perform(toolsA, sessionA.id, 'archive_project', { project: alpha.id }, 'call-1')
    const otherExecution = await perform(toolsB, sessionB.id, 'archive_project', { project: other.id }, 'call-1')

    expect(() => undoCommanderAction({ db, store, agents }, sessionB.id, alphaExecution)).toThrow(/not found/i)
    undoCommanderAction({ db, store, agents }, sessionB.id, otherExecution)
    expect(db.getProject(alpha.id)?.archived).toBe(true)
    expect(db.getProject(other.id)?.archived).toBe(false)
  })

  it('rolls back reversal and consumption together, then survives restart and refuses replay', async () => {
    const agents = fakeAgents()
    const project = db.createProject({ name: 'Atomic' })!
    const session = store.createSession()
    const tools = createCommanderProjectTools({ db, context: { sessionId: session.id }, agents })
    const executionId = await perform(tools, session.id, 'archive_project', { project: project.id })
    const changed = vi.fn()
    const originalMark = store.markActionUndone.bind(store)
    vi.spyOn(store, 'markActionUndone').mockImplementation(() => {
      throw new Error('SQLITE_FULL: injected consumption-marker failure')
    })

    expect(() => undoCommanderAction({ db, store, agents, onProjectChanged: changed }, session.id, executionId))
      .toThrow(/SQLITE_FULL/)
    expect(db.getProject(project.id)?.archived).toBe(true)
    expect(store.getActionExecution(executionId)?.undone_at).toBeNull()
    expect(store.listMessages(session.id).some((message) => message.correlation_id === `undo:${executionId}`)).toBe(false)
    expect(changed).not.toHaveBeenCalled()

    vi.mocked(store.markActionUndone).mockImplementation(originalMark)
    const restarted = new CommanderStore(db)
    undoCommanderAction({ db, store: restarted, agents, onProjectChanged: changed }, session.id, executionId)
    expect(db.getProject(project.id)?.archived).toBe(false)
    expect(restarted.getActionExecution(executionId)?.undone_at).not.toBeNull()
    expect(changed).toHaveBeenCalledTimes(1)

    db.archiveProject(project.id, true)
    expect(() => undoCommanderAction({ db, store: new CommanderStore(db), agents }, session.id, executionId))
      .toThrow(/already undone/i)
    expect(db.getProject(project.id)?.archived).toBe(true)
  })
})

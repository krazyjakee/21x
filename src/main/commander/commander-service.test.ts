/**
 * Commander sessions on agent sessions (docs/commander.md): the hidden task
 * row, the agent choice, the tool context read from the transcript (which the
 * confirmation check depends on), delegations, titles and archive.
 */
import { describe, expect, it } from 'vitest'
import { createCommanderHarness } from '../../../test/helpers/commander-harness'
import { COMMANDER_AGENT_SETTING } from '../../shared/commander'
import { SYSTEM_MESSAGE_MARKER } from '../../shared/system-authority'
import { TASK_ROLE_COMMANDER } from '../../shared/task-roles'
import { mcpOptionsForTask } from '../agent-manager/session-config'
import { callCommanderMcpTool, listCommanderMcpTools, setCommanderToolHost } from './commander-mcp'
import { fallbackTitle, toolResultTags, turnContextFromTranscript } from './commander-service'
import { buildCommanderSystemPrompt, COMMANDER_SYSTEM_PROMPT, earlierHistoryNote } from './prompts'
import type { CommanderToolContext } from './commander-service'

describe('Commander session rows', () => {
  it('backs every session with a hidden commander task row that shares its id', () => {
    const { db, store, service } = createCommanderHarness()
    const session = store.createSession('Planning')

    const task = db.getTask(session.id)
    expect(task).toMatchObject({ id: session.id, role: TASK_ROLE_COMMANDER })
    // Never listed as a task, never scheduled.
    expect(db.getTasks().some((t) => t.id === session.id)).toBe(false)
    expect(service.prepareSession(session.id)).toEqual({ taskId: session.id, agentId: expect.any(String) })

    // The Commander gets its own MCP server and no task-management scope.
    expect(mcpOptionsForTask(session.id, task)).toEqual({ ensureTaskManagement: false, commanderSessionId: session.id })

    expect(store.deleteSession(session.id)).toBe(true)
    expect(db.getTask(session.id)).toBeUndefined()
  })

  it('gives a session from the old chat runtime its row on first use, with the old history in the transcript', () => {
    const { db, store, service } = createCommanderHarness()
    const session = store.createSession('Old')
    // Simulate a pre-upgrade session: messages but no task row.
    db.db.prepare('DELETE FROM tasks WHERE id = ?').run(session.id)
    store.appendMessage(session.id, { role: 'user', content: 'How is Alpha doing?' })
    store.appendMessage(session.id, { role: 'assistant', content: 'Alpha is on track.' })
    store.appendMessage(session.id, { role: 'summary', content: 'Talked about Alpha.' })

    service.prepareSession(session.id)
    expect(db.getTask(session.id)?.role).toBe(TASK_ROLE_COMMANDER)
    const parts = db.getTranscriptParts(session.id)
    expect(parts.map((p) => [p.role, p.content])).toEqual([
      ['user', 'How is Alpha doing?'],
      ['assistant', 'Alpha is on track.']
    ])
    // A second prepare copies nothing again.
    service.prepareSession(session.id)
    expect(db.getTranscriptParts(session.id)).toHaveLength(2)

    // The agent is told what was said.
    const note = earlierHistoryNote(store.listMessages(session.id))
    expect(note).toContain('Summary: Talked about Alpha.')
    expect(note).toContain('User: How is Alpha doing?')
    expect(buildCommanderSystemPrompt('Agent prompt', note)).toBe(`${COMMANDER_SYSTEM_PROMPT}\n\n${note}\n\nAgent prompt`)
  })

  it('runs on the chosen agent, else the default agent', () => {
    const { db, service, agent } = createCommanderHarness()
    expect(service.agentId()).toBe(agent.id)
    const other = db.createAgent({ name: 'Codex' })!
    db.setSetting(COMMANDER_AGENT_SETTING, other.id)
    expect(service.agentId()).toBe(other.id)
    // A deleted choice falls back rather than failing.
    db.setSetting(COMMANDER_AGENT_SETTING, 'gone')
    expect(service.agentId()).toBe(agent.id)
  })

  it('stops the agent when a session is archived', () => {
    const { store, service, stopByTaskId } = createCommanderHarness()
    const session = store.createSession()
    expect(service.setArchived(session.id, true)?.archived).toBe(true)
    expect(stopByTaskId).toHaveBeenCalledWith(session.id)
    service.setArchived(session.id, false)
    expect(stopByTaskId).toHaveBeenCalledTimes(1)
  })

  it('names an untitled session after the user speaks and moves it up the list', () => {
    const { store, say, setStatus } = createCommanderHarness()
    const first = store.createSession()
    const second = store.createSession()
    say(first.id, 'Please check on the billing rewrite for me today')
    expect(store.getSession(first.id)?.title).toBe('Please check on the billing rewrite…')
    expect(store.listSessions()[0].id).toBe(first.id)

    // A rename is never overwritten.
    store.renameSession(second.id, 'Mine')
    say(second.id, 'something else')
    expect(store.getSession(second.id)?.title).toBe('Mine')

    setStatus(first.id, 'idle')
    expect(store.listSessions()[0].id).toBe(first.id)
  })
})

describe('Commander tools over MCP', () => {
  it('builds each call with the newest user message of the session, and marks relayed reports', () => {
    const seen: CommanderToolContext[] = []
    const h = createCommanderHarness({
      getTools: (context) => {
        seen.push(context)
        return []
      }
    })
    const session = h.store.createSession()
    h.say(session.id, 'propose a rename')
    h.service.listTools(session.id)
    h.say(session.id, 'Confirm abc123')
    h.service.listTools(session.id)
    h.say(session.id, `${SYSTEM_MESSAGE_MARKER}\nA Captain report arrived.`)
    h.service.listTools(session.id)

    expect(seen).toEqual([
      { sessionId: session.id, userMessage: 'propose a rename', trigger: 'user' },
      { sessionId: session.id, userMessage: 'Confirm abc123', trigger: 'user' },
      { sessionId: session.id, userMessage: '', trigger: 'report' }
    ])
    expect(h.service.listTools('unknown')).toEqual([])
  })

  it('makes a project change only after the user replies with the exact confirmation', async () => {
    const h = createCommanderHarness()
    const session = h.store.createSession()
    h.say(session.id, 'Create a project called Gamma')

    const first = JSON.parse((await h.call(session.id, 'create_project', { name: 'Gamma' })).content)
    expect(first.status).toBe('confirmation_required')
    expect(h.db.getProjects().some((p) => p.name === 'Gamma')).toBe(false)

    // The model cannot confirm on the user's behalf: the user has not said it yet.
    const early = await h.call(session.id, 'create_project', { name: 'Gamma', confirmation_token: first.confirmation_token })
    expect(early.isError).toBe(true)
    expect(h.db.getProjects().some((p) => p.name === 'Gamma')).toBe(false)

    const again = JSON.parse((await h.call(session.id, 'create_project', { name: 'Gamma' })).content)
    h.say(session.id, `Confirm ${again.confirmation_token}`)
    const done = await h.call(session.id, 'create_project', { name: 'Gamma', confirmation_token: again.confirmation_token })
    expect(done.isError).toBeFalsy()
    expect(h.db.getProjects().some((p) => p.name === 'Gamma')).toBe(true)
  })

  it('delegates to each project the user names and stores the delegation for its report', async () => {
    const h = createCommanderHarness()
    const alpha = h.db.createProject({ name: 'Alpha' })!
    const beta = h.db.createProject({ name: 'Beta' })!
    const session = h.store.createSession()
    h.say(session.id, 'Get Alpha to ship the site and Beta to review the API')

    const a = await h.call(session.id, 'ask_captain', { project: 'Alpha', message: 'Ship the site' })
    const b = await h.call(session.id, 'ask_captain', { project: beta.id, message: 'Review the API' })
    expect(a.isError).toBeFalsy()
    expect(b.isError).toBeFalsy()

    expect(h.captainSend).toHaveBeenCalledTimes(2)
    const targets = h.captainSend.mock.calls.map((args) => (args as unknown as [string, string, string])[2]).sort()
    expect(targets).toEqual([h.db.getCoordinatorTask(alpha.id)!.id, h.db.getCoordinatorTask(beta.id)!.id].sort())

    const rows = h.store.listMessages(session.id)
    expect(rows.map((m) => [m.role, m.tool_name, m.project_id])).toEqual([
      ['tool', 'ask_captain', alpha.id],
      ['tool', 'ask_captain', beta.id]
    ])
    expect(rows[0].correlation_id).toMatch(/^cmd-/)
    expect(h.store.findDelegation(rows[1].correlation_id!)).toEqual({ sessionId: session.id, projectId: beta.id })
    expect(h.events.filter((e) => e.type === 'messages_appended')).toHaveLength(2)
  })

  it('serves the tools through the MCP seam, and none without a host', async () => {
    const h = createCommanderHarness()
    const session = h.store.createSession()
    expect(listCommanderMcpTools(session.id)).toEqual([])
    expect((await callCommanderMcpTool(session.id, 'list_projects', {}, 'c')).isError).toBe(true)

    setCommanderToolHost(h.service)
    try {
      const names = listCommanderMcpTools(session.id).map((tool) => tool.name)
      expect(names).toContain('ask_captain')
      expect(names).toContain('list_skills')
      expect(names.some((name) => /task/.test(name))).toBe(false)
      const listed = await callCommanderMcpTool(session.id, 'list_projects', {}, 'c')
      expect(listed.isError).toBeUndefined()
      expect(listed.content[0].text).toContain('Default')
      const unknown = await callCommanderMcpTool(session.id, 'create_task', {}, 'c')
      expect(unknown.isError).toBe(true)
    } finally {
      setCommanderToolHost(null)
    }
  })
})

describe('helpers', () => {
  it('reads the turn context from user text parts only', () => {
    const part = (partId: string, role: string, content: string, partType = 'text') =>
      ({ taskId: 's', partId, seq: 0, role, content, partType, createdAt: 0, updatedAt: 0, rev: 0 })
    expect(turnContextFromTranscript('s', [])).toEqual({ sessionId: 's', userMessage: '', trigger: 'user', userAnchor: '' })
    expect(turnContextFromTranscript('s', [
      part('u1', 'user', ' hello '),
      part('a1', 'assistant', 'hi'),
      part('t1', 'user', 'tool output', 'tool')
    ])).toEqual({ sessionId: 's', userMessage: 'hello', trigger: 'user', userAnchor: 'u1' })
  })

  it('tags only successful object results and builds fallback titles', () => {
    expect(toolResultTags('{"project_id":"p","correlation_id":"cmd-1"}', false)).toEqual({ projectId: 'p', correlationId: 'cmd-1' })
    expect(toolResultTags('{"project_id":"p"}', true)).toEqual({})
    expect(toolResultTags('not json', false)).toEqual({})
    expect(fallbackTitle('   ')).toBe('New session')
    expect(fallbackTitle('Short one')).toBe('Short one')
  })
})

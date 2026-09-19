/**
 * Captain reports back into Commander sessions (#62): routing by
 * correlation id, the open-session relay turn, the unread-only path, the
 * report-ask loop cap, escalations as reports, and the `report_to_commander`
 * route with its coordinator-only guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { CommanderEvent } from '../../shared/commander'
import type { ChatProvider, ChatProviderEvent, ChatProviderRequest } from '../chat/providers/types'
import type { DatabaseManager } from '../database'
import { escalateToCommander, type EscalationEvent } from '../escalation'
import { callToolForScope } from '../mcp-servers/task-management-core'
import { handleTaskRoute } from '../task-api/task-routes'
import { CommanderService } from './commander-service'
import { CommanderStore } from './commander-store'
import { createCommanderProjectTools, type CommanderAgents } from './project-tools'
import { COMMANDER_SUMMARY_PROMPT, COMMANDER_TITLE_PROMPT } from './prompts'
import { deliverCaptainReport, setCaptainReportHandler } from './report-inbox'
import {
  escalationReportText,
  guardReportAsks,
  installCommanderReportBridge,
  MAX_REPORT_ASKS_WITHOUT_USER_TURN,
  REPORT_INBOX_TITLE,
  resolveReportSession
} from './report-tools'

type ModelAnswer = string | { text?: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }
type Reply = (request: ChatProviderRequest) => ModelAnswer

/** A fake provider whose `chat` decides each Commander turn; titles and summaries are fixed text. */
function fakeProvider(chat: Reply = () => 'ok'): ChatProvider & { requests: ChatProviderRequest[] } {
  const requests: ChatProviderRequest[] = []
  let calls = 0
  return {
    id: 'fake',
    model: 'fake-1',
    requests,
    stream(request) {
      requests.push(request)
      const out = request.system === COMMANDER_TITLE_PROMPT ? 'Title' : request.system === COMMANDER_SUMMARY_PROMPT ? 'Summary' : chat(request)
      return (async function* (): AsyncGenerator<ChatProviderEvent> {
        const text = typeof out === 'string' ? out : out.text ?? ''
        if (text) yield { type: 'text_delta', text }
        if (typeof out !== 'string') {
          for (const call of out.toolCalls) yield { type: 'tool_call', ...call, id: `${call.id}-${++calls}` }
          yield { type: 'message_end', stopReason: 'tool_use' }
          return
        }
        yield { type: 'message_end', stopReason: 'end_turn' }
      })()
    }
  }
}

/** The last message of a chat request is the report note when a report started the turn. */
function startedByReport(request: ChatProviderRequest): boolean {
  const last = request.messages[request.messages.length - 1]
  return last?.role === 'user' && last.content.includes('[Report from project')
}

const chatRequests = (provider: { requests: ChatProviderRequest[] }): ChatProviderRequest[] =>
  provider.requests.filter((r) => r.system !== COMMANDER_TITLE_PROMPT && r.system !== COMMANDER_SUMMARY_PROMPT)

let db: DatabaseManager
let store: CommanderStore
let events: CommanderEvent[]
let sendMessage: ReturnType<typeof vi.fn>
let agents: CommanderAgents
let uninstall: (() => void) | null

function makeService(provider: ChatProvider, over: { maxReportAsks?: number } = {}): CommanderService {
  return new CommanderService({
    store,
    emit: (e) => events.push(e),
    createProvider: () => provider,
    getTools: (context) => createCommanderProjectTools({ db, context, agents }),
    ...over
  })
}

function install(service: CommanderService): void {
  uninstall = installCommanderReportBridge({ service, store, getProject: (id) => db.getProject(id) })
}

/** The correlation id inside the relay text a Captain received. */
function correlationOf(relayText: string): string {
  return /correlation_id=(\S+)/.exec(relayText)![1]
}

/** Waits until the session has no running turn and its newest message is an assistant reply. */
async function settled(service: CommanderService, sessionId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(service.activeTurnId(sessionId)).toBeNull()
    expect(store.listMessages(sessionId).at(-1)?.role).toBe('assistant')
  })
}

beforeEach(() => {
  ;({ db } = createTestDb())
  db.createAgent({ name: 'Claude' })
  store = new CommanderStore(db)
  events = []
  sendMessage = vi.fn(async () => ({}))
  agents = {
    getStartQueue: () => [],
    findSessionByTaskId: () => undefined,
    getSessionStatus: () => null,
    getProjectLimitState: () => undefined,
    sendMessage,
    pauseAllProjects: vi.fn(),
    isAllProjectsPaused: () => false
  } as unknown as CommanderAgents
  uninstall = null
})

afterEach(() => {
  uninstall?.()
  setCaptainReportHandler(null)
})

describe('report routing', () => {
  it('delivers two overlapping replies to the sessions that asked, tagged with their projects (#62 acceptance)', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const beta = db.createProject({ name: 'Beta' })!
    const provider = fakeProvider((request) => {
      if (request.messages.some((m) => m.role === 'tool')) return 'Asked.'
      const project = request.messages[0].content.includes('Alpha') ? 'Alpha' : 'Beta'
      return { toolCalls: [{ id: 'c', name: 'ask_captain', input: { project, message: `Do the ${project} thing` } }] }
    })
    const service = makeService(provider)
    install(service)
    const first = store.createSession()
    const second = store.createSession()

    await service.sendUserMessage(first.id, 'Ask Alpha to ship the site').done
    await service.sendUserMessage(second.id, 'Ask Beta to review the API').done
    expect(sendMessage).toHaveBeenCalledTimes(2)
    const alphaId = correlationOf((sendMessage.mock.calls[0] as unknown as [string, string])[1])
    const betaId = correlationOf((sendMessage.mock.calls[1] as unknown as [string, string])[1])
    expect(alphaId).not.toBe(betaId)

    // The Captains answer in the other order, minutes later, through the route the tool uses.
    const betaReply = await handleTaskRoute(db, '/report_to_commander', { project_id: beta.id, message: 'API reviewed: two comments.', correlation_id: betaId })
    const alphaReply = await handleTaskRoute(db, '/report_to_commander', { project_id: alpha.id, message: 'Site shipped.', correlation_id: alphaId })
    expect(betaReply).toMatchObject({ success: true, session_id: second.id, routed_by: 'correlation' })
    expect(alphaReply).toMatchObject({ success: true, session_id: first.id, routed_by: 'correlation' })

    expect(store.listMessages(first.id).at(-1)).toMatchObject({ role: 'report', content: 'Site shipped.', project_id: alpha.id, correlation_id: alphaId })
    expect(store.listMessages(second.id).at(-1)).toMatchObject({ role: 'report', content: 'API reviewed: two comments.', project_id: beta.id, correlation_id: betaId })
    // Neither session is open in the view: both reports are queued unread, no relay turn ran.
    expect(store.getSession(first.id)?.unread_count).toBe(1)
    expect(store.getSession(second.id)?.unread_count).toBe(1)
    expect(chatRequests(provider)).toHaveLength(4)
  })

  it('sends unprompted, unknown-correlation and archived-origin reports to the most recent session, or an inbox when there is none', () => {
    expect(store.listSessions()).toEqual([])
    const inbox = resolveReportSession(store)
    expect(inbox.routedBy).toBe('inbox')
    expect(store.getSession(inbox.sessionId)?.title).toBe(REPORT_INBOX_TITLE)

    const newer = store.createSession('Newer')
    expect(resolveReportSession(store, null)).toEqual({ sessionId: newer.id, routedBy: 'latest' })
    expect(resolveReportSession(store, 'cmd-unknown')).toEqual({ sessionId: newer.id, routedBy: 'latest' })

    // A delegation from an older session routes its reply back there.
    const older = inbox.sessionId
    store.appendMessage(older, { role: 'tool', content: '{"status":"sent"}', toolCallId: 'c1', toolName: 'ask_captain', projectId: null, correlationId: 'cmd-1' })
    // (appending bumps updated_at, so make the other one the most recent again)
    store.appendMessage(newer.id, { role: 'user', content: 'hi' })
    expect(resolveReportSession(store, 'cmd-1')).toEqual({ sessionId: older, routedBy: 'correlation' })
    expect(store.findDelegation('cmd-1')).toEqual({ sessionId: older, projectId: null })

    // Archived origin: the report follows the user instead.
    store.setArchived(older, true)
    expect(resolveReportSession(store, 'cmd-1')).toEqual({ sessionId: newer.id, routedBy: 'latest' })
  })
})

describe('report delivery', () => {
  it('relays a report in the open session with a Commander turn, and only queues it unread elsewhere', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const provider = fakeProvider((request) => (startedByReport(request) ? 'Alpha says the site shipped.' : 'ok'))
    const service = makeService(provider)
    install(service)
    const open = store.createSession('Open')
    const other = store.createSession('Other')
    service.setActiveSession(open.id)

    const delivery = deliverCaptainReport({ projectId: alpha.id, message: 'Site shipped.', correlationId: null, source: 'captain' })
    // The most recent session is `other` (created last), so route there explicitly through the service for the open one.
    expect(delivery).toMatchObject({ delivered: true, sessionId: other.id, relayed: false })
    expect(store.getSession(other.id)?.unread_count).toBe(1)
    expect(chatRequests(provider)).toHaveLength(0)

    const relayed = service.deliverReport({ sessionId: open.id, content: 'Site shipped.', projectId: alpha.id, projectName: 'Alpha' })
    expect(relayed.relayed).toBe(true)
    expect(events.some((e) => e.type === 'turn_started' && e.sessionId === open.id)).toBe(true)
    await settled(service, open.id)

    const messages = store.listMessages(open.id)
    expect(messages.map((m) => m.role)).toEqual(['report', 'assistant'])
    expect(messages[1].content).toBe('Alpha says the site shipped.')
    const [request] = chatRequests(provider)
    expect(request.system).toContain('A report from project "Alpha" has just arrived')
    // The turn is told to summarise in plain language, not to relay (#107).
    expect(request.system).toContain('Summarise it for the user now in plain language')
    expect(request.system).toContain('Leave out issue and PR numbers, branch names')
    expect(request.system).not.toContain('Relay it to the user now')
    expect(request.messages.at(-1)?.content).toContain(`[Report from project ${alpha.id}]\nSite shipped.`)
  })

  it('relays a report that arrives mid-turn once that turn has ended', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const provider = fakeProvider(() => 'answer')
    const slow: ChatProvider = {
      ...provider,
      stream(request, signal) {
        const inner = provider.stream(request, signal)
        return (async function* () {
          if (!startedByReport(request)) await gate
          yield* inner
        })()
      }
    }
    const service = makeService(slow)
    const session = store.createSession()
    service.setActiveSession(session.id)
    const turn = service.sendUserMessage(session.id, 'hello')
    await vi.waitFor(() => expect(chatRequests(provider)).toHaveLength(1))

    const delivery = service.deliverReport({ sessionId: session.id, content: 'Done.', projectId: alpha.id, projectName: 'Alpha' })
    expect(delivery.relayed).toBe(true)
    release()
    await turn.done
    await vi.waitFor(() => expect(chatRequests(provider)).toHaveLength(2))
    await settled(service, session.id)
    expect(store.listMessages(session.id).map((m) => m.role)).toEqual(['user', 'assistant', 'report', 'assistant'])
  })

  it('stores the report unread even when no provider can be built', () => {
    const service = new CommanderService({
      store,
      emit: (e) => events.push(e),
      createProvider: () => {
        throw new Error('No API key')
      }
    })
    const session = store.createSession()
    service.setActiveSession(session.id)
    const delivery = service.deliverReport({ sessionId: session.id, content: 'Done.', projectId: null })
    expect(delivery.relayed).toBe(false)
    expect(store.getSession(session.id)?.unread_count).toBe(1)
  })
})

describe('loop protection', () => {
  it('refuses ask_captain once report-triggered turns have used the budget, until the user speaks', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const provider = fakeProvider((request) => {
      // After its tool result the model answers in text; a turn that a report started delegates once.
      if (request.messages.at(-1)?.role === 'tool') return 'Asked again.'
      if (startedByReport(request)) return { toolCalls: [{ id: 'c', name: 'ask_captain', input: { project: 'Alpha', message: 'Follow up' } }] }
      return 'ok'
    })
    const service = makeService(provider)
    const session = store.createSession()
    service.setActiveSession(session.id)

    for (let i = 0; i < MAX_REPORT_ASKS_WITHOUT_USER_TURN + 1; i++) {
      service.deliverReport({ sessionId: session.id, content: `Report ${i}`, projectId: alpha.id, projectName: 'Alpha' })
      await settled(service, session.id)
    }
    expect(sendMessage).toHaveBeenCalledTimes(MAX_REPORT_ASKS_WITHOUT_USER_TURN)
    const toolRows = store.listMessages(session.id).filter((m) => m.role === 'tool')
    expect(toolRows).toHaveLength(MAX_REPORT_ASKS_WITHOUT_USER_TURN + 1)
    expect(toolRows.at(-1)).toMatchObject({ is_error: true })
    expect(toolRows.at(-1)?.content).toContain('loop_guard')

    // A user turn resets the budget.
    await service.sendUserMessage(session.id, 'thanks').done
    service.deliverReport({ sessionId: session.id, content: 'Another', projectId: alpha.id, projectName: 'Alpha' })
    await settled(service, session.id)
    expect(sendMessage).toHaveBeenCalledTimes(MAX_REPORT_ASKS_WITHOUT_USER_TURN + 1)
  })

  it('guardReportAsks wraps only ask_captain', async () => {
    let used = 0
    const budget = { remaining: () => 1 - used, consume: () => { used += 1 } }
    const handler = vi.fn(async () => 'sent')
    const tools = guardReportAsks(
      [
        { name: 'ask_captain', description: '', inputSchema: { type: 'object' }, handler },
        { name: 'list_projects', description: '', inputSchema: { type: 'object' }, handler: async () => 'list' }
      ],
      budget
    )
    const context = { signal: new AbortController().signal, toolCallId: 't' }
    expect(await tools[0].handler({}, context)).toBe('sent')
    const refused = await tools[0].handler({}, context)
    expect(refused).toMatchObject({ isError: true })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(await tools[1].handler({}, context)).toBe('list')
  })
})

describe('escalations as reports', () => {
  const event = (over: Partial<EscalationEvent>): EscalationEvent => ({
    projectId: 'p', action: 'start_task', level: 'tell_commander', tool: 'start_task', args: {}, summary: 'start "Ship it"', outcome: 'performed', at: '2026-01-01T00:00:00.000Z', ...over
  })

  it('turns a tell_commander escalation into an unprompted project-tagged report (#62 acceptance)', () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    const service = makeService(fakeProvider())
    install(service)
    const session = store.createSession()

    escalateToCommander(event({ projectId: alpha.id }))
    const report = store.listMessages(session.id).at(-1)
    expect(report).toMatchObject({ role: 'report', project_id: alpha.id, correlation_id: null })
    expect(report?.content).toContain('start "Ship it"')
    expect(store.getSession(session.id)?.unread_count).toBe(1)

    // Held and decided ask_user calls are the user's business, not reports.
    escalateToCommander(event({ projectId: alpha.id, level: 'ask_user', outcome: 'held', heldId: 'h1' }))
    expect(store.listMessages(session.id)).toHaveLength(1)
    expect(escalationReportText(event({ level: 'ask_user', outcome: 'approved' }))).toBeNull()
  })
})

describe('report_to_commander route and scope', () => {
  it('validates, refuses without the Commander, and forces the scope project like update_project_status', async () => {
    const alpha = db.createProject({ name: 'Alpha' })!
    expect(await handleTaskRoute(db, '/report_to_commander', { message: 'x' })).toEqual({ error: 'project_id is required' })
    expect(await handleTaskRoute(db, '/report_to_commander', { project_id: alpha.id })).toEqual({ error: 'message is required' })
    expect(await handleTaskRoute(db, '/report_to_commander', { project_id: 'missing', message: 'x' })).toEqual({ error: 'Project not found' })
    expect(await handleTaskRoute(db, '/report_to_commander', { project_id: alpha.id, message: 'x'.repeat(4_001) })).toMatchObject({ error: expect.stringContaining('4000') })
    const refused = await handleTaskRoute(db, '/report_to_commander', { project_id: alpha.id, message: 'hello' }) as { error: string }
    expect(refused.error).toContain('not available')

    const invoke = vi.fn(async () => ({ success: true }))
    const captain = { parentTaskId: null, taskId: null, artifactTaskId: null, projectId: 'p1' }
    const ok = await callToolForScope('report_to_commander', { message: 'Done', project_id: 'other' }, captain, invoke)
    expect(ok.isError).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('/report_to_commander', { message: 'Done', project_id: 'p1' })

    const taskAgent = { parentTaskId: null, taskId: null, artifactTaskId: 't1', projectId: 'p1' }
    const denied = await callToolForScope('report_to_commander', { message: 'Done' }, taskAgent, invoke)
    expect(denied.isError).toBe(true)
    expect(denied.content[0].text).toContain("only the project's Captain")
  })
})

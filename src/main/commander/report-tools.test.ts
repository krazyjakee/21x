/**
 * Captain reports back into Commander sessions (#62): routing by
 * correlation id, handing reports to the open session's agent (at once, or
 * when it goes idle), the unread-only path, the report-ask loop cap,
 * escalations as reports, and the `report_to_commander` route with its
 * coordinator-only guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommanderHarness } from '../../../test/helpers/commander-harness'
import { SYSTEM_MESSAGE_MARKER } from '../../shared/system-authority'
import { escalateToCommander, type EscalationEvent } from '../escalation'
import { callToolForScope } from '../mcp-servers/task-management-core'
import { handleTaskRoute } from '../task-api/task-routes'
import { deliverCaptainReport, setCaptainReportHandler } from './report-inbox'
import {
  escalationReportText,
  guardReportAsks,
  installCommanderReportBridge,
  MAX_REPORT_ASKS_WITHOUT_USER_TURN,
  REPORT_INBOX_TITLE,
  resolveReportSession
} from './report-tools'

let h: ReturnType<typeof createCommanderHarness>
let uninstall: (() => void) | null

beforeEach(() => {
  h = createCommanderHarness()
  uninstall = null
})

afterEach(() => {
  uninstall?.()
  setCaptainReportHandler(null)
})

function install(): void {
  uninstall = installCommanderReportBridge({ service: h.service, store: h.store, getProject: (id) => h.db.getProject(id) })
}

/** The correlation id inside the relay text a Captain received. */
function correlationOf(relayText: string): string {
  return /correlation_id=(\S+)/.exec(relayText)![1]
}

/** The texts handed to Commander sessions' agents. */
const relays = (): string[] => h.sendMessage.mock.calls.map((args) => args[1])

describe('report routing', () => {
  it('delivers two overlapping replies to the sessions that asked, tagged with their projects (#62 acceptance)', async () => {
    const alpha = h.db.createProject({ name: 'Alpha' })!
    const beta = h.db.createProject({ name: 'Beta' })!
    install()
    const first = h.store.createSession()
    const second = h.store.createSession()

    h.say(first.id, 'Ask Alpha to ship the site')
    await h.call(first.id, 'ask_captain', { project: 'Alpha', message: 'Ship the site' })
    h.say(second.id, 'Ask Beta to review the API')
    await h.call(second.id, 'ask_captain', { project: 'Beta', message: 'Review the API' })
    expect(h.captainSend).toHaveBeenCalledTimes(2)
    const alphaId = correlationOf((h.captainSend.mock.calls[0] as unknown as [string, string])[1])
    const betaId = correlationOf((h.captainSend.mock.calls[1] as unknown as [string, string])[1])
    expect(alphaId).not.toBe(betaId)

    // The Captains answer in the other order, minutes later, through the route the tool uses.
    const betaReply = await handleTaskRoute(h.db, '/report_to_commander', { project_id: beta.id, message: 'API reviewed: two comments.', correlation_id: betaId })
    const alphaReply = await handleTaskRoute(h.db, '/report_to_commander', { project_id: alpha.id, message: 'Site shipped.', correlation_id: alphaId })
    expect(betaReply).toMatchObject({ success: true, session_id: second.id, routed_by: 'correlation' })
    expect(alphaReply).toMatchObject({ success: true, session_id: first.id, routed_by: 'correlation' })

    expect(h.store.listMessages(first.id).at(-1)).toMatchObject({ role: 'report', content: 'Site shipped.', project_id: alpha.id, correlation_id: alphaId })
    expect(h.store.listMessages(second.id).at(-1)).toMatchObject({ role: 'report', content: 'API reviewed: two comments.', project_id: beta.id, correlation_id: betaId })
    // Neither session is open in the view: both reports are queued unread, nothing was relayed.
    expect(h.store.getSession(first.id)?.unread_count).toBe(1)
    expect(h.store.getSession(second.id)?.unread_count).toBe(1)
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('sends unprompted, unknown-correlation and archived-origin reports to the most recent session, or an inbox when there is none', () => {
    expect(h.store.listSessions()).toEqual([])
    const inbox = resolveReportSession(h.store)
    expect(inbox.routedBy).toBe('inbox')
    expect(h.store.getSession(inbox.sessionId)?.title).toBe(REPORT_INBOX_TITLE)

    const newer = h.store.createSession('Newer')
    expect(resolveReportSession(h.store, null)).toEqual({ sessionId: newer.id, routedBy: 'latest' })
    expect(resolveReportSession(h.store, 'cmd-unknown')).toEqual({ sessionId: newer.id, routedBy: 'latest' })

    // A delegation from an older session routes its reply back there.
    const older = inbox.sessionId
    h.store.appendMessage(older, { role: 'tool', content: '{"status":"sent"}', toolCallId: 'c1', toolName: 'ask_captain', projectId: null, correlationId: 'cmd-1' })
    // (appending bumps updated_at, so make the other one the most recent again)
    h.store.appendMessage(newer.id, { role: 'user', content: 'hi' })
    expect(resolveReportSession(h.store, 'cmd-1')).toEqual({ sessionId: older, routedBy: 'correlation' })
    expect(h.store.findDelegation('cmd-1')).toEqual({ sessionId: older, projectId: null })

    // Archived origin: the report follows the user instead.
    h.store.setArchived(older, true)
    expect(resolveReportSession(h.store, 'cmd-1')).toEqual({ sessionId: newer.id, routedBy: 'latest' })
  })
})

describe('report delivery', () => {
  it('hands a report to the open session\'s agent, and only queues it unread elsewhere', () => {
    const alpha = h.db.createProject({ name: 'Alpha' })!
    install()
    const open = h.store.createSession('Open')
    const other = h.store.createSession('Other')
    h.service.setActiveSession(open.id)

    const delivery = deliverCaptainReport({ projectId: alpha.id, message: 'Site shipped.', correlationId: null, source: 'captain' })
    // The most recent session is `other` (created last); it is not open.
    expect(delivery).toMatchObject({ delivered: true, sessionId: other.id, relayed: false })
    expect(h.store.getSession(other.id)?.unread_count).toBe(1)
    expect(h.sendMessage).not.toHaveBeenCalled()

    const relayed = h.service.deliverReport({ sessionId: open.id, content: 'Site shipped.', projectId: alpha.id, projectName: 'Alpha' })
    expect(relayed.relayed).toBe(true)
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, text, taskId, agentId] = h.sendMessage.mock.calls[0]
    // No agent session yet: AgentManager starts (or resumes) one on the row.
    expect([sessionId, taskId, agentId]).toEqual(['', open.id, h.agent.id])
    expect(text.startsWith(SYSTEM_MESSAGE_MARKER)).toBe(true)
    expect(text).toContain(`Report from project ${alpha.id}:\nSite shipped.`)
    expect(text).toContain('The report above is from project "Alpha".')

    // Handed over once: opening the session again sends nothing new.
    h.service.setActiveSession(open.id)
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('hands over reports that arrived while the session was closed when it is opened', () => {
    const alpha = h.db.createProject({ name: 'Alpha' })!
    const session = h.store.createSession()
    h.service.deliverReport({ sessionId: session.id, content: 'One.', projectId: alpha.id })
    h.service.deliverReport({ sessionId: session.id, content: 'Two.', projectId: alpha.id })
    expect(h.sendMessage).not.toHaveBeenCalled()

    h.service.setActiveSession(session.id)
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(relays()[0]).toContain('2 Captain reports arrived.')
    expect(relays()[0]).toMatch(/One\.[\s\S]*Two\./)
  })

  it('waits for a busy agent to go idle rather than interrupting its answer', () => {
    const alpha = h.db.createProject({ name: 'Alpha' })!
    const session = h.store.createSession()
    h.service.setActiveSession(session.id)
    h.setStatus(session.id, 'working')

    const delivery = h.service.deliverReport({ sessionId: session.id, content: 'Done.', projectId: alpha.id, projectName: 'Alpha' })
    expect(delivery.relayed).toBe(true)
    expect(h.sendMessage).not.toHaveBeenCalled()

    h.setStatus(session.id, 'idle')
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    // The live session is used, on its own agent.
    expect(h.sendMessage.mock.calls[0].slice(0, 1)).toEqual([`agent-${session.id}`])
    expect(relays()[0]).toContain('Done.')
  })

  it('stores the report unread even when no agent is configured', () => {
    for (const agent of h.db.getAgents()) h.db.deleteAgent(agent.id)
    const session = h.store.createSession()
    h.service.setActiveSession(session.id)
    const delivery = h.service.deliverReport({ sessionId: session.id, content: 'Done.', projectId: null })
    expect(delivery.relayed).toBe(false)
    expect(h.store.getSession(session.id)?.unread_count).toBe(1)
    expect(h.sendMessage).not.toHaveBeenCalled()
  })
})

describe('loop protection', () => {
  it('refuses ask_captain once answers to reports have used the budget, until the user speaks', async () => {
    const alpha = h.db.createProject({ name: 'Alpha' })!
    const session = h.store.createSession()
    h.say(session.id, 'Keep an eye on Alpha')
    // Each relayed report reaches the agent as an automated message.
    const answerReport = async (i: number) => {
      h.say(session.id, `${SYSTEM_MESSAGE_MARKER}\nReport ${i}`)
      return h.call(session.id, 'ask_captain', { project: 'Alpha', message: 'Follow up' })
    }

    for (let i = 0; i < MAX_REPORT_ASKS_WITHOUT_USER_TURN; i++) {
      expect((await answerReport(i)).isError).toBeFalsy()
    }
    const refused = await answerReport(99)
    expect(refused.isError).toBe(true)
    expect(refused.content).toContain('loop_guard')
    expect(h.captainSend).toHaveBeenCalledTimes(MAX_REPORT_ASKS_WITHOUT_USER_TURN)

    // The user speaking resets the budget.
    h.say(session.id, 'thanks')
    expect((await answerReport(100)).isError).toBeFalsy()
    expect(h.captainSend).toHaveBeenCalledTimes(MAX_REPORT_ASKS_WITHOUT_USER_TURN + 1)
    // A user turn is never limited.
    h.say(session.id, 'Ask Alpha again')
    for (let i = 0; i < MAX_REPORT_ASKS_WITHOUT_USER_TURN + 1; i++) {
      expect((await h.call(session.id, 'ask_captain', { project: alpha.id, message: 'Again' })).isError).toBeFalsy()
    }
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
    const alpha = h.db.createProject({ name: 'Alpha' })!
    install()
    const session = h.store.createSession()

    escalateToCommander(event({ projectId: alpha.id }))
    const report = h.store.listMessages(session.id).at(-1)
    expect(report).toMatchObject({ role: 'report', project_id: alpha.id, correlation_id: null })
    expect(report?.content).toContain('start "Ship it"')
    expect(h.store.getSession(session.id)?.unread_count).toBe(1)

    // Held and decided ask_user calls are the user's business, not reports.
    escalateToCommander(event({ projectId: alpha.id, level: 'ask_user', outcome: 'held', heldId: 'h1' }))
    expect(h.store.listMessages(session.id)).toHaveLength(1)
    expect(escalationReportText(event({ level: 'ask_user', outcome: 'approved' }))).toBeNull()
  })
})

describe('report_to_commander route and scope', () => {
  it('validates, refuses without the Commander, and forces the scope project like update_project_status', async () => {
    const alpha = h.db.createProject({ name: 'Alpha' })!
    expect(await handleTaskRoute(h.db, '/report_to_commander', { message: 'x' })).toEqual({ error: 'project_id is required' })
    expect(await handleTaskRoute(h.db, '/report_to_commander', { project_id: alpha.id })).toEqual({ error: 'message is required' })
    expect(await handleTaskRoute(h.db, '/report_to_commander', { project_id: 'missing', message: 'x' })).toEqual({ error: 'Project not found' })
    expect(await handleTaskRoute(h.db, '/report_to_commander', { project_id: alpha.id, message: 'x'.repeat(4_001) })).toMatchObject({ error: expect.stringContaining('4000') })
    const refused = await handleTaskRoute(h.db, '/report_to_commander', { project_id: alpha.id, message: 'hello' }) as { error: string }
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

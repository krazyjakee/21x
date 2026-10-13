import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { AgentManager } from './agent-manager-core'
import type { AgentManagerHost } from './agent-manager/host'
import { SessionStatusType, type SessionStatus } from './adapters/coding-agent-adapter'

vi.mock('./agent-manager/workspace-docs', async original => ({
  ...await original<typeof import('./agent-manager/workspace-docs')>(), writeSkillFiles: vi.fn(async () => undefined)
}))

type Session = NonNullable<ReturnType<AgentManager['getSession']>>
type Internals = { transitionToIdle(id: string, session: Session): Promise<void> }
const resources: Array<{ manager: AgentManager; db: ReturnType<typeof createPortableTestDb>; directory: string }> = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }))
afterEach(async () => {
  for (const { manager, db, directory } of resources.splice(0)) {
    await manager.stopAllSessions(); db.close(); rmSync(directory, { recursive: true, force: true })
  }
  vi.useRealTimers(); vi.restoreAllMocks()
})

async function fixture(captain = true) {
  const db = createPortableTestDb()
  const directory = mkdtempSync(join(tmpdir(), 'activity-outcome-'))
  const agent = db.createAgent({ name: 'Outcome fixture', config: { coding_agent: 'codex', model: 'fixture' } })!
  const project = db.createProject({ name: 'Outcome project', captain_agent_id: agent.id })!
  const task = captain ? db.getCoordinatorTask(project.id)! : db.createTask({ title: 'Ordinary task', project_id: project.id })!
  if (!captain) db.updateTask(task.id, { agent_id: agent.id })
  const adapter = new FakeAdapter({ status: SessionStatusType.IDLE })
  const statuses: Array<Record<string, unknown>> = []
  const host: AgentManagerHost = {
    renderer: { kind: 'native', send(_target, channel, ...args) { if (channel === 'agent:status') statuses.push(args[0] as Record<string, unknown>); return true } },
    notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' },
    configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => adapter, isCodexAppServerAdapter: () => true
  }
  const manager = new AgentManager(db, host)
  resources.push({ manager, db, directory })
  manager.setMainWindow({ isDestroyed: () => false, isFocused: () => true, show() {}, focus() {}, webContents: { send() {} } })
  const id = await manager.startSession(agent.id, task.id, directory, true)
  const session = manager.getSession(id)!
  return { db, task, adapter, manager, id, session, statuses, internal: manager as unknown as Internals }
}

describe('authoritative activity terminal outcomes', () => {
  it('distinguishes a verified Captain reply from manual abort and Stop', async () => {
    const h = await fixture()
    await h.internal.transitionToIdle(h.id, h.session)
    expect(h.statuses.at(-1)).toMatchObject({ status: 'idle', activityOutcome: 'completed' })
    await h.manager.sendMessage(h.id, 'Another controlled turn', h.task.id, h.session.agentId)
    await h.manager.abortSession(h.id)
    expect(h.statuses.at(-1)).toMatchObject({ status: 'idle', activityOutcome: 'cancelled' })
    await h.manager.sendMessage(h.id, 'A stopped controlled turn', h.task.id, h.session.agentId)
    await h.manager.stopByTaskId(h.task.id)
    expect(h.statuses.at(-1)).toMatchObject({ status: 'idle', activityOutcome: 'cancelled' })
    expect(h.statuses.filter(status => status.activityOutcome === 'completed')).toHaveLength(1)
  })

  it('does not claim idle or successful completion when the final native verification disconnects', async () => {
    const h = await fixture(false)
    h.statuses.length = 0
    h.adapter.getStatus.mockRejectedValueOnce(new Error('Connection closed'))
    await h.internal.transitionToIdle(h.id, h.session)
    expect(h.session.status).toBe('working')
    expect(h.db.getTask(h.task.id)?.status).toBe('agent_working')
    expect(h.statuses).toContainEqual(expect.objectContaining({ disconnected: true, heartbeat: true }))
    expect(h.statuses.some(status => status.status === 'idle' || status.activityOutcome === 'completed')).toBe(false)
  })

  it('routes a verified native error to failure instead of a successful idle result', async () => {
    const h = await fixture()
    h.adapter.setStatus(SessionStatusType.ERROR, 'Synthetic terminal failure')
    await h.internal.transitionToIdle(h.id, h.session)
    expect(h.session.status).toBe('error')
    expect(h.statuses.at(-1)).toMatchObject({ status: 'error', activityOutcome: 'failed' })
    expect(h.statuses.some(status => status.activityOutcome === 'completed')).toBe(false)
  })

  it('fences a late final-idle read after acknowledged Stop', async () => {
    const h = await fixture(false)
    let resolve!: (status: SessionStatus) => void
    h.adapter.getStatus.mockImplementationOnce(() => new Promise<SessionStatus>(done => { resolve = done }))
    const settling = h.internal.transitionToIdle(h.id, h.session)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await h.manager.stopByTaskId(h.task.id)
    resolve({ type: SessionStatusType.IDLE }); await settling
    expect(h.db.getTask(h.task.id)?.status).toBe('not_started')
    expect(h.manager.getSession(h.id)).toBeUndefined()
    expect(h.statuses.some(status => status.activityOutcome === 'completed')).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { CaptainWaker, type CaptainWakerAgents } from './captain-waker'
import type { ProjectEvent } from './project-events'
import { AdapterEngine } from './sessions/adapter-engine'
import { captainWakeIdentity } from './sessions/roles/captain'

const owners: Array<{ db: ReturnType<typeof createPortableTestDb>; engine: AdapterEngine; waker: CaptainWaker }> = []
afterEach(async () => {
  for (const { db, engine, waker } of owners.splice(0)) { await waker.close(); engine.shutdown(); db.close() }
  vi.restoreAllMocks()
})
function fixture() {
  const db = createPortableTestDb()
  db.setSetting('sessions.captain_managed', 'true')
  const agent = db.createAgent({ name: 'Captain agent', is_default: true })!
  const project = db.createProject({ name: 'Wake project', captain_agent_id: agent.id })!
  const captain = db.getCoordinatorTask(project.id)!
  const engine = new AdapterEngine(db.db, 'wake-process')
  let now = 1000
  const live = { status: 'idle' as 'idle' | 'working', agentId: agent.id }
  const sendMessage = vi.fn(async () => ({}))
  const deliverCaptainWake = vi.fn(async (_sessionId: string, message: string, ownerId: string, _agentId: string, identity: string, count: number) => {
    await engine.recordWake(ownerId, 'backend', identity, message)
    await engine.recordWakeDisposition(ownerId, 'backend', identity, 'delivered', count)
    return {}
  })
  const recordDroppedCaptainWake = vi.fn<NonNullable<CaptainWakerAgents['recordDroppedCaptainWake']>>(async (ownerId, identity, disposition, count) => {
    await engine.recordWakeDisposition(ownerId, 'backend', identity, disposition, count)
  })
  const agents = { findSessionByTaskId: () => ({ sessionId: 'backend', session: live }), sendMessage,
    deliverCaptainWake, recordDroppedCaptainWake } as unknown as CaptainWakerAgents
  const waker = new CaptainWaker(db, agents, { now: () => now, maxDeferMs: 100, hourlyCap: 1,
    setTimer: () => 1, clearTimer: () => {} })
  owners.push({ db, engine, waker })
  const event = (at = '2026-10-13T12:00:00Z'): ProjectEvent => ({ projectId: project.id, taskId: 'task-1', title: 'Finished task', kind: 'task_ready_for_review', at })
  return { db, engine, waker, live, sendMessage, deliverCaptainWake, recordDroppedCaptainWake, project, captain, event,
    advance: (ms: number) => { now += ms } }
}

describe('managed Captain wake batches', () => {
  it('forwards stable transport identity, independent of event order, with later occurrences kept distinct', async () => {
    const h = fixture()
    const first = h.event()
    const second = { ...first, taskId: 'task-2' }
    h.waker.handleEvent(first); h.waker.handleEvent(second)
    await h.waker.flush(h.project.id)
    expect(h.deliverCaptainWake).toHaveBeenCalledOnce()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.deliverCaptainWake.mock.calls[0][4]).toBe(captainWakeIdentity(h.captain.id, [second, first]))
    expect(h.deliverCaptainWake.mock.calls[0][5]).toBe(2)
    expect(captainWakeIdentity(h.captain.id, [first])).not.toBe(captainWakeIdentity(h.captain.id, [h.event('2026-10-13T12:01:00Z')]))
  })

  it('persists stale batch disposition and never interrupts a busy Captain', async () => {
    const h = fixture()
    h.live.status = 'working'
    h.waker.handleEvent(h.event())
    await h.waker.flush(h.project.id)
    expect(h.recordDroppedCaptainWake).not.toHaveBeenCalled()
    h.advance(101)
    await h.waker.flush(h.project.id)
    expect(h.recordDroppedCaptainWake).toHaveBeenCalledWith(h.captain.id, captainWakeIdentity(h.captain.id, [h.event()]), 'stale', 1)
    const row = h.db.db.prepare("SELECT payload FROM session_lifecycle_events WHERE event_type='wake_disposition'").get() as { payload: string }
    expect(JSON.parse(row.payload)).toMatchObject({ disposition: 'stale', count: 1 })
    expect(h.deliverCaptainWake).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.waker.pendingEvents(h.project.id)).toEqual([])
  })

  it('records hourly-cap drops after the accepted batch without starting another delivery', async () => {
    const h = fixture()
    h.waker.handleEvent(h.event())
    await h.waker.flush(h.project.id)
    h.waker.handleEvent(h.event('2026-10-13T12:01:00Z'))
    await h.waker.flush(h.project.id)
    expect(h.deliverCaptainWake).toHaveBeenCalledOnce()
    expect(h.recordDroppedCaptainWake).toHaveBeenCalledWith(h.captain.id, expect.any(String), 'hourly_cap', 1)
    expect(h.db.db.prepare("SELECT COUNT(*) AS count FROM session_lifecycle_events WHERE payload LIKE '%hourly_cap%'").get()).toEqual({ count: 1 })
  })
})

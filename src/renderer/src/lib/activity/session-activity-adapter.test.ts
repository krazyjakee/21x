import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVITY_REVALIDATE_MS, ACTIVITY_STALE_MS } from '@shared/activity'
import { deriveActivity } from './derive-activity'
import {
  __resetSessionActivity,
  captainEvidence,
  onSessionTransition,
  queueFromState,
  recordAgentStatus,
  recordStartQueue,
  taskEvidence,
  useSessionActivityStore,
  type SessionTransition
} from './session-activity-adapter'
import { summarizeProjectActivity } from './use-activity'

const status = (taskId: string, s: string, seq?: number, extra: Record<string, unknown> = {}) => ({
  sessionId: `s-${taskId}`,
  agentId: 'a',
  taskId,
  status: s,
  ...(seq !== undefined ? { epoch: 'E1', seq } : {}),
  ...extra
})

const derive = (taskId: string, now: number) =>
  deriveActivity(taskEvidence({ session: useSessionActivityStore.getState().sessions[taskId] }), now)

beforeEach(() => __resetSessionActivity())
afterEach(() => __resetSessionActivity())

describe('recordAgentStatus', () => {
  it('rejects malformed pushes', () => {
    expect(recordAgentStatus(null, 0)).toBe(false)
    expect(recordAgentStatus({ taskId: 't', status: 'bogus' }, 0)).toBe(false)
    expect(recordAgentStatus({ status: 'working' }, 0)).toBe(false)
  })

  it('a quiet session stays fresh on heartbeats and goes unknown when they stop', () => {
    recordAgentStatus(status('t', 'working', 1), 0)
    // Successful polls publish a heartbeat every 5 s with no new output.
    for (let i = 1; i <= 6; i++) recordAgentStatus(status('t', 'working', 1 + i, { heartbeat: true }), i * ACTIVITY_REVALIDATE_MS)
    const lastBeat = 6 * ACTIVITY_REVALIDATE_MS
    expect(derive('t', lastBeat + ACTIVITY_STALE_MS - 1).state).toBe('running')
    // Failed or hung polls publish nothing: unknown within 15 s.
    const r = derive('t', lastBeat + ACTIVITY_STALE_MS)
    expect(r.state).toBe('unknown')
    expect(r.lastKnown).toBe('running')
  })

  it('rejects late or replayed pushes within an epoch', () => {
    recordAgentStatus(status('t', 'working', 5), 1_000)
    expect(recordAgentStatus(status('t', 'working', 5, { heartbeat: true }), 20_000)).toBe(false)
    expect(recordAgentStatus(status('t', 'idle', 3), 20_000)).toBe(false)
    expect(useSessionActivityStore.getState().sessions.t).toMatchObject({ status: 'working', observedAt: 1_000 })
  })

  it('accepts a new epoch (main restarted) even with a lower sequence', () => {
    recordAgentStatus(status('t', 'working', 50), 0)
    expect(recordAgentStatus({ ...status('t', 'idle'), epoch: 'E2', seq: 1 }, 10)).toBe(true)
    expect(useSessionActivityStore.getState()).toMatchObject({ epoch: 'E2', seq: 1 })
  })

  it('emits transitions but not first sightings or unchanged heartbeats', () => {
    const seen: SessionTransition[] = []
    const off = onSessionTransition((t) => seen.push(t))
    recordAgentStatus(status('t', 'working', 1), 0)
    recordAgentStatus(status('t', 'working', 2, { heartbeat: true }), 5)
    recordAgentStatus(status('t', 'waiting_approval', 3), 10)
    off()
    expect(seen).toEqual([{ taskId: 't', from: 'working', to: 'waiting_approval', at: 10 }])
  })
})

describe('evidence builders', () => {
  it('a Captain turn end is a finished outcome; a failure is failed', () => {
    recordAgentStatus(status('cap', 'working', 1), 0)
    recordAgentStatus(status('cap', 'idle', 2), 100)
    const done = deriveActivity(captainEvidence(useSessionActivityStore.getState().sessions.cap), 200)
    expect(done).toMatchObject({ state: 'finished', label: 'Reply finished' })
    recordAgentStatus(status('cap', 'error', 3), 300)
    expect(deriveActivity(captainEvidence(useSessionActivityStore.getState().sessions.cap), 400).state).toBe('failed')
  })

  it('queue evidence is undefined before the first read and null for "not queued"', () => {
    expect(queueFromState('t', {}, null)).toBeUndefined()
    recordStartQueue([{ taskId: 'q', reason: 'global_pause', position: 1 }], 50)
    const s = useSessionActivityStore.getState()
    expect(queueFromState('t', s.queue, s.queueObservedAt)).toBeNull()
    expect(queueFromState('q', s.queue, s.queueObservedAt)).toEqual({ reason: 'global_pause', position: 1, observedAt: 50 })
  })
})

describe('summarizeProjectActivity (status bar)', () => {
  it('counts only fresh running sessions as running, scoped to the project', () => {
    recordAgentStatus(status('run', 'working', 1), 0)
    recordAgentStatus(status('wait', 'working', 2), 0)
    recordAgentStatus(status('wait', 'waiting_approval', 3), 0)
    recordAgentStatus(status('err', 'working', 4), 0)
    recordAgentStatus(status('err', 'error', 5), 0)
    recordAgentStatus(status('other-project', 'working', 6), 0)
    recordAgentStatus(status('old', 'working', 7), -ACTIVITY_STALE_MS)
    recordStartQueue([{ taskId: 'queued', reason: 'project_limit' }], 0)
    const ids = new Set(['run', 'wait', 'err', 'old', 'queued'])
    const { summary, expiresAt } = summarizeProjectActivity(ids, useSessionActivityStore.getState(), 1_000)
    expect(summary).toEqual({ running: 1, needsInput: 1, queued: 1, failed: 1, unavailable: 1 })
    expect(expiresAt).toBe(ACTIVITY_STALE_MS)
  })
})

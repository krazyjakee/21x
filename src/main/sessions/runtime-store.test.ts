import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { CaptainRuntimeStore } from './runtime-store'

describe('CaptainRuntimeStore', () => {
  it('fences late generations and records retry lifecycle', () => {
    const { db } = createTestDb()
    let now = 1_000
    const store = new CaptainRuntimeStore(db, () => now)
    const project = db.createProject({ name: 'Runtime' })!
    const owner = db.getCoordinatorTask(project.id)!.id
    const agentA = db.createAgent({ name: 'A' })!
    const agentB = db.createAgent({ name: 'B' })!

    const first = store.begin({ ownerId: owner, projectId: project.id, agentId: agentA.id, deadlineAt: 2_000 })
    now++
    const retry = store.begin({ ownerId: owner, projectId: project.id, agentId: agentB.id, lastGoodAgentId: agentA.id, deadlineAt: 2_001, retry: true })
    expect(retry).toMatchObject({ generation: 2, attemptCount: 2, phase: 'retrying', candidateAgentId: agentB.id, lastGoodAgentId: agentA.id })
    expect(store.transition(owner, first.generation, 'healthy', { sessionId: 'late' })).toBeNull()
    expect(store.transition(owner, retry.generation, 'healthy', {
      sessionId: 'current', candidateAgentId: null, lastGoodAgentId: agentB.id, probeOk: true
    })).toMatchObject({ phase: 'healthy', sessionId: 'current', probeOk: true })
  })

  it('turns stale startup state into a visible timeout after restart', () => {
    const { db } = createTestDb()
    let now = 4_000
    const project = db.createProject({ name: 'Stale' })!
    const owner = db.getCoordinatorTask(project.id)!.id
    const agent = db.createAgent({ name: 'A' })!
    const store = new CaptainRuntimeStore(db, () => now)
    store.begin({ ownerId: owner, projectId: project.id, agentId: agent.id, deadlineAt: 4_100 })

    now = 4_101
    expect(store.expireStale()).toMatchObject([{
      ownerId: owner,
      phase: 'timed_out',
      errorCode: 'STARTUP_TIMEOUT',
      probeOk: false,
      deadlineAt: null
    }])
    expect(store.expireStale()).toEqual([])
  })
})

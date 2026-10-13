import { describe, expect, it } from 'vitest'
import { AGENT_RECOVERY_ERROR } from './agent-desktop-codecs'
import { PRODUCTION_AGENT_EVENT_CODECS } from './production-agent-events'

const row = (index: number) => ({ id: `queue-${index}`, taskId: `task-${index}`, projectId: 'project-id', agentId: 'agent-id', reason: 'agent_limit', queuedAt: '2026-10-13T12:00:00.000Z',
  position: index + 1, priority: null, state: 'queued', retryCount: 0, nextRetryAt: null, generation: 1, dependencyReason: null, recoveryCause: null, recoveryAction: null, recoveryResult: null, lastError: null })

describe('production queue event projection', () => {
  it('retains concurrent queue rows and terminal position zero while removing private failure details', () => {
    const codec = PRODUCTION_AGENT_EVENT_CODECS['agent:startQueueChanged']
    const wire = codec.encodePayload({ queue: [row(0), row(1), { ...row(2), state: 'failed', position: 0, lastError: 'private provider response' }], failed: { taskId: 'task-2', error: 'private credential path' } })
    expect(codec.decodePayload(wire)).toMatchObject({ queue: [{ position: 1 }, { position: 2 }, { position: 0, lastError: AGENT_RECOVERY_ERROR }], failed: { error: AGENT_RECOVERY_ERROR } })
    expect(JSON.stringify(wire)).not.toContain('private')
    expect(() => codec.encodePayload({ queue: Array.from({ length: 513 }, (_, index) => row(index)) })).toThrow()
    expect(() => codec.encodePayload({ queue: [row(0)], failed: { taskId: '../foreign', error: 'failure' } })).toThrow()
  })
  it('retains actual recovery outcomes and rejects undeclared authority instead of copying it', () => {
    const codec = PRODUCTION_AGENT_EVENT_CODECS['agent:recoveryStateChanged']
    const source = { taskId: 'task-id', cause: 'quota', action: 'switch_agent', result: 'failed', error: 'private provider body' }
    expect(codec.decodePayload(codec.encodePayload(source))).toEqual({ ...source, error: AGENT_RECOVERY_ERROR })
    expect(() => codec.encodePayload({ ...source, authority: 'all_tasks' })).toThrow()
  })
})

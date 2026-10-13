import { describe, expect, it } from 'vitest'
import { AGENT_COMMAND_CODECS as codecs, AGENT_EVENT_CODECS as events, AGENT_RECOVERY_ERROR } from './agent-desktop-codecs'

describe('retained synthetic agent desktop codecs', () => {
  it('requires approval request identity despite the legacy optional parameter', () => {
    expect(() => codecs['agentSession:approve'].encodeArguments(['session-1', true])).toThrow()
    expect(() => codecs['agentSession:approve'].decodeArguments({ sessionId: 'session-1', approved: true })).toThrow()
    for (const requestId of ['', '  ', '\0request']) expect(() => codecs['agentSession:approve'].decodeArguments({ sessionId: 'session-1', approved: true, requestId })).toThrow()
    expect(codecs['agentSession:approve'].encodeArguments(['session-1', false, undefined, 'permission', 'request-1'])).toEqual({ sessionId: 'session-1', approved: false, responseType: 'permission', requestId: 'request-1' })
    expect(codecs['agentSession:approve'].decodeArguments({ sessionId: 'session-1', approved: true, requestId: 'request-1' })).toEqual(['session-1', true, undefined, undefined, 'request-1'])
  })

  it('preserves only declared optional slots and denies renderer workspace paths', () => {
    expect(codecs['agentSession:start'].encodeArguments(['agent-1', 'task-1', undefined, false])).toEqual({ agentId: 'agent-1', taskId: 'task-1', skipInitialPrompt: false })
    expect(codecs['agentSession:start'].decodeArguments({ agentId: 'agent-1', taskId: 'task-1', skipInitialPrompt: true })).toEqual(['agent-1', 'task-1', undefined, true])
    expect(() => codecs['agentSession:start'].encodeArguments(['agent-1', 'task-1', '/untrusted'])).toThrow()
    expect(() => codecs['agentSession:start'].decodeArguments({ agentId: 'agent-1', taskId: 'task-1', workspaceDir: '/untrusted' })).toThrow()
    expect(() => codecs['agentSession:resume'].decodeArguments({ agentId: 'agent-1', taskId: 'task-1', sessionId: 'session-1', taskScope: 'foreign' })).toThrow()
    expect(codecs['agentSession:resume'].decodeArguments({ agentId: 'agent-1', taskId: 'task-1', sessionId: 'session-1' })).toEqual(['agent-1', 'task-1', 'session-1'])
  })

  it('keeps exact start/resume/success response unions', () => {
    expect(codecs['agentSession:start'].validateResult({ sessionId: 'session-1' })).toBe(true)
    expect(codecs['agentSession:start'].validateResult({ sessionId: '', queued: true, queuePosition: 1, queueReason: 'agent_limit' })).toBe(true)
    expect(codecs['agentSession:start'].validateResult({ sessionId: '' })).toBe(false)
    expect(codecs['agentSession:start'].validateResult({ sessionId: 'session-1', queued: true, queuePosition: 1, queueReason: 'agent_limit' })).toBe(false)
    expect(codecs['agentSession:resume'].validateResult({ sessionId: '', ended: true })).toBe(true)
    expect(codecs['agentSession:approve'].validateWireResult({ defined: false })).toBe(false)
    expect(codecs['agentSession:approve'].validateWireResult({ defined: true, value: { success: true, diagnostic: 'private' } })).toBe(false)
  })

  it('validates activity metadata separately from service sequence and fails unsupported critical shapes', () => {
    const status = { sessionId: 'session-1', agentId: 'agent-1', taskId: 'task-1', status: 'waiting_approval' }
    expect(events['agent:status'].validatePayload(status)).toBe(true)
    expect(events['agent:status'].validatePayload({ ...status, epoch: 'owner:1', seq: 1, heartbeat: true })).toBe(true)
    for (const activityOutcome of ['completed', 'cancelled', 'interrupted']) {
      expect(events['agent:status'].validatePayload({ ...status, status: 'idle', epoch: 'owner:1', seq: 2, activityOutcome })).toBe(true)
    }
    expect(events['agent:status'].validatePayload({ ...status, status: 'error', epoch: 'owner:1', seq: 2, activityOutcome: 'failed' })).toBe(true)
    for (const extra of [{ activityOutcome: 'completed' }, { epoch: 'owner:1', seq: 2, activityOutcome: 'completed' }, { status: 'idle', epoch: 'owner:1', seq: 2, activityOutcome: 'failed' }, { status: 'idle', epoch: 'owner:1', seq: 2, activityOutcome: 'completed', heartbeat: true }]) {
      expect(events['agent:status'].validatePayload({ ...status, ...extra })).toBe(false)
    }
    for (const extra of [{ epoch: 'owner:1' }, { seq: 1 }, { epoch: 'owner:1', seq: 0 }, { heartbeat: true }, { epoch: 'owner:1', seq: 1, heartbeat: false }, { secret: 'private' }]) {
      expect(events['agent:status'].validatePayload({ ...status, ...extra })).toBe(false)
    }
    expect(events['agent:startQueueChanged'].validatePayload({ queue: [] })).toBe(true)
    expect(events['agent:startQueueChanged'].validatePayload({ queue: [{ taskId: 'task-1' }] })).toBe(false)
    const row = { id: 'claim-1', taskId: 'task-1', projectId: 'project-1', agentId: 'agent-1', reason: 'recovery', queuedAt: '2026-01-01', position: 1, priority: 'medium', state: 'starting', retryCount: 0, nextRetryAt: null, generation: 1, dependencyReason: null, recoveryCause: null, recoveryAction: 'start_session', recoveryResult: 'start_invoked', lastError: null }
    expect(events['agent:startQueueChanged'].validatePayload({ queue: [row] })).toBe(true)
    expect(events['agent:startQueueChanged'].validatePayload({ queue: [row, row] })).toBe(false)
    expect(events['agent:startQueueChanged'].validatePayload({ queue: [{ ...row, leaseOwner: 'private' }] })).toBe(false)
    expect(events['agent:startQueueChanged'].validatePayload({ queue: [{ ...row, lastError: 'private diagnostic' }] })).toBe(false)
    expect(events['agent:recoveryStateChanged'].validatePayload({ taskId: 'task-1', cause: 'manual_stop', action: 'exclude_from_retry', result: 'manual_stop_not_retried', error: AGENT_RECOVERY_ERROR })).toBe(true)
    expect(events['agent:recoveryStateChanged'].validatePayload({ taskId: 'task-1', cause: 'manual_stop', action: 'exclude_from_retry', result: 'manual_stop_not_retried', error: 'private diagnostic' })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { AGENT_RECOVERY_ERROR } from './agent-desktop-codecs'
import { PRODUCTION_AGENT_CODECS, PRODUCTION_AGENT_LIMITS, PRODUCTION_AGENT_OPERATIONS, isBoundedProductionAgentJson, projectProductionAgentQueue } from './production-agent-codecs'
import type { JsonValue } from './service-protocol'

const queueRow = () => ({ id: 'queue-id', taskId: 'task-id', projectId: 'project-id', agentId: 'agent-id', reason: 'agent_limit', queuedAt: '2026-10-13T12:00:00.000Z',
  position: 1, priority: null, state: 'queued', retryCount: 0, nextRetryAt: null, generation: 1, dependencyReason: null, recoveryCause: null, recoveryAction: null, recoveryResult: null, lastError: null })
const runtime = () => ({ ownerId: 'captain-id', projectId: 'project-id', generation: 1, agentId: 'agent-id', candidateAgentId: null, lastGoodAgentId: 'agent-id', sessionId: 'native-id',
  phase: 'healthy', deadlineAt: null, lastProbeAt: 1, probeOk: true, attemptCount: 0, errorCode: null, errorDetail: null, createdAt: 1, updatedAt: 2 })

describe('production agent finite bounded codecs', () => {
  it('declares exact lifecycle operations without borrowing agent configuration, transcript pagination or installer authority', () => {
    expect(PRODUCTION_AGENT_OPERATIONS).toHaveLength(17)
    expect(Object.keys(PRODUCTION_AGENT_CODECS)).toEqual([...PRODUCTION_AGENT_OPERATIONS])
    expect(PRODUCTION_AGENT_OPERATIONS).not.toContain('agent:update')
    expect(PRODUCTION_AGENT_OPERATIONS).not.toContain('agentSession:getTranscriptPage')
  })
  it('roundtrips positional optionals while refusing workspace paths, extra keys and absent approval identity', () => {
    const start = PRODUCTION_AGENT_CODECS['agentSession:start']
    expect(start.decodeArguments(start.encodeArguments(['agent-id', 'task-id', undefined, true]))).toEqual(['agent-id', 'task-id', undefined, true])
    expect(() => start.decodeArguments({ agentId: 'agent-id', taskId: 'task-id', workspaceDir: '/from-renderer' })).toThrow('Invalid operation arguments')
    expect(() => start.decodeArguments({ agentId: 'agent-id', taskId: 'task-id', unexpected: true })).toThrow('Invalid operation arguments')
    const approval = PRODUCTION_AGENT_CODECS['agentSession:approve']
    expect(approval.encodeArguments(['native-id', true, undefined, 'question', 'request:1'])).toEqual({ sessionId: 'native-id', approved: true, responseType: 'question', requestId: 'request:1' })
    expect(() => approval.decodeArguments({ sessionId: 'native-id', approved: true })).toThrow('Invalid operation arguments')
    expect(() => approval.decodeArguments({ sessionId: 'native-id', approved: true, requestId: 'request:1', responseType: 'other' })).toThrow('Invalid operation arguments')
  })
  it('bounds UTF-8 instructions and attachment metadata without truncating an oversized protected instruction', () => {
    const send = PRODUCTION_AGENT_CODECS['agentSession:sendByTaskId']
    expect(() => send.encodeArguments(['task-id', 'x'.repeat(PRODUCTION_AGENT_LIMITS.message + 1)])).toThrow('Invalid operation arguments')
    expect(send.encodeArguments(['task-id', '😀'.repeat(PRODUCTION_AGENT_LIMITS.message / 2)])).toMatchObject({ taskId: 'task-id' })
    expect(isBoundedProductionAgentJson({ text: '😀'.repeat(PRODUCTION_AGENT_LIMITS.bytes / 2) })).toBe(false)
    expect(() => send.decodeArguments({ taskId: 'task-id', message: 'hello', attachments: [{ id: 'file-id', filename: 'file', size: 1, mime_type: 'text/plain', path: '/foreign' }] })).toThrow('Invalid operation arguments')
    const file = { id: 'file-id', filename: 'file.txt', size: 1, mime_type: 'text/plain' }
    expect(() => send.decodeArguments({ taskId: 'task-id', message: 'hello', attachments: [file, file] })).toThrow('Invalid operation arguments')
    expect(send.decodeArguments({ taskId: 'task-id', message: 'hello', attachments: [file], deliveryId: 'intent:1' })).toEqual(['task-id', 'hello', [file], 'intent:1'])
  })
  it('preserves active queue positions and terminal position zero, sanitizing provider error text', () => {
    const codec = PRODUCTION_AGENT_CODECS['agent:getStartRecoveryState']
    const source = { ...queueRow(), position: 0, state: 'failed', lastError: 'private provider request body' }
    const wire = codec.encodeResult(source)
    expect(wire).toMatchObject({ defined: true, value: { position: 0, state: 'failed', lastError: AGENT_RECOVERY_ERROR } })
    expect(codec.validateWireResult(wire)).toBe(true)
    expect(JSON.stringify(wire)).not.toContain('private provider')
    expect(codec.encodeResult(null)).toEqual({ defined: true, value: null })
    expect(() => projectProductionAgentQueue(Array.from({ length: PRODUCTION_AGENT_LIMITS.queue + 1 }, queueRow))).toThrow('Invalid operation result')
    expect(() => codec.encodeResult({ ...queueRow(), position: 0 })).toThrow('Invalid operation result')
  })
  it('preserves real Captain outcomes and strips private error details without inventing successful readiness', () => {
    const codec = PRODUCTION_AGENT_CODECS['captainRuntime:switch']
    const source = { ...runtime(), phase: 'rolled_back', probeOk: null, errorCode: 'STARTUP_FAILED', errorDetail: 'private native path' }
    const wire = codec.encodeResult(source)
    expect(wire).toMatchObject({ value: { phase: 'rolled_back', probeOk: null, errorCode: 'STARTUP_FAILED', errorDetail: AGENT_RECOVERY_ERROR } })
    expect(codec.validateWireResult(wire)).toBe(true)
    expect(() => codec.encodeResult({ ...runtime(), privateToken: 'secret' })).toThrow('Invalid operation result')
    expect(() => codec.encodeResult({ ...runtime(), probeOk: 'yes' })).toThrow('Invalid operation result')
  })
  it('keeps missing raw diagnostic fields distinct from null and rejects oversized/cyclic/non-JSON results', () => {
    const codec = PRODUCTION_AGENT_CODECS['agentSession:getRawTranscript']
    const source = [{ role: 'assistant', parts: [{ type: 'text', content: 'reply', tool: undefined }] }]
    expect(codec.encodeResult(source)).toEqual({ defined: true, value: [{ role: 'assistant', parts: [{ type: 'text', content: 'reply' }] }] })
    expect(() => codec.encodeResult([{ role: 'assistant', parts: [{ type: 'text', content: null }] }])).toThrow('Invalid operation result')
    expect(() => codec.encodeResult([{ role: 'assistant', parts: Array.from({ length: 513 }, () => ({ type: 'text' })) }])).toThrow('Invalid operation result')
    const cyclic: { next?: unknown } = {}; cyclic.next = cyclic
    expect(isBoundedProductionAgentJson(cyclic)).toBe(false)
    expect(isBoundedProductionAgentJson({ bytes: new Uint8Array([1]) })).toBe(false)
    expect(isBoundedProductionAgentJson({ text: 'x'.repeat(PRODUCTION_AGENT_LIMITS.bytes) })).toBe(false)
    expect(PRODUCTION_AGENT_CODECS['agentSession:stop'].validateWireResult({ defined: false })).toBe(false)
    expect(PRODUCTION_AGENT_CODECS['agentSession:stop'].validateWireResult({ defined: true, value: { success: true, unexpected: true } } as JsonValue)).toBe(false)
  })
})

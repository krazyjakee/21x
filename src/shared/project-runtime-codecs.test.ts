import { describe, expect, it } from 'vitest'
import { PROJECT_RUNTIME_CODECS as codecs, PROJECT_RUNTIME_LIMITS, PROJECT_RUNTIME_OPERATIONS } from './project-runtime-codecs'

const limits = { projectId: 'project', paused: false, allProjectsPaused: false, maxConcurrentAgents: null, runningAgents: 1, dailySessionCap: null, sessionsStartedToday: 0, dailyTokenCap: null, tokensToday: 0, queued: [{ taskId: 'task', agentId: 'agent', reason: 'agent_limit', queuedAt: '2026-10-14T10:00:00.000Z', position: 1 }], blockedBy: null }
const status = { project_id: 'project', counts: { running: 1, queued: 1, awaiting_review: 0, awaiting_approval: 1, blocked: 0 }, limits, summary: 'Captain summary 🦀', top_blockers: ['Decision needed'], updated_at: null }
const concurrency = { projectId: 'project', captainControl: true, agents: [{ agentId: 'agent', agentName: 'Actual agent', cap: 3, level: 1, source: 'captain', runningInProject: 1, runningTotal: 1, queuedInProject: 1, recommendation: { level: 2, why: 'one queued start could run' } }], pressure: { underPressure: false, reasons: [], freeMemRatio: 0.5, loadPerCpu: 0 }, recentChanges: [] }
describe('exact retained project runtime codecs', () => {
  it('covers ten existing commands and preserves optional history query semantics', () => {
    expect(PROJECT_RUNTIME_OPERATIONS).toHaveLength(10)
    expect(codecs['project:getStatus'].encodeArguments(['project'])).toEqual({ projectId: 'project' })
    expect(codecs['project:getAllStatuses'].decodeArguments({})).toEqual([])
    expect(codecs['project:getStatusHistory'].encodeArguments(['project', undefined])).toEqual({ projectId: 'project' })
    expect(codecs['project:getStatusHistory'].encodeArguments(['project', { limit: undefined, cursor: null }])).toEqual({ projectId: 'project', query: { cursor: null } })
    expect(codecs['project:getStatusHistory'].decodeArguments({ projectId: 'project', query: { limit: 20, cursor: null } })).toEqual(['project', { limit: 20, cursor: null }])
    for (const limit of [-10, 0, 1.5, 21, 1e100]) expect(codecs['project:getStatusHistory'].encodeArguments(['project', { limit }])).toEqual({ projectId: 'project', query: { limit } })
    expect(codecs['concurrency:pin'].encodeArguments(['project', 'agent', null])).toEqual({ projectId: 'project', agentId: 'agent', level: null })
    expect(codecs['projectLimits:pauseAll'].encodeArguments([true])).toEqual({ paused: true })
  })
  it('refuses caller roots, unknown optional fields, malformed IDs, unsafe numbers and unreviewed pin levels', () => {
    for (const payload of [{ projectId: 'project', root: '/private' }, { projectId: '../project' }] as import('./service-protocol').JsonValue[]) expect(() => codecs['project:getCaptainMemory'].decodeArguments(payload)).toThrow('Invalid operation arguments')
    expect(() => codecs['project:getStatusHistory'].encodeArguments(['project', { root: undefined } as never])).toThrow()
    for (const limit of [NaN, Infinity, -Infinity]) expect(() => codecs['project:getStatusHistory'].encodeArguments(['project', { limit }])).toThrow()
    for (const level of [0, 11, 1.5, NaN, undefined]) expect(codecs['concurrency:pin'].validateArguments(['project', 'agent', level])).toBe(false)
    expect(() => codecs['concurrency:setCaptainControl'].decodeArguments({ projectId: 'project', enabled: 1 })).toThrow()
  })
  it('validates real finite public status/limit/concurrency DTOs without recovery secrets or extras', () => {
    expect(codecs['project:getStatus'].decodeResult(status)).toEqual(status)
    expect(codecs['projectLimits:getState'].decodeResult(limits)).toEqual(limits)
    expect(codecs['concurrency:getState'].decodeResult(concurrency)).toEqual(concurrency)
    expect(codecs['concurrency:setCaptainControl'].decodeResult({ success: true })).toEqual({ success: true })
    expect(codecs['concurrency:pin'].decodeResult({ error: 'A pinned level cannot exceed the agent hard cap.' })).toHaveProperty('error')
    expect(codecs['project:getStatus'].validateResult({ ...status, counts: { ...status.counts, running: Number.MAX_SAFE_INTEGER + 1 } })).toBe(false)
    expect(codecs['projectLimits:getState'].validateResult({ ...limits, queued: [{ ...limits.queued[0], lastError: 'raw private provider error' }] })).toBe(false)
    expect(codecs['concurrency:getState'].validateResult({ ...concurrency, agents: [{ ...concurrency.agents[0], config: { api_keys: 'private' } }] })).toBe(false)
    expect(codecs['project:getStatus'].validateWireResult({ defined: false })).toBe(false)
  })
  it('preserves null, empty and truthful truncated Captain memory and caps the complete output envelope', () => {
    const memory = { path: '/workspace/captain/MEMORY.md', content: '🦀'.repeat(6000), truncated: true }
    expect(codecs['project:getCaptainMemory'].decodeResult(memory)).toEqual(memory)
    expect(codecs['project:getCaptainMemory'].decodeResult(null)).toBeNull()
    expect(codecs['project:getCaptainMemory'].validateResult({ ...memory, content: 'x'.repeat(12001) })).toBe(false)
    expect(codecs['project:getCaptainMemory'].validateResult({ ...memory, content: '\ud800' })).toBe(false)
    const entry = { project_id: 'project', name: 'Project', brief: '\u0001'.repeat(16000), is_default: false, sort_order: 0, status, pending_approvals: 0, running_agents: 1, paused: false, all_projects_paused: false, blocked_by: null, last_activity_at: null, needs_attention: false }
    expect(codecs['project:getAllStatuses'].validateResult([entry])).toBe(true)
    expect(codecs['project:getAllStatuses'].validateResult(Array.from({ length: 10 }, () => entry))).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(codecs['project:getCaptainMemory'].encodeResult(memory)))).toBeLessThan(PROJECT_RUNTIME_LIMITS.resultBytes)
  })
  it('bounds exact history pages and rejects arbitrary source/metadata or cursor payloads', () => {
    const page = { entries: [{ id: 'entry', project_id: 'project', summary: 'Preserved recovery', completed: [], blockers: [], decisions: ['Keep history'], next_steps: [], source: 'system_recovery', correlation_id: null, created_at: '2026-10-14T10:00:00.000Z' }], has_more: true, next_cursor: 'opaque-cursor' }
    expect(codecs['project:getStatusHistory'].decodeResult(page)).toEqual(page)
    expect(codecs['project:getStatusHistory'].validateResult({ ...page, entries: [{ ...page.entries[0], source: 'provider-private' }] })).toBe(false)
    expect(codecs['project:getStatusHistory'].validateResult({ ...page, entries: Array.from({ length: 21 }, () => page.entries[0]) })).toBe(false)
    expect(() => codecs['project:getStatusHistory'].decodeArguments({ projectId: 'project', query: { cursor: 'x'.repeat(301) } })).toThrow()
  })
})

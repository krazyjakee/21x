import { describe, expect, it } from 'vitest'
import { DATABASE_COMMAND_CODECS as commands, DATABASE_EVENT_CODECS as events } from './database-desktop-codecs'
import type { JsonValue } from './service-protocol'

function taskRow() {
  return {
    id: 'task-1', title: 'Synthetic', description: '', type: 'general', priority: 'medium', status: 'not_started', assignee: '', source: 'local', project_id: 'default', created_at: '2026-01-01', updated_at: '2026-01-01',
    due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null, resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null, heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null,
    is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false,
    labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null, recurrence_pattern: null, heartbeat_interval_minutes: 30, complete_at_source: null, next_subtask_ids: [], sort_order: 0,
    mcp_scope_nonce: 'fixture-private-nonce', checklist: '[]', role: 'task'
  }
}
const part = { taskId: 'task-1', partId: 'adapter:part/1', seq: 1, role: 'assistant', content: 'persisted', createdAt: 1, updatedAt: 2, rev: 3 }

describe('explicit database desktop codecs', () => {
  it('omits only declared optional arguments and preserves exact named wire shapes', () => {
    expect(commands['db:getTasks'].encodeArguments([])).toEqual({})
    expect(commands['db:getTasks'].encodeArguments([undefined])).toEqual({})
    expect(commands['db:getTasks'].decodeArguments({ projectId: 'project-1' })).toEqual(['project-1'])
    expect(commands['project:getAll'].encodeArguments([{ includeArchived: undefined }])).toEqual({})
    expect(commands['agentSession:getTranscriptSnapshot'].encodeArguments(['task-1', undefined])).toEqual({ taskId: 'task-1' })
    expect(commands['db:createTask'].encodeArguments([{ title: 'Synthetic', description: undefined }])).toEqual({ data: { title: 'Synthetic' } })
    expect(() => commands['db:getTasks'].decodeArguments({ projectId: undefined } as unknown as JsonValue)).toThrow()
    expect(() => commands['db:getTask'].decodeArguments({ id: 'task-1', projectId: 'forged' })).toThrow()
  })

  it('rejects lifecycle mutations, hidden fields, credentials, and binary arguments', () => {
    expect(() => commands['db:updateTask'].encodeArguments(['task-1', { status: 'agent_working' as never }])).toThrow()
    expect(() => commands['db:createTask'].decodeArguments({ data: { title: 'Synthetic', role: 'captain' } })).toThrow()
    expect(() => commands['db:createTask'].decodeArguments({ data: { title: 'Synthetic', auto_start_agent: true } })).toThrow()
    expect(() => commands['db:createTask'].decodeArguments({ data: { title: 'Synthetic', labels: [Buffer.from('bytes')] } } as unknown as JsonValue)).toThrow()
    expect(() => commands['settings:set'].decodeArguments({ key: 'anthropic_api_key', value: 'fixture-secret' })).toThrow()
    expect(() => commands['settings:get'].decodeArguments({ key: 'mobile_init_code_token' })).toThrow()
  })

  it('projects task rows without private database fields and rejects malformed DTOs', () => {
    const encoded = commands['db:getTask'].encodeResult(taskRow())
    expect(encoded.defined).toBe(true)
    expect(JSON.stringify(encoded)).not.toContain('fixture-private-nonce')
    expect(JSON.stringify(encoded)).not.toContain('mcp_scope_nonce')
    expect(JSON.stringify(encoded)).not.toContain('checklist')
    expect(commands['db:getTask'].validateWireResult(encoded)).toBe(true)
    expect(() => commands['db:getTask'].encodeResult({ ...taskRow(), status: 'arbitrary-status' })).toThrow()
    expect(() => commands['db:getTask'].encodeResult({ ...taskRow(), labels: ['ok', 1] })).toThrow()
    expect(commands['db:getTask'].encodeResult({ ...taskRow(), group_id: 'group-1' })).toMatchObject({ defined: true, value: { group_id: 'group-1' } })
    expect(() => commands['db:getTask'].encodeResult({ ...taskRow(), group_id: { forged: true } })).toThrow()
  })

  it('preserves undefined versus null and never accepts an undeclared void result', () => {
    expect(commands['db:getTask'].encodeResult(undefined)).toEqual({ defined: false })
    expect(commands['settings:get'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(commands['settings:set'].encodeResult(undefined)).toEqual({ defined: false })
    expect(commands['db:createTask'].validateWireResult({ defined: false })).toBe(false)
    expect(commands['settings:get'].validateWireResult({ defined: false })).toBe(false)
    expect(commands['settings:set'].validateWireResult({ defined: true, value: null })).toBe(false)
    expect(commands['db:getTask'].validateWireResult({ defined: false, value: null })).toBe(false)
  })

  it('encodes explicit optional transcript fields and checks event task/revision association', () => {
    const encoded = commands['agentSession:getTranscriptSnapshot'].encodeResult([{ ...part, partType: undefined, tool: undefined, payload: { durable: true } }])
    expect(encoded).toEqual({ defined: true, value: [{ ...part, payload: { durable: true } }] })
    expect(events['transcript:changed'].validatePayload({ taskId: 'task-1', parts: [part], maxRev: 3 })).toBe(true)
    expect(events['transcript:changed'].validatePayload({ taskId: 'other-task', parts: [part], maxRev: 3 })).toBe(false)
    expect(events['transcript:changed'].validatePayload({ taskId: 'task-1', parts: [part], maxRev: 2 })).toBe(false)
    expect(events['transcript:changed'].validatePayload({ taskId: 'task-1', parts: [part], maxRev: 3, reloadRequired: true })).toBe(false)
    const task = commands['db:getTask'].encodeResult(taskRow())
    expect(events['task:updated'].validatePayload({ taskId: 'other-task', updates: task.defined ? task.value : undefined })).toBe(false)
  })
})

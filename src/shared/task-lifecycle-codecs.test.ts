import { describe, expect, it } from 'vitest'
import { TASK_LIFECYCLE_CODECS as codecs, TASK_LIFECYCLE_EVENT_CODECS as events, projectTaskLifecycleTask, OVERDUE_EVENT_CODEC } from './task-lifecycle-codecs'
import { TaskStatus } from './constants'
import type { JsonValue } from './service-protocol'

const task = {
  id: 'task-one', title: 'Task', description: '', type: 'coding', priority: 'high', status: 'ready_for_review', assignee: '', due_date: null,
  labels: ['label'], attachments: [], repos: [], output_fields: [{ id: 'notes', name: 'Notes', type: 'text' as const, value: { nested: ['kept', 2] } }],
  agent_id: null, external_id: null, source_id: null, source: 'local', skill_ids: null, session_id: null, snoozed_until: null,
  resolution: null, feedback_rating: null, feedback_comment: null, is_recurring: false, recurrence_pattern: null, recurrence_parent_id: null,
  last_occurrence_at: null, next_occurrence_at: null, heartbeat_enabled: false, heartbeat_interval_minutes: 30, heartbeat_last_check_at: null, heartbeat_next_check_at: null,
  auto_start_agent: false, auto_complete_without_review: false, complete_at_source: null, parent_task_id: null, next_subtask_ids: [], sort_order: 0,
  role: 'task', project_id: 'project-one', group_id: null, created_at: '2026-10-13T10:00:00Z', updated_at: '2026-10-13T10:00:00Z', last_activity_at: null
}
describe('full task lifecycle codecs', () => {
  it('retains full public task fields and exact lifecycle inputs', () => {
    const request = { title: 'Recurring task', status: TaskStatus.AgentWorking, is_recurring: true, recurrence_pattern: '0 9 * * 1',
      auto_start_agent: true, complete_at_source: false, parent_task_id: 'parent', attachments: [{ id: 'attachment-one', filename: 'image.png', size: 123, mime_type: 'image/png', added_at: '2026-10-13T10:00:00Z' }],
      output_fields: task.output_fields }
    const encoded = codecs['db:createTask'].encodeArguments([request])
    expect(codecs['db:createTask'].decodeArguments(encoded)).toEqual([request])
    expect(codecs['db:updateTask'].decodeArguments(codecs['db:updateTask'].encodeArguments(['task-one', {
      status: TaskStatus.AgentLearning, feedback_rating: 4, complete_at_source: true, agent_id: 'agent-one', skill_ids: ['skill-one'], snoozed_until: '2026-11-01T10:00:00Z'
    }]))).toEqual(['task-one', { status: 'agent_learning', feedback_rating: 4, complete_at_source: true, agent_id: 'agent-one', skill_ids: ['skill-one'], snoozed_until: '2026-11-01T10:00:00Z' }])
    const result = codecs['db:getTask'].encodeResult({ ...task, mcp_scope_nonce: 'private-nonce', checklist: 'legacy-private-column' })
    expect(result).toEqual({ defined: true, value: task })
    expect(codecs['db:getTask'].validateWireResult(result)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/private-nonce|checklist/)
  })

  it('rejects undeclared owner fields, foreign path shapes and malformed nested data', () => {
    for (const data of [{ role: 'captain' }, { group_id: 'group-one' }, { source_id: 'source-one' }, { session_id: 'native-id' }, { project_id: 'destination' },
      { feedback_rating: 6 }, { status: 'waiting_approval' }, { parent_task_id: '../outside' }, { next_subtask_ids: ['same', 'same'] },
      { attachments: [{ id: 'attachment-one', filename: '../secret', size: 1, mime_type: 'text/plain', added_at: '2026-10-13T10:00:00Z' }] },
      { recurrence_pattern: { type: 'weekly', interval: 1, time: '27:99' } }, { output_fields: [{ id: 'notes', name: 'Notes', type: 'text', private_config: {} }] }]) {
      expect(codecs['db:updateTask'].validateArguments(['task-one', data])).toBe(false)
    }
    expect(() => codecs['db:createTask'].decodeArguments({ data: { title: 'Task' }, caller: { principal: 'service' } })).toThrow('arguments')
    expect(() => codecs['db:createTask'].encodeArguments([{ title: 'Task', description: undefined }])).not.toThrow()
  })

  it('preserves undefined/null/boolean results and aggregate UTF8 bounds without truncation', () => {
    expect(codecs['db:getTask'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['db:updateTask'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['project:moveTask'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(codecs['db:deleteTask'].encodeResult(false)).toEqual({ defined: true, value: false })
    expect(codecs['db:getTasks'].validateResult(Array.from({ length: 129 }, () => task))).toBe(false)
    const big = Array.from({ length: 8 }, () => ({ ...task, description: '界'.repeat(60_000) }))
    expect(() => codecs['db:getTasks'].encodeResult(big)).toThrow('result')
    expect(codecs['db:getTasks'].validateWireResult({ defined: true, value: big })).toBe(false)
    expect(() => codecs['db:getTasks'].decodeResult(big)).toThrow('result')
    expect(() => projectTaskLifecycleTask({ ...task, role: 'arbitrary' })).toThrow('result')
  })

  it('keeps exact event correlation and safe public action results', () => {
    expect(events['task:updated'].validatePayload({ taskId: task.id, updates: task })).toBe(true)
    expect(events['task:updated'].validatePayload({ taskId: 'foreign', updates: task })).toBe(false)
    expect(events['task:updated'].validatePayload({ taskId: task.id, updates: { heartbeat_enabled: false, session_id: null } })).toBe(true)
    expect(events['task:updated'].validatePayload({ taskId: task.id, updates: { mcp_scope_nonce: 'private' } })).toBe(false)
    expect(events['task:subtasks-reordered'].validatePayload({ parentId: 'parent', orderedIds: ['child'] })).toBe(true)
    expect(events['tasks:refresh'].validatePayload({ tasks: [] })).toBe(false)
    const action = codecs['plugin:executeAction'].encodeResult({ success: true, taskUpdate: { status: 'completed', oauth_token: 'private' }, secret: 'private' })
    expect(action).toEqual({ defined: true, value: { success: true, taskUpdate: { status: 'completed' } } })
    expect(codecs['plugin:executeAction'].validateWireResult(action)).toBe(true)
    expect(codecs['plugin:executeAction'].validateResult({ success: true, taskUpdate: { oauth_token: 'private' } })).toBe(false)
  })
  it('keeps the overdue advisory void at the public API and exact empty on the wire', () => {
    expect(OVERDUE_EVENT_CODEC.encodePayload(undefined)).toEqual({})
    expect(OVERDUE_EVENT_CODEC.decodePayload({})).toBeUndefined()
    expect(OVERDUE_EVENT_CODEC.validatePayload(undefined)).toBe(true)
    expect(OVERDUE_EVENT_CODEC.validatePayload({})).toBe(false)
    const invalid: JsonValue[] = [null, false, [], { taskId: 'task' }, { projectId: 'project' }, { authority: true }]
    for (const payload of invalid)
      expect(() => OVERDUE_EVENT_CODEC.decodePayload(payload)).toThrow()
    expect(() => OVERDUE_EVENT_CODEC.encodePayload({})).toThrow()
  })
})

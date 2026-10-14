import { projectTaskLifecycleTask } from '../shared/task-lifecycle-codecs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { TASK_GROUP_CODECS, TASK_GROUP_OPERATIONS, TASK_GROUP_LIMITS } from '../shared/task-group-codecs'

let db: ReturnType<typeof createPortableTestDb>
beforeEach(() => { db = createPortableTestDb() })
afterEach(() => db.close())
function fixture() {
  const agent = db.createAgent({ name: 'Codec fixture', config: {} })!
  const members = ['First', 'Second'].map(title => db.createTask({ title })!)
  const group = db.createTaskGroup({ title: 'Actual stored group', task_ids: members.map(task => task.id), agent_id: agent.id })
  return { group, task: db.getTask(group.execution_task_id)!, members: members.map(task => db.getTask(task.id)!) }
}
describe('exact retained task group codecs', () => {
  it('declares nine finite operations and preserves optional argument presence', () => {
    expect(TASK_GROUP_OPERATIONS).toHaveLength(9)
    expect(TASK_GROUP_CODECS['taskGroups:list'].encodeArguments(['project-one'])).toEqual({ projectId: 'project-one' })
    expect(TASK_GROUP_CODECS['taskGroups:list'].decodeArguments({ projectId: 'project-one', includeDissolved: false })).toEqual(['project-one', false])
    expect(TASK_GROUP_CODECS['taskGroups:list'].decodeArguments({ projectId: 'project-one' })).toEqual(['project-one', undefined])
    expect(TASK_GROUP_CODECS['taskGroups:create'].encodeArguments([{ title: 'New group', task_ids: ['one', 'two'], agent_id: undefined }])).toEqual({ data: { title: 'New group', task_ids: ['one', 'two'] } })
  })
  it('rejects unknown payload grants, duplicate/foreign IDs and invalid review/start states', () => {
    expect(() => TASK_GROUP_CODECS['taskGroups:get'].decodeArguments({ id: 'group', scope: { approved: true } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:create'].encodeArguments([{ title: 'Group', task_ids: ['same', 'same'] }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:add'].decodeArguments({ id: 'group', taskIds: ['../task'] })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:move'].decodeArguments({ id: 'group', status: 'agent_learning' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:review'].decodeArguments({ data: { group_id: 'group', action: 'approve', task_ids: [] } })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:review'].encodeArguments([{ group_id: 'group', action: 'send_back', message: 'x'.repeat(4001) }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }))
  })
  it('projects real stored groups and complete public tasks without private nonce/credential spreads', () => {
    const actual = fixture()
    const wire = TASK_GROUP_CODECS['taskGroups:get'].encodeResult({ ...actual, privateSession: 'private-session', group: { ...actual.group, secret: 'private-key' }, task: { ...actual.task, mcp_scope_nonce: 'private-nonce', api_keys: { openai: 'private-key' } } })
    expect(wire.defined).toBe(true)
    expect(JSON.stringify(wire)).not.toMatch(/private-key|private-nonce|private-session|mcp_scope_nonce|api_keys/)
    expect(TASK_GROUP_CODECS['taskGroups:get'].validateWireResult(wire)).toBe(true)
    expect(TASK_GROUP_CODECS['taskGroups:get'].decodeResult(wire.defined ? wire.value : undefined)).toEqual({ group: actual.group, task: projectTaskLifecycleTask(actual.task), members: actual.members.map(projectTaskLifecycleTask) })
  })
  it('checks result association and never invents null or void for required records', () => {
    const actual = fixture()
    expect(() => TASK_GROUP_CODECS['taskGroups:get'].encodeResult({ ...actual, task: actual.members[0] })).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:get'].encodeResult({ ...actual, members: [actual.members[0], actual.members[0]] })).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(() => TASK_GROUP_CODECS['taskGroups:get'].decodeResult(null)).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(TASK_GROUP_CODECS['taskGroups:get'].validateWireResult({ defined: false })).toBe(false)
    expect(TASK_GROUP_CODECS['taskGroups:list'].encodeResult([])).toEqual({ defined: true, value: [] })
  })
  it('retains useful per-member failure IDs while redacting raw provider diagnostics', () => {
    const { group, members } = fixture()
    const wire = TASK_GROUP_CODECS['taskGroups:review'].encodeResult({ group, completed_task_ids: [members[0].id], failures: [{ task_id: members[1].id, message: 'Bearer private-provider-key https://signed.invalid?secret=x', stdout: 'private CLI receipt' }] })
    expect(wire.defined ? wire.value : undefined).toMatchObject({ completed_task_ids: [members[0].id], failures: [{ task_id: members[1].id, message: 'Source completion failed.' }] })
    expect(JSON.stringify(wire)).not.toMatch(/private-provider|signed.invalid|stdout/)
  })
  it('bounds row counts and aggregate result bytes without clipping stored meaning', () => {
    const { group } = fixture()
    expect(() => TASK_GROUP_CODECS['taskGroups:list'].encodeResult(Array.from({ length: TASK_GROUP_LIMITS.groups + 1 }, () => group))).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    const huge = { ...group, progress: group.progress.map(item => ({ ...item, message: '\u0001'.repeat(4000) })) }
    expect(() => TASK_GROUP_CODECS['taskGroups:list'].encodeResult(Array.from({ length: 100 }, () => huge))).toThrow(expect.objectContaining({ code: 'INVALID_RESULT' }))
    expect(db.getTaskGroup(group.id)?.title).toBe(group.title)
  })
})

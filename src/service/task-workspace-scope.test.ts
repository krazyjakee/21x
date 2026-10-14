import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { TaskWorkspaceScopeReader } from './task-workspace-scope'
import { ServiceProtocolError } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'workspace-scope', webviewId: 'main', origin: 'app://workspace-scope' }
let db: ReturnType<typeof createPortableTestDb>, reader: TaskWorkspaceScopeReader, task: NonNullable<ReturnType<typeof db.createTask>>, tasks: Set<string> | null, projects: Set<string> | null
beforeEach(() => {
  db = createPortableTestDb(); task = db.createTask({ title: 'Literal owned task' })!; tasks = projects = null
  reader = new TaskWorkspaceScopeReader({ database: db, assertAvailable() { if (!db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, canAccessTask: id => tasks === null || tasks.has(id), canAccessProject: id => projects === null || projects.has(id) })
})
afterEach(() => { if (db.db.open) db.close(); vi.restoreAllMocks() })
function group() {
  const agent = db.createAgent({ name: 'Group owner' })!, member = db.createTask({ title: 'Other literal member', repos: db.getTask(task.id)!.repos })!
  db.updateTask(task.id, { agent_id: agent.id }); db.updateTask(member.id, { agent_id: agent.id })
  return { member, group: db.createTaskGroup({ title: 'Owned group', task_ids: [task.id, member.id] }) }
}
describe('shared literal workspace SQL scope', () => {
  it('captures only bounded bindings without deserializing unrelated task/agent/source credentials', () => {
    const getTask = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Unrelated full deserializer must not run') })
    db.db.prepare('UPDATE tasks SET output_fields=? WHERE id=?').run('malformed retained unrelated field', task.id)
    const scope = reader.capture(task.id, caller)
    expect(scope.task.id).toBe(task.id); expect(scope.tasks).toEqual([scope.task]); expect(scope.group).toBeNull(); expect(getTask).not.toHaveBeenCalled()
    expect(JSON.stringify(scope)).not.toContain('malformed retained unrelated field')
  })
  it('preserves literal members and requires all current member and execution-anchor grants', () => {
    const value = group(), memberScope = reader.capture(task.id, caller), anchorScope = reader.capture(value.group.execution_task_id, caller)
    expect(memberScope.task.id).toBe(task.id); expect(anchorScope.task.id).toBe(value.group.execution_task_id)
    expect(new Set(memberScope.tasks.map(row => row.id))).toEqual(new Set([task.id, value.member.id, value.group.execution_task_id]))
    tasks = new Set([task.id, value.group.execution_task_id]); expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    tasks = new Set([task.id, value.member.id]); expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
  it('keeps dissolved-anchor history scoped to former members and lets removed members retain their literal workspace', () => {
    const value = group(); db.dissolveTaskGroup(value.group.id)
    const scope = reader.capture(value.group.execution_task_id, caller)
    expect(scope.tasks.map(row => row.id)).toContain(task.id); expect(scope.tasks.map(row => row.id)).toContain(value.member.id)
    tasks = new Set([value.group.execution_task_id]); expect(() => reader.capture(value.group.execution_task_id, caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    tasks = new Set([task.id]); expect(reader.capture(task.id, caller).task.id).toBe(task.id); expect(reader.capture(task.id, caller).group).toBeNull()
  })
  it('detects current role/session/repository/project/group membership changes in the same policy snapshot', () => {
    const before = JSON.stringify(reader.capture(task.id, caller)); db.db.prepare('UPDATE tasks SET session_id=? WHERE id=?').run('changed-session', task.id)
    expect(JSON.stringify(reader.capture(task.id, caller))).not.toBe(before)
    const next = JSON.stringify(reader.capture(task.id, caller)); db.updateTask(task.id, { repos: ['different/repo'] }); expect(JSON.stringify(reader.capture(task.id, caller))).not.toBe(next)
    db.db.prepare('UPDATE tasks SET session_id=NULL WHERE id=?').run(task.id)
    const value = group(), grouped = JSON.stringify(reader.capture(task.id, caller)); db.dissolveTaskGroup(value.group.id); expect(JSON.stringify(reader.capture(task.id, caller))).not.toBe(grouped)
  })
  it('checks stored repository bounds before parsing and refuses malformed legacy scalar/namespace bindings', () => {
    const oversized = 'x'.repeat(65537); db.db.prepare('UPDATE tasks SET repos=? WHERE id=?').run(oversized, task.id); const parse = vi.spyOn(JSON, 'parse')
    expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'FRAME_TOO_LARGE' })); expect(parse).not.toHaveBeenCalledWith(oversized)
    expect((db.db.prepare('SELECT repos FROM tasks WHERE id=?').get(task.id) as { repos: string }).repos).toBe(oversized)
    db.db.prepare('UPDATE tasks SET repos=?, session_id=? WHERE id=?').run('[]', 'bad\nidentity', task.id); expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    db.db.prepare('UPDATE tasks SET session_id=NULL, role=? WHERE id=?').run('commander', task.id); expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
  it('refuses unknown tasks, unauthorized projects, malformed IDs and closed owners', () => {
    expect(() => reader.capture('missing', caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' })); expect(() => reader.capture('../task', caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    projects = new Set(); expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' })); db.close()
    expect(() => reader.capture(task.id, caller)).toThrow(expect.objectContaining({ code: 'DISCONNECTED' }))
  })
})

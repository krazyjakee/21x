import { describe, expect, it, vi } from 'vitest'
import { SyncManager, SyncManagerClosedError, SyncManagerShutdownIncompleteError } from './sync-manager'
import type { DatabaseManager, TaskRecord } from './database'
import type { PluginRegistry } from './plugins/registry'
import type { TaskSourcePlugin } from './plugins/types'
import { PluginActionId } from '../shared/constants'

function fixture() {
  let finish!: (value: unknown) => void
  const held = new Promise<unknown>(resolve => { finish = resolve })
  const task = { id: 'task', source_id: 'source', external_id: 'fixture-card', complete_at_source: true } as TaskRecord
  const database = { getTask: vi.fn(() => task),
    getTaskSource: vi.fn(() => ({ id: 'source', name: 'Fixture source', plugin_id: 'fixture', project_id: 'project', config: {} })),
    updateTaskSourceLastSynced: vi.fn(), updateTask: vi.fn(), getTasks: vi.fn(() => []), recordTaskActivity: vi.fn() }
  const provider = { importTasks: vi.fn(() => held), exportUpdate: vi.fn(() => held), executeAction: vi.fn(() => held),
    getUsers: vi.fn(() => held), reassignTask: vi.fn(() => held) }
  const registry = { get: vi.fn(() => provider as unknown as TaskSourcePlugin) } as unknown as PluginRegistry
  const manager = new SyncManager(database as unknown as DatabaseManager, registry)
  return { finish, task, database, provider, manager }
}

const methods = ['import', 'export', 'action', 'users', 'reassign'] as const
type Method = typeof methods[number]
function invoke(f: ReturnType<typeof fixture>, method: Method) {
  switch (method) {
    case 'import': return f.manager.importTasks('source')
    case 'export': return f.manager.exportTaskUpdate('task', { title: 'Changed' })
    case 'action': return f.manager.executeAction(PluginActionId.Complete, f.task, undefined, 'source')
    case 'users': return f.manager.getSourceUsers('source')
    case 'reassign': return f.manager.reassignTask('task', ['user'], 'Fixture user')
  }
}

describe('source sync shutdown ownership', () => {
  it.each(methods)('joins raw %s work and its following database writes', async method => {
    const f = fixture()
    const active = invoke(f, method)
    await vi.waitFor(() => expect(f.database.getTaskSource).toHaveBeenCalledOnce())
    let closed = false
    const close = f.manager.close().then(() => { closed = true })
    expect(closed).toBe(false)
    expect(f.database.updateTask).not.toHaveBeenCalled()
    expect(f.database.updateTaskSourceLastSynced).not.toHaveBeenCalled()
    for (const next of methods) await expect(invoke(f, next)).rejects.toBeInstanceOf(SyncManagerClosedError)
    expect(f.database.getTaskSource).toHaveBeenCalledOnce()
    const value = method === 'import' ? { imported: 1, updated: 2, errors: [] }
      : method === 'action' ? { success: true, taskUpdate: { title: 'Returned' } }
        : method === 'reassign' ? { success: true } : method === 'users' ? [] : undefined
    f.finish(value)
    await active
    await close
    if (method === 'import') expect(f.database.updateTaskSourceLastSynced).toHaveBeenCalledWith('source')
    if (method === 'action') expect(f.database.updateTask).toHaveBeenCalledWith('task', { title: 'Returned' }, 'task-source-action')
    if (method === 'reassign') expect(f.database.updateTask).toHaveBeenCalledWith('task', { assignee: 'Fixture user' })
  })

  it('retains source work after a close deadline and joins it on retry', async () => {
    const f = fixture()
    const active = f.manager.importTasks('source')
    await vi.waitFor(() => expect(f.provider.importTasks).toHaveBeenCalledOnce())
    await expect(f.manager.close(5)).rejects.toBeInstanceOf(SyncManagerShutdownIncompleteError)
    let closed = false
    const retry = f.manager.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    f.finish({ imported: 0, updated: 0, errors: [] })
    await active
    await retry
    expect(f.database.updateTaskSourceLastSynced).toHaveBeenCalledOnce()
  })

  it('closes queued calls before their first database read', async () => {
    const f = fixture()
    const queued = methods.map(method => expect(invoke(f, method)).rejects.toBeInstanceOf(SyncManagerClosedError))
    await f.manager.close()
    await Promise.all(queued)
    expect(f.database.getTask).not.toHaveBeenCalled()
    expect(f.database.getTaskSource).not.toHaveBeenCalled()
  })

  it('validates a deadline before stopping admission', async () => {
    const f = fixture()
    await expect(f.manager.close(0)).rejects.toBeInstanceOf(RangeError)
    const active = f.manager.importTasks('source')
    await vi.waitFor(() => expect(f.provider.importTasks).toHaveBeenCalledOnce())
    f.finish({ imported: 0, updated: 0, errors: [] })
    await active
    await f.manager.close()
  })
})

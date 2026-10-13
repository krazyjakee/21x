import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskGroupRecord } from '@shared/task-groups'
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), updates: new Set<(event: unknown) => void>(), refreshes: new Set<() => void>() }))
vi.mock('@/lib/ipc-client', async original => ({
  ...await original<typeof import('@/lib/ipc-client')>(),
  taskGroupsApi: { list: mocks.list, get: mocks.get },
  onTaskUpdated: (listener: (event: unknown) => void) => { mocks.updates.add(listener); return () => mocks.updates.delete(listener) },
  onTasksRefresh: (listener: () => void) => { mocks.refreshes.add(listener); return () => mocks.refreshes.delete(listener) }
}))
import { useTaskGroupStore } from './task-group-store'
const releases: Array<() => void> = []
beforeEach(() => { vi.clearAllMocks(); useTaskGroupStore.setState({ projects: {}, snapshots: {}, busy: {}, errors: {} }); mocks.list.mockResolvedValue([]) })
afterEach(() => { for (const release of releases.splice(0)) release() })
it('shares one project source between board/chrome and coalesces a ten-member update burst with refresh', async () => {
  const updates = mocks.updates.size, refreshes = mocks.refreshes.size
  const board = useTaskGroupStore.getState().subscribe('project')
  const chrome = useTaskGroupStore.getState().subscribe('project')
  releases.push(board, chrome)
  expect(mocks.updates.size).toBe(updates + 1); expect(mocks.refreshes.size).toBe(refreshes + 1)
  await Promise.resolve(); await Promise.resolve()
  expect(mocks.list).toHaveBeenCalledTimes(1)
  mocks.list.mockClear()
  for (let index = 0; index < 10; index++) for (const listener of mocks.updates) listener({ taskId: `member-${index}`, updates: { status: 'agent_working' } })
  for (const listener of mocks.refreshes) listener()
  await Promise.resolve(); await Promise.resolve()
  expect(mocks.list).toHaveBeenCalledTimes(1)
  board(); expect(mocks.updates.size).toBe(updates + 1)
  chrome(); expect(mocks.updates.size).toBe(updates); expect(mocks.refreshes.size).toBe(refreshes)
})
it('a slower older list response cannot overwrite a newer group state', async () => {
  let oldResponse!: (groups: TaskGroupRecord[]) => void, newResponse!: (groups: TaskGroupRecord[]) => void
  mocks.list.mockReturnValueOnce(new Promise<TaskGroupRecord[]>(resolve => { oldResponse = resolve })).mockReturnValueOnce(new Promise<TaskGroupRecord[]>(resolve => { newResponse = resolve }))
  const older = useTaskGroupStore.getState().fetch('project'), newer = useTaskGroupStore.getState().fetch('project')
  const latest = { id: 'group', title: 'Updated group', project_id: 'project', task_ids: ['two', 'three'] } as TaskGroupRecord
  newResponse([latest]); await newer
  oldResponse([{ ...latest, title: 'Old group', task_ids: ['one', 'two'] }]); await older
  expect(useTaskGroupStore.getState().projects.project).toEqual([latest])
})

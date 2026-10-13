import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TaskGroupRecord } from '@shared/task-groups'
const mocks = vi.hoisted(() => ({ history: vi.fn() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), taskGroupsApi: { history: mocks.history } }))
vi.mock('./TaskGroupDialog', () => ({ TaskGroupDialog: ({ groupId }: { groupId: string | null }) => groupId ? <p>Retained conversation: {groupId}</p> : null }))
import { TaskGroupHistoryNotice } from './TaskGroupHistoryNotice'
const group: TaskGroupRecord = { id: 'batch', title: 'Checkout polish', project_id: 'project', agent_id: 'agent', execution_task_id: 'execution', state: 'dissolved', status: 'ready_for_review', task_ids: [], former_task_ids: ['removed'], progress: [], created_at: '2026-01-01', updated_at: '2026-01-01' }
beforeEach(() => { vi.clearAllMocks(); mocks.history.mockResolvedValue([group]) })
afterEach(cleanup)
it('keeps a removed member linked to its dissolved shared conversation', async () => {
  render(<TaskGroupHistoryNotice taskId="removed" />)
  expect(await screen.findByLabelText('Task group history')).toHaveTextContent('Previously worked in a task group. Shared history is retained.')
  fireEvent.click(screen.getByRole('button', { name: 'Open shared conversation for Checkout polish' }))
  expect(screen.getByText('Retained conversation: batch')).toBeTruthy()
  expect(mocks.history).toHaveBeenCalledWith('removed')
})
it('fences a late history read and closes the previous conversation when changing tasks', async () => {
  let finishOld!: (groups: TaskGroupRecord[]) => void
  mocks.history.mockReturnValueOnce(new Promise<TaskGroupRecord[]>(resolve => { finishOld = resolve })).mockResolvedValueOnce([{ ...group, id: 'new-group', title: 'New group', former_task_ids: ['new-task'] }])
  const view = render(<TaskGroupHistoryNotice taskId="old-task" />)
  view.rerender(<TaskGroupHistoryNotice taskId="new-task" />)
  const button = await screen.findByRole('button', { name: 'Open shared conversation for New group' })
  fireEvent.click(button)
  expect(screen.getByText('Retained conversation: new-group')).toBeTruthy()
  finishOld([group])
  await Promise.resolve()
  expect(screen.queryByRole('button', { name: 'Open shared conversation for Checkout polish' })).toBeNull()
  mocks.history.mockResolvedValueOnce([])
  view.rerender(<TaskGroupHistoryNotice taskId="ungrouped-task" />)
  expect(screen.queryByText('Retained conversation: new-group')).toBeNull()
})

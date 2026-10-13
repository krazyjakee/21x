import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaskGroupRecord } from '@shared/task-groups'
import { TaskGroupDialog } from './TaskGroupDialog'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus, type Task } from '@/types'
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remove: vi.fn(), move: vi.fn(), dissolve: vi.fn(), review: vi.fn() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), taskGroupsApi: mocks }))
vi.mock('@/components/tasks/TaskWorkspace', () => ({ TaskWorkspace: ({ task, groupExecution }: { task: Task; groupExecution: string }) => <div data-testid="shared-execution" data-execution-id={task.id} data-mode={groupExecution}>Retained transcript</div> }))
const group: TaskGroupRecord = { id: 'batch', title: 'Checkout polish', project_id: 'project', agent_id: 'agent', execution_task_id: 'execution', state: 'active', status: TaskStatus.ReadyForReview, task_ids: ['one', 'two'], former_task_ids: ['former'], progress: [], created_at: '', updated_at: '' }
const task = (id: string, status = TaskStatus.ReadyForReview): Task => ({ id, title: id, status } as Task)
let current = group
beforeEach(() => {
  vi.clearAllMocks(); current = group
  useTaskGroupStore.setState({ projects: {}, snapshots: {}, errors: {}, busy: {} })
  mocks.get.mockImplementation(async () => ({ group: current, task: task('execution'), members: [task('one'), task('two'), task('former')] }))
  mocks.list.mockImplementation(async () => current.state === 'active' ? [current] : [])
  vi.spyOn(useTaskStore.getState(), 'fetchTasks').mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('uses one hidden execution workspace and reviews only the selected member with explicit source choice', async () => {
  mocks.review.mockResolvedValue({ group, completed_task_ids: [], failures: [{ task_id: 'two', message: 'Issue source is offline; task remains ready for review.' }] })
  render(<TaskGroupDialog groupId="batch" onClose={() => {}} />)
  const selected = await screen.findByRole('checkbox', { name: 'Select two for review' })
  expect(screen.getByTestId('shared-execution')).toHaveAttribute('data-execution-id', 'execution')
  expect(screen.getByRole('checkbox', { name: 'Select former for review' })).toBeDisabled()
  fireEvent.click(selected)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Complete at task sources' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }))
  await waitFor(() => expect(mocks.review).toHaveBeenCalledWith({ group_id: 'batch', task_ids: ['two'], action: 'approve', complete_at_source: false, message: undefined }))
  expect(await screen.findByRole('alert')).toHaveTextContent('two: Issue source is offline')
  expect(selected).toBeChecked()
  expect(screen.getByRole('button', { name: 'Approve selected' })).not.toBeDisabled()
})
it('sends selected members back with feedback and default task-source completion preference', async () => {
  mocks.review.mockResolvedValue({ group, completed_task_ids: [], failures: [] })
  render(<TaskGroupDialog groupId="batch" onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select one for review' }))
  fireEvent.change(screen.getByLabelText('Group review feedback'), { target: { value: 'Adjust the checkout label.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send selected back' }))
  await waitFor(() => expect(mocks.review).toHaveBeenCalledWith({ group_id: 'batch', task_ids: ['one'], action: 'send_back', complete_at_source: true, message: 'Adjust the checkout label.' }))
  expect(await screen.findByText('Selected tasks sent back.')).toBeTruthy()
})
it('retains former member history and transcript after dissolution and removes execution controls', async () => {
  current = { ...group, state: 'dissolved', task_ids: [], former_task_ids: ['one', 'two', 'former'] }
  render(<TaskGroupDialog groupId="batch" onClose={() => {}} />)
  expect(await screen.findByTestId('shared-execution')).toHaveAttribute('data-mode', 'history')
  expect(screen.getAllByText('Removed from group · history retained')).toHaveLength(3)
  expect(screen.queryByRole('button', { name: 'Approve selected' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Dissolve group' })).toBeNull()
})

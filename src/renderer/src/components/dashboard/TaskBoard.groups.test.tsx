import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TaskGroupRecord } from '@shared/task-groups'
import { TaskBoard } from './TaskBoard'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { useBoardOrderStore } from '@/stores/board-order-store'
import { useTaskGroupStore } from '@/stores/task-group-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus, type Task } from '@/types'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remove: vi.fn(), move: vi.fn(), history: vi.fn(), dissolve: vi.fn(), review: vi.fn() }))
vi.mock('@/lib/ipc-client', async original => ({ ...await original<typeof import('@/lib/ipc-client')>(), taskGroupsApi: mocks }))
vi.mock('@/components/task-groups/TaskGroupDialog', () => ({ TaskGroupDialog: ({ groupId }: { groupId: string | null }) => groupId ? <p>Shared conversation: {groupId}</p> : null }))
const group: TaskGroupRecord = { id: 'batch', title: 'Checkout polish', project_id: 'project', agent_id: 'agent', execution_task_id: 'execution', state: 'active', status: TaskStatus.NotStarted, task_ids: ['one', 'two'], former_task_ids: [], progress: [{ task_id: 'one', state: 'done', message: 'Copy fixed; user review remains.', updated_at: '2026-01-01' }], created_at: '2026-01-01', updated_at: '2026-01-01' }
const task = (id: string, groupId?: string): Task => ({ id, title: id, description: '', status: TaskStatus.NotStarted, group_id: groupId, labels: [], priority: 'low', project_id: 'project', parent_task_id: null, created_at: '2026-01-01', updated_at: '2026-01-01' } as unknown as Task)
beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProjectId: 'project' }); useBoardOrderStore.setState({ orders: {} })
  useUIStore.setState({ dashboardPreviewTaskId: null })
  useTaskStore.setState({ tasks: [task('one', 'batch'), task('two', 'batch'), task('single')], isLoading: false })
  useTaskGroupStore.setState({ projects: {}, snapshots: {}, busy: {}, errors: {} })
  mocks.list.mockResolvedValue([group]); mocks.remove.mockRejectedValue(new Error('Stop the shared session before removing a task.'))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('renders a group as one distinct board unit, hides independent member drag cards, and opens the shared conversation', async () => {
  render(<TaskBoard />)
  const card = await screen.findByTestId('task-group-batch')
  expect(card).toHaveClass('border-2')
  expect(card).toHaveTextContent('Task group · 2 tasks')
  expect(screen.queryByTestId('task-card-one')).toBeNull(); expect(screen.queryByTestId('task-card-two')).toBeNull()
  expect(screen.getByTestId('task-card-single')).toBeTruthy()
  fireEvent.click(within(card).getByText('Show members'))
  const member = screen.getByTestId('group-member-one')
  expect(member).not.toHaveAttribute('draggable')
  expect(member).not.toHaveAttribute('role', 'button')
  expect(member).toHaveTextContent('Agent finished · awaiting review')
  expect(member).not.toHaveTextContent('Approved')
  fireEvent.click(within(card).getByRole('button', { name: 'Checkout polish' }))
  expect(screen.getByText('Shared conversation: batch')).toBeTruthy()
})
it('surfaces a refused removal and preserves the member in its original group', async () => {
  render(<TaskBoard />)
  const card = await screen.findByTestId('task-group-batch')
  fireEvent.click(within(card).getByText('Show members'))
  fireEvent.click(within(card).getByRole('button', { name: 'Remove one from group' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Stop the shared session')
  expect(mocks.remove).toHaveBeenCalledWith('batch', 'one')
  expect(screen.getByTestId('group-member-one')).toBeTruthy()
  expect(screen.queryByTestId('task-card-one')).toBeNull()
})
it('uses Enter to open a group or ordinary task instead of accidentally starting a drag', async () => {
  render(<TaskBoard />)
  const card = await screen.findByTestId('task-group-batch')
  fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' })
  expect(screen.getByText('Shared conversation: batch')).toBeTruthy()
  expect(card).not.toHaveAttribute('aria-pressed', 'true')
  expect(mocks.move).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByTestId('task-card-single'), { key: 'Enter', code: 'Enter' })
  expect(useUIStore.getState().dashboardPreviewTaskId).toBe('single')
})
it('moves the whole group card when the server acknowledges a new lifecycle and preserves completed members', async () => {
  render(<TaskBoard />)
  await screen.findByTestId('task-group-batch')
  act(() => {
    useTaskGroupStore.setState({ projects: { project: [{ ...group, status: TaskStatus.AgentWorking }] } })
    useTaskStore.setState({ tasks: [{ ...task('one', 'batch'), status: TaskStatus.Completed }, { ...task('two', 'batch'), status: TaskStatus.AgentWorking }] })
  })
  await waitFor(() => expect(screen.getByTestId('task-column-agent_working')).toContainElement(screen.getByTestId('task-group-batch')))
  expect(screen.queryByTestId('task-card-one')).toBeNull()
  fireEvent.click(screen.getByText('Show members'))
  expect(screen.getByTestId('group-member-one')).toHaveTextContent('Approved')
  expect(screen.getByRole('button', { name: 'Remove two from group' })).toBeDisabled()
})

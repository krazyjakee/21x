import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaskBoard } from './TaskBoard'
import { useTaskStore } from '@/stores/task-store'
import { useBoardOrderStore } from '@/stores/board-order-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus, type Task } from '@/types'

vi.mock('@/hooks/use-snooze-tick', () => ({ useSnoozeTick: () => 0 }))
const older = '2026-01-01T00:00:00.000Z'
const newer = '2026-01-02T00:00:00.000Z'
const newest = '2026-01-03T00:00:00.000Z'
const task = (id: string, status = TaskStatus.NotStarted, activity = older): Task => ({
  id, title: id, description: '', status, priority: 'medium', labels: [],
  project_id: 'project', created_at: older, updated_at: older, last_activity_at: activity
} as unknown as Task)
function order(status = TaskStatus.NotStarted): (string | null)[] {
  return Array.from(screen.getByTestId(`task-column-${status}`).querySelectorAll('[data-testid^="task-card-"]'))
    .map((el) => el.getAttribute('data-testid')?.replace('task-card-', '') ?? null)
}
function refresh(tasks: Task[]): void { act(() => useTaskStore.setState({ tasks })) }
beforeEach(() => {
  useTaskStore.setState({ tasks: [], isLoading: false })
  useProjectStore.setState({ currentProjectId: 'project' })
  useBoardOrderStore.setState({ orders: {} })
  useUIStore.setState({ dashboardPreviewTaskId: null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('moves a status-changed task to the top of its destination and ignores passive refresh order', () => {
  const moving = task('moving')
  const resident = task('resident', TaskStatus.AgentWorking, newer)
  refresh([resident, moving])
  render(<TaskBoard />)
  const moved = { ...moving, status: TaskStatus.AgentWorking, last_activity_at: newest }
  refresh([resident, moved])
  expect(order(TaskStatus.AgentWorking)).toEqual(['moving', 'resident'])
  refresh([{ ...resident, updated_at: '2099-01-01T00:00:00.000Z' }, { ...moved }])
  expect(order(TaskStatus.AgentWorking)).toEqual(['moving', 'resident'])
})

it('honours manual order and lets the user return just that column to activity order', () => {
  refresh([task('older'), task('newer', TaskStatus.NotStarted, newer), task('working', TaskStatus.AgentWorking)])
  useBoardOrderStore.getState().setColumnOrder('project', TaskStatus.NotStarted, ['older', 'newer'])
  render(<TaskBoard />)
  expect(order()).toEqual(['older', 'newer'])
  fireEvent.click(screen.getByRole('button', { name: 'Sort by activity' }))
  expect(order()).toEqual(['newer', 'older'])
  expect(order(TaskStatus.AgentWorking)).toEqual(['working'])
  expect(screen.queryByRole('button', { name: 'Sort by activity' })).toBeNull()
})

it('defers activity sorting while a task preview is open and applies it on close', () => {
  const old = task('older')
  const recent = task('newer', TaskStatus.NotStarted, newer)
  refresh([old, recent])
  render(<TaskBoard />)
  fireEvent.click(screen.getByTestId('task-card-older'))
  refresh([{ ...old, last_activity_at: newest }, recent])
  expect(order()).toEqual(['newer', 'older'])
  act(() => useUIStore.setState({ dashboardPreviewTaskId: null }))
  expect(order()).toEqual(['older', 'newer'])
})

it('holds card order during an actual keyboard drag and releases it on cancellation', async () => {
  const old = task('older')
  const recent = task('newer', TaskStatus.NotStarted, newer)
  refresh([old, recent])
  render(<TaskBoard />)
  const card = screen.getByTestId('task-card-older')
  card.focus()
  fireEvent.keyDown(card, { key: ' ', code: 'Space' })
  await waitFor(() => expect(screen.getByTestId('task-column-completed').dataset.dropActive).toBe('true'))
  refresh([{ ...old, last_activity_at: newest }, recent])
  expect(order()).toEqual(['newer', 'older'])
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  fireEvent.keyDown(card, { key: 'Escape', code: 'Escape' })
  expect(order()).toEqual(['older', 'newer'])
})

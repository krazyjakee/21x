import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { AgentStatusEvent } from '@/types/electron'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { useBoardOrderStore } from '@/stores/board-order-store'
import { __resetSessionActivity } from '@/lib/activity/session-activity-adapter'
import { __setActivityTimeSource, __resetActivityClock, revalidateActivityNow } from '@/lib/activity/activity-clock'
import { __resetMotionOwners } from '@/lib/activity/motion-owner'
import { TaskBoard } from '@/components/dashboard/TaskBoard'
import { TaskHeaderBar } from '@/components/tasks/TaskHeaderBar'
import { TaskStatus, type Task } from '@/types'

vi.mock('@/hooks/use-snooze-tick', () => ({ useSnoozeTick: () => 0 }))

// agent-store registers its agent:status listener once, at module init.
const statusCallback = (window.electronAPI.onAgentStatus as unknown as Mock).mock.calls[0][0] as (e: AgentStatusEvent) => void

let now = 0
const push = (e: Partial<AgentStatusEvent> & Record<string, unknown>) =>
  act(() => statusCallback({ sessionId: 's1', agentId: 'a', taskId: 't1', status: SessionStatus.WORKING, ...e } as AgentStatusEvent))

function task(id: string, status: TaskStatus = TaskStatus.AgentWorking): Task {
  return {
    id, title: id, description: '', status, priority: 'medium', labels: [],
    project_id: 'project', parent_task_id: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-01-01T00:00:00.000Z'
  } as unknown as Task
}

function mockReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  }))
  window.matchMedia = globalThis.matchMedia
}

function card(id: string): HTMLElement {
  return screen.getByTestId(`task-card-${id}`)
}

beforeEach(() => {
  now = 10_000
  __setActivityTimeSource(() => now)
  __resetActivityClock()
  __resetSessionActivity()
  mockReducedMotion(false)
  useAgentStore.setState({ sessions: new Map() })
  useTaskStore.setState({ tasks: [], isLoading: false })
  useProjectStore.setState({ currentProjectId: 'project' })
  useBoardOrderStore.setState({ orders: {} })
  useUIStore.setState({ dashboardPreviewTaskId: null })
})

afterEach(() => {
  cleanup()
  __resetMotionOwners()
  __setActivityTimeSource(null)
  vi.unstubAllGlobals()
})

describe('board cards (#95)', () => {
  it('a lifecycle status alone never claims the session is running', () => {
    useTaskStore.setState({ tasks: [task('t1')] })
    render(<TaskBoard />)
    expect(card('t1').querySelector('[data-activity-state]')).toBeNull()
  })

  it('shows the derived state once there is live evidence', () => {
    useTaskStore.setState({ tasks: [task('t1')] })
    render(<TaskBoard />)
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    expect(screen.getByRole('img', { name: 't1 — Running' })).toBeInTheDocument()
    push({ status: SessionStatus.WAITING_APPROVAL, epoch: 'E', seq: 2 })
    expect(screen.getByRole('img', { name: 't1 — Needs approval' })).toBeInTheDocument()
  })

  it('the board is one motion region: many running cards, at most one moves', () => {
    useTaskStore.setState({ tasks: [task('t1'), task('t2'), task('t3')] })
    render(<TaskBoard />)
    push({ taskId: 't1', sessionId: 's1', epoch: 'E', seq: 1 })
    push({ taskId: 't2', sessionId: 's2', epoch: 'E', seq: 2 })
    push({ taskId: 't3', sessionId: 's3', epoch: 'E', seq: 3 })
    const motions = ['t1', 't2', 't3'].map((id) => card(id).querySelector('[data-activity-motion]')?.getAttribute('data-activity-motion'))
    expect(motions.filter((m) => m === 'breathe')).toHaveLength(1)
    expect(motions.filter((m) => m === 'none')).toHaveLength(2)
    // Every card still states its activity in words, not by motion alone.
    for (const id of ['t1', 't2', 't3']) expect(screen.getByRole('img', { name: `${id} — Running` })).toBeInTheDocument()
  })

  it('nothing on the board moves under prefers-reduced-motion', () => {
    mockReducedMotion(true)
    useTaskStore.setState({ tasks: [task('t1'), task('t2')] })
    const { container } = render(<TaskBoard />)
    push({ taskId: 't1', sessionId: 's1', epoch: 'E', seq: 1 })
    push({ taskId: 't2', sessionId: 's2', epoch: 'E', seq: 2 })
    expect(container.querySelector('.activity-breathe')).toBeNull()
    expect([...container.querySelectorAll('[data-activity-motion]')].map((el) => el.getAttribute('data-activity-motion')))
      .toEqual(['none', 'none'])
  })

  it('a card whose evidence expires reads as unknown, not idle and not running', () => {
    useTaskStore.setState({ tasks: [task('t1')] })
    render(<TaskBoard />)
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    now += 15_000
    act(() => revalidateActivityNow())
    expect(screen.getByRole('img', { name: 't1 — Status unavailable · Last seen running' })).toBeInTheDocument()
    expect(card('t1').querySelector('[data-activity-motion]')?.getAttribute('data-activity-motion')).toBe('none')
  })
})

describe('task header bar (#95)', () => {
  const props = {
    onRename: () => {}, detailsOpen: false, showDetailsToggle: false,
    onToggleDetails: () => {}, onEdit: () => {}, onDelete: () => {}
  }

  it('shows the live activity beside the durable status badge', () => {
    useTaskStore.setState({ tasks: [task('t1')] })
    render(<TaskHeaderBar task={task('t1')} {...props} />)
    expect(screen.queryByRole('img', { name: /t1 —/ })).toBeNull()
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    expect(screen.getByRole('img', { name: 't1 — Running' })).toBeInTheDocument()
  })

  it('renders no badge when the surrounding chrome owns it (canvas panels)', () => {
    useTaskStore.setState({ tasks: [task('t1')] })
    render(<TaskHeaderBar task={task('t1')} {...props} showActivity={false} />)
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    expect(screen.queryByRole('img', { name: 't1 — Running' })).toBeNull()
  })
})

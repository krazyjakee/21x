import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityAnnouncer } from './ActivityAnnouncer'
import { __resetSessionActivity, recordAgentStatus } from '@/lib/activity/session-activity-adapter'
import { __resetActivityClock, __setActivityTimeSource, revalidateActivityNow } from '@/lib/activity/activity-clock'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import type { Task } from '@/types'

let now = 0

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1 })
  now = 0
  __setActivityTimeSource(() => now)
  __resetActivityClock()
  __resetSessionActivity()
  useProjectStore.setState({ currentProjectId: 'p' })
  useTaskStore.setState({
    tasks: [{ id: 't', title: 'Build', project_id: 'p', status: 'agent_working', parent_task_id: null } as Task]
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __setActivityTimeSource(null)
  __resetActivityClock()
  __resetSessionActivity()
})

describe('ActivityAnnouncer connection freshness', () => {
  it('announces loss and restoration, but not the first live observation', async () => {
    render(<ActivityAnnouncer />)
    act(() => {
      recordAgentStatus({ sessionId: 's', agentId: 'a', taskId: 't', status: 'working', epoch: 'E', seq: 1 }, now)
    })
    expect(screen.getByRole('status')).toHaveTextContent('')

    now = 15_000
    act(() => revalidateActivityNow())
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByRole('status')).toHaveTextContent('Build connection lost')

    now = 16_000
    act(() => {
      recordAgentStatus({ sessionId: 's', agentId: 'a', taskId: 't', status: 'working', epoch: 'E', seq: 2, heartbeat: true }, now)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByRole('status')).toHaveTextContent('Build connection restored')
  })

  it('does not announce a stale first sighting or a later recovery from that silent baseline', async () => {
    now = 20_000
    recordAgentStatus({ sessionId: 's', agentId: 'a', taskId: 't', status: 'working', epoch: 'E', seq: 1 }, 0)
    render(<ActivityAnnouncer />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByRole('status')).toHaveTextContent('')

    now = 21_000
    act(() => {
      recordAgentStatus({ sessionId: 's', agentId: 'a', taskId: 't', status: 'working', epoch: 'E', seq: 2, heartbeat: true }, now)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByRole('status')).toHaveTextContent('')
  })
})

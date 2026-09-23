import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityAnnouncer } from './ActivityAnnouncer'
import { __resetSessionActivity, recordAgentStatus } from '@/lib/activity/session-activity-adapter'
import {
  __resetActivityClock,
  __setActivityTimeSource,
  pendingActivityDeadlines,
  revalidateActivityNow,
  useActivityClock
} from '@/lib/activity/activity-clock'
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

  it('expires on its own, announces once, and then leaves the shared clock quiet', async () => {
    // THE LOOP. The announcer re-registered the already-passed expiry on every
    // clock tick, so one stale observation re-armed the shared clock every
    // 25 ms and woke every indicator subscribed to it, indefinitely.
    const advance = async (ms: number) => {
      now += ms
      await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    }
    await act(async () => { render(<ActivityAnnouncer />) })
    act(() => {
      recordAgentStatus({ sessionId: 's', agentId: 'a', taskId: 't', status: 'working', epoch: 'E', seq: 1 }, now)
    })
    expect(pendingActivityDeadlines()).toBe(1)

    // No manual revalidation: the scheduled expiry alone must do it.
    await advance(15_025)
    const settled = useActivityClock.getState().tick
    await advance(2_000)
    expect(screen.getByRole('status')).toHaveTextContent('Build connection lost')

    // Ten more seconds of nothing: no further ticks, no timer left armed.
    for (let i = 0; i < 400; i++) await advance(25)
    expect(useActivityClock.getState().tick).toBe(settled)
    expect(pendingActivityDeadlines()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    // Fresh evidence re-arms a single future expiry and is announced.
    act(() => {
      recordAgentStatus({ sessionId: 's', agentId: 'a', taskId: 't', status: 'working', epoch: 'E', seq: 2, heartbeat: true }, now)
    })
    expect(pendingActivityDeadlines()).toBe(1)
    await advance(2_000)
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

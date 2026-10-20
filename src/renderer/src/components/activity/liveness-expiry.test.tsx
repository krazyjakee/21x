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
import { __setActivityTimeSource, __resetActivityClock, useActivityClock } from '@/lib/activity/activity-clock'
import { __resetMotionOwners } from '@/lib/activity/motion-owner'
import { ActivityAnnouncer } from './ActivityAnnouncer'
import { TaskBoard } from '@/components/dashboard/TaskBoard'
import { TaskHeaderBar } from '@/components/tasks/TaskHeaderBar'
import { TaskStatus, type Task } from '@/types'

// The whole renderer path of #95 with nothing driven by hand: the mounted board,
// task header and global announcer, the shared deadline clock on fake timers,
// and heartbeats that simply stop arriving — as they do once a dead backend is
// no longer renewed by the main process. No call to revalidateActivityNow.

vi.mock('@/hooks/use-snooze-tick', () => ({ useSnoozeTick: () => 0 }))

// agent-store registers its agent:status listener once, at module init.
const statusCallback = (window.electronAPI.onAgentStatus as unknown as Mock).mock.calls[0][0] as (e: AgentStatusEvent) => void

const STALE_MS = 15_000
const FIRE_MARGIN_MS = 25
const RUNNING = 't1 — Running'
const UNAVAILABLE = 't1 — Status unavailable · Last seen running'

let now = 0
const heartbeat = (seq: number) =>
  act(() => statusCallback({ sessionId: 's1', agentId: 'a', taskId: 't1', status: SessionStatus.WORKING, epoch: 'E', seq, heartbeat: seq > 1 } as AgentStatusEvent))
const advance = async (ms: number) => {
  now += ms
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const tick = () => useActivityClock.getState().tick
/** The announcer coalesces routine messages for 2 s, then speaks on the next frame. */
const ANNOUNCE_MS = 2_500
const moving = () => document.querySelectorAll('.activity-breathe').length

function task(id: string): Task {
  return {
    id, title: id, description: '', status: TaskStatus.AgentWorking, priority: 'medium', labels: [],
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

function setVisibility(state: 'visible' | 'hidden'): void {
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

const headerProps = {
  onRename: () => {}, detailsOpen: false, showDetailsToggle: false,
  onToggleDetails: () => {}, onEdit: () => {}, onDelete: () => {}
}

async function mountEverything(): Promise<void> {
  await act(async () => {
    render(
      <>
        <TaskBoard />
        <TaskHeaderBar task={task('t1')} {...headerProps} />
        <ActivityAnnouncer />
      </>
    )
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  now = 10_000
  __setActivityTimeSource(() => now)
  __resetActivityClock()
  __resetSessionActivity()
  mockReducedMotion(false)
  useAgentStore.setState({ sessions: new Map() })
  useTaskStore.setState({ tasks: [task('t1')], isLoading: false })
  useProjectStore.setState({ currentProjectId: 'project' })
  useBoardOrderStore.setState({ orders: {} })
  useUIStore.setState({ dashboardPreviewTaskId: null })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  __resetMotionOwners()
  __resetActivityClock()
  __setActivityTimeSource(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('activity expires on its own once heartbeats stop (#95)', () => {
  it('goes from Running to unknown 15 s after the last real heartbeat, announces it once, then stays quiet', async () => {
    await mountEverything()
    heartbeat(1)
    await advance(5_000)
    heartbeat(2)
    const lastHeartbeatAt = now
    expect(screen.getAllByRole('img', { name: RUNNING })).toHaveLength(2)
    // Board and header are separate regions, but one entity moves in one place.
    expect(moving()).toBe(1)

    // Hidden: nothing moves, and the claim is not renewed by being hidden.
    setVisibility('hidden')
    expect(moving()).toBe(0)
    setVisibility('visible')
    expect(moving()).toBe(1)

    // Just before the deadline it is still Running...
    await advance(STALE_MS - 1_000)
    expect(screen.getAllByRole('img', { name: RUNNING })).toHaveLength(2)

    // ...and just after, both surfaces say unknown and stop moving — without
    // anyone revalidating by hand.
    await advance(1_000 + FIRE_MARGIN_MS)
    expect(now - lastHeartbeatAt).toBeLessThan(20_000)
    expect(screen.getAllByRole('img', { name: UNAVAILABLE })).toHaveLength(2)
    expect(screen.queryByRole('img', { name: RUNNING })).toBeNull()
    expect(moving()).toBe(0)

    await advance(ANNOUNCE_MS)
    expect(screen.getByTestId('activity-announcer')).toHaveTextContent('t1 connection lost')

    // Settled: ten seconds in 25 ms steps wake no subscriber. Before the fix
    // the announcer re-armed the passed expiry and this was one tick per step.
    const settled = tick()
    for (let i = 0; i < 400; i++) await advance(FIRE_MARGIN_MS)
    expect(tick()).toBe(settled)
    expect(screen.getAllByRole('img', { name: UNAVAILABLE })).toHaveLength(2)
  })

  it('under reduced motion nothing moves, and expiry still happens on its own', async () => {
    mockReducedMotion(true)
    await mountEverything()
    heartbeat(1)
    expect(screen.getAllByRole('img', { name: RUNNING })).toHaveLength(2)
    expect(moving()).toBe(0)

    await advance(STALE_MS + FIRE_MARGIN_MS)
    expect(screen.getAllByRole('img', { name: UNAVAILABLE })).toHaveLength(2)

    const settled = tick()
    for (let i = 0; i < 100; i++) await advance(FIRE_MARGIN_MS)
    expect(tick()).toBe(settled)
  })

  it('a fresh heartbeat after expiry restores Running and re-arms one future expiry', async () => {
    await mountEverything()
    heartbeat(1)
    await advance(STALE_MS + FIRE_MARGIN_MS)
    expect(screen.getAllByRole('img', { name: UNAVAILABLE })).toHaveLength(2)
    await advance(ANNOUNCE_MS)
    expect(screen.getByTestId('activity-announcer')).toHaveTextContent('t1 connection lost')

    heartbeat(2)
    expect(screen.getAllByRole('img', { name: RUNNING })).toHaveLength(2)
    await advance(ANNOUNCE_MS)
    expect(screen.getByTestId('activity-announcer')).toHaveTextContent('t1 connection restored')

    await advance(STALE_MS)
    expect(screen.getAllByRole('img', { name: UNAVAILABLE })).toHaveLength(2)
  })
})

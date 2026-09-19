import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mock } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { AgentStatusEvent } from '@/types/electron'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useTaskStore } from '@/stores/task-store'
import { useProjectStore } from '@/stores/project-store'
import { __resetSessionActivity, useSessionActivityStore } from '@/lib/activity/session-activity-adapter'
import { __setActivityTimeSource, __resetActivityClock, revalidateActivityNow } from '@/lib/activity/activity-clock'
import { __resetMotionOwners } from '@/lib/activity/motion-owner'
import { StatusBar } from '@/components/layout/StatusBar'
import { TaskActivityBadge } from './TaskActivityBadge'
import type { Task } from '@/types'

// agent-store registers its agent:status listener once, at module init.
const statusCallback = (window.electronAPI.onAgentStatus as unknown as Mock).mock.calls[0][0] as (e: AgentStatusEvent) => void

let now = 0
const push = (e: Partial<AgentStatusEvent> & Record<string, unknown>) =>
  act(() => statusCallback({ sessionId: 's1', agentId: 'a', taskId: 't1', status: SessionStatus.WORKING, ...e } as AgentStatusEvent))

function task(id: string, status: string, extra: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, status, project_id: useProjectStore.getState().currentProjectId, parent_task_id: null, ...extra } as unknown as Task
}

beforeEach(() => {
  now = 10_000
  __setActivityTimeSource(() => now)
  __resetActivityClock()
  __resetSessionActivity()
  useAgentStore.setState({ sessions: new Map() })
})

afterEach(() => {
  cleanup()
  __resetMotionOwners()
  __setActivityTimeSource(null)
})

describe('agent-store and heartbeats', () => {
  it('a heartbeat renews activity freshness but does not touch the agent store', () => {
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    const before = useAgentStore.getState().sessions
    now += 5_000
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 2, heartbeat: true })
    expect(useAgentStore.getState().sessions).toBe(before)
    expect(useSessionActivityStore.getState().sessions.t1.observedAt).toBe(now)
  })

  it('a transition still updates the agent store as before', () => {
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    push({ status: SessionStatus.WAITING_APPROVAL, epoch: 'E', seq: 2 })
    expect(useAgentStore.getState().sessions.get('t1')?.status).toBe(SessionStatus.WAITING_APPROVAL)
  })
})

describe('surfaces', () => {
  it('StatusBar counts only fresh running sessions of this project and hosts one announcer', () => {
    useTaskStore.setState({ tasks: [task('t1', 'agent_working'), task('t2', 'agent_working'), task('t3', 'ready_for_review')] })
    push({ taskId: 't1', sessionId: 's1', status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    push({ taskId: 't2', sessionId: 's2', status: SessionStatus.WAITING_APPROVAL, epoch: 'E', seq: 2 })
    push({ taskId: 'elsewhere', sessionId: 's9', status: SessionStatus.WORKING, epoch: 'E', seq: 3 })
    render(<StatusBar />)
    expect(screen.getByTestId('status-running')).toHaveTextContent('1 running')
    expect(screen.getByTestId('status-needs-input')).toHaveTextContent('1 needs input')
    expect(screen.getByTestId('status-review')).toHaveTextContent('1 ready for review')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    // Nothing in the status bar animates.
    expect(document.querySelector('.animate-pulse, .activity-breathe')).toBeNull()
  })

  it('TaskActivityBadge: lifecycle alone shows nothing; a lost running claim shows unavailable', () => {
    useTaskStore.setState({ tasks: [task('t1', 'agent_working')] })
    const { container, rerender } = render(<TaskActivityBadge taskId="t1" title="Task t1" region="r" />)
    expect(container).toBeEmptyDOMElement()
    push({ status: SessionStatus.WORKING, epoch: 'E', seq: 1 })
    rerender(<TaskActivityBadge taskId="t1" title="Task t1" region="r" />)
    expect(screen.getByRole('img', { name: 'Task t1 — Running' })).toBeInTheDocument()
    now += 15_000
    act(() => revalidateActivityNow())
    rerender(<TaskActivityBadge taskId="t1" title="Task t1" region="r2" />)
    expect(screen.getByRole('img', { name: 'Task t1 — Status unavailable · Last seen running' })).toBeInTheDocument()
  })
})

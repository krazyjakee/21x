import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { getDesktopHost } from '@/lib/desktop-api'
import { useAgentStore } from '@/stores/agent-store'
import { useTaskStore } from '@/stores/task-store'
import { TaskStatus } from '@/types'
import type { Task } from '@/types'
import { TranscriptPanelContent } from './TranscriptPanelContent'

const panel = vi.hoisted(() => ({
  restart: undefined as (() => Promise<void> | void) | undefined,
  session: { sessionId: null as string | null, status: 'idle', messages: [{ id: 'message-1', role: 'assistant', content: 'Retained' }] },
  order: [] as string[]
}))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({
  AgentTranscriptPanel: ({ onRestart }: { onRestart?: () => Promise<void> | void }) => { panel.restart = onRestart; return null }
}))
vi.mock('@/hooks/use-agent-session', () => ({
  useAgentSession: () => ({
    session: panel.session,
    stop: async () => { panel.order.push('stop') },
    start: async (agentId: string, taskId: string) => { panel.order.push(`start:${agentId}:${taskId}`); return 'fresh-session' },
    resume: vi.fn(), sendMessage: vi.fn(), approve: vi.fn()
  })
}))

const task = (extra: Partial<Task> = {}) => ({ id: 'task-1', role: 'task', status: TaskStatus.ReadyForReview, agent_id: 'agent-1', session_id: 'retained-session', ...extra }) as Task
const removeSession = useAgentStore.getState().removeSession
const show = (extra: Partial<Task> = {}) => {
  useTaskStore.setState({ tasks: [task(extra)] })
  render(<TranscriptPanelContent taskId="task-1" />)
}
beforeEach(() => {
  panel.restart = undefined; panel.order = []; panel.session = { ...panel.session, sessionId: null }
  useAgentStore.setState({ removeSession: (taskId: string) => { panel.order.push(`remove:${taskId}`) } })
})
afterEach(() => {
  cleanup(); vi.clearAllMocks()
  useAgentStore.setState({ removeSession }); useTaskStore.setState({ tasks: [] })
})

it('runs on the Electron host, so a leaked native gate fails below', () => {
  expect(getDesktopHost().kind).toBe('electron')
})

it('keeps the Electron restart of a live session: stop, remove, then start', async () => {
  panel.session = { ...panel.session, sessionId: 'live-session' }
  show()
  await panel.restart!()
  expect(panel.order).toEqual(['stop', 'remove:task-1', 'start:agent-1:task-1'])
})

it('keeps the Electron restart of an idle session: remove, then start', async () => {
  show()
  await panel.restart!()
  expect(panel.order).toEqual(['remove:task-1', 'start:agent-1:task-1'])
})

it.each([
  ['a Completed task', { status: TaskStatus.Completed }],
  ['a Captain', { role: 'captain' }]
] as Array<[string, Partial<Task>]>)('does not apply the native refusal to %s on Electron', async (_name, extra) => {
  show(extra)
  await panel.restart!()
  expect(panel.order).toEqual(['remove:task-1', 'start:agent-1:task-1'])
})

it('adds no owner reads to the Electron restart', async () => {
  show()
  await panel.restart!()
  expect(window.electronAPI.agents.getStartRecoveryState).not.toHaveBeenCalled()
  expect(window.electronAPI.db.getTask).not.toHaveBeenCalled()
})

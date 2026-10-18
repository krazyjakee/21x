import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Task, UpdateTaskDTO } from '@/types'
import { TaskStatus } from '@shared/constants'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
const held = <T,>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
const task = (extra: Partial<Task> = {}): Task => ({ id: 'task-1', title: 'Captured completion', description: '', type: 'general', role: 'task', priority: 'medium', status: 'ready_for_review', assignee: '', source: 'manual', project_id: 'default', created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null, resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null, heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null, is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false, labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null, recurrence_pattern: null, heartbeat_interval_minutes: null, complete_at_source: null, next_subtask_ids: [], sort_order: 0, ...extra } as Task)

let canonical: Task[] = []
const values = new Map<string, unknown>(), handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'feedback-engine', uiLeaseId: 'feedback-document' }
  const op = String(args?.operation), result = handlers.has(op) ? await handlers.get(op)!(args?.payload as Record<string, unknown>) : values.get(op)
  return { engineEpoch: 'feedback-engine', result: result === undefined ? { defined: false } : { defined: true, value: result } }
})
const calls = (op: string) => invoke.mock.calls.filter(([, args]) => args?.operation === op)
const ensure = vi.fn(async () => 'pre-started'), start = vi.fn(async () => 'pre-started'), complete = vi.fn()
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>, release: () => void
let useFeedback: typeof import('../components/tasks/workspace/useTaskFeedbackFlow').useTaskFeedbackFlow
let useActions: typeof import('./use-agent-session').useAgentSessionActions
let Dialog: typeof import('../components/tasks/FeedbackDialog').FeedbackDialog
let tasks: typeof import('@/stores/task-store').useTaskStore, projects: typeof import('@/stores/project-store').useProjectStore, agents: typeof import('@/stores/agent-store').useAgentStore
let controls: ReturnType<typeof useFeedback>
const legacy = window.electronAPI
function Harness({ taskId = 'task-1' }: { taskId?: string }) {
  const current = tasks(s => s.tasks.find(t => t.id === taskId)), actions = useActions(taskId)
  controls = useFeedback({ task: current, sessionId: agents(s => s.sessions.get(taskId)?.sessionId ?? null), hasMessages: true, onCompleteTask: complete, ensureChatSession: ensure, start, sendMessage: actions.sendMessage })
  return <><button onClick={() => void controls.handleCompleteTask()}>Complete with feedback</button><Dialog open={controls.showFeedback} isBusy={controls.feedbackBusy} review={controls.feedbackReview} sourceName={(controls.feedbackTask ?? current)?.source_id ? (controls.feedbackTask ?? current)?.source : undefined} onSubmit={controls.handleFeedbackSubmit} onSkip={controls.handleFeedbackSkip} onCancel={controls.handleFeedbackCancel} /></>
}
beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  host = (await import('@/lib/native-desktop-host')).createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi)
  release = (await import('@/lib/desktop-api')).installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
  useFeedback = (await import('../components/tasks/workspace/useTaskFeedbackFlow')).useTaskFeedbackFlow; Dialog = (await import('../components/tasks/FeedbackDialog')).FeedbackDialog; useActions = (await import('./use-agent-session')).useAgentSessionActions
  tasks = (await import('@/stores/task-store')).useTaskStore; projects = (await import('@/stores/project-store')).useProjectStore; agents = (await import('@/stores/agent-store')).useAgentStore
})
beforeEach(async () => {
  canonical = [task({ agent_id: 'agent-1', session_id: 'saved-1' })]; values.clear(); handlers.clear(); invoke.mockClear(); ensure.mockClear(); start.mockClear(); complete.mockClear()
  handlers.set('db:getTasks', async () => canonical); handlers.set('db:getTask', async p => canonical.find(row => row.id === p.id))
  handlers.set('db:updateTask', async p => { const row = canonical.find(row => row.id === p.id); if (!row) return undefined; const updated = { ...row, ...p.data as UpdateTaskDTO }; canonical = canonical.map(row => row.id === p.id ? updated : row); return updated })
  handlers.set('agentSession:getTranscriptPage', async p => ({ version: 1, taskId: p.taskId, mode: (p.page as { mode: string }).mode, after: (p.page as { after: number }).after, cursor: (p.page as { after: number }).after, watermark: (p.page as { after: number }).after, hasMore: false, parts: [] })); values.set('settings:get', null); values.set('agentSession:send', { success: true }); values.set('agentSession:sendByTaskId', { success: true, sessionId: 'recovered-1' })
  tasks.setState({ tasks: canonical, selectedTaskId: 'task-1', error: null }); projects.setState({ currentProjectId: 'default' }); agents.setState({ sessions: new Map() }); agents.getState().initSession('task-1', 'saved-1', 'agent-1')
  await host.reconnect(); const store = await import('@/stores/task-store'); store.initializeTaskDesktopState(); await store.rehydrateTaskDesktopState()
})
afterEach(() => { cleanup(); agents.setState({ sessions: new Map() }); vi.restoreAllMocks() })
afterAll(() => { release(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Complete with feedback', hidden: true }))
const choose = () => { const buttons = screen.getAllByRole('button').filter(button => button.querySelector('svg.lucide-star')); fireEvent.click(buttons[3]); fireEvent.change(screen.getByPlaceholderText('Optional feedback...'), { target: { value: 'Captured feedback draft' } }) }
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }))
it('dispatches one native learning marker and the actual retained send owner', async () => {
  render(<Harness />); open(); choose(); submit(); await waitFor(() => expect(calls('agentSession:send')).toHaveLength(1))
  expect(calls('db:updateTask')).toHaveLength(1); expect(canonical[0]).toMatchObject({ status: TaskStatus.AgentLearning, feedback_rating: 4, feedback_comment: 'Captured feedback draft' }); expect(ensure).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
})
it('requires a canonical native learning marker before sending feedback', async () => {
  handlers.set('db:updateTask', async () => undefined); render(<Harness />); open(); choose(); submit()
  await screen.findByRole('alert'); expect(calls('agentSession:send')).toHaveLength(0)
})
it('retains native rating/comment while its raw marker is pending', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />); open(); choose(); submit()
  expect(screen.getByDisplayValue('Captured feedback draft')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Submit Feedback' })).toBeDisabled()
  await act(async () => { raw.resolve(undefined) })
})
it('admits only one native feedback marker before React paints', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />); open(); choose()
  const button = screen.getByRole('button', { name: 'Submit Feedback' }); act(() => { fireEvent.click(button); fireEvent.click(button) })
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1)); await act(async () => { raw.resolve(undefined) })
})
it.each(['project-return', 'pagehide', 'unmount', 'reconnect'] as const)('fences later native feedback send after %s during the owned marker', async mode => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); const view = render(<Harness />); open(); choose(); submit()
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'other' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (mode === 'unmount') view.unmount()
  if (mode === 'reconnect') await act(async () => { await host.reconnect() })
  await act(async () => { canonical = [{ ...canonical[0], status: TaskStatus.AgentLearning, feedback_rating: 4, feedback_comment: 'Captured feedback draft', complete_at_source: true }]; raw.resolve(canonical[0]) })
  expect(calls('agentSession:send')).toHaveLength(0); expect(ensure).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(calls('db:updateTask')).toHaveLength(1)
})
it('refuses a changed observed native task/Source choice before feedback effects', async () => {
  render(<Harness />); open(); choose(); act(() => { canonical = [task({ agent_id: 'agent-1', session_id: 'saved-1', source_id: 'new-source', external_id: '8', source: 'Other Source' })]; tasks.setState({ tasks: canonical }) })
  submit(); await screen.findByRole('alert'); expect(calls('db:updateTask')).toHaveLength(0); expect(calls('agentSession:send')).toHaveLength(0)
})
it('leaves an accepted native learning marker intact when send refuses, without replay', async () => {
  values.set('agentSession:send', { success: false }); render(<Harness />); open(); choose(); submit(); await screen.findByRole('alert')
  expect(canonical[0].status).toBe(TaskStatus.AgentLearning); expect(calls('db:updateTask')).toHaveLength(1); expect(calls('agentSession:send')).toHaveLength(1)
  await act(async () => { await controls.handleFeedbackSubmit(4, 'duplicate', true) }); expect(calls('agentSession:send')).toHaveLength(1)
})
it('uses the retained native sendByTaskId recovery owner without UI pre-resume/create', async () => {
  agents.setState({ sessions: new Map() }); render(<Harness />); open(); choose(); submit()
  await waitFor(() => expect(calls('agentSession:sendByTaskId')).toHaveLength(1)); expect(ensure).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
})
it.each(['captain', 'task_group'] as const)('refuses native ordinary learning for %s before a mutation', async role => {
  canonical = [task({ role, agent_id: 'agent-1', session_id: 'saved-1' })]; tasks.setState({ tasks: canonical }); render(<Harness />); open()
  await screen.findByRole('alert'); expect(calls('db:updateTask')).toHaveLength(0)
})
it('fences a cached native feedback submit after its owning hook unmounts', async () => {
  const view = render(<Harness />); open(); const old = controls.handleFeedbackSubmit; view.unmount()
  await act(async () => { await old(4, 'late', true) }); expect(calls('db:updateTask')).toHaveLength(0); expect(calls('agentSession:send')).toHaveLength(0)
})
it('does not hand a retargeted native feedback Skip to a replacement task binding', async () => {
  render(<Harness />); open(); act(() => { canonical = [task({ agent_id: 'other-agent', session_id: 'saved-1' })]; tasks.setState({ tasks: canonical }) })
  fireEvent.click(screen.getByRole('button', { name: 'Skip' })); expect(complete).not.toHaveBeenCalled(); await screen.findByRole('alert')
})

it('refuses a replaced native session owner before the next learning effect', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />); open(); choose(); submit()
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  act(() => agents.getState().initSession('task-1', 'replacement-session', 'agent-1'))
  await act(async () => { canonical = [{ ...canonical[0], status: TaskStatus.AgentLearning, feedback_rating: 4, feedback_comment: 'Captured feedback draft', complete_at_source: true }]; raw.resolve(canonical[0]) })
  await screen.findByRole('alert'); expect(calls('agentSession:send')).toHaveLength(0); expect(calls('agentSession:sendByTaskId')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(1)
})
it('fences a replacement native task view while the original marker is pending', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); canonical.push(task({ id: 'task-2', agent_id: 'agent-1', session_id: 'saved-2' })); tasks.setState({ tasks: canonical })
  const view = render(<Harness />); open(); choose(); submit(); await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1)); view.rerender(<Harness taskId="task-2" />)
  await act(async () => { const accepted = { ...canonical[0], status: TaskStatus.AgentLearning, feedback_rating: 4, feedback_comment: 'Captured feedback draft', complete_at_source: true }; canonical = [accepted, canonical[1]]; raw.resolve(accepted) })
  expect(calls('agentSession:send')).toHaveLength(0); expect(calls('agentSession:sendByTaskId')).toHaveLength(0); expect(screen.queryByRole('dialog')).toBeNull()
})
it('joins an already admitted native feedback send without reversing its accepted marker after unmount', async () => {
  const raw = held<unknown>(); handlers.set('agentSession:send', () => raw.promise); const view = render(<Harness />); open(); choose(); submit()
  await waitFor(() => expect(calls('agentSession:send')).toHaveLength(1)); view.unmount(); await act(async () => { raw.resolve({ success: true }) })
  expect(calls('db:updateTask')).toHaveLength(1); expect(canonical[0].status).toBe(TaskStatus.AgentLearning); expect(screen.queryByRole('dialog')).toBeNull()
})
it('keeps a refused native feedback intent in review after Close without replay', async () => {
  handlers.set('db:updateTask', async () => undefined); render(<Harness />); open(); choose(); submit(); await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog')).toBeNull(); open(); await screen.findByRole('alert'); expect(calls('db:updateTask')).toHaveLength(1)
})
it('transfers one native Skip choice to the existing completion owner without a learning write', async () => {
  render(<Harness />); open(); fireEvent.click(screen.getByRole('button', { name: 'Skip' })); await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(true))
  expect(calls('db:updateTask')).toHaveLength(0); expect(calls('agentSession:send')).toHaveLength(0); await act(async () => { await controls.handleFeedbackSkip(true) }); expect(complete).toHaveBeenCalledTimes(1)
})
it('allows native cancellation before any feedback effect', async () => {
  render(<Harness />); open(); choose(); fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(calls('db:updateTask')).toHaveLength(0); expect(calls('agentSession:send')).toHaveLength(0)
})
it('disables native dialog Close while the raw learning marker is owned', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />); open(); choose(); submit()
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled(); await act(async () => { raw.resolve(undefined) })
})

it('cannot retarget a cancelled native form submit to a newly opened Source choice', async () => {
  render(<Harness />); open(); choose(); const old = controls.handleFeedbackSubmit
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); act(() => { canonical = [task({ agent_id: 'agent-1', session_id: 'saved-1', source_id: 'replacement-source', external_id: '8', source: 'Replacement Source' })]; tasks.setState({ tasks: canonical }) })
  open(); choose(); await act(async () => { await old(1, 'cancelled original form', false) })
  expect(calls('db:updateTask')).toHaveLength(0); expect(calls('agentSession:send')).toHaveLength(0); expect(screen.getByDisplayValue('Captured feedback draft')).toBeInTheDocument()
})
it('cannot retarget a cancelled native form Skip to a newly opened form', async () => {
  render(<Harness />); open(); const old = controls.handleFeedbackSkip
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); open(); await act(async () => { await old(false) })
  expect(complete).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeInTheDocument()
})
it('cannot close a replacement native feedback form through a cancelled form callback', async () => {
  render(<Harness />); open(); const old = controls.handleFeedbackCancel
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); open(); act(() => old())
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('keeps internal native learning metadata out of the external Source export path', async () => {
  canonical = [task({ agent_id: 'agent-1', session_id: 'saved-1', source_id: 'source-1', external_id: '7', source: 'GitHub' })]; tasks.setState({ tasks: canonical })
  const api = await import('@/lib/ipc-client'), exported = vi.spyOn(api.taskSourceApi, 'exportUpdate')
  render(<Harness />); open(); choose(); submit(); await waitFor(() => expect(calls('agentSession:send')).toHaveLength(1))
  expect(exported).not.toHaveBeenCalled(); expect(calls('db:updateTask')).toHaveLength(1); expect(canonical[0].status).toBe(TaskStatus.AgentLearning)
})

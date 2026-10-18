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
  if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'completion-engine', uiLeaseId: 'completion-document' }
  const op = String(args?.operation), result = handlers.has(op) ? await handlers.get(op)!(args?.payload as Record<string, unknown>) : values.get(op)
  return { engineEpoch: 'completion-engine', result: result === undefined ? { defined: false } : { defined: true, value: result } }
})
const calls = (op: string) => invoke.mock.calls.filter(([, args]) => args?.operation === op)
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>, release: () => void
let useCompletion: typeof import('./use-task-completion').useTaskCompletion
let tasks: typeof import('@/stores/task-store').useTaskStore, projects: typeof import('@/stores/project-store').useProjectStore
let request: ReturnType<typeof useCompletion>['requestComplete']
const toast = vi.fn(), completed = vi.fn(), legacy = window.electronAPI
function Harness({ beforeComplete, viewKey }: { beforeComplete?: () => Promise<void>; viewKey?: string }) {
  const owner = useCompletion({ onToast: toast, viewKey }); request = owner.requestComplete
  return <>{owner.completionDialog}<button onClick={() => void owner.requestComplete('task-1', { beforeComplete, onCompleted: completed })}>Complete captured task</button></>
}
beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  host = (await import('@/lib/native-desktop-host')).createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi)
  release = (await import('@/lib/desktop-api')).installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
  useCompletion = (await import('./use-task-completion')).useTaskCompletion; tasks = (await import('@/stores/task-store')).useTaskStore; projects = (await import('@/stores/project-store')).useProjectStore
})
beforeEach(async () => {
  canonical = [task()]; values.clear(); handlers.clear(); invoke.mockClear(); toast.mockReset(); completed.mockReset()
  handlers.set('db:getTasks', async () => canonical); handlers.set('db:getTask', async p => canonical.find(row => row.id === p.id))
  handlers.set('db:updateTask', async p => { const row = canonical.find(row => row.id === p.id); if (!row) return undefined; const updated = { ...row, ...p.data as UpdateTaskDTO }; canonical = canonical.map(row => row.id === p.id ? updated : row); return updated })
  values.set('plugin:executeAction', { success: true }); values.set('settings:get', null)
  tasks.setState({ tasks: canonical, selectedTaskId: 'task-1', error: null }); projects.setState({ currentProjectId: 'default' })
  await host.reconnect(); const store = await import('@/stores/task-store'); store.initializeTaskDesktopState(); await store.rehydrateTaskDesktopState()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
afterAll(() => { release(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
const click = () => fireEvent.click(screen.getByRole('button', { name: 'Complete captured task', hidden: true }))
const useSourceTask = () => { canonical = [task({ source_id: 'source-1', external_id: '7', source: 'GitHub' })]; tasks.setState({ tasks: canonical }) }
it('does not manufacture native completion when the write has no accepted task receipt', async () => {
  handlers.set('db:updateTask', async () => undefined); render(<Harness />); await act(async () => { click() })
  expect(completed).not.toHaveBeenCalled(); await screen.findByRole('alert'); expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('completed'))
  click(); expect(calls('db:updateTask')).toHaveLength(1)
})
it('publishes the exact canonical native completion instead of a synthetic old task', async () => {
  const accepted = task({ title: 'Canonical accepted title', status: TaskStatus.Completed }); handlers.set('db:updateTask', async () => { canonical = [accepted]; return accepted })
  render(<Harness />); click(); await waitFor(() => expect(completed).toHaveBeenCalledWith(accepted)); expect(calls('db:updateTask')).toHaveLength(1)
})
it('admits one native completion while its raw acknowledgement is pending', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />)
  act(() => { click(); click() }); await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  await act(async () => { const accepted = task({ status: TaskStatus.Completed }); canonical = [accepted]; raw.resolve(accepted) })
})
it.each(['project-return', 'pagehide', 'unmount', 'reconnect'] as const)('fences future native completion effects after %s during an owned pre-completion callback', async mode => {
  const raw = held<void>(), view = render(<Harness beforeComplete={() => raw.promise} />); click()
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (mode === 'unmount') view.unmount()
  if (mode === 'reconnect') await act(async () => { await host.reconnect() })
  await act(async () => { raw.resolve() }); expect(calls('db:updateTask')).toHaveLength(0); expect(completed).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled()
})
it('cannot retarget a native source choice to a different observed source binding', async () => {
  useSourceTask(); render(<Harness />); click(); await screen.findByTestId('complete-at-source-dialog')
  act(() => { canonical = [task({ source_id: 'replacement-source', external_id: '8', source: 'Other provider' })]; tasks.setState({ tasks: canonical }) })
  await act(async () => { fireEvent.click(screen.getByTestId('complete-at-source')) })
  expect(calls('db:updateTask')).toHaveLength(0); await screen.findByRole('alert'); expect(calls('plugin:executeAction')).toHaveLength(0); expect(completed).not.toHaveBeenCalled()
})
it('withdraws a later native source action across project change and return after the accepted local marker', async () => {
  useSourceTask(); const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />); click()
  fireEvent.click(await screen.findByTestId('complete-at-source')); await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: 'default' }) })
  await act(async () => { const accepted = { ...canonical[0], complete_at_source: true }; canonical = [accepted]; raw.resolve(accepted) })
  expect(calls('plugin:executeAction')).toHaveLength(0); expect(completed).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled()
})
it('requires native canonical completion readback after a true source-action receipt', async () => {
  useSourceTask(); render(<Harness />); click(); fireEvent.click(await screen.findByTestId('complete-at-source'))
  await screen.findByRole('alert'); expect(calls('plugin:executeAction')).toHaveLength(1); expect(completed).not.toHaveBeenCalled()
})
it('owns a native source readback refusal without reporting completion or replaying its action', async () => {
  useSourceTask(); handlers.set('db:getTasks', async () => { throw { code: 'CANCELLED', detail: 'private-completion-readback' } })
  render(<Harness />); click(); fireEvent.click(await screen.findByTestId('complete-at-source'))
  await screen.findByRole('alert'); expect(completed).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('private-completion-readback'); expect(calls('plugin:executeAction')).toHaveLength(1)
})
it.each(['captain', 'task_group'] as const)('refuses native ordinary completion for %s before a mutation', async role => {
  canonical = [task({ role })]; tasks.setState({ tasks: canonical }); render(<Harness />); click()
  await screen.findByRole('alert'); expect(calls('db:updateTask')).toHaveLength(0); expect(completed).not.toHaveBeenCalled()
})
it('fences a cached native completion callback after its owning hook unmounts', async () => {
  const view = render(<Harness />), old = request; view.unmount()
  await act(async () => { await old('task-1', { onCompleted: completed }) }); expect(calls('db:updateTask')).toHaveLength(0); expect(completed).not.toHaveBeenCalled()
})
it('uses the canonical completed source row for the accepted native callback', async () => {
  useSourceTask(); handlers.set('plugin:executeAction', async () => { canonical = [{ ...canonical[0], status: TaskStatus.Completed, title: 'Source canonical completion' }]; return { success: true } })
  render(<Harness />); click(); fireEvent.click(await screen.findByTestId('complete-at-source'))
  await waitFor(() => expect(completed).toHaveBeenCalledWith(canonical[0])); expect(calls('plugin:executeAction')).toHaveLength(1)
})

it('keeps native source choice cancellation free of writes or pre-completion effects', async () => {
  useSourceTask(); const before = vi.fn(async () => {}); render(<Harness beforeComplete={before} />); click()
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(before).not.toHaveBeenCalled(); expect(calls('db:updateTask')).toHaveLength(0); expect(calls('plugin:executeAction')).toHaveLength(0)
})
it('keeps a refused native completion in review after closing its dialog without replay', async () => {
  handlers.set('db:updateTask', async () => undefined); render(<Harness />); click(); await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('alert')).toBeNull()
  click(); await screen.findByRole('alert'); expect(calls('db:updateTask')).toHaveLength(1)
})
it('admits only one native source choice before React paints a busy state', async () => {
  useSourceTask(); const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); render(<Harness />); click()
  const choice = await screen.findByTestId('complete-at-source'); act(() => { fireEvent.click(choice); fireEvent.click(choice) })
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  await act(async () => { const accepted = { ...canonical[0], complete_at_source: true }; canonical = [accepted]; raw.resolve(accepted) })
  await screen.findByRole('alert'); expect(calls('plugin:executeAction')).toHaveLength(1)
})
it('does not mutate a replacement native view after an admitted completion acknowledgement', async () => {
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); const view = render(<Harness />); click()
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1)); view.unmount()
  await act(async () => { raw.resolve(task({ status: TaskStatus.Completed })) }); expect(completed).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled()
})
it('fences native source followups when its mounted view key is replaced', async () => {
  useSourceTask(); const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise)
  const view = render(<Harness viewKey="original" />); click(); fireEvent.click(await screen.findByTestId('complete-at-source'))
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1)); view.rerender(<Harness viewKey="replacement" />)
  await act(async () => { raw.resolve({ ...canonical[0], complete_at_source: true }) })
  expect(calls('plugin:executeAction')).toHaveLength(0); expect(completed).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled()
})
it('requires the native learning-stop receipt before a later completion write', async () => {
  canonical = [task({ status: TaskStatus.AgentLearning })]; tasks.setState({ tasks: canonical }); handlers.set('db:updateTask', async () => undefined)
  render(<Harness />); click(); await screen.findByRole('alert'); expect(calls('db:updateTask')).toHaveLength(1); expect(completed).not.toHaveBeenCalled()
})
it('keeps an accepted native marker after refused source completion without rollback or retry', async () => {
  useSourceTask(); values.set('plugin:executeAction', { success: false, error: 'private-source-detail' }); render(<Harness />); click()
  fireEvent.click(await screen.findByTestId('complete-at-source')); await screen.findByRole('alert')
  expect(canonical[0].complete_at_source).toBe(true); expect(calls('db:updateTask')).toHaveLength(1); expect(calls('plugin:executeAction')).toHaveLength(1)
  expect(document.body.textContent).not.toContain('private-source-detail'); click(); expect(calls('plugin:executeAction')).toHaveLength(1)
})
it('retires even an already failed native receipt on project withdrawal', async () => {
  handlers.set('db:updateTask', async () => undefined); render(<Harness />); click(); await screen.findByRole('alert')
  act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: 'default' }) })
  expect(screen.queryByRole('alert')).toBeNull(); click(); expect(calls('db:updateTask')).toHaveLength(1)
})

it('routes native board completion through the captured completion owner without a second UI Stop', async () => {
  canonical = [task({ status: TaskStatus.AgentWorking })]; tasks.setState({ tasks: canonical }); render(<Harness />)
  const deps = { startTask: vi.fn(), stopByTaskId: vi.fn(), getStartRecoveryState: vi.fn(), updateTask: tasks.getState().updateTask, completeTask: request }
  const { transitionTaskFromBoard } = await import('@/components/dashboard/task-board-transition')
  await act(async () => { await transitionTaskFromBoard(canonical[0], TaskStatus.Completed, deps) })
  expect(calls('db:updateTask')).toHaveLength(1); expect(deps.stopByTaskId).not.toHaveBeenCalled(); expect(deps.getStartRecoveryState).not.toHaveBeenCalled(); expect(canonical[0].status).toBe(TaskStatus.Completed)
})
it('uses one native lifecycle status receipt for a board move instead of renderer recovery/Stop', async () => {
  canonical = [task({ status: TaskStatus.AgentWorking })]; tasks.setState({ tasks: canonical })
  const deps = { startTask: vi.fn(), stopByTaskId: vi.fn(), getStartRecoveryState: vi.fn(), updateTask: tasks.getState().updateTask, completeTask: vi.fn() }
  const { transitionTaskFromBoard } = await import('@/components/dashboard/task-board-transition')
  await transitionTaskFromBoard(canonical[0], TaskStatus.ReadyForReview, deps)
  expect(calls('db:updateTask')).toHaveLength(1); expect(deps.stopByTaskId).not.toHaveBeenCalled(); expect(deps.getStartRecoveryState).not.toHaveBeenCalled(); expect(canonical[0].status).toBe(TaskStatus.ReadyForReview)
})
it('refuses a native board status acknowledgement without its canonical destination row', async () => {
  handlers.set('db:updateTask', async () => undefined)
  const deps = { startTask: vi.fn(), stopByTaskId: vi.fn(), getStartRecoveryState: vi.fn(), updateTask: tasks.getState().updateTask, completeTask: vi.fn() }
  const { transitionTaskFromBoard } = await import('@/components/dashboard/task-board-transition')
  await expect(transitionTaskFromBoard(canonical[0], TaskStatus.ReadyForReview, deps)).rejects.toThrow('Task transition was not confirmed')
  expect(deps.stopByTaskId).not.toHaveBeenCalled(); expect(deps.getStartRecoveryState).not.toHaveBeenCalled()
})


it.each(['project-return','unmount','view-replacement'] as const)('never starts a background Source export after %s retires an owned completion marker', async mode => {
  useSourceTask(); const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise)
  const api = await import('@/lib/ipc-client'), exported = vi.spyOn(api.taskSourceApi, 'exportUpdate')
  const view = render(<Harness viewKey="original" />); click(); fireEvent.click(await screen.findByTestId('complete-at-source'))
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'other' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'unmount') view.unmount()
  if (mode === 'view-replacement') view.rerender(<Harness viewKey="replacement" />)
  await act(async () => { const accepted = { ...canonical[0], complete_at_source: true }; canonical = [accepted]; raw.resolve(accepted) })
  expect(exported).not.toHaveBeenCalled(); expect(calls('taskSource:exportUpdate')).toHaveLength(0); expect(calls('plugin:executeAction')).toHaveLength(0); expect(completed).not.toHaveBeenCalled()
})
it('keeps the local native completion choice free of background Source export', async () => {
  useSourceTask(); const api = await import('@/lib/ipc-client'), exported = vi.spyOn(api.taskSourceApi, 'exportUpdate')
  render(<Harness />); click(); fireEvent.click(await screen.findByTestId('complete-manually'))
  await waitFor(() => expect(completed).toHaveBeenCalledOnce()); expect(canonical[0]).toMatchObject({ status: TaskStatus.Completed, complete_at_source: false }); expect(exported).not.toHaveBeenCalled(); expect(calls('plugin:executeAction')).toHaveLength(0)
})
it('keeps native completion markers on the local lifecycle path before its one explicit Source action', async () => {
  useSourceTask(); const api = await import('@/lib/ipc-client'), exported = vi.spyOn(api.taskSourceApi, 'exportUpdate')
  handlers.set('plugin:executeAction', async () => { canonical = [{ ...canonical[0], status: TaskStatus.Completed }]; return { success: true } })
  render(<Harness />); click(); fireEvent.click(await screen.findByTestId('complete-at-source'))
  await waitFor(() => expect(completed).toHaveBeenCalledOnce()); expect(calls('plugin:executeAction')).toHaveLength(1); expect(exported).not.toHaveBeenCalled()
})

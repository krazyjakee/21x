import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Task } from '@/types'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import type { ProjectRecord } from '@shared/projects'
vi.mock('@/components/tasks/TaskWorkspace', () => ({ TaskWorkspace: () => null }))
const held = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
const task = (extra: Partial<Task> = {}): Task => ({ id: 'task-1', title: 'Synthetic task', description: '', type: 'general', role: 'task', priority: 'medium', status: 'not_started', assignee: '', source: 'manual', project_id: 'default', created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null, resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null, heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null, is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false, labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null, recurrence_pattern: null, heartbeat_interval_minutes: null, complete_at_source: null, next_subtask_ids: [], sort_order: 0, ...extra } as Task)
const project = (id: string): ProjectRecord => ({ id, name: id, description: '', default_agent_id: null, captain_agent_id: null, git_provider: null, git_org: null, settings: {}, sort_order: 0, archived: false, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z' })
const values = new Map<string, unknown>(), handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'crud-engine', uiLeaseId: 'crud-document' }
  const operation = String(args?.operation), result = handlers.has(operation) ? await handlers.get(operation)!(args?.payload as Record<string, unknown>) : values.get(operation)
  return { engineEpoch: 'crud-engine', result: result === undefined ? { defined: false } : { defined: true, value: result } }
})
const calls = (op: string) => invoke.mock.calls.filter(([, args]) => args?.operation === op)
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>, release: () => void
let Field: typeof import('./TaskProjectField').TaskProjectField, Dialogs: typeof import('../layout/TaskDialogs').TaskDialogs
let tasks: typeof import('@/stores/task-store').useTaskStore, projects: typeof import('@/stores/project-store').useProjectStore, ui: typeof import('@/stores/ui-store').useUIStore, agents: typeof import('@/stores/agent-store').useAgentStore
const legacy = window.electronAPI
const props = { agents: [], showToast: vi.fn(), completeTask: vi.fn(async () => {}), onGoToFullView: vi.fn(), onNavigateFromPreview: vi.fn(), onAssignAgent: vi.fn(async () => {}), onUpdateTask: vi.fn(async () => {}) }
beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  host = (await import('@/lib/native-desktop-host')).createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi)
  release = (await import('@/lib/desktop-api')).installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  Field = (await import('./TaskProjectField')).TaskProjectField; Dialogs = (await import('../layout/TaskDialogs')).TaskDialogs
  tasks = (await import('@/stores/task-store')).useTaskStore; projects = (await import('@/stores/project-store')).useProjectStore
  ui = (await import('@/stores/ui-store')).useUIStore; agents = (await import('@/stores/agent-store')).useAgentStore
})
beforeEach(async () => {
  values.clear(); handlers.clear(); invoke.mockClear(); props.showToast.mockClear()
  handlers.set('db:getTasks', async () => tasks.getState().tasks); values.set('settings:get', null); values.set('agent:getAll', []); values.set('skills:getAll', [])
  tasks.setState({ tasks: [task()], selectedTaskId: 'task-1', error: null })
  projects.setState({ projects: [project('default'), project('other-project'), project('third-project')], currentProjectId: 'default' })
  ui.setState({ activeModal: null, deletingTaskId: null, editingTaskId: null, dashboardPreviewTaskId: 'task-1', canvasPendingTaskId: 'task-1' })
  agents.setState({ sessions: new Map(), agents: [] }); vi.stubGlobal('confirm', vi.fn(() => true))
  await host.reconnect()
  ;(await import('@/stores/task-store')).initializeTaskDesktopState()
  await (await import('@/stores/task-store')).rehydrateTaskDesktopState()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(() => { release(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
const move = () => fireEvent.change(screen.getByRole('combobox', { name: 'Project (choose another to move the task)' }), { target: { value: 'other-project' } })
const openDelete = () => { ui.setState({ dashboardPreviewTaskId: null }); ui.getState().openDeleteModal('task-1'); return render(<Dialogs {...props} />) }
const confirmDelete = () => fireEvent.click(screen.getByRole('button', { name: 'Delete Task' }))

it('admits one native project move before disabled state paints', async () => {
  const raw = held<unknown>(); handlers.set('project:moveTask', () => raw.promise); render(<Field task={task()} />)
  act(() => { move(); move() }); await waitFor(() => expect(calls('project:moveTask')).toHaveLength(1))
  await act(async () => { raw.resolve([task({ project_id: 'other-project' })]) })
})
it('requires review after a refused native project move without replay', async () => {
  values.set('project:moveTask', null); render(<Field task={task()} />); move()
  await screen.findByRole('alert'); expect(screen.getByRole('combobox')).toBeDisabled(); move()
  await act(async () => { await host.reconnect() }); expect(calls('project:moveTask')).toHaveLength(1)
})
it('rejects a native move receipt without the exact root and leaves canonical cache unchanged', async () => {
  values.set('project:moveTask', [task({ id: 'foreign-task', project_id: 'other-project' })]); render(<Field task={task()} />); move()
  await screen.findByRole('alert'); expect(tasks.getState().tasks[0].project_id).toBe('default')
  expect(tasks.getState().selectedTaskId).toBe('task-1'); expect(ui.getState().dashboardPreviewTaskId).toBe('task-1')
})
it('joins the canonical native root and children move without renderer Stop or a second write', async () => {
  tasks.setState({ tasks: [task(), task({ id: 'child', parent_task_id: 'task-1' }), task({ id: 'sibling' })] })
  values.set('project:moveTask', [task({ project_id: 'other-project' }), task({ id: 'child', parent_task_id: 'task-1', project_id: 'other-project' })])
  render(<Field task={task()} />); move()
  await waitFor(() => expect(tasks.getState().selectedTaskId).toBeNull())
  expect(tasks.getState().tasks.map(row => row.project_id)).toEqual(['other-project', 'other-project', 'default'])
  expect(ui.getState().dashboardPreviewTaskId).toBeNull(); expect(calls('project:moveTask')).toHaveLength(1)
  expect(calls('agentSession:stop')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})
it.each(['replacement', 'project-return', 'pagehide', 'reconnect'] as const)('retires native move followups after %s', async mode => {
  const raw = held<unknown>(); handlers.set('project:moveTask', () => raw.promise); const view = render(<Field task={task()} />); move()
  await waitFor(() => expect(calls('project:moveTask')).toHaveLength(1))
  if (mode === 'replacement') view.rerender(<Field task={task({ id: 'replacement' })} />)
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'third-project' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (mode === 'reconnect') await act(async () => { await host.reconnect() })
  // A newer local view can select the same literal task ID; old UI work must not close it.
  tasks.setState({ selectedTaskId: 'task-1' }); ui.setState({ dashboardPreviewTaskId: 'task-1' })
  await act(async () => { raw.resolve([task({ project_id: 'other-project' })]) })
  expect(tasks.getState().selectedTaskId).toBe('task-1'); expect(ui.getState().dashboardPreviewTaskId).toBe('task-1')
})
it.each(['captain', 'task_group'] as const)('has no native project move control for %s coordinator rows', role => {
  render(<Field task={task({ role })} />); expect(screen.queryByRole('combobox')).toBeNull(); expect(calls('project:moveTask')).toHaveLength(0)
})
it('native delete uses one Source deletion owner without local Stop or worktree cleanup', async () => {
  tasks.setState({ tasks: [task({ repos: ['org/repo'] })], selectedTaskId: 'task-1' }); agents.getState().initSession('task-1', 'live-session', 'agent-1')
  values.set('agentSession:stop', { success: true }); values.set('db:deleteTask', true); values.set('settings:get', 'org')
  openDelete(); confirmDelete(); await waitFor(() => expect(calls('db:deleteTask')).toHaveLength(1))
  expect(calls('agentSession:stop')).toHaveLength(0); expect(calls('worktree:cleanup')).toHaveLength(0)
})
it('keeps native delete confirmation pending and synchronously admits one request', async () => {
  const raw = held<unknown>(); handlers.set('db:deleteTask', () => raw.promise); openDelete()
  act(() => { confirmDelete(); confirmDelete() }); await waitFor(() => expect(calls('db:deleteTask')).toHaveLength(1))
  expect(screen.getByRole('alertdialog')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Delete Task' })).toBeDisabled()
  await act(async () => { raw.resolve(true) }); await waitFor(() => expect(ui.getState().activeModal).toBeNull())
})
it('keeps refused native delete in review without closing its dialog or replaying', async () => {
  values.set('db:deleteTask', false); openDelete(); confirmDelete()
  await screen.findByRole('alert'); expect(ui.getState().activeModal).toBe('delete'); expect(tasks.getState().tasks).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Delete Task' })).toBeDisabled(); confirmDelete(); expect(calls('db:deleteTask')).toHaveLength(1)
})
it('does not close a replacement same-kind native delete dialog from an old acknowledgement', async () => {
  const raw = held<unknown>(); handlers.set('db:deleteTask', () => raw.promise); tasks.setState({ tasks: [task(), task({ id: 'task-2', title: 'Replacement task' })] })
  openDelete(); confirmDelete(); await waitFor(() => expect(calls('db:deleteTask')).toHaveLength(1))
  act(() => ui.getState().openDeleteModal('task-2'))
  await act(async () => { raw.resolve(true) }); expect(ui.getState().activeModal).toBe('delete'); expect(ui.getState().deletingTaskId).toBe('task-2')
  expect(screen.getByText(/Replacement task/)).toBeInTheDocument()
})
it.each(['project-return', 'pagehide', 'reconnect'] as const)('retires native delete UI followups after %s', async mode => {
  const raw = held<unknown>(); handlers.set('db:deleteTask', () => raw.promise); openDelete(); confirmDelete()
  await waitFor(() => expect(calls('db:deleteTask')).toHaveLength(1))
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'third-project' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (mode === 'reconnect') await act(async () => { await host.reconnect() })
  ui.setState({ activeModal: 'delete', deletingTaskId: 'task-1', dashboardPreviewTaskId: 'task-1', canvasPendingTaskId: 'task-1' })
  await act(async () => { raw.resolve(true) }); expect(ui.getState().activeModal).toBe('delete')
  expect(ui.getState().dashboardPreviewTaskId).toBe('task-1'); expect(ui.getState().canvasPendingTaskId).toBe('task-1')
})
it.each(['create', 'delete', 'move'] as const)('refuses old-connection %s cache/error publication', async kind => {
  const raw = held<unknown>(); const op = kind === 'create' ? 'db:createTask' : kind === 'delete' ? 'db:deleteTask' : 'project:moveTask'
  handlers.set(op, () => raw.promise)
  const pending = (kind === 'create' ? tasks.getState().createTask({ title: 'Old create' }) : kind === 'delete' ? tasks.getState().deleteTask('task-1') : tasks.getState().moveTaskToProject('task-1', 'other-project')).catch(error => error)
  await waitFor(() => expect(calls(op)).toHaveLength(1)); await host.reconnect()
  tasks.setState({ tasks: [task({ title: 'New canonical view' })], selectedTaskId: 'task-1', error: 'new-error' })
  raw.resolve(kind === 'create' ? task({ id: 'created' }) : kind === 'delete' ? true : [task({ project_id: 'other-project' })]); await pending
  expect(tasks.getState().tasks).toEqual([task({ title: 'New canonical view' })]); expect(tasks.getState().error).toBe('new-error')
})
it.each(['create', 'delete', 'move'] as const)('does not publish an old-connection %s failure over a new error', async kind => {
  const raw = held<unknown>(); const op = kind === 'create' ? 'db:createTask' : kind === 'delete' ? 'db:deleteTask' : 'project:moveTask'
  handlers.set(op, async () => { await raw.promise; throw { code: 'CANCELLED' } })
  const pending = (kind === 'create' ? tasks.getState().createTask({ title: 'Old create' }) : kind === 'delete' ? tasks.getState().deleteTask('task-1') : tasks.getState().moveTaskToProject('task-1', 'other-project')).catch(error => error)
  await waitFor(() => expect(calls(op)).toHaveLength(1)); await host.reconnect(); tasks.setState({ error: 'new-error' }); raw.resolve(undefined); await pending
  expect(tasks.getState().error).toBe('new-error')
})

it.each(['delete', 'move'] as const)('fences a retired-document %s cache receipt even without connection replacement', async kind => {
  const raw = held<unknown>(), op = kind === 'delete' ? 'db:deleteTask' : 'project:moveTask'; handlers.set(op, () => raw.promise)
  const pending = (kind === 'delete' ? tasks.getState().deleteTask('task-1') : tasks.getState().moveTaskToProject('task-1', 'other-project')).catch(error => error)
  await waitFor(() => expect(calls(op)).toHaveLength(1)); act(() => window.dispatchEvent(new Event('pagehide')))
  ;(await import('@/stores/task-store')).initializeTaskDesktopState()
  tasks.setState({ tasks: [task({ title: 'New document snapshot' })], selectedTaskId: 'task-1', error: 'new-document-error' })
  raw.resolve(kind === 'delete' ? true : [task({ project_id: 'other-project' })]); await pending
  expect(tasks.getState().tasks).toEqual([task({ title: 'New document snapshot' })]); expect(tasks.getState().error).toBe('new-document-error')
})
it('fences an old document create failure from the replacement view error', async () => {
  const raw = held<unknown>(); handlers.set('db:createTask', async () => { await raw.promise; throw { code: 'CANCELLED' } })
  const pending = tasks.getState().createTask({ title: 'Old intent' }).catch(error => error)
  await waitFor(() => expect(calls('db:createTask')).toHaveLength(1)); act(() => window.dispatchEvent(new Event('pagehide')))
  ;(await import('@/stores/task-store')).initializeTaskDesktopState(); tasks.setState({ error: 'new-document-error' }); raw.resolve(undefined); await pending
  expect(tasks.getState().error).toBe('new-document-error')
})

it.each(['foreign-project', 'foreign-parent'] as const)('rejects a native create acknowledgement for %s intent', async mode => {
  values.set('db:createTask', task({ id: 'accepted-child', project_id: mode === 'foreign-project' ? 'third-project' : 'default', parent_task_id: mode === 'foreign-parent' ? 'other-parent' : 'parent' }))
  await expect(tasks.getState().createTask({ title: 'Child intent', project_id: 'default', parent_task_id: 'parent' })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(calls('db:createTask')).toHaveLength(1); expect(tasks.getState().tasks.map(row => row.id)).toEqual(['task-1'])
})
it('retains the exact accepted native create identity for its caller without guessing or inserting another row', async () => {
  const child = task({ id: 'accepted-child', parent_task_id: 'parent' }); values.set('db:createTask', child)
  expect(await tasks.getState().createTask({ title: 'Child intent', project_id: 'default', parent_task_id: 'parent' })).toEqual(child)
  expect(calls('db:createTask')).toHaveLength(1); expect(tasks.getState().tasks.map(row => row.id)).toEqual(['task-1'])
})
it('owns a refused native delete promise without exposing private diagnostics or replaying after Cancel', async () => {
  handlers.set('db:deleteTask', async () => { throw { code: 'CANCELLED', detail: 'private-delete-canary' } }); openDelete(); confirmDelete()
  await screen.findByRole('alert'); expect(document.body.textContent).not.toContain('private-delete-canary')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(ui.getState().activeModal).toBeNull(); expect(calls('db:deleteTask')).toHaveLength(1)
})

it('explains a native project picker retired by an idle reconnect before any move', async () => {
  render(<Field task={task()} />); await act(async () => { await host.reconnect() })
  expect(screen.getByRole('combobox')).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('Reopen and review')
  move(); expect(calls('project:moveTask')).toHaveLength(0)
})
it('explains a native delete dialog retired by an idle reconnect before any deletion', async () => {
  openDelete(); await act(async () => { await host.reconnect() })
  expect(screen.getByRole('button', { name: 'Delete Task' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('Close and review')
  confirmDelete(); expect(calls('db:deleteTask')).toHaveLength(0)
})
it.each(['captain', 'task_group'] as const)('refuses native ordinary deletion of %s before a Source request', role => {
  tasks.setState({ tasks: [task({ role })] }); openDelete()
  expect(screen.getByRole('button', { name: 'Delete Task' })).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('owning project or group')
  confirmDelete(); expect(calls('db:deleteTask')).toHaveLength(0); expect(calls('agentSession:stop')).toHaveLength(0)
})

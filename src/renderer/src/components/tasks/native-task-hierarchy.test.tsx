import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import type { Task } from '@/types'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
const drag = vi.hoisted(() => ({ end: undefined as ((event: DragEndEvent) => void) | undefined }))
vi.mock('@dnd-kit/core', async original => ({ ...await original<typeof import('@dnd-kit/core')>(), DndContext: (props: { children: ReactNode; onDragEnd?: (event: DragEndEvent) => void }) => { drag.end = props.onDragEnd; return props.children } }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({ AgentTranscriptPanel: () => null }))
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
const makeTask = (extra: Partial<Task> = {}): Task => ({
  id: 'task-1', title: 'Synthetic task', description: '', type: 'general', role: 'task', priority: 'medium', status: 'not_started', assignee: '',
  source: 'manual', project_id: 'default', created_at: '2026-10-17T20:00:00.000Z', updated_at: '2026-10-17T20:00:00.000Z',
  due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null,
  resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null,
  heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null,
  is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false,
  labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null,
  recurrence_pattern: null, heartbeat_interval_minutes: null, complete_at_source: null, next_subtask_ids: [], sort_order: 0, ...extra
} as Task)

const values = new Map<string, unknown>(), handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'hierarchy-engine', uiLeaseId: 'hierarchy-document' }
  const operation = String(args?.operation), value = handlers.has(operation) ? await handlers.get(operation)!(args?.payload as Record<string, unknown>) : values.get(operation)
  return { engineEpoch: 'hierarchy-engine', result: value === undefined ? { defined: false } : { defined: true, value } }
})
const calls = (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation)
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>, release: () => void
let Workspace: typeof import('./TaskWorkspace').TaskWorkspace
let tasks: typeof import('@/stores/task-store').useTaskStore
const legacy = window.electronAPI
const props = { agents: [], panelLayout: 'task-only' as const, onEdit: vi.fn(), onDelete: vi.fn(), onUpdateAttachments: vi.fn(), onUpdateOutputFields: vi.fn(), onCompleteTask: vi.fn(), onAssignAgent: vi.fn(), onNavigateToTask: vi.fn() }
beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  const native = { core: { invoke }, event: { listen: vi.fn(async () => () => {}) } } as unknown as TauriDesktopApi
  host = (await import('@/lib/native-desktop-host')).createNativeDesktopHost(native)
  release = (await import('@/lib/desktop-api')).installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  Workspace = (await import('./TaskWorkspace')).TaskWorkspace
  tasks = (await import('@/stores/task-store')).useTaskStore
})
beforeEach(async () => {
  values.clear(); handlers.clear(); invoke.mockClear(); drag.end = undefined
  values.set('settings:get', null); values.set('tasks:getWorkspaceDir', '/synthetic'); values.set('artifacts:scan', []); values.set('agent:getAll', []); values.set('db:getTasks', [])
  handlers.set('agentSession:getTranscriptPage', async payload => { const page = payload.page as { mode: string; after: number }; return { version: 1, taskId: payload.taskId, mode: page.mode, after: page.after, parts: [], cursor: page.after, watermark: page.after, hasMore: false } })
  tasks.setState({ tasks: [], selectedTaskId: null })
  await host.reconnect()
})
afterEach(cleanup)
afterAll(() => { release(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })

it('refuses an old parent read after the workspace changes to another child', async () => {
  const old = held<unknown>()
  handlers.set('db:getTask', payload => payload.id === 'parent-old' ? old.promise : Promise.resolve(makeTask({ id: 'parent-new', title: 'Current parent' })))
  const view = render(<Workspace {...props} task={makeTask({ id: 'child-old', parent_task_id: 'parent-old' })} />)
  await waitFor(() => expect(calls('db:getTask')).toHaveLength(1))
  view.rerender(<Workspace {...props} task={makeTask({ id: 'child-new', parent_task_id: 'parent-new' })} />)
  await screen.findByText('Current parent')
  await act(async () => { old.resolve(makeTask({ id: 'parent-old', title: 'Retired parent' })) })
  expect(screen.queryByText('Retired parent')).toBeNull(); expect(screen.getByText('Current parent')).toBeInTheDocument()
})
it('retains a pending subtask title and admits one create until its exact receipt', async () => {
  const create = held<unknown>(); handlers.set('db:createTask', () => create.promise)
  render(<Workspace {...props} task={makeTask()} />)
  fireEvent.click(within(screen.getByText('Subtasks').parentElement!).getByRole('button', { name: 'Add' }))
  const input = screen.getByPlaceholderText('Subtask title...')
  fireEvent.change(input, { target: { value: 'Captured child title' } })
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(calls('db:createTask')).toHaveLength(1))
  expect(screen.getByPlaceholderText('Subtask title...')).toHaveValue('Captured child title')
  expect(screen.getByPlaceholderText('Subtask title...')).toBeDisabled()
  await act(async () => { create.resolve(makeTask({ id: 'accepted-child', parent_task_id: 'task-1', title: 'Captured child title' })) })
  await waitFor(() => expect(screen.queryByPlaceholderText('Subtask title...')).toBeNull())
  expect(calls('db:createTask')).toHaveLength(1)
})


const addDraft = () => { fireEvent.click(within(screen.getByText('Subtasks').parentElement!).getByRole('button', { name: 'Add' })); return screen.getByPlaceholderText('Subtask title...') }
const submitChild = (title = 'Requested child') => { const input = addDraft(); fireEvent.change(input, { target: { value: title } }); fireEvent.keyDown(input, { key: 'Enter' }); return input }
const moveChildren = () => drag.end?.({ active: { id: 'child-a' }, over: { id: 'child-b' } } as DragEndEvent)
const children = () => [makeTask({ id: 'child-a', parent_task_id: 'task-1', title: 'Child A' }), makeTask({ id: 'child-b', parent_task_id: 'task-1', title: 'Child B', sort_order: 1 })]

it('rejects a foreign parent receipt and reads the real parent again after same-epoch reconnect', async () => {
  handlers.set('db:getTask', async () => makeTask({ id: 'foreign-parent', title: 'Foreign parent' }))
  render(<Workspace {...props} task={makeTask({ parent_task_id: 'parent-1' })} />)
  await waitFor(() => expect(calls('db:getTask')).toHaveLength(1)); expect(screen.queryByText('Foreign parent')).toBeNull()
  handlers.set('db:getTask', async () => makeTask({ id: 'parent-1', title: 'Restored parent' }))
  await act(async () => { await host.reconnect() })
  await screen.findByText('Restored parent'); expect(calls('db:getTask')).toHaveLength(2)
})
it('retires parent observations on pagehide and releases their reconnect listener', async () => {
  const read = held<unknown>(); handlers.set('db:getTask', () => read.promise)
  render(<Workspace {...props} task={makeTask({ parent_task_id: 'parent-1' })} />)
  await waitFor(() => expect(calls('db:getTask')).toHaveLength(1))
  act(() => window.dispatchEvent(new Event('pagehide')))
  await act(async () => { read.resolve(makeTask({ id: 'parent-1', title: 'Late parent' })) })
  expect(screen.queryByText('Late parent')).toBeNull()
  await act(async () => { await host.reconnect() }); expect(calls('db:getTask')).toHaveLength(1)
})
it('fences a parent read across synchronous project change and return', async () => {
  const read = held<unknown>(); handlers.set('db:getTask', () => calls('db:getTask').length === 1 ? read.promise : Promise.resolve(makeTask({ id: 'parent-1', title: 'Current parent' })))
  render(<Workspace {...props} task={makeTask({ parent_task_id: 'parent-1' })} />)
  await waitFor(() => expect(calls('db:getTask')).toHaveLength(1))
  const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
  act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: initial }) })
  await screen.findByText('Current parent')
  await act(async () => { read.resolve(makeTask({ id: 'parent-1', title: 'Retired parent' })) })
  expect(screen.queryByText('Retired parent')).toBeNull(); expect(screen.getByText('Current parent')).toBeInTheDocument()
})
it.each(['missing', 'foreign-parent', 'foreign-project'] as const)('retains an uncertain subtask draft on a %s create receipt without replay', async variant => {
  handlers.set('db:createTask', async () => variant === 'missing' ? undefined : makeTask({ id: 'new-child', parent_task_id: variant === 'foreign-parent' ? 'other-parent' : 'task-1', project_id: variant === 'foreign-project' ? 'other-project' : 'default' }))
  render(<Workspace {...props} task={makeTask()} />); submitChild()
  await screen.findByRole('alert')
  expect(screen.getByPlaceholderText('Subtask title...')).toHaveValue('Requested child')
  expect(screen.getByPlaceholderText('Subtask title...')).toBeDisabled()
  expect(calls('db:getTasks')).toHaveLength(0)
  fireEvent.keyDown(screen.getByPlaceholderText('Subtask title...'), { key: 'Enter' })
  await act(async () => { await host.reconnect() }); expect(calls('db:createTask')).toHaveLength(1)
})
it('joins canonical subtask readback after accepted create before closing its draft', async () => {
  const read = held<unknown>(), child = makeTask({ id: 'new-child', title: 'Canonical child', parent_task_id: 'task-1' })
  handlers.set('db:createTask', async () => child); handlers.set('db:getTasks', () => read.promise)
  render(<Workspace {...props} task={makeTask()} />); submitChild('Canonical child')
  await waitFor(() => expect(calls('db:getTasks')).toHaveLength(1))
  expect(screen.getByPlaceholderText('Subtask title...')).toBeDisabled()
  expect(calls('db:createTask')[0][1]?.payload).toMatchObject({ data: { title: 'Canonical child', parent_task_id: 'task-1', type: 'general', priority: 'medium' } })
  await act(async () => { read.resolve([child]) })
  await waitFor(() => expect(screen.queryByPlaceholderText('Subtask title...')).toBeNull())
  expect(screen.getByText('Canonical child')).toBeInTheDocument()
})
it('ignores an accepted create after task replacement without closing the new task draft or starting readback', async () => {
  const create = held<unknown>(); handlers.set('db:createTask', () => create.promise)
  const view = render(<Workspace {...props} task={makeTask()} />); submitChild('Old child')
  await waitFor(() => expect(calls('db:createTask')).toHaveLength(1))
  view.rerender(<Workspace {...props} task={makeTask({ id: 'replacement-task' })} />)
  const next = addDraft(); fireEvent.change(next, { target: { value: 'New child draft' } })
  await act(async () => { create.resolve(makeTask({ id: 'accepted-old-child', parent_task_id: 'task-1' })) })
  expect(screen.getByPlaceholderText('Subtask title...')).toHaveValue('New child draft')
  expect(screen.getByPlaceholderText('Subtask title...')).toBeEnabled(); expect(calls('db:getTasks')).toHaveLength(0)
})
it('fences create readback across project change-and-return and pagehide without replay', async () => {
  const create = held<unknown>(); handlers.set('db:createTask', () => create.promise)
  render(<Workspace {...props} task={makeTask()} />); submitChild()
  await waitFor(() => expect(calls('db:createTask')).toHaveLength(1))
  const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
  act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: initial }) })
  await act(async () => { create.resolve(makeTask({ id: 'accepted-child', parent_task_id: 'task-1' })) })
  await screen.findByRole('alert'); expect(calls('db:getTasks')).toHaveLength(0)
  act(() => window.dispatchEvent(new Event('pagehide')))
  await act(async () => { await host.reconnect() }); expect(calls('db:createTask')).toHaveLength(1)
})
it('serializes a subtask reorder and joins canonical readback rather than optimistically replacing order', async () => {
  const reorder = held<unknown>(), original = children(); tasks.setState({ tasks: original })
  handlers.set('db:reorderSubtasks', () => reorder.promise); values.set('db:getTasks', [{ ...original[1], sort_order: 0 }, { ...original[0], sort_order: 1 }])
  render(<Workspace {...props} task={makeTask()} />)
  act(() => { moveChildren(); moveChildren() })
  await waitFor(() => expect(calls('db:reorderSubtasks')).toHaveLength(1))
  expect(calls('db:reorderSubtasks')[0][1]?.payload).toEqual({ parentId: 'task-1', orderedIds: ['child-b', 'child-a'] })
  expect(calls('db:getTasks')).toHaveLength(0); expect(tasks.getState().tasks[0].id).toBe('child-a')
  await act(async () => { reorder.resolve(true) })
  await waitFor(() => expect(tasks.getState().tasks[0].id).toBe('child-b'))
  expect(calls('db:reorderSubtasks')).toHaveLength(1); expect(calls('db:getTasks')).toHaveLength(1)
})
it('reports a refused reorder without retrying it or fabricating an accepted order', async () => {
  tasks.setState({ tasks: children() }); values.set('db:reorderSubtasks', false)
  render(<Workspace {...props} task={makeTask()} />); act(moveChildren)
  await screen.findByRole('alert'); expect(calls('db:getTasks')).toHaveLength(0)
  act(moveChildren); await act(async () => { await host.reconnect() })
  expect(calls('db:reorderSubtasks')).toHaveLength(1); expect(tasks.getState().tasks[0].id).toBe('child-a')
})
it('withdraws reorder readback when a replacement task is mounted', async () => {
  const reorder = held<unknown>(); handlers.set('db:reorderSubtasks', () => reorder.promise); tasks.setState({ tasks: children() })
  const view = render(<Workspace {...props} task={makeTask()} />); act(moveChildren)
  await waitFor(() => expect(calls('db:reorderSubtasks')).toHaveLength(1))
  view.rerender(<Workspace {...props} task={makeTask({ id: 'other-task' })} />)
  await act(async () => { reorder.resolve(true) }); expect(calls('db:getTasks')).toHaveLength(0)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps native Captain subtask mutation absent before any request', () => {
  render(<Workspace {...props} task={makeTask({ role: 'captain' })} />)
  expect(within(screen.getByText('Subtasks').parentElement!).queryByRole('button', { name: 'Add' })).toBeNull()
  expect(calls('db:createTask')).toHaveLength(0); expect(calls('db:reorderSubtasks')).toHaveLength(0)
})

it('does not unlock another native create after a cancelled draft receives an uncertain reply', async () => {
  const create = held<unknown>(); handlers.set('db:createTask', () => create.promise)
  render(<Workspace {...props} task={makeTask()} />); submitChild()
  await waitFor(() => expect(calls('db:createTask')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel subtask draft' }))
  expect(screen.queryByPlaceholderText('Subtask title...')).toBeNull()
  expect(within(screen.getByText('Subtasks').parentElement!).getByRole('button', { name: 'Add' })).toBeDisabled()
  await act(async () => { create.resolve(undefined) })
  await screen.findByRole('alert')
  expect(within(screen.getByText('Subtasks').parentElement!).getByRole('button', { name: 'Add' })).toBeDisabled()
  expect(calls('db:createTask')).toHaveLength(1)
})
it('keeps an accepted create uncertain when canonical readback fails instead of recreating it', async () => {
  handlers.set('db:createTask', async () => makeTask({ id: 'accepted-child', parent_task_id: 'task-1' }))
  handlers.set('db:getTasks', async () => { throw { code: 'DISCONNECTED', detail: 'private-readback-canary' } })
  render(<Workspace {...props} task={makeTask()} />); submitChild()
  await screen.findByRole('alert')
  expect(document.body.textContent).not.toContain('private-readback-canary')
  expect(screen.getByPlaceholderText('Subtask title...')).toHaveValue('Requested child')
  expect(calls('db:createTask')).toHaveLength(1); expect(calls('db:getTasks')).toHaveLength(1)
  await act(async () => { await host.reconnect() }); expect(calls('db:createTask')).toHaveLength(1)
})

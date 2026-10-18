import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'
import type { Agent, Task } from '@/types'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import type { SendHandler } from '@/components/agents/transcript/TranscriptComposer'
import type { TaskSession } from '@/stores/agent-store'
import { SessionStatus } from '@shared/constants'
const drag = vi.hoisted(() => ({ end: undefined as ((event: DragEndEvent) => void) | undefined }))
const transcript = vi.hoisted(() => ({ send: undefined as SendHandler | undefined }))
vi.mock('@dnd-kit/core', async original => ({ ...await original<typeof import('@dnd-kit/core')>(), DndContext: (props: { children: ReactNode; onDragEnd?: (event: DragEndEvent) => void }) => { drag.end = props.onDragEnd; return props.children } }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({ AgentTranscriptPanel: ({ onSend }: { onSend?: SendHandler }) => { transcript.send = onSend; return null } }))
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
let agents: typeof import('@/stores/agent-store').useAgentStore
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
  agents = (await import('@/stores/agent-store')).useAgentStore
})
beforeEach(async () => {
  values.clear(); handlers.clear(); invoke.mockClear(); drag.end = undefined; transcript.send = undefined
  values.set('skills:getAll', []); values.set('settings:get', null); values.set('tasks:getWorkspaceDir', '/synthetic'); values.set('artifacts:scan', []); values.set('agent:getAll', []); values.set('db:getTasks', [])
  handlers.set('db:updateTask', async payload => makeTask({ ...(payload.data as Partial<Task>), id: String(payload.id) }))
  handlers.set('agentSession:getTranscriptPage', async payload => { const page = payload.page as { mode: string; after: number }; return { version: 1, taskId: payload.taskId, mode: page.mode, after: page.after, parts: [], cursor: page.after, watermark: page.after, hasMore: false } })
  tasks.setState({ tasks: [], selectedTaskId: null })
  agents.setState({ sessions: new Map(), agents: [], error: null })
  await host.reconnect()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
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

it('sends exactly one Source metadata mutation for a fallback header rename', async () => {
  render(<Workspace {...props} task={makeTask()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic task' }))
  fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'One accepted rename' } })
  fireEvent.keyDown(screen.getByLabelText('Task title'), { key: 'Enter' })
  await waitFor(() => expect(calls('db:updateTask').length).toBeGreaterThan(0))
  expect(calls('db:updateTask')).toHaveLength(1)
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { title: 'One accepted rename' } })
})
it('sends exactly one Source metadata mutation for a fallback description edit', async () => {
  render(<Workspace {...props} task={makeTask()} />)
  fireEvent.click(screen.getByTestId('description-add-placeholder'))
  fireEvent.change(screen.getByTestId('description-edit-textarea'), { target: { value: 'One accepted description' } })
  fireEvent.click(screen.getByTestId('description-edit-save'))
  await waitFor(() => expect(calls('db:updateTask').length).toBeGreaterThan(0))
  expect(calls('db:updateTask')).toHaveLength(1)
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { description: 'One accepted description' } })
})
it('sends exactly one Source metadata mutation for a fallback lifecycle status edit', async () => {
  render(<Workspace {...props} task={makeTask()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change task status' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready for Review' }))
  await waitFor(() => expect(calls('db:updateTask').length).toBeGreaterThan(0))
  expect(calls('db:updateTask')).toHaveLength(1)
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { status: 'ready_for_review' } })
})

const renameDraft = (title = 'Preserved rename') => {
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic task' }))
  const input = screen.getByLabelText('Task title')
  fireEvent.change(input, { target: { value: title } }); return input
}
const descriptionDraft = () => {
  fireEvent.click(screen.getByTestId('description-add-placeholder'))
  const input = screen.getByTestId('description-edit-textarea')
  fireEvent.change(input, { target: { value: 'Preserved description' } }); return input
}
it('holds the title draft through Enter plus blur until one accepted write settles', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  render(<Workspace {...props} task={makeTask()} />)
  const input = renameDraft()
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input); fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  expect(input).toHaveValue('Preserved rename'); expect(input).toBeDisabled()
  await act(async () => { write.resolve(makeTask({ title: 'Preserved rename' })) })
  await waitFor(() => expect(screen.queryByLabelText('Task title')).toBeNull())
  expect(calls('db:updateTask')).toHaveLength(1)
})
it('preserves an unsaved title across canonical updates for the same task', async () => {
  const view = render(<Workspace {...props} task={makeTask()} />)
  renameDraft()
  view.rerender(<Workspace {...props} task={makeTask({ title: 'Canonical background title' })} />)
  expect(screen.getByLabelText('Task title')).toHaveValue('Preserved rename')
  expect(calls('db:updateTask')).toHaveLength(0)
  await act(async () => {})
})
it.each(['missing', 'foreign', 'rejected'] as const)('retains the title on a %s write receipt without replay', async variant => {
  handlers.set('db:updateTask', async () => {
    if (variant === 'rejected') throw { code: 'DISCONNECTED', detail: 'private-write-canary' }
    return variant === 'missing' ? undefined : makeTask({ id: 'foreign-task' })
  })
  tasks.setState({ tasks: [makeTask()] })
  render(<Workspace {...props} task={makeTask()} />)
  const input = renameDraft(); fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('alert')
  expect(input).toHaveValue('Preserved rename'); expect(input).toBeDisabled()
  expect(document.body.textContent).not.toContain('private-write-canary')
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input)
  await act(async () => { await host.reconnect() })
  expect(calls('db:updateTask')).toHaveLength(1)
  expect(tasks.getState().tasks[0].id).toBe('task-1')
})
it('does not close or replace a new task title editor when an old write settles', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  const view = render(<Workspace {...props} task={makeTask()} />)
  fireEvent.keyDown(renameDraft(), { key: 'Enter' })
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  view.rerender(<Workspace {...props} task={makeTask({ id: 'task-next' })} />)
  renameDraft('New task draft')
  await act(async () => { write.resolve(makeTask({ title: 'Preserved rename' })) })
  expect(screen.getByLabelText('Task title')).toHaveValue('New task draft')
  expect(screen.getByLabelText('Task title')).toBeEnabled()
})
it.each(['project', 'pagehide', 'connection'] as const)('refuses a title submission after %s retirement without a new mutation', async reason => {
  render(<Workspace {...props} task={makeTask()} />); const input = renameDraft()
  if (reason === 'project') {
    const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
    act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: initial }) })
  } else if (reason === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  else await act(async () => { await host.reconnect() })
  fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input)
  expect(calls('db:updateTask')).toHaveLength(0); expect(input).toHaveValue('Preserved rename'); expect(input).toBeDisabled()
  await act(async () => {})
})
it('serializes description keyboard and button saves and retains the pending draft on canonical refresh', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  const view = render(<Workspace {...props} task={makeTask()} />)
  const input = descriptionDraft()
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }); fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  fireEvent.click(screen.getByTestId('description-edit-save'))
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  view.rerender(<Workspace {...props} task={makeTask({ description: 'Canonical refresh' })} />)
  expect(input).toHaveValue('Preserved description'); expect(input).toBeDisabled()
  await act(async () => { write.resolve(makeTask({ description: 'Preserved description' })) })
  await waitFor(() => expect(screen.queryByTestId('description-edit-form')).toBeNull())
  expect(calls('db:updateTask')).toHaveLength(1)
})
it('keeps an uncertain description locked through cancel, save and reconnect without replay', async () => {
  handlers.set('db:updateTask', async () => undefined)
  render(<Workspace {...props} task={makeTask()} />)
  const input = descriptionDraft(); fireEvent.click(screen.getByTestId('description-edit-save'))
  await screen.findByRole('alert'); expect(input).toHaveValue('Preserved description'); expect(input).toBeDisabled()
  fireEvent.keyDown(input, { key: 'Escape' }); fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  fireEvent.click(screen.getByTestId('description-edit-cancel')); fireEvent.click(screen.getByTestId('description-edit-save'))
  await act(async () => { await host.reconnect() })
  expect(calls('db:updateTask')).toHaveLength(1); expect(input).toHaveValue('Preserved description')
})
it('retains a replacement description draft when an old accepted write settles', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  const view = render(<Workspace {...props} task={makeTask()} />)
  descriptionDraft(); fireEvent.click(screen.getByTestId('description-edit-save'))
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  view.rerender(<Workspace {...props} task={makeTask({ id: 'task-next' })} />)
  const input = descriptionDraft(); fireEvent.change(input, { target: { value: 'New task description' } })
  await act(async () => { write.resolve(makeTask({ description: 'Old accepted description' })) })
  expect(input).toHaveValue('New task description'); expect(input).toBeEnabled()
})
it('owns a missing status receipt and requires review rather than replay', async () => {
  handlers.set('db:updateTask', async () => undefined)
  render(<Workspace {...props} task={makeTask()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change task status' }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Ready for Review' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Change task status' })).toBeDisabled()
  expect(calls('db:updateTask')).toHaveLength(1)
})
it('does not publish an old-connection accepted task receipt into the replacement store', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  tasks.setState({ tasks: [makeTask()], error: null })
  const result = tasks.getState().updateTask('task-1', { title: 'Old connection write' }).catch(error => error)
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  await act(async () => { await host.reconnect() })
  tasks.setState({ tasks: [makeTask({ title: 'Replacement canonical task' })], error: null })
  await act(async () => { write.resolve(makeTask({ title: 'Old connection write' })); await result })
  expect(tasks.getState().tasks[0].title).toBe('Replacement canonical task'); expect(tasks.getState().error).toBeNull()
})

it.each([
  ['auto-start-agent-toggle', 'auto_start_agent'], ['auto-complete-toggle', 'auto_complete_without_review']
] as const)('awaits one %s mutation and prevents overlapping detail edits', async (testId, field) => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  render(<Workspace {...props} task={makeTask({ agent_id: 'agent-1', is_recurring: true })} />)
  const checkbox = within(screen.getByTestId(testId)).getByRole('checkbox')
  fireEvent.click(checkbox); fireEvent.click(checkbox)
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  expect(checkbox).toBeDisabled()
  expect(within(screen.getByTestId('auto-start-agent-toggle')).getByRole('checkbox')).toBeDisabled()
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { [field]: true } })
  await act(async () => { write.resolve(makeTask({ [field]: true, agent_id: 'agent-1', is_recurring: true })) })
  await waitFor(() => expect(checkbox).toBeEnabled())
})
it('keeps recurrence settings in review on an unconfirmed write without retry', async () => {
  handlers.set('db:updateTask', async () => undefined)
  render(<Workspace {...props} task={makeTask({ agent_id: 'agent-1', is_recurring: true })} />)
  const checkbox = within(screen.getByTestId('auto-start-agent-toggle')).getByRole('checkbox')
  fireEvent.click(checkbox); await screen.findByRole('alert')
  expect(checkbox).toBeDisabled(); expect(checkbox).not.toBeChecked()
  fireEvent.click(checkbox); await act(async () => { await host.reconnect() })
  expect(calls('db:updateTask')).toHaveLength(1)
})
it('writes one captured next-subtask replacement and waits for its receipt', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  tasks.setState({ tasks: children() })
  render(<Workspace {...props} task={children()[0]} />)
  const checkbox = within(screen.getByTestId('next-subtasks-field')).getByRole('checkbox')
  fireEvent.click(checkbox); fireEvent.click(checkbox)
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'child-a', data: { next_subtask_ids: ['child-b'] } })
  expect(checkbox).toBeDisabled()
  await act(async () => { write.resolve(makeTask({ id: 'child-a', parent_task_id: 'task-1', next_subtask_ids: ['child-b'] })) })
  await waitFor(() => expect(checkbox).toBeEnabled())
})
it('persists the explicit reset-to-agent-defaults skill choice through the fallback owner once', async () => {
  render(<Workspace {...props} task={makeTask({ agent_id: 'agent-1', skill_ids: [] })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { skill_ids: null } })
  await act(async () => {})
})

it.each(['title', 'description'] as const)('retains a pending %s draft when Escape races submission before the busy paint', async field => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  render(<Workspace {...props} task={makeTask()} />)
  const input = field === 'title' ? renameDraft() : descriptionDraft()
  act(() => {
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: field === 'description' })
    fireEvent.keyDown(input, { key: 'Escape' })
  })
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  expect(input).toBeInTheDocument(); expect(input).toHaveValue(field === 'title' ? 'Preserved rename' : 'Preserved description')
  await act(async () => { write.resolve(makeTask()) })
})

const configuredAgent = (id = 'agent-1'): Agent => ({ id, name: `Synthetic ${id}`, server_url: 'http://localhost:4096', config: { coding_agent: 'pi', model: 'synthetic/model' }, is_default: id === 'agent-1', created_at: '2026-10-18', updated_at: '2026-10-18' } as Agent)
const triageButton = () => screen.getAllByRole('button', { name: 'Triage' })[0]
it('sends one triage status write before one explicit session start', async () => {
  values.set('agentSession:start', { sessionId: 'triage-session' })
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask()} />)
  fireEvent.click(triageButton())
  await waitFor(() => expect(calls('agentSession:start')).toHaveLength(1))
  expect(calls('db:updateTask')).toHaveLength(1)
  expect(calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { status: 'triaging' } })
})
it('does not roll back an accepted triage status after an uncertain session start', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  handlers.set('agentSession:start', async () => { throw new Error('synthetic unavailable start') })
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask()} />)
  fireEvent.click(triageButton())
  await waitFor(() => expect(calls('agentSession:start')).toHaveLength(1)); await act(async () => {})
  expect(calls('db:updateTask')).toHaveLength(1)
  expect(calls('db:updateTask').every(([, args]) => (args?.payload as { data: { status: string } }).data.status === 'triaging')).toBe(true)
  vi.restoreAllMocks()
})
it('does not replace assignment after a failed handoff', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  handlers.set('agentSession:switchAgent', async () => { throw new Error('synthetic unavailable handoff') })
  const assign = vi.fn(async () => {})
  render(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent(), configuredAgent('agent-2')]} task={makeTask({ agent_id: 'agent-1', session_id: 'original-session' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
  fireEvent.click(screen.getByTestId('header-agent-option-agent-2'))
  await waitFor(() => expect(calls('agentSession:switchAgent')).toHaveLength(1)); await act(async () => {})
  expect(assign).not.toHaveBeenCalled(); expect(calls('db:updateTask')).toHaveLength(0)
  vi.restoreAllMocks()
})
it('joins the exact Stop receipt before unassigning the agent', async () => {
  const stop = held<unknown>(); handlers.set('agentSession:stop', () => stop.promise)
  const assign = vi.fn(async () => {})
  agents.getState().initSession('task-1', 'session-owned', 'agent-1')
  render(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'session-owned' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change agent' }))
  fireEvent.click(screen.getByTestId('header-agent-option-unassigned'))
  await waitFor(() => expect(calls('agentSession:stop')).toHaveLength(1))
  const beforeStop = assign.mock.calls.length
  await act(async () => { stop.resolve({ success: true }) })
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
  expect(beforeStop).toBe(0)
})

it('admits one triage action across duplicate native controls while its status write is pending', async () => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise); values.set('agentSession:start', { sessionId: 'triage-session' })
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask()} />)
  const controls = screen.getAllByRole('button', { name: 'Triage' })
  act(() => { fireEvent.click(controls[0]); fireEvent.click(controls.at(-1)!) })
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  await act(async () => { write.resolve(makeTask({ status: 'triaging' } as Partial<Task>)) })
  await waitFor(() => expect(calls('agentSession:start')).toHaveLength(1))
  expect(calls('db:updateTask')).toHaveLength(1)
})
it('refuses triage session startup on a missing status receipt without replay', async () => {
  handlers.set('db:updateTask', async () => undefined)
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask()} />)
  fireEvent.click(triageButton()); await screen.findByRole('alert')
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(1)
  await act(async () => { await host.reconnect() })
  expect(calls('agentSession:start')).toHaveLength(0)
})
it.each(['project', 'pagehide', 'connection'] as const)('withdraws triage followups after %s retirement without rolling back accepted status', async reason => {
  const write = held<unknown>(); handlers.set('db:updateTask', () => write.promise)
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask()} />); fireEvent.click(triageButton())
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  if (reason === 'project') {
    const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
    act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: initial }) })
  } else if (reason === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  else await act(async () => { await host.reconnect() })
  await act(async () => { write.resolve(makeTask({ status: 'triaging' } as Partial<Task>)) })
  await screen.findByRole('alert')
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(1)
})
it('allows the replacement task action while retiring an old pending triage callback', async () => {
  const write = held<unknown>()
  handlers.set('db:updateTask', payload => payload.id === 'task-1' ? write.promise : Promise.resolve(makeTask({ id: String(payload.id), status: 'triaging' } as Partial<Task>)))
  values.set('agentSession:start', { sessionId: 'replacement-triage' })
  const view = render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask()} />)
  fireEvent.click(triageButton()); await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  view.rerender(<Workspace {...props} agents={[configuredAgent()]} task={makeTask({ id: 'task-next' })} />)
  fireEvent.click(triageButton()); await waitFor(() => expect(calls('agentSession:start')).toHaveLength(1))
  await act(async () => { write.resolve(makeTask({ status: 'triaging' } as Partial<Task>)) })
  expect(calls('agentSession:start')[0][1]?.payload).toMatchObject({ taskId: 'task-next' })
  expect(calls('agentSession:start')).toHaveLength(1); expect(screen.queryByRole('alert')).toBeNull()
})
it('joins canonical handoff readback without issuing a second assignment mutation', async () => {
  const read = held<unknown>(); handlers.set('db:getTasks', () => read.promise)
  values.set('agentSession:switchAgent', { sessionId: 'new-session' })
  const assign = vi.fn(async () => {})
  render(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent(), configuredAgent('agent-2')]} task={makeTask({ agent_id: 'agent-1', session_id: 'original-session' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change agent' })); fireEvent.click(screen.getByTestId('header-agent-option-agent-2'))
  await waitFor(() => expect(calls('db:getTasks')).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'Change agent' })).toBeDisabled(); expect(assign).not.toHaveBeenCalled()
  await act(async () => { read.resolve([makeTask({ agent_id: 'agent-2', session_id: 'new-session' })]) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change agent' })).toBeEnabled())
  expect(tasks.getState().tasks[0].agent_id).toBe('agent-2'); expect(assign).not.toHaveBeenCalled(); expect(calls('db:updateTask')).toHaveLength(0)
})
it('retains a refused handoff for review without retrying assignment or switching', async () => {
  handlers.set('agentSession:switchAgent', async () => { throw new Error('synthetic refusal') })
  const assign = vi.fn(async () => {})
  render(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent(), configuredAgent('agent-2')]} task={makeTask({ agent_id: 'agent-1', session_id: 'original-session' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change agent' })); fireEvent.click(screen.getByTestId('header-agent-option-agent-2'))
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Change agent' })).toBeDisabled()
  await act(async () => { await host.reconnect() })
  expect(calls('agentSession:switchAgent')).toHaveLength(1); expect(assign).not.toHaveBeenCalled(); expect(calls('db:getTasks')).toHaveLength(0)
})
it('does not unassign after a finite false Stop receipt', async () => {
  values.set('agentSession:stop', { success: false }); const assign = vi.fn(async () => {})
  agents.getState().initSession('task-1', 'session-owned', 'agent-1')
  render(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'session-owned' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change agent' })); fireEvent.click(screen.getByTestId('header-agent-option-unassigned'))
  await screen.findByRole('alert'); expect(assign).not.toHaveBeenCalled()
  expect(agents.getState().sessions.get('task-1')?.sessionId).toBe('session-owned')
})
it('does not unassign a retired task after its old Stop acknowledgement', async () => {
  const stop = held<unknown>(); handlers.set('agentSession:stop', () => stop.promise); const assign = vi.fn(async () => {})
  agents.getState().initSession('task-1', 'session-owned', 'agent-1')
  const view = render(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'session-owned' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Change agent' })); fireEvent.click(screen.getByTestId('header-agent-option-unassigned'))
  await waitFor(() => expect(calls('agentSession:stop')).toHaveLength(1))
  view.rerender(<Workspace {...props} onAssignAgent={assign} agents={[configuredAgent()]} task={makeTask({ id: 'task-next', agent_id: 'agent-1' })} />)
  await act(async () => { stop.resolve({ success: true }) })
  expect(assign).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull()
})
it('refuses a native Fresh shortcut before Stop, session removal or runtime-field writes', async () => {
  const { dispatchTaskShortcut, onShortcutFeedback, TaskShortcutAction } = await import('@/lib/keyboard-shortcuts')
  const feedback = vi.fn(), off = onShortcutFeedback(feedback), update = vi.fn(async (id: string, data: Record<string, unknown>) => { await tasks.getState().updateTask(id, data) })
  render(<Workspace {...props} onUpdateTask={update} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'retained-session' })} />)
  await act(async () => {})
  act(() => {
    agents.setState({ sessions: new Map([['task-1', { taskId: 'task-1', agentId: 'agent-1', sessionId: null, status: 'idle', messages: [{ id: 'retained-message', role: 'assistant', content: 'Retained transcript', timestamp: new Date() }] }]]) } as Parameters<typeof agents.setState>[0])
    dispatchTaskShortcut({ action: TaskShortcutAction.RUN, taskId: 'task-1' })
  })
  await act(async () => {})
  expect(update).not.toHaveBeenCalled(); expect(calls('agentSession:stop')).toHaveLength(0); expect(calls('agentSession:start')).toHaveLength(0)
  expect(agents.getState().sessions.get('task-1')?.messages[0].content).toBe('Retained transcript')
  expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('unavailable') }))
  off()
})
it('keeps native incompatible-session Fresh UI unavailable', async () => {
  const { IncompatibleSessionDialog } = await import('./IncompatibleSessionDialog')
  const start = vi.fn(); render(<IncompatibleSessionDialog open onOpenChange={vi.fn()} onStartFresh={start} />)
  expect(screen.queryByRole('button', { name: 'Start New Session' })).toBeNull()
  expect(screen.getByText(/Starting a fresh session is unavailable/)).toBeInTheDocument(); expect(start).not.toHaveBeenCalled()
})

it('admits one explicit native Start across duplicate controls while retaining the pending action', async () => {
  const start = held<unknown>(); handlers.set('agentSession:start', () => start.promise)
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  const controls = screen.getAllByRole('button', { name: 'Start' })
  act(() => { fireEvent.click(controls[0]); fireEvent.click(controls.at(-1)!) })
  await waitFor(() => expect(calls('agentSession:start')).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'Change agent' })).toBeDisabled()
  await act(async () => { start.resolve({ sessionId: 'started-session' }) })
  expect(agents.getState().sessions.get('task-1')?.sessionId).toBe('started-session')
  expect(calls('db:updateTask')).toHaveLength(0)
})
it('retains an uncertain explicit native Start for review without replay', async () => {
  handlers.set('agentSession:start', async () => undefined)
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[0])
  await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  const { dispatchTaskShortcut, TaskShortcutAction } = await import('@/lib/keyboard-shortcuts')
  act(() => dispatchTaskShortcut({ action: TaskShortcutAction.RUN, taskId: 'task-1' }))
  expect(calls('agentSession:start')).toHaveLength(1)
})
it('joins canonical metadata after a known-ended native Resume without starting fresh', async () => {
  const read = held<unknown>(); handlers.set('db:getTasks', () => read.promise)
  values.set('agentSession:resume', { sessionId: '', ended: true })
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'retained-session' })} />)
  fireEvent.click(screen.getAllByRole('button', { name: /^(Resume|Resume Session)$/ })[0])
  await waitFor(() => expect(calls('db:getTasks')).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'Change agent' })).toBeDisabled()
  await act(async () => { read.resolve([makeTask({ agent_id: 'agent-1', session_id: null })]) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change agent' })).toBeEnabled())
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
  expect(tasks.getState().tasks[0].session_id).toBeNull()
})
it('requires review after an unconfirmed native Resume without an automatic fresh start', async () => {
  handlers.set('agentSession:resume', async () => undefined)
  render(<Workspace {...props} agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'retained-session' })} />)
  fireEvent.click(screen.getAllByRole('button', { name: /^(Resume|Resume Session)$/ })[0])
  await screen.findByRole('alert')
  expect(calls('agentSession:resume')).toHaveLength(1); expect(calls('agentSession:start')).toHaveLength(0)
  expect(calls('db:getTasks')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})

it('delegates a native message without a live session to one retained Source send owner', async () => {
  values.set('agentSession:start', { sessionId: 'renderer-started' })
  values.set('agentSession:send', { success: true })
  values.set('agentSession:sendByTaskId', { success: true, sessionId: null, newSessionId: 'source-started' })
  render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  let outcome: unknown
  await act(async () => { outcome = await Promise.resolve(transcript.send!('Original instruction')).catch(error => error) })
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('agentSession:resume')).toHaveLength(0)
  expect(calls('agentSession:sendByTaskId')).toHaveLength(1); expect(calls('agentSession:send')).toHaveLength(0)
  expect(outcome).toBeUndefined()
  expect(calls('agentSession:sendByTaskId')[0][1]?.payload).toMatchObject({ taskId: 'task-1', message: 'Original instruction', deliveryId: expect.stringMatching(/^renderer:/) })
})
it.each(['replacement', 'project-return', 'pagehide'] as const)('refuses a captured native message callback before effects after %s retirement', async retirement => {
  values.set('agentSession:start', { sessionId: 'renderer-started' }); values.set('agentSession:send', { success: true })
  const view = render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  const send = transcript.send!
  if (retirement === 'replacement') view.rerender(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ id: 'task-next', agent_id: 'agent-1' })} />)
  else if (retirement === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  else {
    const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
    act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: initial }) })
  }
  let outcome: unknown
  await act(async () => { outcome = await Promise.resolve(send('Retired instruction')).catch(error => error) })
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('agentSession:send')).toHaveLength(0); expect(calls('agentSession:sendByTaskId')).toHaveLength(0)
  expect(outcome).toBeInstanceOf(Error)
})
it('refuses a native historical question before resuming or starting its old session', async () => {
  values.set('agentSession:resume', { sessionId: 'resumed-question' })
  render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'retained-session' })} />)
  await act(async () => {})
  act(() => agents.setState({ sessions: new Map<string, TaskSession>([['task-1', { taskId: 'task-1', agentId: 'agent-1', sessionId: null, status: SessionStatus.IDLE, messages: [{ id: 'question-message', role: 'assistant', content: 'Old question', timestamp: new Date(), partType: 'question', tool: { name: 'question', status: 'pending', requestId: 'request-old', questions: [{ question: 'Old?', header: 'Old', options: [] }] } }] }]]) }))
  let outcome: unknown
  await act(async () => { outcome = await Promise.resolve(transcript.send!('Answer old question')).catch(error => error) })
  expect(calls('agentSession:resume')).toHaveLength(0); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('agentSession:approve')).toHaveLength(0)
  expect(outcome).toBeInstanceOf(Error)
})

it('admits one native message across duplicate callbacks and preserves its saved attachment references', async () => {
  const raw = held<unknown>(); handlers.set('agentSession:sendByTaskId', () => raw.promise)
  render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  const send = transcript.send!, refs = [{ id: 'saved-ref', filename: 'saved.txt', size: 3, mime_type: 'text/plain' }]
  let first!: Promise<unknown>, duplicate!: Promise<unknown>
  act(() => { first = Promise.resolve(send('One intent', { attachments: refs })); duplicate = Promise.resolve(send('One intent', { attachments: refs })).catch(error => error) })
  await waitFor(() => expect(calls('agentSession:sendByTaskId')).toHaveLength(1))
  expect(await duplicate).toBeInstanceOf(Error)
  expect(calls('agentSession:sendByTaskId')[0][1]?.payload).toMatchObject({ taskId: 'task-1', message: 'One intent', attachments: refs, deliveryId: expect.stringMatching(/^renderer:/) })
  await act(async () => { raw.resolve({ success: true, sessionId: null }); await first })
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('agentSession:resume')).toHaveLength(0)
})
it('retains an unknown native send for review instead of submitting a new nonce on retry', async () => {
  handlers.set('agentSession:sendByTaskId', async () => undefined)
  render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  let outcome: unknown
  await act(async () => { outcome = await Promise.resolve(transcript.send!('Uncertain instruction')).catch(error => error) })
  expect(outcome).toBeInstanceOf(Error); await screen.findByRole('alert')
  await act(async () => { await Promise.resolve(transcript.send!('Uncertain instruction')).catch(error => error) })
  expect(calls('agentSession:sendByTaskId')).toHaveLength(1); expect(calls('db:updateTask')).toHaveLength(0)
})

async function currentQuestion(type: 'permission' | 'question', requestId: string | undefined = 'request-exact') {
  // Populate the real facade's exact session-to-task binding, then hydrate its
  // durable transcript before publishing the controlled question to the UI.
  values.set('agentSession:start', { sessionId: 'question-session' })
  await host.api.agentSession.start('agent-1', 'task-1'); invoke.mockClear()
  const view = render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1', session_id: 'question-session' })} />)
  await act(async () => { await agents.getState().hydrateTranscript('task-1') })
  act(() => agents.setState({ sessions: new Map<string, TaskSession>([['task-1', { taskId: 'task-1', agentId: 'agent-1', sessionId: 'question-session', status: SessionStatus.WAITING_APPROVAL, messages: [{ id: 'question-message', role: 'assistant', content: 'Current question', timestamp: new Date(), partType: 'question', tool: { name: type, status: 'pending', requestId, questions: [{ question: 'Current?', header: 'Current', options: [] }] } }] }]]) }))
  return view
}
it.each(['permission', 'question'] as const)('uses the exact current native %s request without startup or a general prompt', async type => {
  values.set('agentSession:approve', { success: true }); await currentQuestion(type)
  await act(async () => { await transcript.send!('Exact visual answer') })
  expect(calls('agentSession:approve')).toHaveLength(1)
  expect(calls('agentSession:approve')[0][1]?.payload).toMatchObject({ sessionId: 'question-session', requestId: 'request-exact', responseType: type, message: 'Exact visual answer', approved: true })
  expect(calls('agentSession:start')).toHaveLength(0); expect(calls('agentSession:resume')).toHaveLength(0)
  expect(calls('agentSession:send')).toHaveLength(0); expect(calls('agentSession:sendByTaskId')).toHaveLength(0)
  await act(async () => { await Promise.resolve(transcript.send!('Duplicate answer')).catch(error => error) })
  expect(calls('agentSession:approve')).toHaveLength(1)
})
it('refuses a native current question without an exact request ID before any command', async () => {
  await currentQuestion('question', '')
  let outcome: unknown
  await act(async () => { outcome = await Promise.resolve(transcript.send!('No exact request')).catch(error => error) })
  expect(outcome).toBeInstanceOf(Error); expect(calls('agentSession:approve')).toHaveLength(0)
  expect(calls('agentSession:send')).toHaveLength(0); expect(calls('agentSession:sendByTaskId')).toHaveLength(0)
})
it('retains native kickoff text through one pending send and unknown receipt without an unhandled retry', async () => {
  const raw = held<unknown>(); handlers.set('agentSession:sendByTaskId', () => raw.promise)
  render(<Workspace {...props} panelLayout="both" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  const input = screen.getByRole('textbox', { name: 'Kickoff instructions' })
  fireEvent.change(input, { target: { value: 'Retain original kickoff' } })
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }) })
  await waitFor(() => expect(calls('agentSession:sendByTaskId')).toHaveLength(1))
  expect(input).toHaveValue('Retain original kickoff'); expect(input).toBeDisabled()
  await act(async () => { raw.resolve(undefined) })
  await screen.findByRole('alert'); expect(input).toHaveValue('Retain original kickoff'); expect(input).toBeDisabled()
  expect(calls('agentSession:start')).toHaveLength(0)
})
it('does not clear a replacement kickoff draft after an admitted old native prompt settles', async () => {
  const raw = held<unknown>(); handlers.set('agentSession:sendByTaskId', () => raw.promise)
  const view = render(<Workspace {...props} panelLayout="both" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Kickoff instructions' }), { target: { value: 'Old instruction' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Kickoff instructions' }), { key: 'Enter' })
  await waitFor(() => expect(calls('agentSession:sendByTaskId')).toHaveLength(1))
  view.rerender(<Workspace {...props} panelLayout="both" agents={[configuredAgent()]} task={makeTask({ id: 'task-next', agent_id: 'agent-1' })} />)
  const next = screen.getByRole('textbox', { name: 'Kickoff instructions' }); expect(next).toHaveValue('')
  fireEvent.change(next, { target: { value: 'New task draft' } })
  await act(async () => { raw.resolve({ success: true, sessionId: null }) })
  expect(next).toHaveValue('New task draft'); expect(next).toBeEnabled(); expect(screen.queryByRole('alert')).toBeNull()
  expect(calls('agentSession:sendByTaskId')).toHaveLength(1)
  expect(calls('agentSession:sendByTaskId')[0][1]?.payload).toMatchObject({ taskId: 'task-1', message: 'Old instruction' })
})
it('restores a refused native composer draft without unsupported voice work or a replayed send', async () => {
  const { TranscriptComposer } = await import('@/components/agents/transcript/TranscriptComposer')
  const raw = held<unknown>(); handlers.set('agentSession:sendByTaskId', () => raw.promise)
  render(<Workspace {...props} panelLayout="transcript-only" agents={[configuredAgent()]} task={makeTask({ agent_id: 'agent-1' })} />)
  const send = transcript.send!
  render(<TranscriptComposer taskId="task-1" onSend={send} isStarting={false} />)
  const input = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'Retained composer intent' } })
  act(() => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.click(screen.getByRole('button', { name: 'Send message' })) })
  await waitFor(() => expect(calls('agentSession:sendByTaskId')).toHaveLength(1))
  expect(input).toBeDisabled()
  await act(async () => { raw.resolve(undefined) })
  await waitFor(() => expect(input).toHaveValue('Retained composer intent'))
  expect(input).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  await act(async () => {})
  expect(input).toHaveValue('Retained composer intent')
  expect(calls('agentSession:sendByTaskId')).toHaveLength(1)
  expect(calls('voice:answerNotExpected')).toHaveLength(0)
})

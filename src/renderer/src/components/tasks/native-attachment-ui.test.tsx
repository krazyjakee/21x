import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { FileAttachment, Task } from '@/types'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'

const panel = vi.hoisted(() => ({ pick: undefined as (() => Promise<unknown>) | undefined }))
vi.mock('@/components/agents/AgentTranscriptPanel', () => ({ AgentTranscriptPanel: (props: { onPickAttachments?: () => Promise<unknown> }) => {
  panel.pick = props.onPickAttachments; return null
} }))
function held<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail }), resolve, reject } }
const attachment = (index: number): FileAttachment => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  filename: `${index}.txt`, size: index, mime_type: 'text/plain', added_at: '2026-10-17T20:00:00.000Z' })
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
async function fixture() {
  const { installDesktopHost } = await import('@/lib/desktop-api')
  const { createNativeDesktopHost } = await import('@/lib/native-desktop-host')
  const values = new Map<string, unknown>()
  const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1' }
    const op = String(args?.operation), payload = args?.payload as Record<string, unknown>
    const value = handlers.has(op) ? await handlers.get(op)!(payload) : values.get(op)
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async () => vi.fn()) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native), release = installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  return { host, values, handlers, invoke, release, calls: (op: string) => invoke.mock.calls.filter(([, args]) => args?.operation === op) }
}
let f: Awaited<ReturnType<typeof fixture>>
let TaskAttachments: typeof import('./TaskAttachments').TaskAttachments
let TaskForm: typeof import('./TaskForm').TaskForm
let TaskDialogs: typeof import('../layout/TaskDialogs').TaskDialogs
let TaskWorkspace: typeof import('./TaskWorkspace').TaskWorkspace
let TranscriptComposer: typeof import('../agents/transcript/TranscriptComposer').TranscriptComposer
let stores: { ui: typeof import('@/stores/ui-store').useUIStore; tasks: typeof import('@/stores/task-store').useTaskStore }
const feedback = vi.fn<(detail: { message: string; isError: boolean }) => void>()
let retireFeedback: () => void
const legacy = window.electronAPI
beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  f = await fixture()
  ;({ TaskAttachments } = await import('./TaskAttachments'))
  ;({ TaskForm } = await import('./TaskForm'))
  ;({ TaskDialogs } = await import('../layout/TaskDialogs'))
  ;({ TaskWorkspace } = await import('./TaskWorkspace'))
  ;({ TranscriptComposer } = await import('../agents/transcript/TranscriptComposer'))
  stores = { ui: (await import('@/stores/ui-store')).useUIStore, tasks: (await import('@/stores/task-store')).useTaskStore }
  retireFeedback = (await import('@/lib/keyboard-shortcuts')).onShortcutFeedback(feedback)
})
beforeEach(async () => {
  f.values.clear(); f.handlers.clear(); f.invoke.mockClear(); feedback.mockClear(); panel.pick = undefined
  f.values.set('attachments:pick', ['/synthetic/1.txt', '/synthetic/2.txt'])
  f.values.set('settings:get', null); f.values.set('tasks:getWorkspaceDir', '/synthetic')
  f.values.set('artifacts:scan', []); f.values.set('agent:getAll', [])
  f.handlers.set('attachments:save', async payload => attachment(Number(String(payload.filePath).match(/([12])\.txt$/)?.[1] ?? 1)))
  f.handlers.set('agentSession:getTranscriptPage', async payload => {
    const page = payload.page as { mode: string; after: number }
    return { version: 1, taskId: payload.taskId, mode: page.mode, after: page.after, parts: [], cursor: page.after, watermark: page.after, hasMore: false }
  })
  f.handlers.set('db:updateTask', async payload => makeTask({ ...(payload.data as Partial<Task>), id: String(payload.id) }))
  f.handlers.set('db:createTask', async payload => makeTask({ ...(payload.data as Partial<Task>), id: 'created-task' }))
  stores.ui.setState({ activeModal: null, dashboardPreviewTaskId: null, editingTaskId: null, deletingTaskId: null, sidebarView: 'tasks' })
  stores.tasks.setState({ tasks: [], selectedTaskId: null })
  await f.host.reconnect()
})
afterEach(() => { cleanup() })
afterAll(() => {
  retireFeedback(); f.release()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})
function Existing() {
  const [items, setItems] = useState<FileAttachment[]>([attachment(9)])
  return <TaskAttachments items={items} taskId="task-1" onChange={async next => {
    await f.host.api.db.updateTask('task-1', { attachments: next }); setItems(next)
  }} />
}
it('imports native selections sequentially, waits for each receipt and appends metadata exactly once', async () => {
  const first = held<unknown>()
  f.handlers.set('attachments:save', payload => String(payload.filePath).endsWith('1.txt') ? first.promise : Promise.resolve(attachment(2)))
  render(<Existing />); fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  expect(f.calls('db:updateTask')).toHaveLength(0)
  await act(async () => { first.resolve(attachment(1)) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add files' })).toBeEnabled())
  expect(f.calls('attachments:save')).toHaveLength(2)
  expect(f.calls('attachments:pick')[0][1]).toMatchObject({ payload: {}, uiLease: 'document-1' })
  expect(f.calls('attachments:save').map(([, args]) => args)).toMatchObject([
    { payload: { taskId: 'task-1', filePath: '/synthetic/1.txt' }, uiLease: 'document-1' },
    { payload: { taskId: 'task-1', filePath: '/synthetic/2.txt' }, uiLease: 'document-1' }
  ])
  expect(f.calls('db:updateTask')).toHaveLength(1)
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { attachments: [attachment(9), attachment(1), attachment(2)] } })
})
it('keeps accepted partial imports and stops on refusal without leaking errors or replaying on reconnect', async () => {
  f.values.set('attachments:pick', ['/synthetic/1.txt', '/synthetic/2.txt', '/synthetic/3.txt'])
  f.handlers.set('attachments:save', async payload => {
    if (String(payload.filePath).endsWith('1.txt')) return attachment(1)
    throw { code: 'DISCONNECTED', detail: 'private-file-canary' }
  })
  render(<Existing />); fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Check the current attachments'))
  expect(document.body.textContent).not.toContain('private-file-canary')
  expect(f.calls('attachments:save')).toHaveLength(2)
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { attachments: [attachment(9), attachment(1)] } })
  await f.host.reconnect()
  expect(f.calls('attachments:save')).toHaveLength(2)
})
it('retains accepted file receipts without automatic retry when metadata persistence fails', async () => {
  f.handlers.set('db:updateTask', async () => { throw { code: 'DISCONNECTED' } })
  render(<Existing />); fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(f.calls('attachments:save')).toHaveLength(2); expect(f.calls('db:updateTask')).toHaveLength(1)
  expect(screen.queryByText('1.txt')).toBeNull()
  await f.host.reconnect(); expect(f.calls('attachments:save')).toHaveLength(2)
})
it('owns a pending picker through double click and ignores a retired task before saving', async () => {
  const pick = held<unknown>(); f.handlers.set('attachments:pick', () => pick.promise)
  const changed = vi.fn(), view = render(<TaskAttachments items={[]} taskId="task-1" onChange={changed} />)
  const add = screen.getByRole('button', { name: 'Add files' })
  fireEvent.click(add); fireEvent.click(add)
  await waitFor(() => expect(f.calls('attachments:pick')).toHaveLength(1))
  view.rerender(<TaskAttachments items={[]} taskId="task-2" onChange={changed} />)
  await act(async () => { pick.resolve(['/synthetic/1.txt']) })
  expect(f.calls('attachments:save')).toHaveLength(0); expect(changed).not.toHaveBeenCalled()
})
it('stops a native batch before the next selection after task replacement', async () => {
  const first = held<unknown>(); f.handlers.set('attachments:save', () => first.promise)
  const changed = vi.fn(), view = render(<TaskAttachments items={[]} taskId="task-1" onChange={changed} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  view.rerender(<TaskAttachments items={[]} taskId="task-2" onChange={changed} />)
  await act(async () => { first.resolve(attachment(1)) })
  expect(f.calls('attachments:save')).toHaveLength(1); expect(changed).not.toHaveBeenCalled()
})
it('keeps draft picker selections pending before task creation without claiming file authority', async () => {
  f.values.set('attachments:pick', ['/synthetic/draft.txt'])
  const pending = vi.fn()
  render(<TaskAttachments items={[]} taskId={null} onChange={vi.fn()} onPendingChange={pending} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(pending).toHaveBeenCalledOnce())
  expect(pending.mock.calls[0][0][0]).toMatchObject({ filename: 'draft.txt', sourcePath: '/synthetic/draft.txt' })
  expect(f.calls('attachments:save')).toHaveLength(0)
})
it('uses the actual create form then attaches to only the accepted new task, preserving partial imports without repeating create', async () => {
  stores.ui.setState({ activeModal: 'create' })
  f.handlers.set('attachments:save', async payload => {
    if (String(payload.filePath).endsWith('1.txt')) return attachment(1)
    throw { code: 'BACKPRESSURE' }
  })
  const toast = vi.fn(), noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={toast} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New synthetic task' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByText('1.txt')).toBeInTheDocument())
  expect(f.calls('attachments:save')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(stores.ui.getState().activeModal).toBeNull())
  expect(f.calls('db:createTask')).toHaveLength(1)
  expect(f.calls('attachments:save').every(([, args]) => (args?.payload as { taskId: string }).taskId === 'created-task')).toBe(true)
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'created-task', data: { attachments: [attachment(1)] } })
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('Check the current attachments'), true)
})
it('serializes the actual workspace composer import callback before its explicit metadata append', async () => {
  const first = held<unknown>(); f.handlers.set('attachments:save', payload => String(payload.filePath).endsWith('1.txt') ? first.promise : Promise.resolve(attachment(2)))
  const changed = vi.fn(async () => {})
  render(<TaskWorkspace task={makeTask()} agents={[]} panelLayout="transcript-only" onEdit={vi.fn()} onDelete={vi.fn()} onUpdateAttachments={changed} onUpdateOutputFields={vi.fn()} onCompleteTask={vi.fn()} onAssignAgent={vi.fn()} />)
  let importing!: Promise<unknown>
  await act(async () => { importing = panel.pick!() })
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  expect(changed).not.toHaveBeenCalled()
  await act(async () => { first.resolve(attachment(1)); await importing })
  expect(changed).toHaveBeenCalledExactlyOnceWith([attachment(1), attachment(2)])
  expect(f.calls('attachments:save')).toHaveLength(2)
})
it('keeps native DOM drops non-authoritative in task attachments and the actual transcript composer', () => {
  const paths = vi.fn(async () => []), file = new File(['synthetic'], 'dropped.txt')
  render(<><TaskAttachments items={[]} taskId="task-1" onChange={vi.fn()} />
    <TranscriptComposer taskId="task-1" onSend={vi.fn()} onAddAttachmentPaths={paths} isStarting={false} /></>)
  const dataTransfer = { files: [file], types: ['Files'] }
  fireEvent.drop(screen.getByRole('group', { name: 'Attachments' }), { dataTransfer })
  fireEvent.drop(screen.getByTestId('transcript-composer'), { dataTransfer })
  expect(screen.getByRole('alert')).toHaveTextContent('Use Add files')
  expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Use Add files') }))
  expect(paths).not.toHaveBeenCalled(); expect(f.calls('attachments:save')).toHaveLength(0)
  expect(f.host.unavailableCapability).toBeNull()
})
it('catches picker failure and ignores late composer selections after task replacement', async () => {
  const picked = held<import('../agents/transcript/TranscriptComposer').ComposerAttachment[]>()
  const onPick = vi.fn(() => picked.promise)
  const view = render(<TranscriptComposer taskId="task-1" onSend={vi.fn()} onPickAttachments={onPick} isStarting={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  expect(onPick).toHaveBeenCalledOnce()
  view.rerender(<TranscriptComposer taskId="task-2" onSend={vi.fn()} onPickAttachments={onPick} isStarting={false} />)
  await act(async () => { picked.resolve([attachment(1)]) })
  expect(screen.queryByText('1.txt')).toBeNull()
  view.rerender(<TranscriptComposer taskId="task-2" onSend={vi.fn()} onPickAttachments={async () => { throw new Error('private-path-canary') }} isStarting={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  await waitFor(() => expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Check the current attachments') })))
  expect(document.body.textContent).not.toContain('private-path-canary')
})

it('catches an actual native picker refusal without saving or publishing metadata', async () => {
  f.handlers.set('attachments:pick', async () => { throw { code: 'CANCELLED', detail: 'private-picker-canary' } })
  const changed = vi.fn()
  render(<TaskAttachments taskId="task-1" items={[]} onChange={changed} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(document.body.textContent).not.toContain('private-picker-canary')
  expect(f.calls('attachments:save')).toHaveLength(0); expect(changed).not.toHaveBeenCalled()
})
it('does not import draft selections or close another modal after create intent is withdrawn', async () => {
  const created = held<unknown>(); f.handlers.set('db:createTask', () => created.promise)
  stores.ui.setState({ activeModal: 'create' })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Withdrawn import intent' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByText('1.txt')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(f.calls('db:createTask')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  act(() => stores.ui.setState({ activeModal: 'settings' }))
  await act(async () => { created.resolve(makeTask({ id: 'created-task' })) })
  expect(stores.ui.getState().activeModal).toBe('settings')
  expect(f.calls('attachments:save')).toHaveLength(0)
  expect(f.calls('db:createTask')).toHaveLength(1)
  expect(stores.tasks.getState().selectedTaskId).toBeNull()
})
it('opens the accepted new task after metadata failure instead of offering the same create again', async () => {
  stores.ui.setState({ activeModal: 'create' })
  f.handlers.set('db:updateTask', async () => { throw { code: 'DISCONNECTED' } })
  const toast = vi.fn(), noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={toast} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Accepted task with uncertain metadata' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByText('1.txt')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(stores.ui.getState().activeModal).toBeNull())
  expect(f.calls('db:createTask')).toHaveLength(1); expect(f.calls('db:updateTask')).toHaveLength(1)
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('Check the current attachments'), true)
  expect(screen.queryByRole('button', { name: 'Create Task' })).toBeNull()
})

it.each(['task_group', 'captain'] as const)('keeps native %s conversation picker paths absent before selection', role => {
  render(<TaskWorkspace task={makeTask({ role })} agents={[]} panelLayout="transcript-only" onEdit={vi.fn()} onDelete={vi.fn()} onUpdateAttachments={vi.fn()} onUpdateOutputFields={vi.fn()} onCompleteTask={vi.fn()} onAssignAgent={vi.fn()} />)
  expect(panel.pick).toBeUndefined()
  expect(f.calls('attachments:pick')).toHaveLength(0); expect(f.calls('attachments:save')).toHaveLength(0)
})
it.each(['task_group', 'captain'] as const)('keeps saved %s attachment preview available while making file edits read-only', async role => {
  render(<TaskForm task={makeTask({ role, attachments: [attachment(1)] })} onSubmit={vi.fn(async () => {})} onCancel={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '1.txt' })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull()
  expect(screen.queryByTitle('Remove attachment')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '1.txt' }))
  await waitFor(() => expect(f.calls('attachments:open')).toHaveLength(1))
  expect(f.calls('attachments:open')[0][1]).toMatchObject({ payload: { taskId: 'task-1', attachmentId: attachment(1).id }, uiLease: 'document-1' })
  expect(f.calls('attachments:save')).toHaveLength(0)
})

it('does not start draft file imports after the create-dialog owner unmounts during accepted creation', async () => {
  const created = held<unknown>(); f.handlers.set('db:createTask', () => created.promise)
  stores.ui.setState({ activeModal: 'create' })
  const noop = vi.fn(async () => {})
  const view = render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unmounted create owner' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByText('1.txt')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(f.calls('db:createTask')).toHaveLength(1))
  view.unmount()
  await act(async () => { created.resolve(makeTask({ id: 'created-task' })) })
  expect(f.calls('attachments:save')).toHaveLength(0)
  expect(f.calls('db:updateTask')).toHaveLength(0)
  expect(stores.tasks.getState().selectedTaskId).toBeNull()
})

it('does not publish a late metadata error after its create owner unmounts', async () => {
  const metadata = held<unknown>(); f.handlers.set('db:updateTask', () => metadata.promise)
  stores.ui.setState({ activeModal: 'create' })
  const toast = vi.fn(), noop = vi.fn(async () => {})
  const view = render(<TaskDialogs agents={[]} showToast={toast} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retired metadata feedback' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByText('1.txt')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(f.calls('db:updateTask')).toHaveLength(1))
  view.unmount()
  await act(async () => { metadata.reject(new Error('retired-metadata-canary')) })
  expect(toast).not.toHaveBeenCalled()
  expect(f.calls('db:createTask')).toHaveLength(1)
})
it('does not publish partial-import feedback or composer attachments into a replacement workspace', async () => {
  f.handlers.set('attachments:save', async payload => {
    if (String(payload.filePath).endsWith('1.txt')) return attachment(1)
    throw { code: 'BACKPRESSURE' }
  })
  const metadata = held<void>(), changed = vi.fn(() => metadata.promise)
  const props = { agents: [], panelLayout: 'transcript-only' as const, onEdit: vi.fn(), onDelete: vi.fn(), onUpdateAttachments: changed, onUpdateOutputFields: vi.fn(), onCompleteTask: vi.fn(), onAssignAgent: vi.fn() }
  const view = render(<TaskWorkspace task={makeTask()} {...props} />)
  let importing!: Promise<unknown>
  await act(async () => { importing = panel.pick!() })
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  view.rerender(<TaskWorkspace task={makeTask({ id: 'task-2' })} {...props} />)
  await act(async () => { metadata.resolve(); await importing })
  expect(await importing).toEqual([])
  expect(feedback).not.toHaveBeenCalled()
})
it('ignores a retired composer picker error after same-epoch reconnect', async () => {
  const picked = held<import('../agents/transcript/TranscriptComposer').ComposerAttachment[]>()
  render(<TranscriptComposer taskId="task-1" onSend={vi.fn()} onPickAttachments={() => picked.promise} isStarting={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
  await f.host.reconnect()
  await act(async () => { picked.reject(new Error('retired-picker-canary')) })
  expect(feedback).not.toHaveBeenCalled()
})

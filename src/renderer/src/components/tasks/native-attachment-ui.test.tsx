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
  let dropSupported = false
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>()
  const values = new Map<string, unknown>()
  const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1', nativeDropSupported: dropSupported }
    const op = String(args?.operation), payload = args?.payload as Record<string, unknown>
    const value = handlers.has(op) ? await handlers.get(op)!(payload) : values.get(op)
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
    const callbacks = listeners.get(event) ?? new Set(); listeners.set(event, callbacks); callbacks.add(listener)
    return () => callbacks.delete(listener)
  }) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native), release = installDesktopHost(host)
  host.setRehydrator(async () => {}); await host.reconnect()
  return { host, values, handlers, invoke, release, setDropSupported: (value: boolean) => { dropSupported = value },
    emitDrop: (contextId: string, paths = ['/synthetic/1.txt', '/synthetic/2.txt'], dropId = crypto.randomUUID()) => {
      for (const listener of listeners.get('desktop:attachment-drop') ?? []) listener({ payload: { engineEpoch: 'engine-1', leaseId: 'document-1', drop: { contextId, paths, dropId } } })
      return dropId
    }, calls: (op: string) => invoke.mock.calls.filter(([, args]) => args?.operation === op) }
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
let restoreLayout: () => void
const legacy = window.electronAPI
beforeAll(async () => {
  // happy-dom has no layout engine. Give visible roots a controlled viewport
  // rectangle; hidden/inert/style/modal admission is still checked by the owner.
  const layout = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 400, 400)] as unknown as DOMRectList)
  restoreLayout = () => layout.mockRestore()
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
  f.setDropSupported(false)
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
  retireFeedback(); restoreLayout(); f.release()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})
function Existing() {
  const [items, setItems] = useState<FileAttachment[]>([attachment(9)])
  return <TaskAttachments items={items} taskId="task-1" onChange={async (next, baseline) => {
    await f.host.api.db.updateTask('task-1', { attachments: next }, { attachmentsBaseline: baseline! }); setItems(next)
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
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { attachments: [attachment(9), attachment(1), attachment(2)] }, precondition: { attachmentsBaseline: [attachment(9)] } })
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
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { attachments: [attachment(9), attachment(1)] }, precondition: { attachmentsBaseline: [attachment(9)] } })
  await f.host.reconnect()
  expect(f.calls('attachments:save')).toHaveLength(2)
})
it('retains accepted file receipts without automatic retry when metadata persistence fails', async () => {
  f.handlers.set('db:updateTask', async () => { throw { code: 'DISCONNECTED' } })
  render(<Existing />); fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(f.calls('attachments:save')).toHaveLength(2); expect(f.calls('db:updateTask')).toHaveLength(1)
  expect(screen.queryByText('1.txt')).toBeNull()
  await act(async () => { await f.host.reconnect() }); expect(f.calls('attachments:save')).toHaveLength(2)
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
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'created-task', data: { attachments: [attachment(1)] }, precondition: { attachmentsBaseline: [] } })
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
  expect(changed).toHaveBeenCalledExactlyOnceWith([attachment(1), attachment(2)], [])
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


async function enableDrops() { f.setDropSupported(true); await act(async () => { await f.host.reconnect() }) }
async function acknowledgedDropContext() {
  let contextId: string | undefined
  await waitFor(() => {
    const calls = f.calls('attachments:setNativeDropContext')
    const payload = calls.at(-1)?.[1]?.payload as { contextId?: string | null } | undefined
    expect(typeof payload?.contextId).toBe('string'); contextId = payload?.contextId ?? undefined
  })
  await act(async () => { await Promise.resolve() })
  return contextId!
}

it('accepts the exact native task drop before sequential copies and closes after explicit metadata receipt', async () => {
  await enableDrops()
  const first = held<unknown>(); f.handlers.set('attachments:save', payload => String(payload.filePath).endsWith('1.txt') ? first.promise : Promise.resolve(attachment(2)))
  render(<Existing />); const context = await acknowledgedDropContext()
  let dropId = ''
  act(() => { dropId = f.emitDrop(context) })
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(1)
  expect(f.calls('db:updateTask')).toHaveLength(0); expect(f.calls('native.attachment.drop.close')).toHaveLength(0)
  await act(async () => { first.resolve(attachment(1)) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(2); expect(f.calls('db:updateTask')).toHaveLength(1)
  expect(f.calls('native.attachment.drop.close')[0][1]?.payload).toEqual({ dropId, contextId: context })
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { attachments: [attachment(9), attachment(1), attachment(2)] }, precondition: { attachmentsBaseline: [attachment(9)] } })
})

it('retains an accepted native draft drop until actual task creation and sequential import finish', async () => {
  await enableDrops(); stores.ui.setState({ activeModal: 'create' })
  const first = held<unknown>(); f.handlers.set('attachments:save', payload => String(payload.filePath).endsWith('1.txt') ? first.promise : Promise.resolve(attachment(2)))
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Dropped draft' } })
  const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context) })
  await screen.findByText('1.txt')
  expect(f.calls('attachments:save')).toHaveLength(0); expect(f.calls('native.attachment.drop.close')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  expect(f.calls('attachments:setNativeDropContext').filter(([, args]) => (args?.payload as { contextId: string | null }).contextId !== null)).toHaveLength(1)
  expect(f.calls('native.attachment.drop.close')).toHaveLength(0)
  await act(async () => { first.resolve(attachment(1)) })
  await waitFor(() => expect(stores.ui.getState().activeModal).toBeNull())
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('db:createTask')).toHaveLength(1); expect(f.calls('attachments:save')).toHaveLength(2)
  expect(f.calls('attachments:save').every(([, args]) => (args?.payload as { taskId: string }).taskId === 'created-task')).toBe(true)
})

it('closes ignored native drops when two unrelated visible task targets are ambiguous', async () => {
  await enableDrops()
  render(<><TaskAttachments items={[]} taskId="task-1" onChange={vi.fn()} /><TaskAttachments items={[]} taskId="task-2" onChange={vi.fn()} /></>)
  await waitFor(() => expect((f.calls('attachments:setNativeDropContext').at(-1)?.[1]?.payload as { contextId: unknown })?.contextId).toBeNull())
  act(() => { f.emitDrop(crypto.randomUUID()) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(0); expect(f.calls('attachments:save')).toHaveLength(0)
})


it('joins a held raw drop acceptance on task replacement before closing and never imports into the replacement', async () => {
  await enableDrops()
  const accepting = held<unknown>(); f.handlers.set('native.attachment.drop.accept', () => accepting.promise)
  const changed = vi.fn(), view = render(<TaskAttachments taskId="task-1" items={[]} onChange={changed} />)
  const original = await acknowledgedDropContext(); act(() => { f.emitDrop(original) })
  await waitFor(() => expect(f.calls('native.attachment.drop.accept')).toHaveLength(1))
  view.rerender(<TaskAttachments taskId="task-2" items={[]} onChange={changed} />)
  expect(f.calls('native.attachment.drop.close')).toHaveLength(0); expect(f.calls('attachments:save')).toHaveLength(0)
  await act(async () => { accepting.resolve(undefined) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(0); expect(changed).not.toHaveBeenCalled()
})

it('rejects an old literal context after replacement and never targets the newly visible task at delivery', async () => {
  await enableDrops()
  const changed = vi.fn(), view = render(<TaskAttachments taskId="task-1" items={[]} onChange={changed} />)
  const original = await acknowledgedDropContext()
  view.rerender(<TaskAttachments taskId="task-2" items={[]} onChange={changed} />)
  const replacement = await acknowledgedDropContext(); expect(replacement).not.toBe(original)
  act(() => { f.emitDrop(original) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(0); expect(f.calls('attachments:save')).toHaveLength(0)
})

it('keeps draft receipts during ordinary field edits and closes the group only after all pending files are removed', async () => {
  await enableDrops(); render(<TaskForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
  const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context, ['/synthetic/1.txt']) })
  await screen.findByText('1.txt')
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Still same draft' } })
  expect(f.calls('attachments:setNativeDropContext').filter(([, args]) => (args?.payload as { contextId: string | null }).contextId !== null)).toHaveLength(1)
  expect(f.calls('native.attachment.drop.close')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Remove 1.txt' }))
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(0)
})

it('uses one workspace owner for nested details and composer instead of ambiguous duplicate targets', async () => {
  await enableDrops()
  const changed = vi.fn(async () => {})
  render(<TaskWorkspace task={makeTask()} agents={[]} panelLayout="task-only" onEdit={vi.fn()} onDelete={vi.fn()} onUpdateAttachments={changed} onUpdateOutputFields={vi.fn()} onCompleteTask={vi.fn()} onAssignAgent={vi.fn()} />)
  const context = await acknowledgedDropContext()
  expect(f.calls('attachments:setNativeDropContext').filter(([, args]) => (args?.payload as { contextId: string | null }).contextId !== null)).toHaveLength(1)
  act(() => { f.emitDrop(context) })
  await waitFor(() => expect(changed).toHaveBeenCalledExactlyOnceWith([attachment(1), attachment(2)], []))
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(1)
})

it('rejects another drop while a task import is busy without repeating accepted copies', async () => {
  await enableDrops()
  const first = held<unknown>(); f.handlers.set('attachments:save', payload => String(payload.filePath).endsWith('1.txt') ? first.promise : Promise.resolve(attachment(2)))
  render(<Existing />); const context = await acknowledgedDropContext()
  act(() => { f.emitDrop(context) }); await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  act(() => { f.emitDrop(context, ['/synthetic/3.txt']) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(1)
  await act(async () => { first.resolve(attachment(1)) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(2))
  expect(f.calls('attachments:save')).toHaveLength(2)
})

it('targets only the modal draft while a background task is still mounted', async () => {
  await enableDrops()
  const changed = vi.fn()
  render(<><TaskAttachments taskId="task-1" items={[]} onChange={changed} /><div role="dialog"><TaskForm onSubmit={vi.fn()} onCancel={vi.fn()} /></div></>)
  const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context, ['/synthetic/1.txt']) })
  await screen.findByText('1.txt')
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(1); expect(f.calls('attachments:save')).toHaveLength(0)
  expect(changed).not.toHaveBeenCalled(); expect(f.calls('native.attachment.drop.close')).toHaveLength(0)
})

it('retires an accepted pending draft on reconnect and never replays its file import', async () => {
  await enableDrops(); render(<TaskForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
  const original = await acknowledgedDropContext(); act(() => { f.emitDrop(original, ['/synthetic/1.txt']) })
  await screen.findByText('1.txt')
  await act(async () => { await f.host.reconnect() })
  await waitFor(() => expect(screen.queryByText('1.txt')).toBeNull())
  const replacement = await acknowledgedDropContext(); expect(replacement).not.toBe(original)
  expect(f.calls('native.attachment.drop.close')).toHaveLength(1); expect(f.calls('attachments:save')).toHaveLength(0)
})

it('keeps refusal wording fixed and closes a drop after partial-copy failure without rollback or retry', async () => {
  await enableDrops()
  f.handlers.set('attachments:save', async payload => {
    if (String(payload.filePath).endsWith('1.txt')) return attachment(1)
    throw new Error('private-native-drop-path')
  })
  render(<Existing />); const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context) })
  await screen.findByRole('alert')
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(2); expect(f.calls('db:updateTask')).toHaveLength(1)
  expect(document.body.textContent).not.toContain('private-native-drop-path')
  expect(f.calls('attachments:delete')).toHaveLength(0)
  await act(async () => { await f.host.reconnect() }); expect(f.calls('attachments:save')).toHaveLength(2)
})

it('retries refused drop cleanup on explicit retirement without another accept or import', async () => {
  await enableDrops()
  let closes = 0
  f.handlers.set('native.attachment.drop.close', async () => { if (++closes === 1) throw new Error('private-retirement-refusal') })
  const view = render(<Existing />); const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context) })
  await screen.findByRole('alert')
  expect(f.calls('native.attachment.drop.close')).toHaveLength(1)
  view.unmount()
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(2))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(1); expect(f.calls('attachments:save')).toHaveLength(2)
})

it('fences a project change and return before a held raw acceptance without adopting the replacement intent', async () => {
  await enableDrops()
  const projects = (await import('@/stores/project-store')).useProjectStore
  const originalProject = projects.getState().currentProjectId
  const accepting = held<unknown>(); f.handlers.set('native.attachment.drop.accept', () => accepting.promise)
  render(<Existing />); const original = await acknowledgedDropContext(); act(() => { f.emitDrop(original) })
  await waitFor(() => expect(f.calls('native.attachment.drop.accept')).toHaveLength(1))
  act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: originalProject }) })
  await act(async () => { accepting.resolve(undefined) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(0)
  const replacement = await acknowledgedDropContext(); expect(replacement).not.toBe(original)
})


it.each(['captain', 'task_group'] as const)('keeps native %s file-drop mutation unavailable before acceptance', async role => {
  await enableDrops()
  render(<TaskWorkspace task={makeTask({ role })} agents={[]} panelLayout="task-only" onEdit={vi.fn()} onDelete={vi.fn()} onUpdateAttachments={vi.fn()} onUpdateOutputFields={vi.fn()} onCompleteTask={vi.fn()} onAssignAgent={vi.fn()} />)
  act(() => { f.emitDrop(crypto.randomUUID()) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:setNativeDropContext').filter(([, args]) => (args?.payload as { contextId: string | null }).contextId !== null)).toHaveLength(0)
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(0); expect(f.calls('attachments:save')).toHaveLength(0)
})

it('retires a draft drop on pagehide and ignores its old context after listener cleanup', async () => {
  await enableDrops(); render(<TaskForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
  const original = await acknowledgedDropContext(); act(() => { f.emitDrop(original, ['/synthetic/1.txt']) })
  await screen.findByText('1.txt')
  act(() => { window.dispatchEvent(new Event('pagehide')) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  act(() => { f.emitDrop(original, ['/synthetic/2.txt']) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(2))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(1); expect(f.calls('attachments:save')).toHaveLength(0)
})

it('never registers a drop owner for hidden content and fences it again before a held acceptance settles', async () => {
  await enableDrops()
  const accepting = held<unknown>(); f.handlers.set('native.attachment.drop.accept', () => accepting.promise)
  const changed = vi.fn(), view = render(<div data-testid="hidden-owner" style={{ display: 'none' }}><TaskAttachments taskId="task-1" items={[]} onChange={changed} /></div>)
  await act(async () => { await Promise.resolve() })
  expect(f.calls('attachments:setNativeDropContext').filter(([, args]) => (args?.payload as { contextId: string | null }).contextId !== null)).toHaveLength(0)
  act(() => { screen.getByTestId('hidden-owner').style.display = 'block' })
  const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context) })
  await waitFor(() => expect(f.calls('native.attachment.drop.accept')).toHaveLength(1))
  act(() => { screen.getByTestId('hidden-owner').style.display = 'none' })
  await act(async () => { accepting.resolve(undefined) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(0); expect(changed).not.toHaveBeenCalled()
  view.unmount()
})

it('fences a modal intent change and return before raw acceptance even without a replacement DOM target', async () => {
  await enableDrops()
  const accepting = held<unknown>(); f.handlers.set('native.attachment.drop.accept', () => accepting.promise)
  render(<Existing />); const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context) })
  await waitFor(() => expect(f.calls('native.attachment.drop.accept')).toHaveLength(1))
  act(() => { stores.ui.setState({ activeModal: 'create' }); stores.ui.setState({ activeModal: null }) })
  await act(async () => { accepting.resolve(undefined) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(0)
  expect(await acknowledgedDropContext()).not.toBe(context)
})

it('refuses over-capacity draft offers before acceptance or any file read', async () => {
  await enableDrops()
  const pendingFiles = Array.from({ length: 128 }, (_, index) => ({ id: 'pending-' + index, filename: 'pending-' + index, sourcePath: '/synthetic/pending-' + index, size: 0 }))
  render(<TaskAttachments taskId={null} items={[]} pendingFiles={pendingFiles} onChange={vi.fn()} onPendingChange={vi.fn()} />)
  const context = await acknowledgedDropContext(); act(() => { f.emitDrop(context, ['/synthetic/1.txt']) })
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('native.attachment.drop.accept')).toHaveLength(0); expect(f.calls('attachments:save')).toHaveLength(0)
  expect(screen.getByRole('alert')).toHaveTextContent('Some files could not be attached')
})


it('captures the complete ordered baseline before raw file save and never refreshes or retries a conflict', async () => {
  const saving = held<unknown>(), original = [attachment(9), attachment(8)]
  f.values.set('attachments:pick', ['/synthetic/1.txt'])
  f.handlers.set('attachments:save', () => saving.promise)
  f.handlers.set('db:updateTask', async () => { throw { code: 'INVALID_REQUEST', detail: 'private-conflict' } })
  const changed = vi.fn(async (next: FileAttachment[], baseline?: FileAttachment[]) => {
    await f.host.api.db.updateTask('task-1', { attachments: next }, { attachmentsBaseline: baseline! })
  })
  const view = render(<TaskAttachments taskId="task-1" items={original} onChange={changed} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add files' }))
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  // A canonical event arrives while the independently admitted copy is pending.
  view.rerender(<TaskAttachments taskId="task-1" items={[...original, attachment(7)]} onChange={changed} />)
  original[0].filename = 'mutated-after-intent.txt'
  await act(async () => { saving.resolve(attachment(1)) })
  await screen.findByRole('alert')
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'task-1', data: { attachments: [attachment(9), attachment(8), attachment(1)] }, precondition: { attachmentsBaseline: [attachment(9), attachment(8)] } })
  expect(f.calls('db:updateTask')).toHaveLength(1); expect(f.calls('db:getTask')).toHaveLength(0)
  expect(f.calls('attachments:remove')).toHaveLength(0); expect(document.body.textContent).not.toContain('private-conflict')
  await act(async () => { await f.host.reconnect() }); expect(f.calls('db:updateTask')).toHaveLength(1)
})

it('keeps a workspace import baseline when canonical props change during its raw copy', async () => {
  const saving = held<unknown>(), changed = vi.fn(async () => {})
  f.values.set('attachments:pick', ['/synthetic/1.txt']); f.handlers.set('attachments:save', () => saving.promise)
  const props = { agents: [], panelLayout: 'transcript-only' as const, onEdit: vi.fn(), onDelete: vi.fn(), onUpdateAttachments: changed, onUpdateOutputFields: vi.fn(), onCompleteTask: vi.fn(), onAssignAgent: vi.fn() }
  const view = render(<TaskWorkspace {...props} task={makeTask({ attachments: [attachment(9)] })} />)
  let importing!: Promise<unknown>
  await act(async () => { importing = panel.pick!() })
  await waitFor(() => expect(f.calls('attachments:save')).toHaveLength(1))
  view.rerender(<TaskWorkspace {...props} task={makeTask({ attachments: [attachment(9), attachment(8)] })} />)
  await act(async () => { saving.resolve(attachment(1)); await importing })
  expect(changed).toHaveBeenCalledExactlyOnceWith([attachment(9), attachment(1)], [attachment(9)])
})

it('retains an edit intent baseline across canonical refresh and locks an uncertain save without replay', async () => {
  const original = makeTask({ attachments: [attachment(9), attachment(8)] })
  stores.tasks.setState({ tasks: [original] }); stores.ui.setState({ activeModal: 'edit', editingTaskId: original.id })
  f.handlers.set('db:updateTask', async () => { throw { code: 'INVALID_REQUEST', detail: 'private-conflict' } })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsaved edit' } })
  act(() => stores.tasks.setState({ tasks: [{ ...original, title: 'Concurrent canonical', attachments: [...original.attachments, attachment(7)] }] }))
  expect(screen.getByLabelText('Title')).toHaveValue('Unsaved edit')
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await screen.findByText('Task save could not be confirmed. Close this draft and review the task list before saving again.')
  expect(f.calls('db:updateTask')[0][1]?.payload).toMatchObject({ id: original.id, data: { title: 'Unsaved edit', attachments: original.attachments }, precondition: { attachmentsBaseline: original.attachments } })
  const data = (f.calls('db:updateTask')[0][1]?.payload as { data: Record<string, unknown> }).data
  expect(data).not.toHaveProperty('_attachmentsBaseline'); expect(data).not.toHaveProperty('_pendingFiles')
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  await act(async () => { await f.host.reconnect() }); expect(f.calls('db:updateTask')).toHaveLength(1)
})

it('uses the accepted new task attachment receipt as draft import baseline', async () => {
  f.handlers.set('db:createTask', async payload => makeTask({ ...(payload.data as Partial<Task>), id: 'created-task', attachments: [attachment(9)] }))
  f.values.set('attachments:pick', ['/synthetic/1.txt']); stores.ui.setState({ activeModal: 'create' })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New task receipt' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add files' })); await screen.findByText('1.txt')
  fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
  await waitFor(() => expect(f.calls('db:updateTask')).toHaveLength(1))
  expect(f.calls('db:updateTask')[0][1]?.payload).toEqual({ id: 'created-task', data: { attachments: [attachment(9), attachment(1)] }, precondition: { attachmentsBaseline: [attachment(9)] } })
  expect(f.calls('db:getTask')).toHaveLength(0)
})

it('does not close or overwrite a replacement edit dialog after a raw save settles', async () => {
  const saving = held<unknown>(), original = makeTask({ attachments: [attachment(9)] })
  f.handlers.set('db:updateTask', () => saving.promise)
  stores.tasks.setState({ tasks: [original] }); stores.ui.setState({ activeModal: 'edit', editingTaskId: original.id })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Old save' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(f.calls('db:updateTask')).toHaveLength(1))
  act(() => { stores.ui.setState({ activeModal: null }); stores.ui.setState({ activeModal: 'edit', editingTaskId: original.id }) })
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Replacement draft' } })
  await act(async () => { saving.resolve(makeTask({ title: 'Old save', attachments: [attachment(9)] })) })
  expect(stores.ui.getState().activeModal).toBe('edit'); expect(screen.getByLabelText('Title')).toHaveValue('Replacement draft')
  expect(f.calls('db:updateTask')).toHaveLength(1)
})


function CanonicalExisting() {
  const task = stores.tasks(state => state.tasks.find(record => record.id === 'task-1'))!
  return <TaskAttachments items={task.attachments} taskId={task.id} onChange={async (next, baseline) => {
    await stores.tasks.getState().updateTask(task.id, { attachments: next }, { attachmentsBaseline: baseline! })
  }} />
}
function canonicalRemoval(partial = false) {
  const original = makeTask({ attachments: [attachment(9), attachment(8)] })
  stores.tasks.setState({ tasks: [original] })
  f.handlers.set('attachments:remove', async () => {
    f.values.set('db:getTasks', [{ ...original, attachments: [attachment(8)] }])
    if (partial) throw { code: 'IO_ERROR', detail: 'private-unlink-canary' }
  })
  return original
}
it('consumes native exact-ID removal through canonical readback without a second full-array write', async () => {
  canonicalRemoval(); render(<CanonicalExisting />)
  fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await waitFor(() => expect(screen.queryByText('9.txt')).toBeNull())
  expect(screen.getByText('8.txt')).toBeInTheDocument()
  expect(f.calls('attachments:remove')).toHaveLength(1); expect(f.calls('db:getTasks')).toHaveLength(1)
  expect(f.calls('db:updateTask')).toHaveLength(0)
})
it('reconciles accepted native metadata after raw cleanup refusal and never replays removal', async () => {
  canonicalRemoval(true); render(<CanonicalExisting />)
  fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await screen.findByRole('alert')
  expect(screen.queryByText('9.txt')).toBeNull(); expect(screen.getByText('8.txt')).toBeInTheDocument()
  expect(document.body.textContent).not.toContain('private-unlink-canary')
  expect(f.calls('db:getTasks')).toHaveLength(1); expect(f.calls('db:updateTask')).toHaveLength(0)
  await act(async () => { await f.host.reconnect() }); expect(f.calls('attachments:remove')).toHaveLength(1)
})
it('preserves edit text and locks Save for canonical review after native exact-ID removal', async () => {
  canonicalRemoval(); stores.ui.setState({ activeModal: 'edit', editingTaskId: 'task-1' })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Other unsaved edit' } })
  fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await waitFor(() => expect(screen.queryByText('9.txt')).toBeNull())
  expect(screen.getByLabelText('Title')).toHaveValue('Other unsaved edit')
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  expect(screen.getByText('Attachment removal needs review. Close this draft and review the saved task before saving other edits.')).toBeInTheDocument()
  expect(f.calls('db:updateTask')).toHaveLength(0)
})

it('keeps canonical records on pre-unlink refusal and fences another native removal until review', async () => {
  const original = canonicalRemoval(); f.values.set('db:getTasks', [original])
  f.handlers.set('attachments:remove', async () => { throw { code: 'FORBIDDEN', detail: 'private-scope-canary' } })
  render(<CanonicalExisting />); fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await screen.findByRole('alert'); expect(screen.getByText('9.txt')).toBeInTheDocument()
  expect(screen.getAllByTitle('Remove attachment').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled()
  expect(document.body.textContent).not.toContain('private-scope-canary'); expect(f.calls('db:updateTask')).toHaveLength(0)
})
it('requires review after acknowledged removal with failed canonical readback without fabricating metadata', async () => {
  canonicalRemoval(); f.handlers.set('db:getTasks', async () => { throw { code: 'DISCONNECTED' } })
  render(<CanonicalExisting />); fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await screen.findByRole('alert'); expect(screen.getByText('9.txt')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add files' })).toBeDisabled()
  expect(f.calls('attachments:remove')).toHaveLength(1); expect(f.calls('db:updateTask')).toHaveLength(0)
  await act(async () => { await f.host.reconnect() }); expect(f.calls('attachments:remove')).toHaveLength(1)
})
it('refuses a void removal acknowledgement whose canonical record remains referenced', async () => {
  const original = canonicalRemoval(); f.handlers.set('attachments:remove', async () => {}); f.values.set('db:getTasks', [original])
  render(<CanonicalExisting />); fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await screen.findByRole('alert'); expect(screen.getByText('9.txt')).toBeInTheDocument()
  expect(f.calls('db:updateTask')).toHaveLength(0)
})
it('does not publish a held removal readback into a replacement task attachment component', async () => {
  canonicalRemoval(); const read = held<unknown>(); f.handlers.set('db:getTasks', () => read.promise)
  const changed = vi.fn(), settled = vi.fn(), view = render(<TaskAttachments items={[attachment(9)]} taskId="task-1" onChange={changed} onNativeRemovalSettled={settled} />)
  fireEvent.click(screen.getByTitle('Remove attachment'))
  await waitFor(() => expect(f.calls('db:getTasks')).toHaveLength(1))
  view.rerender(<TaskAttachments items={[attachment(8)]} taskId="replacement-task" onChange={changed} onNativeRemovalSettled={settled} />)
  await act(async () => { read.resolve([makeTask({ attachments: [] })]) })
  expect(settled).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(screen.getByText('8.txt')).toBeInTheDocument()
})
it.each(['pagehide', 'project-return', 'modal-return', 'connection'] as const)('retires native removal followups on %s while raw work remains Source-owned', async event => {
  const remove = held<unknown>(); f.handlers.set('attachments:remove', () => remove.promise)
  const settled = vi.fn(); render(<TaskAttachments items={[attachment(9)]} taskId="task-1" onChange={vi.fn()} onNativeRemovalSettled={settled} />)
  fireEvent.click(screen.getByTitle('Remove attachment'))
  await waitFor(() => expect(f.calls('attachments:remove')).toHaveLength(1))
  if (event === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (event === 'project-return') {
    const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
    act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: initial }) })
  }
  if (event === 'modal-return') act(() => { stores.ui.setState({ activeModal: 'create' }); stores.ui.setState({ activeModal: null }) })
  if (event === 'connection') await act(async () => { await f.host.reconnect() })
  await act(async () => { remove.resolve(undefined) })
  expect(f.calls('db:getTasks')).toHaveLength(0); expect(f.calls('db:updateTask')).toHaveLength(0); expect(settled).not.toHaveBeenCalled()
  expect(f.calls('attachments:remove')).toHaveLength(1)
})
it.each(['connection', 'project-return'] as const)('keeps the original native form baseline and refuses Save after %s', async event => {
  stores.tasks.setState({ tasks: [makeTask({ attachments: [attachment(9)] })] }); stores.ui.setState({ activeModal: 'edit', editingTaskId: 'task-1' })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Original unsaved edit' } })
  if (event === 'connection') await act(async () => { await f.host.reconnect() })
  else {
    const projects = (await import('@/stores/project-store')).useProjectStore, initial = projects.getState().currentProjectId
    act(() => { projects.setState({ currentProjectId: 'temporary-project' }); projects.setState({ currentProjectId: initial }) })
  }
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled(); expect(screen.getByLabelText('Title')).toHaveValue('Original unsaved edit')
  fireEvent.submit(screen.getByLabelText('Title').closest('form')!)
  expect(f.calls('db:updateTask')).toHaveLength(0)
})

it('preserves other known unsaved import receipts while applying only confirmed exact-ID removal to a review draft', async () => {
  canonicalRemoval(); stores.ui.setState({ activeModal: 'edit', editingTaskId: 'task-1' }); f.values.set('attachments:pick', ['/synthetic/1.txt'])
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add files' })); await screen.findByText('1.txt')
  expect(f.calls('db:updateTask')).toHaveLength(0)
  fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await waitFor(() => expect(screen.queryByText('9.txt')).toBeNull())
  expect(screen.getByText('1.txt')).toBeInTheDocument(); expect(screen.getByText('8.txt')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  expect(f.calls('attachments:save')).toHaveLength(1); expect(f.calls('db:updateTask')).toHaveLength(0)
  expect(stores.tasks.getState().tasks[0].attachments).toEqual([attachment(8)])
})

it('captures the exact removed ID before raw work and refuses later record-object retargeting', async () => {
  const original = canonicalRemoval(), removing = held<unknown>(), item = { ...attachment(9) }, settled = vi.fn()
  f.handlers.set('attachments:remove', () => removing.promise); f.values.set('db:getTasks', [{ ...original, attachments: [attachment(8)] }])
  render(<TaskAttachments items={[item, attachment(8)]} taskId="task-1" onChange={vi.fn()} onNativeRemovalSettled={settled} />)
  fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await waitFor(() => expect(f.calls('attachments:remove')).toHaveLength(1))
  item.id = attachment(7).id
  await act(async () => { removing.resolve(undefined) })
  await waitFor(() => expect(settled).toHaveBeenCalledExactlyOnceWith(attachment(9).id, [attachment(8)]))
  expect(f.calls('attachments:remove')[0][1]?.payload).toEqual({ taskId: 'task-1', attachmentId: attachment(9).id })
  expect(f.calls('db:updateTask')).toHaveLength(0)
})

it('fences a coalesced native offer before React commits the edit-draft review controls', async () => {
  await enableDrops(); const original = canonicalRemoval(); stores.ui.setState({ activeModal: 'edit', editingTaskId: 'task-1' })
  let context = ''
  f.handlers.set('db:getTasks', async () => {
    // Drain the current RPC/readback continuations without yielding a browser
    // paint, then deliver an already queued native offer for the same context.
    let remaining = 100
    const deliver = () => { if (--remaining) queueMicrotask(deliver); else f.emitDrop(context, ['/synthetic/1.txt']) }
    queueMicrotask(deliver)
    return [{ ...original, attachments: [attachment(8)] }]
  })
  const noop = vi.fn(async () => {})
  render(<TaskDialogs agents={[]} showToast={vi.fn()} completeTask={noop} onGoToFullView={noop} onNavigateFromPreview={noop} onAssignAgent={noop} onUpdateTask={noop} />)
  context = await acknowledgedDropContext()
  fireEvent.click(screen.getAllByTitle('Remove attachment')[0])
  await waitFor(() => expect(f.calls('native.attachment.drop.close')).toHaveLength(1))
  expect(f.calls('attachments:save')).toHaveLength(0); expect(f.calls('native.attachment.drop.accept')).toHaveLength(0)
  expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
})

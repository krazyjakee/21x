import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { TaskGroupRecord } from '@shared/task-groups'
import type { Task, UpdateTaskDTO } from '@/types'
import { TaskStatus } from '@shared/constants'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
const drag = vi.hoisted(() => ({ start: undefined as ((e: DragStartEvent) => void) | undefined, end: undefined as ((e: DragEndEvent) => void) | undefined, cancel: undefined as (() => void) | undefined }))
vi.mock('@dnd-kit/core', async original => ({ ...await original<typeof import('@dnd-kit/core')>(), DndContext: (props: { children: ReactNode; onDragStart?: typeof drag.start; onDragEnd?: typeof drag.end; onDragCancel?: () => void }) => { drag.start = props.onDragStart; drag.end = props.onDragEnd; drag.cancel = props.onDragCancel; return props.children } }))
vi.mock('@/hooks/use-snooze-tick', () => ({ useSnoozeTick: () => 0 }))
const held = <T,>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
const task = (extra: Partial<Task> = {}): Task => ({ id: 'task-1', title: 'Captured completion', description: '', type: 'general', role: 'task', priority: 'medium', status: 'ready_for_review', assignee: '', source: 'manual', project_id: 'default', created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null, resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null, heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null, is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false, labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null, recurrence_pattern: null, heartbeat_interval_minutes: null, complete_at_source: null, next_subtask_ids: [], sort_order: 0, ...extra } as Task)
let canonical: Task[] = []
const values = new Map<string, unknown>(), handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>()
let receiveService: ((event: { payload: unknown }) => void) | undefined, sequence = 0
const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'board-engine', uiLeaseId: 'board-document' }
  const op = String(args?.operation), result = handlers.has(op) ? await handlers.get(op)!(args?.payload as Record<string, unknown>) : values.get(op)
  return { engineEpoch: 'board-engine', result: result === undefined ? { defined: false } : { defined: true, value: result } }
})
const calls = (op: string) => invoke.mock.calls.filter(([, args]) => args?.operation === op)
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>, release: () => void
let Board: typeof import('./TaskBoard').TaskBoard, useCompletion: typeof import('@/hooks/use-task-completion').useTaskCompletion
let tasks: typeof import('@/stores/task-store').useTaskStore, projects: typeof import('@/stores/project-store').useProjectStore, groups: typeof import('@/stores/task-group-store').useTaskGroupStore
let transition: typeof import('./task-board-transition').transitionTaskFromBoard
let client: typeof import('@/lib/ipc-client')
const legacy = window.electronAPI
function Harness({ show = true, handler = true }: { show?: boolean; handler?: boolean }) {
  const completion = useCompletion({ viewKey: 'retained-dashboard' })
  return <>{completion.completionDialog}{show && <Board onStatusChange={handler ? (row, status, context?: { assertCurrent: () => void }) => transition(row, status, {
    startTask: client.agentSessionApi.startTask, stopByTaskId: client.agentSessionApi.stopByTaskId, getStartRecoveryState: client.agentApi.getStartRecoveryState,
    updateTask: client.taskApi.update, exportUpdate: (id, data) => client.taskSourceApi.exportUpdate(id, data as Record<string, unknown>), completeTask: (id, options) => completion.requestComplete(id, { ...options, beforeComplete: async () => { context?.assertCurrent(); await options?.beforeComplete() } })
  }, context) : undefined} />}</>
}
beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  host = (await import('@/lib/native-desktop-host')).createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => { if (name === 'desktop:event') receiveService = receive; return () => {} }) } } as unknown as TauriDesktopApi)
  release = (await import('@/lib/desktop-api')).installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
  Board = (await import('./TaskBoard')).TaskBoard; useCompletion = (await import('@/hooks/use-task-completion')).useTaskCompletion
  tasks = (await import('@/stores/task-store')).useTaskStore; projects = (await import('@/stores/project-store')).useProjectStore; groups = (await import('@/stores/task-group-store')).useTaskGroupStore
  transition = (await import('./task-board-transition')).transitionTaskFromBoard; client = await import('@/lib/ipc-client')
})
beforeEach(async () => {
  values.clear(); handlers.clear(); invoke.mockClear(); sequence = 0; canonical = [task({ status: TaskStatus.NotStarted })]
  handlers.set('db:getTasks', async () => canonical); handlers.set('db:getTask', async p => canonical.find(row => row.id === p.id))
  handlers.set('db:updateTask', async p => { const row = canonical.find(row => row.id === p.id); if (!row) return undefined; const accepted = { ...row, ...p.data as UpdateTaskDTO }; canonical = canonical.map(row => row.id === p.id ? accepted : row); return accepted })
  values.set('settings:get', null); values.set('agent:getAll', []); values.set('agent:getStartQueue', []); values.set('agent:getStartRecoveryState', null); values.set('taskGroups:list', [])
  values.set('agentSession:startTask', { action: 'task_started', taskId: 'task-1', sessionId: 'accepted-session' })
  tasks.setState({ tasks: canonical, selectedTaskId: null, isLoading: false }); projects.setState({ currentProjectId: 'default' }); groups.setState({ projects: {}, snapshots: {}, errors: {}, busy: {} })
  await host.reconnect(); const store = await import('@/stores/task-store'); store.initializeTaskDesktopState(); await store.rehydrateTaskDesktopState()
})
afterEach(async () => { cleanup(); vi.restoreAllMocks(); (await import('@/stores/task-group-store')).retireTaskGroupDesktopState() })
afterAll(() => { release(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
const active = (id: string, groupId?: string) => ({ id, data: { current: groupId ? { groupId } : {} }, rect: { current: { initial: null, translated: null } } })
const startEvent = (id: string, groupId?: string): DragStartEvent => ({ active: active(id, groupId), activatorEvent: new Event('pointerdown') })
const endEvent = (id: string, status: TaskStatus, groupId?: string): DragEndEvent => ({ active: active(id, groupId), activatorEvent: new Event('pointerup'), collisions: [], delta: { x: 0, y: 0 }, over: { id: `status:${status}`, data: { current: { status } }, disabled: false, rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } } })
const start = (id = 'task-1') => act(() => drag.start?.(startEvent(id)))
const drop = (status = TaskStatus.AgentWorking, id = 'task-1', end = drag.end) => act(() => end?.(endEvent(id, status)))
it('uses one existing start owner without a runtime status prewrite or synthetic session', async () => {
  render(<Harness />); start(); drop(); await waitFor(() => expect(calls('agentSession:startTask')).toHaveLength(1))
  expect(calls('db:updateTask')).toHaveLength(0); expect(tasks.getState().tasks[0].status).toBe(TaskStatus.NotStarted)
})
it('synchronously admits one drop while its original start receipt is held', async () => {
  const raw = held<unknown>(); handlers.set('agentSession:startTask', () => raw.promise); render(<Harness />); start(); const end = drag.end
  drop(TaskStatus.AgentWorking, 'task-1', end); drop(TaskStatus.AgentWorking, 'task-1', end)
  await waitFor(() => expect(calls('agentSession:startTask')).toHaveLength(1)); await act(async () => raw.resolve({ action: 'queued', queuePosition: 2, queueReason: 'agent_limit' }))
  expect(calls('agentSession:startTask')).toHaveLength(1); expect(calls('db:updateTask')).toHaveLength(0)
})
it.each(['project-return', 'pagehide', 'reconnect', 'unmount'] as const)('refuses an original gesture after %s', async mode => {
  const view = render(<Harness />); start(); const end = drag.end
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (mode === 'reconnect') await act(async () => host.reconnect())
  if (mode === 'unmount') view.unmount()
  drop(TaskStatus.AgentWorking, 'task-1', end); await act(async () => {})
  expect(calls('agentSession:startTask')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})
it.each(['source', 'agent', 'parent', 'project-return', 'role'] as const)('cannot retarget the original gesture after an observed %s binding replacement', async mode => {
  render(<Harness />); start()
  const replacement: Partial<Task> = mode === 'source' ? { source_id: 'replacement-source', external_id: '9' } : mode === 'agent' ? { agent_id: 'replacement-agent' } : mode === 'parent' ? { parent_task_id: 'new-parent' } : mode === 'role' ? { role: 'captain' } : { project_id: 'other-project' }
  act(() => { tasks.setState({ tasks: [task({ status: TaskStatus.NotStarted, ...replacement })] }); if (mode === 'project-return') tasks.setState({ tasks: canonical }) })
  drop(); await act(async () => {}); expect(calls('agentSession:startTask')).toHaveLength(0)
})
it('rejects a cached end callback from a cancelled gesture after another gesture starts', async () => {
  render(<Harness />); start(); const old = drag.end; act(() => drag.cancel?.()); start(); drop(TaskStatus.AgentWorking, 'task-1', old)
  await act(async () => {}); expect(calls('agentSession:startTask')).toHaveLength(0)
  drop(); await waitFor(() => expect(calls('agentSession:startTask')).toHaveLength(1))
})
it('requires an original drag start before any drop mutation', async () => {
  render(<Harness />); drop(); await act(async () => {}); expect(calls('agentSession:startTask')).toHaveLength(0)
})
it('has no native mutation fallback when the dashboard transition owner is absent', async () => {
  render(<Harness handler={false} />); start(); drop(TaskStatus.ReadyForReview); await act(async () => {}); expect(calls('db:updateTask')).toHaveLength(0)
})
it('keeps an unknown start in fixed review and never retries on another drag or reconnect', async () => {
  handlers.set('agentSession:startTask', async () => { throw new Error('private-board-diagnostic') }); vi.spyOn(console, 'error').mockImplementation(() => {})
  render(<Harness />); start(); drop(); await screen.findByRole('alert'); start(); drop(); await act(async () => host.reconnect())
  expect(calls('agentSession:startTask')).toHaveLength(1); expect(document.body.textContent).not.toContain('private-board-diagnostic')
})
it('fences a still-mounted completion dialog when only its originating board unmounts', async () => {
  canonical = [task({ source_id: 'source-1', external_id: '7', source: 'GitHub' })]; tasks.setState({ tasks: canonical })
  const view = render(<Harness />); start(); drop(TaskStatus.Completed); await screen.findByTestId('complete-at-source-dialog')
  view.rerender(<Harness show={false} />); fireEvent.click(screen.getByTestId('complete-manually')); await act(async () => {})
  expect(calls('db:updateTask')).toHaveLength(0); expect(calls('plugin:executeAction')).toHaveLength(0)
})

const queue = (extra: Record<string, unknown> = {}) => ({ id: 'queue-1', taskId: 'task-1', projectId: 'default', agentId: 'agent-1', reason: 'agent_limit', queuedAt: '2026-10-18T00:00:00Z', position: 1, priority: 'medium', state: 'queued', retryCount: 0, nextRetryAt: null, generation: 1, dependencyReason: null, recoveryCause: null, recoveryAction: null, recoveryResult: null, lastError: null, ...extra })
const emitQueue = (rows: ReturnType<typeof queue>[]) => act(() => receiveService?.({ payload: { protocolVersion: 1, kind: 'event', operation: 'agent:startQueueChanged', payload: { queue: rows }, engineEpoch: 'board-engine', sequence: ++sequence } }))
it('shows a queued acknowledgement without manufacturing canonical working state', async () => {
  values.set('agentSession:startTask', { action: 'queued', queuePosition: 2, queueReason: 'agent_limit' }); render(<Harness />); start(); drop()
  expect(await screen.findByTestId('task-transition-task-1')).toHaveTextContent('queued'); expect(tasks.getState().tasks[0].status).toBe(TaskStatus.NotStarted)
})
it.each(['pagehide', 'project-return', 'reconnect'] as const)('never publishes a held recovery snapshot after %s', async mode => {
  const raw = held<unknown>(); handlers.set('agent:getStartRecoveryState', () => raw.promise); render(<Harness />)
  await waitFor(() => expect(calls('agent:getStartRecoveryState')).toHaveLength(1))
  if (mode === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')))
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: 'default' }) })
  if (mode === 'reconnect') { await act(async () => host.reconnect()); handlers.set('agent:getStartRecoveryState', async () => null) }
  await act(async () => raw.resolve(queue())); expect(screen.queryByTestId('task-transition-task-1')).toBeNull()
})
it('rejects recovery rows for a different literal task or project instead of applying them to a visible card', async () => {
  canonical.push(task({ id: 'task-2', status: TaskStatus.NotStarted })); tasks.setState({ tasks: canonical })
  handlers.set('agent:getStartRecoveryState', async p => p.taskId === 'task-1' ? queue({ taskId: 'task-2' }) : null)
  render(<Harness />); await screen.findByRole('alert'); expect(screen.queryByTestId('task-transition-task-2')).toBeNull()
})
it('a late recovery read cannot overwrite a newer queue event', async () => {
  const raw = held<unknown>(); handlers.set('agent:getStartRecoveryState', () => raw.promise); render(<Harness />)
  await waitFor(() => expect(calls('agent:getStartRecoveryState')).toHaveLength(1)); emitQueue([queue()]); handlers.set('agent:getStartRecoveryState', async () => queue())
  await act(async () => raw.resolve(null)); expect(await screen.findByTestId('task-transition-task-1')).toHaveTextContent('queued')
})
it('stops recovery event reads after pagehide and disposes the board observer', async () => {
  render(<Harness />); await waitFor(() => expect(calls('agent:getStartRecoveryState')).toHaveLength(1)); act(() => window.dispatchEvent(new Event('pagehide')))
  const before = calls('agent:getStartRecoveryState').length; emitQueue([queue()]); await act(async () => {}); expect(calls('agent:getStartRecoveryState')).toHaveLength(before)
})
it('refreshes read-only recovery state on the current connection without replaying a drag', async () => {
  render(<Harness />); await waitFor(() => expect(calls('agent:getStartRecoveryState')).toHaveLength(1)); values.set('agent:getStartRecoveryState', queue())
  await act(async () => host.reconnect()); expect(await screen.findByTestId('task-transition-task-1')).toHaveTextContent('queued'); expect(calls('agentSession:startTask')).toHaveLength(0)
})
it.each(['project-return', 'unmount'] as const)('starts no later Source content export after %s during the canonical board write', async mode => {
  canonical = [task({ source_id: 'source-1', external_id: '7', status: TaskStatus.NotStarted })]; tasks.setState({ tasks: canonical })
  const raw = held<unknown>(); handlers.set('db:updateTask', () => raw.promise); const view = render(<Harness />); start(); drop(TaskStatus.ReadyForReview)
  await waitFor(() => expect(calls('db:updateTask')).toHaveLength(1))
  if (mode === 'project-return') act(() => { projects.setState({ currentProjectId: 'other-project' }); projects.setState({ currentProjectId: 'default' }) }); else view.unmount()
  await act(async () => raw.resolve({ ...canonical[0], status: TaskStatus.ReadyForReview })); expect(calls('taskSource:exportUpdate')).toHaveLength(0)
})
it('preserves one deliberate linked-task content export after its canonical board receipt', async () => {
  canonical = [task({ source_id: 'source-1', external_id: '7', status: TaskStatus.NotStarted })]; tasks.setState({ tasks: canonical }); render(<Harness />); start(); drop(TaskStatus.ReadyForReview)
  await waitFor(() => expect(calls('taskSource:exportUpdate')).toHaveLength(1)); expect(calls('db:updateTask')).toHaveLength(1); expect(calls('agentSession:stopByTaskId')).toHaveLength(0)
})

const groupRow = (extra: Partial<TaskGroupRecord> = {}): TaskGroupRecord => ({ id: 'group-1', title: 'Captured group', project_id: 'default', agent_id: 'agent-1', execution_task_id: 'group-anchor', state: 'active', status: 'not_started', task_ids: ['member-1', 'member-2'], former_task_ids: [], progress: [], created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', ...extra })
const groupStart = (id = 'group:group-1') => act(() => drag.start?.(startEvent(id, 'group-1')))
const groupDrop = (status = TaskStatus.AgentWorking, end = drag.end) => act(() => end?.(endEvent('group:group-1', status, 'group-1')))
const seedGroup = () => {
  const row = groupRow(); canonical = [task({ id: 'member-1', group_id: row.id }), task({ id: 'member-2', group_id: row.id })]; tasks.setState({ tasks: canonical }); groups.setState({ projects: { default: [row] } }); values.set('taskGroups:list', [row]); values.set('taskGroups:move', row)
}
it('keeps group queued runtime status canonical and submits one exact group move', async () => {
  seedGroup(); render(<Harness />); groupStart(); const end = drag.end; groupDrop(TaskStatus.AgentWorking, end); groupDrop(TaskStatus.AgentWorking, end)
  await waitFor(() => expect(calls('taskGroups:move')).toHaveLength(1)); expect(calls('agentSession:startTask')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
  expect(groups.getState().projects.default[0].status).toBe('not_started')
})
it('retires a group gesture across membership withdrawal and restoration', async () => {
  seedGroup(); render(<Harness />); groupStart()
  act(() => { groups.setState({ projects: { default: [groupRow({ task_ids: ['member-1'] })] } }); groups.setState({ projects: { default: [groupRow()] } }) })
  groupDrop(); await act(async () => {}); expect(calls('taskGroups:move')).toHaveLength(0)
})
it('refuses a group receipt for another execution owner before followup reads', async () => {
  seedGroup(); values.set('taskGroups:move', groupRow({ execution_task_id: 'foreign-anchor' })); render(<Harness />); await waitFor(() => expect(calls('taskGroups:list')).toHaveLength(1))
  const before = calls('taskGroups:list').length; groupStart(); groupDrop(); await screen.findByRole('alert'); expect(calls('taskGroups:list')).toHaveLength(before)
})
it('does not interpret a foreign active ID as the original group gesture', async () => {
  seedGroup(); render(<Harness />); groupStart('group:foreign'); groupDrop(); await act(async () => {}); expect(calls('taskGroups:move')).toHaveLength(0)
})
it('does not invent an unsupported group triage operation', async () => {
  seedGroup(); render(<Harness />); groupStart(); groupDrop(TaskStatus.Triaging); await screen.findByRole('alert'); expect(calls('taskGroups:move')).toHaveLength(0)
})
it('never follows a retired held group mutation with new group reads', async () => {
  seedGroup(); const raw = held<unknown>(); handlers.set('taskGroups:move', () => raw.promise); const view = render(<Harness />); groupStart(); groupDrop(); await waitFor(() => expect(calls('taskGroups:move')).toHaveLength(1))
  view.unmount(); const before = calls('taskGroups:list').length; await act(async () => raw.resolve(groupRow())); expect(calls('taskGroups:list')).toHaveLength(before)
})
it('clears a transient queued badge from canonical cancelled recovery without a command replay', async () => {
  values.set('agentSession:startTask', { action: 'queued', queuePosition: 2, queueReason: 'agent_limit' }); render(<Harness />); start(); drop(); expect(await screen.findByTestId('task-transition-task-1')).toHaveTextContent('queued')
  values.set('agent:getStartRecoveryState', queue({ state: 'cancelled' })); emitQueue([])
  await waitFor(() => expect(screen.queryByTestId('task-transition-task-1')).toBeNull()); expect(calls('agentSession:startTask')).toHaveLength(1)
})
it('bounds concurrent recovery reads to four and joins the batch before the next', async () => {
  canonical = Array.from({ length: 12 }, (_, i) => task({ id: `task-${i}`, status: TaskStatus.NotStarted })); tasks.setState({ tasks: canonical })
  const raw = held<unknown>(); handlers.set('agent:getStartRecoveryState', () => raw.promise); render(<Harness />); await waitFor(() => expect(calls('agent:getStartRecoveryState')).toHaveLength(4))
  emitQueue([]); emitQueue([]); expect(calls('agent:getStartRecoveryState')).toHaveLength(4)
  handlers.set('agent:getStartRecoveryState', async () => null); await act(async () => raw.resolve(null)); await waitFor(() => expect(calls('agent:getStartRecoveryState')).toHaveLength(16))
})

it('refuses a foreign-project canonical status receipt before any later linked Source export', async () => {
  canonical = [task({ source_id: 'source-1', external_id: '7', status: TaskStatus.NotStarted })]; tasks.setState({ tasks: canonical })
  handlers.set('db:updateTask', async () => ({ ...canonical[0], status: TaskStatus.ReadyForReview, project_id: 'foreign-project' }))
  render(<Harness />); start(); drop(TaskStatus.ReadyForReview); await screen.findByRole('alert'); expect(calls('taskSource:exportUpdate')).toHaveLength(0)
})
it('fences a late held start receipt from a replacement board without replay or runtime rollback', async () => {
  const raw = held<unknown>(); handlers.set('agentSession:startTask', () => raw.promise); const view = render(<Harness />); start(); drop(); await waitFor(() => expect(calls('agentSession:startTask')).toHaveLength(1))
  view.rerender(<Harness show={false} />); view.rerender(<Harness show />)
  await act(async () => raw.resolve({ action: 'queued', queuePosition: 2, queueReason: 'agent_limit' }))
  expect(screen.queryByTestId('task-transition-task-1')).toBeNull(); expect(calls('agentSession:startTask')).toHaveLength(1); expect(calls('agentSession:stopByTaskId')).toHaveLength(0)
})
it('admits no future recovery reads for a board beyond its finite 512-task read budget', async () => {
  canonical = Array.from({ length: 513 }, (_, i) => task({ id: `budget-${i}`, status: TaskStatus.NotStarted })); tasks.setState({ tasks: canonical })
  render(<Harness />); await screen.findByRole('alert'); expect(calls('agent:getStartRecoveryState')).toHaveLength(0)
})

it('releases both direct gesture observations immediately on pagehide', () => {
  const taskSubscribe = tasks.subscribe, groupSubscribe = groups.subscribe, offTask = vi.fn(), offGroup = vi.fn()
  vi.spyOn(tasks, 'subscribe').mockImplementation(listener => { const off = taskSubscribe(listener); return () => { offTask(); off() } })
  vi.spyOn(groups, 'subscribe').mockImplementation(listener => { const off = groupSubscribe(listener); return () => { offGroup(); off() } })
  render(<Harness />); start(); act(() => window.dispatchEvent(new Event('pagehide')))
  expect(offTask).toHaveBeenCalledOnce(); expect(offGroup).toHaveBeenCalledOnce()
})

it('withdraws an original gesture across an observed status change and return before admission', async () => {
  render(<Harness />); start(); act(() => { tasks.setState({ tasks: [task({ status: TaskStatus.AgentWorking })] }); tasks.setState({ tasks: canonical }) })
  drop(); await act(async () => {}); expect(calls('agentSession:startTask')).toHaveLength(0)
})
it('withdraws a delayed completion choice across an observed status change and return before its first write', async () => {
  canonical = [task({ source_id: 'source-1', external_id: '7' })]; tasks.setState({ tasks: canonical }); render(<Harness />); start(); drop(TaskStatus.Completed); await screen.findByTestId('complete-at-source-dialog')
  act(() => { tasks.setState({ tasks: [{ ...canonical[0], status: TaskStatus.AgentWorking }] }); tasks.setState({ tasks: canonical }) })
  fireEvent.click(screen.getByTestId('complete-manually')); await act(async () => {}); expect(calls('db:updateTask')).toHaveLength(0)
})

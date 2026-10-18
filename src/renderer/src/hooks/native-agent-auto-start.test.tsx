import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Task, Agent } from '@/types'
import { TaskStatus } from '@shared/constants'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
const held = <T,>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
const task = (extra: Partial<Task> = {}): Task => ({ id: 'task-1', title: 'Captured completion', description: '', type: 'general', role: 'task', priority: 'medium', status: 'ready_for_review', assignee: '', source: 'manual', project_id: 'default', created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null, resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null, next_occurrence_at: null, heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null, is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false, labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null, recurrence_pattern: null, heartbeat_interval_minutes: null, complete_at_source: null, next_subtask_ids: [], sort_order: 0, ...extra } as Task)
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: 'agent-1', name: 'Original agent', server_url: '', config: {}, is_default: true, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', ...extra })
const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<unknown>>()
let canonical: Task[] = [], receiver: ((event: { payload: unknown }) => void) | undefined, sequence = 0
const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
 if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'autorun-engine', uiLeaseId: 'autorun-document' }
 const op = String(args?.operation), result = await handlers.get(op)?.(args?.payload as Record<string, unknown>)
 return { engineEpoch: 'autorun-engine', result: result === undefined ? { defined: false } : { defined: true, value: result } }
})
const calls = (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation)
let host: ReturnType<typeof import('@/lib/native-desktop-host').createNativeDesktopHost>, release: () => void
let useAuto: typeof import('./use-agent-auto-start').useAgentAutoStart
let projects: typeof import('@/stores/project-store').useProjectStore, agents: typeof import('@/stores/agent-store').useAgentStore, scheduler: typeof import('@/stores/agent-scheduler-store').useAgentSchedulerStore
const legacy = window.electronAPI, toast = vi.fn()
beforeAll(async () => {
 Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
 host = (await import('@/lib/native-desktop-host')).createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => void) => { receiver = listener; return () => { receiver = undefined } }) } } as unknown as TauriDesktopApi)
 release = (await import('@/lib/desktop-api')).installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
 useAuto = (await import('./use-agent-auto-start')).useAgentAutoStart; projects = (await import('@/stores/project-store')).useProjectStore; agents = (await import('@/stores/agent-store')).useAgentStore; scheduler = (await import('@/stores/agent-scheduler-store')).useAgentSchedulerStore
})
beforeEach(async () => {
 canonical = [task({ status: TaskStatus.NotStarted, agent_id: 'agent-1' })]; handlers.clear(); invoke.mockClear(); toast.mockClear(); sequence = 0
 handlers.set('db:getTask', async p => canonical.find(t => t.id === p.id)); handlers.set('db:getSubtasks', async p => canonical.filter(t => t.parent_task_id === p.parentId))
 handlers.set('db:updateTask', async p => { const t = canonical.find(t => t.id === p.id); return t && { ...t, ...p.data as object } })
 handlers.set('agentSession:start', async () => ({ sessionId: '', queued: true, queuePosition: 1, queueReason: 'agent_limit' }))
 projects.setState({ currentProjectId: 'default' }); agents.setState({ sessions: new Map() }); scheduler.getState().disable(); await host.reconnect(); scheduler.getState().enable(); vi.useFakeTimers()
})
afterEach(() => { cleanup(); scheduler.getState().disable(); vi.clearAllTimers(); vi.useRealTimers() })
afterAll(() => { release(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy }) })
const mount = (rows = canonical, available = [agent()]) => renderHook(({ rows, available }) => useAuto({ tasks: rows, agents: available, showToast: toast }), { initialProps: { rows, available } })
const emit = (operation: string, payload: unknown) => receiver?.({ payload: { protocolVersion: 1, kind: 'event', engineEpoch: 'autorun-engine', sequence: ++sequence, operation, payload } })
const tick = async (ms = 350) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
it('keeps an actual native queued acknowledgement in Source without fabricating a local session', async () => {
 mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(1); expect(agents.getState().sessions.size).toBe(0)
 expect(calls('agentSession:start')[0][1]?.payload).toEqual({ agentId: 'agent-1', taskId: 'task-1' }); expect(calls('agentSession:startTask')).toHaveLength(0)
})
it('lets the retained Source start classify an unassigned task without a triage status or assignment prewrite', async () => {
 canonical = [task({ status: TaskStatus.NotStarted })]; mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(1); expect(calls('db:updateTask')).toHaveLength(0); expect(agents.getState().sessions.size).toBe(0)
})
it.each(['pagehide','project-return','unmount','disable'] as const)('retires native delayed AutoRun before effects on %s', async mode => {
 const view = mount();
 if(mode==='pagehide')act(() => window.dispatchEvent(new Event('pagehide')))
 if(mode==='project-return')act(() => { projects.setState({currentProjectId:'other'}); projects.setState({currentProjectId:'default'}) })
 if(mode==='unmount')view.unmount()
 if(mode==='disable')act(() => scheduler.getState().disable())
 await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})
it('stops future native requests after disable while preserving an already admitted raw start', async () => {
 const raw=held<unknown>(); handlers.set('agentSession:start',()=>raw.promise); canonical.push(task({id:'task-2',status:TaskStatus.NotStarted,agent_id:'agent-1'})); mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(1)
 act(()=>scheduler.getState().disable()); await act(async()=>raw.resolve({sessionId:'accepted-session'})); await tick(); expect(calls('agentSession:start')).toHaveLength(1); expect(agents.getState().sessions.size).toBe(0); expect(calls('agentSession:stop')).toHaveLength(0)
})
it('does not retarget a captured native default agent when it changes before the timer', async () => {
 canonical=[task({status:TaskStatus.NotStarted})]; const original=[agent()]; const view=mount(canonical,original); view.rerender({rows:canonical,available:[agent({id:'replacement-agent'})]}); await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})
it('never fabricates a parent review transition when all captured children completed', async () => {
 canonical=[task({status:TaskStatus.NotStarted,agent_id:'agent-1'}),task({id:'child-1',status:TaskStatus.Completed,parent_task_id:'task-1',agent_id:'agent-1'})]; mount(); act(() => emit('task:updated', { taskId: 'child-1', updates: { status: TaskStatus.Completed } })); await tick(); expect(calls('db:updateTask')).toHaveLength(0); expect(calls('agentSession:start')).toHaveLength(0)
})
it('fences a native subtask discovery reply after page retirement', async () => {
 const raw=held<Task[]>();handlers.set('db:getSubtasks',()=>raw.promise);mount();await tick();act(()=>window.dispatchEvent(new Event('pagehide')));await act(async()=>raw.resolve([]));await tick();expect(calls('agentSession:start')).toHaveLength(0)
})
it('does not retry the same unknown native start on metadata churn or rescan', async () => {
 handlers.set('agentSession:start',async()=>{throw { code: 'INVALID_REQUEST', message: 'private provider detail' }});const view=mount();await tick();view.rerender({rows:[{...canonical[0],title:'Renamed',updated_at:'2026-10-18T01:00:00.000Z'}],available:[agent()]});await tick(61000);expect(calls('agentSession:start')).toHaveLength(1);expect(calls('db:updateTask')).toHaveLength(0);expect(calls('agentSession:startTask')).toHaveLength(0);expect(JSON.stringify(toast.mock.calls)).not.toContain('private provider detail')
})

it('retires native AutoRun on same-epoch reconnect without replaying the old timer', async () => {
 mount(); await act(async () => { await host.reconnect() }); await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(scheduler.getState().isEnabled).toBe(false)
})
it('leaves Source as the sole session writer after a nonqueued native start receipt', async () => {
 handlers.set('agentSession:start', async () => ({ sessionId: 'actual-session' })); mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(1); expect(agents.getState().sessions.size).toBe(0); expect(calls('db:updateTask')).toHaveLength(0)
})
it('queues each original native target once across a rescan with no local session placeholder', async () => {
 const view = mount(); await tick(); view.rerender({ rows: [{ ...canonical[0], title: 'Renamed' }], available: [agent()] }); await tick(61000); expect(calls('agentSession:start')).toHaveLength(1); expect(agents.getState().sessions.size).toBe(0)
})
it('requires unchanged original native task and agent bindings across a held task read', async () => {
 const raw = held<Task>(); handlers.set('db:getTask', () => raw.promise); const view = mount(); await tick(); view.rerender({ rows: [{ ...canonical[0], agent_id: 'other-agent' }], available: [agent(), agent({ id: 'other-agent', is_default: false })] })
 act(() => scheduler.getState().disable()); await act(async () => raw.resolve(canonical[0])); await tick(); expect(calls('agentSession:start')).toHaveLength(0)
})
it('withdraws an original native target synchronously on a move away and back event', async () => {
 const raw = held<Task>(); handlers.set('db:getTask', () => raw.promise); mount(); await tick()
 act(() => { emit('task:updated', { taskId: 'task-1', updates: { project_id: 'other' } }); emit('task:updated', { taskId: 'task-1', updates: { project_id: 'default' } }) })
 await act(async () => raw.resolve(canonical[0])); await tick(); expect(calls('agentSession:start')).toHaveLength(0)
})
it('uses fresh exact family checks for the original eligible native child without starting the parent', async () => {
 canonical = [task({ status: TaskStatus.NotStarted, agent_id: 'agent-1' }), task({ id: 'child-1', status: TaskStatus.NotStarted, parent_task_id: 'task-1', agent_id: 'agent-1' }), task({ id: 'child-2', status: TaskStatus.NotStarted, parent_task_id: 'task-1', agent_id: 'agent-1', sort_order: 1 })]
 mount(); await tick(); expect(calls('agentSession:start').map(([,args]) => args?.payload)).toEqual([{ agentId: 'agent-1', taskId: 'child-1' }]); expect(calls('db:updateTask')).toHaveLength(0)
})
it('does not use a failed native child-discovery read as permission to start a parent', async () => {
 handlers.set('db:getSubtasks', async () => { throw { code: 'INVALID_REQUEST' } }); mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})
it('joins an old native receipt before an explicitly enabled replacement generation can request another target', async () => {
 const raw = held<unknown>(); let first = true; handlers.set('agentSession:start', async () => { if (first) { first = false; return raw.promise } return { sessionId: 'source-existing-session' } }); mount(); await tick()
 act(() => { scheduler.getState().disable(); scheduler.getState().enable() }); await tick(); expect(calls('agentSession:start')).toHaveLength(1)
 await act(async () => raw.resolve({ sessionId: 'source-existing-session' })); await tick(); expect(calls('agentSession:start')).toHaveLength(2); expect(agents.getState().sessions.size).toBe(0); expect(calls('agentSession:stop')).toHaveLength(0)
})
it('keeps current native queue-failure review separate from renderer retry/session removal', async () => {
 mount(); await tick(); act(() => emit('agent:startQueueChanged', { queue: [], failed: { taskId: 'task-1', error: 'private queue detail' } })); await tick(61000)
 expect(calls('agentSession:start')).toHaveLength(1); expect(agents.getState().sessions.size).toBe(0); expect(JSON.stringify(toast.mock.calls)).not.toContain('private queue detail')
})
it('treats a typed native idle heartbeat as observation rather than a task transition', async () => {
 canonical = [task({ status: TaskStatus.Completed, agent_id: 'agent-1' })]; mount(); act(() => emit('agent:status', { taskId: 'task-1', agentId: 'agent-1', sessionId: 'session-1', status: 'idle', heartbeat: true, epoch: 'source-1', seq: 1 })); await tick()
 expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:getTask')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0); expect(toast).not.toHaveBeenCalled()
})
it('bounds native intent data before any task or provider operation', async () => {
 mount(canonical, [agent({ config: { system_prompt: 'x'.repeat(270000) } })]); await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:getTask')).toHaveLength(0)
})
it.each(['captain','task_group'] as const)('keeps native %s anchors outside ordinary window AutoRun', async role => {
 canonical = [task({ role, status: TaskStatus.NotStarted, agent_id: 'agent-1' })]; mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})

it('leaves enabled heartbeat tasks with their existing Source scheduler', async () => {
 canonical = [task({ heartbeat_enabled: true, status: TaskStatus.NotStarted, agent_id: 'agent-1' })]; mount(); await tick(); expect(calls('agentSession:start')).toHaveLength(0); expect(calls('db:updateTask')).toHaveLength(0)
})

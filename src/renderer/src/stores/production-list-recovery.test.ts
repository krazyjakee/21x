import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Task } from '@/types'
import type { ProjectRecord } from '@shared/projects'
import { DEFAULT_PROJECT_ID } from '@shared/projects'
import { installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { initializeTaskDesktopState, rehydrateTaskDesktopState, useTaskStore } from './task-store'
import { initializeProjectDesktopState, rehydrateProjectDesktopState, useProjectStore } from './project-store'
import { rehydrateSettingsDesktopState, useSettingsStore } from './settings-store'
import { rehydrateProductionDesktop } from '@/lib/desktop-rehydration'
import { readProjectScopedSetting } from '@/lib/project-scoped-setting'

function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }
const project = (id = DEFAULT_PROJECT_ID, archived = false): ProjectRecord => ({ id, name: id, archived,
  description: '', default_agent_id: null, captain_agent_id: null, git_provider: null, git_org: null,
  settings: {}, sort_order: 0, created_at: '2026-10-17', updated_at: '2026-10-17' })
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, title: id, description: '', type: 'general', role: 'task', priority: 'medium', status: 'not_started', assignee: '',
  source: 'manual', project_id: DEFAULT_PROJECT_ID, created_at: '2026-10-17', updated_at: '2026-10-17',
  due_date: null, agent_id: null, external_id: null, source_id: null, session_id: null, snoozed_until: null,
  resolution: null, feedback_comment: null, recurrence_parent_id: null, last_occurrence_at: null,
  next_occurrence_at: null, heartbeat_last_check_at: null, heartbeat_next_check_at: null, parent_task_id: null,
  is_recurring: false, heartbeat_enabled: false, auto_start_agent: false, auto_complete_without_review: false,
  labels: [], attachments: [], repos: [], output_fields: [], skill_ids: null, feedback_rating: null,
  recurrence_pattern: null, heartbeat_interval_minutes: null, complete_at_source: null, next_subtask_ids: [], sort_order: 0,
  ...overrides
} as Task)

function fixture() {
  let sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>()
  const history: Array<(event: { payload: unknown }) => void> = []
  const values = new Map<string, unknown>([
    ['db:getTasks', []], ['project:getAll', [project()]], ['settings:get', DEFAULT_PROJECT_ID],
    ['settings:getAll', { github_org: 'current-org', git_provider: 'github' }],
    ['agent:getAll', []], ['commander:listSessions', []]
  ])
  const handlers = new Map<string, () => Promise<unknown>>()
  let bootstrap: (() => Promise<unknown>) | undefined
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return bootstrap ? bootstrap() : { available: true, protocolVersion: 1, engineEpoch: 'engine-1' }
    const operation = String(args?.operation)
    const nonProjectSetting = operation === 'settings:get' && (args?.payload as { key?: string })?.key !== 'current_project_id'
    const result = nonProjectSetting ? values.get(`settings:get:${(args?.payload as { key: string }).key}`) ?? null
      : handlers.has(operation) ? await handlers.get(operation)!() : values.get(operation)
    return { engineEpoch: 'engine-1', result: result === undefined ? { defined: false } : { defined: true, value: result } }
  })
  const native = { core: { invoke }, event: { listen: vi.fn(async (_name: string, receive: (event: { payload: unknown }) => void) => {
    receivers.add(receive); history.push(receive); return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi
  const host = createNativeDesktopHost(native)
  const emit = (operation: string, payload: unknown) => {
    for (const receive of [...receivers]) receive({ payload: { protocolVersion: 1, kind: 'event', engineEpoch: 'engine-1', sequence: ++sequence, operation, payload } })
  }
  return { host, values, handlers, invoke, emit, history, setBootstrap: (read: () => Promise<unknown>) => { bootstrap = read },
    calls: (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation).length }
}

let f: ReturnType<typeof fixture>
let releaseHost: () => void
let releaseTasks: () => void
let releaseProjects: () => void
const legacyBridge = window.electronAPI
beforeEach(async () => {
  initializeTaskDesktopState()(); initializeProjectDesktopState()()
  f = fixture(); releaseHost = installDesktopHost(f.host)
  await f.host.reconnect()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  releaseTasks = initializeTaskDesktopState(); releaseProjects = initializeProjectDesktopState()
  useTaskStore.setState({ tasks: [], selectedTaskId: null, error: null, isLoading: false })
  useProjectStore.setState({ projects: [], currentProjectId: DEFAULT_PROJECT_ID, isLoaded: false, error: null })
  useSettingsStore.setState({ githubOrg: null, gitProvider: null, error: null, isLoading: false })
})
afterEach(async () => {
  // Project changes also start the actual layout owners; join those read-only
  // loads before retiring the fixture's captured native connection.
  const [{ useCanvasStore }, { useDrawingStore }] = await Promise.all([import('./canvas-store'), import('./drawing-store')])
  await Promise.all([
    useCanvasStore.getState().loadCanvas(useProjectStore.getState().currentProjectId),
    useDrawingStore.getState().loadDrawings(useProjectStore.getState().currentProjectId)
  ])
  releaseTasks(); releaseProjects(); releaseHost()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacyBridge })
  initializeTaskDesktopState(); initializeProjectDesktopState()
})

it.each(['updated', 'created', 'deleted'] as const)('preserves task:%s across a pending typed snapshot without preload access', async kind => {
  const pending = held<unknown>(); f.handlers.set('db:getTasks', () => pending.promise)
  const recovery = rehydrateTaskDesktopState()
  await vi.waitFor(() => expect(f.calls('db:getTasks')).toBe(1))
  const old = task('old'), created = task('new'), updated = task('old', { priority: 'critical' as Task['priority'] })
  useTaskStore.setState({ tasks: [old], selectedTaskId: 'old' })
  const current = kind === 'created' ? [created, old] : kind === 'deleted' ? [] : [updated]
  f.values.set('db:getTasks', current); f.handlers.delete('db:getTasks')
  f.emit(`task:${kind}`, kind === 'created' ? { task: created } : kind === 'updated' ? { taskId: old.id, updates: { priority: 'critical' } } : { taskId: old.id })
  pending.resolve([old]); await recovery
  expect(useTaskStore.getState().tasks).toEqual(current)
  expect(f.calls('db:getTasks')).toBe(2)
  if (kind === 'deleted') expect(useTaskStore.getState().selectedTaskId).toBeNull()
  expect(f.host.connection.status).toBe('ready')
})

it('coalesces list reads and bounds sustained invalidation with recovery still fenced', async () => {
  f.handlers.set('db:getTasks', async () => { f.emit('tasks:refresh', {}); return [] })
  f.host.setRehydrator(rehydrateTaskDesktopState)
  const first = f.host.rehydrate()
  const second = rehydrateTaskDesktopState()
  await expect(first).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  await expect(second).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  expect(f.calls('db:getTasks')).toBe(8)
  expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.db.deleteTask('old')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.calls('db:deleteTask')).toBe(0)
})

it('refuses an old same-epoch read as soon as replacement bootstrap starts', async () => {
  const pending = held<unknown>(), boot = held<unknown>()
  f.handlers.set('db:getTasks', () => pending.promise)
  const old = rehydrateTaskDesktopState(), rejected = expect(old).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await vi.waitFor(() => expect(f.calls('db:getTasks')).toBe(1))
  f.setBootstrap(() => boot.promise)
  const reconnect = f.host.reconnect()
  pending.resolve([task('stale')]); await rejected
  expect(useTaskStore.getState().tasks).toEqual([])
  boot.resolve({ available: true, protocolVersion: 1, engineEpoch: 'engine-1' }); await reconnect
  f.handlers.delete('db:getTasks'); f.values.set('db:getTasks', [task('current')])
  await rehydrateTaskDesktopState()
  expect(useTaskStore.getState().tasks.map(row => row.id)).toEqual(['current'])
})

it('reports a fresh disconnected read without leaving a loading spinner or invoking the retired client', async () => {
  const boot = held<unknown>(); f.setBootstrap(() => boot.promise)
  const reconnect = f.host.reconnect()
  await expect(rehydrateTaskDesktopState()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(useTaskStore.getState()).toMatchObject({ isLoading: false, tasks: [] })
  expect(useTaskStore.getState().error).toBeTruthy()
  expect(f.calls('db:getTasks')).toBe(0)
  boot.resolve({ available: true, protocolVersion: 1, engineEpoch: 'engine-1' }); await reconnect
})

it('joins persisted project selection and preserves an explicit Default click without a recovery write', async () => {
  const setting = held<unknown>(); f.handlers.set('settings:get', () => setting.promise)
  f.values.set('project:getAll', [project(), project('other')])
  const first = rehydrateProjectDesktopState(), second = rehydrateProjectDesktopState()
  await vi.waitFor(() => expect(f.calls('settings:get')).toBe(1))
  useProjectStore.getState().setCurrentProject(DEFAULT_PROJECT_ID)
  setting.resolve('other'); await Promise.all([first, second])
  expect(useProjectStore.getState().currentProjectId).toBe(DEFAULT_PROJECT_ID)
  expect(useProjectStore.getState().isLoaded).toBe(true)
  expect(f.calls('settings:set')).toBe(0)
})

it('restores a saved project and refreshes an archived selection read-only during native hydration', async () => {
  f.values.set('project:getAll', [project(), project('other')]); f.values.set('settings:get', 'other')
  await rehydrateProjectDesktopState()
  expect(useProjectStore.getState().currentProjectId).toBe('other')
  f.values.set('project:getAll', [project(), project('other', true)])
  f.emit('project:changed', { projectId: 'other', kind: 'archived' })
  await rehydrateProjectDesktopState()
  expect(useProjectStore.getState().currentProjectId).toBe(DEFAULT_PROJECT_ID)
  expect(f.calls('settings:set')).toBe(0)
})

it('discards a crossed project snapshot and retains the last changed project', async () => {
  const pending = held<unknown>(); f.handlers.set('project:getAll', () => pending.promise)
  const recovery = rehydrateProjectDesktopState()
  await vi.waitFor(() => expect(f.calls('project:getAll')).toBe(1))
  f.handlers.delete('project:getAll'); f.values.set('project:getAll', [project(), project('new')])
  f.emit('project:changed', { projectId: 'new', kind: 'created' })
  pending.resolve([project()]); await recovery
  expect(useProjectStore.getState().projects.map(row => row.id)).toEqual([DEFAULT_PROJECT_ID, 'new'])
  expect(f.calls('project:getAll')).toBe(2)
})

it('keeps settings hydration in the mutation fence and retries explicitly after failure', async () => {
  f.handlers.set('settings:getAll', async () => { throw { code: 'DISCONNECTED' } })
  f.host.setRehydrator(rehydrateProductionDesktop)
  await expect(f.host.rehydrate()).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(f.host.hydrationPending).toBe(true)
  expect(useSettingsStore.getState().error).toBeTruthy()
  await expect(f.host.api.settings.set('github_org', 'mutation')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.handlers.delete('settings:getAll')
  await f.host.rehydrate()
  expect(f.host.hydrationPending).toBe(false)
  expect(useSettingsStore.getState()).toMatchObject({ githubOrg: 'current-org', gitProvider: 'github', error: null })
  expect(f.calls('settings:set')).toBe(0)
})

it('does not let a pending settings snapshot overwrite an accepted current preference', async () => {
  const pending = held<unknown>(); f.handlers.set('settings:getAll', () => pending.promise)
  const recovery = rehydrateSettingsDesktopState()
  await vi.waitFor(() => expect(f.calls('settings:getAll')).toBe(1))
  // Explicitly enable mutations for this user's write; the snapshot itself stays read-only.
  f.host.setRehydrator(async () => {}); await f.host.rehydrate()
  await useSettingsStore.getState().setGithubOrg('chosen-org')
  f.handlers.delete('settings:getAll'); f.values.set('settings:getAll', { github_org: 'chosen-org', git_provider: 'github' })
  pending.resolve({ github_org: 'old-org', git_provider: 'github' }); await recovery
  expect(useSettingsStore.getState().githubOrg).toBe('chosen-org')
  expect(f.calls('settings:set')).toBe(1)
})

it('disposes task/project callbacks and pending publications, then binds one replacement listener cohort', async () => {
  const pending = held<unknown>(); f.handlers.set('db:getTasks', () => pending.promise)
  const recovery = rehydrateTaskDesktopState(), rejected = expect(recovery).rejects.toMatchObject({ code: 'STALE_EPOCH' })
  await vi.waitFor(() => expect(f.calls('db:getTasks')).toBe(1))
  releaseTasks(); releaseProjects()
  f.emit('task:created', { task: task('retired') }); f.emit('project:changed', { projectId: 'retired', kind: 'created' })
  pending.resolve([task('retired')]); await rejected
  expect(useTaskStore.getState().tasks).toEqual([])
  expect(f.calls('project:getAll')).toBe(0)
  releaseTasks = initializeTaskDesktopState(); releaseProjects = initializeProjectDesktopState()
  f.emit('task:created', { task: task('current') })
  expect(useTaskStore.getState().tasks.map(row => row.id)).toEqual(['current'])
})

it.each(['canvas_state', 'drawing_state'])('reads legacy %s only for Default without migration writes or cleared-value resurrection', async base => {
  f.values.set(`settings:get:${base}`, '{"retained":"legacy"}')
  expect(await readProjectScopedSetting(base, DEFAULT_PROJECT_ID)).toBe('{"retained":"legacy"}')
  expect(await readProjectScopedSetting(base, 'other')).toBeNull()
  f.values.set(`settings:get:${base}:${DEFAULT_PROJECT_ID}`, '')
  expect(await readProjectScopedSetting(base, DEFAULT_PROJECT_ID)).toBe('')
  f.values.delete(`settings:get:${base}:${DEFAULT_PROJECT_ID}`)
  f.values.set(`settings:get:${base}_migrated_to_projects`, '1')
  expect(await readProjectScopedSetting(base, DEFAULT_PROJECT_ID)).toBeNull()
  expect(f.calls('settings:set')).toBe(0)
})

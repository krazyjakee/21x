import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { saveProjectDraft, emptyProjectDraft } from '@/lib/project-editor'
import { initializeProjectDesktopState, useProjectStore } from '@/stores/project-store'
import { useUIStore } from '@/stores/ui-store'
import { ProjectEditorDialog } from './ProjectEditorDialog'

vi.mock('@/components/github/RepoSelectorDialog', () => ({ RepoSelectorDialog: () => null }))
const record = (id = 'project_fixture', fields = {}) => ({ id, name: 'Synthetic project', description: '', default_agent_id: null,
  captain_agent_id: null, git_provider: null, git_org: null, settings: {}, sort_order: 0, archived: false,
  created_at: '2026-10-17', updated_at: '2026-10-17', ...fields })
const repo = (id = 'repo_fixture') => ({ id, project_id: 'project_fixture', provider: 'github', org: 'synthetic', name: 'repository', default_branch: null, sort_order: 0, created_at: '2026-10-17' })
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture() {
  let sequence = 0
  const receivers = new Set<(event: { payload: unknown }) => void>()
  const values = new Map<string, unknown>([['project:getAll', [record()]], ['settings:getAll', {}], ['agent:getAll', []],
    ['projectRepo:list', []], ['projectResource:list', []], ['project:create', record()], ['project:update', record()], ['projectRepo:add', repo()]])
  const handlers = new Map<string, () => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1' }
    const operation = String(args?.operation)
    const value = handlers.has(operation) ? await handlers.get(operation)!() : values.get(operation)
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => {
    if (name === 'desktop:event') receivers.add(receive)
    return () => { receivers.delete(receive) }
  }) } } as unknown as TauriDesktopApi)
  const release = installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
  const changed = () => { for (const receive of [...receivers]) receive({ payload: { protocolVersion: 1, kind: 'event', operation: 'project:changed',
    payload: { projectId: 'project_fixture', kind: 'updated' }, engineEpoch: 'engine-1', sequence: ++sequence } }) }
  return { host, release, values, handlers, invoke, changed, calls: (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation) }
}
let f: Awaited<ReturnType<typeof fixture>>
const legacy = window.electronAPI
const finish: Array<() => void> = []
beforeEach(async () => {
  initializeProjectDesktopState()()
  f = await fixture(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  useProjectStore.setState({ projects: [record()], currentProjectId: 'project_fixture', isLoaded: true, error: null })
  useUIStore.setState({ projectEditorTarget: null })
})
afterEach(async () => {
  cleanup(); initializeProjectDesktopState()(); f.release()
  for (const resolve of finish.splice(0)) resolve()
  await Promise.resolve()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})
const draft = () => ({ ...emptyProjectDraft(), name: 'Synthetic project', default_agent_id: 'agent_default', captain_agent_id: 'agent_captain',
  git_provider: 'gitlab', git_org: 'synthetic', settings: { limits: { max_concurrent_agents: 2, daily_session_cap: 7, paused: true }, captain_wakeups: { enabled: false, kinds: [] }, scheduled_review: { enabled: false, cron: '0 9 * * *' } } })

it.each([null, 'project_fixture'])('sends full retained editor fields through the actual final production codec for %s', async id => {
  await saveProjectDraft(id, draft())
  const operation = id ? 'project:update' : 'project:create'
  expect(f.calls(operation)).toHaveLength(1)
  expect(f.calls(operation)[0][1]).toMatchObject({ payload: { ...(id ? { id } : {}), data: {
    name: 'Synthetic project', default_agent_id: 'agent_default', captain_agent_id: 'agent_captain', git_provider: 'gitlab', git_org: 'synthetic', settings: draft().settings
  } } })
  expect(f.calls('agentSession:start')).toHaveLength(0)
})

it.each([{ limits: { max_concurrent_agents: 0 } }, { scheduled_review: { enabled: true, cron: 'not a cron' } }, { api_keys: { synthetic: 'forbidden' } }])('refuses invalid configuration before any native invocation', async settings => {
  await expect(saveProjectDraft(null, { ...draft(), settings })).rejects.toThrow()
  expect(f.calls('project:create')).toHaveLength(0)
})

it('joins sequential repository writes and stops after connection replacement without replay', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(repo()))
  f.handlers.set('projectRepo:add', () => pending.promise)
  const saving = saveProjectDraft(null, { ...draft(), repos: [1, 2].map(i => ({ key: `draft-${i}`, provider: 'github', org: 'synthetic', name: `repository${i}`, default_branch: '' })) })
  void saving.catch(() => {})
  await waitFor(() => expect(f.calls('projectRepo:add')).toHaveLength(1))
  await f.host.reconnect(); pending.resolve(repo())
  await expect(saving).rejects.toThrow()
  expect(f.calls('project:create')).toHaveLength(1); expect(f.calls('projectRepo:add')).toHaveLength(1)
  expect(f.calls('projectRepo:reorder')).toHaveLength(0)
})

it('retains the accepted project identity before refusing a retired view and performs no child write', async () => {
  const accepted = vi.fn(); let current = true
  const pending = held<unknown>(); finish.push(() => pending.resolve(record()))
  f.handlers.set('project:create', () => pending.promise)
  const saving = saveProjectDraft(null, { ...draft(), repos: [{ key: 'r', provider: 'github', org: 'synthetic', name: 'repository', default_branch: '' }] }, undefined,
    { assertCurrent: () => { if (!current) throw new Error('Retired') }, onProjectAccepted: accepted })
  void saving.catch(() => {})
  await waitFor(() => expect(f.calls('project:create')).toHaveLength(1)); current = false; pending.resolve(record())
  await expect(saving).rejects.toThrow('Retired')
  expect(accepted).toHaveBeenCalledWith(record()); expect(f.calls('projectRepo:add')).toHaveLength(0)
})

it('keeps an open draft when its canonical project event arrives', async () => {
  useUIStore.getState().openProjectEditor('project_fixture'); render(<ProjectEditorDialog />)
  const name = await screen.findByLabelText('Name')
  fireEvent.change(name, { target: { value: 'Unsaved draft' } })
  await act(async () => { f.changed(); await Promise.resolve() })
  expect(screen.getByLabelText('Name')).toHaveValue('Unsaved draft')
  expect(f.calls('projectRepo:list')).toHaveLength(1)
})

it('blocks a duplicate create after partial failure and explicitly reopens the accepted saved project', async () => {
  f.handlers.set('projectRepo:add', async () => { throw new Error('private-profile-canary') })
  useUIStore.getState().openProjectEditor('new'); render(<ProjectEditorDialog />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Synthetic project' } })
  fireEvent.change(screen.getByLabelText('Add a repo by hand'), { target: { value: 'synthetic/repository' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
  expect(document.body.textContent).not.toContain('canary')
  expect(f.calls('project:create')).toHaveLength(1); expect(f.calls('projectRepo:add')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Reopen saved project' }))
  await screen.findByRole('button', { name: 'Save' })
  expect(useUIStore.getState().projectEditorTarget).toBe('project_fixture')
  expect(f.calls('project:create')).toHaveLength(1)
})

it('does not close or unlock a replacement editor after an old held save settles', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(record()))
  f.handlers.set('project:create', () => pending.promise)
  useUIStore.getState().openProjectEditor('new'); render(<ProjectEditorDialog />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'First intent' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create without repos' }))
  await waitFor(() => expect(f.calls('project:create')).toHaveLength(1))
  expect(screen.getByLabelText('Name')).toBeDisabled()
  act(() => { useUIStore.getState().closeProjectEditor(); useUIStore.getState().openProjectEditor('new') })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Replacement intent' } })
  await act(async () => { pending.resolve(record()); await pending.promise })
  expect(useUIStore.getState().projectEditorTarget).toBe('new')
  expect(screen.getByLabelText('Name')).toHaveValue('Replacement intent')
  expect(screen.getByRole('button', { name: 'Create without repos' })).toBeEnabled()
  expect(f.calls('project:create')).toHaveLength(1)
})


it('saves actual editor limits and agent fields through the typed full configuration mapping', async () => {
  useUIStore.getState().openProjectEditor('project_fixture'); render(<ProjectEditorDialog />)
  await screen.findByLabelText('Name')
  fireEvent.change(screen.getByLabelText('Max concurrent agents'), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText('Agent sessions per day'), { target: { value: '8' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Pause project' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(f.calls('project:update')).toHaveLength(1))
  expect(f.calls('project:update')[0][1]).toMatchObject({ payload: { id: 'project_fixture', data: { settings: { limits: { max_concurrent_agents: 3, daily_session_cap: 8, paused: true } } } } })
  await waitFor(() => expect(useUIStore.getState().projectEditorTarget).toBeNull())
})

it('retires a held initial editor read at pagehide without publishing an old draft', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve([]))
  f.handlers.set('projectRepo:list', () => pending.promise)
  useUIStore.getState().openProjectEditor('project_fixture'); render(<ProjectEditorDialog />)
  await waitFor(() => expect(f.calls('projectRepo:list')).toHaveLength(1))
  act(() => { window.dispatchEvent(new Event('pagehide')) })
  await act(async () => { pending.resolve([]); await pending.promise })
  expect(screen.queryByLabelText('Name')).toBeNull()
  expect(f.calls('project:update')).toHaveLength(0)
})


it('does not publish a late accepted project write into a replacement connection cache', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(record('old_project')))
  f.handlers.set('project:create', () => pending.promise)
  const saving = useProjectStore.getState().createProject({ name: 'Old create' })
  await waitFor(() => expect(f.calls('project:create')).toHaveLength(1))
  await f.host.reconnect()
  useProjectStore.setState({ projects: [record('replacement_project')], error: null })
  pending.resolve(record('old_project')); await saving
  expect(useProjectStore.getState().projects.map(p => p.id)).toEqual(['replacement_project'])
  expect(useProjectStore.getState().error).toBeNull()
})

it('keeps an uncertain create fenced and never supplies a guessed saved project ID', async () => {
  f.handlers.set('project:create', async () => { throw new Error('unknown-commit-canary') })
  useUIStore.getState().openProjectEditor('new'); render(<ProjectEditorDialog />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Uncertain intent' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create without repos' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Create without repos' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Reopen saved project' })).toBeNull()
  expect(f.calls('project:create')).toHaveLength(1)
  expect(document.body.textContent).not.toContain('canary')
})


it('refuses an absent child receipt instead of claiming the project save completed', async () => {
  f.values.set('projectRepo:add', undefined)
  const accepted = vi.fn()
  await expect(saveProjectDraft(null, { ...draft(), repos: [{ key: 'r', provider: 'github', org: 'synthetic', name: 'repository', default_branch: '' }] }, undefined,
    { onProjectAccepted: accepted })).rejects.toThrow()
  expect(accepted).toHaveBeenCalledWith(record())
  expect(f.calls('project:create')).toHaveLength(1); expect(f.calls('projectRepo:add')).toHaveLength(1)
  expect(f.calls('projectResource:add')).toHaveLength(0)
})


it('refuses an absent updated repository receipt rather than reporting a completed edit', async () => {
  const previous = repo()
  await expect(saveProjectDraft('project_fixture', { ...draft(), repos: [{ key: previous.id, id: previous.id, provider: previous.provider,
    org: previous.org, name: 'edited', default_branch: '' }] }, { repos: [previous], resources: [] })).rejects.toThrow()
  expect(f.calls('projectRepo:update')).toHaveLength(1)
  expect(f.calls('projectResource:add')).toHaveLength(0)
})

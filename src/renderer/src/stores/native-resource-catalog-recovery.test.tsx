import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installDesktopHost } from '@/lib/desktop-api'
import { createNativeDesktopHost } from '@/lib/native-desktop-host'
import type { TauriDesktopApi } from '@/lib/tauri-desktop-transport'
import { rehydrateMcpDesktopState, retireMcpDesktopState, useMcpStore } from './mcp-store'
import { rehydrateTaskSourceDesktopState, retireTaskSourceDesktopState, useTaskSourceStore } from './task-source-store'
import { useProjectStore } from './project-store'
import { ToolsMcpSettings } from '@/components/settings/tabs/ToolsMcpSettings'
import { MCP_SECRET_SET_MARKER } from '@shared/mcp-codecs'
import { TASK_SOURCE_KEY_SET_MARKER } from '@shared/task-source-codecs'
import type { McpServer, TaskSource } from '@/types'

vi.mock('@/components/settings/GlobalCliMcpSection', () => ({ GlobalCliMcpSection: () => null }))
const mcp = (id = 'mcp_fixture', fields: Partial<McpServer> = {}) => ({ id, name: 'Synthetic MCP', type: 'local' as const, command: 'synthetic-unavailable-executable', args: [], url: '',
  headers: { Authorization: MCP_SECRET_SET_MARKER }, environment: {}, tools: [], oauth_metadata: {} as McpServer['oauth_metadata'], source: 'user', created_at: '2026-10-17', updated_at: '2026-10-17', ...fields })
const source = (id = 'source_fixture', fields: Partial<TaskSource> = {}) => ({ id, mcp_server_id: 'mcp_fixture', name: 'Synthetic source', plugin_id: 'notion', config: { api_token: TASK_SOURCE_KEY_SET_MARKER },
  list_tool: '', list_tool_args: {}, update_tool: '', update_tool_args: {}, last_synced_at: null, enabled: true, project_id: 'project_fixture', created_at: '2026-10-17', updated_at: '2026-10-17', ...fields })
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve } }
async function fixture() {
  const values = new Map<string, unknown>([['mcp:getAll', []], ['taskSource:getAll', []], ['db:getTasks', []], ['mcp:getOAuthStatus', { connected: false }], ['mcp:testConnection', { status: 'connected', toolCount: 1, tools: [{ name: 'fixture_tool', description: '' }] }]])
  const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<unknown>>()
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'engine_status') return { available: true, protocolVersion: 1, engineEpoch: 'engine-1', uiLeaseId: 'document-1' }
    const operation = String(args?.operation)
    const value = handlers.has(operation) ? await handlers.get(operation)!(args) : values.get(operation)
    return { engineEpoch: 'engine-1', result: value === undefined ? { defined: false } : { defined: true, value } }
  })
  const host = createNativeDesktopHost({ core: { invoke }, event: { listen: vi.fn(async () => vi.fn()) } } as unknown as TauriDesktopApi)
  const release = installDesktopHost(host); host.setRehydrator(async () => {}); await host.reconnect()
  return { host, release, invoke, values, handlers, calls: (operation: string) => invoke.mock.calls.filter(([, args]) => args?.operation === operation) }
}
let f: Awaited<ReturnType<typeof fixture>>
const legacy = window.electronAPI
const finish: Array<() => void> = []
beforeEach(async () => {
  retireMcpDesktopState(); retireTaskSourceDesktopState()
  f = await fixture(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
  useMcpStore.setState({ servers: [], isLoading: false, error: null, oauthStatuses: {}, authRequired: {} })
  useTaskSourceStore.setState({ sources: [], isLoading: false, error: null, syncingIds: new Set(), lastSyncResults: new Map() })
  useProjectStore.setState({ currentProjectId: 'project_fixture' })
})
afterEach(async () => {
  cleanup(); retireMcpDesktopState(); retireTaskSourceDesktopState(); f.release()
  for (const resolve of finish.splice(0)) resolve()
  await Promise.resolve()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: legacy })
})
const fetch = (domain: 'mcp' | 'source') => domain === 'mcp' ? useMcpStore.getState().fetchServers() : useTaskSourceStore.getState().fetchSources()
const recover = (domain: 'mcp' | 'source') => domain === 'mcp' ? rehydrateMcpDesktopState() : rehydrateTaskSourceDesktopState()
const rows = (domain: 'mcp' | 'source') => domain === 'mcp' ? useMcpStore.getState().servers : useTaskSourceStore.getState().sources
const op = (domain: 'mcp' | 'source', name: string) => `${domain === 'mcp' ? 'mcp' : 'taskSource'}:${name}`
const row = (domain: 'mcp' | 'source', name = 'Synthetic') => domain === 'mcp' ? mcp('mcp_fixture', { name }) : source('source_fixture', { name })
async function mutate(domain: 'mcp' | 'source', method: 'create' | 'update' | 'delete') {
  if (domain === 'mcp') {
    if (method === 'create') return useMcpStore.getState().createServer({ name: 'Synthetic' })
    if (method === 'update') return useMcpStore.getState().updateServer('mcp_fixture', { name: 'Accepted' })
    return useMcpStore.getState().deleteServer('mcp_fixture')
  }
  if (method === 'create') return useTaskSourceStore.getState().createSource({ name: 'Synthetic', mcp_server_id: null, plugin_id: 'notion' })
  if (method === 'update') return useTaskSourceStore.getState().updateSource('source_fixture', { name: 'Accepted' })
  return useTaskSourceStore.getState().deleteSource('source_fixture')
}

it('recovers unused catalogs without RPC, sync, auth or a process probe', async () => {
  await Promise.all([rehydrateMcpDesktopState(), rehydrateTaskSourceDesktopState()])
  expect(f.invoke.mock.calls.map(([name]) => name)).toEqual(['engine_status'])
})

it.each((['mcp', 'source'] as const).flatMap(domain => (['create', 'update', 'delete'] as const).map(method => ({ domain, method }))))('preserves accepted $domain $method against a held list without replay', async ({ domain, method }) => {
  const pending = held<unknown>(); finish.push(() => pending.resolve([])); f.handlers.set(op(domain, 'getAll'), () => pending.promise)
  const loading = fetch(domain)
  await waitFor(() => expect(f.calls(op(domain, 'getAll'))).toHaveLength(1))
  f.values.set(op(domain, method), method === 'delete' ? true : row(domain, 'Accepted'))
  await mutate(domain, method)
  const current = method === 'delete' ? [] : [row(domain, 'Accepted')]
  f.handlers.delete(op(domain, 'getAll')); f.values.set(op(domain, 'getAll'), current)
  pending.resolve([row(domain, 'Old')]); await loading
  expect(rows(domain)).toEqual(current); expect(f.calls(op(domain, method))).toHaveLength(1)
  expect(f.calls(op(domain, 'getAll'))).toHaveLength(2)
})

it.each(['mcp', 'source'] as const)('deduplicates $0 canonical read preceding create receipt and marks first accepted write as demanded', async domain => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(row(domain)))
  f.handlers.set(op(domain, 'create'), () => pending.promise)
  const saving = mutate(domain, 'create')
  await waitFor(() => expect(f.calls(op(domain, 'create'))).toHaveLength(1))
  f.values.set(op(domain, 'getAll'), [row(domain)]); await fetch(domain)
  pending.resolve(row(domain)); await saving; await recover(domain)
  expect(rows(domain)).toEqual([row(domain)]); expect(f.calls(op(domain, 'create'))).toHaveLength(1)
})

it('joins both demanded catalogs behind the mutation barrier using only two retained reads', async () => {
  await Promise.all([fetch('mcp'), fetch('source')])
  const a = held<unknown>(), b = held<unknown>(); finish.push(() => a.resolve([]), () => b.resolve([]))
  f.handlers.set('mcp:getAll', () => a.promise); f.handlers.set('taskSource:getAll', () => b.promise)
  f.host.setRehydrator(async () => { await Promise.all([rehydrateMcpDesktopState(), rehydrateTaskSourceDesktopState()]) })
  const loading = f.host.reconnect(); void loading.catch(() => {})
  await waitFor(() => expect(f.calls('taskSource:getAll')).toHaveLength(2))
  await expect(f.host.api.db.deleteTask('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  a.resolve([]); await Promise.resolve(); expect(f.host.hydrationPending).toBe(true)
  b.resolve([]); await loading
  expect(f.host.hydrationPending).toBe(false)
  expect(f.invoke.mock.calls.every(([name, args]) => name === 'engine_status' || ['mcp:getAll', 'taskSource:getAll'].includes(String(args?.operation)))).toBe(true)
})

it.each(['mcp', 'source'] as const)('keeps $0 failure fenced until explicit successful read recovery', async domain => {
  await fetch(domain); f.handlers.set(op(domain, 'getAll'), async () => { throw new Error('private-canary') })
  f.host.setRehydrator(() => recover(domain))
  await expect(f.host.rehydrate()).rejects.toThrow(); expect(f.host.hydrationPending).toBe(true)
  await expect(f.host.api.db.deleteTask('task_fixture')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  f.handlers.delete(op(domain, 'getAll')); await f.host.rehydrate()
  expect(f.host.hydrationPending).toBe(false); expect(f.calls('db:deleteTask')).toHaveLength(0)
})

it.each(['mcp', 'source'] as const)('bounds repeated $0 invalidation at eight readbacks', async domain => {
  await fetch(domain)
  f.handlers.set(op(domain, 'getAll'), async () => { void fetch(domain); return [] })
  f.host.setRehydrator(() => recover(domain))
  await expect(f.host.rehydrate()).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  expect(f.calls(op(domain, 'getAll'))).toHaveLength(9)
  expect(f.host.hydrationPending).toBe(true)
})

it.each(['mcp', 'source'] as const)('retires held $0 writes/readers on pagehide without late publication', async domain => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(row(domain)))
  f.handlers.set(op(domain, 'update'), () => pending.promise)
  const saving = mutate(domain, 'update')
  await waitFor(() => expect(f.calls(op(domain, 'update'))).toHaveLength(1))
  act(() => { window.dispatchEvent(new Event('pagehide')) })
  if (domain === 'mcp') useMcpStore.setState({ servers: [mcp('replacement')] })
  else useTaskSourceStore.setState({ sources: [source('replacement')] })
  pending.resolve(row(domain)); await saving
  expect(rows(domain).map(item => item.id)).toEqual(['replacement'])
  expect(f.calls(op(domain, 'update'))).toHaveLength(1)
})

it('joins one explicit sync and canonical Source timestamp without duplicate remote work', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve({ source_id: 'source_fixture', imported: 1, updated: 0, errors: [] }))
  f.handlers.set('taskSource:sync', () => pending.promise)
  f.values.set('taskSource:getAll', [source('source_fixture', { last_synced_at: '2026-10-17T12:00:00Z' })])
  const a = useTaskSourceStore.getState().syncSource('source_fixture'), b = useTaskSourceStore.getState().syncSource('source_fixture')
  await waitFor(() => expect(f.calls('taskSource:sync')).toHaveLength(1))
  pending.resolve({ source_id: 'source_fixture', imported: 1, updated: 0, errors: [] }); await Promise.all([a, b])
  expect(f.calls('taskSource:sync')).toHaveLength(1); expect(f.calls('db:getTasks')).toHaveLength(1)
  expect(useTaskSourceStore.getState().sources[0].last_synced_at).toBe('2026-10-17T12:00:00Z')
  expect(useTaskSourceStore.getState().syncingIds.size).toBe(0)
})

it('serializes explicit sync-all and withdraws remaining starts when project selection changes', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve({ source_id: 'first', imported: 0, updated: 0, errors: [] }))
  useTaskSourceStore.setState({ sources: [source('first'), source('second')] })
  f.handlers.set('taskSource:sync', () => pending.promise)
  const syncing = useTaskSourceStore.getState().syncAllEnabled()
  await waitFor(() => expect(f.calls('taskSource:sync')).toHaveLength(1))
  useProjectStore.setState({ currentProjectId: 'other_project' })
  pending.resolve({ source_id: 'first', imported: 0, updated: 0, errors: [] }); await syncing
  expect(f.calls('taskSource:sync')).toHaveLength(1)
})

it('rejects a mismatched sync identity before any canonical task or metadata read', async () => {
  f.values.set('taskSource:sync', { source_id: 'foreign_source', imported: 1, updated: 0, errors: [] })
  expect(await useTaskSourceStore.getState().syncSource('source_fixture')).toBeNull()
  expect(f.calls('db:getTasks')).toHaveLength(0); expect(f.calls('taskSource:getAll')).toHaveLength(0)
  expect(useTaskSourceStore.getState().lastSyncResults.size).toBe(0)
})

it('does not run sync readbacks or replay after connection replacement', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve({ source_id: 'source_fixture', imported: 1, updated: 0, errors: [] }))
  f.handlers.set('taskSource:sync', () => pending.promise)
  const syncing = useTaskSourceStore.getState().syncSource('source_fixture')
  await waitFor(() => expect(f.calls('taskSource:sync')).toHaveLength(1))
  await f.host.reconnect(); pending.resolve({ source_id: 'source_fixture', imported: 1, updated: 0, errors: [] }); await syncing
  expect(f.calls('db:getTasks')).toHaveLength(0); expect(f.calls('taskSource:getAll')).toHaveLength(0)
  expect(f.calls('taskSource:sync')).toHaveLength(1)
  expect(useTaskSourceStore.getState().syncingIds.size).toBe(0)
})

it('does not publish old MCP tool probes after accepted configuration changes', async () => {
  useMcpStore.setState({ servers: [mcp()] })
  const pending = held<unknown>(); finish.push(() => pending.resolve({ status: 'connected', tools: [{ name: 'old_tool', description: '' }] }))
  f.handlers.set('mcp:testConnection', () => pending.promise)
  const testing = useMcpStore.getState().testConnection({ id: 'mcp_fixture', name: 'Synthetic', command: 'synthetic' })
  await waitFor(() => expect(f.calls('mcp:testConnection')).toHaveLength(1))
  f.values.set('mcp:update', mcp('mcp_fixture', { command: 'new_synthetic' }))
  await useMcpStore.getState().updateServer('mcp_fixture', { command: 'new_synthetic' })
  pending.resolve({ status: 'connected', tools: [{ name: 'old_tool', description: '' }] }); await testing
  expect(useMcpStore.getState().servers[0].tools).toEqual([])
})

it('reads OAuth metadata sequentially and stops continuation after retirement without fabricating disconnected status', async () => {
  const remote = mcp('first', { type: 'remote', url: 'https://example.invalid/mcp' })
  // Exact public registration metadata, not a credential or browser lease.
  const metadata = { resource_url: 'https://example.invalid/mcp', authorization_server_url: '', authorization_endpoint: '', token_endpoint: '', registration_endpoint: '', revocation_endpoint: '', scopes: '', code_challenge_methods_supported: [], client_id: '', client_secret: '', registration_method: 'manual' as const, discovered_at: '' }
  useMcpStore.setState({ servers: [{ ...remote, oauth_metadata: metadata }, { ...remote, id: 'second', oauth_metadata: metadata }] })
  const pending = held<unknown>(); finish.push(() => pending.resolve({ connected: true }))
  f.handlers.set('mcp:getOAuthStatus', () => pending.promise)
  const reading = useMcpStore.getState().fetchAllOAuthStatuses()
  await waitFor(() => expect(f.calls('mcp:getOAuthStatus')).toHaveLength(1))
  retireMcpDesktopState(); pending.resolve({ connected: true }); await reading
  expect(f.calls('mcp:getOAuthStatus')).toHaveLength(1); expect(useMcpStore.getState().oauthStatuses).toEqual({})
})

it('mounts/reloads native MCP settings with metadata only and tests a connection only from its explicit control', async () => {
  f.values.set('mcp:getAll', [mcp()]); render(<ToolsMcpSettings />)
  await screen.findByText('Synthetic MCP')
  expect(f.calls('mcp:testConnection')).toHaveLength(0); expect(f.calls('mcp:probeForAuth')).toHaveLength(0)
  f.host.setRehydrator(rehydrateMcpDesktopState); await act(async () => { await f.host.reconnect() })
  expect(f.calls('mcp:testConnection')).toHaveLength(0); expect(f.calls('mcp:probeForAuth')).toHaveLength(0)
  fireEvent.click(screen.getByTitle('Test connection'))
  await screen.findByText('Connected')
  expect(f.calls('mcp:testConnection')).toHaveLength(1)
  await act(async () => { await f.host.reconnect() })
  expect(screen.queryByText('Connected')).toBeNull()
  expect(f.calls('mcp:testConnection')).toHaveLength(1)
})

it('keeps native remote form browser sign-in unavailable and URL changes free of probe/OAuth side effects', async () => {
  f.values.set('mcp:getAll', [mcp('mcp_fixture', { type: 'remote', url: 'https://example.invalid/mcp' })])
  render(<ToolsMcpSettings />); await screen.findByText('Synthetic MCP')
  fireEvent.click(screen.getByTitle('Edit'))
  await screen.findByText('Browser sign-in is unavailable in this preview.')
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://other.invalid/mcp' } })
  await act(async () => { await new Promise(done => setTimeout(done, 850)) })
  expect(f.calls('mcp:probeForAuth')).toHaveLength(0); expect(f.calls('mcp:startOAuthFlow')).toHaveLength(0)
})


it.each(['mcp', 'source'] as const)('recovers $0 metadata first populated by accepted create without another mutation', async domain => {
  f.values.set(op(domain, 'create'), row(domain)); f.values.set(op(domain, 'getAll'), [row(domain)])
  await mutate(domain, 'create'); await recover(domain)
  expect(f.calls(op(domain, 'create'))).toHaveLength(1); expect(f.calls(op(domain, 'getAll'))).toHaveLength(1)
})

it('retires a queued sync before its first RPC and releases admission for a later explicit request', async () => {
  f.values.set('taskSource:sync', { source_id: 'source_fixture', imported: 0, updated: 0, errors: [] })
  const retired = useTaskSourceStore.getState().syncSource('source_fixture')
  retireTaskSourceDesktopState(); await retired
  expect(f.calls('taskSource:sync')).toHaveLength(0)
  await useTaskSourceStore.getState().syncSource('source_fixture')
  expect(f.calls('taskSource:sync')).toHaveLength(1)
})


it('refuses a held UI success after masked credential rotation with the same public row and timestamp', async () => {
  f.values.set('mcp:getAll', [mcp()]); render(<ToolsMcpSettings />); await screen.findByText('Synthetic MCP')
  const pending = held<unknown>(); finish.push(() => pending.resolve({ status: 'connected', tools: [] }))
  f.handlers.set('mcp:testConnection', () => pending.promise)
  fireEvent.click(screen.getByTitle('Test connection'))
  await waitFor(() => expect(f.calls('mcp:testConnection')).toHaveLength(1))
  f.values.set('mcp:update', mcp())
  await act(async () => { await useMcpStore.getState().updateServer('mcp_fixture', { headers: { Authorization: 'synthetic-not-a-credential' } }) })
  await act(async () => { pending.resolve({ status: 'connected', tools: [] }); await pending.promise })
  expect(screen.queryByText('Connected')).toBeNull()
  expect(screen.getByTitle('Test connection')).toBeEnabled()
  expect(f.calls('mcp:testConnection')).toHaveLength(1)
  expect(useMcpStore.getState().servers[0].headers.Authorization).toBe(MCP_SECRET_SET_MARKER)
})


async function newMcpDraft(name = 'Draft MCP') {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add Server' })[0])
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'synthetic-unavailable-executable' } })
}

it('keeps an MCP draft frozen until its exact accepted save receipt', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(mcp()))
  f.handlers.set('mcp:create', () => pending.promise)
  render(<ToolsMcpSettings />); await screen.findByText('No MCP servers configured yet')
  await newMcpDraft(); fireEvent.click(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!)
  await waitFor(() => expect(f.calls('mcp:create')).toHaveLength(1))
  expect(screen.getByLabelText('Name')).toHaveValue('Draft MCP')
  expect(screen.getByLabelText('Name')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
  await act(async () => { pending.resolve(mcp()); await pending.promise })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.calls('mcp:create')).toHaveLength(1)
})

it('retains an uncertain MCP draft and refuses duplicate save until explicit review', async () => {
  f.handlers.set('mcp:create', async () => { throw new Error('private-native-error') })
  render(<ToolsMcpSettings />); await screen.findByText('No MCP servers configured yet')
  await newMcpDraft(); fireEvent.click(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!)
  await screen.findByText('Save could not be confirmed. Close this draft and review the server list before saving again.')
  expect(screen.getByLabelText('Name')).toHaveValue('Draft MCP')
  expect(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!).toBeDisabled()
  expect(screen.queryByText('private-native-error')).toBeNull()
  fireEvent.submit(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!.closest('form')!)
  expect(f.calls('mcp:create')).toHaveLength(1)
})

it('does not close a replacement MCP draft when an earlier raw create settles', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(mcp()))
  f.handlers.set('mcp:create', () => pending.promise)
  render(<ToolsMcpSettings />); await screen.findByText('No MCP servers configured yet')
  await newMcpDraft('First draft'); fireEvent.click(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!)
  await waitFor(() => expect(f.calls('mcp:create')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await newMcpDraft('Replacement draft')
  await act(async () => { pending.resolve(mcp()); await pending.promise })
  expect(screen.getByLabelText('Name')).toHaveValue('Replacement draft')
  expect(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!).toBeEnabled()
  expect(f.calls('mcp:create')).toHaveLength(1)
})

it('requires explicit review after a connection change during MCP save without replay', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(mcp()))
  f.handlers.set('mcp:create', () => pending.promise)
  render(<ToolsMcpSettings />); await screen.findByText('No MCP servers configured yet')
  await newMcpDraft(); fireEvent.click(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!)
  await waitFor(() => expect(f.calls('mcp:create')).toHaveLength(1))
  await act(async () => { await f.host.reconnect() })
  await act(async () => { pending.resolve(mcp()); await pending.promise })
  await screen.findByText('Save could not be confirmed. Close this draft and review the server list before saving again.')
  expect(screen.getByLabelText('Name')).toHaveValue('Draft MCP')
  expect(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!).toBeDisabled()
  expect(f.calls('mcp:create')).toHaveLength(1)
})


it('keeps an existing MCP edit draft across canonical refresh and closes only on its own receipt', async () => {
  f.values.set('mcp:getAll', [mcp()])
  const pending = held<unknown>(); finish.push(() => pending.resolve(mcp('mcp_fixture', { name: 'Accepted draft' })))
  f.handlers.set('mcp:update', () => pending.promise)
  render(<ToolsMcpSettings />); await screen.findByText('Synthetic MCP')
  fireEvent.click(screen.getByTitle('Edit'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Accepted draft' } })
  f.values.set('mcp:getAll', [mcp('mcp_fixture', { name: 'Canonical concurrent name' })])
  await act(async () => { await useMcpStore.getState().fetchServers() })
  expect(screen.getByLabelText('Name')).toHaveValue('Accepted draft')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!)
  await waitFor(() => expect(f.calls('mcp:update')).toHaveLength(1))
  expect(screen.getByLabelText('Name')).toBeDisabled()
  await act(async () => { pending.resolve(mcp('mcp_fixture', { name: 'Accepted draft' })); await pending.promise })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.calls('mcp:update')).toHaveLength(1)
})

it('retains a missing update receipt as an uncertain edit without automatic create or retry', async () => {
  f.values.set('mcp:getAll', [mcp()]); f.values.set('mcp:update', null)
  render(<ToolsMcpSettings />); await screen.findByText('Synthetic MCP')
  fireEvent.click(screen.getByTitle('Edit'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unconfirmed edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Save could not be confirmed. Close this draft and review the server list before saving again.')
  expect(screen.getByLabelText('Name')).toHaveValue('Unconfirmed edit')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(f.calls('mcp:update')).toHaveLength(1); expect(f.calls('mcp:create')).toHaveLength(0)
})

it('retires the MCP form on pagehide without a late save close or auth followup', async () => {
  const pending = held<unknown>(); finish.push(() => pending.resolve(mcp()))
  f.handlers.set('mcp:create', () => pending.promise)
  render(<ToolsMcpSettings />); await screen.findByText('No MCP servers configured yet')
  await newMcpDraft(); fireEvent.click(screen.getByRole('dialog').querySelector<HTMLButtonElement>('button[type=submit]')!)
  await waitFor(() => expect(f.calls('mcp:create')).toHaveLength(1))
  act(() => { window.dispatchEvent(new Event('pagehide')) })
  await act(async () => { pending.resolve(mcp()); await pending.promise })
  expect(screen.getByLabelText('Name')).toHaveValue('Draft MCP')
  expect(f.calls('mcp:create')).toHaveLength(1); expect(f.calls('mcp:probeForAuth')).toHaveLength(0)
  expect(f.calls('mcp:startOAuthFlow')).toHaveLength(0)
})

it.each(['create', 'update', 'delete'] as const)('clears a prior MCP failure only after an accepted current %s receipt', async method => {
  useMcpStore.setState({ servers: [mcp()], error: 'Old failure' })
  f.values.set('mcp:' + method, method === 'delete' ? true : mcp())
  await mutate('mcp', method)
  expect(useMcpStore.getState().error).toBeNull()
})

import { open } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SQLite from 'better-sqlite3'
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync, symlinkSync, statfsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProductionOwner, ProductionOwnerBootstrap, ProductionServices } from './production-owner'
import type { CodingAgentAdapter } from '../main/adapters/coding-agent-adapter'
import type { ChatProvider, ChatProviderEvent } from '../main/chat/providers/types'
import type { ProtectedApplicationKeyStore } from '../main/platform/authenticated-secret-storage'
import { makeTask } from '../../test/helpers/task-fixtures'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, statfsSync: vi.fn(fs.statfsSync), mkdirSync: vi.fn(fs.mkdirSync) }
})

function held<T = void>() {
  let finish!: (value: T) => void
  const promise = new Promise<T>(resolve => { finish = resolve })
  return { promise, finish }
}

const roots: string[] = []
const owners: ProductionOwner[] = []
const finishers: Array<() => void> = []
let ownerModule: typeof import('./production-owner')
beforeEach(async () => {
  vi.resetModules()
  // Load the complete SDK/service graph before timing the lifecycle scenario.
  // A timed-out cold import must not leave a late fixture outside afterEach.
  ownerModule = await import('./production-owner')
})
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish()
  for (const owner of owners.splice(0)) await owner.close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(options: { prepare?: ProductionOwnerBootstrap['native']['prepareRuntime']; drain?: ProductionOwnerBootstrap['native']['drainOwnedProcesses']; provider?: ChatProvider } = {}) {
  const root = mkdtempSync(join(tmpdir(), '21x-production-owner-'))
  roots.push(root)
  const resourceRoot = join(root, 'resources'); mkdirSync(resourceRoot)
  const profileRoot = join(root, 'profile')
  const keys = new Map<string, Buffer>()
  const store: ProtectedApplicationKeyStore = {
    create: vi.fn(async (id, key) => { if (keys.has(id)) throw new Error('exists'); keys.set(id, Buffer.from(key)) }),
    load: vi.fn(async id => { const key = keys.get(id); if (!key) throw new Error('missing'); return Buffer.from(key) })
  }
  const adapter = {
    initialize: vi.fn(async () => {}), createSession: vi.fn(async () => 'controlled-native-session'), resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ type: 'busy' })), pollMessages: vi.fn(async () => []),
    abortPrompt: vi.fn(async () => {}), destroySession: vi.fn(async () => {}), checkHealth: vi.fn(async () => ({ available: true }))
  }
  const emit = vi.fn()
  const bootstrap: ProductionOwnerBootstrap = {
    profileId: 'synthetic-profile', paths: { profileRoot, resourceRoot, workspaceRoot: join(root, 'workspaces'),
      attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), tempRoot: join(root, 'temp') },
    credentials: { store, mode: 'create' }, managedTaskMcp: { disabled: true }, connectors: { kind: 'disabled', reason: 'Fixture has no connector resource bundle' },
    native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'enabled' },
      prepareRuntime: options.prepare ?? (async () => {}), openExternal: vi.fn(async () => {}), notify: vi.fn(), emit,
      sendUiCommand: () => ({ ok: false, detail: 'No fixture window' }), drainOwnedProcesses: options.drain ?? (async () => ({ acknowledged: true })) }
  }
  const { ProductionOwner } = ownerModule
  const provider: ChatProvider = options.provider ?? { id: 'fixture', model: 'fixture', async *stream(): AsyncGenerator<ChatProviderEvent> { yield { type: 'message_end', stopReason: 'end_turn' } } }
  const boundaries = { cliMcp: { homeDir: root, environment: {} }, createAdapter: () => adapter as unknown as CodingAgentAdapter, createProvider: () => provider }
  const owner = new ProductionOwner(bootstrap, boundaries); owners.push(owner)
  return { owner, bootstrap, boundaries, store, root, adapter, emit, ProductionOwner }
}

async function startTask(services: ProductionServices) {
  const agent = services.db.getAgents()[0]
  services.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 1 } })
  const task = services.db.createTask(makeTask())!
  services.db.updateTask(task.id, { agent_id: agent.id })
  const result = await services.agents.requestSession(agent.id, task.id)
  return { task, agent, result }
}

describe('actual production application owner', () => {
  it('refuses a missing managed CLI executable before key or application database access', async () => {
    const f = await fixture()
    f.bootstrap.managedTaskMcp = { command: join(f.root, 'missing-node'), args: [join(f.root, 'missing-task-mcp.mjs')], environment: {}, tools: [] }
    await expect(f.owner.start()).rejects.toThrow('MANAGED_MCP_RESOURCE_UNAVAILABLE')
    expect(f.owner.recoveryState()).toEqual({ phase: 'failed', stage: 'resources', code: 'MANAGED_MCP_RESOURCE_UNAVAILABLE', owned: false })
    expect(f.store.create).not.toHaveBeenCalled(); expect(f.adapter.initialize).not.toHaveBeenCalled()
  })

  it('projects a CLI readiness refusal to fixed guidance without reflecting its internal code', async () => {
    const f = await fixture({ prepare: async () => { throw Object.assign(new Error('private CLI canary'), { code: 'AGENT_CLI_PRIVATE_CANARY' }) } })
    await expect(f.owner.start()).rejects.toThrow('AGENT_CLI_PRIVATE_CANARY')
    expect(f.owner.recoveryState()).toEqual({ phase: 'failed', stage: 'native-readiness', code: 'AGENT_CLI_UNAVAILABLE', owned: false })
    expect(JSON.stringify(f.owner.recoveryState())).not.toContain('CANARY')
    expect(f.store.create).not.toHaveBeenCalled()
  })
  it.each(['ENOSPC', 'EDQUOT'])('preserves a useful %s recovery state even before profile lock creation', async code => {
    const f = await fixture()
    vi.mocked(mkdirSync).mockImplementationOnce(() => { throw Object.assign(new Error('private filesystem canary'), { code }) })
    await expect(f.owner.start()).rejects.toThrow('PROFILE_LOW_DISK')
    expect(f.owner.recoveryState()).toEqual({ phase: 'failed', stage: 'profile-lock', code: 'PROFILE_LOW_DISK', owned: false })
    expect(f.store.create).not.toHaveBeenCalled(); expect(f.adapter.initialize).not.toHaveBeenCalled()
  })
  it('refuses low filesystem capacity before native/credential/database initialization with finite recovery metadata', async () => {
    const f = await fixture()
    vi.mocked(statfsSync).mockReturnValueOnce({ ...statfsSync(f.root), bavail: 0 } as ReturnType<typeof statfsSync>)
    await expect(f.owner.start()).rejects.toThrow('PROFILE_LOW_DISK')
    expect(f.owner.recoveryState()).toEqual({ phase: 'failed', stage: 'resources', code: 'PROFILE_LOW_DISK', owned: false })
    expect(f.store.create).not.toHaveBeenCalled(); expect(f.adapter.initialize).not.toHaveBeenCalled()
  })

  it('classifies actual locked SQLite without migrating or changing its rows and allows a later explicit launch', async () => {
    const f = await fixture(), first = await f.owner.start()
    const task = first.db.createTask({ title: 'Preserve busy profile' })!
    await f.owner.close()
    const raw = new SQLite(join(f.bootstrap.paths.profileRoot, '21x.db'))
    raw.pragma('journal_mode = DELETE'); raw.exec('BEGIN EXCLUSIVE')
    const next = new f.ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, f.boundaries)
    owners.push(next)
    try {
      await expect(next.start()).rejects.toThrow('PROFILE_DATABASE_LOCKED')
      expect(next.recoveryState()).toEqual({ phase: 'failed', stage: 'database-preflight', code: 'PROFILE_DATABASE_LOCKED', owned: false })
      expect(raw.prepare('SELECT title FROM tasks WHERE id=?').get(task.id)).toEqual({ title: 'Preserve busy profile' })
    } finally { raw.exec('ROLLBACK'); raw.close() }
    const retry = new f.ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, f.boundaries)
    owners.push(retry)
    expect((await retry.start()).db.getTask(task.id)?.title).toBe('Preserve busy profile')
  })
  it('retains the actual profile while a task attachment descriptor refuses close, then retries cleanup', async () => {
    const f = await fixture(); await f.owner.close()
    const { TaskAttachmentFileOwner } = await import('../main/task-attachment-file-owner')
    const { acquireProfileLock } = await import('../main/platform/profile-lock')
    let refuseClose = true
    finishers.push(() => { refuseClose = false })
    const owner = new f.ProductionOwner(f.bootstrap, { ...f.boundaries, taskAttachmentFiles: options => new TaskAttachmentFileOwner({ ...options, fs: { open: async (path, flags, mode) => {
      const fd = await open(path, flags, mode)
      return { stat: () => fd.stat({ bigint: true }), read: (b,o,l,p) => fd.read(b,o,l,p), write: (b,o,l,p) => fd.write(b,o,l,p), sync: () => fd.sync(), close: async () => { if (refuseClose) throw new Error('Controlled close refusal'); await fd.close() } }
    } } }) }); owners.push(owner)
    const services = await owner.start(), task = services.db.createTask({ title: 'Retain real attachment descriptor' })!
    const attachment = { id: '00000000-0000-4000-8000-000000000001', filename: 'proof.png', size: 12, mime_type: 'image/png', added_at: '2026-10-14T00:00:00.000Z' }
    await expect(services.taskAttachmentFiles.write(task.id, attachment, Buffer.from('iVBORw0KGgoAAAAA', 'base64'), { beforeEffect() {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSE_FAILED' })
    await expect(owner.close()).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(owner.snapshot()).toMatchObject({ phase: 'blocked', owned: true })
    expect(() => acquireProfileLock(f.bootstrap.paths.profileRoot)).toThrow('PROFILE_DUPLICATE_OWNER')
    refuseClose = false; await owner.close()
    expect(owner.snapshot()).toMatchObject({ phase: 'stopped', owned: false })
    const lock = acquireProfileLock(f.bootstrap.paths.profileRoot); lock.release()
  })

  it('starts the real background stack once without a window and preserves admission across attachment loss', async () => {
    const f = await fixture()
    const startup = f.owner.start()
    expect(f.owner.start()).toBe(startup)
    const services = await startup
    expect(f.owner.snapshot()).toMatchObject({ phase: 'ready', owned: true, capabilities: { connectors: 'disabled', managedTaskMcp: 'disabled' } })
    const automationStart = vi.spyOn(services.automation, 'start')
    expect(await f.owner.start()).toBe(services)
    expect(automationStart).not.toHaveBeenCalled()
    expect(services.registry.list().map(plugin => plugin.id)).toEqual(expect.arrayContaining(['linear', 'github-issues', 'notion']))
    const api = await import('../main/task-api-server-core')
    expect(api.getTaskApiPort()).toEqual(expect.any(Number))
    const { agent, result } = await startTask(services)
    if (result.status !== 'started') throw new Error('Fixture task was unexpectedly queued')
    expect(result.sessionId).toBe('controlled-native-session')
    const second = services.db.createTask(makeTask({ title: 'Waits for real admission' }))!
    services.db.updateTask(second.id, { agent_id: agent.id })
    const queued = await services.agents.requestSession(agent.id, second.id)
    expect(queued).toMatchObject({ status: 'queued' })
    expect(services.agents.getStartQueue().some(row => row.taskId === second.id)).toBe(true)
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(f.emit.mock.calls.some(([channel]) => channel === 'agent:status')).toBe(true)
    await f.owner.close()
    expect(services.db.db.open).toBe(false)
    expect(f.owner.snapshot()).toMatchObject({ phase: 'stopped', owned: false })
  })

  it('reserves process globals before deferred native readiness and retains the profile on late initialization', async () => {
    const prepare = held()
    finishers.push(() => prepare.finish())
    const f = await fixture({ prepare: () => prepare.promise })
    const startup = expect(f.owner.start()).rejects.toThrow('OWNER_CLOSING')
    await vi.waitFor(() => expect(f.owner.snapshot().stage).toBe('native-readiness'))
    const second = new f.ProductionOwner(f.bootstrap, f.boundaries)
    await expect(second.start()).rejects.toThrow('SERVICE_DUPLICATE_OWNER')
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(f.owner.snapshot()).toMatchObject({ phase: 'blocked', owned: true })
    const { acquireProfileLock } = await import('../main/platform/profile-lock')
    expect(() => acquireProfileLock(f.bootstrap.paths.profileRoot)).toThrow('PROFILE_DUPLICATE_OWNER')
    expect(f.store.create).not.toHaveBeenCalled()
    prepare.finish()
    await startup
    await f.owner.close()
    expect(f.adapter.createSession).not.toHaveBeenCalled()
  })

  it('owns a protected key load that completes after cancellation and never opens the application database', async () => {
    const gate = held<Buffer>()
    finishers.push(() => gate.finish(Buffer.alloc(32, 8)))
    const f = await fixture()
    vi.mocked(f.store.load).mockImplementation(() => gate.promise)
    const startup = expect(f.owner.start()).rejects.toThrow('OWNER_CLOSING')
    await vi.waitFor(() => expect(f.store.load).toHaveBeenCalledOnce())
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(f.owner.snapshot()).toMatchObject({ owned: true, stage: 'credentials' })
    gate.finish(Buffer.alloc(32, 8))
    await startup
    await f.owner.close()
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(f.bootstrap.paths.profileRoot, '21x.db'))).toBe(false)
    expect(f.owner.snapshot().owned).toBe(false)
    expect(f.adapter.initialize).not.toHaveBeenCalled()
  })

  it('retains raw request writes and native drain acknowledgement after deadlines, releasing only on retry', async () => {
    const request = held(), entered = held(), native = held<{ acknowledged: true }>()
    finishers.push(() => request.finish(), () => native.finish({ acknowledged: true }))
    const f = await fixture({ drain: () => native.promise })
    const services = await f.owner.start()
    const task = services.db.createTask(makeTask())!
    const work = f.owner.run(async ({ db }) => { entered.finish(); await request.promise; db.updateTask(task.id, { title: 'Raw effect joined' }) })
    await entered.promise
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(services.db.db.open).toBe(true)
    request.finish(); await work
    native.finish({ acknowledged: true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(services.db.db.open).toBe(true)
    expect(services.db.getTask(task.id)?.title).toBe('Raw effect joined')
    const { getSecretStorage } = await import('../main/platform/secret-storage')
    expect(getSecretStorage().isEncryptionAvailable()).toBe(true)
    await f.owner.close()
    expect(() => getSecretStorage()).toThrow('Secret storage must be configured')
    expect(services.db.db.open).toBe(false)
  })

  it('drains registered request backends with the actual borrowed database lease and fences late registration', async () => {
    const gate = held(), entered = held()
    finishers.push(() => gate.finish())
    const f = await fixture()
    const services = await f.owner.start()
    const lease = f.owner.getDatabaseBindingLease()
    expect(lease.runtime.paths.profileRoot).toBe(lease.lock.profileRoot)
    const task = services.db.createTask(makeTask())!
    const work = (async () => { entered.finish(); await gate.promise; lease.lock.assertHeld(); services.db.updateTask(task.id, { title: 'Bound backend joined' }) })()
    const stop = vi.fn()
    f.owner.retainCleanup('actual-request-backend', stop, () => work)
    await entered.promise
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(stop).toHaveBeenCalledOnce()
    lease.lock.assertHeld()
    expect(() => f.owner.getDatabaseBindingLease()).toThrow('OWNER_NOT_READY')
    expect(() => f.owner.retainCleanup('late', vi.fn(), async () => {})).toThrow('OWNER_NOT_READY')
    gate.finish(); await work
    expect(services.db.getTask(task.id)?.title).toBe('Bound backend joined')
    await f.owner.close()
    expect(stop).toHaveBeenCalledOnce()
    expect(() => lease.lock.assertHeld()).toThrow('SERVICE_OWNER_LOST')
  })

  it('retains a failed real-manager adapter destroy until acknowledged cleanup, without replaying its prompt', async () => {
    const f = await fixture()
    const services = await f.owner.start()
    await startTask(services)
    f.adapter.destroySession.mockRejectedValue(new Error('controlled cleanup refusal'))
    await expect(f.owner.close()).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(services.db.db.open).toBe(true)
    expect(f.owner.snapshot()).toMatchObject({ phase: 'blocked', owned: true })
    f.adapter.destroySession.mockResolvedValue(undefined)
    await f.owner.close()
    expect(f.adapter.createSession).toHaveBeenCalledOnce()
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(services.db.db.open).toBe(false)
  })

  it('joins an actual Commander iterator ignoring abort and writes nothing after database release', async () => {
    const gate = held(), entered = held()
    finishers.push(() => gate.finish())
    const provider: ChatProvider = { id: 'fixture', model: 'fixture', async *stream(): AsyncGenerator<ChatProviderEvent> {
      yield { type: 'text_delta', text: 'persisted partial' }; entered.finish(); await gate.promise
    } }
    const f = await fixture({ provider })
    const services = await f.owner.start()
    const session = services.commanderStore.createSession()
    const turn = services.commander.sendUserMessage(session.id, 'fixture')
    await entered.promise
    await expect(f.owner.close(5)).rejects.toThrow('OWNER_DRAIN_BLOCKED')
    expect(services.db.db.open).toBe(true)
    gate.finish(); await turn.done
    await f.owner.close()
    const prepare = vi.spyOn(services.db.db, 'prepare')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(prepare).not.toHaveBeenCalled()
    const raw = new SQLite(join(f.bootstrap.paths.profileRoot, '21x.db'), { readonly: true })
    try { expect((raw.prepare('SELECT content FROM commander_messages WHERE session_id = ?').all(session.id) as Array<{ content: string }>).map(row => row.content)).toContain('persisted partial') }
    finally { raw.close() }
  })

  it('reopens authenticated credentials and reconciles accepted deliveries without another external send', async () => {
    const f = await fixture()
    const services = await f.owner.start()
    services.db.setSetting('openai_api_key', 'synthetic-api-key')
    const agent = services.db.createAgent({ name: 'Protected reopen', config: { api_keys: { openai: 'synthetic-agent-key' } } })!
    const mcp = services.db.createMcpServer({ name: 'Protected reopen MCP', headers: { Authorization: 'Bearer synthetic-mcp-key' }, environment: { CONTROLLED_TOKEN: 'synthetic-env' } })!
    const task = services.db.createTask(makeTask())!
    const { DeliveryStore } = await import('../main/sessions/delivery-store')
    const deliveries = new DeliveryStore(services.db)
    const { record } = deliveries.enqueue({ idempotencyKey: 'accepted-fixture', kind: 'agent_message', taskId: task.id, payload: 'accepted intent' })
    deliveries.claim(record.id, 'previous-launch', 60_000)
    deliveries.accept(record.id, 'previous-launch', 'accepted-native')
    await f.owner.close()
    const next = new f.ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, f.boundaries)
    owners.push(next)
    const reopened = await next.start()
    expect(reopened.db.getSetting('openai_api_key')).toBe('synthetic-api-key')
    expect(reopened.db.getAgent(agent.id)?.config.api_keys?.openai).toBe('synthetic-agent-key')
    expect(reopened.db.getMcpServer(mcp.id)).toMatchObject({ headers: { Authorization: 'Bearer synthetic-mcp-key' }, environment: { CONTROLLED_TOKEN: 'synthetic-env' } })
    expect(['accepted', 'acknowledged']).toContain(new DeliveryStore(reopened.db).getByKey('accepted-fixture')?.state)
    expect(f.adapter.createSession).not.toHaveBeenCalled()
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    await next.close()
  })

  it.each(['agent', 'mcp-header', 'mcp-environment', 'mcp-client-secret', 'task-source'])('rejects a plaintext %s credential before profile migration and preserves its bytes', async kind => {
    const f = await fixture(), services = await f.owner.start()
    const agent = services.db.createAgent({ name: 'Legacy plaintext' })!
    const mcp = services.db.createMcpServer({ name: 'Legacy MCP' })!
    const source = services.db.createTaskSource({ name: 'Legacy source', plugin_id: 'notion', mcp_server_id: null })!
    await f.owner.close()
    const path = join(f.bootstrap.paths.profileRoot, '21x.db'), raw = new SQLite(path)
    if (kind === 'agent') raw.prepare('UPDATE agents SET config=? WHERE id=?').run(JSON.stringify({ api_keys: { openai: 'synthetic-legacy-credential' } }), agent.id)
    else if (kind === 'task-source') raw.prepare('UPDATE task_sources SET config=? WHERE id=?').run(JSON.stringify({ api_token: 'synthetic-legacy-credential' }), source.id)
    else {
      const column = kind === 'mcp-header' ? 'headers' : kind === 'mcp-environment' ? 'environment' : 'oauth_metadata'
      raw.prepare(`UPDATE mcp_servers SET ${column}=? WHERE id=?`).run(JSON.stringify(kind === 'mcp-client-secret' ? { client_secret: 'synthetic-legacy-credential' } : { TOKEN: 'synthetic-legacy-credential' }), mcp.id)
    }
    raw.close(); const before = readFileSync(path)
    const next = new f.ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, f.boundaries)
    owners.push(next)
    await expect(next.start()).rejects.toThrow('PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE')
    expect(readFileSync(path)).toEqual(before); expect(f.store.create).toHaveBeenCalledOnce()
    expect(next.snapshot().owned).toBe(false)
  })

  it('reports unavailable store and incompatible credential profiles without creating replacement credentials', async () => {
    const f = await fixture()
    await f.owner.start(); await f.owner.close()
    const raw = new SQLite(join(f.bootstrap.paths.profileRoot, '21x.db'))
    raw.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('openai_api_key','safeStorage:v1:legacy-ciphertext')").run()
    raw.close()
    const next = new f.ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, f.boundaries)
    owners.push(next)
    await expect(next.start()).rejects.toThrow('PROFILE_CREDENTIAL_FORMAT_INCOMPATIBLE')
    expect(f.store.create).toHaveBeenCalledOnce()
    const unavailable = new f.ProductionOwner({ ...f.bootstrap, credentials: { mode: 'load', store: { create: vi.fn(), load: async () => { throw new Error('fixture secret must not leak') } } } }, f.boundaries)
    owners.push(unavailable)
    await expect(unavailable.start()).rejects.toThrow('SECRET_STORE_UNAVAILABLE')
    expect(unavailable.snapshot()).toMatchObject({ phase: 'failed', owned: false, code: 'SECRET_STORE_UNAVAILABLE' })
  })

  it.each(['hardlink', ...(process.platform === 'win32' ? [] : ['symlink'])])('rejects a %s database before opening or migrating another file outside its profile lease', async kind => {
    const f = await fixture(); await f.owner.start(); await f.owner.close()
    const database = join(f.bootstrap.paths.profileRoot, '21x.db'), outside = join(f.root, 'outside.db')
    renameSync(database, outside)
    if (kind === 'hardlink') linkSync(outside, database)
    else symlinkSync(outside, database)
    const before = readFileSync(outside)
    const next = new f.ProductionOwner({ ...f.bootstrap, credentials: { ...f.bootstrap.credentials, mode: 'load' } }, f.boundaries)
    owners.push(next)
    await expect(next.start()).rejects.toThrow('PROFILE_LOCK_INVALID')
    expect(readFileSync(outside)).toEqual(before)
    expect(next.snapshot().owned).toBe(false)
    expect(f.store.create).toHaveBeenCalledOnce()
  })
  it('rejects missing resources and an already-owned profile before credential or database mutation', async () => {
    const f = await fixture()
    const { acquireProfileLock } = await import('../main/platform/profile-lock')
    const lock = acquireProfileLock(f.bootstrap.paths.profileRoot)
    try { await expect(f.owner.start()).rejects.toThrow('PROFILE_DUPLICATE_OWNER') }
    finally { lock.release() }
    expect(f.store.create).not.toHaveBeenCalled()
    const missing = new f.ProductionOwner({ ...f.bootstrap, paths: { ...f.bootstrap.paths, resourceRoot: join(f.root, 'missing-resource') } }, f.boundaries)
    owners.push(missing)
    await expect(missing.start()).rejects.toThrow('RESOURCE_UNAVAILABLE')
    expect(f.store.create).not.toHaveBeenCalled()
  })

  it('rejects a corrupt copied profile read-only and keeps its source bytes for recovery', async () => {
    const f = await fixture()
    mkdirSync(f.bootstrap.paths.profileRoot)
    const databaseFile = join(f.bootstrap.paths.profileRoot, '21x.db')
    const bytes = Buffer.from('synthetic corrupt database')
    writeFileSync(databaseFile, bytes)
    await f.store.create(f.bootstrap.profileId, Buffer.alloc(32, 9))
    f.bootstrap.credentials.mode = 'load'
    await expect(f.owner.start()).rejects.toThrow('PROFILE_DATABASE_CORRUPT')
    expect(readFileSync(databaseFile)).toEqual(bytes)
    expect(f.adapter.initialize).not.toHaveBeenCalled()
    expect(f.owner.snapshot()).toMatchObject({ phase: 'failed', owned: false })
  })

})

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { TunnelManagerCore } from '../main/tunnel-manager-core'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as sourceModule from './production-service'
import {
  PRODUCTION_COMMAND_CODECS,
  validateProductionEventWire,
  type ProductionDesktopBindingOptions
} from './production-desktop-bindings'
import { isBootstrapResult, isRecord, type JsonValue } from '../shared/service-protocol'
import type { ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { ServicePeer, type OperationSchema } from './transport/peer'
import type { CodingAgentAdapter } from '../main/adapters/coding-agent-adapter'
import { PiAdapter } from '../main/adapters/pi-adapter'
import type { ChatProvider } from '../main/chat/providers/types'
import { isOptionalResult } from '../shared/host-services'
import { type DomainObservations } from './production-domain-reconciliation'

const cleanups: Array<() => Promise<void>> = []
const releases: Array<()=>void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Owned fixture cleanup failed')
})
let stagedModule: typeof sourceModule | undefined
const cases = ['source', ...(process.env.TAURI_PRODUCTION_SERVICE_ENTRY ? ['staged'] : [])]
const observations = new Map<string, DomainObservations>()
async function fixture(kind: string, controlledProvider?: ChatProvider, reuse?: { root: string; keys: Map<string, Buffer> }, makeTunnel?: (root: string) => Promise<TunnelManagerCore>) {
  const observed = observations.get(kind) ?? { commands: new Map(), events: new Map() }
  observations.set(kind, observed)
  vi.resetModules()
  const module =
    kind === 'staged'
      ? stagedModule!
      : await import('./production-service')
  const root = reuse?.root ?? mkdtempSync(join(tmpdir(), '21x-mobile-production-'))
  const descriptor: ProductionLaunchDescriptor = {
    version: 1,
    kind: 'production-private-launch',
    launchId: 'mobile_ownership_launch',
    profileId: 'mobile-ownership-profile',
    profileIntent: reuse ? 'load-authenticated-copy' : 'create-new',
    buildIdentity: 'production-mobile-fixture',
    resourceManifestSha256: 'a'.repeat(64),
    paths: {
      resourceRoot: join(root, 'resources'),
      profileRoot: join(root, 'profile'),
      workspaceRoot: join(root, 'workspaces'),
      attachmentRoot: join(root, 'attachments'),
      reposRoot: join(root, 'repos'),
      tempRoot: join(root, 'temp')
    },
    capabilities: {
      externalUrls: 'unsupported',
      notifications: 'unsupported',
      energy: 'unsupported',
      ui: 'unsupported',
      voice: 'unsupported',
      configuredMcp: 'disabled',
      managedTaskMcp: 'disabled',
      connectors: 'disabled'
    }
  }
  mkdirSync(descriptor.paths.resourceRoot, { recursive: true })
  const dist = join(descriptor.paths.resourceRoot, 'mobile'); mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, 'index.html'), '<main>Isolated mobile SPA</main>')
  const tunnel = await makeTunnel?.(root)
  let allowed = true, createProject = true, globalSkillRead = true,
    writes = true,
    adapterChoice: CodingAgentAdapter | undefined
  const blockedProjects = new Set<string>(), blockedAgents = new Set<string>(), blockedProjectReads = new Set<string>(), blockedSessions = new Set<string>(), blockedTaskWrites = new Set<string>(), blockedSources = new Set<string>(), blockedBackendUrls = new Set<string>()
  const check = () => allowed
  const authority: ProductionDesktopBindingOptions['authority'] = {
    isTrustedDesktop: check,
    canAccessTask: (id, _caller, access) => allowed && (access === 'read' || writes && !blockedTaskWrites.has(id)),
    canAccessProject: (id, _caller, access) => allowed && !blockedProjects.has(id) && (access === 'read' ? !blockedProjectReads.has(id) : writes),
    canAccessAgent: (id, _caller, access) => allowed && !blockedAgents.has(id) && (access === 'read' || writes),
    canAccessSource: id => allowed && !blockedSources.has(id),
    canAccessSession: id => allowed && !blockedSessions.has(id),
    canAccessGlobalCommander: check,
    canManageGlobalConfiguration: check,
    canQueryBackend: (_backend, url) => allowed && (url === undefined || !blockedBackendUrls.has(url)),
    canCreateProject: () => allowed && createProject,
    canEditSettings: check,
    canAccessGlobalSkills: (_caller, access) => allowed && (access !== 'read' || globalSkillRead),
    canChangeSkillScope: check,
    canReorderProjects: check,
    canReadSetting: check,
    canWriteSetting: check,
    canAccessSecret: check,
    canCreateSecret: check,
    canUseSecretEnvironment: check,
    canReadEnvironment: check,
    canAccessTerminal: check,
    canAccessMcpServer: check,
    canAccessCli: check,
    canUseTransport: check,
    canUseEnvironmentName: check,
    canAccessConnector: check,
    canUseSourcePlugin: check,
    canCreateInstance: check,
    canUsePiece: check,
    canBorrowSourceCredentials: check,
    canResolveUnsavedConfig: check,
    canManageMobile: check,
    canAccessMobileSession: check,
    canAccessMarketplace: check,
    canCreateMarketplace: check,
    canAccessPluginName: check,
    canAccessPlugin: check,
    canUseMarketplaceSource: check,
    canUsePluginAddress: check,
    canUsePluginSource: check,
    canAccessSkill: check,
    canCreateGlobalSkill: check,
    canCreateAgent: check,
    canCreateMcpServer: check,
    resolveTerminalDirectory: () => null
  }
  let session = 0
  const adapter = {
    initialize: vi.fn(async () => {}),
    createSession: vi.fn(async () => `synthetic_session_${++session}`),
    resumeSession: vi.fn(async () => []),
    sendPrompt: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ type: 'busy' })),
    pollMessages: vi.fn(async () => []),
    abortPrompt: vi.fn(async () => {}),
    destroySession: vi.fn(async (_sessionId: string) => {}),
    checkHealth: vi.fn(async () => ({ available: true })),
    notifyConfigChanged: vi.fn(async () => {}),
    getProviders: vi.fn(async () => ({ providers: [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'model_one', name: 'Model one' }] }], default: {} })),
    listModels: vi.fn(async () => [{ id: 'model_one', name: 'Model one' }])
  }
  const keys = reuse?.keys ?? new Map<string, Buffer>(),
    events: Array<{ operation: string; payload: JsonValue }> = [], ownerEventFailures: Array<{ operation: string; fields: string[] }> = []
  let eventHook: ((event: { operation: string; payload: JsonValue }) => void) | undefined
  const schemas: Record<string, OperationSchema> = Object.fromEntries(
    Object.entries(PRODUCTION_COMMAND_CODECS).map(([operation, codec]) => [
      operation,
      {
        validatePayload: (value: unknown) => {
          try {
            return codec.validateArguments(codec.decodeArguments(value as JsonValue))
          } catch {
            return false
          }
        },
        validateResult: codec.validateWireResult
      }
    ])
  )
  schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  for (const operation of ['voice:startTurn', 'voice:confirm', 'voice:dismiss'])
    schemas[operation] = { validatePayload: isRecord, validateResult: isRecord }
  const deliver = (peer: ServicePeer, bytes: Uint8Array) => {
    for (let n = 0; n < bytes.length; n += 53) peer.receive(bytes.subarray(n, n + 53))
  }
  const host = new ServicePeer({
    role: 'host',
    engineEpoch: null,
    operations: schemas,
    eventSchemas: Object.fromEntries(
      Object.keys((await import('./production-desktop-bindings')).PRODUCTION_EVENT_CODECS).map((operation) => [
        operation,
        (value: unknown) => validateProductionEventWire(operation, value)
      ])
    ),
    write: async (bytes) => deliver(service.peer, bytes),
    onEvent: (event) => {
      events.push({ operation: event.operation, payload: event.payload })
      observed.events.set(event.operation, (observed.events.get(event.operation) ?? 0) + 1)
      eventHook?.({ operation: event.operation, payload: event.payload })
    }
  })
  const provider: ChatProvider = {
    id: 'synthetic',
    model: 'synthetic',
    async *stream() {
      yield { type: 'message_end', stopReason: 'end_turn' }
    }
  }
  const service: sourceModule.ProductionService = new module.ProductionService(
    module.sealProductionServiceHost({
      descriptor,
      authority,
      caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' },
      unbridgedOwnerEvent: () => {},
      boundaries: {
        ...(tunnel ? { mobileTunnel: tunnel } : {}),
        cliMcp: { homeDir: root, environment: {} },
        createAdapter: () => adapterChoice ?? (adapter as unknown as CodingAgentAdapter),
        createProvider: () => controlledProvider ?? provider
      },
      constructBootstrap: (callbacks) => ({
        mobile: { distRoot: dist, port: 0 },
        profileId: descriptor.profileId,
        paths: descriptor.paths,
        credentials: {
          mode: reuse ? 'load' : 'create',
          store: {
            create: async (id, key) => { keys.set(id, Buffer.from(key)) },
            load: async (id) => { const key=keys.get(id); if(!key)throw new Error('Synthetic key absent'); return Buffer.from(key) }
          }
        },
        managedTaskMcp: { disabled: true },
        connectors: { kind: 'disabled', reason: 'Synthetic actions need no connectors' },
        native: {
          agents: {
            renderer: { kind: 'unsupported' },
            notifications: { kind: 'unsupported' },
            energy: { kind: 'unsupported' },
            configuredMcp: 'disabled'
          },
          prepareRuntime: async () => {},
          drainOwnedProcesses: async () => ({ acknowledged: true }),
          openExternal: async () => {},
          notify: () => {},
          emit: (operation, payload) => { try { callbacks.emitOwnerEvent(operation, payload) } catch (error) { ownerEventFailures.push({ operation, fields: isRecord(payload) && isRecord(payload.updates) ? Object.keys(payload.updates) : [] }); throw error } },
          sendUiCommand: () => ({ ok: false, detail: 'No native voice availability' })
        }
      })
    }),
    { write: async (bytes) => deliver(host, bytes) }
  )
  cleanups.push(async () => {
    await service.close()
    host.disconnect()
    await host.waitForHandlers()
    if (!reuse) rmSync(root, { recursive: true, force: true })
  })
  await host.request('engine.ping', {})
  await host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
  const actual = service.getReadyServices()!,
    db = actual.db,
    manager = actual.agents,
    project = db.getProjects()[0]
  db.updateProject(project.id, { settings: { ...project.settings, captain_wakeups: { enabled: false } } })
  const caller = {
    principal: 'trusted-desktop-main' as const,
    engineEpoch: service.owner.snapshot().epoch,
    webviewId: 'main',
    origin: 'tauri://localhost',
    uiLeaseId: 'synthetic_document'
  }
  const task = (title: string, assigned = true) => {
    const agent = db.getAgents()[0]
    db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 1 } })
    const row=db.createTask({ title, project_id: project.id })!
    if(assigned)db.updateTask(row.id,{agent_id:agent.id})
    return db.getTask(row.id)!
  }
  const bindings = Reflect.get(service, 'bindings') as import('./production-desktop-bindings').ProductionDesktopBindings
  const command = async (operation: string, args: unknown[], signal?: AbortSignal) => {
    const codec = PRODUCTION_COMMAND_CODECS[operation as keyof typeof PRODUCTION_COMMAND_CODECS]
    const payload = codec.encodeArguments(args as never)
    const counter = observed.commands.get(operation) ?? { attempted: 0, succeeded: 0 }; observed.commands.set(operation, counter); counter.attempted++
    const result = await host.request(operation, payload, { signal })
    if (!isOptionalResult(result)) throw new Error('Invalid synthetic peer result')
    const decoded = codec.decodeResult(result.defined ? result.value : undefined); counter.succeeded++
    return decoded as unknown
  }
  return {
    command, bindings, blockedBackendUrls, blockedProjects, blockedProjectReads, blockedAgents, blockedSessions, blockedTaskWrites, blockedSources, onEvent: (hook: typeof eventHook) => { eventHook = hook }, denyGlobalSkillRead: () => { globalSkillRead = false }, denyCreate: () => { createProject = false },
    root, keys,
    db,
    manager,
    services: actual,
    project,
    caller,
    host,
    events,
    ownerEventFailures,
    adapter,
    task,
    service,
    authority,
    allow: () => { allowed = true },
    deny: () => {
      allowed = false
    },
    denyWrites: () => {
      writes = false
    },
    useAdapter: (value: CodingAgentAdapter) => {
      adapterChoice = value
    }
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); releases.push(() => resolve()); return { promise, resolve } }

async function savedFile(f: Awaited<ReturnType<typeof fixture>>, taskId: string, text = 'protected mobile fixture') {
  const bytes = Buffer.from(text), file = { id: randomUUID(), filename: 'mobile-owned.txt', size: bytes.length, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00.000Z' }
  const receipt = await f.services.taskAttachmentFiles.write(taskId, file, bytes, { beforeEffect() {}, signal: new AbortController().signal })
  f.db.updateTask(taskId, { attachments: [file] }); f.services.taskAttachmentFiles.commit(receipt)
  return { bytes, file, path: join(f.root, 'attachments', taskId, `${file.id}-${file.filename}`), workspace: f.db.getWorkspaceDir(taskId) }
}

function holdSavedFile(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred(), held = deferred(), files = f.services.taskAttachmentFiles, original = files.readForExecution.bind(files)
  const read: typeof files.readForExecution = (id, file, controls, consume) => original(id, file, controls, async reader => {
    entered.resolve(); await held.promise; return consume(reader)
  })
  vi.spyOn(files, 'readForExecution').mockImplementation(read)
  return { entered, held }
}

async function post(base: string, path: string, value: unknown, token?: string) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) })
}
async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  await f.command('mobile:setAccess', [{ enabled: true }])
  const info = await f.command('mobile:getInfo', []) as { url: string; port: number }
  return `http://127.0.0.1:${info.port}`
}
async function pair(f: Awaited<ReturnType<typeof fixture>>, base: string) {
  const info = await f.command('mobile:getInfo', []) as { url: string }
  const init = await post(base, '/api/auth/pair/initiate', { code: new URL(info.url).searchParams.get('code') })
  expect(init.status).toBe(200)
  const { pairCodeId } = await init.json() as { pairCodeId: string }
  const pending = await f.command('mobile:getPendingPin', []) as { pairCodeId: string; pin: string }
  expect(pending.pairCodeId).toBe(pairCodeId)
  const response = await post(base, '/api/auth/pair/verify', { pairCodeId, pin: pending.pin })
  expect(response.status).toBe(200)
  return await response.json() as { sessionToken: string; sessionId: string }
}
async function socket(base: string, token: string) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws?token=' + token)
  ws.on('error', () => {})
  await once(ws, 'open')
  cleanups.push(async () => { if (ws.readyState === WebSocket.CLOSED) return; const done = once(ws, 'close'); ws.terminate(); await done })
  const events: Array<{ type: string; payload: unknown }> = []
  ws.on('message', data => events.push(JSON.parse(String(data))))
  return { ws, events }
}
for (const kind of cases) describe(`actual ${kind} production mobile HTTP/WS`, () => {
  beforeAll(async () => {
    if (kind === 'staged') stagedModule = await import(pathToFileURL(join(dirname(process.env.TAURI_PRODUCTION_SERVICE_ENTRY!), 'production-engine.mjs')).href) as typeof sourceModule
  })
  it('keeps access disabled, serves an independent SPA on loopback, pairs hashed credentials and revokes HTTP/WS access', async () => {
    const f = await fixture(kind)
    expect(await f.command('mobile:getInfo', [])).toMatchObject({ enabled: false, lanAccess: false })
    const base = await enable(f)
    expect(await (await fetch(base)).text()).toContain('Isolated mobile SPA')
    expect((await fetch(base + '/api/tasks')).status).toBe(401)
    const device = await pair(f, base), stream = await socket(base, device.sessionToken)
    const stored = f.db.db.prepare('SELECT token_hash FROM mobile_sessions WHERE id=?').get(device.sessionId) as { token_hash: string }
    expect(stored.token_hash).toBe(createHash('sha256').update(device.sessionToken).digest('hex'))
    expect(JSON.stringify(await f.command('mobile:getSessions', []))).not.toContain(device.sessionToken)
    const done = once(stream.ws, 'close')
    await f.command('mobile:revokeSession', [device.sessionId]); await done
    expect((await fetch(base + '/api/tasks', { headers: { Authorization: `Bearer ${device.sessionToken}` } })).status).toBe(401)
  })
  it('delegates learning/heartbeat/resource updates to the same production task service and projects public rows once', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), stream = await socket(base, device.sessionToken)
    const created = await post(base, '/api/tasks', { title: 'Phone task', project_id: f.project.id }, device.sessionToken)
    expect(created.status).toBe(200)
    const task = await created.json() as { id: string }
    expect(task).not.toHaveProperty('mcp_scope_nonce')
    const agent = f.db.getAgents()[0]
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 1 } })
    const changed = await post(base, `/api/tasks/${task.id}`, { agent_id: agent.id, heartbeat_interval_minutes: 30, heartbeat_enabled: true }, device.sessionToken)
    expect(changed.status).toBe(200)
    expect(f.db.getTask(task.id)).toMatchObject({ agent_id: agent.id, heartbeat_enabled: true })
    await vi.waitFor(() => expect(stream.events.filter(event => event.type === 'task:created')).toHaveLength(1))
    expect(JSON.stringify(stream.events)).not.toContain('mcp_scope_nonce')
    const read = await fetch(base + '/api/tasks/' + task.id, { headers: { Authorization: `Bearer ${device.sessionToken}` } })
    expect(await read.json()).not.toHaveProperty('mcp_scope_nonce')
    const before = f.db.getTask(task.id)?.skill_ids
    const invalid = await post(base, `/api/tasks/${task.id}`, { skill_ids: ['missing_skill'] }, device.sessionToken)
    expect(invalid.status).toBeGreaterThanOrEqual(400)
    expect(f.db.getTask(task.id)?.skill_ids).toEqual(before)
  })
  it('does not release a paired request guard during a held Stop or write after revocation', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Held phone task')
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(started.status).toBe(200)
    const hold = deferred(), entered = deferred(); releases.push(hold.resolve)
    f.adapter.destroySession.mockImplementationOnce(async () => { entered.resolve(); await hold.promise })
    const update = post(base, `/api/tasks/${task.id}`, { status: 'not_started', title: 'Must not be written' }, device.sessionToken)
    await entered.promise
    await f.command('mobile:revokeSession', [device.sessionId])
    hold.resolve()
    expect((await update).status).toBeGreaterThanOrEqual(400)
    expect(f.db.getTask(task.id)?.title).toBe('Held phone task')
  })
  it('retains pairing and durable transcript across a real production owner restart without blind session replay', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), stream = await socket(base, device.sessionToken)
    const task = f.task('Durable phone projection')
    const saved = process.platform === 'linux' ? await savedFile(f, task.id) : undefined
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(started.status).toBe(200)
    f.db.upsertTranscriptParts(task.id, [{ id: 'durable_mobile_part', role: 'assistant', partType: 'text', content: 'Persisted before service restart' }])
    const before = f.db.getTranscriptDelta(task.id, 0)
    const closed = once(stream.ws, 'close')
    await f.service.close(); await closed
    expect(f.db.db.open).toBe(false)
    const next = await fixture(kind, undefined, { root: f.root, keys: f.keys })
    const address = await enable(next)
    const snapshot = await fetch(address + `/api/tasks/${task.id}/transcript`, { headers: { Authorization: `Bearer ${device.sessionToken}` } })
    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Persisted before service restart' })]))
    expect(next.db.getTranscriptDelta(task.id, 0)).toEqual(before)
    expect(next.adapter.createSession).not.toHaveBeenCalled()
    expect(next.manager.findSessionByTaskId(task.id)).toBeUndefined()
    if (saved) { expect(next.db.getTask(task.id)?.attachments).toEqual([saved.file]); expect(readFileSync(saved.path)).toEqual(saved.bytes) }
    const again = await socket(address, device.sessionToken)
    again.ws.send(JSON.stringify({ type: 'ping' }))
    await vi.waitFor(() => expect(again.events.some(event => event.type === 'pong')).toBe(true))
    await next.command('mobile:revokeSession', [device.sessionId])
  })
  it('uses a real controlled Pi process for admission, exact permission/question replies, streaming and acknowledged Stop with PATH restricted', async () => {
    const f = await fixture(kind), cli = join(f.root, 'controlled-pi.cjs'), receipt = join(f.root, 'pi-receipt.json')
    const node = process.env.TAURI_NODE_RUNTIME ?? (!process.versions.electron ? process.execPath : join(process.cwd(), 'src-tauri/resources/node/node'))
    writeFileSync(cli, `#!${node}\n` + readFileSync(join(process.cwd(), 'test/fixtures/agent-rpc-process.cjs'), 'utf8'), { mode: 0o700 })
    const empty = join(f.root, 'empty-path'); mkdirSync(empty)
    vi.stubEnv('HOME', f.root); vi.stubEnv('PATH', empty); vi.stubEnv('PI_CODING_AGENT_DIR', f.root)
    vi.stubEnv('TWENTYX_SYNTHETIC_AGENT', '1'); vi.stubEnv('TWENTYX_FIXTURE_PROTOCOL', 'pi'); vi.stubEnv('TWENTYX_FIXTURE_RECEIPT', receipt)
    const adapter = new PiAdapter(); Object.assign(adapter, { piExecutablePath: cli }); f.useAdapter(adapter)
    cleanups.push(() => adapter.closeOwnedSessions())
    const base = await enable(f), device = await pair(f, base), stream = await socket(base, device.sessionToken)
    const task = f.task('Real phone provider'), second = f.task('Queued real phone provider')
    if (process.platform === 'linux') await savedFile(f, task.id)
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(started.status).toBe(200)
    const live = await started.json() as { sessionId: string }
    const waiting = await post(base, '/api/sessions/start', { taskId: second.id, agentId: second.agent_id }, device.sessionToken)
    expect(await waiting.json()).toMatchObject({ queued: true, queuePosition: 1, queueReason: 'agent_limit' })
    const providerReceipt = JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number; path: string; promptCount: number }
    expect(providerReceipt.path).toBe(empty); expect(providerReceipt.promptCount).toBe(1)
    expect(() => process.kill(providerReceipt.pid, 0)).not.toThrow()
    const approve = (requestId: string, responseType: 'permission' | 'question', approved = true) => post(base, `/api/sessions/${live.sessionId}/approve`, { approved, responseType, requestId, message: 'Synthetic answer' }, device.sessionToken)
    await vi.waitFor(async () => expect((await adapter.getPendingRequests(live.sessionId)).some(item => item.requestId === 'native-permission-211')).toBe(true))
    expect((await approve('stale-request', 'permission')).status).toBeGreaterThanOrEqual(400)
    expect((await approve('native-permission-211', 'permission')).status).toBe(200)
    await vi.waitFor(async () => expect((await adapter.getPendingRequests(live.sessionId)).some(item => item.requestId === 'native-question-211')).toBe(true))
    expect((await approve('native-question-211', 'question')).status).toBe(200)
    await vi.waitFor(() => expect(f.db.getTranscriptParts(task.id).some(part => part.content?.includes('Synthetic retained reply'))).toBe(true), { timeout: 5000 })
    expect(stream.events.some(event => event.type.startsWith('voice:speech:'))).toBe(false)
    await f.command('project:update', [f.project.id, { settings: { ...f.project.settings, limits: { paused: true } } }])
    const stopped = await post(base, `/api/sessions/${live.sessionId}/stop`, {}, device.sessionToken)
    expect(stopped.status).toBe(200)
    expect(() => process.kill(providerReceipt.pid, 0)).toThrow()
    expect(f.manager.getSession(live.sessionId)).toBeUndefined()
  }, 20000)

  it('routes explicit source completion through actual SyncManager, joins revocation, and refuses attachment replacement without a caller baseline', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), hold = deferred(), entered = deferred()
    const execute = vi.fn(async () => { entered.resolve(); await hold.promise; return { success: true, taskUpdate: { status: 'completed' as const } } })
    f.services.registry.register({ id: 'mobile-controlled-source', displayName: 'Synthetic Source', description: '', icon: 'test',
      getConfigSchema: () => [], getActions: () => [{ id: 'complete', label: 'Complete', description: '' }], resolveOptions: async () => [],
      importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction: execute })
    const source = f.db.createTaskSource({ name: 'Synthetic Source', plugin_id: 'mobile-controlled-source', mcp_server_id: null, config: {}, project_id: f.project.id })!
    const task = f.db.createTask({ title: 'Source completion', project_id: f.project.id, source_id: source.id, external_id: 'synthetic-issue', source: 'Synthetic Source' })!
    const request = post(base, `/api/tasks/${task.id}/complete`, { completeAtSource: true }, device.sessionToken)
    await entered.promise
    expect(f.db.getTask(task.id)?.status).not.toBe('completed')
    await f.command('mobile:revokeSession', [device.sessionId]); hold.resolve()
    expect((await request).status).toBeGreaterThanOrEqual(400)
    expect(f.db.getTask(task.id)?.status).not.toBe('completed')
    expect(execute).toHaveBeenCalledOnce()
    const current = await pair(f, base)
    const accepted = await post(base, `/api/tasks/${task.id}/complete`, { completeAtSource: true }, current.sessionToken)
    expect(accepted.status).toBe(200); expect(await accepted.json()).toMatchObject({ completed: true, status: 'completed' })
    expect(execute).toHaveBeenCalledTimes(2)
    const before = f.db.getTask(task.id)?.attachments
    expect((await post(base, `/api/tasks/${task.id}`, { attachments: [] }, current.sessionToken)).status).toBe(409)
    expect(f.db.getTask(task.id)?.attachments).toEqual(before)
    expect((await post(base, `/api/tasks/${task.id}`, { title: 'Field-only edit' }, current.sessionToken)).status).toBe(200)
  })
  it('keeps current mobile work independent of desktop grants and drains active pairing/listeners on disable', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), stream = await socket(base, device.sessionToken)
    const info = await f.command('mobile:getInfo', []) as { url: string }
    expect((await post(base, '/api/auth/pair/initiate', { code: new URL(info.url).searchParams.get('code') })).status).toBe(200)
    f.deny()
    const created = await post(base, '/api/tasks', { title: 'Desktop absent; same owner' }, device.sessionToken)
    expect(created.status).toBe(200)
    expect(f.db.getTasks().some(task => task.title === 'Desktop absent; same owner')).toBe(true)
    expect(f.service.owner.snapshot().phase).toBe('ready')
    // Restore desktop authority only for the explicit management command.
    f.allow()
    const closed = once(stream.ws, 'close')
    expect(await f.command('mobile:setAccess', [{ enabled: false }])).toMatchObject({ enabled: false, listening: false })
    await closed
    await expect(fetch(base + '/api/tasks')).rejects.toThrow()
  })

  it('routes legacy source create/configuration and explicit options through encrypted production owners', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base)
    const secret = 'synthetic-mobile-source-key', resolve = vi.fn(async () => [{ value: 'fixture-database', label: `Database ${secret}` }])
    f.services.registry.register({ id: 'notion', displayName: 'Controlled Notion', description: '', icon: 'test',
      getConfigSchema: () => [{ key: 'data_source_id', label: 'Database', type: 'dynamic-select', optionsResolver: 'data_sources' }], getActions: () => [],
      resolveOptions: resolve, importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction: async () => ({ success: false }) })
    const create = await post(base, '/api/task-sources', { name: 'Phone source', plugin_id: 'notion', mcp_server_id: null, config: { data_source_id: 'fixture-database', api_token: secret }, project_id: f.project.id }, device.sessionToken)
    expect(create.status).toBe(200)
    const source = await create.json() as { id: string }
    expect(source).not.toHaveProperty('config'); expect(resolve).not.toHaveBeenCalled()
    const raw = () => (f.db.db.prepare('SELECT config FROM task_sources WHERE id=?').get(source.id) as { config: string }).config
    expect(raw()).not.toContain(secret); expect(f.db.getTaskSource(source.id)?.config.api_token).toBe(secret)
    const update = await post(base, `/api/task-sources/${source.id}`, { name: 'Renamed source', enabled: false, config: { api_token: '__21x_api_key_set__' } }, device.sessionToken)
    expect(update.status).toBe(200); expect(await update.json()).not.toHaveProperty('config')
    expect(f.db.getTaskSource(source.id)).toMatchObject({ name: 'Renamed source', enabled: false, config: { api_token: secret, data_source_id: 'fixture-database' } })
    const options = await post(base, '/api/plugins/notion/resolve-options', { resolverKey: 'data_sources', config: { api_token: secret } }, device.sessionToken)
    expect(options.status).toBe(200); expect(await options.json()).toEqual([{ value: 'fixture-database', label: 'Database [REDACTED]' }])
    expect(resolve).toHaveBeenCalledOnce()
    expect((await post(base, '/api/plugins/notion/resolve-options', { resolverKey: 'not-a-declared-resolver', config: {} }, device.sessionToken)).status).toBe(400)
    expect((await post(base, `/api/task-sources/${source.id}`, { config: { unexpected_private_key: secret } }, device.sessionToken)).status).toBe(400)
    expect(resolve).toHaveBeenCalledOnce(); expect(raw()).not.toContain(secret)
  })
  it('holds raw source/configuration and resolver work until exact paired access is rechecked', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), held = deferred(), entered = deferred()
    const resolver = vi.fn(async () => { entered.resolve(); await held.promise; return [{ value: 'unchanged', label: 'Controlled option' }] })
    f.services.registry.register({ id: 'notion', displayName: 'Controlled', description: '', icon: 'test',
      getConfigSchema: () => [{ key: 'data_source_id', label: 'Database', type: 'dynamic-select', optionsResolver: 'data_sources' }], getActions: () => [], resolveOptions: resolver,
      importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction: async () => ({ success: false }) })
    const created = await post(base, '/api/task-sources', { name: 'Original', plugin_id: 'notion', mcp_server_id: null, config: { data_source_id: 'before', api_token: 'synthetic-original' } }, device.sessionToken)
    expect(created.status).toBe(200); const source = await created.json() as { id: string }
    const workGate = deferred(), workEntered = deferred()
    const work = f.services.sync.runSourceWork(source.id, async () => { workEntered.resolve(); await workGate.promise }); await workEntered.promise
    const mutation = vi.spyOn(f.services.sync, 'runSourceMutation')
    const update = post(base, `/api/task-sources/${source.id}`, { config: { data_source_id: 'must-not-commit' } }, device.sessionToken)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalled())
    await f.command('mobile:revokeSession', [device.sessionId]); workGate.resolve(); await work
    expect((await update).status).toBeGreaterThanOrEqual(400); expect(f.db.getTaskSource(source.id)?.config.data_source_id).toBe('before')
    const current = await pair(f, base)
    const options = post(base, '/api/plugins/notion/resolve-options', { resolverKey: 'data_sources', config: {} }, current.sessionToken)
    await entered.promise; await f.command('mobile:revokeSession', [current.sessionId]); held.resolve()
    expect((await options).status).toBeGreaterThanOrEqual(400); expect(resolver).toHaveBeenCalledOnce()
    expect(f.db.db.open).toBe(true); expect(f.service.owner.snapshot().phase).toBe('ready')
  })

  it('keeps explicit sync-all sequential and routes parent edits through the real exclusion/reference owner', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), hold = deferred(), entered = deferred()
    const imports = vi.fn(async () => { entered.resolve(); await hold.promise; return { imported: 0, updated: 0, errors: [] } })
    f.services.registry.register({ id: 'notion', displayName: 'Controlled Notion', description: '', icon: 'test', getConfigSchema: () => [], getActions: () => [], resolveOptions: async () => [],
      importTasks: imports, exportUpdate: async () => {}, executeAction: async () => ({ success: false }) })
    for (const name of ['First phone source', 'Second phone source']) {
      const create = await post(base, '/api/task-sources', { name, plugin_id: 'notion', mcp_server_id: null, config: { data_source_id: 'fixture' } }, device.sessionToken)
      expect(create.status).toBe(200)
    }
    const work = post(base, '/api/task-sources/sync-all', {}, device.sessionToken)
    await entered.promise; expect(imports).toHaveBeenCalledOnce()
    await f.command('mobile:revokeSession', [device.sessionId]); hold.resolve()
    expect((await work).status).toBeGreaterThanOrEqual(400)
    expect(imports).toHaveBeenCalledOnce()
    const current = await pair(f, base), parent = f.task('Parent', false), child = f.task('Child', false)
    const accepted = await post(base, `/api/tasks/${child.id}`, { parent_task_id: parent.id }, current.sessionToken)
    expect(accepted.status).toBe(200); expect(f.db.getTask(child.id)?.parent_task_id).toBe(parent.id)
    const cycle = await post(base, `/api/tasks/${parent.id}`, { parent_task_id: child.id }, current.sessionToken)
    expect(cycle.status).toBe(409); expect(f.db.getTask(parent.id)?.parent_task_id).toBeNull()
  })

  it('projects canonical manager update records without weakening malformed partial-event refusal', async () => {
    const f = await fixture(kind), task = f.task('Canonical task event'), full = f.db.getTask(task.id)!
    const raw = { taskId: task.id, updates: full }
    expect(validateProductionEventWire('task:updated', raw)).toBe(false)
    const projected = f.bindings.encodeOwnerEvent('task:updated', raw)
    expect(validateProductionEventWire('task:updated', projected)).toBe(true)
    expect(JSON.stringify(projected)).not.toContain('mcp_scope_nonce')
    expect(f.service.owner.snapshot().phase).toBe('ready')
    expect(() => f.bindings.encodeOwnerEvent('task:updated', { taskId: task.id, updates: { unsupported: 'not a public task field' } })).toThrow()
  })
  it.runIf(process.platform === 'linux')('refuses an explicit agent override before saved-file execution just like the desktop backend', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Exact saved-file assignment'); await savedFile(f, task.id)
    const other = f.db.createAgent({ name: 'Unassigned provider', config: { coding_agent: 'pi' } })!
    expect((await post(base, '/api/sessions/start', { taskId: task.id, agentId: other.id }, device.sessionToken)).status).toBe(409)
    expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(f.db.getTask(task.id)?.agent_id).toBe(task.agent_id)
  })
  it.runIf(process.platform === 'linux')('uses the protected saved-file manager for HTTP start and WebSocket projection', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), stream = await socket(base, device.sessionToken), task = f.task('Saved-file mobile start'), saved = await savedFile(f, task.id)
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(started.status).toBe(200); expect(f.adapter.createSession).toHaveBeenCalledOnce(); expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(readFileSync(join(saved.workspace, 'attachments', saved.file.filename))).toEqual(saved.bytes)
    await vi.waitFor(() => expect(stream.events.some(event => event.type === 'task:updated')).toBe(true))
    expect(stream.events.some(event => event.type.startsWith('voice:speech:'))).toBe(false)
    expect((await post(base, `/api/tasks/${task.id}`, { attachments: [] }, device.sessionToken)).status).toBe(409)
    expect((await post(base, '/api/tasks', { title: 'Incoming file create', attachments: [saved.file] }, device.sessionToken)).status).toBeGreaterThanOrEqual(400)
    expect(f.db.getTask(task.id)?.attachments).toEqual([saved.file])
  })
  it.runIf(process.platform === 'linux')('copies protected bytes on mobile empty-payload send without reading foreign workspace paths', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Saved-file mobile send')
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id, skipInitialPrompt: true }, device.sessionToken)
    expect(started.status).toBe(200); const { sessionId } = await started.json() as { sessionId: string }
    const saved = await savedFile(f, task.id), outside = join(f.root, 'private-canary.txt'); writeFileSync(outside, 'mobile-foreign-preview-canary')
    mkdirSync(join(saved.workspace, 'attachments')); symlinkSync(outside, join(saved.workspace, 'attachments', saved.file.filename))
    const sent = await post(base, `/api/sessions/${sessionId}/send`, { message: 'Read saved task context', attachments: [] }, device.sessionToken)
    expect(sent.status).toBe(200); expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(readFileSync(join(saved.workspace, 'attachments', saved.file.filename))).toEqual(saved.bytes)
    expect(readFileSync(outside, 'utf8')).toBe('mobile-foreign-preview-canary'); expect(JSON.stringify(f.adapter.sendPrompt.mock.calls)).not.toContain('mobile-foreign-preview-canary')
    expect((await post(base, `/api/sessions/${sessionId}/send`, { message: 'Incoming files refused', attachments: [saved.file] }, device.sessionToken)).status).toBe(400)
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
  })
  it.runIf(process.platform === 'linux')('uses the same protected copy authority on an exact saved mobile resume', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Saved-file mobile resume'), saved = await savedFile(f, task.id)
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id, skipInitialPrompt: true }, device.sessionToken)
    expect(started.status).toBe(200); const { sessionId } = await started.json() as { sessionId: string }
    await f.manager.stopSession(sessionId, false)
    const resumed = await post(base, `/api/sessions/${sessionId}/resume`, { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(resumed.status).toBe(200); expect(f.adapter.resumeSession).toHaveBeenCalledOnce()
    expect(readFileSync(join(saved.workspace, 'attachments', saved.file.filename))).toEqual(saved.bytes)
  })
  it.runIf(process.platform === 'linux').each(['saved', 'workspace'] as const)('refuses a foreign %s symlink through authenticated mobile before provider effects', async where => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Hostile saved target'), saved = await savedFile(f, task.id)
    const outside = join(f.root, 'foreign'); mkdirSync(outside); const canary = join(outside, saved.file.filename); writeFileSync(canary, 'foreign remains')
    if (where === 'saved') { unlinkSync(saved.path); symlinkSync(canary, saved.path) }
    else { mkdirSync(saved.workspace, { recursive: true }); symlinkSync(outside, join(saved.workspace, 'attachments')) }
    const response = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(readFileSync(canary, 'utf8')).toBe('foreign remains')
    expect(await response.text()).not.toContain(outside)
  })
  it.runIf(process.platform === 'linux')('routes a parent to its saved-file subtask through the same start policy and admission', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), parent = f.task('Mobile parent'), child = f.task('Mobile saved child')
    f.db.updateTask(child.id, { parent_task_id: parent.id }); const saved = await savedFile(f, child.id)
    const response = await post(base, '/api/sessions/start', { taskId: parent.id }, device.sessionToken)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ startedTaskId: child.id, action: 'subtask_started' })
    expect(readFileSync(join(saved.workspace, 'attachments', saved.file.filename))).toEqual(saved.bytes)
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce(); expect(f.manager.findSessionByTaskId(parent.id)).toBeUndefined()
  })
  it.runIf(process.platform === 'linux').each(['pairing', 'project', 'agent', 'metadata', 'child'] as const)('fences original %s while a real protected FD is held across mobile start', async change => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Held saved-file start'), saved = await savedFile(f, task.id), gate = holdSavedFile(f)
    const response = post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    await gate.entered.promise
    expect(f.services.taskAttachmentFiles.inflightCount).toBeGreaterThan(0)
    if (change === 'pairing') await f.command('mobile:revokeSession', [device.sessionId])
    else if (change === 'project') f.db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(f.db.createProject({ name: 'Replacement project' })!.id, task.id)
    else if (change === 'agent') f.db.updateTask(task.id, { agent_id: f.db.createAgent({ name: 'Replacement agent', config: { coding_agent: 'pi' } })!.id })
    else if (change === 'metadata') f.db.updateTask(task.id, { attachments: [] })
    else f.db.updateTask(f.task('Late routed child').id, { parent_task_id: task.id })
    gate.held.resolve(); expect((await response).status).toBeGreaterThanOrEqual(400)
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(readFileSync(saved.path)).toEqual(saved.bytes)
    await vi.waitFor(() => expect(f.services.taskAttachmentFiles.inflightCount).toBe(0))
  })
  it.runIf(process.platform === 'linux')('captures group membership receipts and refuses a changed member during protected copy', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), a = f.task('Member A'), b = f.task('Member B'), saved = await savedFile(f, b.id)
    const group = f.db.createTaskGroup({ title: 'Mobile file group', task_ids: [a.id, b.id] }), gate = holdSavedFile(f)
    const response = post(base, '/api/sessions/start', { taskId: a.id, agentId: a.agent_id }, device.sessionToken)
    await gate.entered.promise
    f.db.db.prepare('UPDATE task_group_memberships SET left_at=? WHERE group_id=? AND task_id=? AND left_at IS NULL').run('2026-10-18T01:00:00Z', group.id, b.id)
    gate.held.resolve(); expect((await response).status).toBeGreaterThanOrEqual(400)
    expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(readFileSync(saved.path)).toEqual(saved.bytes)
  })
  it.runIf(process.platform === 'linux')('starts the captured group with member-namespaced protected bytes', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), a = f.task('Member A'), b = f.task('Member B'), saved = await savedFile(f, b.id)
    const group = f.db.createTaskGroup({ title: 'Mobile file group', task_ids: [a.id, b.id] })
    const response = await post(base, '/api/sessions/start', { taskId: a.id, agentId: a.agent_id }, device.sessionToken)
    expect(response.status).toBe(200); expect(f.manager.findSessionByTaskId(group.execution_task_id)).toBeDefined()
    expect(f.ownerEventFailures).toEqual([]); expect(f.service.owner.snapshot().phase).toBe('ready')
    expect(JSON.stringify(f.events)).not.toContain('mcp_scope_nonce')
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    const prompt = JSON.stringify(f.adapter.sendPrompt.mock.calls); expect(prompt).toContain(b.id); expect(prompt).toContain(saved.file.filename)
  })
  it.runIf(process.platform === 'linux')('retains raw FD/HTTP ownership after a client disconnect and joins quit before profile release', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Disconnected file start'), saved = await savedFile(f, task.id), gate = holdSavedFile(f), abort = new AbortController()
    const request = fetch(base + '/api/sessions/start', { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${device.sessionToken}` }, body: JSON.stringify({ taskId: task.id, agentId: task.agent_id }) })
    const rejected = expect(request).rejects.toBeDefined(); await gate.entered.promise; abort.abort(); await rejected
    await expect(f.service.owner.close(25)).rejects.toMatchObject({ code: 'OWNER_DRAIN_BLOCKED' })
    expect(f.db.db.open).toBe(true); expect(f.services.taskAttachmentFiles.inflightCount).toBeGreaterThan(0)
    gate.held.resolve(); await f.service.close()
    expect(f.db.db.open).toBe(false); expect(f.adapter.sendPrompt).not.toHaveBeenCalled(); expect(readFileSync(saved.path)).toEqual(saved.bytes)
  })
  it.runIf(process.platform === 'linux')('keeps an accepted admission queue in Source after the paired caller retires', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), blocker = f.task('Admission blocker'), next = f.task('Queued file task'), saved = await savedFile(f, next.id)
    const first = await post(base, '/api/sessions/start', { taskId: blocker.id, agentId: blocker.agent_id }, device.sessionToken)
    expect(first.status).toBe(200); const { sessionId } = await first.json() as { sessionId: string }
    const queued = await post(base, '/api/sessions/start', { taskId: next.id, agentId: next.agent_id }, device.sessionToken)
    expect(queued.status).toBe(200); expect(await queued.json()).toMatchObject({ queued: true })
    await f.command('mobile:revokeSession', [device.sessionId]); await f.manager.stopSession(sessionId, false)
    await vi.waitFor(() => expect(f.manager.findSessionByTaskId(next.id)).toBeDefined())
    await vi.waitFor(() => expect(f.adapter.sendPrompt.mock.calls.length).toBe(2))
    expect(readFileSync(join(saved.workspace, 'attachments', saved.file.filename))).toEqual(saved.bytes)
    expect(f.manager.getStartQueue()).toEqual([])
  })
  it.runIf(process.platform === 'linux').each(['pairing', 'metadata', 'session'] as const)('refuses retired %s question authority before the native provider reply', async change => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Scoped question with file'); await savedFile(f, task.id)
    const pending = vi.fn(async () => [{ requestId: 'mobile-question', responseType: 'question' as const }]), reply = vi.fn(async () => true)
    Object.assign(f.adapter, { getPendingRequests: pending, respondToQuestion: reply })
    const started = await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)
    expect(started.status).toBe(200); const { sessionId } = await started.json() as { sessionId: string }
    const entered = deferred(), held = deferred(); pending.mockImplementationOnce(async () => { entered.resolve(); await held.promise; return [{ requestId: 'mobile-question', responseType: 'question' as const }] })
    const response = post(base, `/api/sessions/${sessionId}/approve`, { approved: true, responseType: 'question', requestId: 'mobile-question', message: 'Held answer' }, device.sessionToken)
    await entered.promise
    if (change === 'pairing') await f.command('mobile:revokeSession', [device.sessionId])
    else if (change === 'metadata') f.db.updateTask(task.id, { attachments: [] })
    else f.db.updateTask(task.id, { session_id: 'foreign_runtime' })
    held.resolve()
    expect((await response).status).toBeGreaterThanOrEqual(400); expect(reply).not.toHaveBeenCalled()
  })
  it.runIf(process.platform === 'linux').each(['darwin', 'win32'] as const)('keeps %s saved-file execution unavailable before effects (policy branch only)', async platform => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task = f.task('Unsupported policy target'); await savedFile(f, task.id)
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { ...original, value: platform })
      expect((await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id }, device.sessionToken)).status).toBe(409)
    } finally { Object.defineProperty(process, 'platform', original) }
    expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
  })
  it.each(['attachments', 'graph'])('rechecks %s after held raw initialization before attachment or provider effects', async change => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task=f.task('Held initialize')
    const held=deferred(); f.adapter.initialize.mockImplementationOnce(async () => { await held.promise })
    const response=post(base, '/api/sessions/start', { taskId: task.id }, device.sessionToken)
    await vi.waitFor(() => expect(f.adapter.initialize).toHaveBeenCalledOnce())
    if (change === 'attachments') f.db.updateTask(task.id, { attachments: [{ id: 'late_file', filename: 'late.txt', size: 1, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00Z' }] })
    else { const child=f.task('New routed child'); f.db.updateTask(child.id, { parent_task_id: task.id }) }
    held.resolve(); expect((await response).status).toBeGreaterThanOrEqual(400)
    expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.sendPrompt).not.toHaveBeenCalled()
    expect(f.manager.findSessionByTaskId(task.id)).toBeUndefined()
  })
  it('keeps queued sends fenced when saved attachments change', async () => {
    const f = await fixture(kind), base = await enable(f), device = await pair(f, base), task=f.task('Held send')
    const started=await post(base, '/api/sessions/start', { taskId: task.id, agentId: task.agent_id, skipInitialPrompt: true }, device.sessionToken)
    expect(started.status).toBe(200); const { sessionId }=await started.json() as { sessionId: string }
    const held=deferred(); f.adapter.sendPrompt.mockImplementationOnce(async () => { await held.promise })
    const first=post(base, `/api/sessions/${sessionId}/send`, { message: 'Accepted raw send' }, device.sessionToken)
    await vi.waitFor(() => expect(f.adapter.sendPrompt).toHaveBeenCalledOnce())
    const second=post(base, `/api/sessions/${sessionId}/send`, { message: 'Queued send' }, device.sessionToken)
    await new Promise(resolve => setTimeout(resolve, 30))
    f.db.updateTask(task.id, { attachments: [{ id: 'late_file', filename: 'late.txt', size: 1, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00Z' }] })
    held.resolve(); expect((await first).status).toBeGreaterThanOrEqual(400); expect((await second).status).toBeGreaterThanOrEqual(400)
    expect(f.adapter.sendPrompt).toHaveBeenCalledOnce()
    expect(f.service.owner.snapshot().phase).toBe('ready')
  })

})


describe('actual Source production tunnel composition with contained process', () => {
  it('refuses disabled access, starts one controlled raw child and drains it and paired sockets on quit', async () => {
    let receipt = '', spawns = 0
    const f = await fixture('source', undefined, undefined, async root => {
      const { TunnelManagerCore } = await import('../main/tunnel-manager-core')
      const script = join(root, 'contained-tunnel.cjs'); receipt = join(root, 'contained-tunnel-receipt.json')
      writeFileSync(script, `require('node:fs').writeFileSync(process.env.TUNNEL_RECEIPT, JSON.stringify({pid:process.pid,args:process.argv.slice(2),path:process.env.PATH}));
console.log('https://synthetic-root.trycloudflare.com');
console.error('Registered tunnel connection connIndex=0');
setInterval(()=>{},1000);
`)
      return new TunnelManagerCore({ binary: process.execPath, privateRoot: root, environment: { HOME: root, PATH: '', TUNNEL_RECEIPT: receipt },
        spawn: (_binary, args, options) => { spawns++; return spawn(process.execPath, [script, ...args], options) as import('node:child_process').ChildProcessWithoutNullStreams }, connectTimeoutMs: 2000 })
    })
    await expect(f.command('mobile:startTunnel', [])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(spawns).toBe(0); expect(existsSync(receipt)).toBe(false)
    const base = await enable(f), device = await pair(f, base), stream = await socket(base, device.sessionToken)
    const replies = await Promise.all([f.command('mobile:startTunnel', []), f.command('mobile:startTunnel', [])])
    expect(spawns).toBe(1); expect(replies).toEqual([expect.objectContaining({ tunnelUrl: expect.stringContaining('https://synthetic-root.trycloudflare.com/pair?code=') }), expect.objectContaining({ tunnelUrl: expect.stringContaining('https://synthetic-root.trycloudflare.com/pair?code=') })])
    const proof = JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number; args: string[]; path: string }
    expect(proof.path).toBe(''); expect(proof.args.at(-1)).toBe(base)
    const config = proof.args[2]!; expect(readFileSync(config, 'utf8')).toBe('')
    expect(() => process.kill(proof.pid, 0)).not.toThrow()
    const closed = once(stream.ws, 'close'); await f.service.close(); await closed
    expect(() => process.kill(proof.pid, 0)).toThrow(); expect(existsSync(config)).toBe(false)
    expect(f.db.db.open).toBe(false); expect(f.service.owner.snapshot().phase).toBe('stopped')
  })
})

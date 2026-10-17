import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { ProjectRecord } from '../shared/projects'
import type { AgentRecord } from '../main/database/types'
import type { ProjectConfigurationBackend } from './project-configuration-backend'
import { DESKTOP_OPERATION_MANIFEST } from '../shared/desktop-operations'
import { isOptionalResult } from '../shared/host-services'
import { reconcileProductionDomains, type DomainObservations } from './production-domain-reconciliation'

const cleanups: Array<() => Promise<void>> = []
const releases: Array<()=>void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
let stagedModule: typeof sourceModule | undefined
const cases = ['source', ...(process.env.TAURI_PRODUCTION_SERVICE_ENTRY ? ['staged'] : [])]
const observations = new Map<string, DomainObservations>()
async function fixture(kind: string) {
  const observed = observations.get(kind) ?? { commands: new Map(), events: new Map() }
  observations.set(kind, observed)
  vi.resetModules()
  const module =
    kind === 'staged'
      ? stagedModule!
      : await import('./production-service')
  const root = mkdtempSync(join(tmpdir(), '21x-project-configuration-'))
  const descriptor: ProductionLaunchDescriptor = {
    version: 1,
    kind: 'production-private-launch',
    launchId: 'voice_actions_launch',
    profileId: 'voice-actions-profile',
    profileIntent: 'create-new',
    buildIdentity: 'production-voice-fixture',
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
  mkdirSync(descriptor.paths.resourceRoot)
  let allowed = true, createProject = true, globalSkillRead = true,
    writes = true,
    adapterChoice: CodingAgentAdapter | undefined
  const blockedProjects = new Set<string>(), blockedAgents = new Set<string>(), blockedProjectReads = new Set<string>(), blockedSessions = new Set<string>(), blockedTaskWrites = new Set<string>()
  const check = () => allowed
  const authority: ProductionDesktopBindingOptions['authority'] = {
    isTrustedDesktop: check,
    canAccessTask: (id, _caller, access) => allowed && (access === 'read' || writes && !blockedTaskWrites.has(id)),
    canAccessProject: (id, _caller, access) => allowed && !blockedProjects.has(id) && (access === 'read' ? !blockedProjectReads.has(id) : writes),
    canAccessAgent: (id, _caller, access) => allowed && !blockedAgents.has(id) && (access === 'read' || writes),
    canAccessSource: check,
    canAccessSession: id => allowed && !blockedSessions.has(id),
    canAccessGlobalCommander: check,
    canManageGlobalConfiguration: check,
    canQueryBackend: check,
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
  const keys = new Map<string, Buffer>(),
    events: Array<{ operation: string; payload: JsonValue }> = []
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
        cliMcp: { homeDir: root, environment: {} },
        createAdapter: () => adapterChoice ?? (adapter as unknown as CodingAgentAdapter),
        createProvider: () => provider
      },
      constructBootstrap: (callbacks) => ({
        profileId: descriptor.profileId,
        paths: descriptor.paths,
        credentials: {
          mode: 'create',
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
          emit: callbacks.emitOwnerEvent,
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
    rmSync(root, { recursive: true, force: true })
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
  const command = async (operation: string, args: unknown[]) => {
    const codec = PRODUCTION_COMMAND_CODECS[operation as keyof typeof PRODUCTION_COMMAND_CODECS]
    const payload = codec.encodeArguments(args as never)
    const counter = observed.commands.get(operation) ?? { attempted: 0, succeeded: 0 }; observed.commands.set(operation, counter); counter.attempted++
    const result = await host.request(operation, payload)
    if (!isOptionalResult(result)) throw new Error('Invalid synthetic peer result')
    const decoded = codec.decodeResult(result.defined ? result.value : undefined); counter.succeeded++
    return decoded as unknown
  }
  return {
    command, bindings, blockedProjects, blockedProjectReads, blockedAgents, blockedSessions, blockedTaskWrites, onEvent: (hook: typeof eventHook) => { eventHook = hook }, denyGlobalSkillRead: () => { globalSkillRead = false }, denyCreate: () => { createProject = false },
    root,
    db,
    manager,
    project,
    caller,
    host,
    events,
    adapter,
    task,
    service,
    authority,
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
for (const kind of cases) describe(`actual ${kind} production project configuration`, () => {
  beforeAll(async () => {
    if (kind === 'staged') stagedModule = await import(pathToFileURL(join(dirname(process.env.TAURI_PRODUCTION_SERVICE_ENTRY!), 'production-engine.mjs')).href) as typeof sourceModule
  })
  it('creates the full editor configuration and one durable Captain with canonical invalidation', async () => {
    const f = await fixture(kind), agent = f.db.getAgents()[0]
    const created = await f.command('project:create', [{ name: 'Configured project', description: 'Context', default_agent_id: agent.id, captain_agent_id: agent.id,
      git_provider: 'forgejo', git_org: 'synthetic', settings: { limits: { paused: true, daily_session_cap: 5 }, captain_wakeups: { enabled: false }, scheduled_review: { enabled: false, cron: '0 9 * * 1-5' },
        concurrency: { captain_control: true, levels: { [agent.id]: 10 } }, public_note: 'Kept' } }]) as ProjectRecord
    expect(created).toMatchObject({ name: 'Configured project', default_agent_id: agent.id, captain_agent_id: agent.id, git_provider: 'forgejo', git_org: 'synthetic' })
    expect(created.settings).toEqual({ limits: { paused: true, daily_session_cap: 5 }, captain_wakeups: { enabled: false }, scheduled_review: { enabled: false, cron: '0 9 * * 1-5' }, public_note: 'Kept' })
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND role='captain'").get(created.id)).toEqual({ count: 1 })
    await vi.waitFor(() => expect(f.events).toContainEqual({ operation: 'project:changed', payload: { projectId: created.id, kind: 'created' } }))
  })
  it('preserves audited concurrency and drains the real paused project FIFO after a settings update', async () => {
    const f = await fixture(kind), task = f.task('Paused start'), agent = f.db.getAgents()[0]
    const concurrency = { captain_control: false, levels: { [agent.id]: 1 }, pinned: { [agent.id]: 1 } }
    f.db.updateProject(f.project.id, { default_agent_id: agent.id, settings: { captain_wakeups: { enabled: false }, limits: { paused: true }, concurrency } })
    const start = await f.manager.startTask(task.id)
    expect(start.action).toBe('queued'); expect(f.adapter.createSession).not.toHaveBeenCalled()
    expect(f.manager.getStartQueue()).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: task.id, reason: 'project_paused' })]))
    const result = await f.command('project:update', [f.project.id, { name: 'Edited', default_agent_id: agent.id, captain_agent_id: null, git_provider: null, git_org: null,
      settings: { limits: { paused: false, max_concurrent_agents: 1 }, captain_wakeups: { enabled: false }, concurrency: { captain_control: true, levels: { [agent.id]: 10 } } } }]) as ProjectRecord
    expect(result.settings.concurrency).toEqual(concurrency)
    await vi.waitFor(() => expect(f.manager.findSessionByTaskId(task.id)?.sessionId).toBeTruthy())
    expect(f.adapter.createSession).toHaveBeenCalledTimes(1)
    expect(f.events).toContainEqual({ operation: 'project:changed', payload: { projectId: f.project.id, kind: 'updated' } })
  })
  it('checks the final merged settings budget before persisting preserved concurrency plus new metadata', async () => {
    const f = await fixture(kind), agents = Array.from({ length: 7 }, (_, i) => f.db.createAgent({ name: `Stored cap ${i}`, config: { coding_agent: 'pi' } })!)
    const original = { captain_wakeups: { enabled: false }, concurrency: { captain_control: true, levels: Object.fromEntries(agents.map(agent => [agent.id, 2])), pinned: {} } }
    f.db.updateProject(f.project.id, { settings: original })
    const settings = { note: 'x'.repeat(65_400) }
    expect(Buffer.byteLength(JSON.stringify(settings))).toBeLessThan(65_536)
    expect(Buffer.byteLength(JSON.stringify({ ...settings, concurrency: original.concurrency }))).toBeGreaterThan(65_536)
    await expect(f.command('project:update', [f.project.id, { settings }])).rejects.toThrow()
    expect('note' in f.db.getProject(f.project.id)!.settings).toBe(false)
    expect(f.db.getProject(f.project.id)?.settings).toEqual(original)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
  })
  it('joins exact old Captain teardown before changing selection and preserves an unrelated session', async () => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Next', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi', max_parallel_sessions: 2 } })
    f.db.updateProject(f.project.id, { captain_agent_id: original.id, default_agent_id: original.id })
    const captain = f.db.getCoordinatorTask(f.project.id)!, ordinary = f.task('Unrelated')
    await f.manager.switchCaptainAgent(f.project.id, original.id, true)
    const oldSession = f.manager.findSessionByTaskId(captain.id)!.sessionId, otherSession = await f.manager.startSession(original.id, ordinary.id)
    const gate = deferred(); f.adapter.destroySession.mockImplementationOnce(() => gate.promise)
    const operation = f.command('project:update', [f.project.id, { captain_agent_id: next.id }]); void operation.catch(() => {})
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalled())
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(original.id)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
    await expect(f.manager.switchCaptainAgent(f.project.id, next.id)).rejects.toThrow('being updated')
    expect(() => f.manager.rollbackCaptainSwitch(f.project.id)).toThrow('being updated')
    gate.resolve(); await operation
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(next.id)
    expect(f.manager.getSession(oldSession)).toBeUndefined()
    expect(f.manager.getSession(otherSession)).toBeDefined()
    expect(f.adapter.destroySession.mock.calls.map(call => call[0])).toContain(oldSession)
    expect(f.adapter.destroySession.mock.calls.map(call => call[0])).not.toContain(otherSession)
  })
  it('refuses selection changes after raw stop failure without persisting or publishing them', async () => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Next', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: original.id })
    await f.manager.startSession(original.id, f.db.getCoordinatorTask(f.project.id)!.id)
    f.adapter.destroySession.mockRejectedValueOnce(new Error('Synthetic raw abort refused'))
    await expect(f.command('project:update', [f.project.id, { captain_agent_id: next.id }])).rejects.toThrow()
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(original.id)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
    await f.command('project:update', [f.project.id, { captain_agent_id: next.id }])
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(next.id)
  })
  it.each(['task', 'session', 'agent'])('rechecks exact %s retirement scope after raw teardown acknowledgement', async scope => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Next', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: original.id })
    const captain = f.db.getCoordinatorTask(f.project.id)!, session = await f.manager.startSession(original.id, captain.id)
    const gate = deferred(); f.adapter.destroySession.mockImplementationOnce(() => gate.promise)
    const operation = f.command('project:update', [f.project.id, { captain_agent_id: next.id }]); void operation.catch(() => {})
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalled())
    if (scope === 'task') f.blockedTaskWrites.add(captain.id)
    if (scope === 'session') f.blockedSessions.add(session)
    if (scope === 'agent') f.blockedAgents.add(original.id)
    gate.resolve(); await expect(operation).rejects.toThrow()
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(original.id)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
  })
  it('keeps the same live Captain on metadata/settings edits and applies real pause state', async () => {
    const f = await fixture(kind), agent = f.db.getAgents()[0]
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: agent.id })
    const captain = f.db.getCoordinatorTask(f.project.id)!, session = await f.manager.startSession(agent.id, captain.id)
    await f.command('project:update', [f.project.id, { description: 'Updated metadata', settings: { captain_wakeups: { enabled: false }, limits: { paused: true, daily_session_cap: 1 } } }])
    expect(f.manager.getSession(session)).toBeDefined(); expect(f.adapter.destroySession).not.toHaveBeenCalled()
    expect(f.manager.getProjectLimitState(f.project.id)).toMatchObject({ paused: true })
  })
  it('holds raw retirement through cancellation and failed close; revoked scope cannot write after acknowledgement', async () => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Next', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: original.id })
    await f.manager.startSession(original.id, f.db.getCoordinatorTask(f.project.id)!.id)
    const gate = deferred(); f.adapter.destroySession.mockImplementationOnce(() => gate.promise)
    const operation = f.command('project:update', [f.project.id, { captain_agent_id: next.id }]); void operation.catch(() => {})
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalled())
    f.denyWrites()
    const backend = Reflect.get(f.bindings, 'projectConfiguration') as ProjectConfigurationBackend
    await expect(backend.close(20)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(backend.inflightCount).toBe(1)
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(original.id)
    gate.resolve(); await expect(operation).rejects.toThrow(); await backend.close()
    expect(backend.inflightCount).toBe(0)
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(original.id)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
  })
  it('rejects project/agent/session scope withdrawal and changed project receipts before any late write', async () => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Next', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: original.id })
    await f.manager.startSession(original.id, f.db.getCoordinatorTask(f.project.id)!.id)
    const gate = deferred(); f.adapter.destroySession.mockImplementationOnce(() => gate.promise)
    const operation = f.command('project:update', [f.project.id, { captain_agent_id: next.id }]); void operation.catch(() => {})
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalled())
    f.db.updateProject(f.project.id, { description: 'Concurrent change' })
    gate.resolve(); await expect(operation).rejects.toThrow()
    expect(f.db.getProject(f.project.id)).toMatchObject({ captain_agent_id: original.id, description: 'Concurrent change' })
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
    f.blockedAgents.add(next.id)
    await expect(f.command('project:update', [f.project.id, { default_agent_id: next.id }])).rejects.toThrow()
  })
  it('retains raw teardown after a real private-peer caller cancellation and suppresses the late project write', async () => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Next', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: original.id })
    await f.manager.startSession(original.id, f.db.getCoordinatorTask(f.project.id)!.id)
    const gate = deferred(), cancel = new AbortController(); f.adapter.destroySession.mockImplementationOnce(() => gate.promise)
    const payload = PRODUCTION_COMMAND_CODECS['project:update'].encodeArguments([f.project.id, { captain_agent_id: next.id }])
    const operation = f.host.request('project:update', payload, { signal: cancel.signal }); void operation.catch(() => {})
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalled())
    cancel.abort(); await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' })
    const backend = Reflect.get(f.bindings, 'projectConfiguration') as ProjectConfigurationBackend
    expect(backend.inflightCount).toBe(1)
    gate.resolve(); await vi.waitFor(() => expect(backend.inflightCount).toBe(0))
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(original.id)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
  })
  it('publishes the accepted project invalidation once when cancellation arrives during event delivery', async () => {
    const f = await fixture(kind), cancel = new AbortController()
    f.onEvent(event => { if (event.operation === 'project:changed') cancel.abort() })
    const operation = f.host.request('project:update', PRODUCTION_COMMAND_CODECS['project:update'].encodeArguments([f.project.id, { description: 'Accepted exactly once' }]), { signal: cancel.signal })
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(f.db.getProject(f.project.id)?.description).toBe('Accepted exactly once')
    expect(f.events.filter(e => e.operation === 'project:changed')).toEqual([{ operation: 'project:changed', payload: { projectId: f.project.id, kind: 'updated' } }])
  })
  it('refuses a project edit while an already admitted Captain candidate owns verification', async () => {
    const f = await fixture(kind), original = f.db.getAgents()[0], next = f.db.createAgent({ name: 'Candidate', config: { coding_agent: 'pi' } })!
    f.db.updateAgent(original.id, { config: { coding_agent: 'pi' } }); f.db.updateProject(f.project.id, { captain_agent_id: original.id })
    const gate = deferred(), entered = deferred()
    f.adapter.createSession.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return 'verified_candidate' })
    const candidate = f.manager.switchCaptainAgent(f.project.id, next.id); void candidate.catch(() => {})
    await entered.promise
    await expect(f.command('project:update', [f.project.id, { description: 'Racing edit' }])).rejects.toThrow()
    expect(f.db.getProject(f.project.id)?.description).toBe(f.project.description)
    gate.resolve(); await candidate
    expect(f.db.getProject(f.project.id)?.captain_agent_id).toBe(next.id)
  })
  it('rejects missing or forbidden references and malformed private requests without a project or Captain', async () => {
    const f = await fixture(kind), count = f.db.getProjects().length
    await expect(f.command('project:create', [{ name: 'Invalid', captain_agent_id: 'missing_agent' }])).rejects.toThrow()
    f.denyCreate()
    await expect(f.command('project:create', [{ name: 'Forbidden' }])).rejects.toThrow()
    await expect(f.host.request('project:create', { data: { name: 'Injected', settings: { nested: { api_keys: 'hidden' } } } })).rejects.toThrow()
    expect(f.db.getProjects()).toHaveLength(count)
    expect(f.events.filter(e => e.operation === 'project:changed')).toHaveLength(0)
  })
  it('uses canonical repo/resource/skill owners, conflict checks and invalidations on the same project', async () => {
    const f = await fixture(kind)
    const created = await f.command('project:create', [{ name: 'Domain contents' }]) as ProjectRecord
    const repo = await f.command('projectRepo:add', [created.id, { name: 'repo', provider: 'github', org: 'synthetic' }]) as { id: string }
    const resource = await f.command('projectResource:add', [created.id, { label: 'Guide', notes: 'Context', url: 'https://example.com' }]) as { id: string }
    const skill = await f.command('skills:create', [{ name: 'Skill', description: 'Description', content: 'Safe synthetic context', project_id: created.id }]) as { id: string; version: number }
    await f.command('projectRepo:update', [repo.id, { default_branch: 'master' }])
    await f.command('projectResource:update', [resource.id, { notes: 'Updated context' }])
    await f.command('skills:update', [skill.id, { content: 'New content', expected_version: skill.version }])
    await expect(f.command('skills:update', [skill.id, { content: 'Stale overwrite', expected_version: skill.version }])).rejects.toThrow()
    expect(f.db.getSkill(skill.id)?.content).toBe('New content')
    expect(f.events).toEqual(expect.arrayContaining([
      { operation: 'project:changed', payload: { projectId: created.id, kind: 'repos' } },
      { operation: 'project:changed', payload: { projectId: created.id, kind: 'resources' } },
      { operation: 'skills:changed', payload: { skillId: skill.id, kind: 'updated' } }
    ]))
    f.blockedProjects.add(created.id)
    await expect(f.command('projectResource:update', [resource.id, { notes: 'Foreign' }])).rejects.toThrow()
  })
  it('keeps agent CRUD/configuration/model notification and teardown on the real lifecycle owner', async () => {
    const f = await fixture(kind)
    const created = await f.command('agent:create', [{ name: 'Managed', config: { coding_agent: 'pi', model: 'model_one', api_keys: { openai: 'synthetic-not-a-live-key' } } }]) as AgentRecord
    expect(created.config.api_keys).toEqual({ openai: '__21x_api_key_set__' })
    const stored = f.db.db.prepare('SELECT config FROM agents WHERE id=?').get(created.id) as { config: string }
    expect(stored.config).not.toContain('synthetic-not-a-live-key')
    expect(JSON.parse(stored.config).api_keys.openai).toMatch(/^21x-record-credential:v1:/)
    const task = f.db.createTask({ title: 'Agent lifecycle', project_id: f.project.id })!; f.db.updateTask(task.id, { agent_id: created.id })
    const sessionId = await f.manager.startSession(created.id, task.id)
    await f.command('agent:update', [created.id, { name: 'Renamed', config: { coding_agent: 'pi', model: 'model_two', api_keys: { openai: '__21x_api_key_set__' } } }])
    expect(f.adapter.notifyConfigChanged).toHaveBeenCalled()
    expect(f.manager.getSession(sessionId)).toBeUndefined()
    expect(f.db.getAgent(created.id)?.config.api_keys?.openai).toBe('synthetic-not-a-live-key')
    const models = await f.command('agentConfig:listModels', ['pi'])
    expect(models).toEqual([{ id: 'model_one', name: 'Model one' }]); expect(f.adapter.listModels).toHaveBeenCalled()
    const providers = await f.command('agentConfig:getProviders', [undefined, 'pi'])
    expect(providers).toMatchObject({ providers: [{ id: 'synthetic' }], default: {} }); expect(f.adapter.getProviders).toHaveBeenCalled()
    await expect(f.manager.startSession(created.id, task.id)).rejects.toThrow('manual_stop_not_retried')
    const nextTask = f.db.createTask({ title: 'Explicit new start', project_id: f.project.id })!; f.db.updateTask(nextTask.id, { agent_id: created.id })
    const refreshedSession = await f.manager.startSession(created.id, nextTask.id)
    const gate = deferred(); f.adapter.destroySession.mockImplementationOnce(() => gate.promise)
    f.adapter.destroySession.mockClear()
    const deletion = f.command('agent:delete', [created.id])
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalled())
    expect(f.db.getAgent(created.id)).toBeDefined()
    gate.resolve(); expect(await deletion).toBe(true)
    expect(f.manager.getSession(refreshedSession)).toBeUndefined(); expect(f.db.getAgent(created.id)).toBeUndefined()
  })
  it('delivers project skill create/update/deletion to a project-only reader with the unchanged event DTO', async () => {
    const f = await fixture(kind); f.denyGlobalSkillRead()
    const skill = await f.command('skills:create', [{ name: 'Project only', description: 'Context', content: 'Instructions', project_id: f.project.id }]) as { id: string; version: number }
    await f.command('skills:update', [skill.id, { content: 'Updated', expected_version: skill.version }])
    await f.command('skills:delete', [skill.id])
    expect(f.events.filter(e => e.operation === 'skills:changed')).toEqual(['created', 'updated', 'removed'].map(kind => ({ operation: 'skills:changed', payload: { skillId: skill.id, kind } })))
  })
  it('does not disclose a foreign project skill ID to a global-skills reader', async () => {
    const f = await fixture(kind), other = f.db.createProject({ name: 'Foreign read scope' })!
    f.blockedProjectReads.add(other.id)
    const skill = await f.command('skills:create', [{ name: 'Foreign project skill', description: 'Context', content: 'Instructions', project_id: other.id }]) as { id: string }
    expect(f.events.filter(e => e.operation === 'skills:changed')).toHaveLength(0)
    expect(f.bindings.projectOwnerEvent('skills:changed', { skillId: skill.id, kind: 'updated' }, f.caller)).toBeUndefined()
    const owned = f.db.createSkill({ name: 'Global visible', description: 'Context', content: 'Instructions' })!
    expect(f.bindings.projectOwnerEvent('skills:changed', { skillId: owned.id, kind: 'updated' }, f.caller)).toEqual({ skillId: owned.id, kind: 'updated' })
  })
  it('invalidates the old readable project after a scope move without adding scope metadata to the event', async () => {
    const f = await fixture(kind), other = f.db.createProject({ name: 'Destination' })!
    f.denyGlobalSkillRead(); f.blockedProjectReads.add(other.id)
    const skill = await f.command('skills:create', [{ name: 'Moved scope', description: 'Context', content: 'Instructions', project_id: f.project.id }]) as { id: string }
    await f.command('skills:setProject', [skill.id, other.id])
    expect(f.events.filter(e => e.operation === 'skills:changed')).toContainEqual({ operation: 'skills:changed', payload: { skillId: skill.id, kind: 'scope' } })
    expect(f.bindings.projectOwnerEvent('skills:changed', { skillId: skill.id, kind: 'scope' }, f.caller)).toBeUndefined()
  })
  it('retires a real controlled Pi child before project selection publication with system PATH absent', async () => {
    const f = await fixture(kind), cli = join(f.root, 'controlled-pi.cjs'), receipt = join(f.root, 'process-receipt.json')
    const node = process.env.TAURI_NODE_RUNTIME ?? (!process.versions.electron ? process.execPath : join(process.cwd(), 'src-tauri/resources/node/node'))
    writeFileSync(cli, `#!${node}\n` + readFileSync(join(process.cwd(), 'test/fixtures/agent-rpc-process.cjs'), 'utf8'), { mode: 0o700 })
    const empty = join(f.root, 'empty-path'); mkdirSync(empty)
    vi.stubEnv('HOME', f.root); vi.stubEnv('PATH', empty); vi.stubEnv('PI_CODING_AGENT_DIR', f.root)
    vi.stubEnv('TWENTYX_SYNTHETIC_AGENT', '1'); vi.stubEnv('TWENTYX_FIXTURE_PROTOCOL', 'pi'); vi.stubEnv('TWENTYX_FIXTURE_RECEIPT', receipt)
    const adapter = new PiAdapter(); Object.assign(adapter, { piExecutablePath: cli }); f.useAdapter(adapter)
    cleanups.push(() => adapter.closeOwnedSessions())
    const old = await f.command('agent:create', [{ name: 'Controlled Pi', config: { coding_agent: 'pi' } }]) as AgentRecord
    const next = await f.command('agent:create', [{ name: 'Next configuration', config: { coding_agent: 'pi' } }]) as AgentRecord
    const project = await f.command('project:create', [{ name: 'Process ownership', captain_agent_id: old.id, settings: { captain_wakeups: { enabled: false } } }]) as ProjectRecord
    const captain = f.db.getCoordinatorTask(project.id)!, sessionId = await f.manager.startSession(old.id, captain.id, undefined, true)
    const processReceipt = JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number; runtime: string; electron: boolean; path: string; promptCount: number }
    expect(processReceipt).toMatchObject({ runtime: process.execPath, electron: !!process.versions.electron, path: empty, promptCount: 0 })
    expect(() => process.kill(processReceipt.pid, 0)).not.toThrow()
    await f.command('project:update', [project.id, { captain_agent_id: next.id }])
    expect(() => process.kill(processReceipt.pid, 0)).toThrow()
    expect(f.manager.getSession(sessionId)).toBeUndefined()
    expect(f.db.getProject(project.id)?.captain_agent_id).toBe(next.id)
    expect(f.events).toContainEqual({ operation: 'project:changed', payload: { projectId: project.id, kind: 'updated' } })
  })
  it('delivers the actual single overdue timer through the private peer only to readable scope and stops it at shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const f = await fixture(kind), before = f.db.getTasks()
    await f.service.owner.start(); await f.service.owner.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.events.filter(e => e.operation === 'overdue:check')).toEqual([{ operation: 'overdue:check', payload: {} }])
    expect(f.db.getTasks()).toEqual(before); expect(f.adapter.createSession).not.toHaveBeenCalled()
    f.blockedProjectReads.add(f.project.id)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.events.filter(e => e.operation === 'overdue:check')).toHaveLength(1)
    f.blockedProjectReads.clear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.events.filter(e => e.operation === 'overdue:check')).toHaveLength(2)
    await expect(f.host.request('overdue:check', {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await f.service.close(); await vi.advanceTimersByTimeAsync(120_000)
    expect(f.events.filter(e => e.operation === 'overdue:check')).toHaveLength(2)
  })
  it('reconciles every current retained command and event without treating codec presence as a proof', async () => {
    const f = await fixture(kind), runtime = f.bindings.operationSchemas(f.caller)
    await f.command('project:update', [f.project.id, { description: 'Reconciliation observation' }])
    const rows = Object.values(DESKTOP_OPERATION_MANIFEST).filter(row => row.disposition === 'retained')
    expect(new Set(rows.map(row => `${row.kind}/${row.name}`)).size).toBe(rows.length)
    const report = reconcileProductionDomains(f.bindings, f.caller, observations.get(kind)!)
    expect(report.rows).toHaveLength(rows.length)
    for (const row of report.rows) expect(row.runtimeBinding.sourceRegisteredInThisLaunch).toBe(row.kind === 'command' ? typeof runtime[row.name]?.handle === 'function' : null)
    expect(f.bindings.hasOwnerEvent('voice:status')).toBe(true)
    expect(report.rows.find(row => row.name === 'voice:status')?.runtimeBinding.sourceRegisteredInThisLaunch).toBeNull()
    expect(report.rows.find(row => row.name === 'voice:status')?.proof.observedSyntheticPrivatePeerEvents).toBe(0)
    expect(report.rows.find(row => row.name === 'project:update')?.proof.successfulSyntheticPrivatePeerCalls).toBeGreaterThan(0)
    expect(report.rows.find(row => row.name === 'voice:startTurn')?.runtimeBinding.sourceRegisteredInThisLaunch).toBe(false)
    if (process.env.TAURI_DOMAIN_RECONCILIATION_REPORT && kind === 'staged') writeFileSync(process.env.TAURI_DOMAIN_RECONCILIATION_REPORT, JSON.stringify({ ...report, runtime: { node: process.version, electron: !!process.versions.electron }, kind }, null, 2) + '\n')
  })
})

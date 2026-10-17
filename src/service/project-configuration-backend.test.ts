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
import { CodexAppServerAdapter } from '../main/adapters/codex-app-server-adapter'
import type { ChatProvider } from '../main/chat/providers/types'
import type { TaskSourcePlugin, ActionResult } from '../main/plugins/types'
import { TaskStatus, PluginActionId } from '../shared/constants'
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
async function fixture(kind: string, controlledProvider?: ChatProvider) {
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
        createProvider: () => controlledProvider ?? provider
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
    root,
    db,
    manager,
    services: actual,
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
  it('withdraws agent configuration authority between acknowledged Stops without stopping the next owner', async () => {
    const f = await fixture(kind), first = f.task('First config owner'), second = f.task('Second config owner'), agent = f.db.getAgents()[0]
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 3 } })
    await f.command('concurrency:pin', [f.project.id, agent.id, 3])
    await f.manager.startSession(agent.id, first.id, undefined, true)
    const secondSession = await f.manager.startSession(agent.id, second.id, undefined, true)
    expect(secondSession).not.toBe(''); expect(f.manager.findSessionByTaskId(second.id)).toBeDefined()
    const hold = deferred()
    f.adapter.destroySession.mockImplementationOnce(async () => { await hold.promise })
    const write = f.command('agent:update', [agent.id, { config: { coding_agent: 'pi', model: 'changed-model', max_parallel_sessions: 3 } }])
    const rejected = expect(write).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalledTimes(1))
    f.deny(); hold.resolve(); await rejected
    expect(f.adapter.destroySession).toHaveBeenCalledTimes(1)
    expect(f.manager.getSession(secondSession)).toBeDefined()
    expect(f.db.getAgent(agent.id)?.config.model).toBeUndefined()
  })
  it('withdraws secret authority between acknowledged Stops without mutating the key or stopping the next owner', async () => {
    const f = await fixture(kind), secret = await f.command('secrets:create', [{ name: 'Scoped token', description: '', env_var_name: 'SYNTHETIC_DOMAIN_TOKEN', value: 'synthetic-old' }]) as { id: string }
    const first = f.task('First secret owner'), second = f.task('Second secret owner'), agent = f.db.getAgents()[0]
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 3, secret_ids: [secret.id] } })
    await f.command('concurrency:pin', [f.project.id, agent.id, 3])
    await f.manager.startSession(agent.id, first.id, undefined, true)
    const secondSession = await f.manager.startSession(agent.id, second.id, undefined, true)
    expect(secondSession).not.toBe(''); expect(f.manager.findSessionByTaskId(second.id)).toBeDefined()
    const before = f.db.db.prepare('SELECT value FROM secrets WHERE id=?').get(secret.id)
    const hold = deferred()
    f.adapter.destroySession.mockImplementationOnce(async () => { await hold.promise })
    const write = f.command('secrets:update', [secret.id, { value: 'synthetic-new' }])
    const rejected = expect(write).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalledTimes(1))
    f.deny(); hold.resolve(); await rejected
    expect(f.adapter.destroySession).toHaveBeenCalledTimes(1)
    expect(f.manager.getSession(secondSession)).toBeDefined()
    expect(f.db.db.prepare('SELECT value FROM secrets WHERE id=?').get(secret.id)).toEqual(before)
  })
  it('withdraws subtree authority between acknowledged Stops without deleting rows or stopping the next child', async () => {
    const f = await fixture(kind), parent = f.db.createTask({ title: 'Owned parent', project_id: f.project.id })!
    const first = f.task('First child'), second = f.task('Second child'), agent = f.db.getAgents()[0]
    f.db.updateTask(first.id, { parent_task_id: parent.id }); f.db.updateTask(second.id, { parent_task_id: parent.id })
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 3 } })
    await f.command('concurrency:pin', [f.project.id, agent.id, 3])
    const firstSession = await f.manager.startSession(agent.id, first.id, undefined, true)
    const secondSession = await f.manager.startSession(agent.id, second.id, undefined, true)
    expect(secondSession).not.toBe(''); expect(f.manager.findSessionByTaskId(second.id)).toBeDefined()
    const hold = deferred()
    f.adapter.destroySession.mockImplementationOnce(async () => { await hold.promise })
    const write = f.command('db:deleteTask', [parent.id])
    const rejected = expect(write).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalledTimes(1))
    const firstStopped = f.adapter.destroySession.mock.calls[0][0]
    const retained = firstStopped === firstSession ? { taskId: second.id, sessionId: secondSession } : { taskId: first.id, sessionId: firstSession }
    f.blockedTaskWrites.add(retained.taskId); hold.resolve(); await rejected
    expect(f.adapter.destroySession).toHaveBeenCalledTimes(1)
    expect(f.manager.findSessionByTaskId(retained.taskId)?.sessionId).toBe(retained.sessionId)
    expect(f.db.getTask(parent.id)).toBeDefined(); expect(f.db.getTask(first.id)).toBeDefined(); expect(f.db.getTask(second.id)).toBeDefined()
  })
  it('acknowledges real configuration Stop and notification while metadata edits preserve the live owner', async () => {
    const f = await fixture(kind), agent = await f.command('agent:create', [{ name: 'Lifecycle agent', config: { coding_agent: 'pi' } }]) as AgentRecord
    const task = f.db.createTask({ title: 'Configuration target', project_id: f.project.id })!
    f.db.updateTask(task.id, { agent_id: agent.id })
    const sessionId = await f.manager.startSession(agent.id, task.id, undefined, true)
    const renamed = await f.command('agent:update', [agent.id, { name: 'Renamed owner' }]) as AgentRecord
    expect(renamed.name).toBe('Renamed owner'); expect(f.manager.getSession(sessionId)).toBeDefined()
    expect(f.adapter.destroySession).not.toHaveBeenCalled(); expect(f.adapter.notifyConfigChanged).not.toHaveBeenCalled()
    const stop = deferred(), notify = deferred()
    f.adapter.destroySession.mockImplementationOnce(async () => { await stop.promise })
    f.adapter.notifyConfigChanged.mockImplementationOnce(async () => { await notify.promise })
    let settled = false
    const update = f.command('agent:update', [agent.id, { config: { coding_agent: 'pi', model: 'changed-model' } }]).finally(() => { settled = true })
    await vi.waitFor(() => expect(f.adapter.destroySession).toHaveBeenCalledTimes(1))
    expect(f.db.getAgent(agent.id)?.config.model).toBeUndefined(); expect(settled).toBe(false)
    stop.resolve(); await vi.waitFor(() => expect(f.adapter.notifyConfigChanged).toHaveBeenCalledTimes(1))
    expect(f.db.getAgent(agent.id)?.config.model).toBe('changed-model'); expect(settled).toBe(false)
    notify.resolve(); await update
    expect(f.manager.getSession(sessionId)).toBeUndefined()
    expect((await f.command('agent:getAll', []) as AgentRecord[]).find(row => row.id === agent.id)?.config.model).toBe('changed-model')
    expect(await f.command('agent:delete', [agent.id])).toBe(true)
    expect(f.db.getTask(task.id)?.agent_id).toBeNull()
  })
  it('retains accepted configuration on notification refusal and requires explicit successful refresh before another start', async () => {
    const f = await fixture(kind), task = f.task('Notification target'), agent = f.db.getAgents()[0]
    await f.manager.startSession(agent.id, task.id, undefined, true)
    f.adapter.notifyConfigChanged.mockRejectedValueOnce(new Error('Synthetic refresh refusal'))
    const before = f.events.filter(event => event.operation === 'tasks:refresh').length
    await expect(f.command('agent:update', [agent.id, { config: { coding_agent: 'pi', model: 'accepted-model' } }])).rejects.toBeDefined()
    expect(f.db.getAgent(agent.id)?.config.model).toBe('accepted-model')
    expect(f.events.filter(event => event.operation === 'tasks:refresh')).toHaveLength(before + 1)
    const next = f.db.createTask({ title: 'After failed refresh', project_id: f.project.id })!
    f.db.updateTask(next.id, { agent_id: agent.id })
    await expect(f.manager.startSession(agent.id, next.id, undefined, true)).rejects.toThrow()
    expect(f.adapter.notifyConfigChanged).toHaveBeenCalledTimes(1)
    await f.command('agent:update', [agent.id, { config: { coding_agent: 'pi', model: 'accepted-model' } }])
    expect(f.adapter.notifyConfigChanged).toHaveBeenCalledTimes(2)
    expect(await f.manager.startSession(agent.id, next.id, undefined, true)).not.toBe('')
  })
  it('discovers providers and CLI models through actual controlled Pi and Codex processes with no system PATH or prompts', async () => {
    const f = await fixture(kind), node = process.env.TAURI_NODE_RUNTIME ?? (!process.versions.electron ? process.execPath : join(process.cwd(), 'src-tauri/resources/node/node'))
    const empty = join(f.root, 'empty-discovery-path'); mkdirSync(empty)
    vi.stubEnv('HOME', f.root); vi.stubEnv('PATH', empty); vi.stubEnv('PI_CODING_AGENT_DIR', f.root)
    vi.stubEnv('TWENTYX_SYNTHETIC_AGENT', '1')
    for (const protocol of ['pi', 'codex'] as const) {
      const cli = join(f.root, `controlled-${protocol}.cjs`), receipt = join(f.root, `${protocol}-discovery.json`)
      writeFileSync(cli, `#!${node}\n` + readFileSync(join(process.cwd(), 'test/fixtures/agent-rpc-process.cjs'), 'utf8'), { mode: 0o700 })
      vi.stubEnv('TWENTYX_FIXTURE_PROTOCOL', protocol); vi.stubEnv('TWENTYX_FIXTURE_RECEIPT', receipt)
      if (protocol === 'pi') {
        const adapter = new PiAdapter(); Object.assign(adapter, { piExecutablePath: cli }); f.useAdapter(adapter); cleanups.push(() => adapter.closeOwnedSessions())
        expect(await f.command('agentConfig:getProviders', [undefined, 'pi'])).toMatchObject({ providers: [{ id: 'synthetic-provider', models: [{ id: 'synthetic-model' }] }] })
      } else {
        const adapter = new CodexAppServerAdapter(); Object.assign(adapter, { codexExecutablePath: cli }); f.useAdapter(adapter); cleanups.push(() => adapter.closeOwnedSessions())
        expect(await f.command('agentConfig:listModels', ['codex'])).toEqual([{ id: 'synthetic-model', name: 'Synthetic model' }])
      }
      const raw = JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number; path: string; promptCount: number }
      expect(raw.path).toBe(empty); expect(raw.promptCount).toBe(0); expect(() => process.kill(raw.pid, 0)).toThrow()
    }
  })
  it('suppresses a cancelled raw model reply while keeping the actual provider work owned', async () => {
    const f = await fixture(kind), hold = deferred(), abort = new AbortController()
    f.adapter.getProviders.mockImplementationOnce(async () => { await hold.promise; return { providers: [{ id: 'synthetic', name: 'Synthetic', models: [{ id: 'late-model', name: 'Late model' }] }], default: {} } })
    const request = f.command('agentConfig:getProviders', [undefined, 'pi'], abort.signal)
    const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(f.adapter.getProviders).toHaveBeenCalledTimes(1))
    abort.abort(); await rejected
    expect(f.service.owner.snapshot().phase).toBe('ready')
    hold.resolve(); await vi.waitFor(() => expect(f.host.pendingCount).toBe(0))
  })
  it('returns unavailable for a missing cached Codex executable and joins its failed spawn without uncaught errors', async () => {
    const f = await fixture(kind), adapter = new CodexAppServerAdapter()
    Object.assign(adapter, { codexExecutablePath: join(f.root, 'absent-codex') }); f.useAdapter(adapter)
    cleanups.push(() => adapter.closeOwnedSessions())
    expect(await f.command('agentConfig:listModels', ['codex'])).toBeNull()
    expect(f.service.owner.snapshot().phase).toBe('ready')
    expect(await f.command('agent:getAll', [])).toBeInstanceOf(Array)
    await adapter.closeOwnedSessions()
  })
  it('round trips the full provider and secret storage formats through actual peer masking and exact clear/omitted semantics', async () => {
    const f = await fixture(kind), marker = '__21x_api_key_set__', value = '\uFEFF  synthetic-雪\nsecond-line  '
    for (const key of ['openai_api_key', 'anthropic_api_key', 'google_api_key', 'cursor_api_key']) {
      await f.command('settings:set', [key, value])
      const row = f.db.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string }
      expect(row.value).toMatch(/^21x-credential:21x\.aes256gcm\.v1:/); expect(row.value).not.toContain('synthetic-雪')
      expect(f.db.getSetting(key)).toBe(value); expect(await f.command('settings:get', [key])).toBe(marker)
      await f.command('settings:set', [key, marker]); expect(f.db.db.prepare('SELECT value FROM settings WHERE key=?').get(key)).toEqual(row)
      await f.command('settings:set', [key, '']); expect(await f.command('settings:get', [key])).toBe('')
    }
    expect(await f.command('settings:get', ['heartbeat_global_instructions'])).toBeNull()
    const secret = await f.command('secrets:create', [{ name: 'Scoped secret', description: '', env_var_name: 'SYNTHETIC_DOMAIN_TOKEN', value }]) as { id: string }
    const raw = f.db.db.prepare('SELECT value FROM secrets WHERE id=?').get(secret.id) as { value: Buffer }
    expect(Buffer.isBuffer(raw.value)).toBe(true); expect(raw.value.toString()).not.toContain('synthetic-雪')
    expect(f.db.getSecretsWithValues([secret.id])[0]?.value).toBe(value)
    await f.command('secrets:update', [secret.id, { description: 'Metadata only' }]); expect(f.db.db.prepare('SELECT value FROM secrets WHERE id=?').get(secret.id)).toEqual(raw)
    const metadata = await f.command('secrets:getAll', []); expect(JSON.stringify(metadata)).not.toContain('synthetic-雪'); expect(JSON.stringify(metadata)).not.toContain('"value"')
    await f.command('secrets:update', [secret.id, { value: '' }]); expect(f.db.getSecretsWithValues([secret.id])[0]?.value).toBe('')
    expect(await f.command('secrets:delete', [secret.id])).toBe(true)
    expect(JSON.stringify(f.events)).not.toContain('synthetic-雪')
  })
  it('fences and drains actual Chat Commander and briefing work before the private settings write', async () => {
    const hold = deferred(), signals: AbortSignal[] = []
    const provider: ChatProvider = { id: 'controlled', model: 'controlled', async *stream(_request, signal) { signals.push(signal); await hold.promise; yield { type: 'message_end', stopReason: 'end_turn' } } }
    const f = await fixture(kind, provider)
    const chat = f.services.chat.startTurn({ provider, messages: [{ role: 'user', content: 'Synthetic chat' }] }, () => {})
    const session = f.services.commanderStore.createSession(), commander = f.services.commander.sendUserMessage(session.id, 'Synthetic commander'), briefing = f.services.coordination.runBriefingNow()
    await vi.waitFor(() => expect(signals).toHaveLength(3))
    const write = f.command('settings:set', ['openai_api_key', 'synthetic-new-key'])
    await vi.waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true))
    expect(f.db.getSetting('openai_api_key')).toBeUndefined()
    expect(() => f.services.chat.startTurn({ provider, messages: [] }, () => {})).toThrow('CONFIGURATION_CHANGING')
    hold.resolve(); await Promise.all([chat.done, commander.done, briefing, write])
    expect(await f.command('settings:get', ['openai_api_key'])).toBe('__21x_api_key_set__')
    await f.services.chat.startTurn({ provider, messages: [] }, () => {}).done
  })
  it('uses real subtask order and recurrence owners while snoozed automation remains dormant', async () => {
    const f = await fixture(kind), parent = await f.command('db:createTask', [{ title: 'Parent', auto_start_agent: false }]) as import('../main/database/types').TaskRecord
    const one = await f.command('db:createTask', [{ title: 'First child', parent_task_id: parent.id }]) as typeof parent
    const two = await f.command('db:createTask', [{ title: 'Second child', parent_task_id: parent.id }]) as typeof parent
    expect(await f.command('db:reorderSubtasks', [parent.id, [two.id, one.id]])).toBe(true)
    expect((await f.command('db:getSubtasks', [parent.id]) as typeof parent[]).map(t => t.id)).toEqual([two.id, one.id])
    await expect(f.command('db:reorderSubtasks', [parent.id, [one.id]])).rejects.toBeDefined()
    const template = await f.command('db:createTask', [{ title: 'Recurring', is_recurring: true, recurrence_pattern: '0 9 * * 1', auto_start_agent: false }]) as typeof parent
    expect(template.next_occurrence_at).not.toBeNull()
    f.db.db.prepare('UPDATE tasks SET next_occurrence_at=? WHERE id=?').run('2026-10-12T09:00:00.000Z', template.id)
    await f.services.recurrence.runNow(); expect(f.service.owner.snapshot().phase).toBe('ready'); await f.services.recurrence.runNow()
    expect(f.db.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE recurrence_parent_id=?').get(template.id)).toEqual({ count: 1 })
    const instance = f.db.db.prepare('SELECT id FROM tasks WHERE recurrence_parent_id=?').get(template.id) as { id: string }
    const notice = f.events.find(event => event.operation === 'task:created' && isRecord(event.payload) && isRecord(event.payload.task) && event.payload.task.id === instance.id)
    expect(notice).toBeDefined(); expect(JSON.stringify(notice)).not.toContain('mcp_scope_nonce')
    const task = f.task('Snoozed owner')
    await f.command('db:updateTask', [task.id, { snoozed_until: '2099-01-01T00:00:00.000Z', auto_start_agent: true }])
    await f.services.automation.runNow(); expect(f.manager.findSessionByTaskId(task.id)).toBeUndefined()
    await f.command('db:updateTask', [task.id, { snoozed_until: null }]); await f.services.automation.runNow()
    await vi.waitFor(() => expect(f.manager.findSessionByTaskId(task.id)).toBeDefined())
    expect(f.events.some(e => e.operation === 'task:subtasks-reordered')).toBe(true)
  })
  it('routes source completion through the actual SyncManager and preserves review after refusal or withdrawn source authority', async () => {
    const f = await fixture(kind)
    let result: ActionResult = { success: false, error: 'Synthetic refusal' }, wait: Promise<void> | undefined
    const execute = vi.fn(async (): Promise<ActionResult> => { await wait; return result })
    const plugin: TaskSourcePlugin = { id: 'notion', displayName: 'Controlled source', description: 'Synthetic local provider boundary', icon: '', getConfigSchema: () => [], getActions: () => [{ id: PluginActionId.Complete, label: 'Complete' }],
      resolveOptions: async () => [], importTasks: async () => ({ imported: 0, updated: 0, errors: [] }), exportUpdate: async () => {}, executeAction: execute }
    f.services.registry.register(plugin)
    const source = await f.command('taskSource:create', [{ name: 'Controlled source', plugin_id: 'notion', mcp_server_id: null, config: { data_source_id: 'synthetic-data' } }]) as { id: string }
    await f.command('taskSource:update', [source.id, { enabled: false }])
    const task = f.db.createTask({ title: 'Imported source task', source: 'Controlled source', source_id: source.id, external_id: 'synthetic-external', status: TaskStatus.ReadyForReview, project_id: f.project.id })!
    expect(await f.command('plugin:executeAction', [PluginActionId.Complete, task.id, source.id])).toMatchObject({ success: false })
    expect(f.db.getTask(task.id)?.status).toBe(TaskStatus.ReadyForReview)
    result = { success: true, taskUpdate: { status: TaskStatus.Completed } }; const hold = deferred(); wait = hold.promise
    const write = f.command('plugin:executeAction', [PluginActionId.Complete, task.id, source.id]); const rejected = expect(write).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2)); f.blockedSources.add(source.id); hold.resolve(); await rejected
    expect(f.db.getTask(task.id)?.status).toBe(TaskStatus.ReadyForReview)
    f.blockedSources.clear(); wait = undefined
    expect(await f.command('plugin:executeAction', [PluginActionId.Complete, task.id, source.id])).toMatchObject({ success: true })
    expect(f.db.getTask(task.id)?.status).toBe(TaskStatus.Completed)
    expect(f.events.some(e => e.operation === 'task:updated' && isRecord(e.payload) && e.payload.taskId === task.id)).toBe(true)
  })
  it('finishes actual session learning only after workspace skill sync and the user completion choice', async () => {
    const f = await fixture(kind), task = f.task('Learning owner'), agent = f.db.getAgents()[0]
    const sessionId = await f.manager.startSession(agent.id, task.id, undefined, true)
    const session = f.manager.getSession(sessionId)!
    expect(session.workspaceDir).toBeTruthy()
    const skillDir = join(session.workspaceDir!, '.agents', 'skills', 'learned-locally')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: learned-locally\ndescription: Synthetic learning\n---\n\nRemember the controlled result.')
    await f.command('db:updateTask', [task.id, { status: TaskStatus.AgentLearning, feedback_rating: 5, complete_at_source: false }])
    expect(f.db.getTask(task.id)?.status).toBe(TaskStatus.AgentLearning)
    const entries = Reflect.get(f.manager, 'pollingEntries') as Map<string, unknown>
    const entry = entries.get(sessionId)
    expect(entry).toBeDefined()
    // Exercise the actual poll/transition owner using controlled provider status;
    // no DB transition, learning callback or skill-sync result is substituted.
    const poll = () => Reflect.apply(Reflect.get(f.manager, 'pollSingleSession'), f.manager, [entry]) as Promise<void>
    await poll()
    f.adapter.getStatus.mockResolvedValue({ type: 'idle' })
    await poll()
    await vi.waitFor(() => expect(f.db.getTask(task.id)?.status).toBe(TaskStatus.Completed))
    expect(f.db.getSkillByName('learned-locally')).toMatchObject({ content: 'Remember the controlled result.', project_id: f.project.id })
    expect(f.db.getSetting(`session-feedback-completion:${task.id}`)).toBeUndefined()
    expect(f.events.some(event => event.operation === 'task:updated' && isRecord(event.payload) && event.payload.taskId === task.id && isRecord(event.payload.updates) && event.payload.updates.status === TaskStatus.Completed)).toBe(true)
    expect(f.service.owner.snapshot().phase).toBe('ready')
  })
  it('enforces the real daily session cap and admits the retained FIFO request only after an authorized limit increase', async () => {
    const f = await fixture(kind), first = f.task('Daily first'), second = f.task('Daily queued'), agent = f.db.getAgents()[0]
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi', max_parallel_sessions: 3 } })
    await f.command('concurrency:pin', [f.project.id, agent.id, 3])
    await f.command('project:update', [f.project.id, { settings: { captain_wakeups: { enabled: false }, limits: { daily_session_cap: 1 } } }])
    const one = await f.command('agentSession:start', [agent.id, first.id, undefined, true]) as { sessionId: string }
    expect(one.sessionId).not.toBe('')
    const queued = await f.command('agentSession:start', [agent.id, second.id, undefined, true])
    expect(queued).toMatchObject({ queued: true, queuePosition: 1, queueReason: 'project_daily_cap' })
    expect(await f.command('projectLimits:getState', [f.project.id])).toMatchObject({ dailySessionCap: 1, sessionsStartedToday: 1, blockedBy: 'project_daily_cap' })
    await f.command('agentSession:stopByTaskId', [first.id])
    expect(f.manager.findSessionByTaskId(second.id)).toBeUndefined()
    await f.command('project:update', [f.project.id, { settings: { captain_wakeups: { enabled: false }, limits: { daily_session_cap: 2 } } }])
    await vi.waitFor(() => expect(f.manager.findSessionByTaskId(second.id)).toBeDefined())
    expect(await f.command('projectLimits:getState', [f.project.id])).toMatchObject({ dailySessionCap: 2, sessionsStartedToday: 2, blockedBy: 'project_daily_cap', queued: [] })
  })
  it.each(['agentConfig:getProviders', 'agentConfig:listModels'] as const)('rejects a held %s result after the authorized default endpoint changes instead of publishing the old endpoint models', async operation => {
    const f = await fixture(kind), agent = f.db.getAgents()[0], hold = deferred(), oldUrl = agent.server_url
    if (operation === 'agentConfig:getProviders') f.adapter.getProviders.mockImplementationOnce(async () => { await hold.promise; return { providers: [{ id: 'old-target', name: 'Old target', models: [{ id: 'old-model', name: 'Old model' }] }], default: {} } })
    else f.adapter.listModels.mockImplementationOnce(async () => { await hold.promise; return [{ id: 'old-model', name: 'Old model' }] })
    const request = f.command(operation, operation === 'agentConfig:getProviders' ? [undefined, 'pi'] : ['pi'])
    const rejected = expect(request).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await vi.waitFor(() => expect(operation === 'agentConfig:getProviders' ? f.adapter.getProviders : f.adapter.listModels).toHaveBeenCalledTimes(1))
    await f.command('agent:update', [agent.id, { server_url: 'http://localhost:4097' }])
    f.blockedBackendUrls.add(oldUrl); hold.resolve(); await rejected
    expect(f.service.owner.snapshot().phase).toBe('ready')
    expect((await f.command('agent:getAll', []) as AgentRecord[]).find(row => row.id === agent.id)?.server_url).toBe('http://localhost:4097')
  })
  it('keeps the accepted destination backend fenced when the previous backend notification refuses during a backend switch', async () => {
    const f = await fixture(kind), task = f.task('Switch owner'), agent = f.db.getAgents()[0]
    await f.manager.startSession(agent.id, task.id, undefined, true)
    const second = { ...f.adapter, createSession: vi.fn(async () => 'synthetic_codex_session'), notifyConfigChanged: vi.fn(async () => {}) }
    const other = await f.command('agent:create', [{ name: 'Cached Codex', config: { coding_agent: 'codex' } }]) as AgentRecord
    const cache = f.db.createTask({ title: 'Cached backend task', project_id: f.project.id })!
    f.db.updateTask(cache.id, { agent_id: other.id }); f.useAdapter(second as unknown as CodingAgentAdapter)
    await f.manager.startSession(other.id, cache.id, undefined, true); await f.manager.stopByTaskId(cache.id)
    f.adapter.notifyConfigChanged.mockRejectedValueOnce(new Error('Synthetic old backend refusal'))
    await expect(f.command('agent:update', [agent.id, { config: { coding_agent: 'codex', model: 'accepted-model' } }])).rejects.toBeDefined()
    expect(f.db.getAgent(agent.id)?.config.coding_agent).toBe('codex'); expect(second.notifyConfigChanged).not.toHaveBeenCalled()
    const next = f.db.createTask({ title: 'New backend task', project_id: f.project.id })!; f.db.updateTask(next.id, { agent_id: agent.id })
    await expect(f.manager.startSession(agent.id, next.id, undefined, true)).rejects.toThrow()
    await f.command('agent:update', [agent.id, { config: { coding_agent: 'codex', model: 'accepted-model' } }])
    expect(second.notifyConfigChanged).toHaveBeenCalledTimes(1)
    expect(await f.manager.startSession(agent.id, next.id, undefined, true)).not.toBe('')
  })
  it('keeps every unrefreshed credential backend fenced after the first actual notification refuses', async () => {
    const f = await fixture(kind), secret = await f.command('secrets:create', [{ name: 'Shared refresh token', description: '', env_var_name: 'SYNTHETIC_REFRESH_TOKEN', value: 'synthetic-old' }]) as { id: string }
    const task = f.task('Pi credential owner'), agent = f.db.getAgents()[0]
    f.db.updateAgent(agent.id, { config: { coding_agent: 'pi', secret_ids: [secret.id] } })
    await f.manager.startSession(agent.id, task.id, undefined, true)
    const second = { ...f.adapter, createSession: vi.fn(async () => 'synthetic_other_session'), notifyConfigChanged: vi.fn(async (): Promise<void> => { throw new Error('Synthetic second refusal') }) }
    const other = await f.command('agent:create', [{ name: 'Other credential owner', config: { coding_agent: 'codex', secret_ids: [secret.id] } }]) as AgentRecord
    const otherTask = f.db.createTask({ title: 'Codex credential task', project_id: f.project.id })!
    f.db.updateTask(otherTask.id, { agent_id: other.id }); f.useAdapter(second as unknown as CodingAgentAdapter)
    await f.manager.startSession(other.id, otherTask.id, undefined, true)
    f.adapter.notifyConfigChanged.mockRejectedValueOnce(new Error('Synthetic first refusal'))
    await expect(f.command('secrets:update', [secret.id, { value: 'synthetic-new' }])).rejects.toBeDefined()
    expect(f.db.getSecretsWithValues([secret.id])[0]?.value).toBe('synthetic-new')
    const unrefreshed = f.adapter.notifyConfigChanged.mock.calls.length === 0 ? agent : other
    const next = f.db.createTask({ title: 'Unrefreshed backend task', project_id: f.project.id })!; f.db.updateTask(next.id, { agent_id: unrefreshed.id })
    await expect(f.manager.startSession(unrefreshed.id, next.id, undefined, true)).rejects.toThrow()
    f.adapter.notifyConfigChanged.mockReset().mockResolvedValue(undefined); second.notifyConfigChanged.mockReset().mockImplementation(async () => {})
    await f.command('secrets:update', [secret.id, { value: 'synthetic-new' }])
    expect(f.adapter.notifyConfigChanged).toHaveBeenCalled(); expect(second.notifyConfigChanged).toHaveBeenCalled()
    expect(await f.manager.startSession(unrefreshed.id, next.id, undefined, true)).not.toBe('')
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

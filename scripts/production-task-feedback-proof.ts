import { createHash } from 'node:crypto'
import { execFile, type ChildProcess, type ExecFileException, type ExecFileOptions } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir, release as osRelease } from 'node:os'
import { join, resolve } from 'node:path'
import { ProductionService, sealProductionServiceHost } from '../src/service/production-service'
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions, type ProductionDesktopBindings } from '../src/service/production-desktop-bindings'
import { PRODUCTION_HOST_SCHEMAS, type ProductionLaunchDescriptor } from '../src/shared/production-bootstrap'
import { ServicePeer, type OperationSchema } from '../src/service/transport/peer'
import { isBootstrapResult, isRecord, ServiceProtocolError, type JsonValue, type ServiceErrorCode } from '../src/shared/service-protocol'
import { GitProviderProcessOwner } from '../src/main/git-provider-process-owner'
import { SessionStatusType, type CodingAgentAdapter, type SessionConfig } from '../src/main/adapters/coding-agent-adapter'
import { getTaskApiPort, getTaskApiToken } from '../src/main/task-api-server-core'
import { PRODUCTION_INCOMPATIBLE_SESSION_ERROR } from '../src/shared/production-agent-events'
import { TASK_SOURCE_ACTION_ERROR } from '../src/shared/task-feedback-event-codecs'

export const TASK_FEEDBACK_FIXTURE = Object.freeze({ version: 1, fragmentBytes: 61, timeoutMs: 15_000, eventBytes: 2048, titleBytes: 512, maxRequests: 64 })
export const TASK_FEEDBACK_EVENTS = ['agent:incompatible-session', 'task:checkpointAnswered', 'task:source-action-failed'] as const
type Notice = { operation: string; payload: JsonValue; engineEpoch: string; sequence: number }
type Barrier = { entered: Promise<void>; enter(): void; finish: Promise<void>; release(): void }
function barrier(): Barrier {
  let enter!: () => void, release!: () => void
  return { entered: new Promise<void>(done => { enter = done }), enter: () => enter(), finish: new Promise<void>(done => { release = done }), release: () => release() }
}
async function bounded<T>(label: string, raw: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([raw, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`TASK_FEEDBACK_PROOF deadline: ${label}`)), TASK_FEEDBACK_FIXTURE.timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
export function feedbackTitleIsBounded(title: string): boolean { return !!title.trim() && !title.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(title) && Buffer.byteLength(title) <= TASK_FEEDBACK_FIXTURE.titleBytes }
export interface TaskFeedbackProofReport {
  version: 1
  scope: string
  provenance: { platform: string; architecture: string; osRelease: string; node: string; sqlite: string; webview: null; sources: Record<string, string>; artifacts: Record<string, string> }
  counters: Array<{ name: string; expected: number; actual: number }>
  notices: Notice[]
  encoding: Array<{ operation: string; succeeded: boolean; raw: ReturnType<typeof encodingMetrics>; encoded: ReturnType<typeof encodingMetrics> | null; code: string | null }>
  raw: { adapterCreates: number; adapterResumes: number; adapterApprovals: number; adapterDestroys: number; sourceCommands: number; sourceCallbacks: number; sourceChildren: number; sourceStdio: number; nativeDrainAcks: number }
  cleanup: { ownerStopped: boolean; profileRemoved: boolean }
  remaining: string[]
}
/** Bounded diagnostic shape only. No task text, source/backend values, IDs or
 * secrets are returned, and diagnostic serialization cannot mask owner errors. */
function encodingMetrics(value: unknown) {
  const shape = (input: unknown): unknown => {
    if (typeof input === 'string') return { type: 'string', codeUnits: input.length, utf8: Buffer.byteLength(input) }
    if (Array.isArray(input)) return { type: 'array', length: input.length }
    if (isRecord(input)) return { type: 'object', keys: Object.keys(input).slice(0, 64), fields: Object.fromEntries(Object.entries(input).slice(0, 64).map(([key, field]) => [key, typeof field])) }
    return { type: input === null ? 'null' : typeof input }
  }
  try {
    const json = JSON.stringify(value)
    return { shape: shape(value), nested: isRecord(value) && isRecord(value.updates) ? shape(value.updates) : null, bytes: json === undefined ? null : Buffer.byteLength(json), serializable: true }
  } catch { return { shape: { type: 'uninspectable' }, nested: null, bytes: null, serializable: false } }
}

/** Actual source owners and private transport. Adapter and CLI outcomes are
 * controlled disposable boundaries, not vendor/native/page acceptance. */
export async function runProductionTaskFeedbackProof(): Promise<TaskFeedbackProofReport> {
  const pins = JSON.parse(readFileSync(resolve('scripts/tauri-runtime.json'), 'utf8')) as { nodeVersion: string; nativeDependencies: Record<string, string> }
  const sqlite = process.env.TAURI_SQLITE_MODULE
  if (process.platform !== 'linux' || process.version !== `v${pins.nodeVersion}` || process.versions.electron || !process.env.TAURI_NODE_RUNTIME || realpathSync(process.execPath) !== realpathSync(process.env.TAURI_NODE_RUNTIME) || !sqlite || realpathSync(sqlite) !== realpathSync(resolve('src-tauri/resources/service/node_modules/better-sqlite3'))) throw new Error('TASK_FEEDBACK_PROOF requires explicitly staged pinned Linux Node/SQLite')
  const packageBytes = readFileSync(join(sqlite, 'package.json')), metadata = JSON.parse(packageBytes.toString())
  if (metadata.name !== 'better-sqlite3' || metadata.version !== pins.nativeDependencies['better-sqlite3']) throw new Error('TASK_FEEDBACK_PROOF SQLite version mismatch')
  const sourcePaths = ['scripts/production-task-feedback-proof.ts', 'scripts/production-task-feedback-proof.test.ts', 'src/service/production-task-feedback-acceptance.test.ts',
    'src/service/production-service.ts', 'src/service/production-owner.ts', 'src/service/production-desktop-bindings.ts', 'src/service/production-agent-backend.ts',
    'src/shared/production-agent-events.ts', 'src/shared/task-feedback-event-codecs.ts', 'src/main/agent-manager-core.ts', 'src/main/task-api/session-routes.ts',
    'src/main/task-api/state.ts', 'src/main/task-api-server-core.ts', 'src/main/session-feedback.ts', 'src/main/sync-manager.ts', 'src/main/plugins/github-issues-plugin.ts', 'src/main/git-provider-process-owner.ts',
    'src/shared/desktop-api.ts', 'src/shared/desktop-operations.ts', 'src-tauri/engine/src/production_contracts.rs', 'src-tauri/src/production_host.rs',
    'src/renderer/src/lib/tauri-desktop-transport.ts', 'src/renderer/src/lib/native-desktop-host.ts']
  const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-task-feedback-'))), keys = new Map<string, Buffer>()
  mkdirSync(join(root, 'resources'))
  const raw = { adapterCreates: 0, adapterResumes: 0, adapterApprovals: 0, adapterDestroys: 0, sourceCommands: 0, sourceCallbacks: 0, sourceChildren: 0, sourceStdio: 0, nativeDrainAcks: 0 }
  const report: TaskFeedbackProofReport = { version: 1, scope: 'actual-source-production-owner-authenticated-task-api-private-peer-controlled-adapter-source', provenance: {
    platform: process.platform, architecture: process.arch, osRelease: osRelease(), node: process.version, sqlite: metadata.version, webview: null,
    sources: Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(resolve(path)))])), artifacts: { node: digest(readFileSync(process.execPath)), sqlitePackage: digest(packageBytes), sqliteAddon: digest(readFileSync(join(sqlite, `prebuilds/${process.platform}-${process.arch}.node`))) } },
    counters: [], notices: [], encoding: [], raw, cleanup: { ownerStopped: false, profileRemoved: false }, remaining: [
      'Node sender/private-peer/projection receipts do not establish native window/document or renderer consumer delivery; separate owned-source tests supplement them.',
      'Controlled local adapter and failing source CLI are not installed vendor/provider or authorized remote source mutation acceptance.',
      'Full learning/skill/checkpoint/source/platform acceptance and explicit #202 prerequisite remain open; no whole #210 closure.' ] }
  const check = (name: string, expected: number, actual: number): void => { report.counters.push({ name, expected, actual }); if (!Number.isFinite(actual) || actual !== expected) throw new Error(`TASK_FEEDBACK_PROOF ${name}: expected ${expected}, actual ${actual}`) }
  const watchers = new Set<() => void>(), notify = (): void => { for (const watcher of watchers) watcher() }
  const until = async (label: string, predicate: () => boolean): Promise<void> => {
    if (predicate()) return
    let done!: () => void
    const finished = new Promise<void>(resolveDone => { done = resolveDone }), watcher = (): void => { if (predicate()) done() }
    watchers.add(watcher)
    try { watcher(); await bounded(label, finished) } finally { watchers.delete(watcher) }
  }
  const holds: Barrier[] = [], children: Array<{ child: ChildProcess; closed: Promise<void> }> = []
  const sessions = new Map<string, { config: SessionConfig; status: SessionStatusType; pending: boolean; requestId: string }>()
  let approvalHold: Barrier | null = null, approvalHandled = true
  const privateMarker = 'DISPOSABLE_PRIVATE_BACKEND_TOKEN_34'
  const adapter: CodingAgentAdapter & { respondToApproval(sessionId: string, approved: boolean, option?: string, requestId?: string): Promise<boolean> } = {
    initialize: async () => {}, checkHealth: async () => ({ available: true }),
    createSession: async config => { const id = `feedback_native_${++raw.adapterCreates}`; sessions.set(id, { config, status: SessionStatusType.BUSY, pending: true, requestId: `permission_${raw.adapterCreates}` }); return id },
    resumeSession: async () => { raw.adapterResumes++; throw new Error(`INCOMPATIBLE_SESSION_ID ${privateMarker}`) },
    getStatus: async id => { const status = sessions.get(id)?.status ?? SessionStatusType.ERROR; queueMicrotask(notify); return { type: status } },
    sendPrompt: async () => {}, pollMessages: async () => [], getAllMessages: async () => [], abortPrompt: async () => {},
    getPendingRequests: async id => { const entry = sessions.get(id); return entry?.pending ? [{ requestId: entry.requestId, responseType: 'permission' }] : [] },
    respondToApproval: async (id, _approved, _option, requestId) => {
      raw.adapterApprovals++; const entry = sessions.get(id), held = approvalHold; approvalHold = null
      if (held) { held.enter(); await held.finish }
      if (!entry || !sessions.has(id) || !entry.pending || requestId !== entry.requestId || !approvalHandled) return false
      entry.pending = false; entry.status = SessionStatusType.BUSY; return true
    }, destroySession: async id => { raw.adapterDestroys++; sessions.delete(id); notify() }
  }
  const sourceScript = join(root, 'source-refusal.cjs')
  writeFileSync(sourceScript, `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['api','-X','PATCH','/repos/fixture-owner/fixture-repo/issues/7','-f','state=closed'])){process.stderr.write('UNEXPECTED_FIXTURE_COMMAND');process.exitCode=93}else{process.stderr.write('${privateMarker}');process.exitCode=1}`)
  report.provenance.artifacts.sourceFixture = digest(readFileSync(sourceScript))
  const descriptor: ProductionLaunchDescriptor = { version: 1, kind: 'production-private-launch', launchId: 'launch_feedback_proof_001', profileId: 'feedback-disposable', profileIntent: 'create-new', buildIdentity: 'source-feedback-fixture-v1', resourceManifestSha256: 'b'.repeat(64),
    paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), resourceRoot: join(root, 'resources'), tempRoot: join(root, 'temp') },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
  let trusted = true, denyTask = false, denyProject = false, deniedProjectId: string | null = null, denyAgent = false, denySource = false, expectedClose = false, disconnecting = false, fatalDisconnects = 0
  const disconnectCodes: Partial<Record<'service' | 'host', ServiceErrorCode>> = {}
  const trustedCaller: ProductionDesktopBindingOptions['authority']['isTrustedDesktop'] = caller => trusted && caller.principal === 'trusted-desktop-main' && caller.webviewId === 'main' && caller.origin === 'tauri://localhost' && caller.engineEpoch === service.owner.snapshot().epoch
  const authority: ProductionDesktopBindingOptions['authority'] = {
    isTrustedDesktop: trustedCaller, canAccessTask: (_id, caller, access) => trustedCaller(caller) && (access !== 'read' || !denyTask),
    canAccessProject: (id, caller, access) => trustedCaller(caller) && (access !== 'read' || !denyProject && id !== deniedProjectId), canAccessAgent: (_id, caller, access) => trustedCaller(caller) && (access !== 'read' || !denyAgent),
    canAccessSource: (_id, caller, access) => trustedCaller(caller) && (access !== 'read' || !denySource), canAccessSession: () => trusted, canAccessGlobalCommander: () => trusted,
    canManageGlobalConfiguration: () => trusted, canQueryBackend: () => trusted, canCreateProject: () => trusted, canEditSettings: () => trusted,
    canAccessGlobalSkills: () => trusted, canChangeSkillScope: () => trusted, canReorderProjects: () => trusted, canReadSetting: () => trusted, canWriteSetting: () => trusted, canAccessSecret: () => trusted,
    canCreateSecret: () => trusted, canUseSecretEnvironment: () => trusted, canReadEnvironment: () => trusted, canAccessTerminal: () => trusted, canAccessMcpServer: () => trusted, canAccessCli: () => trusted, canUseTransport: () => trusted,
    canUseEnvironmentName: () => trusted, canAccessConnector: () => trusted, canUseSourcePlugin: () => trusted, canCreateInstance: () => trusted, canUsePiece: () => trusted, canBorrowSourceCredentials: () => trusted,
    canResolveUnsavedConfig: () => trusted, canManageMobile: () => trusted, canAccessMobileSession: () => trusted, canAccessMarketplace: () => trusted, canCreateMarketplace: () => trusted,
    canAccessPluginName: () => trusted, canAccessPlugin: () => trusted, canUseMarketplaceSource: () => trusted, canUsePluginAddress: () => trusted, canUsePluginSource: () => trusted,
    canAccessSkill: () => trusted, canCreateGlobalSkill: () => trusted, canCreateAgent: () => trusted, canCreateMcpServer: () => trusted, resolveTerminalDirectory: () => null
  }
  const disconnect = (side: 'service' | 'host', error: ServiceProtocolError): void => {
    disconnectCodes[side] ??= error.code
    if (disconnecting) return
    if (!expectedClose || error.code !== 'DISCONNECTED') fatalDisconnects++
    disconnecting = true
    try { if (side === 'service') host?.disconnect(error.code); else service?.peer.disconnect(error.code) } finally { disconnecting = false }
  }
  const deliver = (peer: ServicePeer, bytes: Uint8Array): void => { for (let at = 0; at < bytes.length; at += TASK_FEEDBACK_FIXTURE.fragmentBytes) peer.receive(bytes.subarray(at, at + TASK_FEEDBACK_FIXTURE.fragmentBytes)) }
  const schemas: Record<string, OperationSchema> = Object.fromEntries(Object.entries(PRODUCTION_COMMAND_CODECS).map(([name, codec]) => [name, { validatePayload: value => { try { return codec.validateArguments(codec.decodeArguments(value as JsonValue)) } catch { return false } }, validateResult: codec.validateWireResult }]))
  schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }; schemas['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['host.production.prepare'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.prepare'], handle: () => ({ launchId: descriptor.launchId, ready: true, processTree: 'supervised' }) }
  schemas['host.production.drain'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.drain'], handle: () => { raw.nativeDrainAcks++; return { launchId: descriptor.launchId, acknowledged: true } } }
  const unbridged = new Map<string, number>()
  const observedStatuses = new Map<string, string>()
  const service: ProductionService = new ProductionService(sealProductionServiceHost({ descriptor, authority, caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' }, unbridgedOwnerEvent: name => unbridged.set(name, (unbridged.get(name) ?? 0) + 1),
    boundaries: { cliMcp: { homeDir: root, environment: {} }, createAdapter: () => adapter, createProvider: () => { throw new Error('TASK_FEEDBACK_PROOF unexpected provider') },
      gitProviderProcess: options => new GitProviderProcessOwner({ ...options, home: root, environment: { PATH: '/usr/bin:/bin' }, fixture: { executables: { gh: { file: process.execPath, prefix: [sourceScript] } } },
        execFile: ((file: string, args: string[], options: ExecFileOptions, callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void) => {
          if (file !== process.execPath || args[0] !== sourceScript || raw.sourceCommands >= TASK_FEEDBACK_FIXTURE.maxRequests) throw new Error('TASK_FEEDBACK_PROOF unexpected source executable')
          raw.sourceCommands++; const child = execFile(file, args, { ...options, env: { PATH: '/usr/bin:/bin', HOME: root }, encoding: 'utf8' }, (error, stdout, stderr) => { raw.sourceCallbacks++; callback(error, stdout, stderr) })
          const closed = new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => { raw.sourceChildren++; if (code === 1 && signal === null) done(); else reject(new Error('TASK_FEEDBACK_PROOF source fixture did not return its exact refusal')) }) }); void closed.catch(() => {}); children.push({ child, closed });
          child.stdout?.once('close', () => { raw.sourceStdio++ }); child.stderr?.once('close', () => { raw.sourceStdio++ }); return child }) as typeof execFile }) },
    constructBootstrap: callbacks => ({ profileId: descriptor.profileId, paths: descriptor.paths, credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => Buffer.from(keys.get(id)!) } }, connectors: { kind: 'disabled', reason: 'Synthetic feedback acceptance' }, managedTaskMcp: { disabled: true },
      native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' }, prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent, openExternal: callbacks.openExternal, notify: callbacks.notify, sendUiCommand: () => ({ ok: false, detail: 'No fixture UI' }) } })
  }), { write: async bytes => deliver(host, bytes), onDisconnect: error => disconnect('service', error) })
  const host: ServicePeer = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas, eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(name => [name, payload => validateProductionEventWire(name, payload)])),
    onEvent: event => {
      if ((TASK_FEEDBACK_EVENTS as readonly string[]).includes(event.operation)) report.notices.push({ operation: event.operation, payload: event.payload, engineEpoch: event.engineEpoch, sequence: event.sequence ?? -1 })
      if (event.operation === 'agent:status' && isRecord(event.payload) && typeof event.payload.status === 'string' && typeof event.payload.sessionId === 'string') observedStatuses.set(event.payload.sessionId, event.payload.status)
      notify()
    }, write: async bytes => deliver(service.peer, bytes), onDisconnect: error => disconnect('host', error) })
  const call = async (operation: keyof typeof PRODUCTION_COMMAND_CODECS, args: unknown[], signal?: AbortSignal): Promise<unknown> => { const codec = PRODUCTION_COMMAND_CODECS[operation], result = await host.request(operation, codec.encodeArguments(args as never), { signal }); return codec.decodeResult((result as { value?: JsonValue }).value) }
  const drain = (): Promise<unknown> => bounded('public/private raw work', Promise.all([service.peer.drain(), host.drain()]))
  const outcome = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'resolved', error => error instanceof ServiceProtocolError ? error.code : error instanceof Error ? error.message : String(error))
  const http = (params: Record<string, unknown>, token = getTaskApiToken(), signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> => bounded('authenticated task API request', new Promise((done, reject) => {
    const port = getTaskApiPort(); if (!port) { reject(new Error('TASK_FEEDBACK_PROOF no actual task API')); return }
    const req = request({ hostname: '127.0.0.1', port, path: '/respond_to_checkpoint', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal, agent: false }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 8192) req.destroy(new Error('TASK_FEEDBACK_PROOF response bound')) }); res.once('error', reject); res.once('end', () => { try { done({ status: res.statusCode ?? 0, body: JSON.parse(text) }) } catch (error) { reject(error) } }) }); req.once('error', reject); req.end(JSON.stringify(params))
  }))
  let originalFailure: unknown, failed = false
  try {
    await host.request('engine.ping', {}); await host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
    const services = service.getReadyServices()!, db = services.db, manager = services.agents
    await services.wakeups.close() // no background Captain work is part of this fixture
    db.setSetting('workspace_autocleanup_enabled', 'false'); db.setSetting('workspace_nodemodules_gc_enabled', 'false')
    const agent = db.getAgents()[0]!; db.updateAgent(agent.id, { config: { coding_agent: 'pi', model: 'fixture/model', max_parallel_sessions: 16 } })
    const bindings = Reflect.get(service, 'bindings') as ProductionDesktopBindings
    const actualEncodeOwnerEvent = bindings.encodeOwnerEvent.bind(bindings)
    bindings.encodeOwnerEvent = (operation, payload) => {
      const rawShape = encodingMetrics(payload)
      try {
        const encoded = actualEncodeOwnerEvent(operation, payload)
        if (report.encoding.length === 64) report.encoding.shift()
        report.encoding.push({ operation, succeeded: true, raw: rawShape, encoded: encodingMetrics(encoded), code: null })
        return encoded
      } catch (error) {
        if (report.encoding.length === 64) report.encoding.shift()
        const receipt = { operation, succeeded: false, raw: rawShape, encoded: null, code: error instanceof ServiceProtocolError ? error.code : 'NON_PROTOCOL_ERROR' }
        report.encoding.push(receipt)
        console.error(`PRODUCTION_TASK_FEEDBACK_ENCODER_FAILURE ${JSON.stringify(receipt)}`)
        throw error
      }
    }
    const caller = { principal: 'trusted-desktop-main' as const, engineEpoch: service.owner.snapshot().epoch, webviewId: 'main', origin: 'tauri://localhost' }
    const task = (title: string) => { const row = db.createTask({ title })!; db.updateTask(row.id, { agent_id: agent.id }); return db.getTask(row.id)! }
    const startFixture = async (taskId: string, label: string): Promise<{ sessionId: string }> => {
      const result = await call('agentSession:start', [agent.id, taskId, undefined, true])
      const entry = isRecord(result) && typeof result.sessionId === 'string' ? sessions.get(result.sessionId) : undefined
      if (!isRecord(result) || result.queued === true || typeof result.sessionId !== 'string' || !result.sessionId || !entry || entry.config.taskId !== taskId || entry.config.agentId !== agent.id) {
        throw new Error(`TASK_FEEDBACK_PROOF ${label} did not start its actual adapter session: ${JSON.stringify({ taskId, outcome: result, projectAdmission: manager.getProjectLimitState(db.getTask(taskId)!.project_id), queue: manager.getStartQueue(), raw })}`)
      }
      return { sessionId: result.sessionId }
    }
    const ping = async (label: string) => { const value = await host.request('engine.ping', {}); check(label, 1, Number(isBootstrapResult(value) && value.engineEpoch === caller.engineEpoch)); check(`${label} zero fatal disconnects`, 0, fatalDisconnects) }
    const counts = (name: string) => report.notices.filter(notice => notice.operation === name).length
    const incompatible = task('Real incompatible resume fixture')
    db.updateTask(incompatible.id, { session_id: 'missing_native_34' })
    check('actual incompatible resume refuses public mutation', 1, Number(await outcome(call('agentSession:resume', [agent.id, incompatible.id, 'missing_native_34'])) !== 'resolved'))
    await drain()
    check('actual Manager emitted one incompatible notice', 1, counts('agent:incompatible-session'))
    const incompatibleNotice = report.notices.find(notice => notice.operation === 'agent:incompatible-session')!
    check('incompatible payload exact current identities', 1, Number(isRecord(incompatibleNotice.payload) && incompatibleNotice.payload.taskId === incompatible.id && incompatibleNotice.payload.agentId === agent.id))
    check('incompatible backend error redacted to exact wire notice', 1, Number(isRecord(incompatibleNotice.payload) && incompatibleNotice.payload.error === PRODUCTION_INCOMPATIBLE_SESSION_ERROR && !JSON.stringify(incompatibleNotice.payload).includes(privateMarker)))
    check('incompatible durable native session cleared', 1, Number(db.getTask(incompatible.id)?.session_id === null))
    check('incompatible durable classified loss notice retained', 1, Number(db.getTranscriptParts(incompatible.id).some(part => part.partId.startsWith('session-loss-pending-') && part.content === 'INCOMPATIBLE_SESSION_ID')))
    check('incompatible failure does not automatically create replacement session', 0, raw.adapterCreates)
    await ping('transport usable after actual incompatible failure')
    for (const scope of ['task', 'project', 'agent'] as const) {
      denyTask = scope === 'task'; denyProject = scope === 'project'; denyAgent = scope === 'agent'
      check(`captured incompatible event denies current ${scope} read`, 1, Number(bindings.projectOwnerEvent(incompatibleNotice.operation, incompatibleNotice.payload, caller) === undefined))
      // A real sender with withdrawn observer rights is suppressed at publish;
      // this domain call is fixture work, not a bypass of public invocation.
      const deniedNative = `denied_${scope}_native_34`
      db.updateTask(incompatible.id, { session_id: deniedNative })
      check(`real ${scope}-denied incompatible resume still refuses`, 1, Number(await outcome(manager.resumeSession(agent.id, incompatible.id, deniedNative)) !== 'resolved'))
      await drain()
      check(`real ${scope}-denied incompatible sender leaks no notice`, 1, counts('agent:incompatible-session'))
      denyTask = denyProject = denyAgent = false
    }
    check('captured incompatible event denies stale epoch', 1, Number(bindings.projectOwnerEvent(incompatibleNotice.operation, incompatibleNotice.payload, { ...caller, engineEpoch: 'retired_epoch_34' }) === undefined))
    check('captured incompatible event denies foreign principal', 1, Number(bindings.projectOwnerEvent(incompatibleNotice.operation, incompatibleNotice.payload, { ...caller, principal: 'service' }) === undefined))

    const checkpoint = task('Actual authenticated checkpoint fixture'), started = await startFixture(checkpoint.id, 'initial checkpoint')
    const checkpointSession = sessions.get(started.sessionId)!
    checkpointSession.status = SessionStatusType.WAITING_APPROVAL; adapter.onDataAvailable?.(started.sessionId)
    await until('actual Manager waiting approval', () => manager.getSessionStatus(started.sessionId)?.status === 'waiting_approval')
    check('checkpoint actually waits in current Manager', 1, Number(manager.getSessionStatus(started.sessionId)?.status === 'waiting_approval'))
    const unauthorized = await http({ task_id: checkpoint.id, approved: true }, 'wrong-disposable-token')
    check('unauthenticated checkpoint returns401', 401, unauthorized.status); check('unauthorized checkpoint never calls adapter', 0, raw.adapterApprovals)
    const wrongTask = task('Foreign checkpoint target'), foreign = await http({ task_id: wrongTask.id, approved: true })
    check('foreign task checkpoint refuses', 1, Number(typeof foreign.body.error === 'string')); check('foreign task never approves other session', 0, raw.adapterApprovals)
    const invalidBoolean = await http({ task_id: checkpoint.id, approved: 'true' })
    check('checkpoint nonboolean approval refuses', 1, Number(invalidBoolean.body.success !== true)); check('invalid boolean never calls native approval', 0, raw.adapterApprovals)
    approvalHandled = false
    const refused = await http({ task_id: checkpoint.id, approved: true })
    check('actual adapter refusal does not claim checkpoint success', 1, Number(refused.body.success !== true && typeof refused.body.error === 'string'))
    check('adapter refusal emits no answered notice', 0, counts('task:checkpointAnswered')); approvalHandled = true
    const approved = await http({ task_id: checkpoint.id, approved: false })
    await drain()
    check('authenticated checkpoint success follows actual adapter acknowledgment', 1, Number(approved.body.success === true && checkpointSession.pending === false))
    check('actual checkpoint response emits one notice', 1, counts('task:checkpointAnswered'))
    const checkpointNotice = report.notices.find(notice => notice.operation === 'task:checkpointAnswered')!
    check('checkpoint notice preserves actual false boolean and exact task', 1, Number(isRecord(checkpointNotice.payload) && checkpointNotice.payload.taskId === checkpoint.id && checkpointNotice.payload.approved === false && Object.keys(checkpointNotice.payload).length === 2))
    const answeredCalls = raw.adapterApprovals, duplicate = await http({ task_id: checkpoint.id, approved: true })
    check('duplicate answered checkpoint refuses', 1, Number(duplicate.body.success !== true)); check('duplicate never replays adapter approval', answeredCalls, raw.adapterApprovals)
    check('duplicate emits no false second notice', 1, counts('task:checkpointAnswered'))
    check('acknowledged checkpoint current pending request consumed', 1, Number(await manager.getSessionRequestScope(started.sessionId) === null))
    check('checkpoint durable session binding remains exact', 1, Number(db.getTask(checkpoint.id)?.session_id === started.sessionId))
    const destroysBeforeCheckpointStop = raw.adapterDestroys
    await manager.stopByTaskId(checkpoint.id); await drain()
    check('answered checkpoint actual adapter destruction acknowledged', destroysBeforeCheckpointStop + 1, raw.adapterDestroys)
    check('answered checkpoint retained Manager session retired before next start', 0, manager.getActiveSessionsForTask(checkpoint.id).length)
    check('answered checkpoint controlled adapter identity retired', 0, Number(sessions.has(started.sessionId)))
    for (const scope of ['task', 'project', 'agent'] as const) {
      const deniedTask = task(`Checkpoint observer ${scope} denied`), deniedStart = await startFixture(deniedTask.id, `${scope}-denied checkpoint`)
      sessions.get(deniedStart.sessionId)!.status = SessionStatusType.WAITING_APPROVAL; adapter.onDataAvailable?.(deniedStart.sessionId)
      await until(`actual ${scope}-denied checkpoint waiting`, () => manager.getSessionStatus(deniedStart.sessionId)?.status === 'waiting_approval')
      denyTask = scope === 'task'; denyProject = scope === 'project'; denyAgent = scope === 'agent'
      const acknowledged = await http({ task_id: deniedTask.id, approved: true })
      await drain()
      check(`actual acknowledged checkpoint with ${scope}-denied observer`, 1, Number(acknowledged.body.success === true))
      check(`actual ${scope}-denied checkpoint leaks no answered event`, 1, counts('task:checkpointAnswered'))
      denyTask = denyProject = denyAgent = false
      await ping(`no automatic checkpoint replay after ${scope} read restored`)
      check(`restored ${scope} grant does not replay notice`, 1, counts('task:checkpointAnswered'))
      await manager.stopByTaskId(deniedTask.id)
    }
    await ping('transport usable after acknowledged checkpoint')

    // Source completion follows the real feedback path, skill scan and Manager
    // idle transition. Only the external gh process is replaced by local Node.
    const source = db.createTaskSource({ name: 'Disposable failing source', plugin_id: 'github-issues', mcp_server_id: null })!
    db.db.prepare('UPDATE task_sources SET enabled=0,config=? WHERE id=?').run(JSON.stringify({ owner: 'fixture-owner', repo: 'fixture-repo' }), source.id)
    const sourceTask = task('🧪'.repeat(180) + ' exact disposable source title')
    // Initialize only this captured synthetic task through the same finite
    // origin accepted by source sync; ordinary user writes cannot relink it.
    const linkedSourceTask = db.updateTask(sourceTask.id, { source_id: source.id, external_id: '7', source: 'GitHub' }, 'task-source')
    check('synthetic source binding persisted through source writer origin', 1, Number(linkedSourceTask?.source_id === source.id && linkedSourceTask.external_id === '7' && linkedSourceTask.source === 'GitHub' && linkedSourceTask.project_id === source.project_id))
    const sourceStarted = await startFixture(sourceTask.id, 'source feedback')
    const sourceSession = sessions.get(sourceStarted.sessionId)!
    // Production has no legacy mainWindow heartbeat route. Require two actual
    // polled transitions, so initial registration's working flag cannot stand
    // in for the Manager consuming BUSY and establishing has-seen-work.
    sourceSession.status = SessionStatusType.WAITING_APPROVAL; adapter.onDataAvailable?.(sourceStarted.sessionId)
    await until('actual source WAITING poll transition delivered', () => manager.getSessionStatus(sourceStarted.sessionId)?.status === 'waiting_approval' && observedStatuses.get(sourceStarted.sessionId) === 'waiting_approval')
    sourceSession.status = SessionStatusType.BUSY; sourceSession.pending = false; adapter.onDataAvailable?.(sourceStarted.sessionId)
    await until('actual source BUSY poll transition delivered', () => manager.getSessionStatus(sourceStarted.sessionId)?.status === 'working' && observedStatuses.get(sourceStarted.sessionId) === 'working')
    check('actual source WAITING to BUSY polling acknowledged by current Manager and wire', 1, Number(manager.getSessionStatus(sourceStarted.sessionId)?.status === 'working' && observedStatuses.get(sourceStarted.sessionId) === 'working'))
    await call('db:updateTask', [sourceTask.id, { status: 'agent_learning', feedback_rating: 4, complete_at_source: true }])
    check('user feedback pending choice persisted', 1, Number(!!db.getSetting(`session-feedback-completion:${sourceTask.id}`)))
    sourceSession.status = SessionStatusType.IDLE; adapter.onDataAvailable?.(sourceStarted.sessionId)
    await until('actual source completion failure notice', () => counts('task:source-action-failed') === 1)
    await drain(); await Promise.all(children.map(child => bounded('source process close', child.closed)))
    const sourceNotice = report.notices.find(notice => notice.operation === 'task:source-action-failed')!
    check('actual source failure projected safe fixed error', 1, Number(isRecord(sourceNotice.payload) && sourceNotice.payload.error === TASK_SOURCE_ACTION_ERROR && !JSON.stringify(sourceNotice.payload).includes(privateMarker)))
    check('actual source failure title fits UTF8/codepoint bound', 1, Number(isRecord(sourceNotice.payload) && typeof sourceNotice.payload.taskTitle === 'string' && feedbackTitleIsBounded(sourceNotice.payload.taskTitle) && sourceTask.title.startsWith(sourceNotice.payload.taskTitle)))
    check('failed source completion leaves task durably ready for review', 1, Number(db.getTask(sourceTask.id)?.status === 'ready_for_review'))
    check('source completion choice consumed without automatic replay', 1, Number(db.getSetting(`session-feedback-completion:${sourceTask.id}`) === undefined))
    check('one actual bounded source command attempted', 1, raw.sourceCommands)
    check('one actual source callback acknowledged', 1, raw.sourceCallbacks)
    check('one actual source child close acknowledged', 1, raw.sourceChildren)
    check('actual source stdout and stderr close acknowledged', 2, raw.sourceStdio)
    await ping('transport usable after actual source failure')
    for (const scope of ['task', 'project', 'agent', 'source'] as const) {
      denyTask = scope === 'task'; denyProject = scope === 'project'; denyAgent = scope === 'agent'; denySource = scope === 'source'
      check(`source failure denies current ${scope} read`, 1, Number(bindings.projectOwnerEvent(sourceNotice.operation, sourceNotice.payload, caller) === undefined))
      denyTask = denyProject = denyAgent = denySource = false
    }
    for (const notice of report.notices) {
      check(`actual ${notice.operation} has exact production codec`, 1, Number(validateProductionEventWire(notice.operation, notice.payload)))
      check(`actual ${notice.operation} wire bytes bounded`, 1, Number(Buffer.byteLength(JSON.stringify(notice.payload)) <= TASK_FEEDBACK_FIXTURE.eventBytes))
      check(`actual ${notice.operation} stamped current engine epoch`, 1, Number(notice.engineEpoch === caller.engineEpoch))
      check(`actual ${notice.operation} avoids unbridged fallback`, 0, unbridged.get(notice.operation) ?? 0)
      check(`actual ${notice.operation} refuses unknown wire keys`, 1, Number(isRecord(notice.payload) && !validateProductionEventWire(notice.operation, { ...notice.payload, unknownPrivateField: true })))
    }
    check('exact three distinct retained notices exercised', 3, new Set(report.notices.map(notice => notice.operation)).size)
    for (const notice of report.notices) {
      check(`${notice.operation} foreign document observer denied`, 1, Number(bindings.projectOwnerEvent(notice.operation, notice.payload, { ...caller, webviewId: 'foreign-document', origin: 'https://foreign.invalid' }) === undefined))
    }
    const replacementAgent = db.createAgent({ name: 'Different current assignment', config: { coding_agent: 'pi' } })!
    db.updateTask(incompatible.id, { agent_id: replacementAgent.id })
    check('incompatible event cannot describe a replaced assigned agent', 1, Number(bindings.projectOwnerEvent(incompatibleNotice.operation, incompatibleNotice.payload, caller) === undefined))
    db.deleteTask(incompatible.id)
    check('captured incompatible event grants no deleted-task access', 1, Number(bindings.projectOwnerEvent(incompatibleNotice.operation, incompatibleNotice.payload, caller) === undefined))
    const movedProject = db.createProject({ name: 'Foreign fixture project' })!
    deniedProjectId = movedProject.id
    if (!db.moveTaskToProject(checkpoint.id, movedProject.id)?.some(row => row.id === checkpoint.id && row.project_id === movedProject.id)) throw new Error('TASK_FEEDBACK_PROOF synthetic task project move was not persisted')
    check('checkpoint event follows moved task current project grant', 1, Number(bindings.projectOwnerEvent(checkpointNotice.operation, checkpointNotice.payload, caller) === undefined))
    deniedProjectId = null
    check('no incompatible automatic resume retry', 4, raw.adapterResumes)
    check('source command is not replayed by later pings/drains', 1, raw.sourceCommands)
    // Hold an actual accepted adapter response, cancel only its HTTP caller,
    // then Stop its real generation. No private Manager state is changed.
    const retiringTask = task('Cancelled checkpoint retains raw approval'), retiringStart = await startFixture(retiringTask.id, 'retiring checkpoint')
    sessions.get(retiringStart.sessionId)!.status = SessionStatusType.WAITING_APPROVAL; adapter.onDataAvailable?.(retiringStart.sessionId)
    await until('retiring checkpoint actually waiting', () => manager.getSessionStatus(retiringStart.sessionId)?.status === 'waiting_approval')
    const retiringHold = barrier(); holds.push(retiringHold); approvalHold = retiringHold
    const controller = new AbortController(), retiringRequest = outcome(http({ task_id: retiringTask.id, approved: false }, getTaskApiToken(), controller.signal))
    await bounded('raw native checkpoint response accepted', retiringHold.entered)
    controller.abort(); check('checkpoint HTTP caller cancellation observed', 1, Number(await retiringRequest !== 'resolved'))
    const stopping = manager.stopByTaskId(retiringTask.id)
    await until('retiring checkpoint actual native destruction', () => !sessions.has(retiringStart.sessionId))
    await bounded('retired task actual Stop joins while raw approval remains held', stopping)
    check('retired checkpoint generation no longer registered', 0, manager.getActiveSessionsForTask(retiringTask.id).length)
    check('cancelled raw approval has not fabricated answered event', 1, counts('task:checkpointAnswered'))
    expectedClose = true
    const closing = service.close()
    check('profile SQLite writer retained through raw checkpoint callback', 1, Number(db.db.open))
    retiringHold.release(); await bounded('raw checkpoint response and native owner drain', closing)
    check('retired cancelled checkpoint emits no false approval', 1, counts('task:checkpointAnswered'))
    check('profile SQLite closes after raw checkpoint retirement', 0, Number(db.db.open))
  } catch (error) {
    originalFailure = error; failed = true
    console.error(`PRODUCTION_TASK_FEEDBACK_FAILURE ${JSON.stringify({ error: String(error), disconnectCodes, counters: report.counters, encoding: report.encoding, raw, provenance: report.provenance, root })}`)
    throw error
  } finally {
    for (const hold of holds) hold.release()
    trusted = true; denyTask = denyProject = denyAgent = denySource = false; expectedClose = true
    try { await bounded('actual production owner close', service.close()); host.disconnect(); await host.waitForHandlers(); await Promise.all(children.map(child => bounded('source raw child close', child.closed))) }
    catch (cleanupFailure) {
      const drains: unknown = Reflect.get(service.owner, 'drains')
      console.error(`PRODUCTION_TASK_FEEDBACK_DRAIN_FAILURE ${JSON.stringify({ original: failed ? String(originalFailure) : null, cleanup: String(cleanupFailure), owner: service.owner.snapshot(), residualDrains: drains instanceof Map ? [...drains.keys()] : null, nativeDrained: Reflect.get(service.owner, 'nativeDrained'), raw, root })}`)
      if (failed) throw new AggregateError([originalFailure, cleanupFailure], 'TASK_FEEDBACK_PROOF workload and owner drain failed; disposable profile retained')
      throw cleanupFailure
    }
    report.cleanup.ownerStopped = service.owner.snapshot().phase === 'stopped'
    check('real native process-owner drain acknowledged', 1, raw.nativeDrainAcks)
    check('no fatal feedback transport disconnects', 0, fatalDisconnects)
    check('no source child signaled', 0, children.filter(child => child.child.killed).length)
    check('all accepted adapter sessions destroyed', 0, sessions.size)
    rmSync(root, { recursive: true, force: true }); report.cleanup.profileRemoved = !existsSync(root)
    for (const key of keys.values()) key.fill(0); keys.clear()
  }
  return report
}

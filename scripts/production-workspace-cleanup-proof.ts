import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, readlink, type FileHandle } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ProductionService, sealProductionServiceHost } from '../src/service/production-service'
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions, type ProductionDesktopBindings } from '../src/service/production-desktop-bindings'
import { DESKTOP_OPERATION_MANIFEST } from '../src/shared/desktop-operations'
import { ServicePeer, type OperationSchema } from '../src/service/transport/peer'
import { PRODUCTION_HOST_SCHEMAS, type ProductionLaunchDescriptor } from '../src/shared/production-bootstrap'
import { isBootstrapResult, isRecord, ServiceProtocolError, type JsonValue, type ServiceErrorCode } from '../src/shared/service-protocol'
import { WORKSPACE_CLEANUP_CALLBACK_SCHEMA, type WorkspaceCleanupObservationRequest, type WorkspaceCleanupObservationResult } from '../src/shared/workspace-native-callbacks'
import { WorkspaceFileOwner } from '../src/main/workspace-file-owner'
import { createNodePty, terminalProcessCwd } from '../src/main/terminal-process'
import { SessionStatusType, type CodingAgentAdapter } from '../src/main/adapters/coding-agent-adapter'

interface ProofCounter { name: string; expected: number; actual: number; comparison: 'equal' | 'atMost' | 'atLeast' }
function assertProofCounter(counter: ProofCounter): void {
  const { expected, actual, comparison, name } = counter
  if (!Number.isFinite(actual) || (comparison === 'equal' ? actual !== expected : comparison === 'atMost' ? actual > expected : actual < expected)) {
    throw new Error(`PAYLOAD_PROOF ${name}: expected ${comparison} ${expected}, actual ${actual}`)
  }
}

export const WORKSPACE_CLEANUP_FIXTURE = Object.freeze({ version: 1, retentionDays: 1, age: '2000-01-01T00:00:00.000Z', timeoutMs: 10_000, fragmentBytes: 79 })
export function isSyntheticDescendant(root: string, path: string): boolean { return path.startsWith(root + sep) && !path.slice(root.length + 1).split(sep).some(value => value === '..' || value === '.') }
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done }); return { promise, release } }
async function deadline<T>(label: string, raw: Promise<T>, timeout = WORKSPACE_CLEANUP_FIXTURE.timeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([raw, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`CLEANUP_PROOF deadline: ${label}`)), timeout) })]) }
  finally { clearTimeout(timer) }
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
type Hold = { action: 'acquire' | 'check' | 'release'; entered: ReturnType<typeof gate>; finish: ReturnType<typeof gate> }
interface ChildReceipt { child: ChildProcess; cwd: string; closed: Promise<void>; exited: boolean }
/** Failure inspection only: never invokes, removes or bypasses an owner drain. */
function readOnlyDrainState(owner: object) {
  const object = (value: unknown): object | null => value !== null && typeof value === 'object' ? value : null
  const count = (target: object | null, key: string): number | null => {
    const value: unknown = target ? Reflect.get(target, key) : null
    return value instanceof Map || value instanceof Set ? value.size : null
  }
  const boolean = (target: object | null, key: string): boolean | null => {
    const value: unknown = target ? Reflect.get(target, key) : null
    return typeof value === 'boolean' ? value : null
  }
  const drains: unknown = Reflect.get(owner, 'drains')
  const residualNames = drains instanceof Map ? [...drains.keys()].filter((value): value is string => typeof value === 'string') : null
  const services = object(Reflect.get(owner, 'services')), manager = object(services ? Reflect.get(services, 'agents') : null)
  const processes = object(Reflect.get(owner, 'workspaceProcesses')), scope = object(processes ? Reflect.get(processes, 'scope') : null)
  return {
    residualDrains: residualNames, residualOrdinaryDrains: residualNames?.filter(name => name !== 'adapters') ?? null,
    rawDrain: { present: Reflect.get(owner, 'rawDrain') instanceof Promise, settledStatus: 'not-exposed' },
    nativeDrained: boolean(owner, 'nativeDrained'),
    workspaceProcesses: { inflightCount: processes ? Reflect.get(processes, 'inflightCount') as unknown : null, failed: boolean(processes, 'failed'), scopePresent: scope !== null, scopeActive: boolean(scope, 'active'), scopeIds: count(scope, 'ids'), scopeTickets: count(scope, 'tickets') },
    manager: Object.fromEntries(['shutdownWork', 'rawTaskStarts', 'sessionStarts', 'admittedStarts', 'scopedCleanupFailures', 'scopedCleanupConflicts'].map(key => [key, count(manager, key)])),
    workspaceCleanupExclusion: boolean(manager, 'workspaceCleanupExclusion')
  }
}
export interface WorkspaceCleanupProofReport {
  version: 1
  scope: string
  fixture: typeof WORKSPACE_CLEANUP_FIXTURE
  provenance: { platform: string; architecture: string; osRelease: string; node: string; electron: null; webview: null; packages: Record<string, string>; sources: Record<string, string>; artifacts: Record<string, string> }
  counters: ProofCounter[]
  contracts: Array<{ name: string; kind: string; declaredOwner: string; declaredCaller: string; destination: string; codec: boolean; runtimeInThisLaunch: boolean; attempted: number; succeededOrObserved: number; authorityProof: string; nativeProof: string }>
  observation: { scope: string; acquire: number; check: number; release: number; peakDirectoryFds: number; openDirectoryFds: number }
  cleanup: { ownerStopped: boolean; profileRemoved: boolean; childExits: number; ptyExits: number }
  remaining: string[]
}

/** Actual source production consumers, explicitly controlled native observation.
 * This fixture never claims that its retained-child registry is full-host procfs. */
export async function runProductionWorkspaceCleanupProof(): Promise<WorkspaceCleanupProofReport> {
  const pins = JSON.parse(readFileSync(resolve('scripts/tauri-runtime.json'), 'utf8')) as { nodeVersion: string; nativeDependencies: Record<string, string> }
  if (process.platform !== 'linux' || process.versions.electron || process.version !== `v${pins.nodeVersion}` ||
      !process.env.TAURI_NODE_RUNTIME || realpathSync(process.execPath) !== realpathSync(process.env.TAURI_NODE_RUNTIME)) throw new Error('CLEANUP_PROOF requires pinned staged Linux Node and --terminal-proofs')
  const artifacts: Record<string, string> = { node: hash(readFileSync(process.execPath)) }
  for (const [name, variable] of [['better-sqlite3', 'TAURI_SQLITE_MODULE'], ['node-pty', 'TAURI_NODE_PTY_MODULE']] as const) {
    const selected = process.env[variable]
    if (!selected || realpathSync(selected) !== realpathSync(resolve('src-tauri/resources/service/node_modules', name))) throw new Error(`CLEANUP_PROOF missing staged ${name}`)
    const bytes = readFileSync(join(selected, 'package.json')), metadata = JSON.parse(bytes.toString())
    if (metadata.version !== pins.nativeDependencies[name] || metadata.name !== name) throw new Error(`CLEANUP_PROOF wrong staged ${name}`)
    artifacts[`${name}/package.json`] = hash(bytes)
    artifacts[`${name}/native-addon`] = hash(readFileSync(join(selected, name === 'node-pty' ? 'build/Release/pty.node' : `prebuilds/${process.platform}-${process.arch}.node`)))
  }
  const sourcePaths = ['scripts/production-workspace-cleanup-proof.ts', 'scripts/production-workspace-cleanup-proof.test.ts',
    'src/service/production-workspace-cleanup-acceptance.test.ts', 'src/service/production-owner.ts', 'src/service/production-service.ts',
    'src/service/production-desktop-bindings.ts', 'src/service/worktree-runtime-backend.ts', 'src/main/workspace-cleanup-scheduler-core.ts',
    'src/main/agent-manager-core.ts', 'src/main/worktree-manager-core.ts', 'src/main/terminal-service-core.ts',
    'src/main/workspace-file-owner.ts', 'src/shared/workspace-native-callbacks.ts', 'src/shared/production-bootstrap.ts',
    'src/service/production-workspace-process-owner.ts', 'src-tauri/engine/src/production_cleanup_observation.rs', 'src/shared/desktop-operations.ts', 'scripts/tauri-runtime.json']
  const sources = Object.fromEntries(sourcePaths.map(path => [path, hash(readFileSync(resolve(path)))]))
  const root = realpathSync(mkdtempSync(join(tmpdir(), '21x-cleanup-acceptance-'))), workspaceRoot = join(root, 'workspaces')
  mkdirSync(join(root, 'resources')); mkdirSync(workspaceRoot)
  const observation = { scope: 'controlled-retained-fixture-processes-only-not-full-host-procfs', acquire: 0, check: 0, release: 0, peakDirectoryFds: 0, openDirectoryFds: 0 }
  const report: WorkspaceCleanupProofReport = { version: 1, scope: 'actual-production-owner-private-peer-cleanup-controlled-native-observer', fixture: WORKSPACE_CLEANUP_FIXTURE,
    provenance: { platform: process.platform, architecture: process.arch, osRelease: osRelease(), node: process.version, electron: null, webview: null,
      packages: { 'better-sqlite3': pins.nativeDependencies['better-sqlite3'], 'node-pty': pins.nativeDependencies['node-pty'] }, sources, artifacts }, counters: [], contracts: [], observation,
    cleanup: { ownerStopped: false, profileRemoved: false, childExits: 0, ptyExits: 0 }, remaining: [
      'Actual Rust full-host procfs authority and physical-root source-wire proof must supplement this controlled native callback.',
      'Partial/unreadable full-host visibility is unknown, never idle; unsupported OS remains unavailable.',
      'Installed supported-platform and full issue210 acceptance/#202 closure prerequisite remain open.' ] }
  const check = (name: string, expected: number, actual: number): void => { const counter: ProofCounter = { name, expected, actual, comparison: 'equal' }; report.counters.push(counter); assertProofCounter(counter) }
  const keys = new Map<string, Buffer>(), children: ChildReceipt[] = [], ptys: Array<{ exited: boolean }> = []
  const adapterSessions = new Map<string, string>(), adapterDestroyed: string[] = []
  let workloadFailure: unknown, hadWorkloadFailure = false
  const leases = new Map<string, { taskId: string; rootFd: FileHandle; taskFd: FileHandle; rootIdentity: string; taskIdentity: string }>()
  const holds: Hold[] = []
  const attempts = new Map<string, number>(), successes = new Map<string, number>(), events = new Map<string, number>()
  const extraReleases: Array<() => void> = []
  let nextHold: Hold | null = null, unknown = false, adapterCreates = 0, adapterPrompts = 0, observerCalls = 0, fileFds = 0, fileHold: { entered: ReturnType<typeof gate>; finish: ReturnType<typeof gate> } | null = null
  let adapterStartHold: { entered: ReturnType<typeof gate>; finish: ReturnType<typeof gate> } | null = null
  let host: ServicePeer | null = null
  const transportState: { servicePeer: ServicePeer | null; firstServiceCode: ServiceErrorCode | null; firstHostCode: ServiceErrorCode | null; expectedClose: boolean; propagating: boolean; fatalCount: number } = {
    servicePeer: null, firstServiceCode: null, firstHostCode: null, expectedClose: false, propagating: false, fatalCount: 0
  }
  const disconnectReceipt = () => ({ service: transportState.firstServiceCode, host: transportState.firstHostCode, fatalCount: transportState.fatalCount })
  const disconnect = (side: 'service' | 'host', error: ServiceProtocolError): void => {
    if (side === 'service') transportState.firstServiceCode ??= error.code
    else transportState.firstHostCode ??= error.code
    if (transportState.propagating) return
    if (!transportState.expectedClose || error.code !== 'DISCONNECTED') transportState.fatalCount++
    transportState.propagating = true
    try {
      if (side === 'service') host?.disconnect(error.code)
      else transportState.servicePeer?.disconnect(error.code)
    } finally { transportState.propagating = false }
  }
  const identity = (path: string): string => { const info = lstatSync(path, { bigint: true }); if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) throw new Error('CLEANUP_PROOF physical fixture changed'); return `${info.dev}:${info.ino}` }
  const idle = async (taskId: string): Promise<'idle' | 'busy' | 'unknown'> => {
    if (unknown) return 'unknown'
    const path = join(workspaceRoot, taskId)
    for (const receipt of children) if (!receipt.exited) {
      try { const cwd = await readlink(`/proc/${receipt.child.pid}/cwd`); if (cwd === path || isSyntheticDescendant(path, cwd)) return 'busy' }
      catch { return 'unknown' }
    }
    // This is a controlled closed-world fixture policy, not an OS observation.
    return 'idle'
  }
  const observe = async (request: WorkspaceCleanupObservationRequest): Promise<WorkspaceCleanupObservationResult> => {
    observerCalls++; observation[request.action]++
    if (request.action === 'release') {
      const entry = leases.get(request.leaseId)
      if (!entry || entry.taskId !== request.taskId) throw new ServiceProtocolError('INVALID_REQUEST')
      const selected = nextHold?.action === 'release' ? nextHold : null
      if (selected) { nextHold = null; selected.entered.release(); await selected.finish.promise }
      await entry.taskFd.close(); observation.openDirectoryFds--; await entry.rootFd.close(); observation.openDirectoryFds--; leases.delete(request.leaseId)
      return { released: true }
    }
    let leaseId: string, entry: NonNullable<ReturnType<typeof leases.get>>
    if (request.action === 'acquire') {
      const status = await idle(request.taskId); if (status !== 'idle') return { status }
      const rootIdentity = identity(workspaceRoot), taskIdentity = identity(join(workspaceRoot, request.taskId))
      const rootFd = await open(workspaceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); observation.openDirectoryFds++
      let taskFd: FileHandle
      try { taskFd = await open(join(workspaceRoot, request.taskId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); observation.openDirectoryFds++ }
      catch (error) { await rootFd.close(); observation.openDirectoryFds--; throw error }
      leaseId = randomUUID(); entry = { taskId: request.taskId, rootFd, taskFd, rootIdentity, taskIdentity }; leases.set(leaseId, entry)
      observation.peakDirectoryFds = Math.max(observation.peakDirectoryFds, observation.openDirectoryFds)
    } else {
      leaseId = request.leaseId; const current = leases.get(leaseId)
      if (!current || current.taskId !== request.taskId) throw new ServiceProtocolError('INVALID_REQUEST'); entry = current
    }
    const selected = nextHold?.action === request.action ? nextHold : null
    if (selected) { nextHold = null; selected.entered.release(); await selected.finish.promise }
    let status: 'idle' | 'busy' | 'unknown'
    try { status = identity(workspaceRoot) === entry.rootIdentity && identity(join(workspaceRoot, request.taskId)) === entry.taskIdentity ? await idle(request.taskId) : 'unknown' }
    catch { status = 'unknown' }
    if (request.action === 'acquire' && status !== 'idle') {
      await entry.taskFd.close(); observation.openDirectoryFds--; await entry.rootFd.close(); observation.openDirectoryFds--; leases.delete(leaseId)
    }
    return request.action === 'acquire' && status === 'idle' ? { status, leaseId } : { status }
  }
  const hold = (action: Hold['action']): Hold => { const value = { action, entered: gate(), finish: gate() }; nextHold = value; holds.push(value); return value }
  const ptyRoot = realpathSync(process.env.TAURI_NODE_PTY_MODULE!), pty = createRequire(join(ptyRoot, 'package.json'))(ptyRoot) as typeof import('node-pty')
  const adapter: CodingAgentAdapter = { initialize: async () => {}, createSession: async config => {
    const sessionId = `cleanup_adapter_${++adapterCreates}`; adapterSessions.set(config.taskId, sessionId)
    const selected = adapterStartHold
    if (selected) { adapterStartHold = null; selected.entered.release(); await selected.finish.promise }
    return sessionId
  }, resumeSession: async () => [], sendPrompt: async () => { adapterPrompts++ },
    getStatus: async () => ({ type: SessionStatusType.BUSY }), pollMessages: async () => [], abortPrompt: async () => {}, destroySession: async sessionId => { adapterDestroyed.push(sessionId) }, checkHealth: async () => ({ available: true }) }
  const descriptor: ProductionLaunchDescriptor = { version: 1, kind: 'production-private-launch', launchId: 'launch_cleanup_proof_001', profileId: 'cleanup-disposable', profileIntent: 'create-new',
    buildIdentity: 'source-cleanup-fixture-v1', resourceManifestSha256: 'a'.repeat(64), paths: { profileRoot: join(root, 'profile'), workspaceRoot, attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), resourceRoot: join(root, 'resources'), tempRoot: join(root, 'temp') },
    capabilities: { workspaceCleanup: 'host', externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
  let allowed = true
  const trusted = (): boolean => allowed
  const terminalDirectories = new Map<string, Readonly<{ taskId: string; cwd: string; rootIdentity: string; cwdIdentity: string }>>()
  const authority: ProductionDesktopBindingOptions['authority'] = { isTrustedDesktop: trusted, canAccessTask: trusted, canAccessSource: trusted, canAccessProject: trusted, canAccessAgent: trusted,
    canAccessSession: trusted, canAccessGlobalCommander: trusted, canManageGlobalConfiguration: trusted, canQueryBackend: trusted, canCreateProject: trusted, canEditSettings: trusted,
    canAccessGlobalSkills: trusted, canChangeSkillScope: trusted, canReorderProjects: trusted, canReadSetting: trusted, canWriteSetting: trusted, canAccessSecret: trusted,
    canCreateSecret: trusted, canUseSecretEnvironment: trusted, canReadEnvironment: trusted, canAccessTerminal: trusted, canAccessMcpServer: trusted, canAccessCli: trusted, canUseTransport: trusted,
    canUseEnvironmentName: trusted, canAccessConnector: trusted, canUseSourcePlugin: trusted, canCreateInstance: trusted, canUsePiece: trusted, canBorrowSourceCredentials: trusted,
    canResolveUnsavedConfig: trusted, canManageMobile: trusted, canAccessMobileSession: trusted, canAccessMarketplace: trusted, canCreateMarketplace: trusted,
    canAccessPluginName: trusted, canAccessPlugin: trusted, canUseMarketplaceSource: trusted, canUsePluginAddress: trusted, canUsePluginSource: trusted,
    canAccessSkill: trusted, canCreateGlobalSkill: trusted, canCreateAgent: trusted, canCreateMcpServer: trusted,
    resolveTerminalDirectory: id => {
      const selected = terminalDirectories.get(id)
      if (!trusted() || !selected || selected.cwd !== join(workspaceRoot, selected.taskId) || !isSyntheticDescendant(workspaceRoot, selected.cwd)) return null
      try {
        if (identity(workspaceRoot) !== selected.rootIdentity || identity(selected.cwd) !== selected.cwdIdentity) return null
        return { cwd: selected.cwd, root: workspaceRoot }
      } catch { return null }
    } }
  const schemas: Record<string, OperationSchema> = Object.fromEntries(Object.entries(PRODUCTION_COMMAND_CODECS).map(([operation, codec]) => [operation, {
    validatePayload: value => { try { return codec.validateArguments(codec.decodeArguments(value as JsonValue)) } catch { return false } }, validateResult: codec.validateWireResult }]))
  schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }; schemas['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['host.production.prepare'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.prepare'], handle: () => ({ launchId: descriptor.launchId, ready: true, processTree: 'supervised' }) }
  schemas['host.production.drain'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.drain'], handle: () => ({ launchId: descriptor.launchId, acknowledged: true }) }
  schemas['host.workspace.cleanupObservation'] = { ...WORKSPACE_CLEANUP_CALLBACK_SCHEMA, handle: payload => observe(payload as unknown as WorkspaceCleanupObservationRequest) as Promise<JsonValue> }
  const deliver = (peer: ServicePeer, bytes: Uint8Array): void => { for (let at = 0; at < bytes.length; at += WORKSPACE_CLEANUP_FIXTURE.fragmentBytes) peer.receive(bytes.subarray(at, at + WORKSPACE_CLEANUP_FIXTURE.fragmentBytes)) }
  const service = new ProductionService(sealProductionServiceHost({ descriptor, authority, caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' }, unbridgedOwnerEvent: () => {},
    boundaries: { cliMcp: { homeDir: root, environment: {} }, createAdapter: () => adapter, createProvider: () => { throw new Error('CLEANUP_PROOF unexpected provider') },
      terminalProcessHost: { resolveShell: () => '/bin/bash', getCwd: terminalProcessCwd, create: options => {
        const receipt = { exited: false }; ptys.push(receipt)
        return createNodePty({ ...options, onExit: (pid, code, signal) => { receipt.exited = true; options.onExit(pid, code, signal) } }, { spawn: (shell, _args, settings) => pty.spawn(shell, ['--noprofile', '--norc'], { ...settings, env: { HOME: root, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', PS1: '', HISTFILE: '/dev/null' } }) })
      } }, workspaceFiles: options => new WorkspaceFileOwner({ ...options, fs: { open: async (path, flags) => {
        const fd = await open(path, flags); fileFds++
        const selected = fileHold; if (selected) { fileHold = null; selected.entered.release(); await selected.finish.promise }
        return { stat: () => fd.stat({ bigint: true }), read: (buffer, offset, length, position) => fd.read(buffer, offset, length, position), close: async () => { await fd.close(); fileFds-- } }
      } } }) }, constructBootstrap: callbacks => ({ profileId: descriptor.profileId, paths: descriptor.paths, credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => Buffer.from(keys.get(id)!) } },
      connectors: { kind: 'disabled', reason: 'Synthetic acceptance' }, managedTaskMcp: { disabled: true }, native: {
        workspaceCleanup: { observe: callbacks.cleanupObservation }, agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
        prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent, openExternal: callbacks.openExternal, notify: callbacks.notify, sendUiCommand: () => ({ ok: false, detail: 'No fixture UI' }) } })
  }), { write: async bytes => deliver(host!, bytes), onDisconnect: error => disconnect('service', error) })
  transportState.servicePeer = service.peer
  host = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas,
    eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(operation => [operation, value => validateProductionEventWire(operation, value)])),
    onEvent: event => { events.set(event.operation, (events.get(event.operation) ?? 0) + 1) }, write: async bytes => deliver(service.peer, bytes), onDisconnect: error => disconnect('host', error) })
  const call = async (operation: keyof typeof PRODUCTION_COMMAND_CODECS, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    attempts.set(operation, (attempts.get(operation) ?? 0) + 1)
    const codec = PRODUCTION_COMMAND_CODECS[operation], result = await host!.request(operation, codec.encodeArguments(args as never), { signal })
    successes.set(operation, (successes.get(operation) ?? 0) + 1)
    return codec.decodeResult((result as { value?: JsonValue }).value)
  }
  const outcome = async (raw: Promise<unknown>): Promise<string> => raw.then(() => 'resolved', error => error instanceof ServiceProtocolError ? error.code : error instanceof Error ? error.message : 'unknown error')
  const child = async (cwd: string): Promise<ChildReceipt> => {
    if (!isSyntheticDescendant(root, cwd)) throw new Error('CLEANUP_PROOF foreign child cwd')
    const value = spawn(process.execPath, ['-e', "const fs=require('node:fs');const fd=fs.openSync('keep.txt','r');process.stdin.resume();process.stdout.write('READY\\n');process.stdin.on('end',()=>fs.closeSync(fd))"], { cwd, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const receipt: ChildReceipt = { child: value, cwd, exited: false, closed: Promise.resolve() }
    receipt.closed = new Promise<void>((done, reject) => { value.once('error', reject); value.once('close', code => { receipt.exited = true; if (code === 0) done(); else reject(new Error('CLEANUP_PROOF fixture child exit failed')) }) })
    void receipt.closed.catch(() => {}) // final cleanup still awaits exact receipt
    children.push(receipt); value.stderr!.resume()
    await deadline('retained child ready', new Promise<void>((done, reject) => { let bytes = ''; value.stdout!.on('data', data => { bytes += String(data); if (bytes.length > 64) reject(new Error('CLEANUP_PROOF child readiness overflow')); else if (bytes.includes('READY\n')) done() }); value.once('error', reject) }))
    return receipt
  }
  try {
    await host.request('engine.ping', {}); await host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
    const services = service.getReadyServices()!, db = services.db
    // Read only the actual attached domain schemas; never attach a second
    // registry or infer runtime handlers from declaration/codec membership.
    const bindings = Reflect.get(service, 'bindings') as ProductionDesktopBindings
    const runtime = bindings.operationSchemas({ principal: 'trusted-desktop-main', engineEpoch: service.owner.snapshot().epoch, webviewId: 'main', origin: 'tauri://localhost' })
    const contractRows = Object.values(DESKTOP_OPERATION_MANIFEST).filter(row => row.disposition === 'retained')
    report.contracts = contractRows.map(row => ({ name: row.name, kind: row.kind, declaredOwner: row.owner, declaredCaller: row.caller, destination: row.destination,
      codec: Object.hasOwn(row.kind === 'command' ? PRODUCTION_COMMAND_CODECS : PRODUCTION_EVENT_CODECS, row.name),
      runtimeInThisLaunch: row.kind === 'command' ? typeof runtime[row.name]?.handle === 'function' : bindings.hasOwnerEvent(row.name),
      attempted: 0, succeededOrObserved: 0, authorityProof: 'requires-current-domain-scope; this-row-not-proved-by-presence', nativeProof: 'not-assessed-by-node-fixture' }))
    check('every retained manifest row separately reconciled', contractRows.length, report.contracts.length)
    db.setSetting('workspace_nodemodules_gc_enabled', 'false'); db.setSetting('workspace_autocleanup_days', String(WORKSPACE_CLEANUP_FIXTURE.retentionDays)); db.setSetting('workspace_autocleanup_enabled', 'true')
    const create = async (title: string) => {
      const task = db.createTask({ title })!, path = await call('worktree:setup', [task.id, [], '', 'github']) as string
      if (!isSyntheticDescendant(workspaceRoot, path)) throw new Error('CLEANUP_PROOF foreign workspace')
      writeFileSync(join(path, 'keep.txt'), title); db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, task.id)
      return { task, path }
    }
    const scheduled = async (): Promise<void> => {
      const run = Reflect.get(services.cleanup, 'runCleanup') as () => Promise<void>
      await deadline('actual scheduled cleanup pass', run.call(services.cleanup))
    }
    const manual = (): Promise<unknown> => call('workspace:runCleanupNow', [])
    const observationsBeforeDenial = observerCalls; allowed = false
    const denied = await outcome(manual()); allowed = true
    check('withdrawn trusted caller cleanup denied', 1, Number(denied === 'INVALID_REQUEST'))
    check('denied cleanup performs no observation', observationsBeforeDenial, observerCalls)
    const unrelatedPath = join(root, 'unrelated-child'); mkdirSync(unrelatedPath); writeFileSync(join(unrelatedPath, 'keep.txt'), 'unrelated child descriptor')
    const unrelated = await child(unrelatedPath)
    const first = await create('manual idle completed workspace')
    const removed = await manual() as { cleaned: number }; check('manual eligible idle workspace removed', 1, removed.cleaned); check('manual physical removal acknowledged', 0, Number(existsSync(first.path)))
    const automatic = await create('scheduled idle completed workspace'); await scheduled(); check('scheduled physical removal acknowledged', 0, Number(existsSync(automatic.path)))
    const busy = await create('live retained workspace child'), live = await child(busy.path)
    const refusal = await outcome(manual()); check('live child cleanup reports busy', 1, Number(refusal === 'BACKPRESSURE')); check('live child exact workspace preserved', 1, Number(readFileSync(join(busy.path, 'keep.txt'), 'utf8') === 'live retained workspace child'))
    await scheduled(); check('scheduled live child workspace preserved', 1, Number(existsSync(busy.path))); check('cleanup never signaled retained child', 0, Number(live.child.killed))
    live.child.stdin!.end(); await deadline('actual retained child reap', live.closed)
    await manual(); check('reaped fixture permits controlled idle removal', 0, Number(existsSync(busy.path)))
    const uncertain = await create('unknown observation preserves workspace'); unknown = true
    check('unknown observation explicitly unavailable', 1, Number(await outcome(manual()) === 'UNKNOWN_OPERATION'))
    await scheduled(); check('scheduled unknown preserves workspace', 1, Number(existsSync(uncertain.path))); unknown = false; await manual()
    const otherStart = await create('cross-task start fenced during cleanup')
    db.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('not_started', otherStart.task.id)
    const fenced = await create('held observer excludes dispatch'), held = hold('acquire'), cleaning = manual(), cleaningResult = outcome(cleaning)
    await deadline('raw acquire accepted with directory FDs', held.entered.promise)
    const createsBefore = adapterCreates, agent = db.getAgents()[0]!
    const start = await outcome(services.agents.requestSession(agent.id, fenced.task.id, fenced.path, true))
    check('cleanup lifecycle lease rejects concurrent start', 1, Number(start !== 'resolved')); check('no adapter starts during cleanup lease', createsBefore, adapterCreates)
    const crossStart = await outcome(services.agents.requestSession(agent.id, otherStart.task.id, otherStart.path, true))
    check('cleanup process exclusion rejects cross-task start', 1, Number(crossStart !== 'resolved'))
    check('no cross-task adapter startup inside process exclusion', createsBefore, adapterCreates)
    check('cross-task workspace is preserved', 1, Number(existsSync(otherStart.path)))
    check('raw observation retains directory descriptors', 2, observation.openDirectoryFds)
    held.finish.release(); check('held cleanup completes after observer acknowledgment', 1, Number(await cleaningResult === 'resolved'))
    await deadline('private cleanup owners drain', Promise.all([service.peer.drain(), host.drain()]))

    const ptyTask = await create('live managed PTY preserves workspace')
    if (ptyTask.path !== join(workspaceRoot, ptyTask.task.id) || !isSyntheticDescendant(workspaceRoot, ptyTask.path)) throw new Error('CLEANUP_PROOF foreign terminal task directory')
    terminalDirectories.set('cleanup:owned', Object.freeze({ taskId: ptyTask.task.id, cwd: ptyTask.path, rootIdentity: identity(workspaceRoot), cwdIdentity: identity(ptyTask.path) }))
    const native = await call('terminal:create', ['cleanup:owned', 80, 24, ptyTask.path]) as { pid: number }
    check('actual native PTY created', 1, ptys.length)
    const nativeCwd = await call('terminal:getCwd', ['cleanup:owned', native.pid]) as { cwd: string | null }
    check('actual native PTY cwd matches captured synthetic task directory', 1, Number(nativeCwd.cwd === ptyTask.path))
    check('managed PTY cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled managed PTY workspace preserved', 1, Number(existsSync(ptyTask.path)))
    await call('terminal:kill', ['cleanup:owned', native.pid]); check('PTY stop acknowledges native exit', 1, Number(ptys[0].exited)); await manual()

    const sessionTask = await create('actual managed session preserves workspace')
    db.updateAgent(agent.id, { config: { coding_agent: 'pi', model: 'fixture/model', max_parallel_sessions: 1 } })
    await call('db:updateTask', [sessionTask.task.id, { agent_id: agent.id, status: 'not_started' }])
    check('first task has actual assigned fixture agent', 1, Number(db.getTask(sessionTask.task.id)?.agent_id === agent.id))
    const session = await services.agents.requestSession(agent.id, sessionTask.task.id, sessionTask.path, true)
    check('actual manager session started', 1, Number(session.status === 'started'))
    if (session.status !== 'started') throw new Error('CLEANUP_PROOF first assigned session did not start')
    const promptsBefore = adapterPrompts
    await services.agents.sendMessage(session.sessionId, 'Keep this disposable fixture turn active until explicit Stop.', sessionTask.task.id, agent.id)
    check('actual manager prompt reaches controlled adapter', promptsBefore + 1, adapterPrompts)
    check('actual assigned runtime session is working', 1, Number(services.agents.getSessionStatus(session.sessionId)?.status === 'working'))
    check('actual project admission counts working fixture session', 1, services.agents.getProjectLimitState(sessionTask.task.project_id).runningAgents)
    db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, sessionTask.task.id)
    check('live manager session cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled live session workspace preserved', 1, Number(existsSync(sessionTask.path)))
    // Exercise the actual durable admission queue while its first counted
    // session is active. A stale completed task row must not erase that owner.
    db.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('agent_working', sessionTask.task.id)
    const queuedTask = await create('actual queued start preserves workspace')
    await call('db:updateTask', [queuedTask.task.id, { agent_id: agent.id, status: 'not_started' }])
    check('second task has actual assigned fixture agent', 1, Number(db.getTask(queuedTask.task.id)?.agent_id === agent.id))
    check('first runtime retains counted working slot before second request', 1, services.agents.getProjectLimitState(sessionTask.task.project_id).runningAgents)
    const queued = await services.agents.requestSession(agent.id, queuedTask.task.id, queuedTask.path, true)
    if (queued.status !== 'queued') console.error(`CLEANUP_PROOF_ADMISSION_FAILURE ${JSON.stringify({ outcome: queued, firstRuntime: services.agents.getSessionStatus(session.sessionId), limits: services.agents.getProjectLimitState(sessionTask.task.project_id), firstAssigned: db.getTask(sessionTask.task.id)?.agent_id, secondAssigned: db.getTask(queuedTask.task.id)?.agent_id })}`)
    check('actual second start queued', 1, Number(queued.status === 'queued'))
    check('actual durable start queue owns second task', 1, Number(services.agents.getStartQueue().some(entry => entry.taskId === queuedTask.task.id && entry.agentId === agent.id && entry.state === 'queued')))
    db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, queuedTask.task.id)
    check('queued start cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled queued workspace preserved', 1, Number(existsSync(queuedTask.path)))
    await services.agents.stopByTaskId(queuedTask.task.id); await services.agents.stopByTaskId(sessionTask.task.id)
    for (const id of [queuedTask.task.id, sessionTask.task.id]) db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, id)
    await manual(); check('stopped session and cancelled queue permit removal', 0, Number(existsSync(sessionTask.path)) + Number(existsSync(queuedTask.path)))

    const rawStartTask = await create('unacknowledged adapter startup preserves workspace'), startupBarrier = { entered: gate(), finish: gate() }
    adapterStartHold = startupBarrier; extraReleases.push(startupBarrier.finish.release)
    db.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('not_started', rawStartTask.task.id)
    const rawStart = services.agents.requestSession(agent.id, rawStartTask.task.id, rawStartTask.path, true), rawStartOutcome = outcome(rawStart)
    await deadline('actual adapter startup raw ownership accepted', startupBarrier.entered.promise)
    db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, rawStartTask.task.id)
    check('unacknowledged start cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled raw startup workspace preserved', 1, Number(existsSync(rawStartTask.path)))
    const rawAdapterId = adapterSessions.get(rawStartTask.task.id)
    if (!rawAdapterId) throw new Error('CLEANUP_PROOF raw adapter creation receipt missing')
    startupBarrier.finish.release()
    const staleStartupResult = await rawStartOutcome
    check('stale raw adapter startup rejects withdrawn task ownership', 1, Number(staleStartupResult.includes('Start ownership was withdrawn before session registration.')))
    check('stale raw adapter session destruction acknowledged', 1, adapterDestroyed.filter(id => id === rawAdapterId).length)
    check('stale raw adapter session is not registered after destruction', 1, Number(services.agents.getSessionStatus(rawAdapterId) === null))
    check('rejected raw startup preserves exact workspace bytes', 1, Number(readFileSync(join(rawStartTask.path, 'keep.txt'), 'utf8') === 'unacknowledged adapter startup preserves workspace'))
    await services.agents.stopByTaskId(rawStartTask.task.id)
    check('explicit Stop leaves no registered raw startup session', 0, services.agents.getActiveSessionsForTask(rawStartTask.task.id).length)
    check('stale-start refusal causes zero fatal transport disconnects', 0, transportState.fatalCount)
    check('production owner remains ready after stale-start refusal', 1, Number(service.owner.snapshot().phase === 'ready'))
    const staleStartPing = await host.request('engine.ping', {})
    check('actual engine ping succeeds after stale-start refusal', 1, Number(isBootstrapResult(staleStartPing) && staleStartPing.engineEpoch === service.owner.snapshot().epoch))
    await deadline('rejected raw startup public peer work drains', Promise.all([service.peer.drain(), host.drain()]))
    db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, rawStartTask.task.id); await manual()

    const heartbeatTask = await create('actual heartbeat ownership preserves workspace'), heartbeatBarrier = { entered: gate(), finish: gate() }
    services.heartbeat.writeHeartbeatFile(heartbeatTask.task.id, 'Inspect the existing local fixture result. No external command is needed.')
    db.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(WORKSPACE_CLEANUP_FIXTURE.age, heartbeatTask.task.id)
    adapterStartHold = heartbeatBarrier; extraReleases.push(heartbeatBarrier.finish.release)
    const heartbeatAbort = new AbortController(), heartbeatResult = outcome(call('heartbeat:runNow', [heartbeatTask.task.id], heartbeatAbort.signal))
    await deadline('actual heartbeat adapter startup accepted', heartbeatBarrier.entered.promise)
    check('actual heartbeat scheduler retains task ownership', 1, Number(services.heartbeat.hasTaskOwnership(heartbeatTask.task.id)))
    check('heartbeat-owned workspace cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled heartbeat-owned workspace preserved', 1, Number(existsSync(heartbeatTask.path)))
    heartbeatAbort.abort(); check('heartbeat public reply cancelled', 1, Number(await heartbeatResult === 'CANCELLED'))
    heartbeatBarrier.finish.release()
    await deadline('actual cancelled heartbeat cleanup drains', Promise.all([service.peer.drain(), host.drain()]))
    check('heartbeat task ownership releases after actual cleanup', 0, Number(services.heartbeat.hasTaskOwnership(heartbeatTask.task.id)))
    check('cancelled heartbeat preserves exact workspace bytes', 1, Number(readFileSync(join(heartbeatTask.path, 'keep.txt'), 'utf8') === 'actual heartbeat ownership preserves workspace'))
    // Scheduler ownership does not acknowledge every Manager pseudo-session or
    // a Captain wake admitted by prior task-failure events. Stop new fixture
    // wake deliveries, join accepted ones, then retire their exact real owners.
    await deadline('fixture Captain wake deliveries drain', services.wakeups.close())
    const heartbeatAlias = `heartbeat-${heartbeatTask.task.id}`, heartbeatAdapterId = adapterSessions.get(heartbeatAlias)
    if (!heartbeatAdapterId) throw new Error('CLEANUP_PROOF accepted heartbeat adapter receipt missing')
    await services.agents.cleanupHeartbeatSession(heartbeatTask.task.id, true)
    await services.agents.stopByTaskId(heartbeatAlias)
    await services.agents.stopByTaskId(heartbeatTask.task.id)
    check('cancelled heartbeat adapter destruction acknowledged exactly once', 1, adapterDestroyed.filter(id => id === heartbeatAdapterId).length)
    check('cancelled heartbeat pseudo-session is retired', 0, services.agents.getActiveSessionsForTask(heartbeatAlias).length)
    check('cancelled heartbeat literal task has no registered session', 0, services.agents.getActiveSessionsForTask(heartbeatTask.task.id).length)
    const fixtureCaptain = db.getCoordinatorTask(heartbeatTask.task.project_id)
    if (!fixtureCaptain) throw new Error('CLEANUP_PROOF fixture Captain row missing')
    await services.agents.stopByTaskId(fixtureCaptain.id)
    const captainAdapterId = adapterSessions.get(fixtureCaptain.id)
    if (captainAdapterId) check('fixture Captain adapter destruction acknowledged exactly once', 1, adapterDestroyed.filter(id => id === captainAdapterId).length)
    check('fixture Captain has no registered session after explicit Stop', 0, services.agents.getActiveSessionsForTask(fixtureCaptain.id).length)
    await deadline('explicit heartbeat and Captain retirement peer drains', Promise.all([service.peer.drain(), host.drain()]))
    db.db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('completed', WORKSPACE_CLEANUP_FIXTURE.age, heartbeatTask.task.id); await manual()

    const fileTask = await create('retained read descriptor preserves workspace'), readBarrier = { entered: gate(), finish: gate() }; fileHold = readBarrier; extraReleases.push(readBarrier.finish.release)
    const reading = call('worktree:readFile', [fileTask.task.id, null, 'keep.txt']), readOutcome = outcome(reading)
    await deadline('actual workspace read FD accepted', readBarrier.entered.promise)
    check('workspace read owns real descriptor', 1, fileFds)
    check('accepted workspace read cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled retained FD workspace preserved', 1, Number(existsSync(fileTask.path)))
    readBarrier.finish.release(); check('actual workspace read completes', 1, Number(await readOutcome === 'resolved'))
    await deadline('workspace read raw drain', Promise.all([service.peer.drain(), host.drain()])); check('workspace read FD closed', 0, fileFds); await manual()

    const source = db.createTaskSource({ name: 'Disposable cleanup source', plugin_id: 'github-issues', mcp_server_id: null })!
    db.db.prepare('UPDATE task_sources SET enabled=0 WHERE id=?').run(source.id)
    const sourceTask = await create('source mutation preserves selected workspace')
    db.db.prepare('UPDATE tasks SET source_id=? WHERE id=?').run(source.id, sourceTask.task.id)
    const sourceBarrier = { entered: gate(), finish: gate() }; extraReleases.push(sourceBarrier.finish.release)
    const sourceMutation = services.sync.runSourceMutation(source.id, async () => { sourceBarrier.entered.release(); await sourceBarrier.finish.promise })
    await deadline('actual source mutation entered', sourceBarrier.entered.promise)
    check('source mutation cleanup reports busy', 1, Number(await outcome(manual()) === 'BACKPRESSURE'))
    await scheduled(); check('scheduled source mutation workspace preserved', 1, Number(existsSync(sourceTask.path)))
    sourceBarrier.finish.release(); await deadline('actual source mutation drain', sourceMutation)
    const sourceLease = hold('acquire'), sourceCleanup = outcome(manual())
    await deadline('cleanup holds actual source mutation lease', sourceLease.entered.promise)
    let sourceJobs = 0
    const sourceJob = await outcome(services.sync.runSourceWork(source.id, async () => { sourceJobs++ }))
    check('cleanup lease refuses newly dispatched source job', 1, Number(sourceJob !== 'resolved'))
    check('source job never executes inside cleanup exclusion', 0, sourceJobs)
    sourceLease.finish.release(); check('source cleanup completes after observation acknowledgment', 1, Number(await sourceCleanup === 'resolved'))
    await deadline('source cleanup raw drain', Promise.all([service.peer.drain(), host.drain()]))

    const changedTask = await create('changed task binding preserves workspace'), taskBarrier = hold('check'), taskCleanup = outcome(manual())
    await deadline('task binding observation check entered', taskBarrier.entered.promise)
    db.db.prepare('UPDATE tasks SET session_id=? WHERE id=?').run('replacement-session-generation', changedTask.task.id)
    taskBarrier.finish.release(); check('changed task binding cleanup denied', 1, Number(await taskCleanup === 'INVALID_REQUEST'))
    await deadline('task binding refusal drain', Promise.all([service.peer.drain(), host.drain()]))
    check('changed task binding bytes preserved', 1, Number(readFileSync(join(changedTask.path, 'keep.txt'), 'utf8') === 'changed task binding preserves workspace'))
    db.db.prepare('UPDATE tasks SET session_id=NULL WHERE id=?').run(changedTask.task.id); await manual()

    for (const kind of ['task-directory', 'workspace-root'] as const) {
      const value = await create(`substituted ${kind} preserves both generations`), barrier = hold('check'), pending = outcome(manual())
      await deadline(`${kind} physical observation accepted`, barrier.entered.promise)
      const selected = kind === 'task-directory' ? value.path : workspaceRoot, displaced = join(root, `displaced-${kind}`)
      renameSync(selected, displaced); mkdirSync(selected)
      const replacementPath = kind === 'task-directory' ? selected : join(selected, value.task.id)
      if (kind === 'workspace-root') mkdirSync(replacementPath)
      writeFileSync(join(replacementPath, 'keep.txt'), 'replacement generation sentinel')
      barrier.finish.release()
      check(`${kind} physical observation becomes unavailable`, 1, Number(await pending === 'UNKNOWN_OPERATION'))
      await deadline(`${kind} refusal drain`, Promise.all([service.peer.drain(), host.drain()]))
      check(`${kind} replacement generation preserved`, 1, Number(readFileSync(join(replacementPath, 'keep.txt'), 'utf8') === 'replacement generation sentinel'))
      const originalPath = kind === 'task-directory' ? displaced : join(displaced, value.task.id)
      check(`${kind} original generation preserved`, 1, Number(readFileSync(join(originalPath, 'keep.txt'), 'utf8') === `substituted ${kind} preserves both generations`))
      rmSync(selected, { recursive: true }); renameSync(displaced, selected); await manual()
    }

    const cancelled = await create('cancelled raw observer keeps bytes'), cancelHold = hold('acquire'), controller = new AbortController()
    check('unrelated retained child survives every cleanup pass', 0, Number(unrelated.exited) + Number(unrelated.child.killed))
    unrelated.child.stdin!.end(); await deadline('unrelated fixture child acknowledged close', unrelated.closed)
    check('all retained fixture children reaped before profile shutdown', children.length, children.filter(value => value.exited).length)
    const cancelling = outcome(call('workspace:runCleanupNow', [], controller.signal)); await deadline('cancelled acquire entered', cancelHold.entered.promise)
    controller.abort(); check('public cleanup reply cancelled', 1, Number(await cancelling === 'CANCELLED'))
    check('cancelled raw observer still owns directory FDs', 2, observation.openDirectoryFds)
    const retiring = hold('release')
    transportState.expectedClose = true
    const closing = service.close()
    cancelHold.finish.release()
    await deadline('late acquired observer release entered', retiring.entered.promise)
    check('profile writer retained through raw observer release', 1, Number(db.db.open))
    check('raw release still owns real directory FDs', 2, observation.openDirectoryFds)
    retiring.finish.release(); await deadline('acknowledged production owner shutdown', closing)
    check('profile writer closes only after raw observer release', 0, Number(db.db.open))
    check('cancelled cleanup preserves selected workspace', 1, Number(existsSync(cancelled.path)))
  } catch (error) {
    workloadFailure = error; hadWorkloadFailure = true
    console.error(`PRODUCTION_WORKSPACE_CLEANUP_FAILURE ${JSON.stringify({ reason: error instanceof ServiceProtocolError ? error.code : error instanceof Error ? error.message : 'unknown', disconnects: disconnectReceipt(), runtimeOwnership: readOnlyDrainState(service.owner), counters: report.counters, observation, provenance: report.provenance })}`)
    throw error
  } finally {
    allowed = true
    for (const release of extraReleases) release()
    for (const value of holds) value.finish.release()
    fileHold?.finish.release()
    for (const receipt of children) if (!receipt.exited) receipt.child.stdin!.end()
    transportState.expectedClose = true
    try { await deadline('actual production owner close', service.close()); host.disconnect(); await host.waitForHandlers() }
    catch (closeError) {
      console.error(`PRODUCTION_WORKSPACE_CLEANUP_DRAIN_FAILURE ${JSON.stringify({ workload: hadWorkloadFailure ? String(workloadFailure) : null, cleanup: String(closeError), disconnects: disconnectReceipt(), owner: service.owner.snapshot(), drainState: readOnlyDrainState(service.owner), observation, fileFds, adapterDestroyed })}`)
      if (hadWorkloadFailure) throw new AggregateError([workloadFailure, closeError], 'CLEANUP_PROOF workload and owner drain failed; disposable profile retained')
      throw closeError
    }
    await Promise.all(children.map(receipt => deadline('owned child close', receipt.closed)))
    report.cleanup.ownerStopped = service.owner.snapshot().phase === 'stopped'; report.cleanup.childExits = children.filter(value => value.exited).length; report.cleanup.ptyExits = ptys.filter(value => value.exited).length
    if (leases.size || observation.openDirectoryFds || fileFds || ptys.some(value => !value.exited)) throw new Error('CLEANUP_PROOF raw resources retained; disposable root preserved')
    check('observer lease receipts all released', 0, leases.size)
    check('observer directory descriptors all closed', 0, observation.openDirectoryFds)
    check('actual native PTY exit receipts', ptys.length, report.cleanup.ptyExits)
    check('actual child close receipts', children.length, report.cleanup.childExits)
    check('observation callback actually exercised', 1, Number(observerCalls > 0))
    check('complete cleanup proof has zero fatal transport disconnects', 0, transportState.fatalCount)
    const descriptorBound: ProofCounter = { name: 'retained observation directory FD bound', expected: 128 * 2, actual: observation.peakDirectoryFds, comparison: 'atMost' }
    report.counters.push(descriptorBound); assertProofCounter(descriptorBound)
    for (const row of report.contracts) { row.attempted = attempts.get(row.name) ?? 0; row.succeededOrObserved = row.kind === 'command' ? successes.get(row.name) ?? 0 : events.get(row.name) ?? 0 }
    check('no fixture child handle signal requests', 0, children.filter(value => value.child.killed).length)
    rmSync(root, { recursive: true, force: true }); report.cleanup.profileRemoved = !existsSync(root)
    for (const key of keys.values()) key.fill(0); keys.clear()
  }
  return report
}

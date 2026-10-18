import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Writable } from 'node:stream'
import { nativeCredentialEnvironment } from '../src/main/platform/native-application-key-store'
import { observeOwnedProcess } from './credential-proof/process.mjs'
import type * as ServiceModule from '../src/service/production-service'
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions } from '../src/service/production-desktop-bindings'
import { PRODUCTION_HOST_SCHEMAS, isProductionOwnerState, type ProductionLaunchDescriptor } from '../src/shared/production-bootstrap'
import { isBootstrapResult, isRecord, type JsonValue } from '../src/shared/service-protocol'
import { ServicePeer, type OperationSchema } from '../src/service/transport/peer'

const probes = ['engine.fixture.start', 'engine.fixture.cooperative', 'engine.fixture.crash', 'engine.fixture.hang',
  'engine.test.reset', 'engine.probe', 'automation.execute', 'nativeSmokeReport', 'engine.bootstrap.replace']
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => { vi.resetModules() })
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish() })

/** Real singleton/database/registry and serialized private peers; only native
 * readiness, protected key storage and provider creation are synthetic. No OS
 * credential service, live profile or provider account is selected. */
async function fixture(kind: 'source' | 'staged') {
  const module: typeof ServiceModule = kind === 'source' ? await import('../src/service/production-service')
    : await import(/* @vite-ignore */ pathToFileURL(join(dirname(process.env.TAURI_PRODUCTION_SERVICE_ENTRY!), 'production-engine.mjs')).href)
  const root = mkdtempSync(join(tmpdir(), '21x-production-no-automation-'))
  const descriptor: ProductionLaunchDescriptor = { version: 1, kind: 'production-private-launch', launchId: 'launch_no_automation_001', profileId: 'no-automation-fixture', profileIntent: 'create-new', buildIdentity: 'controlled-production-proof', resourceManifestSha256: 'a'.repeat(64),
    paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), resourceRoot: join(root, 'resources'), tempRoot: join(root, 'temp') },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
  mkdirSync(descriptor.paths.resourceRoot)
  const keys = new Map<string, Buffer>()
  const schemas: Record<string, OperationSchema> = Object.fromEntries(probes.map(operation => [operation, { validatePayload: isRecord, validateResult: isRecord }]))
  schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['engine.ownerState'] = { validatePayload: isRecord, validateResult: isProductionOwnerState }
  schemas['engine.shutdown'] = { validatePayload: isRecord, validateResult: value => isRecord(value) && value.stopped === true }
  const projectCodec = PRODUCTION_COMMAND_CODECS['project:getAll']
  schemas['project:getAll'] = { validatePayload: isRecord, validateResult: projectCodec.validateWireResult }
  const nativeCalls: string[] = []
  schemas['host.production.prepare'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.prepare'], handle: () => {
    nativeCalls.push('prepare'); return { launchId: descriptor.launchId, ready: true, processTree: 'supervised' }
  } }
  schemas['host.production.drain'] = { ...PRODUCTION_HOST_SCHEMAS['host.production.drain'], handle: () => {
    nativeCalls.push('drain'); return { launchId: descriptor.launchId, acknowledged: true }
  } }
  const deliver = (peer: ServicePeer, bytes: Uint8Array) => { for (let offset = 0; offset < bytes.length; offset += 37) peer.receive(bytes.subarray(offset, offset + 37)) }
  const host = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas,
    eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(operation => [operation, value => validateProductionEventWire(operation, value)])),
    write: async bytes => { deliver(service.peer, bytes) } })
  const permitted = () => true
  const authority: ProductionDesktopBindingOptions['authority'] = { isTrustedDesktop: permitted, canAccessTask: permitted, canAccessSource: permitted,
    canAccessProject: permitted, canAccessAgent: permitted, canAccessSession: permitted, canAccessGlobalCommander: permitted,
    canManageGlobalConfiguration: permitted, canQueryBackend: permitted, canCreateProject: permitted, canEditSettings: permitted,
    canAccessGlobalSkills: permitted, canChangeSkillScope: permitted, canReorderProjects: permitted, canReadSetting: permitted, canWriteSetting: permitted, canAccessSecret: permitted,
    canCreateSecret: permitted, canUseSecretEnvironment: permitted, canReadEnvironment: permitted, canAccessTerminal: permitted, canAccessMcpServer: permitted, canAccessCli: permitted,
    canUseTransport: permitted, canUseEnvironmentName: permitted, canAccessConnector: permitted, canUseSourcePlugin: permitted,
    canCreateInstance: permitted, canUsePiece: permitted, canBorrowSourceCredentials: permitted, canResolveUnsavedConfig: permitted,
    canManageMobile: permitted, canAccessMobileSession: permitted, canAccessMarketplace: permitted, canCreateMarketplace: permitted,
    canAccessPluginName: permitted, canAccessPlugin: permitted, canUseMarketplaceSource: permitted, canUsePluginAddress: permitted, canUsePluginSource: permitted,
    canAccessSkill: permitted, canCreateGlobalSkill: permitted, canCreateAgent: permitted, canCreateMcpServer: permitted,
    resolveTerminalDirectory: () => ({ cwd: descriptor.paths.workspaceRoot, root: descriptor.paths.workspaceRoot }) }
  const service: ServiceModule.ProductionService = new module.ProductionService(module.sealProductionServiceHost({ descriptor, authority,
    caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' }, unbridgedOwnerEvent: () => {},
    boundaries: { createAdapter: () => { throw new Error('No provider process is allowed in this boundary proof') }, createProvider: () => { throw new Error('No chat provider is allowed in this boundary proof') }, cliMcp: { homeDir: root, environment: {} } },
    constructBootstrap: callbacks => ({ profileId: descriptor.profileId, paths: descriptor.paths,
      credentials: { mode: 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) }, load: async id => Buffer.from(keys.get(id)!) } },
      connectors: { kind: 'disabled', reason: 'No connector authority in this proof' }, managedTaskMcp: { disabled: true },
      native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
        prepareRuntime: callbacks.prepare, drainOwnedProcesses: callbacks.drain, emit: callbacks.emitOwnerEvent,
        openExternal: callbacks.openExternal, notify: callbacks.notify, sendUiCommand: () => ({ ok: false, detail: 'No UI authority in this proof' }) } })
  }), { write: async bytes => { deliver(host, bytes) } })
  cleanup.push(async () => {
    await service.close(); host.disconnect(); await host.waitForHandlers()
    for (const key of keys.values()) key.fill(0)
    rmSync(root, { recursive: true, force: true })
  })
  await host.request('engine.ping', {})
  await host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
  return { service, host, nativeCalls, projects: async () => {
    const result = await host.request('project:getAll', projectCodec.encodeArguments([])) as { defined: boolean; value?: JsonValue }
    return projectCodec.decodeResult(result.defined ? result.value : undefined)
  } }
}

describe.each(['source', ...(process.env.TAURI_PRODUCTION_SERVICE_ENTRY ? ['staged'] : [])] as const)('production automation boundary (%s)', kind => {
  it('rejects diagnostic/test operations after actual initialization without creating effects or replacing the owner', async () => {
    const f = await fixture(kind as 'source' | 'staged')
    const projects = await f.projects(), before = await f.host.request('engine.ownerState', {})
    expect(projects.length).toBeGreaterThan(0)
    expect(before).toMatchObject({ phase: 'ready', owned: true })
    for (const operation of probes) await expect(f.host.request(operation, {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(await f.host.request('engine.ownerState', {})).toEqual(before)
    expect(await f.projects()).toEqual(projects)
    expect(f.nativeCalls).toEqual(['prepare'])
    expect(await f.host.request('engine.shutdown', {})).toEqual({ stopped: true })
    expect(f.nativeCalls).toEqual(['prepare', 'drain'])
    expect(f.service.owner.snapshot()).toMatchObject({ phase: 'stopped', owned: false })
  }, 30_000)
})

if (process.env.TAURI_PRODUCTION_SERVICE_ENTRY) it('keeps fixture environment switches inert in the actual hashed production stdio child', async () => {
  const resourceRoot = resolve('src-tauri/resources'), manifestBytes = readFileSync(join(resourceRoot, 'service/PRODUCTION_RESOURCE_MANIFEST.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { buildIdentity: string }
  const root = mkdtempSync(join(tmpdir(), '21x-production-switch-denial-')), smoke = join(root, 'smoke.json')
  const descriptor: ProductionLaunchDescriptor = { version: 1, kind: 'production-private-launch', launchId: 'launch_no_fixture_switch_001', profileId: 'no-fixture-switch', profileIntent: 'create-new', buildIdentity: manifest.buildIdentity,
    resourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    paths: { resourceRoot, profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'), reposRoot: join(root, 'repos'), tempRoot: join(root, 'temp') },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported', configuredMcp: 'disabled', managedTaskMcp: 'disabled', connectors: 'disabled' } }
  const child = spawn(process.env.TAURI_NODE_RUNTIME!, [process.env.TAURI_PRODUCTION_SERVICE_ENTRY!], { cwd: process.cwd(),
    env: { ...nativeCredentialEnvironment(process.env), TWENTYONEX_FEASIBILITY_TEST_MODE: '1', TWENTYONEX_NATIVE_SMOKE_REPORT: smoke, TWENTYONEX_NATIVE_SMOKE_PROFILE: descriptor.paths.profileRoot },
    detached: process.platform !== 'win32', stdio: process.platform === 'win32' ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true })
  const receipt = observeOwnedProcess(child, process.platform !== 'win32')
  child.stdin!.on('error', () => {}); child.stdout!.on('error', () => {}); child.stderr!.on('data', () => {})
  const schemas: Record<string, OperationSchema> = Object.fromEntries(probes.map(operation => [operation, { validatePayload: isRecord, validateResult: isRecord }]))
  schemas['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  schemas['engine.shutdown'] = { validatePayload: isRecord, validateResult: value => isRecord(value) && value.stopped === true }
  const peer = new ServicePeer({ role: 'host', engineEpoch: null, operations: schemas,
    write: bytes => new Promise<void>((done, reject) => child.stdin!.write(bytes, error => error ? reject(error) : done())) })
  child.stdout!.on('data', (bytes: Buffer) => peer.receive(bytes)); child.once('close', () => peer.disconnect())
  cleanup.push(async () => { peer.disconnect(); expect(await receipt.stop()).toBe(true); await peer.waitForHandlers(); rmSync(root, { recursive: true, force: true }) })
  if (process.platform === 'win32') child.stdin!.write(JSON.stringify(descriptor) + '\n')
  else { const pipe = child.stdio[3] as Writable; pipe.on('error', () => {}); pipe.end(JSON.stringify(descriptor)) }
  const ping = await peer.request('engine.ping', {}, { timeoutMs: 30_000 })
  expect(ping).toMatchObject({ nodeVersion: 'v22.23.2' })
  for (const operation of probes) await expect(peer.request(operation, {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
  expect(await peer.request('engine.ping', {})).toEqual(ping)
  expect(await peer.request('engine.shutdown', {})).toEqual({ stopped: true })
  await receipt.receipt
  expect(child.exitCode).toBe(0); expect(existsSync(smoke)).toBe(false); expect(existsSync(descriptor.paths.profileRoot)).toBe(false)
}, 45_000)

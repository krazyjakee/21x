import Database from 'better-sqlite3'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as sourceModule from './production-service'
import { ArtifactViewerOwner } from './artifact-viewer-owner'
import type { ArtifactBackend } from './artifact-backend'
import { PRODUCTION_COMMAND_CODECS, PRODUCTION_EVENT_CODECS, validateProductionEventWire, type ProductionDesktopBindingOptions } from './production-desktop-bindings'
import { ServicePeer, type OperationSchema } from './transport/peer'
import { isBootstrapResult, isJsonValue, isRecord, type JsonValue } from '../shared/service-protocol'
import { isOptionalResult } from '../shared/host-services'
import type { ProductionLaunchDescriptor } from '../shared/production-bootstrap'
import { DESKTOP_OPERATION_MANIFEST } from '../shared/desktop-operations'
import type { AgentManagerHost } from '../main/agent-manager/host'
import { browserTools } from '../main/mcp-servers/task-management-tools'
import { BrowserRecordingService } from '../main/browser-recording'
import { acquireProfileLock } from '../main/platform/profile-lock'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { createProfileMigrationFixture, rehearseProfileCredentialImport, rehearseProfileCredentialRollback } from '../main/platform/profile-migration-rehearsal'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Owned canvas fixture cleanup failed')
})
let staged: typeof sourceModule | undefined
const kinds = ['source', ...(process.env.TAURI_PRODUCTION_SERVICE_ENTRY ? ['staged'] : [])]
const retired = Object.values(DESKTOP_OPERATION_MANIFEST).filter(row => row.disposition === 'removed-browser')
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function navigationCanary() {
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.end('Synthetic navigation canary') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback canary address')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const origin = `http://127.0.0.1:${address.port}`
  expect(await (await fetch(origin)).text()).toBe('Synthetic navigation canary'); expect(requests).toBe(1)
  requests = 0
  return { origin, requests: () => requests }
}
function fileHashes(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name)
      if (entry.isDirectory()) visit(next)
      else { expect(entry.isFile()).toBe(true); result[relative(root, next)] = digest(readFileSync(next)) }
    }
  }
  visit(root); return result
}
function fileIdentities(root: string): Record<string, string> {
  return Object.fromEntries(Object.keys(fileHashes(root)).map(path => {
    const info = statSync(join(root, path))
    return [path, `${info.dev}:${info.ino}`]
  }))
}
async function fixture(kind: string, reuse?: { root: string; keys: Map<string, Buffer> }, managed = false) {
  vi.resetModules()
  const module = kind === 'staged' ? staged! : await import('./production-service')
  const root = reuse?.root ?? mkdtempSync(join(tmpdir(), '21x-canvas-production-'))
  const keys = reuse?.keys ?? new Map<string, Buffer>()
  const descriptor: ProductionLaunchDescriptor = {
    version: 1, kind: 'production-private-launch', launchId: 'canvas_retirement_launch', profileId: 'canvas-fixture',
    profileIntent: reuse ? 'load-authenticated-copy' : 'create-new', buildIdentity: 'canvas-retirement-fixture', resourceManifestSha256: 'a'.repeat(64),
    paths: { profileRoot: join(root, 'profile'), workspaceRoot: join(root, 'workspaces'), attachmentRoot: join(root, 'attachments'),
      reposRoot: join(root, 'repos'), resourceRoot: join(root, 'resources'), tempRoot: join(root, 'temp') },
    capabilities: { externalUrls: 'unsupported', notifications: 'unsupported', energy: 'unsupported', ui: 'unsupported', voice: 'unsupported',
      configuredMcp: 'disabled', managedTaskMcp: managed ? 'enabled' : 'disabled', connectors: 'disabled' }
  }
  mkdirSync(descriptor.paths.resourceRoot, { recursive: true })
  let permitted = true
  const deniedProjects = new Set<string>(), nativeEffects: string[] = [], events: Array<{ operation: string; payload: JsonValue }> = []
  const allowed = () => permitted
  const authority: ProductionDesktopBindingOptions['authority'] = {
    isTrustedDesktop: allowed, canAccessTask: allowed, canAccessProject: id => permitted && !deniedProjects.has(id), canAccessAgent: allowed,
    canAccessSource: allowed, canAccessSession: allowed, canAccessGlobalCommander: allowed, canManageGlobalConfiguration: allowed,
    canQueryBackend: allowed, canCreateProject: allowed, canEditSettings: allowed, canAccessGlobalSkills: allowed, canChangeSkillScope: allowed,
    canReorderProjects: allowed, canReadSetting: allowed, canWriteSetting: allowed, canAccessSecret: allowed, canCreateSecret: allowed,
    canUseSecretEnvironment: allowed, canReadEnvironment: allowed, canAccessTerminal: allowed, canAccessMcpServer: allowed, canAccessCli: allowed,
    canUseTransport: allowed, canUseEnvironmentName: allowed, canAccessConnector: allowed, canUseSourcePlugin: allowed, canCreateInstance: allowed,
    canUsePiece: allowed, canBorrowSourceCredentials: allowed, canResolveUnsavedConfig: allowed, canManageMobile: allowed, canAccessMobileSession: allowed,
    canAccessMarketplace: allowed, canCreateMarketplace: allowed, canAccessPluginName: allowed, canAccessPlugin: allowed, canUseMarketplaceSource: allowed,
    canUsePluginAddress: allowed, canUsePluginSource: allowed, canAccessSkill: allowed, canCreateGlobalSkill: allowed, canCreateAgent: allowed,
    canCreateMcpServer: allowed, resolveTerminalDirectory: () => null
  }
  const operations: Record<string, OperationSchema> = Object.fromEntries(Object.entries(PRODUCTION_COMMAND_CODECS).map(([name, codec]) => [name, {
    validatePayload: (value: unknown) => { try { return isJsonValue(value) && codec.validateArguments(codec.decodeArguments(value)) } catch { return false } },
    validateResult: codec.validateWireResult
  }]))
  // The hostile host knows old names. The production engine must refuse them;
  // a local missing-schema check would not exercise the service boundary.
  for (const row of retired) operations[row.name] = { validatePayload: isJsonValue, validateResult: isJsonValue }
  operations['engine.ping'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  operations['engine.initialize'] = { validatePayload: isRecord, validateResult: isBootstrapResult }
  const deliver = (peer: ServicePeer, bytes: Uint8Array): void => { for (let i = 0; i < bytes.length; i += 47) peer.receive(bytes.subarray(i, i + 47)) }
  const host = new ServicePeer({ role: 'host', engineEpoch: null, operations,
    eventSchemas: Object.fromEntries(Object.keys(PRODUCTION_EVENT_CODECS).map(name => [name, (value: unknown) => validateProductionEventWire(name, value)])),
    write: async bytes => deliver(service.peer, bytes), onEvent: event => { events.push(event) } })
  const service = new module.ProductionService(module.sealProductionServiceHost({ descriptor, authority,
    caller: { principal: 'trusted-desktop-main', webviewId: 'main', origin: 'tauri://localhost' },
    unbridgedOwnerEvent: () => {},
    boundaries: { cliMcp: { homeDir: root, environment: {} }, createAdapter: () => { throw new Error('Retired canvas must not create a provider') },
      createProvider: () => { throw new Error('Retired canvas must not create a provider') } },
    constructBootstrap: callbacks => ({ profileId: descriptor.profileId, paths: descriptor.paths,
      credentials: { mode: reuse ? 'load' : 'create', store: { create: async (id, key) => { keys.set(id, Buffer.from(key)) },
        load: async id => { const key = keys.get(id); if (!key) throw new Error('Synthetic key absent'); return Buffer.from(key) } } },
      managedTaskMcp: managed ? { command: process.execPath, args: [join(process.cwd(), 'src-tauri/resources/service/production-task-mcp.mjs')], tools: [], environment: {} } : { disabled: true },
      connectors: { kind: 'disabled', reason: 'Retired canvas fixture needs no connectors' },
      native: { agents: { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, configuredMcp: 'disabled' },
        prepareRuntime: async () => {}, drainOwnedProcesses: async () => ({ acknowledged: true }),
        openExternal: async () => { nativeEffects.push('openExternal') }, notify: () => { nativeEffects.push('notify') },
        emit: callbacks.emitOwnerEvent, sendUiCommand: () => { nativeEffects.push('sendUiCommand'); return { ok: false, detail: 'No physical document' } } }
    })
  }), { write: async bytes => deliver(host, bytes) })
  let closed = false
  const close = async (): Promise<void> => { if (closed) return; await service.close(); host.disconnect(); await host.waitForHandlers(); closed = true }
  cleanups.push(async () => { await close(); if (!reuse) { for (const key of keys.values()) key.fill(0); rmSync(root, { recursive: true, force: true }) } })
  await host.request('engine.ping', {}); await host.request('engine.initialize', { protocolVersion: 1, launchId: descriptor.launchId })
  const services = service.getReadyServices()!, db = services.db, project = db.getProjects()[0]
  db.updateProject(project.id, { settings: { ...project.settings, captain_wakeups: { enabled: false } } })
  const command = async (name: keyof typeof PRODUCTION_COMMAND_CODECS, args: unknown[]) => {
    const codec = PRODUCTION_COMMAND_CODECS[name], response = await host.request(name, codec.encodeArguments(args as never))
    if (!isOptionalResult(response)) throw new Error('Invalid private result')
    return codec.decodeResult(response.defined ? response.value : undefined)
  }
  return { root, keys, descriptor, service, services, host, db, project, command, close, nativeEffects, events, deniedProjects, deny: () => { permitted = false } }
}
function savedState(taskId: string, browserOrigin = 'https://inactive.invalid') {
  const canvas = JSON.stringify({ viewport: { x: -140.25, y: 90, zoom: 0.75 }, nextZIndex: 12, panels: [
    { id: 'panel-7', type: 'task', refId: taskId, title: 'Retained task', x: 1, y: 2, width: 500, height: 400, zIndex: 2 },
    { id: 'panel-9', type: 'browser', title: 'Dormant browser', url: `${browserOrigin}/path?synthetic=canary#old`,
      browserSessionId: 'inactive-session', streamPort: 65500, webContentsId: 451, x: 570, y: -33, width: 901, height: 602, zIndex: 10 },
    { id: 'panel-11', type: 'webpage', title: 'Dormant document 雪', url: 'javascript:globalThis.__retiredCanary=1', x: -15, y: 202, width: 300, height: 250, zIndex: 11 }
  ], edges: [{ id: 'edge-4', fromPanelId: 'panel-7', toPanelId: 'panel-9', edgeType: 'browser' },
    { id: 'edge-5', fromPanelId: 'panel-9', toPanelId: 'panel-11', edgeType: 'default' }] })
  const drawing = JSON.stringify({ objects: [{ id: 'shape-8', type: 'text', x: -15, y: 9, text: 'Preserved 雪\ncanvas', zIndex: 20,
    color: '#ab12ef', width: 220, height: 90 }], nextZIndex: 21, selectedTool: 'select' })
  return { canvas, drawing }
}
function recordings(root: string, taskId: string): Record<string, string> {
  const store = new BrowserRecordingService(root)
  store.start('panel-9', [taskId], 'Saved inactive archive')
  store.append('panel-9', { source: 'human', action: 'click', url: 'https://inactive.invalid/page' },
    { url: 'https://inactive.invalid/page', elements: [{ tag: 'button', role: 'button', name: 'Synthetic action' }], truncated: false })
  store.stop('panel-9', [taskId])
  // A production startup must not instantiate the retired recording owner:
  // its historical recovery constructor would rewrite this unfinished record.
  store.start('inactive-unfinished', [taskId], 'Historical unfinished archive')
  store.append('inactive-unfinished', { source: 'human', action: 'navigate' })
  return fileHashes(root)
}
for (const kind of kinds) describe(`actual ${kind} retained canvas and browser retirement`, () => {
  beforeAll(async () => { if (kind === 'staged') staged = await import(pathToFileURL(join(dirname(process.env.TAURI_PRODUCTION_SERVICE_ENTRY!), 'production-engine.mjs')).href) as typeof sourceModule })
  it('round-trips exact dormant layout/drawing/URLs/edges and recording bytes across real profile shutdown/reopen without effects', async () => {
    const f = await fixture(kind), task = f.db.createTask({ title: 'Saved canvas task', project_id: f.project.id })!, canary = await navigationCanary(), state = savedState(task.id, canary.origin)
    const recordRoot = join(f.root, 'profile', 'browser-recordings'), hashes = recordings(recordRoot, task.id), identities = fileIdentities(recordRoot)
    const keys = ['canvas_state', 'drawing_state', `canvas_state:${f.project.id}`, `drawing_state:${f.project.id}`]
    for (let i = 0; i < keys.length; i++) await f.command('settings:set', [keys[i], i % 2 === 0 ? state.canvas : state.drawing])
    for (let i = 0; i < keys.length; i++) expect(await f.command('settings:get', [keys[i]])).toBe(i % 2 === 0 ? state.canvas : state.drawing)
    expect(await f.command('settings:getAll', [])).toMatchObject(Object.fromEntries(keys.map((key, i) => [key, i % 2 === 0 ? state.canvas : state.drawing])))
    expect(f.nativeEffects).toEqual([]); expect(fileHashes(recordRoot)).toEqual(hashes)
    await f.close()
    const reopened = await fixture(kind, { root: f.root, keys: f.keys })
    for (let i = 0; i < keys.length; i++) expect(await reopened.command('settings:get', [keys[i]])).toBe(i % 2 === 0 ? state.canvas : state.drawing)
    expect(fileHashes(recordRoot)).toEqual(hashes); expect(fileIdentities(recordRoot)).toEqual(identities); expect(reopened.nativeEffects).toEqual([])
    expect(reopened.db.getTask(task.id)).toMatchObject({ id: task.id, title: task.title, session_id: null })
    expect(reopened.events.some(row => row.operation.startsWith('browser:'))).toBe(false)
    await reopened.close(); expect(canary.requests()).toBe(0)
  })
  it('keeps project-scoped inactive blobs isolated and refuses withdrawn/missing-project writes without altering bytes', async () => {
    const f = await fixture(kind), other = f.db.createProject({ name: 'Other canvas' })!, state = savedState('historical_task')
    const key = `canvas_state:${f.project.id}`, otherKey = `canvas_state:${other.id}`
    await f.command('settings:set', [key, state.canvas]); await f.command('settings:set', [otherKey, '{"panels":[],"edges":[],"opaque":"other"}'])
    f.deniedProjects.add(f.project.id)
    await expect(f.command('settings:get', [key])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.command('settings:set', [key, '{}'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.command('settings:getAll', [])).not.toHaveProperty(key)
    expect(f.db.getSetting(key)).toBe(state.canvas)
    await expect(f.command('settings:set', ['canvas_state:missing_project', '{}'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await f.command('settings:get', [otherKey])).toBe('{"panels":[],"edges":[],"opaque":"other"}')
    expect(f.nativeEffects).toEqual([])
  })
  it('rejects every retired command across the real private peer while retained settings remain live', async () => {
    const f = await fixture(kind)
    expect(retired.length).toBeGreaterThan(0)
    for (const row of retired.filter(row => row.kind === 'command')) {
      expect(row).toMatchObject({ caller: 'none', destination: 'none' })
      await expect(f.host.request(row.name, { panelId: 'panel-9', url: 'https://inactive.invalid', script: 'globalThis.__retiredCanary=1' })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    }
    await f.command('settings:set', ['canvas_state', savedState('old').canvas])
    expect(await f.command('settings:get', ['canvas_state'])).toContain('inactive.invalid')
    expect(f.service.owner.snapshot().phase).toBe('ready'); expect(f.nativeEffects).toEqual([])
  })
  it('borrows the actual root artifact snapshot for the optional private SDK without registering a production viewer', async () => {
    const f = await fixture(kind), task = f.db.createTask({ title: 'Private snapshot task', project_id: f.project.id })!
    const html = '<!doctype html><h1>Inert private snapshot 雪</h1><script>globalThis.synthetic=1</script>'
    writeFileSync(join(f.db.getWorkspaceDir(task.id), 'preview.html'), html)
    const bindings = Reflect.get(f.service, 'bindings'), backend = Reflect.get(bindings, 'artifacts') as ArtifactBackend
    const caller = { principal: 'trusted-desktop-main' as const, engineEpoch: f.service.owner.snapshot().epoch!, webviewId: 'main', origin: 'tauri://localhost', uiLeaseId: 'synthetic_viewer_document' }
    const unavailable = new ArtifactViewerOwner({ engineEpoch: caller.engineEpoch, artifacts: backend, assertAvailable: () => { f.service.owner.getDatabaseBindingLease() } })
    const read = vi.spyOn(backend, 'captureViewerSnapshot')
    await expect(unavailable.register(task.id, 'preview.html', caller)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(read).not.toHaveBeenCalled(); await unavailable.close()
    const registrations: unknown[] = [], opened: string[] = []
    // Synthetic native receipts prove only Source consumption. No physical
    // document, WebView, native capability or production bootstrap is enabled.
    const owner = new ArtifactViewerOwner({ engineEpoch: caller.engineEpoch, artifacts: backend, assertAvailable: () => { f.service.owner.getDatabaseBindingLease() }, native: {
      register: async input => { registrations.push(input); return { viewerId: input.viewerId, registered: true } },
      open: async ({ viewerId }) => { opened.push(viewerId); return { viewerId, opened: true } }, retire: async ({ viewerId }) => ({ viewerId, retired: true })
    } })
    cleanups.push(async () => { await owner.close() })
    const lease = await owner.register(task.id, 'preview.html', caller)
    expect(registrations).toEqual([{ viewerId: lease.viewerId, uiLeaseId: caller.uiLeaseId, html }])
    f.deniedProjects.add(f.project.id)
    await expect(lease.open()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(opened).toEqual([]); await lease.close()
    expect(Object.keys(PRODUCTION_COMMAND_CODECS).some(name => name.includes('artifactViewer'))).toBe(false)
    expect(f.nativeEffects).toEqual([])
  })
  it('rejects retired HTTP routes and real MCP tools with valid auth, preserving archives and a working task positive control', async () => {
    const f = await fixture(kind, undefined, true), task = f.db.createTask({ title: 'Retirement positive task', project_id: f.project.id })!
    const host = Reflect.get(f.services.agents, 'host') as AgentManagerHost
    if (host.managedTaskMcp.kind !== 'server') throw new Error('Expected actual production task API owner')
    await host.managedTaskMcp.waitUntilReady()
    const config = host.managedTaskMcp.buildConfig({ projectId: f.project.id, taskId: task.id })
    if (!config || config.type !== 'http') throw new Error('Expected signed loopback MCP URL')
    const url = new URL(config.url!), base = url.origin, token = url.searchParams.get('token')!
    expect(url.hostname).toBe('127.0.0.1')
    const recordRoot = join(f.root, 'profile', 'browser-recordings'), hashes = recordings(recordRoot, task.id)
    const client = new Client({ name: 'retired-browser-fixture', version: '1.0.0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(url))
      const tools = await client.listTools()
      expect(tools.tools.some(tool => tool.name === 'list_tasks')).toBe(true)
      expect(tools.tools.some(tool => tool.name.startsWith('browser_'))).toBe(false)
      expect(JSON.stringify(await client.callTool({ name: 'list_tasks', arguments: {} }))).toContain(task.title)
      for (const tool of browserTools) {
        expect((await client.callTool({ name: tool.name, arguments: { task_id: task.id, url: 'https://inactive.invalid' } })).isError, tool.name).toBe(true)
        const response = await fetch(base + '/' + tool.name, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_id: task.id, panel_id: 'panel-9', url: 'https://inactive.invalid', target: '@e1', recording_id: 'old-recording' }) })
        expect(response.status).toBe(200); expect(await response.json()).toEqual({ error: 'Unknown route' })
      }
      expect(fileHashes(recordRoot)).toEqual(hashes); expect(f.nativeEffects).toEqual([])
    } finally { await client.close() }
  }, 20_000)
  it('preserves exact inactive settings/resources in interrupted candidate and immutable encrypted rollback backup', async () => {
    const f = await fixture(kind), state = savedState('historical_task')
    await f.command('settings:set', ['canvas_state', state.canvas]); await f.command('settings:set', [`drawing_state:${f.project.id}`, state.drawing])
    const archive = join(f.root, 'profile', 'browser-recordings'), hashes = recordings(archive, 'historical_task')
    await f.close()
    const root = createProfileMigrationFixture('copied-fixture'), lock = acquireProfileLock(root)
    const key = randomBytes(32), destination = new AuthenticatedSecretStorage(key, 'canvas-rehearsal-destination'); key.fill(0)
    try {
      const stoppedOriginal = digest(readFileSync(join(f.root, 'profile', '21x.db')))
      copyFileSync(join(f.root, 'profile', '21x.db'), join(root, '21x.db')); cpSync(archive, join(root, 'browser-recordings'), { recursive: true })
      // Rehearsal intentionally checkpoints/converts its working copy to
      // DELETE before exclusive snapshotting. Normalize this owned fixture
      // before capturing its byte invariant; the stopped source stays intact.
      const normalizer = new Database(join(root, '21x.db'))
      try { expect(normalizer.pragma('journal_mode=DELETE', { simple: true })).toBe('delete') } finally { normalizer.close() }
      const original = digest(readFileSync(join(root, '21x.db')))
      const resourcePaths = Object.keys(hashes).map(path => join('browser-recordings', path))
      const options = { lock, providers: { destination: { storage: destination, formatId: destination.formatId, persistentProtection: 'os-protected' as const } }, blobInterpretations: [], resourcePaths }
      expect(() => rehearseProfileCredentialImport({ ...options, interruptAfter: 'candidate-published' })).toThrow('REHEARSAL_INTERRUPTED')
      const backupPath = join(root, 'credential-import-rehearsal', 'original.sqlite.enc'), before = digest(readFileSync(backupPath)), inode = statSync(backupPath).ino
      const result = rehearseProfileCredentialImport(options)
      expect(result.recovered).toBe(true); expect(result.credentialChanges).toBe(0)
      const rollback = rehearseProfileCredentialRollback(options)
      for (const path of [result.candidatePath, rollback]) {
        const db = new Database(path, { readonly: true })
        try {
          expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
          expect(db.prepare('SELECT value FROM settings WHERE key=?').pluck().get('canvas_state')).toBe(state.canvas)
          expect(db.prepare('SELECT value FROM settings WHERE key=?').pluck().get(`drawing_state:${f.project.id}`)).toBe(state.drawing)
        } finally { db.close() }
      }
      expect(digest(readFileSync(join(root, '21x.db')))).toBe(original)
      expect(digest(readFileSync(join(f.root, 'profile', '21x.db')))).toBe(stoppedOriginal)
      expect(digest(readFileSync(backupPath))).toBe(before); expect(statSync(backupPath).ino).toBe(inode)
      expect(statSync(backupPath).mode & 0o222).toBe(0)
      expect(fileHashes(join(root, 'browser-recordings'))).toEqual(hashes)
      expect(readFileSync(backupPath).includes(Buffer.from('inactive.invalid'))).toBe(false)
      expect(rehearseProfileCredentialRollback(options)).toBe(rollback)
      expect(f.nativeEffects).toEqual([])
      // Open only another isolated copy of rollback output through the real
      // production service; original/candidate/capsule remain immutable.
      const readerRoot = mkdtempSync(join(tmpdir(), '21x-canvas-rollback-'))
      cleanups.push(async () => { rmSync(readerRoot, { recursive: true, force: true }) })
      mkdirSync(join(readerRoot, 'profile'))
      const readerDb = join(readerRoot, 'profile', '21x.db')
      copyFileSync(rollback, readerDb); chmodSync(readerDb, 0o600)
      cpSync(join(root, 'browser-recordings'), join(readerRoot, 'profile', 'browser-recordings'), { recursive: true })
      const restored = await fixture(kind, { root: readerRoot, keys: f.keys })
      expect(await restored.command('settings:get', ['canvas_state'])).toBe(state.canvas)
      expect(await restored.command('settings:get', [`drawing_state:${f.project.id}`])).toBe(state.drawing)
      expect(fileHashes(join(readerRoot, 'profile', 'browser-recordings'))).toEqual(hashes)
      expect(restored.nativeEffects).toEqual([]); await restored.close()
      expect(digest(readFileSync(backupPath))).toBe(before)
    } finally { destination.dispose(); lock.release(); rmSync(root, { recursive: true, force: true }) }
  }, 20_000)
})

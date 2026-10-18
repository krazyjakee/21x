import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { ArtifactBackend } from './artifact-backend'
import { ArtifactViewerOwner, type ArtifactViewerLease } from './artifact-viewer-owner'
import { ARTIFACT_VIEWER_NATIVE_SCHEMAS, ARTIFACT_VIEWER_CLOSED_SCHEMA, ARTIFACT_VIEWER_LIMITS, isArtifactViewerRegistration,
  type ArtifactViewerNativeBridge, type ArtifactViewerRegistration } from '../shared/artifact-viewer-native'
import { hasExactKeys, isBootstrapResult, isJsonValue, isRecord, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { ServicePeer, type OperationSchema } from './transport/peer'

const boundary = vi.hoisted(() => ({ read: null as ((path: string) => Promise<void>) | null, handles: new Set<FileHandle>() }))
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args); boundary.handles.add(handle)
    await boundary.read?.(String(args[0]))
    return new Proxy(handle, { get(target, key) {
      if (key === 'close') return async () => { await target.close(); boundary.handles.delete(target) }
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})
const epoch = 'viewer_fixture'
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: epoch, webviewId: 'main', origin: 'tauri://localhost', uiLeaseId: 'document_viewer_fixture' }
const html = '<!doctype html><title>Untrusted snapshot</title><script>globalThis.fixture=1</script><h1>雪</h1>'
const releases: Array<() => void> = []
const closers: Array<() => Promise<void>> = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done }); releases.push(resolve)
  return { promise, resolve }
}
let db: ReturnType<typeof createPortableTestDb>, artifacts: ArtifactBackend, root: string, task: NonNullable<ReturnType<typeof db.createTask>>
let denied: Set<string>
beforeEach(async () => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture'))); denied = new Set()
  task = db.createTask({ title: 'Private viewer fixture' })!
  const workspaceRoot = dirname(db.getWorkspaceDir(task.id))
  artifacts = new ArtifactBackend({ database: db, workspaceRoot, engineEpoch: epoch, assertAvailable: () => { if (!db.db.open) throw new Error('Closed fixture') },
    assertArtifactOwners: (owner, path) => { if (owner !== db || path !== workspaceRoot) throw new Error('Wrong fixture owner') },
    isTrustedDesktop: value => value.principal === caller.principal && value.origin === caller.origin && value.webviewId === caller.webviewId,
    canAccessTask: id => !denied.has(id), canAccessProject: () => true })
  await writeFile(join(db.getWorkspaceDir(task.id), 'preview.html'), html)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  const errors: unknown[] = []
  for (const close of closers.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  await artifacts.close(); boundary.read = null
  expect(boundary.handles.size).toBe(0)
  db.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.useRealTimers()
  if (errors.length) throw new AggregateError(errors, 'Viewer fixture cleanup failed')
})
async function fixture() {
  const calls: Array<{ operation: string; payload: JsonValue }> = []
  let registerGate: ReturnType<typeof deferred> | null = null, openGate: ReturnType<typeof deferred> | null = null, retireGate: ReturnType<typeof deferred> | null = null
  let refuseRetire = false, wrongRegister = false
  const registrations = new Map<string, ArtifactViewerRegistration>()
  const operations: Record<string, OperationSchema> = Object.fromEntries(Object.entries(ARTIFACT_VIEWER_NATIVE_SCHEMAS).map(([operation, schema]) => [operation, { ...schema,
    handle: async (payload: JsonValue): Promise<JsonValue> => {
      calls.push({ operation, payload })
      const { viewerId } = payload as { viewerId: string }
      if (operation.endsWith('.register')) {
        registrations.set(viewerId, payload as unknown as ArtifactViewerRegistration); await registerGate?.promise
        return { viewerId: wrongRegister ? randomUUID() : viewerId, registered: true }
      }
      if (operation.endsWith('.open')) { await openGate?.promise; return { viewerId, opened: true } }
      await retireGate?.promise
      if (refuseRetire) throw new Error('synthetic native close refused')
      return { viewerId, retired: true }
    } }]))
  const ping = { validatePayload: (value: unknown) => isRecord(value) && hasExactKeys(value, []), validateResult: isBootstrapResult }
  operations['engine.ping'] = ping
  operations['engine.artifactViewer.closed'] = ARTIFACT_VIEWER_CLOSED_SCHEMA
  const deliver = (peer: ServicePeer, bytes: Uint8Array) => { for (let n = 0; n < bytes.length; n += 31) peer.receive(bytes.subarray(n, n + 31)) }
  const host = new ServicePeer({ role: 'host', engineEpoch: null, operations, write: async bytes => deliver(engine, bytes) })
  const engine = new ServicePeer({ role: 'service', engineEpoch: epoch, operations: { ...operations,
    'engine.ping': { ...ping, handle: () => ({ protocolVersion: 1, engineEpoch: epoch, nodeVersion: process.versions.node }) },
    'engine.artifactViewer.closed': { ...ARTIFACT_VIEWER_CLOSED_SCHEMA, handle: value => owner.closed(value) } }, write: async bytes => deliver(host, bytes) })
  await host.request('engine.ping', {})
  const native: ArtifactViewerNativeBridge = {
    register: async input => await engine.request('host.artifactViewer.register', input as unknown as JsonValue) as Awaited<ReturnType<ArtifactViewerNativeBridge['register']>>,
    open: async input => await engine.request('host.artifactViewer.open', input) as Awaited<ReturnType<ArtifactViewerNativeBridge['open']>>,
    retire: async input => await engine.request('host.artifactViewer.retire', input) as Awaited<ReturnType<ArtifactViewerNativeBridge['retire']>>
  }
  const owner = new ArtifactViewerOwner({ engineEpoch: epoch, artifacts, native, assertAvailable: () => { if (!db.db.open) throw new Error('Closed fixture') } })
  closers.push(async () => { refuseRetire = false; await owner.close(); host.disconnect(); engine.disconnect(); await Promise.all([host.waitForHandlers(), engine.waitForHandlers()]) })
  return { owner, host, calls, registrations, heldRegister: () => (registerGate = deferred()), heldOpen: () => (openGate = deferred()), heldRetire: () => (retireGate = deferred()),
    refuseRetire: (value: boolean) => { refuseRetire = value }, wrongRegister: () => { wrongRegister = true } }
}
const count = (calls: Array<{ operation: string }>, suffix: string) => calls.filter(row => row.operation.endsWith('.' + suffix)).length
describe('optional private artifact viewer actual SQLite/filesystem consumer', () => {
  it('stops admission synchronously while raw native retirement remains owned by close', async () => {
    const f = await fixture(), lease = await f.owner.register(task.id, 'preview.html', caller)
    f.owner.stop()
    await expect(lease.open()).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(f.owner.register(task.id, 'preview.html', caller)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    const retirement = f.heldRetire()
    let closed = false
    const closing = f.owner.close().then(() => { closed = true })
    await vi.waitFor(() => expect(count(f.calls, 'retire')).toBe(1))
    expect(closed).toBe(false); expect(f.owner.inflightCount).toBe(1)
    retirement.resolve(); await closing
    expect(f.owner.inflightCount).toBe(0)
    expect(count(f.calls, 'open')).toBe(0)
  })
  it('stays unavailable without native authority and performs no read, allocation or observer callback', async () => {
    const read = vi.spyOn(artifacts, 'captureViewerSnapshot'), observer = vi.fn()
    const owner = new ArtifactViewerOwner({ engineEpoch: epoch, artifacts, assertAvailable() {} })
    await expect(owner.register(task.id, 'preview.html', caller, { onOwnedLease: observer })).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    expect(read).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled(); expect(owner.inflightCount).toBe(0); await owner.close()
  })
  it('exposes cleanup ownership before raw read/register and opens exactly once only after a matching ACK and scope check', async () => {
    const f = await fixture(), gate = f.heldRegister(), read = vi.spyOn(artifacts, 'captureViewerSnapshot')
    let lease!: ArtifactViewerLease
    const pending = f.owner.register(task.id, 'preview.html', caller, { onOwnedLease: owned => { lease = owned; expect(read).not.toHaveBeenCalled() } })
    expect(Object.isFrozen(lease)).toBe(true)
    await expect(lease.open()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(count(f.calls, 'open')).toBe(0)
    await vi.waitFor(() => expect(count(f.calls, 'register')).toBe(1))
    expect(f.registrations.get(lease.viewerId)).toEqual({ viewerId: lease.viewerId, uiLeaseId: caller.uiLeaseId, html })
    gate.resolve(); expect(await pending).toBe(lease); await lease.open()
    await expect(lease.open()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(count(f.calls, 'open')).toBe(1)
    await lease.close(); expect(f.owner.inflightCount).toBe(0)
  })
  it('retains the real opened read FD across cancellation and bounded shutdown, then joins it without native registration', async () => {
    const f = await fixture(), read = deferred(), entered = deferred(), file = join(db.getWorkspaceDir(task.id), 'preview.html')
    boundary.read = async path => { if (path === file) { entered.resolve(); await read.promise } }
    let lease!: ArtifactViewerLease
    const pending = f.owner.register(task.id, 'preview.html', caller, { onOwnedLease: value => { lease = value } })
    const failed = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise; expect(boundary.handles.size).toBeGreaterThan(0)
    await expect(f.owner.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(f.owner.inflightCount).toBe(1); expect(count(f.calls, 'register')).toBe(0)
    read.resolve(); await failed; await lease.close(); await f.owner.close(); expect(boundary.handles.size).toBe(0)
  })
  it('retains held-register scope withdrawal and refused retirement without affecting an unrelated viewer', async () => {
    const f = await fixture(), other = db.createTask({ title: 'Unrelated artifact' })!
    await writeFile(join(db.getWorkspaceDir(other.id), 'preview.html'), html)
    const unrelated = await f.owner.register(other.id, 'preview.html', caller), gate = f.heldRegister()
    let lease!: ArtifactViewerLease
    const pending = f.owner.register(task.id, 'preview.html', caller, { onOwnedLease: value => { lease = value } })
    const failed = expect(pending).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await vi.waitFor(() => expect(count(f.calls, 'register')).toBe(2))
    denied.add(task.id); f.refuseRetire(true); gate.resolve(); await failed
    await expect(lease.open()).rejects.toMatchObject({ code: 'CANCELLED' }); expect(count(f.calls, 'open')).toBe(0)
    expect(f.owner.inflightCount).toBe(2); expect(f.owner.failedCleanupCount).toBeGreaterThan(0)
    f.refuseRetire(false); await lease.close(); expect(f.owner.inflightCount).toBe(1)
    await unrelated.open(); expect(f.calls.filter(row => row.operation.endsWith('.retire')).some(row => (row.payload as { viewerId: string }).viewerId === unrelated.viewerId)).toBe(false)
    await unrelated.close()
  })
  it('joins cleanup if the synchronous observer throws before raw read/native registration', async () => {
    const f = await fixture(), gate = f.heldRetire(), read = vi.spyOn(artifacts, 'captureViewerSnapshot')
    const failed = expect(f.owner.register(task.id, 'preview.html', caller, { onOwnedLease: () => { throw new Error('Synthetic observer refusal') } })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await vi.waitFor(() => expect(count(f.calls, 'retire')).toBe(1))
    expect(read).not.toHaveBeenCalled(); expect(count(f.calls, 'register')).toBe(0)
    await expect(f.owner.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); gate.resolve(); await failed
    expect(f.owner.inflightCount).toBe(0)
  })
  it('never reopens after an uncertain open and retains raw open until retirement drains', async () => {
    const f = await fixture(), lease = await f.owner.register(task.id, 'preview.html', caller), gate = f.heldOpen()
    const opening = lease.open(), rejected = expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(count(f.calls, 'open')).toBe(1))
    await expect(lease.open()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.owner.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(f.owner.inflightCount).toBe(1)
    gate.resolve(); await rejected; await f.owner.close(); expect(count(f.calls, 'open')).toBe(1)
  })
  it('claims native closure synchronously and acknowledges delivery while retirement remains held', async () => {
    const f = await fixture(), lease = await f.owner.register(task.id, 'preview.html', caller), gate = f.heldRetire()
    await lease.open()
    await expect(f.host.request('engine.artifactViewer.closed', { viewerId: lease.viewerId, reason: 'parent-retired' })).resolves.toEqual({ accepted: true })
    await expect(f.host.request('engine.artifactViewer.closed', { viewerId: lease.viewerId, reason: 'closed' })).resolves.toEqual({ accepted: false })
    await expect(lease.open()).rejects.toMatchObject({ code: 'CANCELLED' }); expect(f.owner.inflightCount).toBe(1)
    gate.resolve(); await lease.close(); expect(f.owner.inflightCount).toBe(0)
  })
  it('rejects mismatched registration ACKs, symlinked content, oversized HTML and foreign callers before opening', async () => {
    const f = await fixture(); f.wrongRegister()
    await expect(f.owner.register(task.id, 'preview.html', caller)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    const before = count(f.calls, 'register'), external = join(root, 'foreign.html'); await writeFile(external, '<h1>foreign synthetic canary</h1>')
    await rm(join(db.getWorkspaceDir(task.id), 'preview.html')); await symlink(external, join(db.getWorkspaceDir(task.id), 'preview.html'))
    await expect(f.owner.register(task.id, 'preview.html', caller)).rejects.toThrow()
    expect(count(f.calls, 'register')).toBe(before); expect(await readFile(external, 'utf8')).toContain('foreign synthetic canary')
    await rm(join(db.getWorkspaceDir(task.id), 'preview.html')); await writeFile(join(db.getWorkspaceDir(task.id), 'preview.html'), 'x'.repeat(ARTIFACT_VIEWER_LIMITS.htmlBytes + 1))
    await expect(f.owner.register(task.id, 'preview.html', caller)).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    await expect(f.owner.register(task.id, 'preview.html', { ...caller, uiLeaseId: 'bad/lease' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(count(f.calls, 'open')).toBe(0)
  })
  it('delivers only the captured immutable HTML after a later path replacement, without a resource/path grant', async () => {
    const f = await fixture(), lease = await f.owner.register(task.id, 'preview.html', caller)
    const file = join(db.getWorkspaceDir(task.id), 'preview.html'); await rm(file); await symlink(join(root, 'foreign-snapshot.html'), file)
    await writeFile(join(root, 'foreign-snapshot.html'), '<h1>later foreign bytes</h1>')
    await lease.open()
    expect(f.registrations.get(lease.viewerId)?.html).toBe(html)
    expect(Object.keys(f.registrations.get(lease.viewerId)!)).toEqual(['viewerId', 'uiLeaseId', 'html'])
    await lease.close()
  })
  it('bounds active ownership and retires leases on the fixed maximum TTL', async () => {
    const f = await fixture(), leases: ArtifactViewerLease[] = []
    for (let i = 0; i < ARTIFACT_VIEWER_LIMITS.active; i++) leases.push(await f.owner.register(task.id, 'preview.html', caller))
    await expect(f.owner.register(task.id, 'preview.html', caller)).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    await leases[0].close(); const next = await f.owner.register(task.id, 'preview.html', caller); await next.close()
    await Promise.all(leases.map(lease => lease.close()))
    vi.useFakeTimers()
    const timed = await f.owner.register(task.id, 'preview.html', caller)
    await vi.advanceTimersByTimeAsync(ARTIFACT_VIEWER_LIMITS.ttlMs + 1)
    await timed.close(); expect(f.owner.inflightCount).toBe(0)
  })
  it('keeps finite private payloads exact and does not expose native labels, titles, paths, grants or arbitrary messages', () => {
    const registration = { viewerId: randomUUID(), uiLeaseId: caller.uiLeaseId, html }
    expect(isArtifactViewerRegistration(registration)).toBe(true)
    for (const key of ['title', 'url', 'path', 'label', 'profileId', 'grant', 'message']) expect(isArtifactViewerRegistration({ ...registration, [key]: 'foreign' })).toBe(false)
    for (const value of ['\ud800', '雪'.repeat(ARTIFACT_VIEWER_LIMITS.htmlBytes / 3 + 1)]) expect(isArtifactViewerRegistration({ ...registration, html: value })).toBe(false)
    expect(ARTIFACT_VIEWER_CLOSED_SCHEMA.validatePayload({ viewerId: registration.viewerId, reason: 'closed', html })).toBe(false)
    expect(ARTIFACT_VIEWER_CLOSED_SCHEMA.validatePayload({ viewerId: registration.viewerId, reason: { toString: () => 'closed' } })).toBe(false)
    expect(ARTIFACT_VIEWER_CLOSED_SCHEMA.validatePayload({ viewerId: registration.viewerId, reason: 'completed' })).toBe(false)
    expect(isJsonValue(registration)).toBe(true)
  })
})

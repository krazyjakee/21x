import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, readFile, rename, rm, symlink, writeFile, open, link } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { ArtifactType, ArtifactClipboardMode } from '../shared/artifacts'
import { createRegisteredTaskArtifact, writeRegisteredTaskArtifactFile } from '../main/artifacts'
import { ARTIFACT_CODECS, ARTIFACT_LIMITS, ARTIFACT_OPERATIONS, type ArtifactCodec, type ArtifactOperation } from '../shared/artifact-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { JsonValue } from '../shared/service-protocol'
import { WorkspaceFileOwner, type WorkspaceFileOwnerOptions, type WorkspaceFileHandle, type WorkspacePathReceipt } from '../main/workspace-file-owner'
import { AgentManager } from '../main/agent-manager-core'
import { FakeAdapter } from '../../test/helpers/fake-adapter'
import { ArtifactBackend, type ArtifactBackendOptions } from './artifact-backend'

// Keep real file handles and directory handles. Controlled gates delay only
// native receipt boundaries; the artifact reader/derivation are never mocked.
const boundary = vi.hoisted(() => ({ afterOpen: null as ((path: string, handle: FileHandle) => Promise<void>) | null, beforeClose: null as ((path: string, handle: FileHandle) => Promise<void>) | null, afterDirectoryOpen: null as ((path: string) => Promise<void>) | null }))
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual,
    open: async (path: Parameters<typeof actual.open>[0], flags: Parameters<typeof actual.open>[1], mode?: Parameters<typeof actual.open>[2]) => {
      const handle = await actual.open(path, flags, mode), name = String(path)
      await boundary.afterOpen?.(name, handle)
      return new Proxy(handle, { get(target, key) {
        if (key === 'close') return async () => { await boundary.beforeClose?.(name, target); await target.close() }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
    opendir: async (path: Parameters<typeof actual.opendir>[0]) => { const directory = await actual.opendir(path); await boundary.afterDirectoryOpen?.(String(path)); return directory }
  }
})
let db: ReturnType<typeof createPortableTestDb>, backend: ArtifactBackend, options: ArtifactBackendOptions, root: string, workspaceRoot: string
let fileOwners: WorkspaceFileOwner[], managers: AgentManager[]
let task: NonNullable<ReturnType<typeof db.createTask>>, releases: Array<() => void>, allowedTasks: Set<string> | null, allowedProjects: Set<string> | null
const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'artifact-fixture', webviewId: 'main', origin: 'app://artifact-fixture' }
beforeEach(async () => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture'))); workspaceRoot = dirname(db.getWorkspaceDir('fixture'))
  task = db.createTask({ title: 'Synthetic artifact task' })!; releases = []; fileOwners = []; managers = []; allowedTasks = allowedProjects = null
  options = { database: db, workspaceRoot, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!db.db.open) throw new Error('Closed owner') }, assertArtifactOwners(database, path) { if (database !== db || path !== workspaceRoot) throw new Error('Wrong owner') },
    isTrustedDesktop: identity => identity.origin === caller.origin && identity.webviewId === caller.webviewId,
    canAccessTask: id => allowedTasks === null || allowedTasks.has(id), canAccessProject: id => allowedProjects === null || allowedProjects.has(id) }
  backend = new ArtifactBackend(options); boundary.afterOpen = boundary.beforeClose = boundary.afterDirectoryOpen = null
})
afterEach(async () => {
  for (const release of releases) release()
  await backend.close(); for (const owner of fileOwners) await owner.close(); vi.restoreAllMocks(); for (const manager of managers) { await manager.stopAllSessions(); await manager.stopServer() }; boundary.afterOpen = boundary.beforeClose = boundary.afterDirectoryOpen = null
  db.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
function held() { let release!: () => void; const promise = new Promise<void>(done => { release = done }); return { promise, release } }
async function call<K extends ArtifactOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = ARTIFACT_CODECS[operation] as ArtifactCodec<K>, wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true); return codec.decodeResult((wire as { value?: JsonValue }).value)
}
async function preview(content = '# Synthetic result', id = task.id) { const dir = db.getWorkspaceDir(id); await writeFile(join(dir, 'result.md'), content); return dir }
describe('production retained artifact real directory authority', () => {
  it('binds retained reads and unavailable copying without making missing workspaces and scans real registry/repository deliverables', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual([...ARTIFACT_OPERATIONS])
    const mkdirEffect = vi.spyOn(db, 'getWorkspaceDir')
    expect(await call('artifacts:scan', [task.id])).toEqual([]); expect(await call('artifacts:read', [task.id, 'missing.md'])).toBeNull(); expect(mkdirEffect).not.toHaveBeenCalled()
    const dir = await preview(); await mkdir(join(dir, 'repo', 'reports'), { recursive: true }); await writeFile(join(dir, 'repo', 'reports', 'summary.md'), '# Repo output')
    db.updateTask(task.id, { repos: ['synthetic/repo'] })
    const registered = await createRegisteredTaskArtifact(dir, task.id, { title: 'Explicit report', type: ArtifactType.HTML })
    await writeRegisteredTaskArtifactFile(dir, task.id, { artifactId: registered.artifactId, filename: 'index.html', content: '<main>Controlled result</main>' })
    const scanned = await call('artifacts:scan', [task.id])
    expect(scanned).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'repo/reports/summary.md' }), expect.objectContaining({ path: `artifacts/${registered.artifactId}/index.html`, title: 'Explicit report' })]))
    expect(await call('artifacts:read', [task.id, 'result.md'])).toEqual({ kind: 'text', content: '# Synthetic result', mimeType: 'text/markdown' })
    const before = await readFile(join(dir, '.20x', 'artifacts.json'), 'utf8'); await call('artifacts:scan', [task.id]); expect(await readFile(join(dir, '.20x', 'artifacts.json'), 'utf8')).toBe(before)
  })
  it('requires current trusted caller/task/project scopes and prevents foreign/missing/root-selected reads before effects', async () => {
    await preview(); allowedTasks = new Set()
    await expect(call('artifacts:read', [task.id, 'result.md'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    allowedTasks = null; allowedProjects = new Set()
    await expect(call('artifacts:scan', [task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); allowedProjects = null
    await expect(call('artifacts:scan', ['missing-task'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('artifacts:scan', [task.id], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    await expect(call('artifacts:scan', [task.id], undefined, { ...caller, origin: 'https://artifact.example' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(backend.registry.invoke('artifacts:read', { taskId: task.id, relativePath: 'result.md', root: root }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
  })
  it('preserves literal member/anchor workspaces and requires every current member and anchor grant', async () => {
    const agent = db.createAgent({ name: 'Group owner' })!, member = db.createTask({ title: 'Other member' })!
    db.updateTask(task.id, { agent_id: agent.id }); db.updateTask(member.id, { agent_id: agent.id })
    const group = db.createTaskGroup({ title: 'Controlled group', task_ids: [task.id, member.id] })
    await preview('Legacy member-owned bytes'); await preview('Anchor-owned bytes', group.execution_task_id)
    expect((await call('artifacts:read', [task.id, 'result.md']))?.content).toBe('Legacy member-owned bytes')
    expect((await call('artifacts:read', [group.execution_task_id, 'result.md']))?.content).toBe('Anchor-owned bytes')
    allowedTasks = new Set([task.id, group.execution_task_id]); await expect(call('artifacts:read', [task.id, 'result.md'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    allowedTasks = new Set([task.id, member.id]); await expect(call('artifacts:scan', [task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    allowedTasks = null; db.dissolveTaskGroup(group.id)
    expect((await call('artifacts:read', [group.execution_task_id, 'result.md']))?.content).toBe('Anchor-owned bytes')
    allowedTasks = new Set([group.execution_task_id]); await expect(call('artifacts:read', [group.execution_task_id, 'result.md'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
  it('rejects symlinked workspace/parent/leaf paths and preserves outside files and inactive retired state', async () => {
    const dir = await preview(), outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private.md'), 'outside private bytes')
    const retired = JSON.stringify({ canvas: { panels: [{ id: 'old-browser', type: 'browser', url: 'https://inactive.example', x: 20 }], edges: [{ id: 'old-edge' }] }, recording: 'copied historical fixture' })
    db.setSetting('retired-canvas-fixture', retired); await writeFile(join(dir, 'historical-recording.bin'), 'copied historical recording bytes')
    await symlink(outside, join(dir, 'linked')); await symlink(join(outside, 'private.md'), join(dir, 'private.md'))
    expect(await call('artifacts:read', [task.id, 'linked/private.md'])).toBeNull(); expect(await call('artifacts:read', [task.id, 'private.md'])).toBeNull()
    await rename(dir, dir + '-preserved'); await symlink(outside, dir)
    await expect(call('artifacts:scan', [task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await readFile(join(outside, 'private.md'), 'utf8')).toBe('outside private bytes')
    expect(db.getSetting('retired-canvas-fixture')).toBe(retired)
    expect(await readFile(join(dir + '-preserved', 'historical-recording.bin'), 'utf8')).toBe('copied historical recording bytes')
  })
  it('explicitly refuses portable text/image/registry capacity without truncating or deleting retained bytes', async () => {
    const dir = await preview(); await writeFile(join(dir, 'large.png'), Buffer.alloc(ARTIFACT_LIMITS.imageBytes + 1, 1)); await writeFile(join(dir, 'large.md'), 'x'.repeat(ARTIFACT_LIMITS.textBytes + 1))
    for (const path of ['large.png', 'large.md']) await expect(call('artifacts:read', [task.id, path])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' })
    expect((await readFile(join(dir, 'large.png'))).length).toBe(ARTIFACT_LIMITS.imageBytes + 1)
    await mkdir(join(dir, '.20x')); const oversized = 'x'.repeat(ARTIFACT_LIMITS.registryBytes + 1); await writeFile(join(dir, '.20x', 'artifacts.json'), oversized)
    await expect(call('artifacts:scan', [task.id])).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' }); expect(await readFile(join(dir, '.20x', 'artifacts.json'), 'utf8')).toBe(oversized)
  })
  it('preflights stored repository JSON without parsing oversized legacy fields or modifying them', async () => {
    const malformed = 'x'.repeat(65_537); db.db.prepare('UPDATE tasks SET repos=? WHERE id=?').run(malformed, task.id)
    const parse = vi.spyOn(JSON, 'parse')
    await expect(call('artifacts:scan', [task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(parse).not.toHaveBeenCalledWith(malformed)
    expect((db.db.prepare('SELECT repos FROM tasks WHERE id=?').get(task.id) as { repos: string }).repos).toBe(malformed)
  })
  it('rejects a late revoked grant/repository binding before publishing actual opened content', async () => {
    const dir = await preview(), gate = held(), entered = held(); releases.push(gate.release)
    boundary.afterOpen = async path => { if (path === join(dir, 'result.md')) { entered.release(); await gate.promise } }
    const pending = call('artifacts:read', [task.id, 'result.md']), rejected = expect(pending).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await entered.promise; db.updateTask(task.id, { repos: ['foreign/replacement'] }); gate.release(); await rejected
    boundary.afterOpen = null; expect(await readFile(join(dir, 'result.md'), 'utf8')).toBe('# Synthetic result')
    const gate2 = held(), entered2 = held(); releases.push(gate2.release)
    boundary.afterOpen = async path => { if (path === join(dir, 'result.md')) { entered2.release(); await gate2.promise } }
    const request = call('artifacts:read', [task.id, 'result.md']), denied = expect(request).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await entered2.promise; allowedTasks = new Set(); gate2.release(); await denied
  })
  it('keeps a real file descriptor owned through request cancellation and a failed close until native close joins', async () => {
    const dir = await preview(), gate = held(), entered = held(), abort = new AbortController(); releases.push(gate.release)
    let owned!: FileHandle
    boundary.beforeClose = async (path, handle) => { if (path === join(dir, 'result.md')) { owned = handle; entered.release(); await gate.promise } }
    const request = call('artifacts:read', [task.id, 'result.md'], abort.signal), cancelled = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise; abort.abort(); await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect((await owned.stat()).isFile()).toBe(true); expect(backend.inflightCount).toBe(1); expect(db.db.open).toBe(true)
    let joined = false; const retry = backend.close().then(() => { joined = true }); await Promise.resolve(); expect(joined).toBe(false)
    gate.release(); await cancelled; await retry; expect(owned.fd).toBe(-1); expect(backend.inflightCount).toBe(0)
  })
  it('retains a real directory scan handle across cancellation rather than treating the public deadline as closure', async () => {
    const dir = await preview(), gate = held(), entered = held(), abort = new AbortController(); releases.push(gate.release)
    boundary.afterDirectoryOpen = async path => { if (path === dir) { entered.release(); await gate.promise } }
    const request = call('artifacts:scan', [task.id], abort.signal), cancelled = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise; abort.abort(); await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBe(1)
    gate.release(); await cancelled; await backend.close(); expect(backend.inflightCount).toBe(0)
  })
  it('fences actual workspace replacement during an opened read without leaking new-root content or retargeting the owner', async () => {
    const dir = await preview('Old owned content'), gate = held(), entered = held(); releases.push(gate.release)
    boundary.afterOpen = async path => { if (path === join(dir, 'result.md')) { entered.release(); await gate.promise } }
    const request = call('artifacts:read', [task.id, 'result.md']), refused = expect(request).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await entered.promise; await rename(dir, dir + '-old'); await mkdir(dir); await writeFile(join(dir, 'result.md'), 'New directory identity')
    gate.release(); await refused; expect(await readFile(join(dir + '-old', 'result.md'), 'utf8')).toBe('Old owned content')
  })
})


describe('actual artifact clipboard source and current read authority', () => {
  const identity: DesktopCallerContext = { ...caller, uiLeaseId: 'ui_artifact_clipboard' }
  async function enableCopy(callback: NonNullable<ArtifactBackendOptions['copyArtifact']> = async () => ({ mode: ArtifactClipboardMode.FILE }), primitives: WorkspaceFileOwnerOptions['fs'] = {}) {
    await backend.close()
    const files = new WorkspaceFileOwner({ workspaceRoot, assertCurrent() { if (!db.db.open) throw new Error('Closed owner') }, fs: primitives }); fileOwners.push(files)
    options = { ...options, files, copyArtifact: callback, canAccessAgent: () => true, assertArtifactOwners(database, root, owner) { if (database !== db || root !== workspaceRoot || owner !== files) throw new Error('Wrong file owner') } }
    backend = new ArtifactBackend(options); return files
  }
  it('returns unavailable for missing capability or source, without byte reads, native effects or workspace creation', async () => {
    const creator = vi.spyOn(db, 'getWorkspaceDir')
    expect(await call('artifacts:copyFile', [task.id, 'missing.md'], undefined, identity)).toEqual({ mode: 'unavailable' }); expect(creator).not.toHaveBeenCalled()
    const copied = vi.fn(async () => ({ mode: ArtifactClipboardMode.FILE })), fd = vi.fn(async (path: string, flags: number) => { const handle = await open(path, flags); return { stat: () => handle.stat({ bigint: true }), read: (...args: Parameters<WorkspaceFileHandle['read']>) => handle.read(...args), close: () => handle.close() } })
    await enableCopy(copied, { open: fd })
    expect(await call('artifacts:copyFile', [task.id, 'missing.md'], undefined, identity)).toEqual({ mode: 'unavailable' }); expect(creator).not.toHaveBeenCalled(); expect(copied).not.toHaveBeenCalled(); expect(fd).not.toHaveBeenCalled()
  })
  it('copies large file references for an actual live task without reading content, stopping its agent or loading private whole rows', async () => {
    const dir = await preview(), agent = db.createAgent({ name: 'Actual artifact owner', config: { coding_agent: 'opencode' } })!
    db.updateTask(task.id, { agent_id: agent.id })
    const manager = new AgentManager(db, { renderer: { kind: 'unsupported' }, notifications: { kind: 'unsupported' }, energy: { kind: 'unsupported' }, secrets: { kind: 'unsupported' }, configuredMcp: 'disabled', managedTaskMcp: { kind: 'disabled' }, createAdapter: () => new FakeAdapter(), isCodexAppServerAdapter: () => false }); managers.push(manager)
    const started = await manager.requestSession(agent.id, task.id); expect(started.status).toBe('started'); if (!('sessionId' in started)) throw new Error('No actual session')
    await writeFile(join(dir, 'large.bin'), Buffer.alloc(600 * 1024, 65)); let reads = 0
    const native = vi.fn(async (receipt: WorkspacePathReceipt) => { expect(receipt.path).toBe(join(dir, 'large.bin')); expect(receipt.target.size).toBe(String(600 * 1024)); return { mode: ArtifactClipboardMode.FILE } })
    await enableCopy(native, { open: async (path, flags) => { const handle = await open(path, flags); return { stat: () => handle.stat({ bigint: true }), read: (...args) => { reads++; return handle.read(...args) }, close: () => handle.close() } } })
    db.db.prepare('UPDATE tasks SET feedback_comment=? WHERE id=?').run('Unrelated retained private field'.repeat(10000), task.id)
    const taskGetter = vi.spyOn(db, 'getTask').mockImplementation(() => { throw new Error('Full task getter forbidden') }), agentGetter = vi.spyOn(db, 'getAgent').mockImplementation(() => { throw new Error('Credential getter forbidden') })
    expect(await call('artifacts:copyFile', [task.id, 'large.bin'], undefined, identity)).toEqual({ mode: 'file' }); expect(reads).toBe(0); expect(native).toHaveBeenCalledTimes(1); expect(taskGetter).not.toHaveBeenCalled(); expect(agentGetter).not.toHaveBeenCalled(); expect(manager.getSession(started.sessionId)).toBeDefined()
  })
  it('preserves literal Captain/member/anchor paths and requires group task/project/independent agent read grants', async () => {
    db.ensureCoordinatorTask(task.project_id); const captain = db.getCoordinatorTask(task.project_id)!, member = db.createTask({ title: 'Other member' })!, agent = db.createAgent({ name: 'Independent group owner' })!
    const group = db.createTaskGroup({ title: 'Clipboard group', task_ids: [task.id, member.id], agent_id: agent.id })
    await preview('Member bytes'); await preview('Anchor bytes', group.execution_task_id); await preview('Captain bytes', captain.id)
    const paths: string[] = []; await enableCopy(async receipt => { paths.push(receipt.path); return { mode: ArtifactClipboardMode.FILE } })
    for (const id of [task.id, group.execution_task_id, captain.id]) expect(await call('artifacts:copyFile', [id, 'result.md'], undefined, identity)).toEqual({ mode: 'file' })
    expect(paths).toEqual([task.id, group.execution_task_id, captain.id].map(id => join(workspaceRoot, id, 'result.md')))
    allowedTasks = new Set([task.id, group.execution_task_id]); await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); allowedTasks = null
    options.canAccessAgent = id => id !== agent.id; await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); options.canAccessAgent = () => true
    allowedProjects = new Set(); await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(paths).toHaveLength(3)
  })
  it.each(['scope', 'grant', 'callback', 'cancel'] as const)('refuses %s drift before a held native clipboard write and retains source FD until raw callback cleanup', async kind => {
    const dir = await preview(), entered = held(), gate = held(), closing = held(), closed = held(), controller = new AbortController(); releases.push(gate.release, closed.release)
    let writes = 0, guard: (() => void) | undefined
    const native = vi.fn(async (_receipt: WorkspacePathReceipt, _caller: DesktopCallerContext, _signal: AbortSignal, beforeEffect: () => void) => { guard = beforeEffect; entered.release(); await gate.promise; try { beforeEffect(); writes++; return { mode: ArtifactClipboardMode.FILE } } finally { closing.release(); await closed.promise } })
    const files = await enableCopy(native), request = call('artifacts:copyFile', [task.id, 'result.md'], controller.signal, identity), outcome = request.catch(error => error)
    await entered.promise
    if (kind === 'scope') db.db.prepare('UPDATE tasks SET repos=? WHERE id=?').run('["changed/repo"]', task.id)
    if (kind === 'grant') allowedTasks = new Set()
    if (kind === 'callback') options.copyArtifact = async () => ({ mode: ArtifactClipboardMode.FILE })
    if (kind === 'cancel') controller.abort()
    gate.release(); await closing.promise; expect(writes).toBe(0); expect(files.inflightCount).toBeGreaterThan(0); expect(backend.inflightCount).toBe(1)
    closed.release(); expect(await outcome).toMatchObject({ code: kind === 'cancel' ? 'CANCELLED' : kind === 'callback' ? 'DISCONNECTED' : 'INVALID_REQUEST' }); expect(native).toHaveBeenCalledTimes(1); expect(files.inflightCount).toBe(0)
    allowedTasks = null; expect(() => guard!()).toThrow(); expect(await readFile(join(dir, 'result.md'), 'utf8')).toBe('# Synthetic result')
  })
  it('retains ignored native work through shutdown timeout, without treating public cancellation as a clipboard receipt', async () => {
    await preview(); const entered = held(), gate = held(), controller = new AbortController(); releases.push(gate.release)
    const native = vi.fn(async () => { entered.release(); await gate.promise; return { mode: ArtifactClipboardMode.FILE } }), files = await enableCopy(native)
    const outcome = call('artifacts:copyFile', [task.id, 'result.md'], controller.signal, identity).catch(error => error)
    await entered.promise; controller.abort(); await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); await expect(files.close(5)).rejects.toMatchObject({ code: 'WORKSPACE_DRAIN_INCOMPLETE' }); expect(db.db.open).toBe(true)
    gate.release(); expect(await outcome).toMatchObject({ code: 'CANCELLED' }); await backend.close(); await files.close(); expect(native).toHaveBeenCalledTimes(1)
  })
  it('refuses malformed or unsupported native mode results and private diagnostics without replaying', async () => {
    await preview()
    for (const result of [{ mode: 'image' }, { mode: 'path' }, { mode: 'file', path: '/private' }, {}]) {
      const native = vi.fn(async () => result as never); await enableCopy(native)
      await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_RESULT' }); expect(native).toHaveBeenCalledTimes(1)
    }
    const native = vi.fn(async () => { throw new Error('Private clipboard destination token') }); await enableCopy(native)
    const error = await call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity).catch(error => error)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' }); expect(error.message).not.toContain('Private clipboard'); expect(native).toHaveBeenCalledTimes(1)
  })
  it('retains a failed exact source close for explicit owner drain retry and blocks subsequent clipboard effects', async () => {
    await preview(); let refuseClose = true
    const native = vi.fn(async () => ({ mode: ArtifactClipboardMode.FILE }))
    const files = await enableCopy(native, { open: async (path, flags) => { const handle = await open(path, flags); return { stat: () => handle.stat({ bigint: true }), read: (...args) => handle.read(...args), close: async () => { if (refuseClose) throw new Error('Controlled native FD close failure'); await handle.close() } } } })
    try {
      await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' }); expect(files.inflightCount).toBeGreaterThan(0)
      await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'BACKPRESSURE' }); expect(native).toHaveBeenCalledTimes(1)
      await expect(files.close()).rejects.toMatchObject({ code: 'WORKSPACE_DRAIN_INCOMPLETE' }); expect(db.db.open).toBe(true); expect(files.inflightCount).toBeGreaterThan(0)
    } finally { refuseClose = false; await files.close() }
    expect(files.inflightCount).toBe(0); expect(native).toHaveBeenCalledTimes(1)
  })
  it('freezes only validated mode before descriptor cleanup awaits so a borrowed mutable result cannot claim another effect', async () => {
    await preview(); const result = { mode: ArtifactClipboardMode.FILE }; let stats = 0
    await enableCopy(async () => result, { open: async (path, flags) => { const handle = await open(path, flags); return { stat: async () => { const info = await handle.stat({ bigint: true }); if (++stats > 1) result.mode = ArtifactClipboardMode.PATH; return info }, read: (...args) => handle.read(...args), close: () => handle.close() } } })
    expect(await call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).toEqual({ mode: 'file' }); expect(result.mode).toBe('path')
  })
  it('bounds scope materialization, refuses private arguments and documentless calls before native/FD effects', async () => {
    await preview(); const native = vi.fn(async () => ({ mode: ArtifactClipboardMode.FILE })); await enableCopy(native)
    await expect(call('artifacts:copyFile', [task.id, 'result.md'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    for (const key of ['root', 'path', 'leaseId', 'authorizationId', 'receipt', 'destination']) await expect(backend.registry.invoke('artifacts:copyFile', { taskId: task.id, relativePath: 'result.md', [key]: 'forged' }, identity, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    const raw = 'x'.repeat(65537); db.db.prepare('UPDATE tasks SET repos=? WHERE id=?').run(raw, task.id)
    const parse = vi.spyOn(JSON, 'parse'); await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(parse).not.toHaveBeenCalledWith(raw); expect(native).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform === 'win32')('refuses linked paths and named replacement after native without altering unrelated retained bytes', async () => {
    const dir = await preview(), outside = join(root, 'unrelated-user-bytes'); await writeFile(outside, 'Preserve outside')
    await symlink(outside, join(dir, 'linked')); await link(join(dir, 'result.md'), join(dir, 'hardlink'))
    const native = vi.fn(async () => ({ mode: ArtifactClipboardMode.FILE })); await enableCopy(native)
    for (const path of ['linked', 'hardlink']) await expect(call('artifacts:copyFile', [task.id, path], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(native).not.toHaveBeenCalled()
    await rm(join(dir, 'hardlink')); const saved = join(dir, 'retained-original')
    const replacement = vi.fn(async () => { await rename(join(dir, 'result.md'), saved); await writeFile(join(dir, 'result.md'), 'Replacement user bytes'); return { mode: ArtifactClipboardMode.FILE } }); await enableCopy(replacement)
    await expect(call('artifacts:copyFile', [task.id, 'result.md'], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(replacement).toHaveBeenCalledTimes(1)
    expect(await readFile(saved, 'utf8')).toBe('# Synthetic result'); expect(await readFile(join(dir, 'result.md'), 'utf8')).toBe('Replacement user bytes'); expect(await readFile(outside, 'utf8')).toBe('Preserve outside')
  })
})

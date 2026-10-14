import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, open, readFile, rename, rm, symlink, writeFile, link, type FileHandle } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { WorkspaceFileOwner, type WorkspaceFileHandle, type WorkspaceFileOwnerOptions, type WorkspacePathReceipt } from '../main/workspace-file-owner'
import { WORKSPACE_FILE_CODECS, WORKSPACE_FILE_OPERATIONS, WORKSPACE_FILE_LIMITS, type WorkspaceFileCodec, type WorkspaceFileOperation } from '../shared/workspace-file-codecs'
import type { DesktopCommandMap } from '../shared/desktop-operations'
import { ServiceProtocolError, type JsonValue } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import { WorkspaceFileBackend, type WorkspaceFileBackendOptions } from './workspace-file-backend'

const caller: DesktopCallerContext = { principal: 'trusted-desktop-main', engineEpoch: 'workspace-file-fixture', webviewId: 'main', origin: 'app://workspace-file-fixture' }
let db: ReturnType<typeof createPortableTestDb>, files: WorkspaceFileOwner, backend: WorkspaceFileBackend, options: WorkspaceFileBackendOptions, ownerOptions: WorkspaceFileOwnerOptions, root: string, workspaceRoot: string
let task: NonNullable<ReturnType<typeof db.createTask>>, allowedTasks: Set<string> | null, allowedProjects: Set<string> | null, ownerValid: boolean
let releases: Array<() => void>, handles: FileHandle[], afterOpen: ((path: string, handle: FileHandle) => Promise<void>) | null, beforeClose: ((path: string, handle: FileHandle) => Promise<void>) | null
let nativeCalls: Array<{ operation: 'open' | 'reveal'; path: string; receipt: WorkspacePathReceipt }>, nativeBoundary: ((receipt: WorkspacePathReceipt) => Promise<void>) | null
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
beforeEach(() => {
  db = createPortableTestDb(); root = dirname(dirname(db.getWorkspaceDir('fixture'))); workspaceRoot = dirname(db.getWorkspaceDir('fixture'))
  task = db.createTask({ title: 'Actual literal workspace task' })!; allowedTasks = allowedProjects = null; ownerValid = true; releases = []; handles = []; nativeCalls = []; afterOpen = beforeClose = nativeBoundary = null
  ownerOptions = { workspaceRoot, assertCurrent() { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, fs: {
    open: async (path, flags): Promise<WorkspaceFileHandle> => {
      const handle = await open(path, flags); handles.push(handle); await afterOpen?.(path, handle)
      return { stat: () => handle.stat({ bigint: true }), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: async () => { await beforeClose?.(path, handle); await handle.close() } }
    }
  } }
  files = new WorkspaceFileOwner(ownerOptions)
  options = { database: db, files, workspaceRoot, engineEpoch: caller.engineEpoch,
    assertAvailable() { if (!ownerValid || !db.db.open) throw new ServiceProtocolError('DISCONNECTED') }, assertWorkspaceFileOwners(actualDatabase, actualFiles, actualRoot) { if (actualDatabase !== db || actualFiles !== files || actualRoot !== workspaceRoot) throw new ServiceProtocolError('DISCONNECTED') },
    isTrustedDesktop: identity => identity.webviewId === caller.webviewId && identity.origin === caller.origin,
    canAccessTask: id => allowedTasks === null || allowedTasks.has(id), canAccessProject: id => allowedProjects === null || allowedProjects.has(id) }
  backend = new WorkspaceFileBackend(options)
})
afterEach(async () => {
  ownerValid = true; allowedTasks = allowedProjects = null; for (const release of releases) release(); beforeClose = null
  await backend.close(); await files.close(); if (db.db.open) db.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
async function nativeEnabled() {
  await backend.close()
  files = new WorkspaceFileOwner({ ...ownerOptions, native: {
    openPath: async (path, receipt) => { nativeCalls.push({ operation: 'open', path, receipt }); await nativeBoundary?.(receipt) },
    showItemInFolder: async (path, receipt) => { nativeCalls.push({ operation: 'reveal', path, receipt }); await nativeBoundary?.(receipt) }
  } }); options = { ...options, files }; backend = new WorkspaceFileBackend(options)
}
async function call<K extends WorkspaceFileOperation>(operation: K, args: DesktopCommandMap[K]['apiArguments'], signal = new AbortController().signal, identity = caller): Promise<DesktopCommandMap[K]['result']> {
  const codec = WORKSPACE_FILE_CODECS[operation] as WorkspaceFileCodec<K>, wire = await backend.registry.invoke(operation, codec.encodeArguments(args), identity, signal)
  expect(codec.validateWireResult(wire)).toBe(true); return codec.decodeResult((wire as { value?: JsonValue }).value)
}
async function preview(content: string | Buffer = 'Owned synthetic text', id = task.id) { const directory = db.getWorkspaceDir(id), path = join(directory, 'result.txt'); await writeFile(path, content); return path }
function group() { const agent = db.createAgent({ name: 'Group owner' })!, member = db.createTask({ title: 'Another group member' })!; db.updateTask(task.id, { agent_id: agent.id }); db.updateTask(member.id, { agent_id: agent.id }); return { member, group: db.createTaskGroup({ title: 'Shared group', task_ids: [task.id, member.id] }) } }

describe('retained workspace controls using actual SQLite and filesystem owner', () => {
  it('registers read/directory operations and keeps absent native actions unavailable before any filesystem effect', async () => {
    expect(Object.keys(backend.operationSchemas(caller))).toEqual(['tasks:getWorkspaceDir', 'shell:readTextFile'])
    const directory = join(workspaceRoot, task.id), oldGetter = vi.spyOn(db, 'getWorkspaceDir')
    expect(await call('tasks:getWorkspaceDir', [task.id])).toBe(directory); expect(existsSync(directory)).toBe(true); expect(oldGetter).not.toHaveBeenCalled()
    const effect = vi.spyOn(files, 'openPath')
    await expect(call('shell:openPath', [join(root, 'private-key')])).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' }); expect(effect).not.toHaveBeenCalled(); expect(nativeCalls).toEqual([])
    await expect(call('shell:showItemInFolder', [directory])).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' }); expect(handles).toEqual([])
  })
  it('reads actual bounded Unicode text, retains missing/empty/oversized metadata and never modifies source bytes', async () => {
    const path = await preview('研究 🦀 résumé\nOwned text'), directory = dirname(path), unicode = join(directory, '研究 🦀 résumé.txt')
    await rename(path, unicode); const content = await readFile(unicode, 'utf8')
    expect(await call('shell:readTextFile', [unicode])).toEqual({ content, size: Buffer.byteLength(content) })
    expect(await call('shell:readTextFile', [join(directory, 'missing.txt')])).toBeNull()
    const empty = join(directory, 'empty.txt'); await writeFile(empty, ''); expect(await call('shell:readTextFile', [empty])).toEqual({ content: '', size: 0 })
    const large = join(directory, 'large.txt'), bytes = Buffer.alloc(WORKSPACE_FILE_LIMITS.contentBytes + 1, 120); await writeFile(large, bytes)
    expect(await call('shell:readTextFile', [large])).toEqual({ content: '', size: bytes.length }); expect(await readFile(large)).toEqual(bytes)
    const malformed = join(directory, 'legacy-malformed-utf8.txt'); await writeFile(malformed, Buffer.from([0xff]))
    expect(await call('shell:readTextFile', [malformed])).toEqual({ content: '\uFFFD', size: 1 })
  })
  it('requires trusted current task/project context and rejects arbitrary/private roots and caller scope overrides', async () => {
    const path = await preview(); allowedTasks = new Set()
    await expect(call('shell:readTextFile', [path])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); allowedTasks = null; allowedProjects = new Set()
    await expect(call('tasks:getWorkspaceDir', [task.id])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); allowedProjects = null
    for (const target of [workspaceRoot, join(root, 'private-store'), join(workspaceRoot, 'missing-task', 'file.txt')]) await expect(call('shell:readTextFile', [target])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(call('tasks:getWorkspaceDir', ['missing-task'])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(existsSync(join(workspaceRoot, 'missing-task'))).toBe(false)
    await expect(call('shell:readTextFile', [path], undefined, { ...caller, engineEpoch: 'old' })).rejects.toMatchObject({ code: 'STALE_EPOCH' })
    for (const identity of [{ ...caller, origin: 'https://foreign.example' }, { ...caller, webviewId: 'foreign' }]) await expect(call('shell:readTextFile', [path], undefined, identity)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(backend.registry.invoke('shell:readTextFile', { filePath: path, taskId: 'foreign', workspaceRoot: root }, caller, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    expect(() => new WorkspaceFileBackend({ ...options, workspaceRoot: root })).toThrow(); expect(await readFile(path, 'utf8')).toBe('Owned synthetic text')
  })
  it('preserves literal member files, anchors and historical group grant requirements', async () => {
    const value = group(), memberPath = await preview('Literal member bytes'), anchorPath = await preview('Execution anchor bytes', value.group.execution_task_id)
    expect((await call('shell:readTextFile', [memberPath]))?.content).toBe('Literal member bytes'); expect((await call('shell:readTextFile', [anchorPath]))?.content).toBe('Execution anchor bytes')
    allowedTasks = new Set([task.id, value.group.execution_task_id]); await expect(call('shell:readTextFile', [memberPath])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    allowedTasks = null; db.dissolveTaskGroup(value.group.id); expect((await call('shell:readTextFile', [anchorPath]))?.content).toBe('Execution anchor bytes')
    allowedTasks = new Set([value.group.execution_task_id]); await expect(call('shell:readTextFile', [anchorPath])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    allowedTasks = new Set([task.id]); expect((await call('shell:readTextFile', [memberPath]))?.content).toBe('Literal member bytes')
  })
  it('refuses symlink/hardlink/escaping paths and preserves unrelated files and inactive saved state', async () => {
    const path = await preview(), outside = join(root, 'outside'); await mkdir(outside); const privateFile = join(outside, 'private.txt'); await writeFile(privateFile, 'Private preserved bytes')
    await symlink(privateFile, join(dirname(path), 'linked.txt')); await symlink(outside, join(dirname(path), 'linked-directory')); await link(privateFile, join(dirname(path), 'hardlinked.txt'))
    for (const target of [join(dirname(path), 'linked.txt'), join(dirname(path), 'linked-directory', 'private.txt'), join(dirname(path), 'hardlinked.txt'), `${dirname(path)}/../outside/private.txt`]) await expect(call('shell:readTextFile', [target])).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_ARGUMENTS|INVALID_REQUEST/) })
    db.setSetting('inactive-layout', '{"panels":[{"id":"browser-old","type":"browser","url":"https://inactive.example"}]}')
    expect(await readFile(privateFile, 'utf8')).toBe('Private preserved bytes'); expect(db.getSetting('inactive-layout')).toContain('browser-old'); expect(await readFile(path, 'utf8')).toBe('Owned synthetic text')
  })
  it.each(['session', 'role', 'repository', 'project-repository', 'grant'])('fences changed %s scope after an actual native file open', async kind => {
    const path = await preview(), gate = held(), entered = held(); releases.push(gate.release)
    afterOpen = async (name) => { if (name === path) { entered.release(); await gate.promise } }
    const pending = call('shell:readTextFile', [path]), failed = pending.catch(error => error)
    await entered.promise
    if (kind === 'session') db.db.prepare('UPDATE tasks SET session_id=? WHERE id=?').run('changed-session', task.id)
    if (kind === 'role') db.db.prepare('UPDATE tasks SET role=? WHERE id=?').run('captain', task.id)
    if (kind === 'repository') db.updateTask(task.id, { repos: ['different/repo'] })
    if (kind === 'project-repository') db.addProjectRepo(task.project_id, { org: 'different', name: 'repo', provider: 'github' })
    if (kind === 'grant') allowedTasks = new Set()
    gate.release(); expect(await failed).toMatchObject({ code: 'INVALID_REQUEST' }); expect(handles.every(handle => handle.fd === -1)).toBe(true); expect(await readFile(path, 'utf8')).toBe('Owned synthetic text')
  })
  it('fences membership and physical-root replacement rather than retargeting pending reads', async () => {
    const value = group(), path = await preview(), gate = held(), entered = held(); releases.push(gate.release)
    afterOpen = async name => { if (name === path) { entered.release(); await gate.promise } }
    const pending = call('shell:readTextFile', [path]), failed = pending.catch(error => error); await entered.promise
    db.removeTaskFromGroup(value.group.id, value.member.id); gate.release(); expect(await failed).toMatchObject({ code: 'INVALID_REQUEST' })
    afterOpen = null; const old = dirname(path); await rename(old, old + '-preserved'); await mkdir(old); await writeFile(path, 'Foreign replacement bytes')
    await expect(call('shell:readTextFile', [path])).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(await readFile(join(old + '-preserved', 'result.txt'), 'utf8')).toBe('Owned synthetic text')
  })
  it('retains an actual late file open and close through caller abort and public deadline', async () => {
    const path = await preview(), gate = held(), entered = held(), controller = new AbortController(); releases.push(gate.release)
    afterOpen = async name => { if (name === path) { entered.release(); await gate.promise } }
    const pending = call('shell:readTextFile', [path], controller.signal), failed = pending.catch(error => error); await entered.promise; controller.abort()
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(handles[0]!.fd).not.toBe(-1); expect(backend.inflightCount).toBeGreaterThan(0); expect(db.db.open).toBe(true)
    gate.release(); expect(await failed).toMatchObject({ code: 'CANCELLED' }); await backend.close(); expect(handles[0]!.fd).toBe(-1); expect(backend.inflightCount).toBe(0)
  })
  it('bounds accepted raw reads and keeps all accepted descriptors owned until cancellation closes them', async () => {
    const path = await preview(), gate = held(), entered = held(); releases.push(gate.release)
    let opened = 0
    afterOpen = async name => { if (name === path) { if (++opened === WORKSPACE_FILE_LIMITS.requests) entered.release(); await gate.promise } }
    const pending = Array.from({ length: WORKSPACE_FILE_LIMITS.requests }, () => call('shell:readTextFile', [path]).catch(error => error))
    await entered.promise
    await expect(call('shell:readTextFile', [path])).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(opened).toBe(WORKSPACE_FILE_LIMITS.requests); expect(handles).toHaveLength(WORKSPACE_FILE_LIMITS.requests)
    backend.shutdown(); gate.release()
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ code: 'CANCELLED' })
    await backend.close(); expect(handles.every(handle => handle.fd === -1)).toBe(true); expect(backend.inflightCount).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('Owned synthetic text')
  })
  it('blocks backend drain after a failed actual descriptor close and retries only that exact receipt', async () => {
    const path = await preview(); let rejectClose = true; beforeClose = async name => { if (name === path && rejectClose) throw new Error('Native close not acknowledged') }
    await expect(call('shell:readTextFile', [path])).rejects.toMatchObject({ code: 'INTERNAL_ERROR' }); expect(handles[0]!.fd).not.toBe(-1)
    await expect(backend.close()).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(backend.inflightCount).toBeGreaterThan(0); expect(db.db.open).toBe(true)
    rejectClose = false; await backend.close(); expect(handles[0]!.fd).toBe(-1); expect(backend.inflightCount).toBe(0)
  })
  it('passes only actual scoped native receipts and retains acknowledgement during cancellation without replay', async () => {
    await nativeEnabled(); expect(Object.keys(backend.operationSchemas(caller))).toEqual([...WORKSPACE_FILE_OPERATIONS])
    const path = await preview(); expect(await call('shell:openPath', [path])).toBeUndefined(); expect(await call('shell:showItemInFolder', [path])).toBeUndefined()
    expect(nativeCalls.map(call => call.operation)).toEqual(['open', 'reveal']); expect(nativeCalls[0]!.receipt).toMatchObject({ version: 1, taskId: task.id, workspaceRoot, path, target: { path, kind: 'file', nlink: '1' } }); expect(nativeCalls[0]!.receipt.target.ino).toMatch(/^\d+$/)
    const gate = held(), entered = held(), controller = new AbortController(); releases.push(gate.release); nativeBoundary = async () => { entered.release(); await gate.promise }
    const pending = call('shell:openPath', [path], controller.signal), failed = pending.catch(error => error); await entered.promise; controller.abort()
    await expect(backend.close(5)).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(nativeCalls).toHaveLength(3); expect(db.db.open).toBe(true)
    gate.release(); expect(await failed).toMatchObject({ code: 'CANCELLED' }); await backend.close(); expect(nativeCalls).toHaveLength(3); expect(handles.every(handle => handle.fd === -1)).toBe(true)
  })
  it('refuses revoked native scope before callback and suppresses a result revoked while acknowledgement is pending', async () => {
    await nativeEnabled(); const path = await preview(), gate = held(), entered = held(); releases.push(gate.release)
    afterOpen = async name => { if (name === path) { entered.release(); await gate.promise } }
    const pending = call('shell:openPath', [path]), failed = pending.catch(error => error); await entered.promise; allowedProjects = new Set(); gate.release()
    expect(await failed).toMatchObject({ code: 'INVALID_REQUEST' }); expect(nativeCalls).toEqual([])
    allowedProjects = null; afterOpen = null; const gate2 = held(), entered2 = held(); releases.push(gate2.release); nativeBoundary = async () => { entered2.release(); await gate2.promise }
    const nativePending = call('shell:showItemInFolder', [path]), nativeFailed = nativePending.catch(error => error); await entered2.promise; allowedTasks = new Set(); gate2.release()
    expect(await nativeFailed).toMatchObject({ code: 'INVALID_REQUEST' }); expect(nativeCalls).toHaveLength(1); expect(await readFile(path, 'utf8')).toBe('Owned synthetic text')
  })
})

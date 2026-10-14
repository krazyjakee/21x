import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, open, readFile, realpath, rename, rm, symlink, link, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { WorkspaceFileOwner, WORKSPACE_FILE_LIMITS, type WorkspaceFileControls, type WorkspaceFileHandle, type WorkspaceFileOwnerOptions, type WorkspacePathReceipt } from './workspace-file-owner'
import { isWorkspacePathReceipt } from '../shared/workspace-native-callbacks'

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let parent: string, root: string, workspace: string, file: string, owners: WorkspaceFileOwner[]
beforeEach(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'workspace-file-owner-')))
  root = join(parent, 'workspaces'); workspace = join(root, 'task-one'); file = join(workspace, 'readme.txt'); owners = []
  await mkdir(root); await mkdir(workspace); await writeFile(file, 'Actual workspace text 🌱\n')
  await writeFile(join(parent, 'unrelated.txt'), 'Unowned data remains unchanged')
})
afterEach(async () => {
  for (const owner of owners) await owner.close()
  expect(await readFile(join(parent, 'unrelated.txt'), 'utf8')).toBe('Unowned data remains unchanged')
  await rm(parent, { recursive: true, force: true }); vi.restoreAllMocks()
})
function controls(beforeEffect: () => void = () => {}, controller = new AbortController()): WorkspaceFileControls { return { beforeEffect, signal: controller.signal } }
function make(changes: Partial<WorkspaceFileOwnerOptions> = {}): WorkspaceFileOwner {
  const owner = new WorkspaceFileOwner({ workspaceRoot: root, assertCurrent() {}, ...changes }); owners.push(owner); return owner
}
async function realHandle(path: string, flags: number): Promise<WorkspaceFileHandle> {
  const handle = await open(path, flags)
  return { stat: () => handle.stat({ bigint: true }), read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position), close: () => handle.close() }
}

describe('WorkspaceFileOwner actual captured filesystem', () => {
  it('previews actual worktree bytes without decoding binary files or reading oversized content', async () => {
    const reads = vi.fn(), owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: (...args: Parameters<WorkspaceFileHandle['read']>) => { reads(); return handle.read(...args) } }
    } } })
    await writeFile(file, Buffer.from([65, 0, 66]))
    expect(await owner.readFilePreview('task-one', file, 32, controls())).toEqual({ content: '', size: 3, binary: true, truncated: false })
    expect(await owner.readTextFile('task-one', file, controls())).toEqual({ content: 'A\u0000B', size: 3 })
    reads.mockClear(); await writeFile(file, Buffer.alloc(33, 65))
    expect(await owner.readFilePreview('task-one', file, 32, controls())).toEqual({ content: '', size: 33, binary: false, truncated: true })
    expect(reads).not.toHaveBeenCalled()
    await writeFile(file, 'Bounded preview')
    expect(await owner.readFilePreview('task-one', file, 32, controls())).toEqual({ content: 'Bounded preview', size: 15, binary: false, truncated: false })
    expect(await owner.readFilePreview('task-one', join(workspace, 'missing'), 32, controls())).toBeNull()
    expect(owner.inflightCount).toBe(0)
  })
  it('reads a real bounded prefix of oversized memory while preserving public preview semantics', async () => {
    const bytes = WORKSPACE_FILE_LIMITS.textBytes + 500, calls: number[] = []
    await writeFile(file, Buffer.alloc(bytes, 65))
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: (...args: Parameters<WorkspaceFileHandle['read']>) => { calls.push(args[2]); return handle.read(...args) } }
    } } })
    expect(await owner.readTextFile('task-one', file, controls())).toEqual({ content: '', size: bytes })
    expect(calls).toEqual([])
    expect(await owner.readTextPrefix('task-one', file, 65537, controls())).toEqual({ content: 'A'.repeat(65537), size: bytes, truncated: true })
    expect(calls).toEqual([32768, 32768, 1]); expect(owner.inflightCount).toBe(0)
    await writeFile(file, 'Small memory')
    expect(await owner.readTextPrefix('task-one', file, 65537, controls())).toEqual({ content: 'Small memory', size: 12, truncated: false })
    expect(await owner.readTextPrefix('task-one', join(workspace, 'missing'), 10, controls())).toBeNull()
    for (const capacity of [0, -1, 1.5, WORKSPACE_FILE_LIMITS.textBytes + 1]) await expect(owner.readTextPrefix('task-one', file, capacity, controls())).rejects.toThrow('INVALID_ARGUMENTS')
  })
  it('drops a revoked prefix and keeps its real close receipt through shutdown', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController()
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: async (...args: Parameters<WorkspaceFileHandle['read']>) => { entered.resolve(); await release.promise; return handle.read(...args) } }
    } } })
    const work = owner.readTextPrefix('task-one', file, 10, controls(() => {}, controller)).catch(error => error)
    try {
      await entered.promise; controller.abort()
      await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
      expect(owner.inflightCount).toBeGreaterThan(0); release.resolve()
      expect((await work).code).toBe('WORKSPACE_CANCELLED'); await owner.close()
    } finally { release.resolve(); await work }
  })
  it('creates only a literal authorized task workspace and preserves read/missing/oversized shapes', async () => {
    const beforeEffect = vi.fn(), owner = make(), read = vi.fn()
    owner.assertOwners(root)
    const requested = await owner.getWorkspaceDir('group-member', controls(beforeEffect))
    expect(requested).toBe(join(root, 'group-member')); expect((await lstat(requested)).isDirectory()).toBe(true)
    expect(await owner.readTextFile('task-one', file, controls())).toEqual({ content: 'Actual workspace text 🌱\n', size: Buffer.byteLength('Actual workspace text 🌱\n') })
    expect(await owner.readTextFile('missing-task', join(root, 'missing-task', 'none.txt'), controls())).toBeNull()
    await expect(lstat(join(root, 'missing-task'))).rejects.toMatchObject({ code: 'ENOENT' })
    const oversized = join(workspace, 'large.txt'); await writeFile(oversized, Buffer.alloc(WORKSPACE_FILE_LIMITS.textBytes + 1))
    const bounded = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: (...args: Parameters<WorkspaceFileHandle['read']>) => { read(); return handle.read(...args) } }
    } } })
    expect(await bounded.readTextFile('task-one', oversized, controls())).toEqual({ content: '', size: WORKSPACE_FILE_LIMITS.textBytes + 1 })
    expect(read).not.toHaveBeenCalled(); expect(beforeEffect).toHaveBeenCalled(); expect(owner.inflightCount).toBe(0)
  })
  it('bounds actual text bytes even for maximally escaped JSON content', async () => {
    await writeFile(file, Buffer.alloc(WORKSPACE_FILE_LIMITS.textBytes, 1))
    const result = await make().readTextFile('task-one', file, controls())
    expect(result?.size).toBe(WORKSPACE_FILE_LIMITS.textBytes)
    expect(result?.content.length).toBe(WORKSPACE_FILE_LIMITS.textBytes)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024)
  })
  it('rejects untrusted task IDs, paths and missing native capabilities before effects', async () => {
    const mkdirSpy = vi.fn(async (path: string) => { await mkdir(path) }), openSpy = vi.fn(realHandle)
    const owner = make({ fs: { mkdir: mkdirSpy, open: openSpy } })
    expect(owner.canOpenPath).toBe(false); expect(owner.canShowItemInFolder).toBe(false)
    await expect(owner.getWorkspaceDir('../escape', controls())).rejects.toThrow('INVALID_ARGUMENTS')
    await expect(owner.getWorkspaceDir('x'.repeat(129), controls())).rejects.toThrow('INVALID_ARGUMENTS')
    await expect(owner.readTextFile('task-one', join(root, 'another-task', 'readme.txt'), controls())).rejects.toThrow('PATH_REFUSED')
    await expect(owner.readTextFile('task-one', `${workspace}/../task-one/readme.txt`, controls())).rejects.toThrow('PATH_REFUSED')
    await expect(owner.openPath('task-one', file, controls())).rejects.toThrow('NATIVE_UNAVAILABLE')
    await expect(owner.showItemInFolder('task-one', join(workspace, 'missing'), controls())).rejects.toThrow('NATIVE_UNAVAILABLE')
    expect(mkdirSpy).not.toHaveBeenCalled(); expect(openSpy).not.toHaveBeenCalled()
    expect(() => owner.assertOwners(dirname(root))).toThrow('INVALID_ARGUMENTS')
  })
  it('does not mkdir or open after caller revocation at an awaited boundary', async () => {
    let allowed = true
    const beforeEffect = () => { if (!allowed) throw new Error('FIXTURE_CALLER_REVOKED') }
    const mkdirSpy = vi.fn(async (path: string) => { await mkdir(path) })
    const owner = make({ fs: { mkdir: mkdirSpy, lstat: async path => {
      const value = await lstat(path, { bigint: true }); allowed = false; return value
    } } })
    await expect(owner.getWorkspaceDir('new-task', controls(beforeEffect))).rejects.toThrow('FIXTURE_CALLER_REVOKED')
    expect(mkdirSpy).not.toHaveBeenCalled()
    await expect(lstat(join(root, 'new-task'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects captured root replacement and remembered task identity replacement', async () => {
    const owner = make()
    await owner.getWorkspaceDir('task-one', controls())
    await rename(workspace, join(root, 'old-task')); await mkdir(workspace); await writeFile(file, 'Replacement task')
    await expect(owner.readTextFile('task-one', file, controls())).rejects.toThrow('PATH_CHANGED')
    const rooted = make()
    await rename(root, join(parent, 'old-root')); await mkdir(root); await mkdir(workspace); await writeFile(file, 'Replacement root')
    await expect(rooted.readTextFile('task-one', file, controls())).rejects.toThrow('PATH_CHANGED')
    expect(await readFile(file, 'utf8')).toBe('Replacement root')
  })
  it('rejects a replaced physical ancestor even when the exact root inode is moved back under it', async () => {
    const holder = join(parent, 'holder'), capturedRoot = join(holder, 'workspaces')
    await mkdir(holder); await mkdir(capturedRoot)
    const owner = make({ workspaceRoot: capturedRoot })
    await rename(holder, join(parent, 'old-holder')); await mkdir(holder)
    await rename(join(parent, 'old-holder', 'workspaces'), capturedRoot)
    await expect(owner.getWorkspaceDir('new-task', controls())).rejects.toThrow('PATH_CHANGED')
    await expect(lstat(join(capturedRoot, 'new-task'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rechecks task identity before publishing a missing-file null/no-op', async () => {
    let replaced = false
    const nonexistent = join(workspace, 'missing.txt')
    const owner = make({ fs: { lstat: async path => {
      try { return await lstat(path, { bigint: true }) }
      catch (cause) {
        if (path === nonexistent && !replaced) { replaced = true; await rename(workspace, join(root, 'previous-task')); await mkdir(workspace) }
        throw cause
      }
    } } })
    await expect(owner.readTextFile('task-one', nonexistent, controls())).rejects.toThrow('PATH_CHANGED')
  })
  it.skipIf(process.platform === 'win32')('rejects task/child links and hardlinked files without changing linked data', async () => {
    const owner = make(), outside = join(parent, 'unrelated.txt')
    const linkedRoot = join(parent, 'linked-root'); await symlink(root, linkedRoot, 'dir')
    expect(() => make({ workspaceRoot: linkedRoot })).toThrow('PATH_REFUSED')
    const linked = join(workspace, 'linked.txt'); await symlink(outside, linked)
    await expect(owner.readTextFile('task-one', linked, controls())).rejects.toThrow('PATH_REFUSED')
    const nested = join(workspace, 'nested'); await symlink(parent, nested, 'dir')
    await expect(owner.readTextFile('task-one', join(nested, 'unrelated.txt'), controls())).rejects.toThrow('PATH_REFUSED')
    await symlink(workspace, join(root, 'linked-task'), 'dir')
    await expect(owner.getWorkspaceDir('linked-task', controls())).rejects.toThrow('PATH_REFUSED')
    const hardlinked = join(workspace, 'hardlinked.txt'); await link(outside, hardlinked)
    await expect(owner.readTextFile('task-one', hardlinked, controls())).rejects.toThrow('PATH_REFUSED')
    expect(await readFile(hardlinked, 'utf8')).toBe('Unowned data remains unchanged')
  })
  it('refuses a mismatched real opened FD and closes it without reading its bytes', async () => {
    const read = vi.fn(), close = vi.fn()
    const owner = make({ fs: { open: async (_path, flags) => {
      const handle = await realHandle(join(parent, 'unrelated.txt'), flags)
      return { ...handle, read: (...args: Parameters<WorkspaceFileHandle['read']>) => { read(); return handle.read(...args) }, close: async () => { close(); await handle.close() } }
    } } })
    await expect(owner.readTextFile('task-one', file, controls())).rejects.toThrow('PATH_CHANGED')
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1); expect(owner.inflightCount).toBe(0)
  })
  it('detects file replacement during actual open before returning content', async () => {
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      await rename(file, join(workspace, 'original.txt')); await writeFile(file, 'Replacement leaf')
      return handle
    } } })
    await expect(owner.readTextFile('task-one', file, controls())).rejects.toThrow('PATH_CHANGED')
    expect(await readFile(join(workspace, 'original.txt'), 'utf8')).toBe('Actual workspace text 🌱\n')
    expect(await readFile(file, 'utf8')).toBe('Replacement leaf'); expect(owner.inflightCount).toBe(0)
  })
  it('detects ancestor replacement and same-inode content mutation during a real read', async () => {
    const folder = join(workspace, 'nested'), nested = join(folder, 'text.txt')
    await mkdir(folder); await writeFile(nested, 'Nested original')
    let changed = false
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: async (...args: Parameters<WorkspaceFileHandle['read']>) => {
        const value = await handle.read(...args)
        if (!changed) { changed = true; await rename(folder, join(workspace, 'old-nested')); await mkdir(folder); await writeFile(nested, 'Nested replacement') }
        return value
      } }
    } } })
    await expect(owner.readTextFile('task-one', nested, controls())).rejects.toThrow('PATH_CHANGED')
    changed = false
    const inplace = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: async (...args: Parameters<WorkspaceFileHandle['read']>) => {
        const value = await handle.read(...args)
        if (!changed) { changed = true; await writeFile(file, 'In-place changed contents') }
        return value
      } }
    } } })
    await expect(inplace.readTextFile('task-one', file, controls())).rejects.toThrow('PATH_CHANGED')
  })
  it('retains a late real open after cancellation, then closes its accepted descriptor', async () => {
    const acquired = deferred(), release = deferred(), controller = new AbortController(), closed = vi.fn()
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags); acquired.resolve(); await release.promise
      return { ...handle, close: async () => { await handle.close(); closed() } }
    } } })
    const work = owner.readTextFile('task-one', file, controls(() => {}, controller)).catch(cause => cause)
    try {
      await acquired.promise; controller.abort()
      await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE'); expect(closed).not.toHaveBeenCalled()
      release.resolve(); expect((await work).code).toBe('WORKSPACE_CANCELLED')
      await owner.close(); expect(closed).toHaveBeenCalledTimes(1); expect(owner.inflightCount).toBe(0)
    } finally { release.resolve(); await work }
  })
  it('retains ignored read cancellation and raw close until both actual receipts settle', async () => {
    const reading = deferred(), readReceipt = deferred(), closing = deferred(), closeReceipt = deferred(), controller = new AbortController()
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, read: async (...args: Parameters<WorkspaceFileHandle['read']>) => { const value = await handle.read(...args); reading.resolve(); await readReceipt.promise; return value },
        close: async () => { closing.resolve(); await closeReceipt.promise; await handle.close() } }
    } } })
    const work = owner.readTextFile('task-one', file, controls(() => {}, controller)).catch(cause => cause)
    try {
      await reading.promise; controller.abort()
      await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
      readReceipt.resolve(); await closing.promise
      await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE'); expect(owner.inflightCount).toBeGreaterThan(0)
      closeReceipt.resolve(); expect((await work).code).toBe('WORKSPACE_CANCELLED')
      await owner.close(); expect(owner.inflightCount).toBe(0)
    } finally { readReceipt.resolve(); closeReceipt.resolve(); await work }
  })
  it('keeps a failed close handle owned until an explicit successful retry', async () => {
    let attempts = 0
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, close: async () => { attempts++; if (attempts < 3) throw new Error('opaque fixture close failure'); await handle.close() } }
    } } })
    await expect(owner.readTextFile('task-one', file, controls())).rejects.toThrow('CLOSE_FAILED')
    expect(owner.inflightCount).toBe(1)
    await expect(owner.close()).rejects.toThrow('DRAIN_INCOMPLETE'); expect(owner.inflightCount).toBe(1)
    await owner.close(); expect(attempts).toBe(3); expect(owner.inflightCount).toBe(0)
  })
  it('retains a synchronously failing close primitive for the same-handle retry', async () => {
    let failed = false
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, close: () => { if (!failed) { failed = true; throw new Error('opaque synchronous close failure') }; return handle.close() } }
    } } })
    await expect(owner.readTextFile('task-one', file, controls())).rejects.toThrow('CLOSE_FAILED')
    expect(owner.inflightCount).toBe(1)
    await owner.close(); expect(owner.inflightCount).toBe(0)
  })
  it('rechecks caller after raw close before publishing text', async () => {
    let allowed = true
    const owner = make({ fs: { open: async (path, flags) => {
      const handle = await realHandle(path, flags)
      return { ...handle, close: async () => { await handle.close(); allowed = false } }
    } } })
    await expect(owner.readTextFile('task-one', file, controls(() => { if (!allowed) throw new Error('FIXTURE_CALLER_REVOKED') }))).rejects.toThrow('FIXTURE_CALLER_REVOKED')
    expect(owner.inflightCount).toBe(0)
  })
  it('retains native callback completion and emits exact decimal FD/ancestor receipts', async () => {
    const entered = deferred(), release = deferred(), controller = new AbortController(), receipts: unknown[] = []
    const folder = join(workspace, 'nested'); await mkdir(folder); const target = join(folder, 'document.txt'); await writeFile(target, 'Receipt target')
    const openPath = vi.fn(async (_path: string, receipt: WorkspacePathReceipt) => { receipts.push(receipt); entered.resolve(); await release.promise })
    const reveal = vi.fn(async () => {})
    const owner = make({ native: { openPath, showItemInFolder: reveal } })
    const work = owner.openPath('task-one', target, controls(() => {}, controller)).catch(cause => cause)
    try {
      await entered.promise
      expect(isWorkspacePathReceipt(receipts[0])).toBe(true)
      expect(receipts[0]).toMatchObject({ version: 1, taskId: 'task-one', workspaceRoot: root, path: target,
        root: { path: root, kind: 'directory' }, ancestors: [{ path: workspace }, { path: folder }], target: { path: target, kind: 'file', size: '14', nlink: '1' } })
      const stats = await lstat(target, { bigint: true })
      expect((receipts[0] as { target: { dev: string; ino: string } }).target).toMatchObject({ dev: stats.dev.toString(), ino: stats.ino.toString() })
      controller.abort(); await expect(owner.close(10)).rejects.toThrow('DRAIN_INCOMPLETE')
      expect(owner.inflightCount).toBeGreaterThan(0); release.resolve(); expect((await work).code).toBe('WORKSPACE_CANCELLED')
      await owner.close(); expect(openPath).toHaveBeenCalledTimes(1); expect(reveal).not.toHaveBeenCalled()
    } finally { release.resolve(); await work }
  })
  it('preserves native missing no-op, directory target receipts, and refuses shutdown admission', async () => {
    const openPath = vi.fn(async (_path: string, _receipt: WorkspacePathReceipt) => {}), reveal = vi.fn(async (_path: string, _receipt: WorkspacePathReceipt) => {})
    const owner = make({ native: { openPath, showItemInFolder: reveal } })
    expect(owner.canOpenPath).toBe(true); expect(owner.canShowItemInFolder).toBe(true)
    await owner.openPath('task-one', join(workspace, 'missing'), controls()); expect(openPath).not.toHaveBeenCalled()
    await owner.showItemInFolder('task-one', file, controls()); expect(reveal).toHaveBeenCalledTimes(1)
    if (process.platform !== 'win32') {
      await owner.openPath('task-one', workspace, controls())
      expect(openPath).toHaveBeenCalledWith(workspace, expect.objectContaining({ ancestors: [], target: expect.objectContaining({ path: workspace, kind: 'directory' }) }))
    }
    owner.shutdown()
    await expect(owner.getWorkspaceDir('next-task', controls())).rejects.toThrow('CLOSED')
    await expect(lstat(join(root, 'next-task'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})


describe('WorkspaceFileOwner metadata-only captured regular file callback', () => {
  it('captures a large exact file without reading bytes and returns null for missing sources', async () => {
    await writeFile(file, Buffer.alloc(600 * 1024, 65))
    const reads = vi.fn(), invoked = vi.fn(async (receipt: WorkspacePathReceipt) => { expect(isWorkspacePathReceipt(receipt)).toBe(true); expect(receipt.target).toMatchObject({ kind: 'file', size: String(600 * 1024), nlink: '1' }); return 'file' })
    const owner = make({ fs: { open: async (path, flags) => { const handle = await realHandle(path, flags); return { ...handle, read: (...args) => { reads(); return handle.read(...args) } } } } })
    expect(await owner.withCapturedFile('task-one', file, controls(), invoked)).toBe('file')
    expect(await owner.withCapturedFile('task-one', join(workspace, 'missing'), controls(), invoked)).toBeNull()
    expect(invoked).toHaveBeenCalledTimes(1); expect(reads).not.toHaveBeenCalled(); expect(owner.inflightCount).toBe(0)
  })
  it.skipIf(process.platform === 'win32')('refuses links/directories and size above the fixed callback budget before invoking native', async () => {
    const owner = make(), invoked = vi.fn(async () => 'file'), outside = join(parent, 'unrelated.txt')
    await symlink(outside, join(workspace, 'linked.txt')); await link(file, join(workspace, 'hardlink.txt'))
    for (const path of [workspace, file, join(workspace, 'linked.txt'), join(workspace, 'hardlink.txt')]) await expect(owner.withCapturedFile('task-one', path, controls(), invoked)).rejects.toThrow('PATH_REFUSED')
    await rm(join(workspace, 'hardlink.txt')); const handle = await open(file, 'r+'); try { await handle.truncate(WORKSPACE_FILE_LIMITS.capturedFileBytes + 1) } finally { await handle.close() }
    await expect(owner.withCapturedFile('task-one', file, controls(), invoked)).rejects.toThrow('PATH_REFUSED')
    expect(invoked).not.toHaveBeenCalled(); expect(owner.inflightCount).toBe(0)
  })
  it('retains the real source FD through ignored native cancellation and bounded close until actual acknowledgement', async () => {
    const entered = deferred(), callback = deferred(), owner = make(), controller = new AbortController()
    const invoked = vi.fn(async () => { entered.resolve(); await callback.promise; return 'file' })
    const pending = owner.withCapturedFile('task-one', file, controls(() => {}, controller), invoked), outcome = pending.catch(error => error)
    try {
      await entered.promise; controller.abort()
      await expect(owner.close(5)).rejects.toThrow('DRAIN_INCOMPLETE'); expect(owner.inflightCount).toBeGreaterThan(0)
    } finally { callback.resolve() }
    expect(await outcome).toMatchObject({ code: 'WORKSPACE_CANCELLED' }); await owner.close(); expect(owner.inflightCount).toBe(0); expect(invoked).toHaveBeenCalledTimes(1)
  })
  it.skipIf(process.platform === 'win32')('detects a named replacement after native acknowledgement without deleting either file or replaying', async () => {
    const owner = make(), original = join(workspace, 'retained-original'), invoked = vi.fn(async () => { await rename(file, original); await writeFile(file, 'Replacement user bytes'); return 'file' })
    await expect(owner.withCapturedFile('task-one', file, controls(), invoked)).rejects.toThrow('PATH_CHANGED')
    expect(await readFile(original, 'utf8')).toBe('Actual workspace text 🌱\n'); expect(await readFile(file, 'utf8')).toBe('Replacement user bytes'); expect(invoked).toHaveBeenCalledTimes(1); expect(owner.inflightCount).toBe(0)
  })
  it('registers late opens before revoked guards and preserves failed close receipts for explicit retry', async () => {
    const entered = deferred(), gate = deferred(); let allowed = true, failClose = true
    const owner = make({ fs: { open: async (path, flags) => { const handle = await realHandle(path, flags); entered.resolve(); await gate.promise; return { ...handle, close: async () => { if (failClose) throw new Error('Controlled close failure'); await handle.close() } } } } })
    const callback = vi.fn(async () => 'file'), pending = owner.withCapturedFile('task-one', file, controls(() => { if (!allowed) throw new Error('Revoked caller') }), callback), outcome = pending.catch(error => error)
    try {
      await entered.promise; allowed = false; gate.resolve()
      expect(await outcome).toMatchObject({ code: 'WORKSPACE_CLOSE_FAILED' }); expect(callback).not.toHaveBeenCalled(); expect(owner.inflightCount).toBeGreaterThan(0)
      allowed = true; await expect(owner.readTextFile('task-one', file, controls())).rejects.toThrow('BUSY')
      await expect(owner.close()).rejects.toThrow('DRAIN_INCOMPLETE'); expect(owner.inflightCount).toBeGreaterThan(0)
    } finally { gate.resolve(); allowed = true; failClose = false; await owner.close() }
    expect(owner.inflightCount).toBe(0)
  })
})

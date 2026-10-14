import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HeartbeatFileOwner, HEARTBEAT_FILE_MAX_BYTES, type HeartbeatFilePrimitives } from './heartbeat-file-owner'

describe('captured heartbeat file ownership (actual filesystem)', () => {
  let root: string, workspace: string, owners: HeartbeatFileOwner[]
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), '21x-heartbeat-fs-')); workspace = join(root, 'workspaces'); mkdirSync(workspace); owners = [] })
  afterEach(async () => { for (const owner of owners) await owner.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
  function owner(fs?: Partial<HeartbeatFilePrimitives>, assertCurrent = () => {}) { const result = new HeartbeatFileOwner({ workspaceRoot: workspace, assertCurrent, fs }); owners.push(result); return result }
  function file(body = 'Check the submitted change', id = 'literal_task') { mkdirSync(join(workspace, id), { recursive: true }); const path = join(workspace, id, 'heartbeat.md'); writeFileSync(path, body); return path }
  function receipt(id = 'literal_task') { const stat = lstatSync(join(workspace, id), { bigint: true }); return { dev: stat.dev.toString(), ino: stat.ino.toString() } }

  it('writes only the literal fixed file, preserves UTF8/BOM and closes every real handle', async () => {
    const io = owner(); expect(io.readFile('literal_task')).toBeNull(); expect(io.hasFile('literal_task')).toBe(false)
    const body = '\uFEFF# Checks\nCheck the 🚀 launch\n'
    io.writeFile('literal_task', body); expect(io.readFile('literal_task')).toBe(body)
    io.writeFile('literal_task', 'Updated instructions'); expect(readFileSync(join(workspace, 'literal_task', 'heartbeat.md'), 'utf8')).toBe('Updated instructions')
    expect(readdirSync(join(workspace, 'literal_task'))).toEqual(['heartbeat.md']); expect(io.inflightCount).toBe(0)
    expect(() => io.assertOwners(root)).toThrow('HEARTBEAT_FILE_INVALID')
    for (const id of ['../foreign', 'bad/id', '', 'x'.repeat(129)]) expect(() => io.writeFile(id, 'bad')).toThrow('HEARTBEAT_FILE_INVALID')
  })
  it('bounds stat before open/read and refuses oversized writes without altering bytes', () => {
    const path = file('x'.repeat(HEARTBEAT_FILE_MAX_BYTES + 1)), open = vi.fn(openSync), io = owner({ open })
    expect(() => io.readFile('literal_task')).toThrow('HEARTBEAT_FILE_LIMIT'); expect(open).not.toHaveBeenCalled()
    expect(() => io.writeFile('literal_task', 'new')).toThrow('HEARTBEAT_FILE_LIMIT')
    expect(readFileSync(path).byteLength).toBe(HEARTBEAT_FILE_MAX_BYTES + 1)
    expect(() => io.writeFile('new_task', 'é'.repeat(HEARTBEAT_FILE_MAX_BYTES))).toThrow('HEARTBEAT_FILE_LIMIT')
    expect(readdirSync(workspace)).toEqual(['literal_task'])
  })
  it('refuses final symlinks and hardlinks without disclosing or modifying unrelated bytes', () => {
    const unrelated = join(root, 'private'); writeFileSync(unrelated, 'unowned secret')
    mkdirSync(join(workspace, 'literal_task')); symlinkSync(unrelated, join(workspace, 'literal_task', 'heartbeat.md'))
    const io = owner(); expect(() => io.readFile('literal_task')).toThrow('HEARTBEAT_FILE_UNSAFE'); expect(() => io.writeFile('literal_task', 'overwrite')).toThrow('HEARTBEAT_FILE_UNSAFE')
    rmSync(join(workspace, 'literal_task', 'heartbeat.md')); linkSync(unrelated, join(workspace, 'literal_task', 'heartbeat.md'))
    expect(() => io.readFile('literal_task')).toThrow('HEARTBEAT_FILE_UNSAFE'); expect(readFileSync(unrelated, 'utf8')).toBe('unowned secret')
  })
  it('rejects linked task directories and physical root/task replacement', async () => {
    const foreign = join(root, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'heartbeat.md'), 'private')
    symlinkSync(foreign, join(workspace, 'linked_task')); const io = owner()
    expect(() => io.readFile('linked_task')).toThrow('HEARTBEAT_FILE_UNSAFE')
    file(); expect(io.readFile('literal_task')).toContain('submitted')
    renameSync(join(workspace, 'literal_task'), join(root, 'saved-task')); file('replacement')
    expect(() => io.readFile('literal_task')).toThrow('HEARTBEAT_FILE_CHANGED')
    renameSync(workspace, join(root, 'saved-root')); mkdirSync(workspace)
    expect(() => io.writeFile('another_task', 'new')).toThrow('HEARTBEAT_FILE_CHANGED')
    await io.close()
  })
  it('compares opened FD identity against path and closes a raced replacement', () => {
    const path = file('original'), replacement = join(root, 'replacement'); writeFileSync(replacement, 'private replacement')
    const close = vi.fn(closeSync), io = owner({ open(path, flags, mode) { renameSync(replacement, path); return openSync(path, flags, mode) }, close })
    expect(() => io.readFile('literal_task')).toThrow('HEARTBEAT_FILE_CHANGED'); expect(close).toHaveBeenCalledOnce(); expect(io.inflightCount).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('private replacement')
  })
  it('rechecks revoked caller after raw read but still closes the accepted real FD', () => {
    file(); let allowed = true
    const close = vi.fn(closeSync), io = owner({ read(...args) { const value = readSync(...args); allowed = false; return value }, close })
    expect(() => io.readFile('literal_task', () => { if (!allowed) throw new Error('CALLER_REVOKED') })).toThrow('CALLER_REVOKED')
    expect(close).toHaveBeenCalledOnce(); expect(io.inflightCount).toBe(0)
  })
  it('retains failed actual FD close and refuses publication until explicit close retry', async () => {
    const path = file('keep original'); let refuse = true
    const close = vi.fn((fd: number) => { if (refuse) throw new Error('private IO diagnostic'); closeSync(fd) })
    const io = owner({ close })
    expect(() => io.writeFile('literal_task', 'pending replacement')).toThrow('HEARTBEAT_FILE_CLOSE_PENDING')
    expect(readFileSync(path, 'utf8')).toBe('keep original'); expect(io.inflightCount).toBe(2)
    await expect(io.close()).rejects.toThrow('HEARTBEAT_FILE_CLOSE_PENDING'); expect(io.inflightCount).toBe(2)
    refuse = false; await io.close(); expect(io.inflightCount).toBe(0); expect(readdirSync(join(workspace, 'literal_task'))).toEqual(['heartbeat.md'])
  })
  it('keeps exact raw FD ownership when fstat fails after open', () => {
    file(); const close = vi.fn(closeSync), io = owner({ fstat() { throw new Error('private stat failure') }, close })
    expect(() => io.readFile('literal_task')).toThrow('HEARTBEAT_FILE_IO'); expect(close).toHaveBeenCalledOnce(); expect(io.inflightCount).toBe(0)
  })
  it('closes a just-created FD when its first identity receipt fails and preserves the unproven scratch', () => {
    const path = file('original'), close = vi.fn(closeSync), io = owner({ fstat() { throw new Error('private first-stat failure') }, close })
    expect(() => io.writeFile('literal_task', 'new')).toThrow('HEARTBEAT_FILE_IO'); expect(close).toHaveBeenCalledOnce(); expect(io.inflightCount).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('original')
    const scratch = readdirSync(join(workspace, 'literal_task')).find(name => name.endsWith('.tmp'))!
    expect(scratch).toBeTruthy(); expect(readFileSync(join(workspace, 'literal_task', scratch))).toHaveLength(0)
  })
  it('preserves concurrent edits to original before publication', () => {
    const path = file('initial'), io = owner({ fsync(fd) { writeFileSync(path, 'user concurrent edit'); const actual = fstatSync(fd); expect(actual.isFile()).toBe(true) } })
    expect(() => io.writeFile('literal_task', 'new instructions')).toThrow('HEARTBEAT_FILE_CHANGED')
    expect(readFileSync(path, 'utf8')).toBe('user concurrent edit'); expect(readdirSync(join(workspace, 'literal_task'))).toEqual(['heartbeat.md'])
  })
  it('preserves tampered private temp and transfers only exact workspace receipt to cleanup', async () => {
    const path = file('original'); let tempPath = ''
    const io = owner({ open(path, flags, mode) { if (path.endsWith('.tmp')) tempPath = path; return openSync(path, flags, mode) }, read(...args) { if (tempPath) writeFileSync(tempPath, 'user changed temp'); return readSync(...args) } })
    expect(() => io.writeFile('literal_task', 'new')).toThrow('HEARTBEAT_FILE_CHANGED'); expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readFileSync(tempPath, 'utf8')).toBe('user changed temp')
    await expect(io.close()).rejects.toThrow('HEARTBEAT_FILE_CHANGED')
    expect(() => io.retireWorkspace('literal_task', { dev: '0', ino: '0' })).toThrow('HEARTBEAT_FILE_CHANGED')
    io.retireWorkspace('literal_task', receipt()); await io.close()
    expect(readFileSync(tempPath, 'utf8')).toBe('user changed temp')
  })
  it('does not create a task directory after guard withdrawal and refuses late closed work', async () => {
    const io = owner(), beforeEffect = (): void => { throw new Error('NO_WRITE_GRANT') }
    expect(() => io.writeFile('new_task', 'text', beforeEffect)).toThrow('NO_WRITE_GRANT'); expect(readdirSync(workspace)).toEqual([])
    await io.close(); expect(() => io.readFile('new_task')).toThrow('HEARTBEAT_FILE_CLOSED')
  })
})

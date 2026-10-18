import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import { TaskAttachmentFileOwner, type TaskAttachmentFileOwnerOptions } from './task-attachment-file-owner'
import { AttachmentExecutionOwner, type AttachmentExecutionOwnerOptions } from './attachment-execution-owner'
import type { FileAttachmentRecord } from './database/types'

const fixtures: Array<{ root: string; db: ReturnType<typeof createPortableTestDb>; files: TaskAttachmentFileOwner; execution: AttachmentExecutionOwner }> = []
const releases: Array<() => void> = []
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); releases.push(release); return { promise, release } }
function arrived() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const f of fixtures.splice(0)) { await f.execution.close(); await f.files.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }) }
})
async function fixture(options: { sourceFs?: TaskAttachmentFileOwnerOptions['fs']; executionFs?: AttachmentExecutionOwnerOptions['fs']; bytes?: Buffer } = {}) {
  const db = createPortableTestDb(), root = dirname(dirname(db.getWorkspaceDir('fixture'))), attachmentRoot = join(root, 'attachments'), workspaceRoot = join(root, 'workspaces')
  mkdirSync(attachmentRoot)
  const assertCurrent = (): void => { if (!db.db.open) throw new Error('Closed fixture') }
  const files = new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent, fs: options.sourceFs })
  const execution = new AttachmentExecutionOwner({ database: db, files, attachmentRoot, workspaceRoot, assertCurrent, fs: options.executionFs })
  fixtures.push({ root, db, files, execution })
  const task = db.createTask({ title: 'Actual bounded protected execution' })!, workspace = db.getWorkspaceDir(task.id), bytes = options.bytes ?? Buffer.from('saved file bytes')
  const record: FileAttachmentRecord = { id: randomUUID(), filename: 'saved.txt', size: bytes.length, mime_type: 'text/plain', added_at: '2026-10-18T00:00:00.000Z' }
  const receipt = await files.write(task.id, record, bytes, { beforeEffect() {}, signal: new AbortController().signal })
  db.updateTask(task.id, { attachments: [record] }); files.commit(receipt)
  return { root, db, files, execution, task, workspace, bytes, record, saved: join(attachmentRoot, task.id, `${record.id}-${record.filename}`) }
}
function heldSource(readGate: ReturnType<typeof held>, opening: ReturnType<typeof arrived>): TaskAttachmentFileOwnerOptions['fs'] {
  return { open: async (path, flags, mode) => {
    const fd = await open(path, flags, mode)
    return { stat: () => fd.stat({ bigint: true }), write: (buffer, offset, length, position) => fd.write(buffer, offset, length, position), sync: () => fd.sync(), close: () => fd.close(),
      read: async (buffer, offset, length, position) => {
        const result = await fd.read(buffer, offset, length, position)
        if (!path.endsWith('.tmp')) { opening.release(); await readGate.promise }
        return result
      } }
  } }
}

describe.runIf(process.platform === 'linux')('private held-FD attachment execution owner (Linux directory-FD authority)', () => {
  it('copies exact saved bytes, replaces only a hostile destination entry, and previews protected bytes', async () => {
    const f = await fixture(), outside = join(f.root, 'outside.txt')
    writeFileSync(outside, 'outside untouched'); mkdirSync(join(f.workspace, 'attachments'))
    symlinkSync(outside, join(f.workspace, 'attachments', f.record.filename))
    expect(await f.execution.sync(f.task.id, f.workspace, () => {})).toEqual([`- attachments/${f.record.filename}`])
    expect(readFileSync(outside, 'utf8')).toBe('outside untouched')
    expect(readFileSync(join(f.workspace, 'attachments', f.record.filename))).toEqual(f.bytes)
    writeFileSync(join(f.workspace, 'attachments', f.record.filename), 'mutable workspace canary')
    const prompt = await f.execution.context(f.task.id, f.workspace, 'Use the file', [f.record], () => {})
    expect(prompt).toContain(f.bytes.toString()); expect(prompt).not.toContain('mutable workspace canary')
    expect(f.execution.inflightCount).toBe(0)
  })
  it('fences actual held source reads on withdrawal and joins cleanup before close', async () => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) })
    let allowed = true
    const result = f.execution.sync(f.task.id, f.workspace, () => { if (!allowed) throw new Error('Withdrawn request') })
    const rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await opened.promise; allowed = false
    await expect(f.execution.close(20)).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE' })
    expect(f.db.db.open).toBe(true); expect(f.files.inflightCount).toBeGreaterThan(0)
    gate.release(); await rejected; await f.execution.close()
    expect(f.execution.inflightCount).toBe(0); expect(readdirSync(join(f.workspace, 'attachments'))).toEqual([])
    expect(readFileSync(f.saved)).toEqual(f.bytes)
  })
  it('does not retarget a held copy after its workspace directory is replaced with a symlink', async () => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) })
    const result = f.execution.sync(f.task.id, f.workspace, () => {}), rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await opened.promise
    const original = join(f.workspace, 'attachments'), retired = join(f.workspace, 'retired-attachments'), outside = join(f.root, 'foreign-dir')
    mkdirSync(outside); writeFileSync(join(outside, f.record.filename), 'foreign file')
    renameSync(original, retired); symlinkSync(outside, original)
    gate.release(); await rejected
    expect(readFileSync(join(outside, f.record.filename), 'utf8')).toBe('foreign file')
    expect(readdirSync(retired)).toEqual([]); expect(f.execution.inflightCount).toBe(0)
  })
  it.each(['metadata', 'project', 'agent', 'parent'] as const)('refuses a changed %s binding after an actual source FD read', async field => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) })
    const result = f.execution.sync(f.task.id, f.workspace, () => {}), rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await opened.promise
    if (field === 'metadata') f.db.updateTask(f.task.id, { attachments: [] })
    if (field === 'project') f.db.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(f.db.createProject({ name: 'Replacement project' })!.id, f.task.id)
    if (field === 'agent') f.db.updateTask(f.task.id, { agent_id: f.db.createAgent({ name: 'Replacement owner' })!.id })
    if (field === 'parent') f.db.updateTask(f.task.id, { parent_task_id: f.db.createTask({ title: 'Replacement parent' })!.id })
    gate.release(); await rejected
    expect(readdirSync(join(f.workspace, 'attachments'))).toEqual([]); expect(f.execution.inflightCount).toBe(0)
  })
  it('owns an admitted rename through cancellation without undoing accepted copied bytes', async () => {
    const gate = held(), renaming = arrived()
    const f = await fixture({ executionFs: { rename: async (from, to) => { renaming.release(); await gate.promise; await rename(from, to) } } })
    let allowed = true
    const result = f.execution.sync(f.task.id, f.workspace, () => { if (!allowed) throw new Error('Withdrawn request') }), rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await renaming.promise; allowed = false
    await expect(f.execution.close(20)).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE' })
    gate.release(); await rejected; await f.execution.close()
    expect(readFileSync(join(f.workspace, 'attachments', f.record.filename))).toEqual(f.bytes)
    expect(readdirSync(join(f.workspace, 'attachments'))).toEqual([f.record.filename])
  })
  it('bounds previews by actual verified saved size and refuses forged message records', async () => {
    const f = await fixture({ bytes: Buffer.alloc(24577, 97) })
    expect(await f.execution.context(f.task.id, f.workspace, 'Use the file', [f.record], () => {})).not.toContain('Small text previews')
    await expect(f.execution.context(f.task.id, f.workspace, 'Use the file', [{ ...f.record, size: 1 }], () => {})).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    expect(existsSync(join(f.workspace, 'attachments'))).toBe(false)
  })
  it('keeps current group-member files in separate exact-ID namespaces', async () => {
    const f = await fixture(), agent = f.db.createAgent({ name: 'Group execution owner' })!
    const sibling = f.db.createTask({ title: 'Second group member' })!, bytes = Buffer.from('second member')
    const record = { ...f.record, id: randomUUID(), size: bytes.length }
    const receipt = await f.files.write(sibling.id, record, bytes, { beforeEffect() {}, signal: new AbortController().signal })
    f.db.updateTask(sibling.id, { attachments: [record] }); f.files.commit(receipt)
    const group = f.db.createTaskGroup({ title: 'Protected group files', task_ids: [f.task.id, sibling.id], agent_id: agent.id }), workspace = f.db.getWorkspaceDir(group.execution_task_id)
    const refs = await f.execution.sync(group.execution_task_id, workspace, () => {})
    expect(refs).toHaveLength(2)
    for (const [taskId, attachment, expected] of [[f.task.id, f.record, f.bytes], [sibling.id, record, bytes]] as const) {
      const relative = `attachments/task-${taskId}/${attachment.id}-${attachment.filename}`
      expect(refs).toContain(`- Task ${taskId}: ${relative}`); expect(readFileSync(join(workspace, relative))).toEqual(expected)
    }
  })
  it('fences group membership withdrawal during a held real member read', async () => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) }), agent = f.db.createAgent({ name: 'Group owner' })!
    const sibling = f.db.createTask({ title: 'Other member' })!
    const group = f.db.createTaskGroup({ title: 'Captured group', task_ids: [f.task.id, sibling.id], agent_id: agent.id }), workspace = f.db.getWorkspaceDir(group.execution_task_id)
    const result = f.execution.sync(group.execution_task_id, workspace, () => {}), rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await opened.promise; f.db.removeTaskFromGroup(group.id, f.task.id); gate.release(); await rejected
    expect(readFileSync(f.saved)).toEqual(f.bytes)
    expect(readdirSync(join(workspace, 'attachments'), { recursive: true }).every(name => !String(name).endsWith('.txt') && !String(name).endsWith('.tmp'))).toBe(true)
  })
  it('bounds its owned queue and rechecks a retired queued scope before another copy', async () => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) })
    const first = f.execution.sync(f.task.id, f.workspace, () => {}); await opened.promise
    let allowed = true
    const second = f.execution.sync(f.task.id, f.workspace, () => { if (!allowed) throw new Error('Retired queued scope') })
    const rejected = expect(second).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    const third = f.execution.sync(f.task.id, f.workspace, () => {}), fourth = f.execution.sync(f.task.id, f.workspace, () => {})
    await expect(f.execution.sync(f.task.id, f.workspace, () => {})).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_BUSY' })
    allowed = false; gate.release(); await first; await rejected; await third; await fourth
    expect(readFileSync(join(f.workspace, 'attachments', f.record.filename))).toEqual(f.bytes); expect(f.execution.inflightCount).toBe(0)
  })
  it('rejects oversized stored metadata and bytes before destination filesystem admission', async () => {
    const f = await fixture()
    f.db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(JSON.stringify([{ ...f.record, size: 67108865 }]), f.task.id)
    await expect(f.execution.sync(f.task.id, f.workspace, () => {})).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    f.db.db.prepare('UPDATE tasks SET attachments=? WHERE id=?').run(' '.repeat(131073), f.task.id)
    await expect(f.execution.sync(f.task.id, f.workspace, () => {})).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    expect(existsSync(join(f.workspace, 'attachments'))).toBe(false)
  })
  it('does not refresh a queued read intent from replacement attachment metadata', async () => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) })
    const first = f.execution.sync(f.task.id, f.workspace, () => {}), rejectedFirst = expect(first).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await opened.promise
    const queued = f.execution.context(f.task.id, f.workspace, 'Original file intent', [f.record], () => {}), rejectedQueued = expect(queued).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    f.db.updateTask(f.task.id, { attachments: [] }); gate.release()
    await rejectedFirst; await rejectedQueued
    expect(readdirSync(join(f.workspace, 'attachments'))).toEqual([]); expect(f.execution.inflightCount).toBe(0)
  })
  it('retires an actually opened late directory FD before acknowledging a withdrawn request', async () => {
    const gate = held(), opened = arrived()
    const f = await fixture({ executionFs: { open: async (...args: Parameters<typeof open>) => { const handle = await open(...args); opened.release(); await gate.promise; return handle } } })
    let allowed = true
    const result = f.execution.sync(f.task.id, f.workspace, () => { if (!allowed) throw new Error('Withdrawn directory intent') }), rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_REFUSED' })
    await opened.promise; allowed = false; gate.release(); await rejected
    expect(f.execution.inflightCount).toBe(0); expect(existsSync(join(f.workspace, 'attachments'))).toBe(false)
  })
  it('retains failed temporary cleanup and held destination FDs until explicit successful retirement', async () => {
    const gate = held(), opened = arrived(); let cleanupAllowed = false
    const f = await fixture({ sourceFs: heldSource(gate, opened), executionFs: { unlink: async path => { if (!cleanupAllowed) throw new Error('Cleanup temporarily refused'); await unlink(path) } } })
    let allowed = true
    const result = f.execution.sync(f.task.id, f.workspace, () => { if (!allowed) throw new Error('Withdrawn copy intent') }), rejected = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE' })
    await opened.promise; allowed = false; gate.release(); await rejected
    expect(f.execution.inflightCount).toBeGreaterThan(0)
    await expect(f.execution.close()).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_DRAIN_INCOMPLETE' })
    expect(f.db.db.open).toBe(true); cleanupAllowed = true; await f.execution.close()
    expect(f.execution.inflightCount).toBe(0); expect(readdirSync(join(f.workspace, 'attachments'))).toEqual([])
    expect(readFileSync(f.saved)).toEqual(f.bytes)
  })
  it('refuses saved execution on an unsupported platform without creating workspace files', async () => {
    const f = await fixture(), platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    try { await expect(f.execution.sync(f.task.id, f.workspace, () => {})).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_UNAVAILABLE' }) }
    finally { Object.defineProperty(process, 'platform', platform) }
    expect(existsSync(join(f.workspace, 'attachments'))).toBe(false)
  })
  it('joins a consumer-ignored raw saved read and withholds its late bytes after consumer retirement', async () => {
    const gate = held(), opened = arrived(), f = await fixture({ sourceFs: heldSource(gate, opened) })
    let late: Promise<Buffer> | undefined, settled = false
    const pending = f.files.readForExecution(f.task.id, f.record, { beforeEffect() {}, signal: new AbortController().signal }, async read => {
      late = read(0, f.record.size); void late.catch(() => {})
      await opened.promise
    })
    void pending.then(() => { settled = true }, () => { settled = true })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' })
    await opened.promise; await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false); expect(f.files.inflightCount).toBeGreaterThan(0)
    gate.release(); await rejected; await expect(late).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' })
    expect(f.files.inflightCount).toBe(0)
  })
})
if (process.platform !== 'linux') it('refuses saved execution on this native unsupported platform before destination effects', async () => {
  const f = await fixture()
  await expect(f.execution.sync(f.task.id, f.workspace, () => {})).rejects.toMatchObject({ code: 'ATTACHMENT_EXECUTION_UNAVAILABLE' })
  expect(existsSync(join(f.workspace, 'attachments'))).toBe(false)
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskAttachmentFileOwner, type TaskAttachmentFileHandle, type TaskAttachmentFilePrimitives } from './task-attachment-file-owner'

const metadata = { id: '61f07006-c85b-438e-83a7-497c77b0dcae', filename: '写真.png', size: 12, mime_type: 'image/png', added_at: '2026-10-14T00:00:00.000Z' }
const bytes = Buffer.from('iVBORw0KGgoAAQID', 'base64')
let root: string, attachmentRoot: string, owner: TaskAttachmentFileOwner, valid: boolean, releases: Array<() => void>
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function controls(signal = new AbortController().signal) { return { signal, beforeEffect() {} } }
function create(fs?: Partial<TaskAttachmentFilePrimitives>) { return new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent() { if (!valid) throw new Error('Protected owner changed') }, fs }) }
async function actualHandle(path: string, flags: number, mode?: number): Promise<TaskAttachmentFileHandle> { const fd = await open(path, flags, mode); return { stat: () => fd.stat({ bigint: true }), write: (b,o,l,p) => fd.write(b,o,l,p), read: (b,o,l,p) => fd.read(b,o,l,p), sync: () => fd.sync(), close: () => fd.close() } }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), '21x-attachment-owner-')); attachmentRoot = join(root, 'attachments'); await mkdir(attachmentRoot); valid = true; releases = []; owner = create() })
afterEach(async () => { for (const release of releases) release(); valid = true; await owner.close(); await rm(root, { recursive: true, force: true }) })
describe('actual attachment-root publication and raw lifetime', () => {
  it('publishes verified real bytes only after fsync/close and keeps committed data through owner close', async () => {
    let closed = false, synced = false
    owner = create({ open: async (path, flags, mode) => { const fd = await actualHandle(path, flags, mode); return { ...fd, sync: async () => { await fd.sync(); synced = true }, close: async () => { await fd.close(); closed = true } } }, link: async (from, to) => { expect(synced).toBe(true); expect(closed).toBe(true); await link(from, to) } })
    const receipt = await owner.write('task-1', metadata, bytes, controls()); owner.commit(receipt)
    const path = join(attachmentRoot, 'task-1', `${metadata.id}-${metadata.filename}`)
    expect(await readFile(path)).toEqual(bytes); expect(await readdir(join(attachmentRoot, 'task-1'))).toEqual([`${metadata.id}-${metadata.filename}`]); await owner.close(); expect(await readFile(path)).toEqual(bytes)
  })
  it('never replaces an existing selected filename and rolls back only its owned temporary bytes', async () => {
    await mkdir(join(attachmentRoot, 'task-1')); const path = join(attachmentRoot, 'task-1', `${metadata.id}-${metadata.filename}`); await writeFile(path, 'personal bytes')
    await expect(owner.write('task-1', metadata, bytes, controls())).rejects.toMatchObject({ code: 'ATTACHMENT_IO_FAILED' })
    expect(await readFile(path, 'utf8')).toBe('personal bytes'); expect(await readdir(join(attachmentRoot, 'task-1'))).toEqual([`${metadata.id}-${metadata.filename}`])
  })
  it('retains raw ignored-cancellation writes and cleans only their verified acknowledged prefix after closure', async () => {
    const gate = held(), entered = held(); releases.push(gate.release)
    owner = create({ open: async (path, flags, mode) => { const fd = await actualHandle(path, flags, mode); return { ...fd, write: async (b,o,l,p) => { entered.release(); await gate.promise; return fd.write(b,o,l,p) } } } })
    const controller = new AbortController(), pending = owner.write('task-1', metadata, bytes, controls(controller.signal)), failure = pending.catch(error => error); await entered.promise; controller.abort()
    await expect(owner.close(5)).rejects.toMatchObject({ code: 'ATTACHMENT_DRAIN_INCOMPLETE' }); expect(owner.inflightCount).toBeGreaterThan(0)
    gate.release(); expect((await failure).code).toMatch(/ATTACHMENT_(CLOSED|CANCELLED)/); await owner.close(); expect(await readdir(join(attachmentRoot, 'task-1'))).toEqual([])
  })
  it('retains actual failed close handles and cleanup through an explicit retry', async () => {
    let rejectClose = true
    owner = create({ open: async (path, flags, mode) => { const fd = await actualHandle(path, flags, mode); return { ...fd, close: async () => { if (rejectClose) throw new Error('Controlled native close refusal'); await fd.close() } } } })
    await expect(owner.write('task-1', metadata, bytes, controls())).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSE_FAILED' }); expect(owner.inflightCount).toBeGreaterThan(0)
    await expect(owner.close()).rejects.toMatchObject({ code: 'ATTACHMENT_CLOSE_FAILED' }); rejectClose = false; await owner.close(); expect(await readdir(join(attachmentRoot, 'task-1'))).toEqual([])
  })
  it('preserves altered new files and keeps their exact retirement receipt until the user removes them', async () => {
    const receipt = await owner.write('task-1', metadata, bytes, controls()), path = join(attachmentRoot, 'task-1', `${metadata.id}-${metadata.filename}`)
    await writeFile(path, Buffer.alloc(bytes.length, 9)); await expect(owner.rollback(receipt)).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_CHANGED' })
    await expect(owner.close()).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_CHANGED' }); expect(await readFile(path)).toEqual(Buffer.alloc(bytes.length, 9)); await rm(path); await owner.close()
  })
  it('refuses root/task replacement, symlinks and hardlinks while preserving unrelated bytes', async () => {
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'private'), 'private')
    await symlink(outside, join(attachmentRoot, 'task-1'), 'junction'); await expect(owner.write('task-1', metadata, bytes, controls())).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_REFUSED' }); await rm(join(attachmentRoot, 'task-1'))
    await mkdir(join(attachmentRoot, 'task-1')); const path = join(attachmentRoot, 'task-1', `${metadata.id}-${metadata.filename}`); await writeFile(path, bytes); await link(path, join(outside, 'linked'))
    await expect(owner.remove('task-1', metadata, controls())).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_REFUSED' }); expect(await readFile(join(outside, 'linked'))).toEqual(bytes)
    await rename(attachmentRoot, attachmentRoot + '.retained'); await mkdir(attachmentRoot)
    await expect(owner.remove('task-1', metadata, controls())).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_CHANGED' }); expect(await readFile(join(outside, 'private'), 'utf8')).toBe('private')
  })
  it('removes only the exact saved metadata filename and preserves similarly prefixed files', async () => {
    const receipt = await owner.write('task-1', metadata, bytes, controls()); owner.commit(receipt)
    const task = join(attachmentRoot, 'task-1'), other = join(task, `${metadata.id}-personal.txt`); await writeFile(other, 'personal')
    await owner.remove('task-1', metadata, controls()); expect(await readFile(other, 'utf8')).toBe('personal'); expect(await readdir(task)).toEqual([`${metadata.id}-personal.txt`])
    await owner.remove('task-1', metadata, controls())
  })
  it('refuses completed inherited Promise callbacks before any later attachment effect', async () => {
    const gate = held(); releases.push(gate.release); let late!: Promise<void>
    owner = create({ link: async (from, to) => { await link(from, to); late = gate.promise.then(() => owner.remove('task-1', metadata, controls())); void late.catch(() => {}) } })
    const receipt = await owner.write('task-1', metadata, bytes, controls()); owner.commit(receipt); gate.release()
    await expect(late).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' }); expect(await readFile(join(attachmentRoot, 'task-1', `${metadata.id}-${metadata.filename}`))).toEqual(bytes)
  })
  it('preserves saved bytes changed during a retained raw removal read', async () => {
    const path = join(attachmentRoot, 'task-1', `${metadata.id}-${metadata.filename}`); await mkdir(join(attachmentRoot, 'task-1')); await writeFile(path, bytes)
    const gate = held(), entered = held(); releases.push(gate.release)
    owner = create({ open: async (name, flags, mode) => { const fd = await actualHandle(name, flags, mode); return { ...fd, read: async (b,o,l,p) => { entered.release(); await gate.promise; return fd.read(b,o,l,p) } } } })
    const pending = owner.remove('task-1', metadata, controls()), failure = pending.catch(error => error); await entered.promise; await writeFile(path, Buffer.alloc(bytes.length, 7)); await utimes(path, new Date(), new Date(Date.now() + 5000)); gate.release()
    expect((await failure).code).toBe('ATTACHMENT_PATH_CHANGED'); expect(await readFile(path)).toEqual(Buffer.alloc(bytes.length, 7))
  })
})

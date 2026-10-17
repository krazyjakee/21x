import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskAttachmentFileOwner, type TaskAttachmentFileHandle, type TaskAttachmentFilePrimitives } from './task-attachment-file-owner'
import { isAttachmentPathReceipt, type AttachmentPathReceipt } from '../shared/attachment-native-callbacks'
import { ServiceProtocolError } from '../shared/service-protocol'

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

async function savedAttachment(size = metadata.size) {
  const taskId='task-open',directory=join(attachmentRoot,taskId),path=join(directory,`${metadata.id}-${metadata.filename}`)
  await mkdir(directory);const fd=await open(path,'wx');try{await fd.truncate(size)}finally{await fd.close()}
  return {taskId,path,attachment:{...metadata,size}}
}
describe('actual native attachment-opening FD lifetime',()=>{
  it('opens files larger than image publication without reading contents and holds FD through acknowledgement',async()=>{
    const saved=await savedAttachment(2*1024*1024),gate=held(),entered=held();releases.push(gate.release)
    let closed=false
    const read=vi.fn(async()=>{throw new Error('Opening must not read bytes')})
    owner=create({open:async(path,flags,mode)=>{const fd=await actualHandle(path,flags,mode);return{...fd,read,close:async()=>{await fd.close();closed=true}}}})
    const invoke=vi.fn(async(receipt:AttachmentPathReceipt)=>{expect(isAttachmentPathReceipt(receipt)).toBe(true);expect(receipt).toMatchObject({taskId:saved.taskId,attachmentId:metadata.id,filename:metadata.filename,attachmentRoot,path:saved.path,target:{size:String(saved.attachment.size),nlink:'1',kind:'file'}});expect(receipt.ancestors).toHaveLength(1);expect(receipt.ancestors[0].path).toBe(join(attachmentRoot,saved.taskId));expect(closed).toBe(false);entered.release();await gate.promise})
    const pending=owner.open(saved.taskId,saved.attachment,controls(),invoke);await entered.promise
    expect(closed).toBe(false);expect(owner.inflightCount).toBeGreaterThan(0);expect(read).not.toHaveBeenCalled()
    gate.release();expect(await pending).toBeUndefined();expect(closed).toBe(true);expect(invoke).toHaveBeenCalledTimes(1);expect(read).not.toHaveBeenCalled()
  })
  it('denies missing/incorrect metadata, linked files and oversized opening without native effects',async()=>{
    const invoke=vi.fn(async()=>{})
    await expect(owner.open('missing-task',metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_PATH_REFUSED'})
    const saved=await savedAttachment()
    await expect(owner.open(saved.taskId,{...metadata,size:metadata.size+1},controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_PATH_REFUSED'})
    await expect(owner.open(saved.taskId,{...metadata,filename:'../foreign'},controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_INVALID_ARGUMENTS'})
    await expect(owner.open(saved.taskId,{...metadata,size:64*1024*1024+1},controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_CAPACITY'})
    await link(saved.path,join(root,'outside-link'))
    await expect(owner.open(saved.taskId,metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_PATH_REFUSED'});await rm(join(root,'outside-link'))
    await rename(saved.path,saved.path+'.kept');await symlink(saved.path+'.kept',saved.path)
    await expect(owner.open(saved.taskId,metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_PATH_REFUSED'})
    expect(invoke).not.toHaveBeenCalled();expect((await readFile(saved.path+'.kept')).length).toBe(metadata.size)
  })
  it('captures a late accepted FD before cancellation and joins its real close',async()=>{
    const saved=await savedAttachment(),gate=held(),entered=held();releases.push(gate.release);let closed=false
    owner=create({open:async(path,flags,mode)=>{const fd=await actualHandle(path,flags,mode);entered.release();await gate.promise;return{...fd,close:async()=>{await fd.close();closed=true}}}})
    const controller=new AbortController(),invoke=vi.fn(async()=>{}),pending=owner.open(saved.taskId,metadata,controls(controller.signal),invoke),failure=pending.catch(error=>error)
    await entered.promise;controller.abort();await expect(owner.close(5)).rejects.toMatchObject({code:'ATTACHMENT_DRAIN_INCOMPLETE'})
    expect(closed).toBe(false);gate.release();expect((await failure).code).toMatch(/ATTACHMENT_(CLOSED|CANCELLED)/);await owner.close();expect(closed).toBe(true);expect(invoke).not.toHaveBeenCalled()
  })
  it('retains ignored native cancellation and never replays an uncertain accepted open',async()=>{
    const saved=await savedAttachment(),gate=held(),entered=held();releases.push(gate.release);let closed=false
    owner=create({open:async(path,flags,mode)=>{const fd=await actualHandle(path,flags,mode);return{...fd,close:async()=>{await fd.close();closed=true}}}})
    const controller=new AbortController(),invoke=vi.fn(async()=>{entered.release();await gate.promise}),pending=owner.open(saved.taskId,metadata,controls(controller.signal),invoke),failure=pending.catch(error=>error)
    await entered.promise;controller.abort();await expect(owner.close(5)).rejects.toMatchObject({code:'ATTACHMENT_DRAIN_INCOMPLETE'});expect(closed).toBe(false)
    gate.release();expect((await failure).code).toMatch(/ATTACHMENT_(CLOSED|CANCELLED)/);await owner.close();expect(closed).toBe(true);expect(invoke).toHaveBeenCalledTimes(1)
    expect((await readFile(saved.path)).length).toBe(metadata.size)
  })
  it('rechecks revoked guards on every primitive and after native work while still closing the FD',async()=>{
    const saved=await savedAttachment();let allowed=false,closed=false
    owner=create({open:async(path,flags,mode)=>{const fd=await actualHandle(path,flags,mode);return{...fd,close:async()=>{await fd.close();closed=true}}}})
    const guarded={signal:new AbortController().signal,beforeEffect:()=>{if(!allowed)throw new ServiceProtocolError('INVALID_REQUEST')}}
    const invoke=vi.fn(async()=>{allowed=false})
    await expect(owner.open(saved.taskId,metadata,guarded,invoke)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(invoke).not.toHaveBeenCalled()
    allowed=true;await expect(owner.open(saved.taskId,metadata,guarded,invoke)).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(invoke).toHaveBeenCalledTimes(1);expect(closed).toBe(true)
  })
  it('preserves replaced files/task directories and freezes the exact saved metadata during native waits',async()=>{
    const saved=await savedAttachment(),input={...metadata},gate=held(),entered=held();releases.push(gate.release)
    const invoke=vi.fn(async(receipt:AttachmentPathReceipt)=>{expect(receipt.filename).toBe(metadata.filename);entered.release();await gate.promise})
    const pending=owner.open(saved.taskId,input,controls(),invoke),failure=pending.catch(error=>error);input.filename='unrelated.txt';await entered.promise
    await rename(saved.path,saved.path+'.original');await writeFile(saved.path,Buffer.alloc(metadata.size,9));gate.release()
    expect((await failure).code).toBe('ATTACHMENT_PATH_CHANGED');expect(await readFile(saved.path)).toEqual(Buffer.alloc(metadata.size,9));expect((await readFile(saved.path+'.original')).length).toBe(metadata.size)
    const taskPath=join(attachmentRoot,saved.taskId);await rename(taskPath,taskPath+'.retained');await mkdir(taskPath);await writeFile(saved.path,Buffer.alloc(metadata.size))
    await expect(owner.open(saved.taskId,metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_PATH_CHANGED'});expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('retains a failed descriptor close after native acknowledgement until explicit retry',async()=>{
    const saved=await savedAttachment();let refuse=true,closes=0
    owner=create({open:async(path,flags,mode)=>{const fd=await actualHandle(path,flags,mode);return{...fd,close:async()=>{closes++;if(refuse)throw new Error('Controlled close refusal');await fd.close()}}}})
    const invoke=vi.fn(async()=>{})
    await expect(owner.open(saved.taskId,metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_CLOSE_FAILED'});expect(owner.inflightCount).toBeGreaterThan(0);expect(invoke).toHaveBeenCalledTimes(1)
    await expect(owner.open(saved.taskId,metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_BUSY'})
    await expect(owner.close()).rejects.toMatchObject({code:'ATTACHMENT_CLOSE_FAILED'});refuse=false;await owner.close();expect(owner.inflightCount).toBe(0);expect(closes).toBe(3);expect((await readFile(saved.path)).length).toBe(metadata.size)
  })
  it('refuses a replaced captured root and preserves its original registered bytes',async()=>{
    const saved=await savedAttachment(),invoke=vi.fn(async()=>{})
    await owner.open(saved.taskId,metadata,controls(),invoke)
    await rename(attachmentRoot,attachmentRoot+'.retained');await mkdir(attachmentRoot)
    await expect(owner.open(saved.taskId,metadata,controls(),invoke)).rejects.toMatchObject({code:'ATTACHMENT_PATH_CHANGED'})
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await readFile(join(attachmentRoot+'.retained',saved.taskId,`${metadata.id}-${metadata.filename}`))).length).toBe(metadata.size)
  })
})


describe('bounded selection-stream publication', () => {
  it('streams and verifies larger files with bounded reads, preserves image limits, and removes the exact committed output', async () => {
    const size = 2 * 1024 * 1024 + 17, record = { ...metadata, filename: 'document.bin', size, mime_type: 'application/octet-stream' }
    const lengths: number[] = [], positions: number[] = []
    owner = create({ open: async (path, flags, mode) => {
      const fd = await actualHandle(path, flags, mode)
      return { ...fd, read: async (b, o, l, p) => { expect(b.length).toBeLessThanOrEqual(65536); return fd.read(b, o, Math.min(997, l), p) }, write: async (b, o, l, p) => fd.write(b, o, Math.min(1009, l), p) }
    } })
    const receipt = await owner.writeStream('task-stream', record, async (offset, length) => { lengths.push(length); positions.push(offset); return Buffer.alloc(length, offset / 65536 % 251) }, controls())
    owner.commit(receipt)
    expect(Math.max(...lengths)).toBe(65536); expect(positions).toEqual(Array.from({ length: Math.ceil(size / 65536) }, (_, i) => i * 65536))
    const actual = await readFile(join(attachmentRoot, 'task-stream', `${record.id}-${record.filename}`))
    expect(actual.length).toBe(size); expect(actual[65536]).toBe(1); expect(actual[size - 1]).toBe(32)
    await expect(owner.write('task-image', record, Buffer.alloc(size), controls())).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_ARGUMENTS' })
    await owner.remove('task-stream', record, controls()); expect(await readdir(join(attachmentRoot, 'task-stream'))).toEqual([])
  })
  it('rolls back an acknowledged streamed prefix after producer refusal, short chunk or withdrawn scope', async () => {
    const record = { ...metadata, size: 131073 }
    for (const mode of ['refused', 'short', 'withdrawn']) {
      let permitted = true
      const guarded = { signal: new AbortController().signal, beforeEffect() { if (!permitted) throw new ServiceProtocolError('INVALID_REQUEST') } }
      await expect(owner.writeStream('task-' + mode, record, async (offset, length) => {
        if (offset) { if (mode === 'refused') throw new Error('Controlled producer refusal'); if (mode === 'short') return Buffer.alloc(length - 1); permitted = false }
        return Buffer.alloc(length, 3)
      }, guarded)).rejects.toBeInstanceOf(Error)
      expect(await readdir(join(attachmentRoot, 'task-' + mode))).toEqual([])
    }
  })
  it('joins a raw producer and destination close through cancellation and failed-close retry', async () => {
    const gate = held(), entered = held(); releases.push(gate.release); let refuse = true
    owner = create({ open: async (path, flags, mode) => { const fd = await actualHandle(path, flags, mode); return { ...fd, close: async () => { if (refuse) throw new Error('Controlled close refusal'); await fd.close() } } } })
    const pending = owner.writeStream('task-held-stream', { ...metadata, size: 65537 }, async (_offset, length) => { entered.release(); await gate.promise; return Buffer.alloc(length) }, controls()), failure = pending.catch(error => error)
    await entered.promise; await expect(owner.close(5)).rejects.toMatchObject({ code: 'ATTACHMENT_DRAIN_INCOMPLETE' })
    gate.release(); expect((await failure).code).toBe('ATTACHMENT_CLOSE_FAILED'); expect(owner.inflightCount).toBeGreaterThan(0)
    refuse = false; await owner.close(); expect(await readdir(join(attachmentRoot, 'task-held-stream'))).toEqual([])
  })
  it('preserves an altered streamed publication and retains cleanup ownership until explicit repair', async () => {
    const record = { ...metadata, size: 1048577 }, receipt = await owner.writeStream('task-changed-stream', record, async (_offset, length) => Buffer.alloc(length, 4), controls())
    const path = join(attachmentRoot, 'task-changed-stream', `${record.id}-${record.filename}`)
    const fd = await open(path, 'r+'); try { await fd.write(Buffer.from([8]), 0, 1, 900000) } finally { await fd.close() }
    await expect(owner.rollback(receipt)).rejects.toMatchObject({ code: 'ATTACHMENT_PATH_CHANGED' }); expect((await readFile(path))[900000]).toBe(8)
    await rm(path); await owner.close()
  })
})

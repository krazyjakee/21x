import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskAttachmentFileOwner } from '../task-attachment-file-owner'
import type { FileAttachmentRecord } from '../database/types'
import { saveImagesAsTaskAttachments, type TaskImageStore } from './task-image-attachments'

const fixtures: Array<{ root: string; owner: TaskAttachmentFileOwner }> = []
const image = { name: '../写真.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAQID' }
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.owner.close(); await rm(fixture.root, { recursive: true, force: true }) } })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '21x-task-images-owner-')), attachmentRoot = join(root, 'attachments'); await mkdir(attachmentRoot)
  const owner = new TaskAttachmentFileOwner({ attachmentRoot, assertCurrent() {} }); fixtures.push({ root, owner })
  let attachments: FileAttachmentRecord[] = []
  const ambient = vi.fn(() => { throw new Error('Ambient attachment directory forbidden') })
  const store: TaskImageStore = { getTask: () => ({ attachments }), getAttachmentsDir: ambient, updateTask: (_id, data) => { attachments = data.attachments; return true } }
  const controls = { beforeEffect() {}, write: (id: string, record: FileAttachmentRecord, bytes: Buffer) => owner.write(id, record, bytes, { beforeEffect() {}, signal: new AbortController().signal }), rollback: (receipt: unknown) => owner.rollback(receipt), commit: (receipt: unknown) => owner.commit(receipt) }
  return { root, owner, attachmentRoot, store, controls, ambient, get attachments() { return attachments } }
}
describe('existing image save algorithm borrowing portable physical owner', () => {
  it('keeps sanitized Unicode names, unique reservations, ordinary metadata and real bytes without ambient paths', async () => {
    const value = await fixture(), first = await saveImagesAsTaskAttachments(value.store, 'task-1', [image], value.controls), second = await saveImagesAsTaskAttachments(value.store, 'task-1', [image], value.controls)
    expect(first.saved[0]?.filename).toBe('写真.png'); expect(second.saved[0]?.filename).toBe('写真-2.png'); expect(value.attachments).toEqual([...first.saved, ...second.saved]); expect(value.ambient).not.toHaveBeenCalled()
    for (const record of value.attachments) expect(await readFile(join(value.attachmentRoot, 'task-1', `${record.id}-${record.filename}`))).toEqual(Buffer.from(image.data, 'base64'))
    await value.owner.close(); expect(await readdir(join(value.attachmentRoot, 'task-1'))).toHaveLength(2)
  })
  it('rolls back only owner receipts when the durable store refuses, retaining legacy failure behavior separately', async () => {
    const value = await fixture(); value.store.updateTask = () => { throw new Error('Controlled durable store refusal') }
    await expect(saveImagesAsTaskAttachments(value.store, 'task-1', [image], value.controls)).rejects.toThrow('Controlled durable store refusal')
    expect(value.attachments).toEqual([]); expect(await readdir(join(value.attachmentRoot, 'task-1'))).toEqual([]); expect(value.ambient).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { TASK_ATTACHMENT_CODECS as codecs, TASK_ATTACHMENT_OPERATIONS, TASK_ATTACHMENT_LIMITS, taskAttachmentRecord, taskAttachmentRecords } from './task-attachment-codecs'

const id = '61f07006-c85b-438e-83a7-497c77b0dcae'
const image = { name: '../写真.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAQID' }
const attachment = { id, filename: '写真.png', size: 12, mime_type: 'image/png', added_at: '2026-10-14T00:00:00.000Z' }
describe('finite task attachment contracts', () => {
  it('keeps two exact operations, existing payload keys, metadata and void removal', () => {
    expect(TASK_ATTACHMENT_OPERATIONS).toEqual(['chatImages:saveToTask', 'attachments:remove'])
    expect(codecs['chatImages:saveToTask'].encodeArguments(['task-1', [image]])).toEqual({ taskId: 'task-1', images: [image] })
    expect(codecs['chatImages:saveToTask'].decodeArguments({ taskId: 'task-1', images: [image] })).toEqual(['task-1', [image]])
    expect(codecs['attachments:remove'].encodeArguments(['task-1', id])).toEqual({ taskId: 'task-1', attachmentId: id })
    expect(codecs['attachments:remove'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['chatImages:saveToTask'].encodeResult([attachment])).toEqual({ defined: true, value: [attachment] })
  })
  it('refuses caller paths/roots/grants, non-UUID selectors and malformed metadata', () => {
    for (const extra of ['path','root','filename','scope','projectId']) expect(() => codecs['attachments:remove'].decodeArguments({ taskId: 'task-1', attachmentId: id, [extra]: undefined } as never)).toThrow()
    expect(() => codecs['attachments:remove'].decodeArguments({ taskId: 'task-1', attachmentId: '../private' })).toThrow()
    for (const filename of ['../private','a/b.png','C:\\private','CON.png','nul','unsafe.','a\0b']) expect(taskAttachmentRecord({ ...attachment, filename })).toBe(false)
    expect(taskAttachmentRecord({ ...attachment, size: Number.MAX_SAFE_INTEGER + 1 })).toBe(false)
    expect(taskAttachmentRecords([attachment, attachment])).toBe(false)
    expect(taskAttachmentRecord({ ...attachment, token: 'private' })).toBe(false)
  })
  it('checks string/count/aggregate bounds before large image decoding or serialization', () => {
    const prefix = 'iVBORw0KGgoA'
    expect(codecs['chatImages:saveToTask'].validateArguments(['task-1', [{ ...image, data: prefix + 'A'.repeat(4 * Math.ceil((TASK_ATTACHMENT_LIMITS.imageBytes + 1) / 3)) }]])).toBe(false)
    const data = prefix + 'A'.repeat(4 * Math.ceil(300000 / 3))
    expect(codecs['chatImages:saveToTask'].validateArguments(['task-1', [{ ...image, data }, { ...image, data }]])).toBe(false)
    expect(codecs['chatImages:saveToTask'].validateArguments(['task-1', Array(6).fill(image)])).toBe(false)
    expect(codecs['chatImages:saveToTask'].validateArguments(['task-1', [{ ...image, data: 'not base64' }]])).toBe(false)
    expect(codecs['chatImages:saveToTask'].validateArguments(['task-1', [{ ...image, data: 'YWJjZA==' }]])).toBe(false)
  })
  it('accepts sniffed type semantics and legacy finite attachment MIME metadata', () => {
    expect(codecs['chatImages:saveToTask'].validateArguments(['task-1', [{ ...image, mimeType: 'image/jpeg' }]])).toBe(true)
    expect(taskAttachmentRecord({ ...attachment, filename: 'document.pdf', mime_type: 'application/pdf', size: 2000000 })).toBe(true)
    expect(codecs['chatImages:saveToTask'].validateWireResult({ defined: true, value: [attachment], path: '/private' })).toBe(false)
    expect(codecs['attachments:remove'].validateWireResult({ defined: false, value: null })).toBe(false)
  })
})

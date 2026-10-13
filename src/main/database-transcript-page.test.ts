import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import type { DatabaseManager } from './database/manager'
import { isDatabaseTranscriptPart } from '../shared/database-desktop-codecs'
import { isTranscriptPage, TRANSCRIPT_PAGE_LIMITS, TRANSCRIPT_PREVIEW_NOTICE, type TranscriptPageRequest } from '../shared/transcript-page'

let db: DatabaseManager
let taskId: string
beforeEach(() => {
  db = createPortableTestDb()
  taskId = db.createTask({ title: 'Paged transcript' })!.id
})
afterEach(() => db.close())

describe('bounded transcript display pages', () => {
  it('reads hundreds of parts with stable identities and cursor order even when event times are reversed', () => {
    db.upsertTranscriptParts(taskId, Array.from({ length: 513 }, (_, i) => ({ id: `p-${i}`, role: 'assistant', content: `part ${i}`, receivedAt: 1000 - i })))
    const ids: string[] = []
    let after = 0
    let watermark: number | undefined
    for (let pages = 0; ; pages++) {
      expect(pages).toBeLessThan(100)
      const page = db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after, limit: 7, ...(watermark === undefined ? {} : { watermark }) })
      expect(isTranscriptPage(page, isDatabaseTranscriptPart)).toBe(true)
      expect(page.parts.length).toBeLessThanOrEqual(7)
      watermark ??= page.watermark
      expect(page.watermark).toBe(watermark)
      ids.push(...page.parts.map(part => part.partId))
      if (!page.hasMore) break
      after = page.cursor
    }
    expect(ids).toEqual(Array.from({ length: 513 }, (_, i) => `p-${i}`))
    expect(new Set(ids).size).toBe(513)
    expect(db.getTranscriptParts(taskId)[0].partId).toBe('p-512') // Existing chronological API is preserved.
  })

  it('limits UTF-8 reply bytes independently of the part-count cap', () => {
    db.upsertTranscriptParts(taskId, Array.from({ length: 64 }, (_, i) => ({ id: `p-${i}`, role: 'assistant', content: '🚀'.repeat(8192) })))
    let after = 0
    let count = 0
    const watermark = db.getTranscriptMaxRev(taskId)
    while (true) {
      const page = db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after, watermark })
      expect(isTranscriptPage(page, isDatabaseTranscriptPart)).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(TRANSCRIPT_PAGE_LIMITS.bytes)
      expect(page.parts.length).toBeLessThan(64)
      count += page.parts.length
      if (!page.hasMore) break
      after = page.cursor
    }
    expect(count).toBe(64)
  })

  it('previews oversized fields before loading them into JS without changing durable data', () => {
    const content = 'x'.repeat(2_000_000)
    const tool = { name: 'read', status: 'completed', output: 'y'.repeat(1_000_000) }
    db.upsertTranscriptParts(taskId, [{ id: 'huge', role: 'assistant', content, tool, payload: { note: 'z'.repeat(1_000_000) } }])
    const page = db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after: 0 })
    expect(page.parts[0].content).toBe(content.slice(0, TRANSCRIPT_PAGE_LIMITS.fieldChars) + TRANSCRIPT_PREVIEW_NOTICE)
    expect(page.parts[0].tool).toBeUndefined()
    expect(page.parts[0].payload).toBeUndefined()
    expect(isTranscriptPage(page, isDatabaseTranscriptPart)).toBe(true)
    expect(db.getTranscriptParts(taskId)[0]).toMatchObject({ content, tool, payload: { note: 'z'.repeat(1_000_000) } })
  })

  it('recovers rows updated or inserted between snapshot pages from the captured revision watermark', () => {
    db.upsertTranscriptParts(taskId, Array.from({ length: 5 }, (_, i) => ({ id: `p-${i}`, role: 'assistant', content: `old ${i}` })))
    const first = db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after: 0, limit: 2 })
    db.upsertTranscriptParts(taskId, [{ id: 'p-2', content: 'changed unseen' }, { id: 'p-0', content: 'changed seen' }, { id: 'new', content: 'inserted during read' }])
    const rest = db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after: first.cursor, watermark: first.watermark })
    expect(rest.parts.map(part => part.partId)).toEqual(['p-3', 'p-4'])
    const updates = db.getTranscriptPage(taskId, { version: 1, mode: 'delta', after: first.watermark, limit: 1 })
    expect(updates.parts[0]).toMatchObject({ partId: 'p-2', content: 'changed unseen' })
    db.upsertTranscriptParts(taskId, [{ id: 'p-0', content: 'changed again' }])
    const last = db.getTranscriptPage(taskId, { version: 1, mode: 'delta', after: updates.cursor, watermark: updates.watermark })
    expect(last.parts.map(part => part.partId)).toEqual(['new'])
    expect(last.hasMore).toBe(false)
    expect(last.cursor).toBe(updates.watermark)
    const later = db.getTranscriptPage(taskId, { version: 1, mode: 'delta', after: last.cursor })
    expect(later.parts[0]).toMatchObject({ partId: 'p-0', content: 'changed again' })
  })

  it('does not expose another task while revision numbers have global gaps', () => {
    const other = db.createTask({ title: 'Other transcript' })!.id
    db.upsertTranscriptParts(taskId, [{ id: 'first', content: 'visible' }])
    db.upsertTranscriptParts(other, [{ id: 'private', content: 'other task' }])
    db.upsertTranscriptParts(taskId, [{ id: 'last', content: 'visible later' }])
    const page = db.getTranscriptPage(taskId, { version: 1, mode: 'delta', after: 0 })
    expect(page.parts.map(part => part.rev)).toEqual([1, 3])
    expect(page.parts.every(part => part.taskId === taskId)).toBe(true)
    expect(page.cursor).toBe(3)
  })

  it('rejects a future watermark or a cursor from a replaced projection', () => {
    expect(() => db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after: 0, watermark: 1 })).toThrow('service instance has changed')
    expect(() => db.getTranscriptPage(taskId, { version: 1, mode: 'delta', after: 1 })).toThrow('service instance has changed')
  })

  it.each([
    { version: 2, mode: 'snapshot', after: 0 },
    { version: 1, mode: 'snapshot', after: -1 },
    { version: 1, mode: 'snapshot', after: 0, limit: 65 },
    { version: 1, mode: 'snapshot', after: 0, watermark: null },
    { version: 1, mode: 'delta', after: 2, watermark: 1 },
    { version: 1, mode: 'snapshot', after: 0, secret: 'unreviewed' }
  ])('rejects malformed or unbounded requests: %j', request => {
    expect(() => db.getTranscriptPage(taskId, request as unknown as TranscriptPageRequest)).toThrow('Invalid operation arguments')
  })

  it('rejects invalid identities without reading oversized identity fields into JS', () => {
    db.upsertTranscriptParts(taskId, [{ id: 'x'.repeat(100_000), content: 'bad identity' }])
    expect(() => db.getTranscriptPage(taskId, { version: 1, mode: 'snapshot', after: 0 })).toThrow('Invalid operation result')
  })
})

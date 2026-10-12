import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPortableTestDb } from '../../test/helpers/portable-db-test-helper'
import type { DatabaseManager, TranscriptPartInput } from './database/manager'
import { encodeDurableTranscriptEvent } from '../service/transcript-events'
import { DATABASE_EVENT_CODECS } from '../shared/database-desktop-codecs'

let db: DatabaseManager
let taskId: string
beforeEach(() => { db = createPortableTestDb(); taskId = db.createTask({ title: 'Durable event fixture' })!.id })
afterEach(() => db.close())
function event(parts: TranscriptPartInput[]) {
  const { maxRev, changedPartIds } = db.upsertTranscriptParts(taskId, parts)
  return { taskId, maxRev, parts: changedPartIds.map(partId => ({ taskId, partId, rev: db.getTranscriptEventPart(taskId, partId)!.rev })) }
}

describe('bounded durable transcript events', () => {
  it('reads canonical persisted values by key without loading the full transcript', () => {
    const source = event([{ id: 'part', role: 'assistant', content: 'Durable value' }])
    const all = vi.spyOn(db, 'getTranscriptParts')
    const delta = vi.spyOn(db, 'getTranscriptDelta')
    const encoded = encodeDurableTranscriptEvent(db, { ...source, parts: [{ ...source.parts[0], content: 'Untrusted event value', tool: { secret: true } }] })
    expect(encoded).toMatchObject({ taskId, parts: [{ content: 'Durable value' }] })
    expect(DATABASE_EVENT_CODECS['transcript:changed'].validatePayload(encoded)).toBe(true)
    expect(JSON.stringify(encoded)).not.toContain('Untrusted')
    expect(all).not.toHaveBeenCalled(); expect(delta).not.toHaveBeenCalled()
  })

  it('replaces count overflow with a bounded invalidation and preserves every saved row', () => {
    const source = event(Array.from({ length: 129 }, (_, i) => ({ id: `p-${i}`, content: 'saved' })))
    expect(encodeDurableTranscriptEvent(db, source)).toEqual({ taskId, parts: [], maxRev: source.maxRev, reloadRequired: true })
    expect(db.getTranscriptParts(taskId)).toHaveLength(129)
  })

  it('counts UTF-8 bytes independently of part count', () => {
    const source = event(Array.from({ length: 32 }, (_, i) => ({ id: `p-${i}`, content: '🚀'.repeat(4096) })))
    expect(encodeDurableTranscriptEvent(db, source)).toEqual({ taskId, parts: [], maxRev: source.maxRev, reloadRequired: true })
    expect(encodeDurableTranscriptEvent(db, { ...source, parts: source.parts.slice(0, 4) })).toMatchObject({ parts: Array(4).fill({ content: '🚀'.repeat(4096) }) })
  })

  it.each(['content', 'tool', 'payload'] as const)('never materializes an oversized %s for an event', field => {
    const value = 'x'.repeat(2_000_000)
    const source = event([{ id: 'huge', content: field === 'content' ? value : 'saved',
      ...(field === 'tool' ? { tool: { output: value } } : {}), ...(field === 'payload' ? { payload: { output: value } } : {}) }])
    expect(db.getTranscriptEventPart(taskId, 'huge')).toEqual({ rev: source.maxRev })
    expect(encodeDurableTranscriptEvent(db, source)).toEqual({ taskId, parts: [], maxRev: source.maxRev, reloadRequired: true })
    const saved = db.getTranscriptParts(taskId)[0]
    expect(field === 'content' ? saved.content : (saved[field] as { output: string }).output).toBe(value)
  })

  it('rejects invalid identities even when the rest of a batch requires reload', () => {
    const source = event(Array.from({ length: 129 }, (_, i) => ({ id: `p-${i}`, content: 'saved' })))
    for (const bad of [{ ...source.parts[128], partId: 'missing' }, { ...source.parts[128], taskId: 'foreign' },
      { ...source.parts[128], rev: source.maxRev + 1 }, source.parts[0]]) {
      expect(() => encodeDurableTranscriptEvent(db, { ...source, parts: [...source.parts.slice(0, 128), bad] })).toThrow()
    }
    expect(() => encodeDurableTranscriptEvent(db, { ...source, maxRev: source.maxRev + 1 })).toThrow()
    expect(() => encodeDurableTranscriptEvent(db, { ...source, reloadRequired: true })).toThrow()
  })

  it('rejects stale revisions and invalid empty invalidations', () => {
    const source = event([{ id: 'part', content: 'old' }])
    event([{ id: 'part', content: 'new' }])
    expect(() => encodeDurableTranscriptEvent(db, source)).toThrow()
    expect(() => encodeDurableTranscriptEvent(db, { taskId, parts: [], maxRev: NaN, reloadRequired: true })).toThrow()
    expect(encodeDurableTranscriptEvent(db, { taskId, parts: [], maxRev: 0, reloadRequired: true })).toEqual({ taskId, parts: [], maxRev: db.getTranscriptMaxRev(taskId), reloadRequired: true })
  })

  it('verifies exact durable permission identity even when its display payload is oversized', () => {
    event([{ id: 'question-r1', tool: { name: 'permission', status: 'running', requestId: 'r1', output: 'x'.repeat(2_000_000) } }])
    expect(db.getTranscriptEventPart(taskId, 'question-r1')?.part).toBeUndefined()
    expect(db.hasTranscriptPermission(taskId, 'question-r1', 'r1')).toBe(true)
    expect(db.hasTranscriptPermission(taskId, 'question-r1', 'r2')).toBe(false)
    expect(db.hasTranscriptPermission('foreign', 'question-r1', 'r1')).toBe(false)
    event([{ id: 'question-r1', tool: { name: 'permission', status: 'completed', requestId: 'r1' } }])
    expect(db.hasTranscriptPermission(taskId, 'question-r1', 'r1')).toBe(false)
  })
})

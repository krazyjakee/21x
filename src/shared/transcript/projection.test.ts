import { describe, expect, it } from 'vitest'
import { applyPartsToProjection, createProjection, projectMessages } from './projection'
import type { TranscriptPartRecord } from './types'

function part(partId: string, createdAt: number, seq: number, content = partId): TranscriptPartRecord {
  return { taskId: 't', partId, seq, role: 'assistant', content, createdAt, updatedAt: createdAt, rev: seq }
}

const ids = (p: ReturnType<typeof createProjection>) => projectMessages(p).map((m) => m.id)

describe('transcript projection', () => {
  it('sorts a snapshot by (createdAt, seq) and dedupes by part id', () => {
    const p = createProjection([part('b', 2, 2), part('a', 1, 1), part('b', 2, 2, 'dup')], 5)
    expect(ids(p)).toEqual(['a', 'b'])
    expect(p.rev).toBe(5)
  })

  it('appends, inserts out-of-order parts, and replaces updated parts in place', () => {
    const p = createProjection([part('a', 1, 1), part('c', 3, 3)])
    applyPartsToProjection(p, [part('d', 4, 4), part('b', 2, 2)], 7)
    expect(ids(p)).toEqual(['a', 'b', 'c', 'd'])
    applyPartsToProjection(p, [part('c', 3, 3, 'streamed')])
    expect(projectMessages(p)[2].content).toBe('streamed')
    expect(ids(p)).toEqual(['a', 'b', 'c', 'd'])
    expect(p.rev).toBe(7)
  })

  it('moves a part whose sort key changed', () => {
    const p = createProjection([part('a', 1, 1), part('b', 2, 2)])
    applyPartsToProjection(p, [part('a', 3, 3)])
    expect(ids(p)).toEqual(['b', 'a'])
  })

  it('keeps message identity for unchanged parts', () => {
    const p = createProjection([part('a', 1, 1), part('b', 2, 2)])
    const before = projectMessages(p)
    applyPartsToProjection(p, [part('b', 2, 2, 'new')])
    const after = projectMessages(p)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
  })
})

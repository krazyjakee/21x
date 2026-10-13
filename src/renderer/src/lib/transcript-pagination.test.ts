import { describe, expect, it, vi } from 'vitest'
import { hydrateTranscriptProjection, readTranscriptWindow, type TranscriptPageReader } from './transcript-pagination'
import { createProjection, applyPartsToProjection } from '@shared/transcript/projection'
import type { TranscriptPage } from '@shared/transcript-page'
import type { TranscriptPartRecord } from '@shared/transcript/types'
import { ServiceProtocolError } from '@shared/service-protocol'

const part = (id: string, seq: number, rev: number, content = id): TranscriptPartRecord =>
  ({ taskId: 'task-1', partId: id, seq, rev, content, role: 'assistant', createdAt: 100 - seq, updatedAt: rev })
const page = (mode: 'snapshot' | 'delta', after: number, watermark: number, parts: TranscriptPartRecord[], hasMore = false): TranscriptPage =>
  ({ version: 1, taskId: 'task-1', mode, after, watermark, parts, hasMore,
    cursor: mode === 'delta' && !hasMore ? watermark : parts.at(-1)?.[mode === 'snapshot' ? 'seq' : 'rev'] ?? after })

describe('transcript page recovery', () => {
  it('uses its captured snapshot cursor even when live events advance the projection during hydration', async () => {
    const projection = createProjection()
    const replies = [page('snapshot', 0, 5, [part('first', 1, 1)], true),
      page('snapshot', 1, 5, [part('last', 3, 5)]),
      page('delta', 5, 10, [part('missed', 2, 7), part('first', 1, 10, 'updated')])]
    const read = vi.fn<TranscriptPageReader>(async () => replies.shift()!)
    let callbacks = 0
    await hydrateTranscriptProjection(read, 'task-1', projection, { onPage: () => {
      if (++callbacks === 1) applyPartsToProjection(projection, [part('newest', 4, 20)], 20)
    } })
    expect(read.mock.calls.map(([, request]) => [request.mode, request.after, request.watermark])).toEqual([
      ['snapshot', 0, undefined], ['snapshot', 1, 5], ['delta', 5, undefined]
    ])
    expect(projection.parts.get('first')?.content).toBe('updated')
    expect(projection.parts.has('missed')).toBe(true)
    expect(projection.parts.has('newest')).toBe(true)
    expect(projection.sorted.map(item => item.partId)).toEqual(['newest', 'last', 'missed', 'first'])
    expect(projection.rev).toBe(20)
  })

  it('does not advance a safe recovery revision when a later snapshot page fails', async () => {
    const projection = createProjection()
    const read = vi.fn<TranscriptPageReader>().mockResolvedValueOnce(page('snapshot', 0, 5, [part('first', 1, 1)], true))
      .mockRejectedValueOnce(new ServiceProtocolError('DISCONNECTED'))
    await expect(hydrateTranscriptProjection(read, 'task-1', projection)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(projection.parts.size).toBe(1)
    expect(projection.rev).toBe(0)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('settles cancellation promptly, passes it to the reader and never applies a late reply', async () => {
    const controller = new AbortController()
    const apply = vi.fn()
    let resolve!: (value: TranscriptPage) => void
    let signal!: AbortSignal
    const read: TranscriptPageReader = (_id, _request, options) => { signal = options.signal; return new Promise(done => { resolve = done }) }
    const result = readTranscriptWindow(read, 'task-1', { version: 1, mode: 'snapshot', after: 0 }, { signal: controller.signal, onPage: apply })
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(signal.aborted).toBe(true)
    resolve(page('snapshot', 0, 1, [part('late', 1, 1)]))
    await Promise.resolve()
    expect(apply).not.toHaveBeenCalled()
  })

  it('bounds a stalled recovery window and aborts its reader', async () => {
    vi.useFakeTimers()
    try {
      let signal!: AbortSignal
      const read: TranscriptPageReader = (_id, _request, options) => { signal = options.signal; return new Promise(() => {}) }
      const failed = expect(readTranscriptWindow(read, 'task-1', { version: 1, mode: 'snapshot', after: 0 }, { timeoutMs: 10, onPage() {} }))
        .rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(10)
      await failed
      expect(signal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('refuses changed watermarks, foreign task replies and cursors that cannot progress', async () => {
    for (const invalid of [page('snapshot', 1, 6, [part('next', 2, 6)]),
      { ...page('snapshot', 1, 5, [part('next', 2, 5)]), taskId: 'foreign' },
      { ...page('snapshot', 1, 5, []), hasMore: true }]) {
      const read = vi.fn<TranscriptPageReader>().mockResolvedValueOnce(page('snapshot', 0, 5, [part('first', 1, 1)], true)).mockResolvedValueOnce(invalid)
      await expect(readTranscriptWindow(read, 'task-1', { version: 1, mode: 'snapshot', after: 0 }, { onPage() {} })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    }
  })

  it('caps the page count without issuing another request or replaying a failed read', async () => {
    const read = vi.fn<TranscriptPageReader>().mockResolvedValue(page('snapshot', 0, 5, [part('first', 1, 1)], true))
    await expect(readTranscriptWindow(read, 'task-1', { version: 1, mode: 'snapshot', after: 0 }, { maxPages: 1, onPage() {} }))
      .rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(read).toHaveBeenCalledOnce()
  })
})

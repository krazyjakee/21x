import { isDatabaseTranscriptPart } from '@shared/database-desktop-codecs'
import { SERVICE_LIMITS, ServiceProtocolError } from '@shared/service-protocol'
import { isTranscriptPage, isTranscriptPageRequest, TRANSCRIPT_PAGE_LIMITS, type TranscriptPage, type TranscriptPageRequest } from '@shared/transcript-page'
import { applyPartsToProjection, type TranscriptProjection } from '@shared/transcript/projection'

export type TranscriptPageReader = (taskId: string, request: TranscriptPageRequest, options: { signal: AbortSignal }) => Promise<TranscriptPage>
interface ReadOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxPages?: number
  /** Synchronous application of one validated page; no aggregate copy is built. */
  onPage: (page: TranscriptPage) => void
}

/** Read one fixed-watermark window. Reconnect/failed reads are never replayed. */
export async function readTranscriptWindow(read: TranscriptPageReader, taskId: string, request: TranscriptPageRequest,
  options: ReadOptions): Promise<{ cursor: number; watermark: number; pages: number }> {
  if (!isTranscriptPageRequest(request) || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  const timeout = options.timeoutMs ?? SERVICE_LIMITS.requestTimeoutMs
  const maxPages = options.maxPages ?? 4096
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > SERVICE_LIMITS.requestTimeoutMs ||
    !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 4096) throw new ServiceProtocolError('INVALID_ARGUMENTS')
  if (options.signal?.aborted) throw new ServiceProtocolError('CANCELLED')
  const controller = new AbortController()
  let reason: 'CANCELLED' | 'TIMEOUT' = 'CANCELLED'
  let reject!: (error: ServiceProtocolError) => void
  const interrupted = new Promise<never>((_resolve, rejectRead) => { reject = rejectRead })
  const cancel = (code: 'CANCELLED' | 'TIMEOUT'): void => {
    if (controller.signal.aborted) return
    reason = code; controller.abort(); reject(new ServiceProtocolError(code))
  }
  const abort = (): void => cancel('CANCELLED')
  const timer = setTimeout(() => cancel('TIMEOUT'), timeout)
  options.signal?.addEventListener('abort', abort, { once: true })
  let after = request.after
  let watermark = request.watermark
  try {
    for (let pages = 1; pages <= maxPages; pages++) {
      if (controller.signal.aborted) throw new ServiceProtocolError(reason)
      const input = { ...request, after, ...(watermark === undefined ? {} : { watermark }) }
      const page = await Promise.race([read(taskId, input, { signal: controller.signal }), interrupted])
      if (controller.signal.aborted) throw new ServiceProtocolError(reason)
      if (!isTranscriptPage(page, isDatabaseTranscriptPart) || page.taskId !== taskId || page.mode !== input.mode || page.after !== after ||
        page.parts.length > (request.limit ?? TRANSCRIPT_PAGE_LIMITS.parts) || watermark !== undefined && page.watermark !== watermark) throw new ServiceProtocolError('INVALID_RESULT')
      watermark = page.watermark
      options.onPage(page)
      if (controller.signal.aborted) throw new ServiceProtocolError(reason)
      if (!page.hasMore) return { cursor: page.cursor, watermark, pages }
      after = page.cursor
      // Yield between read-only requests so cancellation/UI/native callbacks run.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    throw new ServiceProtocolError('BACKPRESSURE')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** Live events may advance projection.rev; recovery uses its own captured cursor. */
export async function hydrateTranscriptProjection(read: TranscriptPageReader, taskId: string, projection: TranscriptProjection,
  options: Omit<ReadOptions, 'onPage'> & { onPage?: () => void } = {}): Promise<number> {
  const apply = (page: TranscriptPage): void => { applyPartsToProjection(projection, page.parts); options.onPage?.() }
  const snapshot = await readTranscriptWindow(read, taskId, { version: 1, mode: 'snapshot', after: 0 }, { ...options, onPage: apply })
  // Rows changed while snapshot pages were read may have moved above its
  // watermark. Reconcile from that watermark, regardless of live event cursors.
  const delta = await readTranscriptWindow(read, taskId, { version: 1, mode: 'delta', after: snapshot.watermark }, { ...options, onPage: apply })
  applyPartsToProjection(projection, [], delta.cursor)
  return delta.cursor
}

import { ServiceProtocolError, type JsonValue, type ServiceRole } from '../../shared/service-protocol'
import { decodeWireBytes, encodeWireBytes, isStreamAck, isStreamChunk, isStreamDescriptor, isStreamEnd,
  STREAM_LIMITS, STREAM_OPERATIONS, streamJson, type StreamAck, type StreamDescriptor, type StreamOperation } from '../../shared/stream-protocol'
import type { OperationSchema } from './peer'

interface Entry { descriptor: StreamDescriptor; sequence: number; busy: boolean; closed: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout>; close?: Promise<void>; raw?: Promise<void>; onClose: (signal: AbortSignal) => void | Promise<void> }
interface Reader extends Entry { consume: (bytes: Uint8Array, signal: AbortSignal) => void | Promise<void> }
export interface StreamWriter { descriptor: StreamDescriptor; write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>; end(): Promise<void>; cancel(): Promise<void> }
export interface StreamReader { cancel(): Promise<void> }

/** One acknowledged chunk per stream: a slow consumer stops its producer.
 * Domain owners alone register descriptors after their own authorization.
 * Neither a stream packet nor an engine operation can create an owner grant. */
export class ServiceStreams {
  private readonly readers = new Map<string, Reader>()
  private readonly writers = new Map<string, Entry>()
  private readonly opened = new Set<string>()
  private readonly closing = new Set<Promise<void>>()
  private next = 0
  private disconnected = false
  constructor(private readonly role: ServiceRole,
    private readonly request: (operation: StreamOperation, payload: JsonValue, signal?: AbortSignal) => Promise<JsonValue>,
    private readonly fatal: () => void) {}

  get activeCount(): number { return this.readers.size + this.writers.size }
  /** Includes raw resource teardown after cancellation; timeout never releases ownership. */
  async drain(): Promise<void> { await Promise.all([...this.closing]) }

  operationSchemas(): Record<StreamOperation, OperationSchema> {
    return {
      'engine.stream.chunk': { validatePayload: isStreamChunk, validateResult: isStreamAck, handle: (value, signal) => this.consume(value, signal, false) },
      'engine.stream.end': { validatePayload: isStreamEnd, validateResult: isStreamAck, handle: (value, signal) => this.consume(value, signal, true) },
      'engine.stream.cancel': { validatePayload: isStreamDescriptor, validateResult: isStreamDescriptor, handle: async value => {
        if (!isStreamDescriptor(value)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
        const entry = this.readers.get(value.streamId) ?? this.writers.get(value.streamId)
        if (!entry || entry.descriptor.ownerId !== value.ownerId) throw new ServiceProtocolError('INVALID_REQUEST')
        await this.release(entry)
        return streamJson(value)
      } }
    }
  }

  createWriter(ownerId: string, onClose: Entry['onClose']): StreamWriter {
    const descriptor: StreamDescriptor = { version: 1, streamId: `${this.role}:${++this.next}`, ownerId }
    if (typeof onClose !== 'function') throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.reserve(descriptor)
    const entry: Entry = { descriptor, sequence: 0, busy: false, closed: false, controller: new AbortController(), onClose }
    this.writers.set(descriptor.streamId, entry); this.renew(entry)
    const send = async (bytes?: Uint8Array, signal?: AbortSignal): Promise<void> => {
      this.available(entry)
      if (entry.busy) throw new ServiceProtocolError('BACKPRESSURE')
      if (signal?.aborted) throw new ServiceProtocolError('CANCELLED')
      const encoded = bytes === undefined ? undefined : encodeWireBytes(bytes)
      entry.busy = true; clearTimeout(entry.timer)
      const sequence = entry.sequence + 1
      const abort = (): void => entry.controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const result = await this.request(encoded ? 'engine.stream.chunk' : 'engine.stream.end',
          streamJson({ ...descriptor, sequence, ...(encoded ? { bytes: encoded } : {}) }), entry.controller.signal)
        if (!isStreamAck(result) || result.streamId !== descriptor.streamId || result.ownerId !== descriptor.ownerId || result.sequence !== sequence || result.closed !== !encoded)
          throw new ServiceProtocolError('INVALID_RESULT')
        this.available(entry); entry.sequence = sequence
        if (!encoded) await this.release(entry)
      } catch (error) {
        await this.release(entry)
        throw error
      } finally { signal?.removeEventListener('abort', abort); entry.busy = false; if (!entry.closed) this.renew(entry) }
    }
    return { descriptor: { ...descriptor }, write: send, end: () => send(), cancel: () => this.cancel(entry) }
  }

  acceptReader(descriptor: StreamDescriptor, consume: Reader['consume'], onClose: Entry['onClose']): StreamReader {
    if (!isStreamDescriptor(descriptor) || descriptor.streamId.startsWith(`${this.role}:`) || typeof consume !== 'function' || typeof onClose !== 'function')
      throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.reserve(descriptor)
    const entry: Reader = { descriptor: { ...descriptor }, sequence: 0, busy: false, closed: false, controller: new AbortController(), consume, onClose }
    this.readers.set(descriptor.streamId, entry); this.renew(entry)
    return { cancel: () => this.cancel(entry) }
  }

  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    for (const entry of [...this.readers.values(), ...this.writers.values()]) void this.release(entry).catch(() => {})
  }

  private reserve(descriptor: StreamDescriptor): void {
    if (this.disconnected) throw new ServiceProtocolError('DISCONNECTED')
    if (!isStreamDescriptor(descriptor) || this.opened.has(descriptor.streamId)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    if (this.activeCount >= STREAM_LIMITS.active || this.opened.size >= STREAM_LIMITS.openedPerEpoch) throw new ServiceProtocolError('BACKPRESSURE')
    this.opened.add(descriptor.streamId)
  }
  private available(entry: Entry): void {
    if (this.disconnected) throw new ServiceProtocolError('DISCONNECTED')
    if (entry.closed || entry.controller.signal.aborted) throw new ServiceProtocolError('CANCELLED')
  }
  private renew(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { void this.cancel(entry).catch(() => {}) }, STREAM_LIMITS.idleMs)
  }
  private async consume(value: JsonValue, signal: AbortSignal, end: boolean): Promise<JsonValue> {
    if (!(end ? isStreamEnd(value) : isStreamChunk(value))) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    const packet = value as unknown as StreamAck
    const entry = this.readers.get(packet.streamId)
    if (!entry || entry.descriptor.ownerId !== packet.ownerId) throw new ServiceProtocolError('INVALID_REQUEST')
    this.available(entry)
    if (entry.busy) throw new ServiceProtocolError('BACKPRESSURE')
    if (packet.sequence !== entry.sequence + 1) throw new ServiceProtocolError('INVALID_REQUEST')
    entry.busy = true; clearTimeout(entry.timer)
    const abort = (): void => {
      // The closer may be what unblocks the raw consumer. Waiting for consume
      // to settle before invoking it deadlocks consumers that ignore the signal.
      void this.release(entry).catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      this.available(entry)
      if (!end && isStreamChunk(value)) {
        const bytes = decodeWireBytes(value.bytes)
        entry.raw = Promise.resolve().then(() => entry.consume(bytes, entry.controller.signal))
        await entry.raw
      }
      this.available(entry); entry.sequence = packet.sequence
      if (end) await this.release(entry)
      return streamJson({ ...entry.descriptor, sequence: packet.sequence, closed: end })
    } catch (error) { await this.release(entry); throw error }
    finally { signal.removeEventListener('abort', abort); entry.busy = false; if (!entry.closed) this.renew(entry) }
  }
  private async cancel(entry: Entry): Promise<void> {
    if (entry.closed) return entry.close
    // Close local resources even when the remote pipe has gone. Never replay.
    const close = this.release(entry)
    if (!this.disconnected) {
      try { await this.request('engine.stream.cancel', streamJson(entry.descriptor)) } catch { /* Remote failure cannot prevent local teardown. */ }
    }
    await close
  }
  private release(entry: Entry): Promise<void> {
    if (entry.close) return entry.close
    entry.closed = true; clearTimeout(entry.timer); entry.controller.abort()
    const work = Promise.resolve().then(async () => {
      // The resource owner can unblock a stalled read/write on abort. Even an
      // ignored abort retains the raw consumer and its slot until it settles.
      await entry.onClose(entry.controller.signal)
      await entry.raw?.catch(() => {})
    }).then(() => {
      this.readers.delete(entry.descriptor.streamId); this.writers.delete(entry.descriptor.streamId)
    }).catch(() => { this.fatal(); throw new ServiceProtocolError('INTERNAL_ERROR') })
    entry.close = work; this.closing.add(work)
    void work.then(() => this.closing.delete(work), () => { /* Failed resource teardown retains ownership. */ })
    return work
  }
}

export function isStreamOperation(value: string): value is StreamOperation { return (STREAM_OPERATIONS as readonly string[]).includes(value) }

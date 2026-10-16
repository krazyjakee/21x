import { describe, expect, it, vi } from 'vitest'
import { ServicePeer } from './peer'
import { encodeWireBytes, STREAM_LIMITS, streamJson } from '../../shared/stream-protocol'
import { SERVICE_LIMITS, type JsonValue } from '../../shared/service-protocol'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function pair() {
  const fragments: number[] = []
  const deliver = async (peer: ServicePeer, bytes: Uint8Array): Promise<void> => {
    // Actual encoded frames pass through split UTF-8/base64/NDJSON boundaries.
    for (let index = 0; index < bytes.length; index += 113) { const slice = bytes.subarray(index, index + 113); fragments.push(slice.length); peer.receive(slice) }
  }
  const host: ServicePeer = new ServicePeer({ role: 'host', engineEpoch: 'stream_epoch', operations: {}, write: (bytes: Uint8Array) => deliver(service, bytes) })
  const service: ServicePeer = new ServicePeer({ role: 'service', engineEpoch: 'stream_epoch', operations: {}, write: (bytes: Uint8Array) => deliver(host, bytes) })
  return { host, service, fragments, async close() { host.disconnect(); service.disconnect(); await Promise.all([host.waitForHandlers(), service.waitForHandlers()]) } }
}

describe('private pipe acknowledged streams', () => {
  it('stops a producer at one chunk until its consumer acknowledges, with no queued writes', async () => {
    const p = pair(), consumed = deferred(), entered = deferred(), closed = vi.fn()
    const writer = p.service.streams.createWriter('attachment_one', closed)
    const received: Uint8Array[] = []
    p.host.streams.acceptReader(writer.descriptor, async bytes => { received.push(bytes); entered.resolve(); await consumed.promise }, () => {})
    const first = writer.write(Uint8Array.of(1, 2, 255)); await entered.promise
    await expect(writer.write(Uint8Array.of(3))).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    expect(p.service.pendingCount).toBe(1); expect(received).toHaveLength(1)
    consumed.resolve(); await first; await writer.write(Uint8Array.of(3)); await writer.end()
    expect(received.map(bytes => [...bytes])).toEqual([[1, 2, 255], [3]])
    expect(closed).toHaveBeenCalledOnce(); expect(p.host.streams.activeCount).toBe(0); expect(p.service.streams.activeCount).toBe(0)
    await p.close()
  })
  it('moves parallel binary streams through fragmented frames with bounded slots and ordered bytes', async () => {
    const p = pair(), bytesPerStream = 1024 * 1024, counts: number[] = [], sums: number[] = []
    const writers = Array.from({ length: STREAM_LIMITS.active }, (_, index) => {
      counts[index] = 0; sums[index] = 0
      const writer = p.service.streams.createWriter(`terminal_${index}`, () => {})
      p.host.streams.acceptReader(writer.descriptor, bytes => { counts[index] += bytes.length; for (const byte of bytes) sums[index] += byte }, () => {})
      return writer
    })
    expect(() => p.service.streams.createWriter('overflow', () => {})).toThrow('Transport capacity')
    await Promise.all(writers.map(async (writer, index) => {
      const chunk = new Uint8Array(STREAM_LIMITS.chunkBytes).fill(index)
      for (let offset = 0; offset < bytesPerStream; offset += chunk.length) {
        await writer.write(chunk)
        expect(p.service.queuedByteCount).toBeLessThanOrEqual(SERVICE_LIMITS.queuedBytes)
        expect(p.service.pendingCount).toBeLessThanOrEqual(STREAM_LIMITS.active)
      }
      await writer.end()
    }))
    expect(counts).toEqual(writers.map(() => bytesPerStream)); expect(sums).toEqual(writers.map((_, index) => index * bytesPerStream))
    expect(p.fragments.some(size => size === 113)).toBe(true); expect(p.service.pendingCount).toBe(0)
    await p.close()
  })
  it('denies unknown/replayed owners and out-of-order chunks without consuming them', async () => {
    const p = pair(), consume = vi.fn(), writer = p.service.streams.createWriter('owner', () => {})
    p.host.streams.acceptReader(writer.descriptor, consume, () => {})
    const packet = { ...writer.descriptor, sequence: 1, bytes: encodeWireBytes(Uint8Array.of(1)) }
    await expect(p.service.request('engine.stream.chunk', streamJson({ ...packet, ownerId: 'other' }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(p.service.request('engine.stream.chunk', streamJson({ ...packet, sequence: 2 }))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await writer.write(Uint8Array.of(1))
    await expect(p.service.request('engine.stream.chunk', streamJson(packet))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await writer.end(); expect(consume).toHaveBeenCalledOnce()
    expect(() => p.host.streams.acceptReader(writer.descriptor, consume, () => {})).toThrow('Invalid operation arguments')
    await expect(p.service.request('engine.stream.chunk', streamJson(packet))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await p.close()
  })
  it('unmount cancellation stops both owners but retains an ignored raw consumer until it settles', async () => {
    const p = pair(), raw = deferred(), entered = deferred(), senderClosed = deferred(), senderClose = vi.fn(() => senderClosed.resolve()), readerClose = vi.fn()
    const writer = p.service.streams.createWriter('terminal', senderClose)
    const reader = p.host.streams.acceptReader(writer.descriptor, async (_bytes, signal) => { entered.resolve(); await raw.promise; expect(signal.aborted).toBe(true) }, readerClose)
    const sending = writer.write(Uint8Array.of(1)); const sendingResult = expect(sending).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise
    const cancel = reader.cancel(); await senderClosed.promise; await sendingResult
    expect(p.host.streams.activeCount).toBe(1)
    p.host.disconnect(); p.service.disconnect()
    await expect(p.host.waitForHandlers(10)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(p.host.streams.activeCount).toBe(1)
    raw.resolve(); await cancel; await p.close()
    expect(senderClose).toHaveBeenCalledOnce(); expect(readerClose).toHaveBeenCalledOnce(); expect(p.host.streams.activeCount).toBe(0)
  })
  it('request cancellation calls the closer before waiting for a consumer that ignores abort', async () => {
    const p = pair(), raw = deferred(), entered = deferred(), closed = deferred()
    const writer = p.service.streams.createWriter('blocked_resource', () => {})
    const closer = vi.fn(() => { closed.resolve(); raw.resolve() })
    p.host.streams.acceptReader(writer.descriptor, async () => { entered.resolve(); await raw.promise }, closer)
    const controller = new AbortController()
    const result = expect(writer.write(Uint8Array.of(1), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    await entered.promise
    controller.abort()
    await closed.promise
    await result
    await p.close()
    expect(closer).toHaveBeenCalledOnce()
    expect(p.host.streams.activeCount).toBe(0)
    expect(p.service.streams.activeCount).toBe(0)
  })
  it('failed stream cleanup disconnects and retains its slot and drain failure', async () => {
    const p = pair(), closer = vi.fn(() => { throw new Error('private cleanup detail') })
    const writer = p.service.streams.createWriter('cleanup_failure', () => {})
    const reader = p.host.streams.acceptReader(writer.descriptor, () => {}, closer)
    await expect(reader.cancel()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(closer).toHaveBeenCalledOnce()
    expect(p.host.streams.activeCount).toBe(1)
    await expect(p.host.waitForHandlers()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(p.host.request('engine.stream.cancel', streamJson(writer.descriptor))).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    await expect(reader.cancel()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    p.service.disconnect()
    await p.service.waitForHandlers()
  })
  it('disconnects a saturated publisher so durable owners must rehydrate on a new epoch', async () => {
    const blocked = deferred(), disconnect = vi.fn()
    const peer = new ServicePeer({ role: 'service', engineEpoch: 'epoch', operations: {}, eventSchemas: { changed: value => typeof value === 'string' }, write: () => blocked.promise, onDisconnect: disconnect })
    const payload = 'x'.repeat(64 * 1024)
    let overflow = false
    for (let index = 0; index < 128; index++) {
      try { peer.emit('changed', payload, index + 1) } catch (error) { expect(error).toMatchObject({ code: 'BACKPRESSURE' }); overflow = true; break }
    }
    expect(overflow).toBe(true); expect(disconnect).toHaveBeenCalledOnce(); expect(peer.queuedByteCount).toBe(0)
    await expect(peer.request('missing', {})).rejects.toMatchObject({ code: 'BACKPRESSURE' })
    blocked.resolve(); await peer.waitForHandlers()
  })
  it('has no public open operation or caller-controlled resource registration', async () => {
    const p = pair()
    await expect(p.host.request('engine.stream.open', {})).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' })
    await expect(p.host.request('engine.stream.chunk', { version: 1, streamId: 'host:1', ownerId: 'invented', sequence: 1, bytes: encodeWireBytes(Uint8Array.of(1)) } as unknown as JsonValue)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(p.service.streams.activeCount).toBe(0); await p.close()
  })
})

import { describe, expect, it } from 'vitest'
import { decodeWireBytes, encodeWireBytes, isStreamChunk, isWireBytes, STREAM_LIMITS } from './stream-protocol'

describe('explicit versioned byte packets', () => {
  it('round trips every byte without Buffer JSON coercion', () => {
    const bytes = Uint8Array.from({ length: STREAM_LIMITS.chunkBytes }, (_, index) => index % 256)
    const wire = JSON.parse(JSON.stringify(encodeWireBytes(bytes)))
    expect(decodeWireBytes(wire)).toEqual(bytes)
    expect(encodeWireBytes(bytes.subarray(0, 1)).byteLength).toBe(1)
  })
  it('rejects oversized, empty, noncanonical, miscounted and unknown byte representations', () => {
    const wire = encodeWireBytes(Uint8Array.of(255))
    for (const value of [{ ...wire, data: '/x==' }, { ...wire, byteLength: 2 }, { ...wire, version: 2 }, { ...wire, encoding: 'hex' },
      { ...wire, extra: true }, { type: 'Buffer', data: [255] }, { ...wire, byteLength: 0, data: '' }, { ...wire, data: '/w==\n' }]) expect(isWireBytes(value)).toBe(false)
    expect(() => encodeWireBytes(new Uint8Array(STREAM_LIMITS.chunkBytes + 1))).toThrow('Invalid operation arguments')
    expect(() => decodeWireBytes({ ...wire, data: '/x==' })).toThrow('Invalid operation arguments')
  })
  it('requires an exact owner, directional ID and progressive chunk sequence', () => {
    const packet = { version: 1, streamId: 'service:1', ownerId: 'task_1', sequence: 1, bytes: encodeWireBytes(Uint8Array.of(1)) }
    expect(isStreamChunk(packet)).toBe(true)
    for (const patch of [{ streamId: 'service:01' }, { ownerId: '../file' }, { sequence: 0 }, { sequence: 1.5 }, { taskId: 'spoofed' }]) expect(isStreamChunk({ ...packet, ...patch })).toBe(false)
  })
})

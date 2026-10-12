import { SERVICE_LIMITS, ServiceProtocolError, validateServiceFrame, type ServiceFrame } from '../../shared/service-protocol'

const encoder = new TextEncoder()

export function encodeServiceFrame(frame: ServiceFrame): Uint8Array {
  try {
    validateServiceFrame(frame)
    const bytes = encoder.encode(JSON.stringify(frame))
    if (bytes.length > SERVICE_LIMITS.frameBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
    const line = new Uint8Array(bytes.length + 1)
    line.set(bytes)
    line[bytes.length] = 10
    return line
  } catch (error) {
    throw error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INVALID_FRAME')
  }
}

/** Bounded incremental byte framing. UTF-8 is decoded only after the full line arrives. */
export class ServiceFrameDecoder {
  private buffer = new Uint8Array(1024)
  private length = 0
  private failed = false
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

  push(chunk: Uint8Array, onFrame: (frame: ServiceFrame) => void): void {
    if (this.failed) throw new ServiceProtocolError('DISCONNECTED')
    try {
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline === -1 ? chunk.length : newline
        const size = this.length + end - start
        if (size > SERVICE_LIMITS.frameBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
        if (size > this.buffer.length) {
          const expanded = new Uint8Array(Math.min(SERVICE_LIMITS.frameBytes, Math.max(size, this.buffer.length * 2)))
          expanded.set(this.buffer.subarray(0, this.length))
          this.buffer = expanded
        }
        this.buffer.set(chunk.subarray(start, end), this.length)
        this.length = size
        if (newline === -1) return
        if (this.length === 0) throw new ServiceProtocolError('INVALID_FRAME')
        let value: unknown
        try { value = JSON.parse(this.decoder.decode(this.buffer.subarray(0, this.length))) }
        catch { throw new ServiceProtocolError('INVALID_FRAME') }
        this.length = 0
        onFrame(validateServiceFrame(value))
        start = newline + 1
      }
    } catch (error) {
      this.failed = true
      this.length = 0
      throw error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INVALID_FRAME')
    }
  }

  finish(): void {
    if (this.length !== 0) {
      this.failed = true
      this.length = 0
      throw new ServiceProtocolError('INVALID_FRAME')
    }
  }
}

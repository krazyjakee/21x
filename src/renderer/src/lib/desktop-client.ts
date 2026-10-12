import { DESKTOP_OPERATION_MANIFEST, type DesktopCommandMap, type DesktopEventMap } from '@shared/desktop-operations'
import { isOptionalResult } from '@shared/host-services'
import {
  SERVICE_LIMITS, ServiceProtocolError, hasExactKeys, isJsonValue, isRecord,
  validateServiceFrame, type JsonValue, type ServiceErrorCode, type ServiceEvent
} from '@shared/service-protocol'

export interface DesktopCommandCodec<K extends keyof DesktopCommandMap> {
  encodeArguments: (args: DesktopCommandMap[K]['apiArguments']) => JsonValue
  decodeResult: (value: JsonValue | undefined) => DesktopCommandMap[K]['result']
  validateResult: (value: unknown) => boolean
}
export interface DesktopEventCodec<K extends keyof DesktopEventMap> {
  decodePayload: (value: JsonValue) => DesktopEventMap[K]
  validatePayload: (value: unknown) => boolean
}
export type DesktopCommandCodecs = { [K in keyof DesktopCommandMap]?: DesktopCommandCodec<K> }
export type DesktopEventCodecs = { [K in keyof DesktopEventMap]?: DesktopEventCodec<K> }

/** The native adapter establishes identity/authority and tags responses with its engine epoch. */
export interface DesktopTransport {
  invoke(operation: string, payload: JsonValue, options: { engineEpoch: string; signal: AbortSignal }): Promise<unknown>
  listen(receive: (event: unknown) => void): Promise<() => void>
}
export interface DesktopClientState {
  status: 'disconnected' | 'connecting' | 'ready'
  engineEpoch: string | null
  /** A new ready connection requires snapshot/delta rehydration by state owners. */
  reason?: ServiceErrorCode
}

/** Renderer lifecycle only. Codecs and native/service authorization remain separate requirements. */
export class DesktopClient {
  private state: DesktopClientState = { status: 'disconnected', engineEpoch: null }
  private generation = 0
  private disposed = false
  private unlisten: (() => void) | undefined
  private readonly pending = new Set<(code: ServiceErrorCode) => void>()
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  private lastSequence: number | undefined

  constructor(private readonly options: {
    transport: DesktopTransport
    commands: DesktopCommandCodecs
    events: DesktopEventCodecs
    onState?: (state: Readonly<DesktopClientState>) => void
  }) {}

  get connection(): Readonly<DesktopClientState> { return { ...this.state } }

  /** Call only with the epoch returned by the trusted host bootstrap. No requests are replayed. */
  async connect(engineEpoch: string): Promise<void> {
    if (this.disposed) throw new ServiceProtocolError('DISCONNECTED')
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(engineEpoch)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.disconnect('STALE_EPOCH')
    const generation = this.generation
    this.setState({ status: 'connecting', engineEpoch })
    const buffered: ServiceEvent[] = []
    let bufferedBytes = 0
    let release: ((code: ServiceErrorCode) => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (code: ServiceErrorCode): void => release?.(code)
    const interrupted = new Promise<never>((_resolve, reject) => {
      release = code => reject(new ServiceProtocolError(code))
      this.pending.add(fail)
      timer = setTimeout(() => fail('TIMEOUT'), SERVICE_LIMITS.requestTimeoutMs)
    })
    const listening = Promise.resolve().then(() => this.options.transport.listen(value => {
      if (generation !== this.generation || this.disposed) return
      try {
        const event = validateServiceFrame(value)
        if (event.kind !== 'event') throw new ServiceProtocolError('INVALID_FRAME')
        if (event.engineEpoch !== engineEpoch) throw new ServiceProtocolError('STALE_EPOCH')
        const size = wireSize(event)
        if (this.state.status === 'connecting') {
          if (buffered.length >= SERVICE_LIMITS.queuedFrames || bufferedBytes + size > SERVICE_LIMITS.queuedBytes) {
            throw new ServiceProtocolError('BACKPRESSURE')
          }
          buffered.push(event)
          bufferedBytes += size
        } else this.deliver(event)
      } catch (error) { this.disconnect(protocolCode(error, 'INVALID_FRAME')) }
    })).then(unlisten => {
      if (typeof unlisten !== 'function') throw new ServiceProtocolError('INVALID_RESULT')
      if (generation !== this.generation || this.disposed) { safely(unlisten); throw new ServiceProtocolError('DISCONNECTED') }
      return unlisten
    })
    try {
      this.unlisten = await Promise.race([listening, interrupted])
      if (generation !== this.generation) throw new ServiceProtocolError('DISCONNECTED')
      this.setState({ status: 'ready', engineEpoch })
      for (const event of buffered) {
        if (generation !== this.generation) break
        this.deliver(event)
      }
      if (generation !== this.generation) throw new ServiceProtocolError('DISCONNECTED')
    } catch (error) {
      const code = protocolCode(error, 'DISCONNECTED')
      if (generation === this.generation) this.disconnect(code)
      throw new ServiceProtocolError(code)
    } finally {
      clearTimeout(timer)
      this.pending.delete(fail)
    }
  }

  async invoke<K extends keyof DesktopCommandMap>(operation: K, args: DesktopCommandMap[K]['apiArguments'],
    options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DesktopCommandMap[K]['result']> {
    this.requireDescriptor('command', operation)
    const codec = this.options.commands[operation] as DesktopCommandCodec<K> | undefined
    if (!codec) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    if (this.disposed || this.state.status !== 'ready' || !this.state.engineEpoch) throw new ServiceProtocolError('DISCONNECTED')
    if (this.pending.size >= SERVICE_LIMITS.pendingRequests) throw new ServiceProtocolError('BACKPRESSURE')
    if (options.signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    const timeoutMs = options.timeoutMs ?? SERVICE_LIMITS.requestTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SERVICE_LIMITS.requestTimeoutMs) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    let payload: JsonValue
    try {
      payload = codec.encodeArguments(args)
      if (!isJsonValue(payload)) throw new Error()
      wireSize(payload)
    } catch (error) { throw new ServiceProtocolError(protocolCode(error, 'INVALID_ARGUMENTS')) }
    const generation = this.generation
    const engineEpoch = this.state.engineEpoch
    const controller = new AbortController()
    let fail: (code: ServiceErrorCode) => void = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      fail = code => { controller.abort(); reject(new ServiceProtocolError(code)) }
    })
    const abort = (): void => fail('CANCELLED')
    const timer = setTimeout(() => fail('TIMEOUT'), timeoutMs)
    this.pending.add(fail)
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const raw = await Promise.race([
        this.options.transport.invoke(operation, payload, { engineEpoch, signal: controller.signal }), interrupted
      ])
      if (generation !== this.generation || this.state.status !== 'ready') throw new ServiceProtocolError('STALE_EPOCH')
      if (!isRecord(raw) || !hasExactKeys(raw, ['engineEpoch', 'result'])) throw new ServiceProtocolError('INVALID_RESULT')
      if (raw.engineEpoch !== engineEpoch) { this.disconnect('STALE_EPOCH'); throw new ServiceProtocolError('STALE_EPOCH') }
      if (!isOptionalResult(raw.result)) throw new ServiceProtocolError('INVALID_RESULT')
      wireSize(raw)
      try {
        const result = codec.decodeResult(raw.result.defined ? raw.result.value : undefined)
        if (!codec.validateResult(result)) throw new Error()
        return result
      } catch { throw new ServiceProtocolError('INVALID_RESULT') }
    } catch (error) { throw new ServiceProtocolError(protocolCode(error, 'INTERNAL_ERROR')) }
    finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      this.pending.delete(fail)
    }
  }

  subscribe<K extends keyof DesktopEventMap>(operation: K, listener: (payload: DesktopEventMap[K]) => void): () => void {
    this.requireDescriptor('event', operation)
    if (this.disposed) throw new ServiceProtocolError('DISCONNECTED')
    if (!this.options.events[operation] || typeof listener !== 'function') throw new ServiceProtocolError('UNKNOWN_OPERATION')
    let listeners = this.listeners.get(operation)
    if (!listeners) { listeners = new Set(); this.listeners.set(operation, listeners) }
    // Separate registrations remain independent, even when callbacks are equal.
    const registered = (payload: unknown): void => listener(payload as DesktopEventMap[K])
    listeners.add(registered)
    return () => {
      if (!listeners.delete(registered)) return
      if (listeners.size === 0 && this.listeners.get(operation) === listeners) this.listeners.delete(operation)
    }
  }

  disconnect(reason: ServiceErrorCode = 'DISCONNECTED'): void {
    this.generation++
    for (const fail of [...this.pending]) fail(reason)
    this.pending.clear()
    if (this.unlisten) safely(this.unlisten)
    this.unlisten = undefined
    this.lastSequence = undefined
    this.setState({ status: 'disconnected', engineEpoch: null, reason })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnect()
    this.listeners.clear()
  }

  private deliver(event: ServiceEvent): void {
    this.requireDescriptor('event', event.operation)
    const codec = this.options.events[event.operation as keyof DesktopEventMap]
    if (!codec) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    if (event.sequence === undefined) throw new ServiceProtocolError('INVALID_FRAME')
    if (this.lastSequence !== undefined) {
      if (event.sequence <= this.lastSequence) return
      if (event.sequence !== this.lastSequence + 1) throw new ServiceProtocolError('STALE_EPOCH')
    }
    const payload = codec.decodePayload(event.payload)
    if (!codec.validatePayload(payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.lastSequence = event.sequence
    for (const listener of [...this.listeners.get(event.operation) ?? []]) safely(() => listener(payload))
  }

  private setState(state: DesktopClientState): void {
    this.state = state
    safely(() => this.options.onState?.({ ...state }))
  }

  private requireDescriptor(kind: 'command' | 'event', operation: string): void {
    const key = `${kind}/${operation}` as keyof typeof DESKTOP_OPERATION_MANIFEST
    if (!Object.hasOwn(DESKTOP_OPERATION_MANIFEST, key) || DESKTOP_OPERATION_MANIFEST[key].disposition !== 'retained') {
      throw new ServiceProtocolError('UNKNOWN_OPERATION')
    }
  }
}

function wireSize(value: unknown): number {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (size > SERVICE_LIMITS.frameBytes) throw new ServiceProtocolError('FRAME_TOO_LARGE')
  return size
}
function protocolCode(error: unknown, fallback: ServiceErrorCode): ServiceErrorCode {
  return error instanceof ServiceProtocolError ? error.code : fallback
}
function safely(callback: () => void): void { try { callback() } catch { /* Consumer errors never enter native logs. */ } }

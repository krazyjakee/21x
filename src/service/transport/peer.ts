import {
  serviceOperationTimeoutMs, SERVICE_LIMITS, SERVICE_PROTOCOL_VERSION, ServiceProtocolError, isBootstrapOperation,
  isBootstrapResult, isRecord, isRequestId, hasExactKeys, isJsonValue, serviceError,
  type JsonValue, type RequestId, type ServiceErrorCode, type ServiceEvent,
  type ServiceFrame, type ServiceRequest, type ServiceResponse, type ServiceRole
} from '../../shared/service-protocol'
import { ServiceFrameDecoder, encodeServiceFrame } from './framing'
import { ServiceStreams } from './streams'
import { STREAM_OPERATIONS } from '../../shared/stream-protocol'

export interface OperationSchema {
  validatePayload: (value: unknown) => boolean
  validateResult: (value: unknown) => boolean
  handle?: (payload: JsonValue, signal: AbortSignal) => JsonValue | Promise<JsonValue>
}
export interface ServicePeerOptions {
  role: ServiceRole
  /** Service generates an epoch before accepting bootstrap; host starts with null. */
  engineEpoch: string | null
  /** Resolves only once bytes have drained. Adapter must reject on closed pipes. */
  write: (bytes: Uint8Array) => Promise<void>
  operations: Readonly<Record<string, OperationSchema>>
  eventSchemas?: Readonly<Record<string, (value: unknown) => boolean>>
  onEvent?: (event: ServiceEvent) => void
  /** Called once with a redacted error. Adapter should close both pipes here. */
  onDisconnect?: (error: ServiceProtocolError) => void
}
interface PendingRequest {
  operation: string
  schema: OperationSchema
  resolve: (result: JsonValue) => void
  reject: (error: ServiceProtocolError) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
}
interface ActiveRequest {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  replied: boolean
}
interface QueuedFrame { bytes: Uint8Array; requestId?: RequestId }

function boundedDrain(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

/** One peer per engine lifetime. Failed peers are terminal and never replay requests. */
export class ServicePeer {
  readonly streams: ServiceStreams
  private readonly operations: Readonly<Record<string, OperationSchema>>
  private readonly decoder = new ServiceFrameDecoder()
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly active = new Map<RequestId, ActiveRequest>()
  private readonly queue: QueuedFrame[] = []
  private queuedBytes = 0
  private writing = false
  private stopWrite: (() => void) | null = null
  private partialFrameTimer: ReturnType<typeof setTimeout> | undefined
  private nextId = 0n
  private lastRemoteId = 0n
  private failure: ServiceProtocolError | null = null
  private epoch: string | null
  private readonly drainWaiters = new Set<{ resolve: () => void; reject: (error: ServiceProtocolError) => void }>()
  private readonly handlerWaiters = new Set<() => void>()

  constructor(private readonly options: ServicePeerOptions) {
    this.epoch = options.engineEpoch
    if ((options.role === 'service' && this.epoch === null) ||
      (this.epoch !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(this.epoch))) {
      throw new ServiceProtocolError('INVALID_ARGUMENTS')
    }
    if (STREAM_OPERATIONS.some(operation => Object.hasOwn(options.operations, operation))) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    this.streams = new ServiceStreams(options.role, (operation, payload, signal) => this.request(operation, payload, { signal }), () => this.disconnect('INTERNAL_ERROR'))
    this.operations = { ...options.operations, ...this.streams.operationSchemas() }
  }

  get engineEpoch(): string | null { return this.epoch }
  get pendingCount(): number { return this.pending.size }
  get activeCount(): number { return this.active.size }
  get queuedByteCount(): number { return this.queuedBytes }
  get queuedFrameCount(): number { return this.queue.length }

  /** Call after returning the shutdown handler result, so its response is queued. */
  drain(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (!this.writing && this.queue.length === 0 && this.active.size === 0) return Promise.resolve()
    return new Promise((resolve, reject) => this.drainWaiters.add({ resolve, reject }))
  }

  /** Terminal cleanup still owns raw handlers after replies/cancellation stop. */
  waitForHandlers(timeoutMs = 2000): Promise<void> {
    if (!this.failure) return Promise.reject(new ServiceProtocolError('INVALID_REQUEST'))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) return Promise.reject(new ServiceProtocolError('INVALID_ARGUMENTS'))
    const streams = this.streams.drain()
    if (!this.active.size) return boundedDrain(streams, timeoutMs)
    return boundedDrain(Promise.all([streams, new Promise<void>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); this.handlerWaiters.delete(done); resolve() }
      const timer = setTimeout(() => {
        this.handlerWaiters.delete(done)
        // Timeout ends the wait, never raw ownership. Caller must retain its
        // database/provider/lock until process exit if this fails.
        reject(new ServiceProtocolError('TIMEOUT'))
      }, timeoutMs)
      this.handlerWaiters.add(done)
    })]).then(() => {}), timeoutMs)
  }

  private settleDrain(): void {
    if (this.writing || this.queue.length || this.active.size) return
    for (const waiter of this.drainWaiters) waiter.resolve()
    this.drainWaiters.clear()
  }

  receive(bytes: Uint8Array): void {
    if (this.failure) return
    try {
      this.decoder.push(bytes, frame => {
        // A completed frame retires its deadline. Subsequent partial bytes in
        // this same read belong to a new frame with their own bounded lifetime.
        clearTimeout(this.partialFrameTimer); this.partialFrameTimer = undefined
        if (!this.failure) this.accept(frame)
      })
      if (!this.failure && this.decoder.pendingByteCount > 0 && !this.partialFrameTimer) {
        // Do not renew on each fragment: a slow sender cannot keep an
        // incomplete frame (or its epoch/resources) alive indefinitely.
        this.partialFrameTimer = setTimeout(() => this.disconnect('TIMEOUT'), SERVICE_LIMITS.requestTimeoutMs)
      }
    } catch (error) { this.disconnect(error instanceof ServiceProtocolError ? error.code : 'INVALID_FRAME') }
  }

  end(): void {
    try { this.decoder.finish() }
    catch { this.disconnect('INVALID_FRAME'); return }
    this.disconnect()
  }

  disconnect(code: ServiceErrorCode = 'DISCONNECTED'): void {
    if (this.failure) return
    const error = new ServiceProtocolError(code)
    this.failure = error
    clearTimeout(this.partialFrameTimer); this.partialFrameTimer = undefined
    this.streams.disconnect()
    for (const waiter of this.drainWaiters) waiter.reject(error)
    this.drainWaiters.clear()
    this.stopWrite?.()
    for (const [id, pending] of this.pending) {
      this.releasePending(id, pending)
      pending.reject(error)
    }
    for (const request of this.active.values()) {
      clearTimeout(request.timer)
      request.controller.abort()
    }
    // Abort is advisory. Keep each raw handler owned until its finally runs.
    this.queue.length = 0
    this.queuedBytes = 0
    try { this.options.onDisconnect?.(error) } catch { /* Never reflect adapter diagnostics. */ }
  }

  request(operation: string, payload: JsonValue, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<JsonValue> {
    if (this.failure) return Promise.reject(this.failure)
    const schema = Object.hasOwn(this.operations, operation) ? this.operations[operation] : undefined
    if (!schema) return Promise.reject(new ServiceProtocolError('UNKNOWN_OPERATION'))
    try { if (!schema.validatePayload(payload)) return Promise.reject(new ServiceProtocolError('INVALID_ARGUMENTS')) }
    catch { return Promise.reject(new ServiceProtocolError('INVALID_ARGUMENTS')) }
    if (this.epoch === null && !isBootstrapOperation(operation)) return Promise.reject(new ServiceProtocolError('STALE_EPOCH'))
    // Bootstrap is exclusive: no competing responses may change the host's epoch.
    if (this.pending.size >= SERVICE_LIMITS.pendingRequests || (this.epoch === null && this.pending.size > 0)) {
      return Promise.reject(new ServiceProtocolError('BACKPRESSURE'))
    }
    if (options.signal?.aborted) return Promise.reject(new ServiceProtocolError('CANCELLED'))
    const timeoutMs = options.timeoutMs ?? serviceOperationTimeoutMs(operation)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > serviceOperationTimeoutMs(operation)) {
      return Promise.reject(new ServiceProtocolError('INVALID_ARGUMENTS'))
    }
    const requestId: RequestId = `${this.options.role}:${++this.nextId}`
    return new Promise((resolve, reject) => {
      const cancel = (code: 'TIMEOUT' | 'CANCELLED'): void => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        this.releasePending(requestId, pending)
        reject(new ServiceProtocolError(code))
        // Cancellation is advisory. A mutation already running may have committed.
        if (this.epoch !== null) {
          try { this.enqueue(this.eventFrame('engine.cancel', { requestId })) }
          catch { this.disconnect('BACKPRESSURE') }
        }
      }
      const abort = (): void => cancel('CANCELLED')
      const pending: PendingRequest = {
        operation, schema, resolve, reject,
        timer: setTimeout(() => cancel('TIMEOUT'), timeoutMs),
        removeAbort: () => options.signal?.removeEventListener('abort', abort)
      }
      this.pending.set(requestId, pending)
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.enqueue({ kind: 'request', protocolVersion: SERVICE_PROTOCOL_VERSION,
          engineEpoch: this.epoch ?? '', requestId, operation, payload }, requestId)
      } catch (error) {
        this.releasePending(requestId, pending)
        reject(error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INVALID_ARGUMENTS'))
      }
    })
  }

  emit(operation: string, payload: JsonValue, sequence?: number): void {
    if (this.failure) throw this.failure
    const validate = this.options.eventSchemas && Object.hasOwn(this.options.eventSchemas, operation)
      ? this.options.eventSchemas[operation] : undefined
    if (!validate || operation === 'engine.cancel') throw new ServiceProtocolError('UNKNOWN_OPERATION')
    try { if (!validate(payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS') }
    catch { throw new ServiceProtocolError('INVALID_ARGUMENTS') }
    try { this.enqueue({ ...this.eventFrame(operation, payload), ...(sequence === undefined ? {} : { sequence }) }) }
    catch (error) {
      // Dropping an owner event would leave consumers silently stale. A saturated
      // publisher is terminal; the next epoch must rehydrate durable state.
      if (error instanceof ServiceProtocolError && error.code === 'BACKPRESSURE') this.disconnect('BACKPRESSURE')
      throw error
    }
  }

  private eventFrame(operation: string, payload: JsonValue): ServiceEvent {
    if (this.epoch === null) throw new ServiceProtocolError('STALE_EPOCH')
    return { kind: 'event', protocolVersion: SERVICE_PROTOCOL_VERSION, engineEpoch: this.epoch, operation, payload }
  }

  private releasePending(id: RequestId, request: PendingRequest): void {
    this.pending.delete(id)
    clearTimeout(request.timer)
    request.removeAbort()
  }

  private accept(frame: ServiceFrame): void {
    if (frame.kind === 'response') { this.acceptResponse(frame); return }
    if (frame.kind === 'request' && frame.requestId.startsWith(`${this.options.role}:`)) {
      throw new ServiceProtocolError('INVALID_REQUEST')
    }
    const bootstrap = frame.kind === 'request' && isBootstrapOperation(frame.operation) &&
      this.options.role === 'service' && frame.engineEpoch === ''
    if (!bootstrap && (this.epoch === null || frame.engineEpoch !== this.epoch)) {
      // Old engine traffic is ignored, never delivered to domain handlers.
      if (frame.kind === 'request' && this.epoch !== null) this.replyError(frame.requestId, 'STALE_EPOCH')
      return
    }
    if (frame.kind === 'event') {
      if (frame.operation === 'engine.cancel') {
        if (!isRecord(frame.payload) || !hasExactKeys(frame.payload, ['requestId']) ||
          !isRequestId(frame.payload.requestId) || frame.payload.requestId.startsWith(`${this.options.role}:`)) {
          throw new ServiceProtocolError('INVALID_ARGUMENTS')
        }
        const request = this.active.get(frame.payload.requestId)
        request?.controller.abort()
        if (request && !request.replied) {
          request.replied = true
          this.replyError(frame.payload.requestId, 'CANCELLED')
        }
        return
      }
      const validate = this.options.eventSchemas && Object.hasOwn(this.options.eventSchemas, frame.operation)
        ? this.options.eventSchemas[frame.operation] : undefined
      if (!validate) throw new ServiceProtocolError('UNKNOWN_OPERATION')
      try { if (!validate(frame.payload)) throw new ServiceProtocolError('INVALID_ARGUMENTS') }
      catch { throw new ServiceProtocolError('INVALID_ARGUMENTS') }
      try { this.options.onEvent?.(frame) } catch { throw new ServiceProtocolError('INTERNAL_ERROR') }
      return
    }
    const counter = BigInt(frame.requestId.split(':')[1])
    if (counter <= this.lastRemoteId) { this.replyError(frame.requestId, 'INVALID_REQUEST'); return }
    this.lastRemoteId = counter
    const schema = Object.hasOwn(this.operations, frame.operation) ? this.operations[frame.operation] : undefined
    if (!schema?.handle) { this.replyError(frame.requestId, 'UNKNOWN_OPERATION'); return }
    try { if (!schema.validatePayload(frame.payload)) { this.replyError(frame.requestId, 'INVALID_ARGUMENTS'); return } }
    catch { this.replyError(frame.requestId, 'INVALID_ARGUMENTS'); return }
    if (this.active.size >= SERVICE_LIMITS.activeRequests) { this.replyError(frame.requestId, 'BACKPRESSURE'); return }
    this.startHandler(frame, schema)
  }

  private acceptResponse(frame: ServiceResponse): void {
    if (!frame.requestId.startsWith(`${this.options.role}:`)) throw new ServiceProtocolError('INVALID_REQUEST')
    const pending = this.pending.get(frame.requestId)
    if (!pending) return // Cancellation, timeout and duplicate responses never revive a call.
    const bootstrap = this.epoch === null && isBootstrapOperation(pending.operation)
    if (!bootstrap && frame.engineEpoch !== this.epoch) return
    if (bootstrap && (!frame.engineEpoch || !('result' in frame) ||
      !isBootstrapResult(frame.result) || frame.result.engineEpoch !== frame.engineEpoch)) {
      this.releasePending(frame.requestId, pending)
      pending.reject(new ServiceProtocolError(frame.error?.code ?? 'INVALID_RESULT'))
      return
    }
    if ('error' in frame && frame.error) {
      this.releasePending(frame.requestId, pending)
      pending.reject(new ServiceProtocolError(frame.error.code))
      return
    }
    let valid = false
    try { valid = pending.schema.validateResult(frame.result) } catch { /* Redacted below. */ }
    this.releasePending(frame.requestId, pending)
    if (!valid) { pending.reject(new ServiceProtocolError('INVALID_RESULT')); return }
    if (bootstrap) this.epoch = frame.engineEpoch
    pending.resolve(frame.result as JsonValue)
  }

  private startHandler(frame: ServiceRequest, schema: OperationSchema): void {
    const active: ActiveRequest = {
      controller: new AbortController(), replied: false,
      timer: setTimeout(() => {
        active.controller.abort()
        if (!active.replied && !this.failure) {
          active.replied = true
          try { this.replyError(frame.requestId, 'TIMEOUT') } catch { this.disconnect('BACKPRESSURE') }
        }
      }, serviceOperationTimeoutMs(frame.operation))
    }
    this.active.set(frame.requestId, active)
    void Promise.resolve().then(() => {
      if (this.failure || active.controller.signal.aborted) throw new ServiceProtocolError('CANCELLED')
      return schema.handle!(frame.payload, active.controller.signal)
    }).then(result => {
      if (this.failure || active.replied) return
      let valid = false
      try { valid = isJsonValue(result) && schema.validateResult(result) } catch { /* Redacted below. */ }
      if (!valid) throw new ServiceProtocolError('INVALID_RESULT')
      this.enqueue({ kind: 'response', protocolVersion: SERVICE_PROTOCOL_VERSION,
        engineEpoch: this.epoch!, requestId: frame.requestId, result })
      active.replied = true
    }).catch(error => {
      if (this.failure || active.replied) return
      active.replied = true
      try { this.replyError(frame.requestId, error instanceof ServiceProtocolError ? error.code : 'INTERNAL_ERROR') }
      catch { this.disconnect('BACKPRESSURE') }
    }).finally(() => {
      clearTimeout(active.timer)
      this.active.delete(frame.requestId)
      if (!this.active.size) for (const done of [...this.handlerWaiters]) done()
      this.settleDrain()
    })
    // The active slot remains occupied until the handler settles, even after abort.
  }

  private replyError(requestId: RequestId, code: ServiceErrorCode): void {
    this.enqueue({ kind: 'response', protocolVersion: SERVICE_PROTOCOL_VERSION,
      engineEpoch: this.epoch!, requestId, error: serviceError(code) })
  }

  private enqueue(frame: ServiceFrame, requestId?: RequestId): void {
    if (this.failure) throw this.failure
    const bytes = encodeServiceFrame(frame)
    if (this.queue.length >= SERVICE_LIMITS.queuedFrames || this.queuedBytes + bytes.length > SERVICE_LIMITS.queuedBytes) {
      throw new ServiceProtocolError('BACKPRESSURE')
    }
    this.queue.push({ bytes, requestId })
    this.queuedBytes += bytes.length
    void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.writing || this.failure) return
    this.writing = true
    try {
      while (this.queue.length > 0 && !this.failure) {
        const frame = this.queue[0]
        if (frame.requestId && !this.pending.has(frame.requestId)) {
          this.queue.shift()
          this.queuedBytes -= frame.bytes.length
          continue // An unsent mutation expired; never send it later.
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const stopped = new Promise<never>((_, reject) => {
            this.stopWrite = () => reject(new ServiceProtocolError('DISCONNECTED'))
            timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), SERVICE_LIMITS.requestTimeoutMs)
          })
          let write: Promise<void>
          try { write = this.options.write(frame.bytes) }
          catch { write = Promise.reject(new ServiceProtocolError('DISCONNECTED')) }
          await Promise.race([stopped, write])
        } finally { clearTimeout(timer); this.stopWrite = null }
        if (!this.failure) {
          this.queue.shift()
          this.queuedBytes -= frame.bytes.length
        }
      }
    } catch (error) { this.disconnect(error instanceof ServiceProtocolError ? error.code : 'DISCONNECTED') }
    finally { this.writing = false; this.settleDrain() }
  }
}

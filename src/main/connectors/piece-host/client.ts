import { resolveAllowedOperation, CONNECTOR_PIECE_ALLOWLIST, type ConnectorPieceAllowlist, type PieceTarget } from '../allowlist'
import { redactCredentials, type ConnectorCredentials } from '../credentials'
import {
  deserializePieceError,
  PieceCancelledError,
  PieceExecutionError,
  PieceHostCrashedError,
  PieceTimeoutError,
  serializePieceError
} from './errors'
import type { HostInboundMessage, HostOutboundMessage, PieceStoreScope } from './protocol'

/**
 * Main-process side of the connector piece host (issue #12).
 *
 * - Calls run one at a time, in order. Each has its own timeout (default 60 s)
 *   and an optional AbortSignal. On timeout or cancel the host process is
 *   killed; the next call starts a fresh one.
 * - A host exit while a call is in flight rejects it with PieceHostCrashedError.
 * - Credentials are resolved per call from `credentials` and sent with the
 *   invoke; the host never stores them. `context.store` requests are answered
 *   from `kv`, scoped to the instance of the call in flight — the host cannot
 *   name another instance.
 * - Error messages from pieces are passed through redactCredentials().
 */

export interface PieceHostTransport {
  postMessage(message: HostInboundMessage): void
  onMessage(handler: (message: HostOutboundMessage) => void): void
  /** Called once when the process exits, including after kill(). */
  onExit(handler: (code: number | null) => void): void
  kill(): void
}

export type PieceHostTransportFactory = () => PieceHostTransport

/**
 * KV backend for `context.store`. ConnectorStore satisfies it through
 * kvBackendFromConnectorStore(). get returns null for a missing key.
 */
export interface PieceKvBackend {
  get(instanceId: string, scope: PieceStoreScope, key: string): unknown
  put(instanceId: string, scope: PieceStoreScope, key: string, value: unknown): unknown
  delete(instanceId: string, scope: PieceStoreScope, key: string): unknown
}

/** Credential source; ConnectorCredentialStore satisfies it. */
export interface PieceCredentialSource {
  get(instanceId: string): ConnectorCredentials | null | Promise<ConnectorCredentials | null>
}

export function kvBackendFromConnectorStore(store: {
  kvGet(instanceId: string, scope: PieceStoreScope, key: string): unknown
  kvPut(instanceId: string, scope: PieceStoreScope, key: string, value: unknown): void
  kvDelete(instanceId: string, scope: PieceStoreScope, key: string): unknown
}): PieceKvBackend {
  return {
    get: (instanceId, scope, key) => store.kvGet(instanceId, scope, key),
    put: (instanceId, scope, key, value) => store.kvPut(instanceId, scope, key, value),
    delete: (instanceId, scope, key) => store.kvDelete(instanceId, scope, key)
  }
}

/** Maps 21x credentials to the Activepieces AppConnectionValue a piece expects in `context.auth`. */
export function toPieceAuthValue(creds: ConnectorCredentials | null): unknown {
  if (!creds) return undefined
  switch (creds.type) {
    case 'secret_text':
      return { type: 'SECRET_TEXT', secret_text: creds.secret }
    case 'basic':
      return { type: 'BASIC_AUTH', username: creds.username, password: creds.password }
    case 'custom_auth':
      return { type: 'CUSTOM_AUTH', props: creds.props }
  }
}

export interface PieceHostClientOptions {
  createTransport: PieceHostTransportFactory
  kv: PieceKvBackend
  credentials: PieceCredentialSource
  defaultTimeoutMs?: number
  allowlist?: ConnectorPieceAllowlist
}

export interface PieceCallRequest {
  instanceId: string
  pieceName: string
  pieceVersion: string
  target: PieceTarget
  propsValue?: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
}

export const DEFAULT_PIECE_CALL_TIMEOUT_MS = 60_000

interface ActiveCall {
  id: number
  instanceId: string
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

interface HostHandle {
  transport: PieceHostTransport
  ready: Promise<void>
}

export class PieceHostClient {
  private host: HostHandle | null = null
  private active: ActiveCall | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private disposed = false
  /** Number of host processes started; exposed for diagnostics and tests. */
  starts = 0

  constructor(private readonly options: PieceHostClientOptions) {}

  runAction(req: Omit<PieceCallRequest, 'target'> & { actionName: string }): Promise<unknown> {
    const { actionName, ...rest } = req
    return this.call({ ...rest, target: { type: 'action', name: actionName } })
  }

  runTrigger(
    req: Omit<PieceCallRequest, 'target'> & { triggerName: string; hook: 'onEnable' | 'onDisable' | 'run' | 'test' }
  ): Promise<unknown> {
    const { triggerName, hook, ...rest } = req
    return this.call({ ...rest, target: { type: 'trigger', name: triggerName, hook } })
  }

  call(req: PieceCallRequest): Promise<unknown> {
    // Refuse before queueing: a non-allowlisted piece never reaches the host.
    try {
      resolveAllowedOperation(req.pieceName, req.pieceVersion, req.target, this.options.allowlist ?? CONNECTOR_PIECE_ALLOWLIST)
    } catch (err) {
      return Promise.reject(err)
    }
    const run = this.queue.then(() => this.execute(req))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Kills the host. In-flight and later calls fail. */
  dispose(): void {
    this.disposed = true
    this.killHost()
    if (this.active) {
      this.active.reject(new PieceCancelledError())
      this.active = null
    }
  }

  private async execute(req: PieceCallRequest): Promise<unknown> {
    if (this.disposed) throw new PieceCancelledError()
    if (req.signal?.aborted) throw new PieceCancelledError()
    const timeoutMs = req.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_PIECE_CALL_TIMEOUT_MS
    const id = this.nextId++

    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const resolved: { creds: ConnectorCredentials | null } = { creds: null }
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const call: ActiveCall = { id, instanceId: req.instanceId, resolve, reject }
        this.active = call
        timer = setTimeout(() => {
          this.failActive(call, new PieceTimeoutError(timeoutMs))
          this.killHost()
        }, timeoutMs)
        onAbort = () => {
          this.failActive(call, new PieceCancelledError())
          this.killHost()
        }
        req.signal?.addEventListener('abort', onAbort, { once: true })

        void (async () => {
          try {
            const creds = await this.options.credentials.get(req.instanceId)
            resolved.creds = creds
            const host = this.ensureHost()
            await host.ready
            if (this.active !== call) return
            host.transport.postMessage({
              kind: 'invoke',
              id,
              invocation: {
                pieceName: req.pieceName,
                pieceVersion: req.pieceVersion,
                target: req.target,
                auth: toPieceAuthValue(creds),
                propsValue: req.propsValue ?? {},
                projectId: `21x-connector-${req.instanceId}`
              }
            })
          } catch (err) {
            this.failActive(call, err)
          }
        })()
      })
    } catch (err) {
      throw this.redact(err, resolved.creds)
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) req.signal?.removeEventListener('abort', onAbort)
      if (this.active?.id === id) this.active = null
    }
  }

  private failActive(call: ActiveCall, err: unknown): void {
    if (this.active !== call) return
    this.active = null
    call.reject(err)
  }

  private redact(err: unknown, creds: ConnectorCredentials | null): unknown {
    if (!creds || !(err instanceof PieceExecutionError)) return err
    const message = redactCredentials(err.message, creds)
    return message === err.message ? err : new PieceExecutionError(message, err.pieceErrorName)
  }

  private ensureHost(): HostHandle {
    if (this.host) return this.host
    const transport = this.options.createTransport()
    this.starts += 1
    let markReady!: () => void
    let markFailed!: (err: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      markFailed = reject
    })
    // Avoid an unhandled rejection when the host dies before anyone awaits ready.
    ready.catch(() => undefined)
    const handle: HostHandle = { transport, ready }
    this.host = handle

    transport.onMessage((message) => {
      if (this.host !== handle) return
      this.onHostMessage(handle, message, markReady)
    })
    transport.onExit((code) => {
      const crash = new PieceHostCrashedError(code)
      markFailed(crash)
      if (this.host !== handle) return
      this.host = null
      if (this.active) this.failActive(this.active, crash)
    })
    return handle
  }

  private killHost(): void {
    const handle = this.host
    this.host = null
    if (!handle) return
    try {
      handle.transport.kill()
    } catch {
      /* already gone */
    }
  }

  private onHostMessage(handle: HostHandle, message: HostOutboundMessage, markReady: () => void): void {
    switch (message.kind) {
      case 'ready':
        markReady()
        return
      case 'result': {
        const call = this.active
        if (!call || call.id !== message.id) return
        this.active = null
        if (message.ok) call.resolve(message.output)
        else call.reject(deserializePieceError(message.error))
        return
      }
      case 'store': {
        const call = this.active
        const reply = (msg: HostInboundMessage): void => {
          if (this.host === handle) handle.transport.postMessage(msg)
        }
        if (!call || call.id !== message.callId) {
          reply({
            kind: 'store-result',
            storeId: message.storeId,
            ok: false,
            error: { code: 'PIECE_EXECUTION_FAILED', message: 'context.store used outside an active call' }
          })
          return
        }
        void this.handleStore(call.instanceId, message)
          .then((value) => reply({ kind: 'store-result', storeId: message.storeId, ok: true, value }))
          .catch((err) => reply({ kind: 'store-result', storeId: message.storeId, ok: false, error: serializePieceError(err) }))
        return
      }
    }
  }

  private async handleStore(
    instanceId: string,
    message: Extract<HostOutboundMessage, { kind: 'store' }>
  ): Promise<unknown> {
    const { op, scope, key } = message
    if (scope !== 'project' && scope !== 'flow') throw new Error(`Unknown store scope: ${String(scope)}`)
    if (typeof key !== 'string') throw new Error('Store keys must be strings')
    const { kv } = this.options
    if (op === 'get') {
      const value = await kv.get(instanceId, scope, key)
      return value === undefined ? null : value
    }
    if (op === 'put') {
      await kv.put(instanceId, scope, key, message.value ?? null)
      return null
    }
    if (op === 'delete') {
      await kv.delete(instanceId, scope, key)
      return null
    }
    throw new Error(`Unknown store operation: ${String(op)}`)
  }
}

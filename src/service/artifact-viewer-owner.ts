import { randomUUID } from 'node:crypto'
import { ARTIFACT_VIEWER_LIMITS, ARTIFACT_VIEWER_NATIVE_SCHEMAS, isArtifactViewerClosed, type ArtifactViewerNativeBridge } from '../shared/artifact-viewer-native'
import { isDatabaseId } from '../shared/database-desktop-codecs'
import { isArtifactRelativePath } from '../shared/artifact-codecs'
import { isUiLeaseId } from '../shared/ui-desktop-codecs'
import { isRecord, ServiceProtocolError } from '../shared/service-protocol'
import type { DesktopCallerContext } from './transport/desktop-registry'
import type { ArtifactBackend, ArtifactViewerSnapshot } from './artifact-backend'

export interface ArtifactViewerLease {
  readonly viewerId: string
  open(): Promise<void>
  close(): Promise<void>
}
export interface ArtifactViewerOwnerOptions {
  engineEpoch: string
  artifacts: ArtifactBackend
  /** Captured private authority only; absent in current production bootstrap. */
  native?: ArtifactViewerNativeBridge
  assertAvailable(): void
}
interface Entry {
  id: string
  controller: AbortController
  caller: Readonly<DesktopCallerContext>
  lease: ArtifactViewerLease
  work: Promise<void>
  opening?: Promise<void>
  retirement?: Promise<void>
  snapshot?: ArtifactViewerSnapshot
  timer: ReturnType<typeof setTimeout> | undefined
  removeAbort(): void
  ready: boolean
  closed: boolean
  opened: boolean
  retired: boolean
}
const safeError = (error: unknown): ServiceProtocolError => error instanceof ServiceProtocolError ? error : new ServiceProtocolError('INTERNAL_ERROR')

/** Optional private Source consumer, deliberately unregistered. No renderer can
 * submit HTML or obtain a viewer by constructing this SDK/schema. Native child
 * authority and the production UI binding remain separately unavailable. */
export class ArtifactViewerOwner {
  private readonly entries = new Map<string, Entry>()
  private readonly native: ArtifactViewerNativeBridge | undefined
  private readonly artifacts: ArtifactBackend
  private allocated = 0
  private closing = false
  private cleanupFailures = 0
  constructor(private readonly options: ArtifactViewerOwnerOptions) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(options.engineEpoch)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    options.assertAvailable(); this.artifacts = options.artifacts
    if (options.native) {
      const bridge = options.native
      if (['register', 'open', 'retire'].some(key => typeof Reflect.get(bridge, key) !== 'function')) throw new ServiceProtocolError('INVALID_ARGUMENTS')
      this.native = Object.freeze({ register: bridge.register.bind(bridge), open: bridge.open.bind(bridge), retire: bridge.retire.bind(bridge) })
    }
  }
  get inflightCount(): number { return this.entries.size }
  get failedCleanupCount(): number { return this.cleanupFailures }
  async register(taskId: string, relativePath: string, caller: DesktopCallerContext, controls: {
    signal?: AbortSignal
    /** Records ownership synchronously only; early open is refused. */
    onOwnedLease?(lease: ArtifactViewerLease): void
  } = {}): Promise<ArtifactViewerLease> {
    if (this.closing) throw new ServiceProtocolError('DISCONNECTED')
    this.options.assertAvailable()
    if (!this.native) throw new ServiceProtocolError('UNKNOWN_OPERATION')
    if (!isDatabaseId(taskId) || !isArtifactRelativePath(relativePath) || !/\.html?$/i.test(relativePath) ||
      caller.principal !== 'trusted-desktop-main' || caller.engineEpoch !== this.options.engineEpoch || !isUiLeaseId(caller.uiLeaseId)) throw new ServiceProtocolError('INVALID_ARGUMENTS')
    if (controls.signal?.aborted) throw new ServiceProtocolError('CANCELLED')
    if (this.entries.size >= ARTIFACT_VIEWER_LIMITS.active || this.allocated >= ARTIFACT_VIEWER_LIMITS.epochIds) throw new ServiceProtocolError('BACKPRESSURE')
    const id = randomUUID(), controller = new AbortController()
    const lease = Object.freeze({ viewerId: id, open: () => this.open(entry), close: () => this.retire(entry) })
    const abort = (): void => { this.fence(entry); queueMicrotask(() => { void this.retire(entry).catch(() => {}) }) }
    const entry: Entry = { id, controller, caller: Object.freeze({ ...caller }), lease, work: Promise.resolve(), timer: undefined,
      removeAbort: () => controls.signal?.removeEventListener('abort', abort), ready: false, closed: false, opened: false, retired: false }
    this.entries.set(id, entry); this.allocated++
    controls.signal?.addEventListener('abort', abort, { once: true })
    entry.timer = setTimeout(abort, ARTIFACT_VIEWER_LIMITS.ttlMs); entry.timer.unref?.()
    // Schedule raw read/register only after the synchronous observer has taken
    // ownership. Observer failure still follows the same fenced drain path.
    entry.work = Promise.resolve().then(async () => {
      this.current(entry)
      entry.snapshot = await this.artifacts.captureViewerSnapshot(taskId, relativePath, entry.caller, controller.signal)
      this.current(entry)
      const result = await this.native!.register({ viewerId: id, uiLeaseId: entry.caller.uiLeaseId!, html: entry.snapshot.html })
      this.ack('register', id, result)
      this.current(entry)
      entry.ready = true
    })
    void entry.work.catch(() => {})
    try {
      controls.onOwnedLease?.(lease)
      await entry.work
      this.current(entry)
      return lease
    } catch (error) {
      await this.retire(entry)
      throw safeError(error)
    }
  }
  /** Delivery claims synchronously. Cleanup is scheduled outside this callback
   * and is never invoked-and-awaited inside a native delivery RPC. */
  closed(value: unknown): { accepted: boolean } {
    if (!isArtifactViewerClosed(value)) return { accepted: false }
    const entry = this.entries.get(value.viewerId)
    if (!entry || entry.closed) return { accepted: false }
    this.fence(entry)
    queueMicrotask(() => { void this.retire(entry).catch(() => {}) })
    return { accepted: true }
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new RangeError('Invalid artifact viewer shutdown deadline')
    this.closing = true
    const work = Promise.allSettled([...this.entries.values()].map(entry => this.retire(entry))).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new ServiceProtocolError('DISCONNECTED')
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceProtocolError('TIMEOUT')), timeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  private current(entry: Entry): void {
    if (this.closing || entry.closed || entry.controller.signal.aborted || this.entries.get(entry.id) !== entry) throw new ServiceProtocolError('CANCELLED')
    this.options.assertAvailable(); entry.snapshot?.beforeEffect()
  }
  private fence(entry: Entry): void {
    entry.closed = true; entry.ready = false; entry.controller.abort(); entry.removeAbort()
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
  }
  private ack(kind: 'register' | 'open' | 'retire', id: string, value: unknown): void {
    const schema = ARTIFACT_VIEWER_NATIVE_SCHEMAS[`host.artifactViewer.${kind}`]
    if (!schema.validateResult(value) || !isRecord(value) || value.viewerId !== id) throw new ServiceProtocolError('INVALID_RESULT')
  }
  private async open(entry: Entry): Promise<void> {
    this.current(entry)
    if (!entry.ready || entry.opened) throw new ServiceProtocolError('INVALID_REQUEST')
    entry.opened = true
    entry.opening = Promise.resolve().then(async () => {
      this.current(entry)
      const result = await this.native!.open({ viewerId: entry.id })
      this.ack('open', entry.id, result); this.current(entry)
    })
    try { await entry.opening }
    catch (error) { await this.retire(entry); throw safeError(error) }
  }
  private retire(entry: Entry): Promise<void> {
    this.fence(entry)
    if (entry.retired) return Promise.resolve()
    if (entry.retirement) return entry.retirement
    // Retire immediately, including unknown IDs, so delayed register/open cannot
    // resurrect a native child. The native ACK must itself join raw native work.
    const native = Promise.resolve().then(async () => {
      const result = await this.native!.retire({ viewerId: entry.id }); this.ack('retire', entry.id, result)
    })
    const work = Promise.allSettled([entry.work, ...(entry.opening ? [entry.opening] : []), native]).then(results => {
      const retired = results[results.length - 1]
      if (retired.status === 'rejected') throw safeError(retired.reason)
      entry.retired = true; entry.snapshot = undefined; entry.opening = undefined; this.entries.delete(entry.id)
    }).catch(error => { this.cleanupFailures++; throw safeError(error) }).finally(() => { entry.retirement = undefined })
    entry.retirement = work
    return work
  }
}

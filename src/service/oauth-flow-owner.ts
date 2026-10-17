import { createHash, randomUUID } from 'node:crypto'
import { isNativeOAuthCallback, isNativeOAuthRegistration, oauthAuthorizationFields, type NativeOAuthBridge, type NativeOAuthCallback, type NativeOAuthRegistration } from '../shared/oauth-native-callbacks'

export interface OAuthFlowLease {
  readonly flowId: string
  /** Opens only the authorization URL captured by this registration. */
  open(): Promise<void>
  /** Custom schemes only; the pending state is consumed before this resolves. */
  waitForCallback(): Promise<{ code: string; state: string }>
  /** Raw register/open work and native retirement must acknowledge first. */
  close(): Promise<void>
}
interface Entry {
  request: NativeOAuthRegistration
  beforeEffect: () => void
  expires: number
  openRequested: boolean
  ready: boolean
  consumed: boolean
  cancelled: boolean
  registration: Promise<unknown>
  opening?: Promise<void>
  retirement?: Promise<void>
  callback: Promise<{ code: string; state: string }>
  resolve(value: { code: string; state: string }): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
const failure = (): Error => new Error('OAUTH_FLOW_UNAVAILABLE')

/**
 * App-owned consumer of private native deliveries. A caller supplies a captured
 * provider/source/intent fence, never callback-selected database identifiers.
 * PKCE and credential writes stay in that caller's closure. No renderer events.
 */
export class OAuthFlowOwner {
  private closing = false
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly native: NativeOAuthBridge, private readonly assertCurrent: () => void, private readonly now: () => number = () => performance.now()) {}

  async register(input: Omit<NativeOAuthRegistration, 'flowId' | 'stateSha256'>, beforeEffect: () => void, onOwnedLease?: (lease: OAuthFlowLease) => void): Promise<OAuthFlowLease> {
    this.requireOpen(); this.assertCurrent(); beforeEffect()
    if (this.entries.size >= 16) throw new Error('OAUTH_FLOW_CAPACITY')
    const fields = oauthAuthorizationFields(input.authorizationUrl)
    if (!fields) throw failure()
    const request: NativeOAuthRegistration = { ...input, flowId: randomUUID(), stateSha256: createHash('sha256').update(fields.state).digest('hex') }
    if (!isNativeOAuthRegistration(request)) throw failure()
    let resolve!: Entry['resolve'], reject!: Entry['reject']
    const callback = new Promise<{ code: string; state: string }>((yes, no) => { resolve = yes; reject = no })
    // A browser/native failure may precede the consumer attaching its waiter.
    void callback.catch(() => {})
    const entry: Entry = {
      request, beforeEffect, expires: this.now() + input.ttlMs, openRequested: false, ready: false, consumed: false, cancelled: false,
      registration: Promise.resolve(), callback, resolve, reject,
      timer: setTimeout(() => { this.cancel(entry); void this.retire(entry).catch(() => {}) }, input.ttlMs)
    }
    this.entries.set(request.flowId, entry)
    entry.registration = Promise.resolve().then(async () => {
      this.assertEntry(entry)
      const result = await this.native.register(structuredClone(request))
      if (result.flowId !== request.flowId || result.registered !== true) throw failure()
      this.assertEntry(entry)
      entry.ready = true
    })
    const lease: OAuthFlowLease = Object.freeze({
      flowId: request.flowId,
      open: () => this.open(entry),
      waitForCallback: () => {
        if (request.kind !== 'custom-scheme') return Promise.reject(failure())
        return callback
      },
      close: () => { this.cancel(entry); return this.retire(entry) }
    })
    // Publish only cleanup ownership synchronously. Opening stays fenced until
    // the receipt and post-ack binding check have both succeeded.
    try { onOwnedLease?.(lease); await entry.registration }
    catch (error) { this.cancel(entry); await this.retire(entry); throw error }
    return lease
  }

  /** Called exclusively by the finite engine.oauth.callback private request. */
  deliver(value: unknown): { accepted: boolean } {
    if (!isNativeOAuthCallback(value) || this.closing) return { accepted: false }
    const entry = this.entries.get(value.flowId)
    if (!entry || entry.consumed || !entry.openRequested || entry.request.kind !== value.kind || entry.request.redirectUri !== value.redirectUri || createHash('sha256').update(value.state).digest('hex') !== entry.request.stateSha256) return { accepted: false }
    try { this.assertEntry(entry) } catch { this.cancel(entry); return { accepted: false } }
    // No await between validation and claim. Duplicates cannot reach exchange.
    entry.consumed = true
    clearTimeout(entry.timer)
    if (value.outcome.status === 'code') entry.resolve({ code: value.outcome.code, state: value.state })
    else entry.reject(new Error(value.outcome.status === 'denied' ? 'OAUTH_FLOW_DENIED' : 'OAUTH_FLOW_FAILED'))
    return { accepted: true }
  }

  /** Synchronous admission/callback fence; raw receipts are retained for close. */
  stop(): void {
    this.closing = true
    for (const entry of this.entries.values()) {
      this.cancel(entry)
      void this.retire(entry).catch(() => {})
    }
  }

  async close(timeoutMs = 3000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new Error('OAUTH_FLOW_DEADLINE_INVALID')
    this.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.entries.values()].map(entry => this.retire(entry))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OAUTH_FLOW_DRAIN_BLOCKED')), timeoutMs) })
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  private requireOpen(): void { if (this.closing) throw failure() }
  private assertEntry(entry: Entry): void {
    this.requireOpen(); this.assertCurrent(); entry.beforeEffect()
    if (entry.cancelled || this.now() >= entry.expires || this.entries.get(entry.request.flowId) !== entry) throw failure()
  }
  private cancel(entry: Entry): void {
    entry.cancelled = true
    clearTimeout(entry.timer)
    entry.reject(failure())
  }
  private open(entry: Entry): Promise<void> {
    try {
      if (!entry.ready) throw failure()
      this.assertEntry(entry)
      if (entry.openRequested || entry.consumed) throw failure()
      entry.openRequested = true
    } catch (error) { return Promise.reject(error) }
    entry.opening = Promise.resolve().then(async () => {
      this.assertEntry(entry)
      const result = await this.native.open({ flowId: entry.request.flowId })
      if (result.flowId !== entry.request.flowId || result.opened !== true) throw failure()
      this.assertEntry(entry)
    }).catch(error => { this.cancel(entry); throw error })
    return entry.opening
  }
  private retire(entry: Entry): Promise<void> {
    if (this.entries.get(entry.request.flowId) !== entry) return Promise.resolve()
    if (entry.retirement) return entry.retirement
    const raw = (async () => {
      // Registration can acknowledge after cancellation; opening can outlive its
      // public deadline. Neither permits an early native retirement receipt.
      await Promise.allSettled([entry.registration, ...(entry.opening ? [entry.opening] : [])])
      const result = await this.native.retire({ flowId: entry.request.flowId })
      if (result.flowId !== entry.request.flowId || result.retired !== true) throw failure()
      this.entries.delete(entry.request.flowId)
    })()
    entry.retirement = raw
    void raw.then(() => {}, () => { if (entry.retirement === raw) entry.retirement = undefined })
    return raw
  }
}

/** Keep callback field types visible to private transport consumers. */
export type { NativeOAuthCallback }

import type { AgentManagerHost } from '../main/agent-manager/host'

export interface ProductionEnergyOwnerOptions {
  assertCurrent(): void
  /** Resolves to actual applied state; false acknowledges released/inactive. */
  setActive(active: boolean): Promise<boolean>
}
export const PRODUCTION_ENERGY_LIMITS = Object.freeze({ tickets: 16 })
export type ProductionEnergyErrorCode = 'ENERGY_INVALID_ARGUMENTS' | 'ENERGY_UNAVAILABLE' | 'ENERGY_CLOSED' | 'ENERGY_CAPACITY' | 'ENERGY_CLEANUP_FAILED' | 'ENERGY_DRAIN_INCOMPLETE'
export class ProductionEnergyError extends Error {
  constructor(readonly code: ProductionEnergyErrorCode) { super(code); this.name = 'ProductionEnergyError' }
}
/** Synchronous manager intent tickets, never native inhibition handles. One
 * serial owned callback reconciles aggregate demand without replaying true. */
export class ProductionEnergyOwner {
  readonly host: Extract<AgentManagerHost['energy'], { kind: 'native' }>
  private readonly assertCurrent: () => void
  private readonly setActive: (active: boolean) => Promise<boolean>
  private readonly tickets = new Set<number>()
  private nextTicket = 1
  private demandVersion = 0
  private attemptedVersion = -1
  private applied: boolean | 'unknown' = false
  private releaseRequested = false
  private releaseFailed = false
  private closing = false
  private finalReleased = false
  private flight: Promise<void> | null = null
  constructor(options: ProductionEnergyOwnerOptions) {
    if (!options || typeof options.assertCurrent !== 'function' || typeof options.setActive !== 'function') throw new ProductionEnergyError('ENERGY_INVALID_ARGUMENTS')
    this.assertCurrent = options.assertCurrent; this.setActive = options.setActive
    this.host = Object.freeze({ kind: 'native', start: () => this.start(), stop: (id: number) => this.stop(id) })
  }
  /** Includes an unresolved cleanup receipt after its raw callback rejects. */
  get inflightCount(): number { return this.flight || this.releaseFailed || this.applied !== false ? 1 : 0 }
  private start(): number {
    if (this.closing) throw new ProductionEnergyError('ENERGY_CLOSED')
    try { this.assertCurrent() } catch { throw new ProductionEnergyError('ENERGY_UNAVAILABLE') }
    if (this.tickets.size >= PRODUCTION_ENERGY_LIMITS.tickets || !Number.isSafeInteger(this.nextTicket)) throw new ProductionEnergyError('ENERGY_CAPACITY')
    const id = this.nextTicket++; if (!this.tickets.size) this.demandVersion++
    this.tickets.add(id); this.kick(); return id
  }
  private stop(id: number): void {
    // An unknown/local-retired ticket grants no native release operation.
    if (!Number.isSafeInteger(id) || !this.tickets.delete(id)) return
    if (!this.tickets.size) { this.demandVersion++; this.releaseRequested = true }
    this.kick()
  }
  shutdown(): void {
    if (this.closing) return
    this.closing = true; this.tickets.clear(); this.demandVersion++
    this.releaseRequested = true; this.finalReleased = false; this.kick()
  }
  private needed(): boolean { return this.releaseRequested || !this.closing && this.tickets.size > 0 && this.attemptedVersion !== this.demandVersion }
  private kick(): void {
    if (this.flight || this.releaseFailed || !this.needed()) return
    const raw = Promise.resolve().then(() => this.reconcile())
    this.flight = raw
    void raw.then(() => { if (this.flight === raw) this.flight = null; this.kick() }, () => {
      // Unexpected internal failure also retains cleanup ownership; raw native
      // diagnostics never become public or a reason to restart a provider.
      if (this.flight === raw) this.flight = null
      this.releaseFailed = true; this.releaseRequested = true; this.applied = 'unknown'
      console.warn('[energy] Native inhibition cleanup was not acknowledged')
    })
  }
  private async reconcile(): Promise<void> {
    while (!this.releaseFailed && this.needed()) {
      const active = !this.releaseRequested && !this.closing && this.tickets.size > 0
      if (active) {
        this.attemptedVersion = this.demandVersion
        try { this.assertCurrent() } catch {
          this.closing = true; this.tickets.clear(); this.releaseRequested = true; this.finalReleased = false
          continue
        }
      } else {
        // Cleanup retains authority even after ordinary owner admission closes.
        // Root supplies a captured release-capable callback for that lifetime.
        try { this.assertCurrent() } catch { /* accepted cleanup remains owned */ }
        this.releaseRequested = false
      }
      let acknowledged: boolean
      try {
        // No abort race: the exact raw callback stays awaited until it settles.
        acknowledged = await this.setActive(active)
        if (typeof acknowledged !== 'boolean') throw new ProductionEnergyError('ENERGY_UNAVAILABLE')
      } catch {
        this.applied = 'unknown'
        if (active) {
          this.releaseRequested = true
          console.warn('[energy] Native inhibition request was unavailable')
        } else {
          this.releaseRequested = true; this.releaseFailed = true; this.finalReleased = false
          console.warn('[energy] Native inhibition cleanup was not acknowledged')
        }
        continue
      }
      this.applied = acknowledged
      if (!active) {
        if (acknowledged) {
          this.releaseRequested = true; this.releaseFailed = true; this.finalReleased = false
          console.warn('[energy] Native inhibition cleanup was not acknowledged')
        } else { this.releaseRequested = false; if (this.closing) this.finalReleased = true }
      } else if (!acknowledged) console.warn('[energy] Native inhibition request was unavailable')
      if (active) {
        // Preserve late accepted true, then require false if ownership retired.
        try { this.assertCurrent() } catch {
          this.closing = true; this.tickets.clear(); this.releaseRequested = true; this.finalReleased = false
        }
        if (this.closing || !this.tickets.size) this.releaseRequested = true
      }
    }
  }
  async close(timeoutMs = 2000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new ProductionEnergyError('ENERGY_INVALID_ARGUMENTS')
    this.shutdown()
    // Retry is explicit and false-only. Failed/uncertain true is never replayed.
    if (this.releaseFailed) { this.releaseFailed = false; this.releaseRequested = true; this.finalReleased = false; this.kick() }
    const drain = (async () => {
      while (this.flight) await this.flight
      if (this.releaseFailed || !this.finalReleased || this.applied !== false) throw new ProductionEnergyError('ENERGY_CLEANUP_FAILED')
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProductionEnergyError('ENERGY_DRAIN_INCOMPLETE')), timeoutMs) })]) } finally { if (timer) clearTimeout(timer) }
  }
}

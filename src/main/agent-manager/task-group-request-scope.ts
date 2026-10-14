import { AsyncLocalStorage } from 'node:async_hooks'

const MAX_REQUESTS = 64
const MAX_NESTING = 8
interface Scope {
  readonly beforeEffect: () => void
  readonly signal: AbortSignal
  readonly parent: Scope | undefined
  readonly children: Set<Promise<unknown>>
  active: boolean
}
export class TaskGroupRequestScopeError extends Error {
  readonly code: 'CANCELLED' | 'BACKPRESSURE'
  constructor(code: 'CANCELLED' | 'BACKPRESSURE' = 'CANCELLED') {
    super(code === 'CANCELLED' ? 'The task group request is no longer current.' : 'Task group request capacity exceeded.')
    this.name = 'TaskGroupRequestScopeError'; this.code = code
  }
}
/** Caller authority belongs to the full raw request, including children that
 * ignore cancellation. Completed requests cannot authorize inherited callbacks.
 * Background ownership and accepted cleanup must detach explicitly. */
export class TaskGroupRequestScope {
  private readonly context = new AsyncLocalStorage<Scope | undefined>()
  private readonly requests = new Set<Promise<unknown>>()
  private readonly rawWork = new Set<Promise<unknown>>()
  private closing = false
  get pendingCount(): number { return this.requests.size }
  get scoped(): boolean { return this.context.getStore() !== undefined }
  assertCurrent(): void { this.assertScope(this.context.getStore()) }
  /** A nested owner receives this exact scope, not whichever caller happens to invoke it later. */
  capture(): (() => void) | undefined {
    const scope = this.context.getStore()
    return scope ? () => this.assertScope(scope) : undefined
  }
  private assertScope(current: Scope | undefined): void {
    for (let scope = current; scope; scope = scope.parent) {
      if (!scope.active || this.closing || scope.signal.aborted) throw new TaskGroupRequestScopeError()
      scope.beforeEffect()
      if (scope.signal.aborted || this.closing) throw new TaskGroupRequestScopeError()
    }
  }
  isCurrent(): boolean { try { this.assertCurrent(); return true } catch { return false } }
  /** Tracking is unconditional: an already accepted raw child must remain
   * owned even when its signal/authority has since been withdrawn. */
  retainRaw<T>(raw: Promise<T>): Promise<T> {
    const scope = this.context.getStore()
    if (scope) {
      this.rawWork.add(raw)
      void raw.then(() => this.rawWork.delete(raw), () => this.rawWork.delete(raw))
      if (scope.active) this.retain(scope, raw)
    }
    return raw
  }
  private retain(scope: Scope, raw: Promise<unknown>): void {
    scope.children.add(raw)
    void raw.then(() => scope.children.delete(raw), () => scope.children.delete(raw))
  }
  /** Use at the creation of manager-owned timers/pollers and acknowledged
   * cleanup, never around a new caller-requested admission or prompt. */
  detached<T>(effect: () => T): T { return this.context.run(undefined, effect) }
  run<T>(effect: () => Promise<T>, beforeEffect: () => void, signal: AbortSignal): Promise<T> {
    if (typeof effect !== 'function' || typeof beforeEffect !== 'function' || !signal || typeof signal.aborted !== 'boolean') return Promise.reject(new TypeError('A task group request requires explicit authority and cancellation controls.'))
    if (this.closing) return Promise.reject(new TaskGroupRequestScopeError())
    const parent = this.context.getStore()
    let depth = 0; for (let ancestor = parent; ancestor; ancestor = ancestor.parent) depth++
    if (this.requests.size >= MAX_REQUESTS || depth >= MAX_NESTING) return Promise.reject(new TaskGroupRequestScopeError('BACKPRESSURE'))
    const scope: Scope = { beforeEffect, signal, parent, children: new Set(), active: true }
    const raw = this.context.run(scope, async () => {
      try {
        this.assertCurrent()
        const result = await effect()
        await this.join(scope)
        this.assertCurrent()
        return result
      } finally {
        // Failure/cancellation cannot release an accepted child or its cleanup.
        await this.join(scope)
        scope.active = false
      }
    })
    this.requests.add(raw)
    if (parent?.active) this.retain(parent, raw)
    void raw.then(() => this.requests.delete(raw), () => this.requests.delete(raw))
    return raw
  }
  private async join(scope: Scope): Promise<void> {
    while (scope.children.size) await Promise.allSettled([...scope.children])
  }
  shutdown(): void { this.closing = true }
  async drain(): Promise<void> {
    while (this.requests.size || this.rawWork.size) await Promise.allSettled([...this.requests, ...this.rawWork])
  }
}

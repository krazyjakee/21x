import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { matchesWorkspaceCleanupObservation, type WorkspaceCleanupObserver, type WorkspaceCleanupObservationRequest } from '../shared/workspace-native-callbacks'

interface Scope {
  active: boolean
  ids: Set<string>
  tickets: Map<string, string>
  beforeEffect(): void
  signal: AbortSignal
}
/** Holds one cleanup exclusion through raw native observation and retirement.
 * Native observations are fresh bounded scans, never timeless process grants. */
export class ProductionWorkspaceProcessOwner {
  private readonly context = new AsyncLocalStorage<Scope>()
  private scope: Scope | null = null
  private raw: Promise<unknown> | null = null
  private closing = false
  private failed = false
  private readonly observe?: WorkspaceCleanupObserver
  constructor(private readonly root: string, observer?: WorkspaceCleanupObserver) { this.observe = observer }
  get inflightCount(): number { return this.scope ? 1 : 0 }
  get ownsCurrentScope(): boolean { return !!this.scope?.active && this.context.getStore() === this.scope }
  assertOtherWorkAllowed(): void {
    if (this.failed || this.scope && this.context.getStore() !== this.scope) throw new Error('WORKSPACE_CLEANUP_BUSY')
    const inherited = this.context.getStore()
    if (inherited && !inherited.active) throw new Error('WORKSPACE_CLEANUP_REQUEST_EXPIRED')
  }
  private current(scope: Scope): void {
    if (this.closing || !scope.active || scope.signal.aborted) throw new Error('WORKSPACE_CLEANUP_CANCELLED')
    scope.beforeEffect()
  }
  private async observation(request: WorkspaceCleanupObservationRequest, signal: AbortSignal) {
    if (!this.observe) throw new Error('WORKSPACE_CLEANUP_PROCESS_AUTHORITY_UNAVAILABLE')
    const result = await this.observe(request, signal)
    if (!matchesWorkspaceCleanupObservation(request, result)) throw new Error('WORKSPACE_CLEANUP_PROCESS_RESULT_INVALID')
    return result
  }
  async assertIdleWorkspace(taskId: string, path: string): Promise<void> {
    const scope = this.context.getStore()
    if (!scope || scope !== this.scope || !scope.ids.has(taskId) || path !== join(this.root, taskId)) throw new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED')
    this.current(scope)
    const leaseId = scope.tickets.get(taskId)
    if (!leaseId) throw new Error('WORKSPACE_CLEANUP_PROCESS_AUTHORITY_UNAVAILABLE')
    const result = await this.observation({ version: 1, action: 'check', taskId, leaseId }, scope.signal)
    this.current(scope)
    if ('status' in result && result.status === 'unknown') throw new Error('WORKSPACE_CLEANUP_PROCESS_OBSERVATION_UNAVAILABLE')
    if (!('status' in result) || result.status !== 'idle') throw new Error('WORKSPACE_CLEANUP_PROCESS_NOT_IDLE')
  }
  run<T>(taskIds: string[], effect: () => Promise<T>, beforeEffect: () => void, signal: AbortSignal): Promise<T> {
    if (this.closing || this.scope || this.failed) return Promise.reject(new Error('WORKSPACE_CLEANUP_BUSY'))
    if (!this.observe) return Promise.reject(new Error('WORKSPACE_CLEANUP_PROCESS_AUTHORITY_UNAVAILABLE'))
    if (!taskIds.length || taskIds.length > 128 || new Set(taskIds).size !== taskIds.length || taskIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) return Promise.reject(new Error('WORKSPACE_CLEANUP_SCOPE_CHANGED'))
    const scope: Scope = { active: true, ids: new Set(taskIds), tickets: new Map(), beforeEffect, signal }
    this.scope = scope
    const raw = this.context.run(scope, async () => {
      try {
        this.current(scope)
        for (const taskId of taskIds) {
          let result
          try { result = await this.observation({ version: 1, action: 'acquire', taskId }, signal) }
          catch (error) { this.failed = true; throw error /* uncertain acquisition retains exclusion */ }
          // Capture a late acquisition before cancellation/current-scope checks.
          if ('status' in result && result.status === 'idle' && result.leaseId) scope.tickets.set(taskId, result.leaseId)
          this.current(scope)
          if ('status' in result && result.status === 'unknown') throw new Error('WORKSPACE_CLEANUP_PROCESS_OBSERVATION_UNAVAILABLE')
          if (!scope.tickets.has(taskId)) throw new Error('WORKSPACE_CLEANUP_PROCESS_NOT_IDLE')
        }
        this.current(scope)
        return await effect()
      } finally {
        // Release is cleanup authority, independent of cancellation or a task
        // directory already removed. No raw callback is abandoned on timeout.
        let releaseFailed = false
        for (const [taskId, leaseId] of scope.tickets) {
          try { await this.observation({ version: 1, action: 'release', taskId, leaseId }, new AbortController().signal); scope.tickets.delete(taskId) }
          catch { releaseFailed = true; this.failed = true }
        }
        scope.active = false
        if (!this.failed) this.scope = null
        if (releaseFailed) throw new Error('WORKSPACE_CLEANUP_PROCESS_DRAIN_INCOMPLETE')
      }
    })
    this.raw = raw
    void raw.then(() => { if (this.raw === raw) this.raw = null }, () => { if (this.raw === raw) this.raw = null })
    return raw
  }
  shutdown(): void { this.closing = true }
  async close(timeoutMs = 2000): Promise<void> {
    this.shutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.raw?.catch(() => {}), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WORKSPACE_CLEANUP_PROCESS_DRAIN_INCOMPLETE')), timeoutMs) })])
      if (this.failed || this.scope) throw new Error('WORKSPACE_CLEANUP_PROCESS_DRAIN_INCOMPLETE')
    } finally { clearTimeout(timer) }
  }
}

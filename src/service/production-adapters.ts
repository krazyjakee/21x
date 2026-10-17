import type { CodingAgentAdapter, SessionConfig } from '../main/adapters/coding-agent-adapter'

/** The production lifetime retains identities even when the legacy manager's
 * best-effort stop logs an error. This registry never repeats prompt/create work. */
export class ProductionAdapters {
  private closing = false
  private readonly raw = new Set<Promise<unknown>>()
  private readonly proxies = new WeakMap<CodingAgentAdapter, CodingAgentAdapter>()
  private readonly adapters = new Set<CodingAgentAdapter>()
  private readonly sessions = new Map<CodingAgentAdapter, Map<string, SessionConfig>>()
  private readonly destroying = new Map<CodingAgentAdapter, Map<string, Promise<void>>>()

  wrap(adapter: CodingAgentAdapter | null): CodingAgentAdapter | null {
    if (!adapter) return null
    const existing = this.proxies.get(adapter)
    if (existing) return existing
    this.adapters.add(adapter)
    const proxy = new Proxy(adapter, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function' || property === 'constructor') return value
        return (...args: unknown[]) => {
          if (this.closing && ['initialize', 'createSession', 'resumeSession', 'sendPrompt', 'respondToPermission', 'respondToQuestion'].includes(String(property))) {
            return Promise.reject(new Error('PRODUCTION_ADAPTER_CLOSED'))
          }
          if (property === 'destroySession') return this.destroy(target, args[0] as string, args[1] as SessionConfig)
          const result: unknown = Reflect.apply(value, target, args)
          if (!result || typeof result !== 'object' || !('then' in result)) return result
          // Registration precedes the manager's own continuation. An accepted
          // late native create is retained for cleanup even if its caller quit.
          const raw = Promise.resolve(result as PromiseLike<unknown>).then(value => {
            if (property === 'createSession' && typeof value === 'string') this.remember(target, value, args[0] as SessionConfig)
            if (property === 'resumeSession') this.remember(target, args[0] as string, args[1] as SessionConfig)
            return value
          })
          return this.own(raw)
        }
      }
    })
    this.proxies.set(adapter, proxy)
    return proxy
  }

  private remember(adapter: CodingAgentAdapter, id: string, config: SessionConfig): void {
    const sessions = this.sessions.get(adapter) ?? new Map<string, SessionConfig>()
    this.sessions.set(adapter, sessions)
    sessions.set(id, config)
  }

  private own<T>(raw: Promise<T>): Promise<T> {
    this.raw.add(raw)
    void raw.then(() => this.raw.delete(raw), () => this.raw.delete(raw))
    return raw
  }

  private destroy(adapter: CodingAgentAdapter, id: string, config: SessionConfig): Promise<void> {
    const pending = this.destroying.get(adapter) ?? new Map<string, Promise<void>>()
    this.destroying.set(adapter, pending)
    const existing = pending.get(id)
    if (existing) return existing
    const raw = Promise.resolve().then(() => adapter.destroySession(id, config)).then(() => {
      this.sessions.get(adapter)?.delete(id)
    })
    pending.set(id, raw)
    void raw.then(() => pending.delete(id), () => pending.delete(id))
    return this.own(raw)
  }

  shutdown(): void { this.closing = true }

  async close(): Promise<void> {
    this.shutdown()
    while (this.raw.size) await Promise.allSettled([...this.raw])
    const results = await Promise.allSettled([
      ...[...this.sessions].flatMap(([adapter, sessions]) => [...sessions].map(([id, config]) => this.destroy(adapter, id, config))),
      ...[...this.adapters].map(adapter => adapter.closeOwnedSessions?.())
    ])
    if (results.some(result => result.status === 'rejected')) throw new Error('PRODUCTION_ADAPTER_CLEANUP_FAILED')
    while (this.raw.size) await Promise.allSettled([...this.raw])
    if ([...this.sessions.values()].some(sessions => sessions.size)) throw new Error('PRODUCTION_ADAPTER_CLEANUP_UNACKNOWLEDGED')
  }
}

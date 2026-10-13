import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type { AdapterContextUsage, AdapterTokenUsage, CodingAgentAdapter, SessionConfig, SessionMessage } from '../adapters/coding-agent-adapter'
import { MessagePartType } from '../adapters/coding-agent-adapter'
import { ManagedSessionObserver } from './managed-session'
import { modelContextWindow } from './model-windows'
import { SESSION_PROCESS_RUN_ID, TokenAccounting } from './token-accounting'
import { reportedUsageFigures } from './token-estimator'
import type { CaptainWakeDisposition } from './roles/captain'

/** Backend-held context and raw operations stay with the adapter. This engine
 * commits managed evidence before prompt dispatch; the existing durable start,
 * delivery and provider-recovery stores remain sole effect/retry owners. The
 * event inbox projects evidence only and never replays an operation. */
export class AdapterEngine {
  private closed = false
  private readonly aliases = new Map<string, string>()
  private readonly observer: ManagedSessionObserver
  private readonly accounting: TokenAccounting
  private readonly freshSessions = new Set<string>()
  private readonly usage = new Map<string, { usageId: string; ownerId: string; backendId: string; intentId: string;
    attempt: number; dispatchedAt: number; baselineContextKey?: string; baselineTurnId?: string;
    allowNativeFirstTurn: boolean; output: Map<string, number> }>()
  constructor(private readonly db: Database.Database, private readonly processRunId: string = SESSION_PROCESS_RUN_ID, readonly role: 'captain' | 'task' = 'captain') {
    this.observer = new ManagedSessionObserver(db, processRunId)
    this.accounting = new TokenAccounting(db, console.log, processRunId)
  }

  get enabled(): boolean {
    if (this.closed) return false
    const setting = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`sessions.${this.role}_managed`) as { value: string } | undefined
    return ['1', 'true'].includes(setting?.value.trim().toLowerCase() ?? '')
  }

  generationKey(backendId: string, ownerId?: string): string {
    if (!ownerId) return `adapter:${backendId}`
    const alias = this.aliases.get(JSON.stringify([ownerId, backendId]))
    if (alias) return alias
    const prior = this.db.prepare('SELECT generation_key FROM session_generations WHERE owner_id=? AND backend_id=? ORDER BY created_at DESC LIMIT 1')
      .get(ownerId, backendId) as { generation_key: string } | undefined
    return prior?.generation_key ?? `adapter:${backendId}`
  }

  async reconcileStartup(): Promise<void> {
    if (this.enabled) { this.accounting.reconcileInterrupted(); await this.observer.reconcileStartup(true) }
  }

  observe(ownerId: string, backendId: string | undefined, eventType: string, identity: string, payload: unknown,
    turnKey?: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    return this.observer.observe({ ownerId, backendId, generationKey: backendId ? this.generationKey(backendId, ownerId) : `${this.role}:${ownerId}:inbox`,
      engine: 'adapter', turnKey, eventType, idempotencyKey: identity, payload }, true)
  }

  async createSession(ownerId: string, adapter: CodingAgentAdapter, config: SessionConfig): Promise<string> {
    this.assertOpen()
    const backendId = await adapter.createSession(config)
    await this.observe(ownerId, backendId, 'session_started', `${this.role}:${ownerId}:${backendId}:started`,
      { model: config.model ?? null, contextWindow: modelContextWindow(config.model ?? ''), contextOwner: 'backend' })
    if (!this.closed) {
      this.freshSessions.add(JSON.stringify([ownerId, backendId]))
      if (this.freshSessions.size > 5000) this.freshSessions.delete(this.freshSessions.values().next().value!)
    }
    return backendId
  }

  async resumeSession(ownerId: string, backendId: string, adapter: CodingAgentAdapter, config: SessionConfig): Promise<SessionMessage[]> {
    this.assertOpen()
    this.freshSessions.delete(JSON.stringify([ownerId, backendId]))
    const history = await adapter.resumeSession(backendId, config)
    // A fresh resume observation refreshes lifetime ownership without sending
    // history or any new prompt back to the backend.
    await this.observe(ownerId, backendId, 'session_resumed', `${this.role}:${ownerId}:${backendId}:resumed:${this.processRunId}`,
      { model: config.model ?? null, contextWindow: modelContextWindow(config.model ?? ''), contextOwner: 'backend' })
    return history
  }

  async sendPrompt(ownerId: string, backendId: string, intentId: string, attempt: number, prompt: string,
    adapter: CodingAgentAdapter, config: SessionConfig, maySend: () => void): Promise<void> {
    this.assertOpen()
    const priorAttempt = this.usage.get(this.usageKey(ownerId, intentId))
    if (priorAttempt && priorAttempt.attempt !== attempt) {
      await this.finishTurn(ownerId, priorAttempt.backendId, intentId, 'error')
      this.assertOpen(); maySend()
    }
    const turnKey = this.attemptKey(intentId, attempt)
    const startedKey = `${this.role}:${ownerId}:${backendId}:${turnKey}:started`
    const prior = this.db.prepare('SELECT owner_id, generation_key, event_type FROM session_event_inbox WHERE idempotency_key=?').get(startedKey) as
      { owner_id: string; generation_key: string; event_type: string } | undefined
    if (prior) {
      if (prior.owner_id !== ownerId || prior.generation_key !== this.generationKey(backendId, ownerId) || prior.event_type !== 'turn_started')
        throw new Error('Managed adapter turn identity belongs to another generation')
    } else await this.observe(ownerId, backendId, 'turn_started', startedKey, { kind: this.role, input: prompt }, turnKey)
    await this.observe(ownerId, backendId, 'prompt_dispatching', `${this.role}:${ownerId}:${backendId}:${intentId}:dispatch:${attempt}`,
      { attempt, promptHash: createHash('sha256').update(prompt).digest('hex') }, turnKey)
    this.assertOpen()
    maySend()
    // A read-only baseline distinguishes new native occupancy from a late
    // report belonging to the previous turn. It never becomes billing usage.
    let baseline: AdapterContextUsage | null = null
    try { baseline = await adapter.getContextUsage?.(backendId, config) ?? null } catch (error) {
      console.error('[Sessions] Adapter usage baseline failed:', error)
    }
    this.assertOpen(); maySend()
    const key = this.usageKey(ownerId, intentId)
    const previous = this.usage.get(key)
    if (previous) this.accounting.finishAdapterAttempt(previous.usageId, previous.attempt, this.outputCharacters(previous.output), 'error')
    const usageId = `adapter:${this.role}:${ownerId}:${this.generationKey(backendId, ownerId)}:${intentId}`
    this.accounting.beginAdapterTurn(usageId, ownerId, { id: 'adapter', model: config.model ?? '', contextWindow: modelContextWindow(config.model ?? '') ?? undefined }, prompt.length, attempt)
    const allowNativeFirstTurn = this.freshSessions.delete(JSON.stringify([ownerId, backendId]))
    this.usage.set(key, { usageId, ownerId, backendId, intentId, attempt, dispatchedAt: Date.now(), baselineContextKey: baseline?.eventKey,
      baselineTurnId: baseline?.turnId, allowNativeFirstTurn, output: new Map() })
    await adapter.sendPrompt(backendId, [{ type: MessagePartType.TEXT, text: prompt }], config)
    await this.observe(ownerId, backendId, 'prompt_accepted', `${this.role}:${ownerId}:${backendId}:${intentId}:accepted:${attempt}`, { attempt }, turnKey)
  }

  finishTurn(ownerId: string, backendId: string, intentId: string, stopReason: 'end_turn' | 'error' | 'cancelled' | 'interrupted'): Promise<void> {
    if (this.closed) return Promise.resolve()
    const key = this.usageKey(ownerId, intentId)
    const usage = this.usage.get(key)
    if (usage && usage.backendId !== backendId) return Promise.resolve()
    const turnKey = this.attemptKey(intentId, usage?.attempt ?? 0)
    if (usage) {
      const state = stopReason === 'end_turn' ? 'completed' : stopReason
      this.accounting.finishAdapterAttempt(usage.usageId, usage.attempt, this.outputCharacters(usage.output), state)
      this.accounting.finishTurn(usage.usageId, state)
      this.usage.delete(key)
    }
    return this.observe(ownerId, backendId, 'turn_done', `${this.role}:${ownerId}:${backendId}:${turnKey}:done`, { stopReason }, turnKey)
  }

  recordWake(ownerId: string, backendId: string | undefined, identity: string, message: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    // Repeated receipt preserves the first durable generation/payload. Delivery
    // Store uses this same identity to resolve the original accepted effect.
    const key = `${identity}:received`
    const prior = this.db.prepare('SELECT owner_id, event_type FROM session_event_inbox WHERE idempotency_key=?').get(key) as { owner_id: string; event_type: string } | undefined
    if (prior) {
      if (prior.owner_id !== ownerId || prior.event_type !== 'wake_received') throw new Error('Captain wake identity belongs to another owner')
      return Promise.resolve()
    }
    return this.observe(ownerId, backendId, 'wake_received', key, { message, deliveryId: identity })
  }

  recordWakeDisposition(ownerId: string, backendId: string | undefined, identity: string, disposition: CaptainWakeDisposition,
    count: number): Promise<void> {
    if (this.closed) return Promise.resolve()
    const prior = this.db.prepare('SELECT owner_id, payload FROM session_event_inbox WHERE idempotency_key=?')
      .get(`${identity}:disposition:${disposition}`) as { owner_id: string; payload: string } | undefined
    if (prior) {
      if (prior.owner_id !== ownerId || JSON.parse(prior.payload).count !== count) throw new Error('Captain disposition identity belongs to another batch')
      return Promise.resolve()
    }
    return this.observe(ownerId, backendId, 'wake_disposition', `${identity}:disposition:${disposition}`, { disposition, count, deliveryId: identity })
  }

  rekeySession(ownerId: string, previousId: string, backendId: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    const generationKey = this.generationKey(previousId, ownerId)
    this.aliases.set(JSON.stringify([ownerId, backendId]), generationKey)
    if (this.freshSessions.delete(JSON.stringify([ownerId, previousId]))) this.freshSessions.add(JSON.stringify([ownerId, backendId]))
    for (const usage of this.usage.values()) if (usage.ownerId === ownerId && usage.backendId === previousId) usage.backendId = backendId
    return this.observe(ownerId, backendId, 'session_rekeyed', `${this.role}:${ownerId}:${previousId}:rekey:${backendId}`, { previousId, backendId })
  }

  shutdown(): void {
    if (this.closed) return
    try { this.accounting.shutdown() } finally {
      try { this.observer.shutdown() } finally { this.closed = true; this.aliases.clear(); this.freshSessions.clear(); this.usage.clear() }
    }
  }

  /** One owned intent, one replaceable cumulative billing observation. A
   * native report requires fresh occupancy for that exact native turn, or
   * an adapter's explicit recovery-intent correlation. Unknown stays estimated. */
  async pollUsage(ownerId: string, backendId: string, intentId: string, adapter: CodingAgentAdapter, config: SessionConfig,
    context: AdapterContextUsage | null, mayObserve: () => boolean): Promise<void> {
    if (this.closed) return
    const key = this.usageKey(ownerId, intentId)
    const owned = this.usage.get(key)
    if (!owned || owned.backendId !== backendId) return
    let reported: AdapterTokenUsage | null = null
    try { reported = await adapter.getUsage?.(backendId, config) ?? null } catch (error) {
      console.error('[Sessions] Adapter billing observation failed:', error)
    }
    if (this.closed || !mayObserve() || this.usage.get(key) !== owned || owned.backendId !== backendId) return
    const correlated = reported?.turnId === intentId || Boolean(reported?.turnId && context?.turnId === reported.turnId
      && context.backendSessionId === backendId && context.observedAt >= owned.dispatchedAt && context.eventKey !== owned.baselineContextKey
      && (owned.baselineTurnId ? context.turnId !== owned.baselineTurnId : owned.allowNativeFirstTurn))
    this.accounting.observeAdapterUsage(owned.usageId, owned.attempt, this.outputCharacters(owned.output),
      correlated && reported?.provenance === 'reported' ? reportedUsageFigures(reported) : null)
  }

  recordOutput(ownerId: string, backendId: string, intentId: string, parts: Array<{ id: string; role: string; content: string; tool?: unknown }>): void {
    if (this.closed) return
    const usage = this.usage.get(this.usageKey(ownerId, intentId))
    if (!usage || usage.backendId !== backendId) return
    for (const part of parts) {
      if (part.role !== 'assistant') continue
      // Adapter updates replace the same durable part; repeated polls must
      // not add its cumulative text again. Match the transcript projection.
      if (usage.output.size < 5000 || usage.output.has(part.id)) usage.output.set(part.id,
        part.content.length + (part.tool && typeof part.tool === 'object'
          ? JSON.stringify({ name: (part.tool as { name?: string }).name, input: (part.tool as { input?: unknown }).input }).length : 0))
    }
    this.accounting.observeAdapterUsage(usage.usageId, usage.attempt, this.outputCharacters(usage.output), null)
  }

  private attemptKey(intentId: string, attempt: number): string { return attempt ? `${intentId}:attempt:${attempt}` : intentId }
  private usageKey(ownerId: string, intentId: string): string { return JSON.stringify([ownerId, intentId]) }
  private outputCharacters(parts: Map<string, number>): number { return [...parts.values()].reduce((sum, count) => sum + count, 0) }

  private assertOpen(): void { if (this.closed) throw new Error(`${this.role.toUpperCase()}_ENGINE_CLOSED`) }
}

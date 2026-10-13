import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import type { CodingAgentAdapter, SessionConfig, SessionMessage } from '../adapters/coding-agent-adapter'
import { MessagePartType } from '../adapters/coding-agent-adapter'
import { ManagedSessionObserver } from './managed-session'
import { modelContextWindow } from './model-windows'
import { SESSION_PROCESS_RUN_ID } from './token-accounting'
import type { CaptainWakeDisposition } from './roles/captain'

/** Backend-held context and raw operations stay with the adapter. This engine
 * commits managed evidence before prompt dispatch; the existing durable start,
 * delivery and provider-recovery stores remain sole effect/retry owners. The
 * event inbox projects evidence only and never replays an operation. */
export class AdapterEngine {
  private closed = false
  private readonly aliases = new Map<string, string>()
  private readonly observer: ManagedSessionObserver
  constructor(private readonly db: Database.Database, private readonly processRunId: string = SESSION_PROCESS_RUN_ID) {
    this.observer = new ManagedSessionObserver(db, processRunId)
  }

  get enabled(): boolean {
    if (this.closed) return false
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'sessions.captain_managed'").get() as { value: string } | undefined
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
    if (this.enabled) await this.observer.reconcileStartup(true)
  }

  observe(ownerId: string, backendId: string | undefined, eventType: string, identity: string, payload: unknown,
    turnKey?: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    return this.observer.observe({ ownerId, backendId, generationKey: backendId ? this.generationKey(backendId, ownerId) : `captain:${ownerId}:inbox`,
      engine: 'adapter', turnKey, eventType, idempotencyKey: identity, payload }, true)
  }

  async createSession(ownerId: string, adapter: CodingAgentAdapter, config: SessionConfig): Promise<string> {
    this.assertOpen()
    const backendId = await adapter.createSession(config)
    await this.observe(ownerId, backendId, 'session_started', `captain:${ownerId}:${backendId}:started`,
      { model: config.model ?? null, contextWindow: modelContextWindow(config.model ?? ''), contextOwner: 'backend' })
    return backendId
  }

  async resumeSession(ownerId: string, backendId: string, adapter: CodingAgentAdapter, config: SessionConfig): Promise<SessionMessage[]> {
    this.assertOpen()
    const history = await adapter.resumeSession(backendId, config)
    // A fresh resume observation refreshes lifetime ownership without sending
    // history or any new prompt back to the backend.
    await this.observe(ownerId, backendId, 'session_resumed', `captain:${ownerId}:${backendId}:resumed:${this.processRunId}`,
      { model: config.model ?? null, contextWindow: modelContextWindow(config.model ?? ''), contextOwner: 'backend' })
    return history
  }

  async sendPrompt(ownerId: string, backendId: string, intentId: string, attempt: number, prompt: string,
    adapter: CodingAgentAdapter, config: SessionConfig, maySend: () => void): Promise<void> {
    this.assertOpen()
    const startedKey = `captain:${ownerId}:${backendId}:${intentId}:started`
    const prior = this.db.prepare('SELECT owner_id, generation_key, event_type FROM session_event_inbox WHERE idempotency_key=?').get(startedKey) as
      { owner_id: string; generation_key: string; event_type: string } | undefined
    if (prior) {
      if (prior.owner_id !== ownerId || prior.generation_key !== this.generationKey(backendId, ownerId) || prior.event_type !== 'turn_started')
        throw new Error('Captain turn identity belongs to another generation')
    } else await this.observe(ownerId, backendId, 'turn_started', startedKey, { kind: 'captain', input: prompt }, intentId)
    await this.observe(ownerId, backendId, 'prompt_dispatching', `captain:${ownerId}:${backendId}:${intentId}:dispatch:${attempt}`,
      { attempt, promptHash: createHash('sha256').update(prompt).digest('hex') }, intentId)
    this.assertOpen()
    maySend()
    await adapter.sendPrompt(backendId, [{ type: MessagePartType.TEXT, text: prompt }], config)
    await this.observe(ownerId, backendId, 'prompt_accepted', `captain:${ownerId}:${backendId}:${intentId}:accepted:${attempt}`, { attempt }, intentId)
  }

  finishTurn(ownerId: string, backendId: string, intentId: string, stopReason: 'end_turn' | 'error' | 'cancelled' | 'interrupted'): Promise<void> {
    return this.observe(ownerId, backendId, 'turn_done', `captain:${ownerId}:${backendId}:${intentId}:done`, { stopReason }, intentId)
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
    return this.observe(ownerId, backendId, 'session_rekeyed', `captain:${ownerId}:${previousId}:rekey:${backendId}`, { previousId, backendId })
  }

  shutdown(): void {
    if (this.closed) return
    try { this.observer.shutdown() } finally { this.closed = true; this.aliases.clear() }
  }

  private assertOpen(): void { if (this.closed) throw new Error('CAPTAIN_ENGINE_CLOSED') }
}

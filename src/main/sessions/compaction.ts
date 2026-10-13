import { createHash } from 'node:crypto'
import { MessagePartType, type MessagePart, type AdapterContextUsage } from '../adapters/coding-agent-adapter'

export interface AdapterCompactionObservation {
  backendSessionId: string
  backend: string
  eventKey: string
  source: 'explicit' | 'context_drop'
  signal: string
  observedAt: number
  turnId?: string
  beforeTokens?: number
  afterTokens?: number
}

const positiveTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export function compactionFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
}

/** Per-backend-session observations only. This class never controls sessions,
 * writes a handoff or treats aggregate billing totals as context occupancy. */
export class AdapterCompactionTracker {
  private sessionId: string | null = null
  private previous: { key: string; tokens: number; turnId?: string } | null = null
  private readonly observations = new Map<string, AdapterCompactionObservation>()
  private pendingExplicit: string | null = null
  private lastDrop: string | null = null
  private context: AdapterContextUsage | null = null
  constructor(private readonly backend: string, private readonly now: () => number = Date.now) {}

  bindSession(sessionId: string): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.previous = null
    this.observations.clear()
    this.pendingExplicit = null
    this.lastDrop = null
    this.context = null
  }

  observeExplicit(sessionId: string, eventKey: string, signal: string, details: { turnId?: string; beforeTokens?: number; afterTokens?: number } = {}): void {
    if (!sessionId || !eventKey) return
    this.bindSession(sessionId)
    if (this.observations.has(`explicit:${eventKey}`)) return
    const drop = this.lastDrop ? this.observations.get(this.lastDrop) : undefined
    // A late explicit signal corroborates the drop already observed in the
    // same request; it must not create a second divider for that compaction.
    if (drop && details.turnId && drop.turnId === details.turnId &&
        (details.beforeTokens === undefined || details.beforeTokens === drop.beforeTokens) &&
        (details.afterTokens === undefined || details.afterTokens === drop.afterTokens)) {
      drop.signal = signal
      return
    }
    const key = `explicit:${eventKey}`
    if (positiveTokens(details.afterTokens)) this.context = { backendSessionId: sessionId, eventKey: key,
      tokens: details.afterTokens, provenance: 'reported', observedAt: this.now(), turnId: details.turnId }
    this.add(key, { backendSessionId: sessionId, backend: this.backend, eventKey: key, source: 'explicit', signal, observedAt: this.now(),
      ...(details.turnId ? { turnId: details.turnId } : {}),
      ...(positiveTokens(details.beforeTokens) ? { beforeTokens: details.beforeTokens } : this.previous ? { beforeTokens: this.previous.tokens } : {}),
      ...(positiveTokens(details.afterTokens) ? { afterTokens: details.afterTokens } : {}) })
    this.pendingExplicit = key
    this.lastDrop = null
  }

  observeContext(sessionId: string, eventKey: string, tokens: unknown, turnId?: string): void {
    if (!sessionId || !eventKey || !positiveTokens(tokens)) return
    this.bindSession(sessionId)
    const previous = this.previous
    if (previous?.key === eventKey) return
    this.context = { backendSessionId: sessionId, eventKey, tokens, provenance: 'reported', observedAt: this.now(), turnId }
    this.previous = { key: eventKey, tokens, turnId }
    const explicit = this.pendingExplicit ? this.observations.get(this.pendingExplicit) : undefined
    this.pendingExplicit = null
    if (!previous || tokens * 100 >= previous.tokens * 60) {
      this.lastDrop = null
      return
    }
    if (explicit && (!explicit.turnId || !turnId || explicit.turnId === turnId)) {
      explicit.afterTokens = tokens
      return
    }
    const key = `drop:${compactionFingerprint([previous.key, eventKey, previous.tokens, tokens])}`
    this.add(key, { backendSessionId: sessionId, backend: this.backend, eventKey: key, source: 'context_drop', signal: 'context_drop', observedAt: this.now(),
      ...(turnId ? { turnId } : {}), beforeTokens: previous.tokens, afterTokens: tokens })
    this.lastDrop = key
  }

  /** Read-only, bounded snapshots can be polled repeatedly without consuming evidence. */
  snapshot(sessionId: string): AdapterCompactionObservation[] {
    if (sessionId !== this.sessionId) return []
    return [...this.observations.values()].map((observation) => ({ ...observation }))
  }

  contextSnapshot(sessionId: string): AdapterContextUsage | null {
    return sessionId === this.sessionId && this.context ? { ...this.context } : null
  }

  private add(key: string, observation: AdapterCompactionObservation): void {
    if (!this.observations.has(key)) this.observations.set(key, observation)
    while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!)
  }
}

/** Prompt occupancy, including cache tokens only for backends whose input
 * figure excludes them. Never use turn/session aggregate usage for fallback. */
export function promptContextTokens(raw: unknown, backend: 'claude-code' | 'codex' | 'opencode' | 'pi'): number | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as Record<string, unknown>
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.input
  if (!positiveTokens(input) && input !== 0) return null
  if (backend === 'codex') return positiveTokens(input) ? input : null
  const cache = usage.cache && typeof usage.cache === 'object' ? usage.cache as Record<string, unknown> : {}
  const read = usage.cache_read_input_tokens ?? usage.cacheRead ?? cache.read ?? 0
  const write = usage.cache_creation_input_tokens ?? usage.cacheWrite ?? cache.write ?? 0
  if ((read !== 0 && !positiveTokens(read)) || (write !== 0 && !positiveTokens(write))) return null
  const total = Number(input) + Number(read) + Number(write)
  return positiveTokens(total) ? total : null
}

export interface CompactionScope {
  ownerId: string
  generationKey: string
  backendSessionId: string
  generationStartedAt?: number
  backend?: string
}

export interface NormalizedCompaction {
  idempotencyKey: string
  eventType: 'compaction'
  payload: AdapterCompactionObservation & { continuity: 'backend_session_only' }
  part: MessagePart
}

/** The root owns ledger/transcript projection. One observation produces one
 * stable effect in its original owner/generation, never cross-session memory. */
export class CompactionNormalizer {
  private readonly bindings = new Map<string, { generationKey: string; effect: NormalizedCompaction; acknowledged: boolean }>()
  observe(observation: AdapterCompactionObservation, scope: CompactionScope): NormalizedCompaction | null {
    if (!scope.ownerId || !scope.generationKey || observation.backendSessionId !== scope.backendSessionId ||
        (scope.backend !== undefined && observation.backend !== scope.backend) ||
        !observation.eventKey || !Number.isFinite(observation.observedAt) ||
        (scope.generationStartedAt !== undefined && observation.observedAt < scope.generationStartedAt)) return null
    const identity = compactionFingerprint([scope.ownerId, scope.backendSessionId, observation.backend, observation.eventKey])
    const binding = this.bindings.get(identity)
    if (binding) return binding.acknowledged || binding.generationKey !== scope.generationKey ? null : this.copy(binding.effect)
    const idempotencyKey = `compaction:${compactionFingerprint([scope.ownerId, scope.generationKey, identity])}`
    const text = observation.source === 'explicit'
      ? 'The agent condensed earlier conversation to make room for more work. It is continuing in the same session.'
      : 'Context usage dropped by more than 40%, suggesting compaction. The agent is continuing in the same session.'
    const effect: NormalizedCompaction = { idempotencyKey, eventType: 'compaction', payload: { ...observation, continuity: 'backend_session_only' },
      part: { id: idempotencyKey, type: MessagePartType.COMPACTION, role: 'system', text, receivedAt: observation.observedAt } }
    this.bindings.set(identity, { generationKey: scope.generationKey, effect, acknowledged: false })
    // Pending effects must survive projection failures. Evict only completed
    // identities; the adapter itself bounds outstanding observations.
    if (this.bindings.size > 5_000) {
      for (const [key, value] of this.bindings) {
        if (value.acknowledged) this.bindings.delete(key)
        if (this.bindings.size <= 5_000) break
      }
    }
    return this.copy(effect)
  }

  /** Call only after both durable transcript and ledger projections succeed. */
  acknowledge(idempotencyKey: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.effect.idempotencyKey === idempotencyKey) {
        binding.acknowledged = true
        return
      }
    }
  }

  private copy(effect: NormalizedCompaction): NormalizedCompaction {
    return { ...effect, payload: { ...effect.payload }, part: { ...effect.part } }
  }
}

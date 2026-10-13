import type { AgentRecord, DatabaseManager } from '../database/manager'
import type { ChatSettingsSource } from '../chat/provider-factory'
import { CHAT_SETTING_KEYS } from '../../shared/chat'
import type { ChatProvider } from '../chat/providers/types'
import { managedVerbatimTokens } from '../commander/context'
import { SessionContextService } from './context-service'
import { evaluateRollover, readRolloverPolicy, rolloverStageEnabled } from './compaction-policy'
import { HandoffEngine, handoffSeed, HANDOFF_SUMMARY_MAX_TOKENS, type HandoffInput, type HandoffRecord, type HandoffTurn } from './handoff'
import { estimateTokens } from './token-estimator'
import { SESSION_PROCESS_RUN_ID } from './token-accounting'

/** The shim exposes exactly the source model's agent and vendor auth. Saved
 * Commander selection, endpoint and effort settings cannot change that model. */
export function captainSummarySettings(source: Pick<DatabaseManager, 'getSetting'>, agent: AgentRecord, model: string): ChatSettingsSource {
  const snapshot: AgentRecord = structuredClone(agent)
  snapshot.config.model = model
  snapshot.is_default = true
  const ignored = new Set<string>(Object.values(CHAT_SETTING_KEYS))
  return { getAgents: () => [snapshot], getSetting: (key) => ignored.has(key) ? undefined : source.getSetting(key) }
}

/** Frozen source stays lossless. A later source edit/new instruction is copied
 * in full into the stable seed; inability to fit pauses binding, never clips. */
export function captainRolloverSeed(record: HandoffRecord, current: HandoffTurn[]): string {
  const frozen = new Map(record.source.turns.map((turn) => [turn.id, JSON.stringify(turn)]))
  const tail = current.filter((turn) => frozen.get(turn.id) !== JSON.stringify(turn))
  const seed = 'Load this continuity context only. Do not run tools or continue work until the next explicit user message or project wake-up. Do not repeat completed actions.\n\n' + handoffSeed(record)
    + (tail.length ? `\n\nAdditional source work since the frozen handoff (instructions and outcomes retained verbatim):\n${JSON.stringify(tail)}` : '')
  if (estimateTokens(seed.length) > managedVerbatimTokens(record.model))
    throw new Error('Captain rollover paused: the summary and newer source work cannot fit safely. Full source, pending handoff and accepted backend identity are retained.')
  return seed
}

export interface CaptainRolloverSource extends HandoffInput { agent: AgentRecord; agentId?: string; codingAgent?: string }
export interface CaptainRolloverCallbacks {
  mayContinue(): boolean
  verifyIdle?(): Promise<boolean>
  createGeneration(record: { handoffId: string; nextGenerationKey: string; source: HandoffInput }): Promise<{ backendId: string }>
  bindGeneration(record: HandoffRecord, signal: AbortSignal): Promise<void>
  notice(record: HandoffRecord | null, message: string): void
}

/** Existing task-send ownership protects this runner. HandoffEngine owns the
 * durable checkpoints and accepted native identity; this class owns only its
 * lifetime signal and exact source-model summary transport. */
export class CaptainRollover {
  private closed = false
  private readonly active = new Map<string, AbortController>()
  private readonly handoffs: HandoffEngine
  private readonly contexts: SessionContextService
  constructor(private readonly source: Pick<DatabaseManager, 'db' | 'getTask' | 'getAgent' | 'getSetting'>,
    private readonly providerFactory?: (source: ChatSettingsSource) => ChatProvider | Promise<ChatProvider>) {
    this.handoffs = new HandoffEngine(source.db, SESSION_PROCESS_RUN_ID)
    this.contexts = new SessionContextService(source)
  }

  cancel(ownerId: string): void { this.active.get(ownerId)?.abort() }
  shutdown(): void { this.closed = true; for (const signal of this.active.values()) signal.abort() }
  get activationEnabled(): boolean {
    return !this.closed && readRolloverPolicy(this.source.db).mode === 'on' && rolloverStageEnabled(this.source.db, 'captain')
  }
  pendingCreated(ownerId: string): HandoffRecord | null {
    const record = this.pendingCreation(ownerId)
    return record?.state === 'created' ? record : null
  }
  pendingCreation(ownerId: string): HandoffRecord | null {
    if (this.closed) return null
    const row = this.source.db.prepare("SELECT generation_key FROM session_handoffs WHERE owner_id=? AND state IN ('created','creating','creation_unconfirmed') ORDER BY created_at DESC LIMIT 1")
      .get(ownerId) as { generation_key: string } | undefined
    return row ? this.handoffs.get(ownerId, row.generation_key) : null
  }

  async consider(input: CaptainRolloverSource, callbacks: CaptainRolloverCallbacks): Promise<HandoffRecord | null> {
    if (this.closed || this.active.has(input.ownerId)) return null
    const policy = readRolloverPolicy(this.source.db)
    if (policy.mode === 'off') return null
    const snapshot = this.contexts.getSnapshot({ kind: 'captain', ownerId: input.ownerId })
    const decision = evaluateRollover({ contextTokens: snapshot.usage.tokens, contextWindow: snapshot.usage.contextWindow,
      compactions: snapshot.counters.compactions, wakeups: snapshot.counters.wakeups, turns: snapshot.counters.turns,
      generationStartedAt: snapshot.generation?.createdAt ?? Date.now(), activeTurn: !callbacks.mayContinue() }, policy,
      rolloverStageEnabled(this.source.db, 'captain'))
    this.handoffs.recordDecision(input, decision)
    const pending = this.source.db.prepare("SELECT generation_key FROM session_handoffs WHERE owner_id=? AND state != 'completed' ORDER BY created_at DESC LIMIT 1")
      .get(input.ownerId) as { generation_key: string } | undefined
    if (decision.action !== 'rollover' && !pending) return null
    if (policy.mode !== 'on' || !rolloverStageEnabled(this.source.db, 'captain') || !callbacks.mayContinue()) return null
    if (callbacks.verifyIdle && (!await callbacks.verifyIdle() || !callbacks.mayContinue())) return null
    const retained = pending ? this.handoffs.get(input.ownerId, pending.generation_key) : null
    const { agent, ...freshSource } = input
    const frozen = retained?.source ?? { ...freshSource, reasons: decision.reasons }
    const signal = new AbortController()
    this.active.set(input.ownerId, signal)
    const lifetimeValid = (): boolean => !this.closed && callbacks.mayContinue()
      && this.activationEnabled
    const guard = (): void => {
      if (!lifetimeValid()) signal.abort()
      signal.signal.throwIfAborted()
    }
    try {
      const result = await this.handoffs.run(frozen, {
        signal: signal.signal,
        summarize: async ({ model, prompt }) => {
          guard()
          if (estimateTokens(prompt.length) > managedVerbatimTokens(model)) throw new Error('Summary source exceeds the own-model request budget')
          if (!this.providerFactory) throw new Error('The own-model summary provider is unavailable in this host')
          guard()
          const provider = await this.providerFactory(captainSummarySettings(this.source, agent, model))
          guard()
          if (provider.model !== model) throw new Error('Summary provider changed the source model')
          const timeout = AbortSignal.any([signal.signal, AbortSignal.timeout(20_000)])
          let text = ''
          for await (const event of provider.stream({ system: 'Summarize the retained conversation only. Never execute tools.',
            messages: [{ role: 'user', content: prompt }], tools: [], toolChoice: 'none', maxTokens: HANDOFF_SUMMARY_MAX_TOKENS }, timeout)) {
            timeout.throwIfAborted()
            if (event.type === 'tool_call') throw new Error('Summary returned a tool call')
            if (event.type === 'text_delta') text += event.text
            if (estimateTokens(text.length) > HANDOFF_SUMMARY_MAX_TOKENS) throw new Error('Summary exceeds continuity budget')
          }
          guard()
          return text
        },
        createGeneration: async ({ handoffId, nextGenerationKey }) => {
          guard()
          const accepted = await callbacks.createGeneration({ handoffId, nextGenerationKey, source: frozen })
          // Return the accepted identity even on lifetime loss: HandoffEngine
          // persists it before honoring cancellation, without binding/seeding.
          if (!lifetimeValid()) signal.abort()
          return accepted
        },
        bindGeneration: async (record) => { guard(); await callbacks.bindGeneration(record, signal.signal) },
        afterStep: (step) => {
          // creation_accepted precedes HandoffEngine's saveCreated checkpoint;
          // throwing there could lose an accepted native identity.
          if (step !== 'creation_accepted' && step !== 'completed') guard()
        }
      })
      if (result.state === 'creation_unconfirmed') callbacks.notice(result, result.notice ?? 'The new backend identity is unconfirmed. Creation will not be repeated; the source history is retained.')
      return result
    } catch (error) {
      if (!this.closed && !signal.signal.aborted) callbacks.notice(this.handoffs.get(frozen.ownerId, frozen.generationKey),
        error instanceof Error && error.message.startsWith('Captain rollover paused:') ? error.message : 'Captain rollover paused. Durable source and handoff progress are retained for a safe retry.')
      return null
    } finally { if (this.active.get(input.ownerId) === signal) this.active.delete(input.ownerId) }
  }
}

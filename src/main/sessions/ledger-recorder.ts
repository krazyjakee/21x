import type Database from 'better-sqlite3'
import { createId } from '@paralleldrive/cuid2'
import { isLedgerEnabled, settingReader } from './flags'
import {
  ownerKey,
  SessionLedger,
  type GenerationInfo,
  type SessionOwner,
  type SummaryKind,
  type SummaryStatus,
  type TurnTrigger
} from './ledger'

/**
 * Record-only use of the ledger (flag `sessions.ledger`, managed sessions B3,
 * #99). The Commander and AgentManager still run their turns exactly as
 * before; they tell the recorder what happened and the recorder writes it to
 * the ledger. Until B4/B5 move them onto ManagedSession, nothing reads the
 * ledger back.
 *
 * Every method swallows its own failures: recording can never break a turn.
 * The flag is read when a turn starts; a turn that started while it was on is
 * recorded to its end even if it is switched off meanwhile.
 */

export interface TurnOutcomeInput {
  status: 'done' | 'failed' | 'interrupted'
  stopReason?: string | null
  errorKind?: string | null
  errorDetail?: string | null
}

function warn(what: string, err: unknown): void {
  console.warn(`[ManagedSession] could not record ${what}:`, err instanceof Error ? err.message : err)
}

export class SessionLedgerRecorder {
  readonly ledger: SessionLedger
  private readonly enabled: () => boolean

  constructor(private readonly source: { db: Database.Database }, options: { enabled?: () => boolean; now?: () => number; runnerId?: string } = {}) {
    this.ledger = new SessionLedger(source, options.now, { runnerId: options.runnerId })
    const read = settingReader(source)
    this.enabled = options.enabled ?? (() => isLedgerEnabled(read))
  }

  isEnabled(): boolean {
    try {
      // A structural DB double (some unit tests) has no SQLite handle.
      if (typeof this.source.db?.prepare !== 'function') return false
      return this.enabled()
    } catch {
      return false
    }
  }

  /**
   * A turn starts. Returns its ledger id, or null when the flag is off, the
   * event was already recorded (a repeat is a no-op), or recording failed.
   * With `retry`, a failed or interrupted turn with the same key runs again.
   */
  turnStarted(owner: SessionOwner, input: { dedupeKey: string; trigger: TurnTrigger; generation: GenerationInfo; retry?: boolean }): string | null {
    if (!this.isEnabled()) return null
    try {
      const { turn, started } = this.ledger.beginTurn(owner, input)
      if (started) return turn.id
      console.log(`[ManagedSession] owner=${ownerKey(owner)} event=duplicate key=${input.dedupeKey} status=${turn.status}: already recorded, ignored`)
      return null
    } catch (err) {
      warn('the turn start', err)
      return null
    }
  }

  toolCallStarted(turnId: string | null, call: { id: string; name: string }): void {
    if (!turnId || !call.id) return
    try {
      this.ledger.toolCallStarted(turnId, call)
    } catch (err) {
      warn('a tool call', err)
    }
  }

  toolCallFinished(turnId: string | null, call: { id: string; name?: string; isError?: boolean }): void {
    if (!turnId || !call.id) return
    try {
      this.ledger.toolCallFinished(turnId, call)
    } catch (err) {
      warn('a tool result', err)
    }
  }

  /** Links a `session_usage` row to the turn (B1's `turn_key`). */
  usage(turnId: string | null, usageTurnKey: string | null | undefined): void {
    if (!turnId || !usageTurnKey) return
    try {
      this.ledger.attachUsage(turnId, usageTurnKey)
    } catch (err) {
      warn('turn usage', err)
    }
  }

  turnEnded(turnId: string | null, outcome: TurnOutcomeInput, usageTurnKeys: ReadonlyArray<string | null | undefined> = []): void {
    if (!turnId) return
    try {
      for (const key of usageTurnKeys) if (key) this.ledger.attachUsage(turnId, key)
      this.ledger.finishTurn(turnId, outcome)
    } catch (err) {
      warn('the turn end', err)
    }
  }

  /** A fold, handoff or failed summary of the owner's current generation. */
  summary(owner: SessionOwner, generation: GenerationInfo, input: { kind: SummaryKind; dedupeKey: string; status?: SummaryStatus; coversThroughRef?: string | null; content: unknown }): void {
    if (!this.isEnabled()) return
    try {
      const gen = this.ledger.ensureGeneration(owner, generation)
      this.ledger.recordSummary(gen.id, input)
    } catch (err) {
      warn('a summary', err)
    }
  }

  rekey(owner: SessionOwner, oldId: string, newId: string): void {
    try {
      this.ledger.rekeyBackendSession(owner, oldId, newId)
    } catch (err) {
      warn('a backend session id', err)
    }
  }
}

/** Tool part statuses the adapters report, by outcome. Anything else is still running. */
const DONE_TOOL_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'finished'])
const ERROR_TOOL_STATUSES = new Set(['error', 'failed', 'failure', 'rejected', 'cancelled', 'canceled', 'denied'])

function toolStatus(tool: unknown): { name: string; state: 'running' | 'done' | 'error' } | null {
  if (!tool || typeof tool !== 'object') return null
  const record = tool as { name?: unknown; status?: unknown }
  const name = typeof record.name === 'string' && record.name ? record.name : 'tool'
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  if (DONE_TOOL_STATUSES.has(status)) return { name, state: 'done' }
  if (ERROR_TOOL_STATUSES.has(status)) return { name, state: 'error' }
  return { name, state: 'running' }
}

interface AdapterTurn {
  owner: SessionOwner
  turnId: string
  /** Tool part id → the last state written, so an unchanged poll writes nothing. */
  tools: Map<string, 'running' | 'done' | 'error'>
  usageKeys: Set<string>
}

/** One live adapter turn per session; a session that never ends a turn must not grow the map forever. */
const MAX_TRACKED_SESSIONS = 1_000

/**
 * The adapter side of the recorder: AgentManager reports by backend session
 * id (prompt sent, output polled, usage reported, idle or error, stop), and
 * this maps each session to its open ledger turn.
 */
export class AdapterLedgerTracker {
  private readonly turns = new Map<string, AdapterTurn>()

  constructor(private readonly recorder: SessionLedgerRecorder) {}

  /**
   * A prompt was sent to the session. A turn still open on it ends first
   * (`superseded`): the backend folds the new prompt into its conversation.
   */
  beginTurn(sessionId: string, owner: SessionOwner, input: { dedupeKey?: string | null; trigger: TurnTrigger; generation: GenerationInfo }): void {
    try {
      const open = this.turns.get(sessionId)
      if (open) this.endTurn(sessionId, { status: 'done', stopReason: 'superseded' })
      const turnId = this.recorder.turnStarted(owner, {
        dedupeKey: input.dedupeKey || `prompt:${createId()}`,
        trigger: input.trigger,
        generation: { ...input.generation, backendSessionId: input.generation.backendSessionId ?? sessionId },
        // A durable delivery retried after a failure is the same event.
        retry: Boolean(input.dedupeKey)
      })
      if (!turnId) return
      if (this.turns.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.turns.keys().next().value
        if (oldest !== undefined) this.turns.delete(oldest)
      }
      this.turns.set(sessionId, { owner, turnId, tools: new Map(), usageKeys: new Set() })
    } catch (err) {
      warn('an adapter turn', err)
    }
  }

  /** The session now goes by the id the backend gave it; its turn and generation follow. */
  rekey(oldSessionId: string, newSessionId: string, owner?: SessionOwner): void {
    if (oldSessionId === newSessionId) return
    const turn = this.turns.get(oldSessionId)
    if (turn) {
      this.turns.delete(oldSessionId)
      this.turns.set(newSessionId, turn)
    }
    const who = turn?.owner ?? owner
    if (who) this.recorder.rekey(who, oldSessionId, newSessionId)
  }

  /** Polled output: tool parts start and finish. Only a changed state is written. */
  addOutput(sessionId: string, messages: ReadonlyArray<{ id?: string; partType?: string; tool?: unknown }>): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    for (const message of messages) {
      if (!message.id || !message.tool) continue
      const tool = toolStatus(message.tool)
      if (!tool) continue
      const previous = turn.tools.get(message.id)
      if (previous === tool.state || (previous && previous !== 'running')) continue
      turn.tools.set(message.id, tool.state)
      if (tool.state === 'running') this.recorder.toolCallStarted(turn.turnId, { id: message.id, name: tool.name })
      else this.recorder.toolCallFinished(turn.turnId, { id: message.id, name: tool.name, isError: tool.state === 'error' })
    }
  }

  /** The adapter reported usage for the session's current turn. */
  usage(sessionId: string, usageTurnKey: string): void {
    const turn = this.turns.get(sessionId)
    if (!turn || !usageTurnKey) return
    turn.usageKeys.add(usageTurnKey)
    this.recorder.usage(turn.turnId, usageTurnKey)
  }

  /** The session's turn is over (idle, error or stopped). */
  endTurn(sessionId: string, outcome: TurnOutcomeInput, usageTurnKey?: string | null): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    this.turns.delete(sessionId)
    this.recorder.turnEnded(turn.turnId, outcome, usageTurnKey ? [usageTurnKey] : [])
  }

  /** The open ledger turn of a session (tests, diagnostics). */
  openTurn(sessionId: string): string | null {
    return this.turns.get(sessionId)?.turnId ?? null
  }
}

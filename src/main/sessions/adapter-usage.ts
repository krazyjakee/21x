import { createId } from '@paralleldrive/cuid2'
import type { AdapterUsageReport } from '../adapters/coding-agent-adapter'
import { contextWindowFor } from './model-windows'
import { calibrate, estimateCharTokens } from './token-estimator'
import type { SessionUsageInput, SessionUsageRecord, UsageOwnerKind } from './usage-store'

/**
 * Token accounting for Captains and task agents (managed sessions B1, #97).
 *
 * AgentManager tells the tracker when it sends a prompt, what text came back,
 * what usage the adapter reported, and when the session went idle. The
 * tracker records:
 *
 * - every usage report the adapter makes, as `reported`;
 * - for a turn that ended without any report (a backend that reports nothing,
 *   or a turn cut short), one `estimated` row. Its size is the prompt and
 *   output text at characters ÷ 3.5, plus, when the same backend session
 *   reported a context size earlier, that figure as the anchor: the context
 *   is then "last reported + what this turn added", corrected by the
 *   session's calibration ratio when there is one.
 *
 * Instrumentation only: every method swallows its own failures.
 */

export interface UsageOwner {
  ownerKind: UsageOwnerKind
  ownerId: string
  /** The coding agent type (`claude-code`, `codex`, `opencode`, …). */
  backend: string
  /** The model the agent is configured with; a report's own model wins. */
  model?: string | null
}

/** The part of SessionUsageStore the tracker needs. */
export interface AdapterUsageSink {
  record(input: SessionUsageInput): SessionUsageRecord | unknown
  latestReported(ownerKind: UsageOwnerKind, ownerId: string): Pick<SessionUsageRecord, 'contextTokens' | 'sessionId' | 'contextWindow' | 'windowSource'> | null
  calibration(ownerKind: UsageOwnerKind, ownerId: string): number | null
}

interface TurnState {
  key: string
  promptChars: number
  /** Longest content seen per output part: a streamed part is re-sent whole as it grows. */
  outputParts: Map<string, number>
  reported: boolean
}

/** Output kinds that are model-generated text (tool calls count through their content). */
const OUTPUT_ROLES = new Set(['assistant'])
/** A tracker entry per live session; sessions that never go idle must not grow the map forever. */
const MAX_TRACKED_TURNS = 1_000

export class AdapterUsageTracker {
  private readonly turns = new Map<string, TurnState>()

  constructor(private readonly sink: AdapterUsageSink) {}

  /** A prompt was sent to the session: a new turn starts. */
  beginTurn(sessionId: string, promptText: string): void {
    try {
      if (this.turns.size >= MAX_TRACKED_TURNS && !this.turns.has(sessionId)) {
        const oldest = this.turns.keys().next().value
        if (oldest !== undefined) this.turns.delete(oldest)
      }
      this.turns.set(sessionId, { key: createId(), promptChars: promptText.length, outputParts: new Map(), reported: false })
    } catch (err) {
      console.warn('[SessionUsage] beginTurn failed:', err)
    }
  }

  /** The session now goes by the id the backend gave it; its turn follows. */
  rekey(oldSessionId: string, newSessionId: string): void {
    const turn = this.turns.get(oldSessionId)
    if (!turn || oldSessionId === newSessionId) return
    this.turns.delete(oldSessionId)
    this.turns.set(newSessionId, turn)
  }

  /** Output the session produced during the turn (polled transcript messages). */
  addOutput(sessionId: string, messages: ReadonlyArray<{ id?: string; role?: string; content?: unknown }>): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    for (const message of messages) {
      if (message.role && !OUTPUT_ROLES.has(message.role)) continue
      if (typeof message.content !== 'string' || !message.content) continue
      const id = message.id || `anonymous-${turn.outputParts.size}`
      turn.outputParts.set(id, Math.max(turn.outputParts.get(id) ?? 0, message.content.length))
    }
  }

  /** The adapter reported usage for one of the session's turns. */
  report(owner: UsageOwner, report: AdapterUsageReport, canonicalSessionId = report.sessionId): void {
    try {
      const turn = this.turns.get(canonicalSessionId)
      if (turn) turn.reported = true
      const model = report.model || owner.model || null
      const window = contextWindowFor(model, { reported: report.contextWindow })
      const contextTokens = typeof report.contextTokens === 'number' && Number.isFinite(report.contextTokens) ? report.contextTokens : null
      this.sink.record({
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        sessionId: canonicalSessionId,
        turnKey: report.turnKey,
        engine: 'adapter',
        backend: owner.backend,
        model,
        source: 'reported',
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        cacheReadTokens: report.cacheReadTokens,
        cacheWriteTokens: report.cacheWriteTokens,
        reasoningTokens: report.reasoningTokens,
        contextTokens,
        contextSource: contextTokens === null ? null : 'reported',
        contextWindow: window.tokens,
        windowSource: window.source,
        costUsd: report.costUsd ?? null,
        modelCalls: report.modelCalls ?? null,
        stopReason: report.stopReason ?? null
      })
    } catch (err) {
      console.warn('[SessionUsage] could not record adapter usage:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * The session's turn is over (idle or failed). Records an estimated row when
   * the adapter reported nothing for it, then forgets the turn.
   */
  endTurn(sessionId: string, owner: UsageOwner, stopReason: string): void {
    const turn = this.turns.get(sessionId)
    this.turns.delete(sessionId)
    if (!turn || turn.reported) return
    try {
      const promptTokens = estimateCharTokens(turn.promptChars)
      let outputChars = 0
      for (const chars of turn.outputParts.values()) outputChars += chars
      const outputTokens = estimateCharTokens(outputChars)
      const ratio = this.sink.calibration(owner.ownerKind, owner.ownerId)
      const anchor = this.sink.latestReported(owner.ownerKind, owner.ownerId)
      // A context reported by another backend session says nothing about this one.
      const anchored = anchor && anchor.sessionId === sessionId && typeof anchor.contextTokens === 'number' ? anchor : null
      const contextTokens = anchored ? (anchored.contextTokens as number) + calibrate(promptTokens + outputTokens, ratio) : null
      const window = contextWindowFor(owner.model, { reported: anchored?.windowSource === 'reported' ? anchored.contextWindow : null })
      this.sink.record({
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        sessionId,
        turnKey: `estimated:${turn.key}`,
        engine: 'adapter',
        backend: owner.backend,
        model: owner.model ?? null,
        source: 'estimated',
        // Without an anchor only the new prompt is known: a lower bound.
        inputTokens: contextTokens ?? calibrate(promptTokens, ratio),
        outputTokens: calibrate(outputTokens, ratio),
        contextTokens,
        contextSource: contextTokens === null ? null : 'estimated',
        contextWindow: window.tokens,
        windowSource: window.source,
        stopReason
      })
    } catch (err) {
      console.warn('[SessionUsage] could not record estimated usage:', err instanceof Error ? err.message : err)
    }
  }
}

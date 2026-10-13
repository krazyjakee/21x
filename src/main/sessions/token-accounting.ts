import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { ChatProvider, ChatProviderRequest } from '../chat/providers/types'
import { modelContextWindow } from './model-windows'
import { CHARS_PER_TOKEN, estimateTokens, reportedUsageFigures, requestCharacters, type ReportedTokenUsage, type ReportedUsageFigures } from './token-estimator'

export const SESSION_PROCESS_RUN_ID = randomUUID()
export type UsageKind = 'user' | 'report' | 'title' | 'summary'
export interface TurnUsage {
  turn_id: string
  owner_id: string
  kind: UsageKind
  provider: string
  model: string
  state: string
  input_tokens: number
  output_tokens: number
  input_source: 'reported' | 'estimated' | 'mixed'
  output_source: 'reported' | 'estimated' | 'mixed'
  estimated_input_tokens: number
  estimated_output_tokens: number
  reported_input_tokens: number | null
  reported_output_tokens: number | null
  context_window: number | null
}

/** Always-on instrumentation, independent of the managed-ledger rollout. */
export class TokenAccounting {
  private closed = false
  private readonly ownedTurns = new Set<string>()
  constructor(private readonly db: Database.Database, private readonly log: (message: string) => void = console.log,
    private readonly processRunId: string = SESSION_PROCESS_RUN_ID, private readonly now: () => number = Date.now) {}

  private factor(model: string, side: 'input' | 'output'): number {
    const sample = this.db.prepare('SELECT * FROM session_token_calibration WHERE model = ?').get(model) as Record<string, number> | undefined
    return sample && sample[`${side}_chars`] > 0 ? sample[`${side}_tokens`] * CHARS_PER_TOKEN / sample[`${side}_chars`] : 1
  }

  beginTurn(turnId: string, ownerId: string, kind: UsageKind, provider: ChatProvider, inputCharacters: number): void {
    if (this.closed) return
    const estimate = estimateTokens(inputCharacters, this.factor(provider.model, 'input'))
    this.db.prepare(`INSERT OR IGNORE INTO session_turn_usage
      (turn_id, owner_id, kind, provider, model, context_window, process_run_id, state,
       input_tokens, estimated_input_tokens, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
      .run(turnId, ownerId, kind, provider.id, provider.model, modelContextWindow(provider.model), this.processRunId, estimate, estimate, this.now())
    this.ownedTurns.add(turnId)
  }

  private beginCall(turnId: string, index: number, characters: number, model: string): void {
    if (this.closed) return
    this.db.prepare(`INSERT OR IGNORE INTO session_usage_calls
      (turn_id, call_index, input_chars, estimated_input_tokens, state) VALUES (?, ?, ?, ?, 'running')`)
      .run(turnId, index, characters, estimateTokens(characters, this.factor(model, 'input')))
    this.aggregate(turnId)
  }

  finishCall(turnId: string, index: number, outputCharacters: number, state: string, usage: ReportedUsageFigures | null): void {
    if (this.closed) return
    const turn = this.get(turnId)
    if (!turn || turn.state !== 'running') return
    this.db.prepare(`UPDATE session_usage_calls SET output_chars = ?, estimated_output_tokens = ?,
      reported_input_tokens = COALESCE(?, reported_input_tokens), reported_output_tokens = COALESCE(?, reported_output_tokens), state = ?
      WHERE turn_id = ? AND call_index = ?`)
      .run(outputCharacters, estimateTokens(outputCharacters, this.factor(turn.model, 'output')), usage?.inputTokens ?? null,
        usage?.outputTokens ?? null, state, turnId, index)
    this.aggregate(turnId)
    if (usage) this.calibrate(turn.model)
  }

  /** A late authoritative report corrects the same call, never adds another. */
  correctReportedUsage(turnId: string, index: number, usage: Partial<ReportedTokenUsage>): void {
    if (this.closed) return
    const normalized = reportedUsageFigures(usage)
    if (!normalized) throw new Error('Invalid reported token usage')
    this.db.prepare('UPDATE session_usage_calls SET reported_input_tokens = COALESCE(?, reported_input_tokens), reported_output_tokens = COALESCE(?, reported_output_tokens) WHERE turn_id = ? AND call_index = ?')
      .run(normalized.inputTokens, normalized.outputTokens, turnId, index)
    this.aggregate(turnId)
    const turn = this.get(turnId)
    if (turn) { this.calibrate(turn.model); this.logTurn(turnId) }
  }

  private calibrate(model: string): void {
    this.db.prepare(`INSERT INTO session_token_calibration (model, input_chars, input_tokens, output_chars, output_tokens)
      SELECT ?, COALESCE(SUM(c.input_chars), 0), COALESCE(SUM(c.reported_input_tokens), 0),
        COALESCE(SUM(c.output_chars), 0), COALESCE(SUM(c.reported_output_tokens), 0)
      FROM session_usage_calls c JOIN session_turn_usage t ON t.turn_id = c.turn_id
      WHERE t.model = ? AND c.reported_input_tokens IS NOT NULL AND c.reported_output_tokens IS NOT NULL
      ON CONFLICT(model) DO UPDATE SET input_chars = excluded.input_chars, input_tokens = excluded.input_tokens,
        output_chars = excluded.output_chars, output_tokens = excluded.output_tokens`).run(model, model)
  }

  private aggregate(turnId: string): void {
    const calls = this.db.prepare(`SELECT COUNT(*) AS calls, SUM(estimated_input_tokens) AS estimated_input,
      SUM(estimated_output_tokens) AS estimated_output,
      SUM(reported_input_tokens) AS reported_input, SUM(reported_output_tokens) AS reported_output,
      SUM(COALESCE(reported_input_tokens, estimated_input_tokens)) AS effective_input,
      SUM(COALESCE(reported_output_tokens, estimated_output_tokens)) AS effective_output,
      COUNT(reported_input_tokens) AS reported_inputs, COUNT(reported_output_tokens) AS reported_outputs
      FROM session_usage_calls WHERE turn_id = ?`).get(turnId) as Record<string, number | null>
    if (!calls.calls) return
    const source = (count: number | null): string => count === calls.calls ? 'reported' : count ? 'mixed' : 'estimated'
    this.db.prepare(`UPDATE session_turn_usage SET input_tokens = ?, output_tokens = ?, input_source = ?, output_source = ?,
      estimated_input_tokens = ?, estimated_output_tokens = ?, reported_input_tokens = ?, reported_output_tokens = ? WHERE turn_id = ?`)
      .run(calls.effective_input ?? 0, calls.effective_output ?? 0, source(calls.reported_inputs), source(calls.reported_outputs),
        calls.estimated_input ?? 0, calls.estimated_output ?? 0, calls.reported_input, calls.reported_output, turnId)
  }

  finishTurn(turnId: string, state: string): void {
    if (this.closed) return
    this.aggregate(turnId)
    if (state === 'interrupted') this.db.prepare("UPDATE session_usage_calls SET state = 'interrupted' WHERE turn_id = ? AND state = 'running'").run(turnId)
    this.db.prepare("UPDATE session_turn_usage SET state = ?, finished_at = COALESCE(finished_at, ?) WHERE turn_id = ? AND state = 'running'")
      .run(state, this.now(), turnId)
    this.logTurn(turnId)
    this.ownedTurns.delete(turnId)
  }

  get(turnId: string): TurnUsage | null {
    if (this.closed) return null
    return this.db.prepare('SELECT * FROM session_turn_usage WHERE turn_id = ?').get(turnId) as TurnUsage | undefined ?? null
  }

  reconcileInterrupted(): string[] {
    if (this.closed) return []
    const interrupted = this.db.prepare("SELECT turn_id FROM session_turn_usage WHERE state = 'running' AND process_run_id != ?")
      .all(this.processRunId) as Array<{ turn_id: string }>
    for (const { turn_id } of interrupted) this.finishTurn(turn_id, 'interrupted')
    return interrupted.map(({ turn_id }) => turn_id)
  }

  /** Seal only this observer's work before the service withdraws ownership.
   * Ignored aborts/iterator cleanup can then drain without touching SQLite. */
  shutdown(): void {
    if (this.closed) return
    try {
      for (const turnId of [...this.ownedTurns]) this.finishTurn(turnId, 'interrupted')
    } finally {
      this.closed = true
      this.ownedTurns.clear()
    }
  }

  private logTurn(turnId: string): void {
    const usage = this.get(turnId)
    if (usage) this.log(`[Sessions] turn_usage ${JSON.stringify({ turnId, ownerId: usage.owner_id, kind: usage.kind, model: usage.model,
      state: usage.state, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      inputSource: usage.input_source, outputSource: usage.output_source })}`)
  }

  private progressCall(turnId: string, index: number, characters: number): void {
    if (this.closed) return
    const turn = this.get(turnId)
    if (!turn || turn.state !== 'running') return
    this.db.prepare("UPDATE session_usage_calls SET output_chars = ?, estimated_output_tokens = ? WHERE turn_id = ? AND call_index = ? AND state = 'running'")
      .run(characters, estimateTokens(characters, this.factor(turn.model, 'output')), turnId, index)
  }

  /** A transparent transport observer: requests/events/signals retain identity,
   * errors still reach the runtime, and telemetry failure cannot alter a turn. */
  observeProvider(provider: ChatProvider, turnId: () => string): ChatProvider {
    const beginCall = this.beginCall.bind(this)
    const progressCall = this.progressCall.bind(this)
    const finishCall = this.finishCall.bind(this)
    let index = 0
    return {
      id: provider.id, model: provider.model, supportsImages: provider.supportsImages,
      async *stream(request: ChatProviderRequest, signal: AbortSignal) {
        const call = ++index
        const id = turnId()
        let outputCharacters = 0
        let reported: ReportedUsageFigures | null = null
        let state = 'completed'
        const observe = (write: () => void): void => { try { write() } catch (error) { console.error('[Sessions] Usage observation failed:', error) } }
        observe(() => beginCall(id, call, requestCharacters(request), provider.model))
        try {
          for await (const event of provider.stream(request, signal)) {
            if (event.type === 'text_delta') outputCharacters += event.text.length
            else if (event.type === 'tool_call') outputCharacters += event.name.length + JSON.stringify(event.input).length
            else if (event.usage) reported = reportedUsageFigures(event.usage) ?? reported
            if (event.type !== 'message_end') observe(() => progressCall(id, call, outputCharacters))
            yield event
          }
        } catch (error) {
          state = signal.aborted ? 'cancelled' : 'error'
          throw error
        } finally {
          if (signal.aborted) state = 'cancelled'
          observe(() => finishCall(id, call, outputCharacters, state, reported))
        }
      }
    }
  }
}

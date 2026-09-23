import type { AdapterUsageReport } from './coding-agent-adapter'

/**
 * Reads the token usage each backend reports and maps it to an
 * AdapterUsageReport (managed sessions B1, #97). Kept apart from the adapters
 * so the parsing is testable on fixtures without a live backend.
 *
 * Every figure here is `reported`: these readers never estimate. A backend
 * that reports nothing yields nothing, and AgentManager estimates the turn.
 */

export type UsageReportBody = Omit<AdapterUsageReport, 'sessionId'>

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

// ── Claude Code ───────────────────────────────────────────────

interface ClaudeModelTotals {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

function modelTotals(value: unknown): ClaudeModelTotals {
  const row = record(value) ?? {}
  return {
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    thinkingTokens: num(row.thinkingTokens),
    cacheReadInputTokens: num(row.cacheReadInputTokens),
    cacheCreationInputTokens: num(row.cacheCreationInputTokens),
    costUSD: num(row.costUSD)
  }
}

/**
 * Follows one Claude Code `query()` stream and reports each turn's usage when
 * its `result` arrives.
 *
 * - Token totals come from `modelUsage`, which covers the main loop,
 *   subagents and compaction. It is cumulative for the life of the `query()`
 *   process, so a turn's figure is the difference from the previous result
 *   (and the whole figure after a restart, when the totals start again).
 *   Without `modelUsage`, the result's own main-loop `usage` is used.
 * - The context size is the prompt of the last main-loop assistant message:
 *   its input plus cache reads and writes, which the API reports in full on
 *   the first frame of each message.
 * - The context window is `modelUsage[model].contextWindow`.
 *
 * Call `reset()` whenever a new `query()` process starts (a resume).
 */
export class ClaudeUsageAccumulator {
  private previous = new Map<string, ClaudeModelTotals>()
  private model: string | null = null
  private lastPrompt: number | null = null
  private calls = new Set<string>()
  private results = 0

  reset(): void {
    this.previous = new Map()
    this.lastPrompt = null
    this.calls = new Set()
  }

  /** Feeds one SDK message; returns the turn's usage when the message is its `result`. */
  observe(message: unknown): UsageReportBody | null {
    const msg = record(message)
    if (!msg) return null
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.model = str(msg.model) ?? this.model
      return null
    }
    if (msg.type === 'assistant') {
      // Subagent frames carry parent_tool_use_id; their prompts are not the session's context.
      if (msg.parent_tool_use_id) return null
      const inner = record(msg.message)
      if (!inner) return null
      this.model = str(inner.model) ?? this.model
      const id = str(inner.id)
      const usage = record(inner.usage)
      // Streamed frames of one message share its id; the prompt is known from the first.
      if (id && this.calls.has(id)) return null
      if (id) this.calls.add(id)
      if (usage) {
        const prompt = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens)
        if (prompt > 0) this.lastPrompt = prompt
      }
      return null
    }
    if (msg.type !== 'result') return null
    return this.finishTurn(msg)
  }

  private finishTurn(msg: Record<string, unknown>): UsageReportBody | null {
    this.results += 1
    const turnKey = str(msg.uuid) ?? `result-${this.results}`
    const modelUsage = record(msg.modelUsage)
    let input = 0
    let output = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    let cost = 0
    let contextWindow: number | null = null
    let sawModelUsage = false

    if (modelUsage && Object.keys(modelUsage).length > 0) {
      const next = new Map<string, ClaudeModelTotals>()
      for (const [model, value] of Object.entries(modelUsage)) {
        const now = modelTotals(value)
        next.set(model, now)
        const before = this.previous.get(model)
        // Totals only grow within one process; a drop means they started again.
        const restarted = !before || now.inputTokens < before.inputTokens || now.outputTokens < before.outputTokens
        const base = restarted ? null : before
        input += now.inputTokens - (base?.inputTokens ?? 0)
        output += now.outputTokens - (base?.outputTokens ?? 0)
        reasoning += now.thinkingTokens - (base?.thinkingTokens ?? 0)
        cacheRead += now.cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0)
        cacheWrite += now.cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0)
        cost += now.costUSD - (base?.costUSD ?? 0)
      }
      this.previous = next
      sawModelUsage = input + output + cacheRead + cacheWrite > 0
      contextWindow = this.windowFor(modelUsage)
    }
    if (!sawModelUsage) {
      const usage = record(msg.usage)
      input = num(usage?.input_tokens)
      output = num(usage?.output_tokens)
      cacheRead = num(usage?.cache_read_input_tokens)
      cacheWrite = num(usage?.cache_creation_input_tokens)
      reasoning = 0
      cost = 0
    }

    const calls = this.calls.size
    const contextTokens = this.lastPrompt
    this.calls = new Set()
    this.lastPrompt = null
    // Crash and startup results carry zeros: nothing was reported.
    if (input + output + cacheRead + cacheWrite <= 0) return null
    return {
      turnKey,
      model: this.model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: Math.max(0, reasoning),
      contextTokens,
      contextWindow,
      costUsd: sawModelUsage ? Math.max(0, Math.round(cost * 1e6) / 1e6) : null,
      modelCalls: calls > 0 ? calls : null,
      stopReason: str(msg.stop_reason) ?? str(msg.subtype)
    }
  }

  private windowFor(modelUsage: Record<string, unknown>): number | null {
    const rows = Object.entries(modelUsage)
    const own = rows.find(([model, row]) => model === this.model || record(row)?.canonicalModel === this.model)
    const row = record((own ?? rows[0])?.[1])
    const window = num(row?.contextWindow)
    return window > 0 ? window : null
  }
}

// ── Codex app-server ──────────────────────────────────────────

interface CodexBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

function codexBreakdown(value: unknown): CodexBreakdown | null {
  const row = record(value)
  if (!row) return null
  return {
    totalTokens: num(row.totalTokens),
    inputTokens: num(row.inputTokens),
    cachedInputTokens: num(row.cachedInputTokens),
    cacheWriteInputTokens: num(row.cacheWriteInputTokens),
    outputTokens: num(row.outputTokens),
    reasoningOutputTokens: num(row.reasoningOutputTokens)
  }
}

interface CodexTurnTotals {
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
  calls: number
  lastPrompt: number | null
}

/**
 * Follows a Codex app-server thread's `thread/tokenUsage/updated`
 * notifications: `{ threadId, turnId?, tokenUsage: { total, last,
 * modelContextWindow } }`, where `last` is the usage of the latest model
 * response and `total` the thread's running total.
 *
 * A turn's figure is the sum of the `last` breakdowns that arrived during it.
 * A notification whose `total` did not grow repeats one already counted (a
 * resume replaying the thread's totals, say) and is skipped. Codex counts
 * cached input inside `inputTokens`; the report moves it to
 * `cacheReadTokens`. The context size is the latest response's input.
 *
 * `observe` returns the turn's figures so far each time they change; the
 * report replaces the earlier one for the same turn key.
 */
export class CodexUsageAccumulator {
  private lastTotal = -1
  private turns = new Map<string, CodexTurnTotals>()
  private window: number | null = null
  /** Names a turn the notifications did not identify; advances when a turn completes. */
  private anonymousTurn = 1

  constructor(private model: string | null = null) {}

  /** The thread's turn ended: usage without a turn id now belongs to the next one. */
  turnCompleted(): void {
    this.anonymousTurn += 1
  }

  setModel(model: string | null | undefined): void {
    if (model) this.model = model
  }

  observe(params: unknown, activeTurnId: string | null): UsageReportBody | null {
    const p = record(params)
    const tokenUsage = record(p?.tokenUsage)
    if (!tokenUsage) return null
    const window = num(tokenUsage.modelContextWindow)
    if (window > 0) this.window = window
    const total = codexBreakdown(tokenUsage.total)
    const last = codexBreakdown(tokenUsage.last)
    if (!last) return null
    const totalTokens = total?.totalTokens ?? 0
    if (total && totalTokens <= this.lastTotal) return null
    if (total) this.lastTotal = totalTokens
    const turnId = str(p?.turnId) ?? str(record(p?.turn)?.id) ?? activeTurnId ?? `turn-${this.anonymousTurn}`

    const turn = this.turns.get(turnId) ?? { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0, lastPrompt: null }
    // Keep only the turns still in flight or just finished.
    if (!this.turns.has(turnId) && this.turns.size >= 8) {
      const oldest = this.turns.keys().next().value
      if (oldest !== undefined) this.turns.delete(oldest)
    }
    const cached = Math.min(last.cachedInputTokens, last.inputTokens)
    turn.input += last.inputTokens - cached
    turn.cached += cached
    turn.cacheWrite += last.cacheWriteInputTokens
    turn.output += last.outputTokens
    turn.reasoning += last.reasoningOutputTokens
    turn.calls += 1
    turn.lastPrompt = last.inputTokens > 0 ? last.inputTokens : turn.lastPrompt
    this.turns.set(turnId, turn)

    return {
      turnKey: turnId,
      model: this.model,
      inputTokens: turn.input,
      outputTokens: turn.output,
      cacheReadTokens: turn.cached,
      cacheWriteTokens: turn.cacheWrite,
      reasoningTokens: turn.reasoning,
      contextTokens: turn.lastPrompt,
      contextWindow: this.window,
      modelCalls: turn.calls
    }
  }
}

// ── opencode ──────────────────────────────────────────────────

interface OpencodeTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

function opencodeTokens(value: unknown): OpencodeTokens | null {
  const tokens = record(value)
  if (!tokens) return null
  const cache = record(tokens.cache)
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(cache?.read),
    cacheWrite: num(cache?.write)
  }
}

/**
 * The usage of one finished opencode assistant message, or null when it is
 * not one (a user message, still running, no tokens).
 *
 * opencode keeps on the message the tokens of its *latest* step and the cost
 * of all of them; each step's tokens are also on its `step-finish` part. The
 * turn's totals are therefore the sum of the step-finish parts, falling back
 * to the message's own tokens when the parts are missing, and the context
 * size is the message's (latest step's) prompt: input plus cache.
 */
export function opencodeMessageUsage(message: unknown): UsageReportBody | null {
  const msg = record(message)
  const info = record(msg?.info)
  if (!info || info.role !== 'assistant') return null
  const id = str(info.id)
  const time = record(info.time)
  if (!id || !time || !num(time.completed)) return null
  const latest = opencodeTokens(info.tokens)
  if (!latest) return null

  const steps: OpencodeTokens[] = []
  const parts = Array.isArray(msg?.parts) ? msg.parts : []
  for (const part of parts) {
    const row = record(part)
    if (row?.type !== 'step-finish') continue
    const tokens = opencodeTokens(row.tokens)
    if (tokens) steps.push(tokens)
  }
  const sum = steps.length > 0
    ? steps.reduce((a, b) => ({
      input: a.input + b.input,
      output: a.output + b.output,
      reasoning: a.reasoning + b.reasoning,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheWrite: a.cacheWrite + b.cacheWrite
    }))
    : latest
  if (sum.input + sum.output + sum.cacheRead + sum.cacheWrite <= 0) return null

  const provider = str(info.providerID)
  const model = str(info.modelID)
  const context = latest.input + latest.cacheRead + latest.cacheWrite
  const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) ? info.cost : null
  return {
    turnKey: id,
    model: model ? (provider ? `${provider}/${model}` : model) : null,
    inputTokens: sum.input,
    outputTokens: sum.output,
    cacheReadTokens: sum.cacheRead,
    cacheWriteTokens: sum.cacheWrite,
    reasoningTokens: sum.reasoning,
    contextTokens: context > 0 ? context : null,
    costUsd: cost,
    modelCalls: steps.length > 0 ? steps.length : null,
    stopReason: str(info.finish)
  }
}

import { describe, expect, it } from 'vitest'
import { ClaudeUsageAccumulator, CodexUsageAccumulator, opencodeMessageUsage } from './usage-reports'

/**
 * Usage fixtures in the shapes each backend sends (#97). The Claude Code
 * frames follow @anthropic-ai/claude-agent-sdk's SDKMessage types; the Codex
 * notification is `thread/tokenUsage/updated` from `codex app-server`; the
 * opencode message is a `session.messages()` entry.
 */

// ── Claude Code ───────────────────────────────────────────────

const claudeInit = { type: 'system', subtype: 'init', model: 'claude-opus-4-6', session_id: 'cc-1' }

function claudeAssistant(id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'cc-1',
    uuid: `frame-${id}-${Math.random()}`,
    message: { id, type: 'message', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'ok' }], usage },
    ...extra
  }
}

function claudeResult(uuid: string, modelUsage: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    uuid,
    session_id: 'cc-1',
    num_turns: 2,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: { input_tokens: 9, output_tokens: 99, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
    modelUsage,
    ...extra
  }
}

function opusTotals(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number): Record<string, unknown> {
  return {
    'claude-opus-4-6': {
      inputTokens: input, outputTokens: output, thinkingTokens: Math.floor(output / 2),
      cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite,
      webSearchRequests: 0, costUSD: cost, contextWindow: 1_000_000, maxOutputTokens: 128_000
    }
  }
}

describe('ClaudeUsageAccumulator', () => {
  it('reports each turn from the growth of modelUsage, with the last prompt as context', () => {
    const usage = new ClaudeUsageAccumulator()
    expect(usage.observe(claudeInit)).toBeNull()
    // Two model calls; the second frame of the first message repeats its usage.
    usage.observe(claudeAssistant('msg_1', { input_tokens: 5, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 1 }))
    usage.observe(claudeAssistant('msg_1', { input_tokens: 5, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 80 }))
    // A subagent's call is not the session's context.
    usage.observe(claudeAssistant('sub_1', { input_tokens: 90_000, output_tokens: 1 }, { parent_tool_use_id: 'toolu_9' }))
    usage.observe(claudeAssistant('msg_2', { input_tokens: 300, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 0, output_tokens: 1 }))

    const first = usage.observe(claudeResult('result-1', opusTotals(1_200, 400, 22_000, 2_000, 0.25)))
    expect(first).toEqual({
      turnKey: 'result-1',
      model: 'claude-opus-4-6',
      inputTokens: 1_200,
      outputTokens: 400,
      cacheReadTokens: 22_000,
      cacheWriteTokens: 2_000,
      reasoningTokens: 200,
      contextTokens: 12_300,
      contextWindow: 1_000_000,
      costUsd: 0.25,
      modelCalls: 2,
      stopReason: 'end_turn'
    })

    // The next result carries the running totals: the turn is the difference.
    usage.observe(claudeAssistant('msg_3', { input_tokens: 50, cache_read_input_tokens: 14_000, cache_creation_input_tokens: 300, output_tokens: 1 }))
    const second = usage.observe(claudeResult('result-2', opusTotals(1_250, 520, 36_000, 2_300, 0.31)))
    expect(second).toMatchObject({
      turnKey: 'result-2', inputTokens: 50, outputTokens: 120, cacheReadTokens: 14_000, cacheWriteTokens: 300,
      contextTokens: 14_350, modelCalls: 1
    })
    expect(second?.costUsd).toBeCloseTo(0.06)
  })

  it('starts again after a new query() process (resume)', () => {
    const usage = new ClaudeUsageAccumulator()
    usage.observe(claudeResult('r1', opusTotals(1_000, 100, 0, 0, 0.1)))
    usage.reset()
    const afterResume = usage.observe(claudeResult('r2', opusTotals(1_500, 50, 0, 0, 0.12)))
    expect(afterResume).toMatchObject({ inputTokens: 1_500, outputTokens: 50, contextTokens: null })
    expect(afterResume?.costUsd).toBeCloseTo(0.12)
  })

  it('treats shrinking totals as a restart even without reset()', () => {
    const usage = new ClaudeUsageAccumulator()
    usage.observe(claudeResult('r1', opusTotals(5_000, 500, 0, 0, 0.5)))
    expect(usage.observe(claudeResult('r2', opusTotals(200, 20, 0, 0, 0.02)))).toMatchObject({ inputTokens: 200, outputTokens: 20 })
  })

  it('falls back to the main-loop usage when modelUsage is missing', () => {
    const usage = new ClaudeUsageAccumulator()
    const report = usage.observe(claudeResult('r1', {}))
    expect(report).toMatchObject({ inputTokens: 9, outputTokens: 99, cacheReadTokens: 1, cacheWriteTokens: 1, costUsd: null, contextWindow: null })
  })

  it('reports nothing for a zeroed crash result, and turns error results into reports too', () => {
    const usage = new ClaudeUsageAccumulator()
    expect(usage.observe(claudeResult('crash', {}, { usage: { input_tokens: 0, output_tokens: 0 } }))).toBeNull()
    const error = usage.observe(claudeResult('rate', opusTotals(800, 10, 0, 0, 0.01), { subtype: 'error_during_execution', is_error: true, stop_reason: null }))
    expect(error).toMatchObject({ turnKey: 'rate', stopReason: 'error_during_execution' })
  })

  it('ignores everything that is not usage', () => {
    const usage = new ClaudeUsageAccumulator()
    expect(usage.observe(null)).toBeNull()
    expect(usage.observe({ type: 'stream_event' })).toBeNull()
    expect(usage.observe({ type: 'user', message: { content: 'hi' } })).toBeNull()
  })
})

// ── Codex app-server ──────────────────────────────────────────

function codexUsage(params: { turnId?: string; last: Record<string, number>; total: Record<string, number>; window?: number }): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    ...(params.turnId ? { turnId: params.turnId } : {}),
    tokenUsage: { total: params.total, last: params.last, modelContextWindow: params.window ?? 272_000 }
  }
}

const call1 = { totalTokens: 11_200, inputTokens: 11_000, cachedInputTokens: 9_000, outputTokens: 200, reasoningOutputTokens: 120 }
const call2 = { totalTokens: 12_150, inputTokens: 11_900, cachedInputTokens: 11_000, outputTokens: 250, reasoningOutputTokens: 60 }

describe('CodexUsageAccumulator', () => {
  it('sums the responses of a turn and moves cached input to cache reads', () => {
    const usage = new CodexUsageAccumulator('gpt-5.1-codex')
    const first = usage.observe(codexUsage({ turnId: 'turn-1', last: call1, total: call1 }), null)
    expect(first).toEqual({
      turnKey: 'turn-1', model: 'gpt-5.1-codex',
      inputTokens: 2_000, outputTokens: 200, cacheReadTokens: 9_000, cacheWriteTokens: 0, reasoningTokens: 120,
      contextTokens: 11_000, contextWindow: 272_000, modelCalls: 1
    })
    const total = { totalTokens: call1.totalTokens + call2.totalTokens, inputTokens: 22_900, cachedInputTokens: 20_000, outputTokens: 450, reasoningOutputTokens: 180 }
    const second = usage.observe(codexUsage({ turnId: 'turn-1', last: call2, total }), null)
    expect(second).toMatchObject({
      turnKey: 'turn-1', inputTokens: 2_900, outputTokens: 450, cacheReadTokens: 20_000, reasoningTokens: 180,
      contextTokens: 11_900, modelCalls: 2
    })
  })

  it('skips a notification whose total did not grow (a replay)', () => {
    const usage = new CodexUsageAccumulator()
    usage.observe(codexUsage({ turnId: 'turn-1', last: call1, total: call1 }), null)
    expect(usage.observe(codexUsage({ turnId: 'turn-1', last: call1, total: call1 }), null)).toBeNull()
  })

  it('takes the turn from the adapter, else numbers it', () => {
    const usage = new CodexUsageAccumulator()
    expect(usage.observe(codexUsage({ last: call1, total: call1 }), 'active-7')?.turnKey).toBe('active-7')
    const next = { ...call2, totalTokens: 30_000 }
    expect(usage.observe(codexUsage({ last: call2, total: next }), null)?.turnKey).toBe('turn-1')
    usage.turnCompleted()
    expect(usage.observe(codexUsage({ last: call2, total: { ...next, totalTokens: 40_000 } }), null)?.turnKey).toBe('turn-2')
  })

  it('tolerates older CLIs and malformed params', () => {
    const usage = new CodexUsageAccumulator()
    expect(usage.observe({}, 'turn-1')).toBeNull()
    expect(usage.observe({ tokenUsage: { total: null, last: null } }, 'turn-1')).toBeNull()
    // No `total` (older protocol): every notification counts.
    expect(usage.observe({ tokenUsage: { last: { inputTokens: 100, outputTokens: 5 } } }, 'turn-1')).toMatchObject({
      inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, contextWindow: null
    })
  })
})

// ── opencode ──────────────────────────────────────────────────

function opencodeAssistant(overrides: Record<string, unknown> = {}, parts: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    info: {
      id: 'msg_a1',
      sessionID: 'ses_1',
      role: 'assistant',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
      cost: 0.042,
      finish: 'stop',
      time: { created: 1_700_000_000_000, completed: 1_700_000_004_000 },
      // The latest step's tokens.
      tokens: { input: 400, output: 150, reasoning: 20, cache: { read: 30_000, write: 1_200 } },
      ...overrides
    },
    parts
  }
}

const stepFinish = (tokens: Record<string, unknown>): Record<string, unknown> => ({ id: `prt_${Math.random()}`, type: 'step-finish', reason: 'tool-calls', cost: 0.01, tokens })

describe('opencodeMessageUsage', () => {
  it('sums the step-finish parts and takes the context from the latest step', () => {
    const message = opencodeAssistant({}, [
      { id: 'prt_1', type: 'text', text: 'Looking.' },
      stepFinish({ input: 1_000, output: 60, reasoning: 0, cache: { read: 25_000, write: 3_000 } }),
      stepFinish({ input: 400, output: 150, reasoning: 20, cache: { read: 30_000, write: 1_200 } })
    ])
    expect(opencodeMessageUsage(message)).toEqual({
      turnKey: 'msg_a1',
      model: 'anthropic/claude-sonnet-4-6',
      inputTokens: 1_400,
      outputTokens: 210,
      cacheReadTokens: 55_000,
      cacheWriteTokens: 4_200,
      reasoningTokens: 20,
      contextTokens: 31_600,
      costUsd: 0.042,
      modelCalls: 2,
      stopReason: 'stop'
    })
  })

  it('uses the message tokens when there are no step parts', () => {
    expect(opencodeMessageUsage(opencodeAssistant())).toMatchObject({ inputTokens: 400, outputTokens: 150, cacheReadTokens: 30_000, modelCalls: null })
  })

  it('reports only finished assistant messages with tokens', () => {
    expect(opencodeMessageUsage(opencodeAssistant({ time: { created: 1 } }))).toBeNull()
    expect(opencodeMessageUsage(opencodeAssistant({ role: 'user' }))).toBeNull()
    expect(opencodeMessageUsage(opencodeAssistant({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))).toBeNull()
    expect(opencodeMessageUsage(opencodeAssistant({ tokens: undefined }))).toBeNull()
    expect(opencodeMessageUsage({})).toBeNull()
  })
})

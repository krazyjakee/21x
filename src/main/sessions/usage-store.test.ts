import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import type { ChatMessage, ChatUsage } from '../../shared/chat'
import { chatTurnUsage } from './chat-usage'
import { estimateChatPromptTokens } from './token-estimator'
import { formatUsageLog, SessionUsageStore, type SessionUsageInput } from './usage-store'

afterEach(() => vi.restoreAllMocks())

function store(): { usage: SessionUsageStore; tick: () => void } {
  const { rawDb } = createTestDb()
  let now = 1_000
  return { usage: new SessionUsageStore({ db: rawDb }, () => now), tick: () => { now += 1 } }
}

const reportedTurn: SessionUsageInput = {
  ownerKind: 'captain',
  ownerId: 'task-1',
  sessionId: 'backend-session',
  turnKey: 'turn-1',
  engine: 'adapter',
  backend: 'claude-code',
  model: 'claude-opus-4-6',
  source: 'reported',
  inputTokens: 12,
  outputTokens: 340,
  cacheReadTokens: 41_000,
  cacheWriteTokens: 900,
  contextTokens: 41_912,
  contextWindow: 1_000_000,
  windowSource: 'reported',
  costUsd: 0.0321,
  stopReason: 'success'
}

describe('SessionUsageStore', () => {
  it('stores a turn and logs it with its provenance', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { usage } = store()
    const row = usage.record(reportedTurn)
    expect(row).toMatchObject({
      ownerKind: 'captain', ownerId: 'task-1', turnKey: 'turn-1', source: 'reported',
      inputTokens: 12, outputTokens: 340, cacheReadTokens: 41_000, cacheWriteTokens: 900,
      contextTokens: 41_912, contextSource: 'reported', contextWindow: 1_000_000, windowSource: 'reported', costUsd: 0.0321
    })
    expect(usage.list('captain', 'task-1')).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[SessionUsage] owner=captain:task-1 turn=turn-1 backend=claude-code model=claude-opus-4-6 source=reported in=12 out=340 cache=41000r/900w context=41912/1000000 (4.2%)'))
  })

  it('replaces the row when the same turn is reported again', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { usage, tick } = store()
    const first = usage.record({ ...reportedTurn, outputTokens: 10, contextTokens: 100 })
    tick()
    const second = usage.record({ ...reportedTurn, outputTokens: 20, contextTokens: 200, contextWindow: null, windowSource: null })
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ outputTokens: 20, contextTokens: 200, createdAt: first.createdAt, updatedAt: first.createdAt + 1 })
    // A later report without a window keeps the one already known.
    expect(second).toMatchObject({ contextWindow: 1_000_000, windowSource: 'reported' })
    expect(usage.list('captain', 'task-1')).toHaveLength(1)
  })

  it('marks estimated figures in the log and keeps owners apart', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { usage } = store()
    usage.record({ ...reportedTurn, ownerId: 'task-2', source: 'estimated', contextSource: 'estimated', costUsd: null })
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/source=estimated in=≈12 out=≈340 .*context=≈41912/)
    expect(usage.list('captain', 'task-1')).toEqual([])
    expect(usage.latestReported('captain', 'task-2')).toBeNull()
  })

  it('cleans up counts it cannot trust', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { usage } = store()
    const row = usage.record({ ...reportedTurn, inputTokens: Number.NaN, outputTokens: -4, contextTokens: undefined, costUsd: Number.POSITIVE_INFINITY })
    expect(row).toMatchObject({ inputTokens: 0, outputTokens: 0, contextTokens: null, contextSource: null, costUsd: null })
  })

  it('reads the latest reported context and calibration ratio', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { usage, tick } = store()
    const owner = { ...reportedTurn, ownerKind: 'commander' as const, ownerId: 's1', engine: 'chat' as const }
    usage.record({ ...owner, turnKey: 'a', contextTokens: 10_000, estimatedPromptTokens: 8_000 })
    tick()
    usage.record({ ...owner, turnKey: 'b', contextTokens: 12_000, estimatedPromptTokens: 10_000 })
    tick()
    // An estimated turn neither anchors nor calibrates.
    usage.record({ ...owner, turnKey: 'c', source: 'estimated', contextSource: 'estimated', contextTokens: 50_000, estimatedPromptTokens: null })
    expect(usage.latestReported('commander', 's1')?.turnKey).toBe('b')
    expect(usage.calibration('commander', 's1')).toBeCloseTo(1.2)
    expect(usage.calibration('commander', 'other')).toBeNull()
  })
})

describe('chatTurnUsage', () => {
  const inputMessages: ChatMessage[] = [
    { role: 'user', content: 'What is running in project Alpha?' }
  ]
  const turnMessages: ChatMessage[] = [
    ...inputMessages,
    { role: 'assistant', content: 'Checking.', toolCalls: [{ id: 'c1', name: 'list_tasks', input: { project: 'Alpha' } }] },
    { role: 'tool', toolCallId: 'c1', name: 'list_tasks', content: JSON.stringify([{ id: 't1', title: 'Fix the build' }]) },
    { role: 'assistant', content: 'One task is running: Fix the build.' }
  ]
  const prompt = { system: 'You are the Commander.'.repeat(40), tools: [] }
  const base = {
    ownerKind: 'commander' as const,
    ownerId: 's1',
    sessionId: 's1',
    turnId: 'turn-1',
    prompt,
    inputMessages
  }

  it('records a fully reported turn with the estimate of its last prompt', () => {
    const usage: ChatUsage = { inputTokens: 30, outputTokens: 25, cacheReadTokens: 400, cacheWriteTokens: 0, modelCalls: 2, reportedCalls: 2, lastPromptTokens: 260 }
    const row = chatTurnUsage({ ...base, provider: { id: 'anthropic', model: 'claude-sonnet-4-6' }, result: { messages: turnMessages, usage, stopReason: 'end_turn' } })
    expect(row).toMatchObject({
      source: 'reported', engine: 'chat', backend: 'anthropic', model: 'claude-sonnet-4-6', turnKey: 'turn-1',
      inputTokens: 30, outputTokens: 25, cacheReadTokens: 400, contextTokens: 260, contextSource: 'reported',
      contextWindow: 1_000_000, windowSource: 'known', modelCalls: 2, stopReason: 'end_turn',
      // The last call's prompt: everything before the final assistant message.
      estimatedPromptTokens: estimateChatPromptTokens({ ...prompt, messages: turnMessages.slice(0, 3) })
    })
  })

  it('estimates a turn whose provider reported nothing, corrected by the calibration ratio', () => {
    const usage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 2, reportedCalls: 0 }
    const raw = chatTurnUsage({ ...base, provider: { id: 'codex-subscription', model: 'gpt-5.1-codex' }, result: { messages: turnMessages, usage, stopReason: 'end_turn' } })
    const firstPrompt = estimateChatPromptTokens({ ...prompt, messages: turnMessages.slice(0, 1) })
    const lastPrompt = estimateChatPromptTokens({ ...prompt, messages: turnMessages.slice(0, 3) })
    expect(raw).toMatchObject({
      source: 'estimated', contextSource: 'estimated', estimatedPromptTokens: null,
      inputTokens: firstPrompt + lastPrompt, contextTokens: lastPrompt, contextWindow: 400_000, windowSource: 'known'
    })
    expect(raw.outputTokens).toBeGreaterThan(0)

    const corrected = chatTurnUsage({ ...base, provider: { id: 'codex-subscription', model: 'gpt-5.1-codex' }, result: { messages: turnMessages, usage, stopReason: 'end_turn' }, calibration: 1.5 })
    expect(corrected.contextTokens).toBe(Math.round(lastPrompt * 1.5))
    expect(corrected.inputTokens).toBe(Math.round((firstPrompt + lastPrompt) * 1.5))
  })

  it('treats a partly reported turn as estimated, since its totals would undercount', () => {
    const usage: ChatUsage = { inputTokens: 30, outputTokens: 5, modelCalls: 2, reportedCalls: 1, lastPromptTokens: 30 }
    const row = chatTurnUsage({ ...base, provider: { id: 'openai-compatible', model: 'local-model' }, result: { messages: turnMessages, usage, stopReason: 'end_turn' } })
    expect(row).toMatchObject({ source: 'estimated', windowSource: 'default' })
  })

  it('estimates the prompt of a turn that failed before any answer', () => {
    const usage: ChatUsage = { inputTokens: 0, outputTokens: 0, modelCalls: 0, reportedCalls: 0 }
    const row = chatTurnUsage({ ...base, provider: { id: 'anthropic', model: 'claude-opus-4-6' }, result: { messages: inputMessages, usage, stopReason: 'error' } })
    expect(row).toMatchObject({ source: 'estimated', outputTokens: 0, stopReason: 'error' })
    expect(row.contextTokens).toBe(estimateChatPromptTokens({ ...prompt, messages: inputMessages }))
  })

  it('formats a log line for an input before it is stored', () => {
    expect(formatUsageLog(reportedTurn)).toContain('cost=$0.0321')
  })
})

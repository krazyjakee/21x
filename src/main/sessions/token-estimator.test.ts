import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../shared/chat'
import {
  calibrate,
  calibrationRatio,
  CHARS_PER_TOKEN,
  estimateChatMessageTokens,
  estimateChatPromptTokens,
  estimateTextTokens,
  IMAGE_TOKENS,
  MAX_CALIBRATION_RATIO,
  MESSAGE_OVERHEAD_TOKENS,
  MIN_CALIBRATION_RATIO
} from './token-estimator'
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW, knownContextWindow, normalizeModelId } from './model-windows'

describe('estimateTextTokens', () => {
  it('counts roughly one token per 3.5 characters, rounding up', () => {
    expect(CHARS_PER_TOKEN).toBe(3.5)
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens(null)).toBe(0)
    expect(estimateTextTokens('abc')).toBe(1)
    expect(estimateTextTokens('a'.repeat(7))).toBe(2)
    expect(estimateTextTokens('a'.repeat(3_500))).toBe(1_000)
  })
})

describe('estimateChatMessageTokens', () => {
  it('adds framing, images, tool calls and tool names', () => {
    expect(estimateChatMessageTokens({ role: 'user', content: 'a'.repeat(35) })).toBe(MESSAGE_OVERHEAD_TOKENS + 10)
    expect(estimateChatMessageTokens({
      role: 'user', content: '', images: [{ name: 'a.png', mimeType: 'image/png', data: 'x' }, { name: 'b.png', mimeType: 'image/png', data: 'y' }]
    })).toBe(MESSAGE_OVERHEAD_TOKENS + 2 * IMAGE_TOKENS)
    const call = { id: 'c1', name: 'list_tasks', input: { status: 'open' } }
    expect(estimateChatMessageTokens({ role: 'assistant', content: '', toolCalls: [call] }))
      .toBe(MESSAGE_OVERHEAD_TOKENS + estimateTextTokens('list_tasks') + estimateTextTokens(JSON.stringify(call.input)))
    expect(estimateChatMessageTokens({ role: 'tool', toolCallId: 'c1', name: 'list_tasks', content: '[]' }))
      .toBe(MESSAGE_OVERHEAD_TOKENS + 1 + estimateTextTokens('list_tasks'))
  })
})

describe('estimateChatPromptTokens', () => {
  it('sums system prompt, tool definitions and history', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(350) },
      { role: 'assistant', content: 'b'.repeat(70) }
    ]
    const historyOnly = estimateChatPromptTokens({ messages })
    expect(historyOnly).toBe(2 * MESSAGE_OVERHEAD_TOKENS + 100 + 20)
    const withSystem = estimateChatPromptTokens({ system: 'c'.repeat(700), messages })
    expect(withSystem).toBe(historyOnly + MESSAGE_OVERHEAD_TOKENS + 200)
    const withTools = estimateChatPromptTokens({
      system: 'c'.repeat(700),
      messages,
      tools: [{ name: 'get_task', description: 'Get one task.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }]
    })
    expect(withTools).toBeGreaterThan(withSystem)
  })

  it('grows linearly with the text, so a long session estimates far above a short one', () => {
    const short = estimateChatPromptTokens({ messages: [{ role: 'user', content: 'x'.repeat(3_500) }] })
    const long = estimateChatPromptTokens({ messages: [{ role: 'user', content: 'x'.repeat(35_000) }] })
    expect(long - MESSAGE_OVERHEAD_TOKENS).toBe(10 * (short - MESSAGE_OVERHEAD_TOKENS))
  })
})

describe('calibration', () => {
  it('derives a ratio from a reported prompt and the estimate of the same prompt', () => {
    expect(calibrationRatio(12_000, 10_000)).toBeCloseTo(1.2)
    expect(calibrationRatio(8_000, 10_000)).toBeCloseTo(0.8)
  })

  it('ignores pairs that cannot have measured the same prompt', () => {
    expect(calibrationRatio(null, 10_000)).toBeNull()
    expect(calibrationRatio(10_000, 0)).toBeNull()
    // Too small to say anything about larger prompts.
    expect(calibrationRatio(120, 100)).toBeNull()
    // Wildly off: a backend that adds its own large system prompt, say.
    expect(calibrationRatio(10_000 * (MAX_CALIBRATION_RATIO + 1), 10_000)).toBeNull()
    expect(calibrationRatio(10_000 * (MIN_CALIBRATION_RATIO / 2), 10_000)).toBeNull()
    expect(calibrationRatio(Number.NaN, 10_000)).toBeNull()
  })

  it('corrects later estimates by the ratio and leaves them alone without one', () => {
    const estimate = estimateChatPromptTokens({ messages: [{ role: 'user', content: 'x'.repeat(35_000) }] })
    const ratio = calibrationRatio(Math.round(estimate * 1.25), estimate)
    expect(calibrate(estimate, ratio)).toBe(Math.round(estimate * 1.25))
    expect(calibrate(estimate, null)).toBe(estimate)
    expect(calibrate(estimate, 50)).toBe(estimate)
  })
})

describe('model windows', () => {
  it('normalises routing prefixes and suffixes', () => {
    expect(normalizeModelId('anthropic/claude-opus-4-6')).toBe('claude-opus-4-6')
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5-20250929-v1:0')
    expect(normalizeModelId('claude-opus-4-5@20251101')).toBe('claude-opus-4-5')
    expect(normalizeModelId('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
  })

  it('knows the Claude families', () => {
    expect(knownContextWindow('claude-opus-4-6')).toBe(1_000_000)
    expect(knownContextWindow('claude-opus-4-8')).toBe(1_000_000)
    expect(knownContextWindow('claude-opus-5')).toBe(1_000_000)
    expect(knownContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(knownContextWindow('claude-sonnet-5')).toBe(1_000_000)
    expect(knownContextWindow('claude-fable-5-1')).toBe(1_000_000)
    expect(knownContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(knownContextWindow('claude-sonnet-4-5')).toBe(200_000)
    expect(knownContextWindow('claude-opus-4-5-20251101')).toBe(200_000)
    // Claude Code's 1M opt-in suffix.
    expect(knownContextWindow('claude-sonnet-4-5[1m]')).toBe(1_000_000)
    expect(knownContextWindow('opus')).toBe(1_000_000)
  })

  it('knows common non-Claude models and nothing else', () => {
    expect(knownContextWindow('gpt-5.1-codex')).toBe(400_000)
    expect(knownContextWindow('openai/gpt-4o-mini')).toBe(128_000)
    expect(knownContextWindow('o4-mini')).toBe(200_000)
    expect(knownContextWindow('gemini-2.5-pro')).toBe(1_048_576)
    expect(knownContextWindow('my-local-model')).toBeNull()
  })

  it('prefers a reported window, then an override, then the table, then the default', () => {
    expect(contextWindowFor('claude-opus-4-6', { reported: 400_000 })).toEqual({ tokens: 400_000, source: 'reported' })
    expect(contextWindowFor('ollama/llama3', { overrides: { llama3: 8_192 } })).toEqual({ tokens: 8_192, source: 'override' })
    expect(contextWindowFor('ollama/llama3', { overrides: { 'ollama/llama3': 4_096 } })).toEqual({ tokens: 4_096, source: 'override' })
    expect(contextWindowFor('claude-haiku-4-5', { reported: 0 })).toEqual({ tokens: 200_000, source: 'known' })
    expect(contextWindowFor('mystery')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' })
    expect(contextWindowFor(null)).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' })
  })
})

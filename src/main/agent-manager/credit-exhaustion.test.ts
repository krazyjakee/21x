import { describe, expect, it } from 'vitest'
import {
  findCreditExhaustionMessage,
  isCreditExhaustionError,
  normalizeFallbackAgentIds,
} from './credit-exhaustion'

describe('credit exhaustion detection', () => {
  it.each([
    'Credit balance is too low',
    'insufficient_quota',
    'Quota exceeded. Check your plan and billing details.',
    "You've hit your weekly limit · resets Friday",
    'Your monthly usage limit has been reached',
    'You are out of rate limits',
    '402 Payment Required',
  ])('recognizes terminal account exhaustion: %s', (message) => {
    expect(isCreditExhaustionError(message)).toBe(true)
  })

  it.each([
    '429 Too Many Requests',
    'Server is temporarily rate limited',
    'The request timed out',
    'Authentication failed',
    'Tool execution failed',
  ])('does not hand off for ordinary or transient failures: %s', (message) => {
    expect(isCreditExhaustionError(message)).toBe(false)
  })

  it('finds the provider detail among generic status messages', () => {
    expect(findCreditExhaustionMessage(['An unexpected error occurred', 'Credit balance is too low']))
      .toBe('Credit balance is too low')
  })
})

describe('fallback agent config normalization', () => {
  it('keeps unique non-empty ids in configured order', () => {
    expect(normalizeFallbackAgentIds(['astra', '', 'gpt-6', 'astra', 42, '  codex  ']))
      .toEqual(['astra', 'gpt-6', 'codex'])
  })

  it('returns an empty list for malformed persisted values', () => {
    expect(normalizeFallbackAgentIds('astra')).toEqual([])
    expect(normalizeFallbackAgentIds(null)).toEqual([])
  })
})

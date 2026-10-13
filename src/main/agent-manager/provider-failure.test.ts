import { describe, expect, it } from 'vitest'
import { classifyProviderFailure, PROVIDER_RETRY_MAX_MS, providerRetryDelay } from './provider-failure'

describe('shared provider policy', () => {
  it.each([
    ['Codex', 'Selected model is at capacity (serverOverloaded)'],
    ['Claude Code', '529 overloaded_error'],
    ['OpenCode', 'APIError: service unavailable (503)'],
    ['Cursor', 'Too many requests (429)'],
    ['Pi', 'stream disconnected: ECONNRESET'],
  ])('classifies %s transient errors without assuming delivery', (_adapter, error) => {
    expect(classifyProviderFailure(error)).toMatchObject({ kind: 'transient', delivery: 'unknown' })
    expect(classifyProviderFailure(error, 'turn_failed')).toMatchObject({ kind: 'transient', delivery: 'turn_failed' })
  })
  it.each(['insufficient_quota', 'Your credits are exhausted', 'Weekly usage limit reached'])('uses fallbacks for %s', (error) => {
    expect(classifyProviderFailure(error, 'turn_failed').kind).toBe('exhausted')
  })
  it.each(['Authentication failed (503)', 'Invalid model', 'INCOMPATIBLE_SESSION_ID', 'Permission required', 'Manual stop', 'Cancelled'])('preserves %s as terminal', (error) => {
    expect(classifyProviderFailure(error, 'rejected').kind).toBe('terminal')
  })
  it('has reproducible, bounded exponential jitter that changes per intent and attempt', () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => providerRetryDelay('intent', attempt))
    expect(delays).toEqual([1, 2, 3, 4, 5].map((attempt) => providerRetryDelay('intent', attempt)))
    delays.forEach((delay, index) => {
      expect(delay).toBeGreaterThanOrEqual(1000 * 2 ** index)
      expect(delay).toBeLessThanOrEqual(1250 * 2 ** index)
    })
    expect(providerRetryDelay('intent', 50)).toBeLessThanOrEqual(PROVIDER_RETRY_MAX_MS)
    expect(providerRetryDelay('different-intent', 1)).not.toBe(delays[0])
  })
})

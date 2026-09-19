import { describe, it, expect, vi } from 'vitest'
import { applyCodexAuthEnv } from './codex-auth'

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>()
  return { ...actual, mkdtempSync: vi.fn(() => '/tmp/codex-session-test') }
})

describe('applyCodexAuthEnv', () => {
  it('authMethod=subscription strips ambient API keys and uses ~/.codex', () => {
    // Explicit subscription choice + an ambient OPENAI_API_KEY exported in the
    // shell — the classic "terminal works, 20x shows out of rate limits" case.
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: 'sk-ambient-from-shell',
      CODEX_API_KEY: 'sk-ambient-from-shell'
    }

    const { usesApiKey } = applyCodexAuthEnv(env, {
      authMethod: 'subscription'
    })

    expect(usesApiKey).toBe(false)
    // Ambient keys must be stripped so Codex uses ~/.codex (subscription).
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
    // CODEX_HOME pinned to the codex CLI default so Codex reads the same login.
    expect(env.CODEX_HOME).toMatch(/[\\/]\.codex$/)
    expect(env.NO_BROWSER).toBeUndefined()
  })

  it('authMethod=subscription ignores even an explicitly-configured API key', () => {
    const env: Record<string, string | undefined> = {}

    const { usesApiKey } = applyCodexAuthEnv(env, {
      authMethod: 'subscription',
      apiKeys: { openai: 'sk-explicit-agent-key' }
    })

    expect(usesApiKey).toBe(false)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_HOME).toMatch(/[\\/]\.codex$/)
  })

  it('authMethod=subscription preserves an inherited custom CODEX_HOME', () => {
    // The user's terminal `codex` may use a custom CODEX_HOME (a different ChatGPT
    // account); 20x inherits it and must NOT override it with the default ~/.codex.
    const env: Record<string, string | undefined> = { CODEX_HOME: '/custom/codex/home' }

    const { usesApiKey } = applyCodexAuthEnv(env, {
      authMethod: 'subscription'
    })

    expect(usesApiKey).toBe(false)
    expect(env.CODEX_HOME).toBe('/custom/codex/home')
  })

  it('authMethod=api_key uses the explicit per-agent key in an isolated CODEX_HOME', () => {
    const env: Record<string, string | undefined> = {}

    const { usesApiKey } = applyCodexAuthEnv(env, {
      authMethod: 'api_key',
      apiKeys: { openai: 'sk-explicit-agent-key' }
    })

    expect(usesApiKey).toBe(true)
    expect(env.OPENAI_API_KEY).toBe('sk-explicit-agent-key')
    expect(env.CODEX_API_KEY).toBe('sk-explicit-agent-key')
    expect(env.NO_BROWSER).toBe('1')
    expect(env.CODEX_HOME).toBe('/tmp/codex-session-test')
  })

  it('authMethod=api_key falls back to an ambient key when no per-agent key is set', () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-ambient' }

    const { usesApiKey } = applyCodexAuthEnv(env, {
      authMethod: 'api_key'
    })

    expect(usesApiKey).toBe(true)
    expect(env.OPENAI_API_KEY).toBe('sk-ambient')
    expect(env.CODEX_HOME).toBe('/tmp/codex-session-test')
  })

  it('legacy (no authMethod): an ambient key alone does NOT force API-key mode', () => {
    // The original bug: an ambient shell OPENAI_API_KEY hijacked subscription users.
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-ambient' }

    const { usesApiKey } = applyCodexAuthEnv(env, {})

    expect(usesApiKey).toBe(false)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_HOME).toMatch(/[\\/]\.codex$/)
  })

  it('legacy (no authMethod): an explicit per-agent key opts into API-key mode', () => {
    const env: Record<string, string | undefined> = {}

    const { usesApiKey } = applyCodexAuthEnv(env, {
      apiKeys: { openai: 'sk-explicit-agent-key' }
    })

    expect(usesApiKey).toBe(true)
    expect(env.OPENAI_API_KEY).toBe('sk-explicit-agent-key')
    expect(env.CODEX_HOME).toBe('/tmp/codex-session-test')
  })
})

import { describe, expect, it } from 'vitest'

import {
  AGENT_BACKEND_KEYS,
  detectInstalledAgents,
  getInstalledBackends,
  isBackendReady,
  isVersionAtLeast,
  MINIMUM_PI_VERSION
} from './detect.js'

describe('Pi version support', () => {
  it('accepts the minimum and newer versions', () => {
    expect(isVersionAtLeast(MINIMUM_PI_VERSION, MINIMUM_PI_VERSION)).toBe(true)
    expect(isVersionAtLeast('0.84.3', MINIMUM_PI_VERSION)).toBe(true)
    expect(isVersionAtLeast('1.0.0', MINIMUM_PI_VERSION)).toBe(true)
  })

  it('rejects versions older than the supported RPC runtime', () => {
    expect(isVersionAtLeast('0.80.4', MINIMUM_PI_VERSION)).toBe(false)
    expect(isVersionAtLeast('0.79.9', MINIMUM_PI_VERSION)).toBe(false)
  })
})

describe('backend availability helpers', () => {
  it('covers every supported coding-agent backend', () => {
    expect(AGENT_BACKEND_KEYS).toEqual(['claudeCode', 'opencode', 'codex', 'cursor', 'pi'])
  })

  it('treats installed, supported backends as ready', () => {
    expect(isBackendReady({ installed: true, version: '1.0.0' })).toBe(true)
    expect(isBackendReady({ installed: true, version: '0.84.3', supported: true })).toBe(true)
    expect(isBackendReady({ installed: true, version: '0.79.0', supported: false })).toBe(false)
    expect(isBackendReady({ installed: false, version: null })).toBe(false)
    expect(isBackendReady(undefined)).toBe(false)
  })

  it('lists every detected backend without a single-selection limit', () => {
    expect(getInstalledBackends({
      nodejs: { installed: true, version: '20.0.0' },
      claudeCode: { installed: true, version: '1.0.0' },
      opencode: { installed: true, version: '0.5.0' },
      codex: { installed: true, version: '0.2.0' },
      cursor: { installed: false, version: null },
      pi: { installed: true, version: '0.79.0', supported: false }
    })).toEqual(['claudeCode', 'opencode', 'codex'])
  })

  it('returns an empty list when nothing is installed', () => {
    expect(getInstalledBackends({})).toEqual([])
    expect(getInstalledBackends(undefined)).toEqual([])
  })
})

describe('detectInstalledAgents', () => {
  /** Build an exec stub whose successes are keyed by command name. */
  function fakeExec(versions: Record<string, string>) {
    return async (cmd: string) => {
      const version = versions[cmd]
      if (version === undefined) throw new Error(`${cmd}: command not found`)
      return { stdout: `${version}\n`, stderr: '' }
    }
  }

  it('probes every supported backend and reports each one independently', async () => {
    const status = await detectInstalledAgents({
      exec: fakeExec({ claude: '1.0.30', codex: '0.4.1', opencode: 'opencode 0.6.2' })
    })

    for (const key of AGENT_BACKEND_KEYS) expect(status).toHaveProperty(key)
    expect(status.claudeCode).toEqual({ installed: true, version: '1.0.30' })
    expect(status.codex).toEqual({ installed: true, version: '0.4.1' })
    expect(status.opencode).toEqual({ installed: true, version: '0.6.2' })
    expect(status.cursor).toEqual({ installed: false, version: null })
    expect(status.pi).toMatchObject({ installed: false, supported: false })
    expect(getInstalledBackends(status)).toEqual(['claudeCode', 'opencode', 'codex'])
  })

  it('reports a fresh snapshot on each run so installs and removals show up', async () => {
    const before = await detectInstalledAgents({ exec: fakeExec({ claude: '1.0.30' }) })
    expect(getInstalledBackends(before)).toEqual(['claudeCode'])

    // Codex installed, Claude Code removed between runs.
    const after = await detectInstalledAgents({ exec: fakeExec({ codex: '0.4.1' }) })
    expect(getInstalledBackends(after)).toEqual(['codex'])
    expect(after.claudeCode).toEqual({ installed: false, version: null })
  })

  it('completes with no backends installed', async () => {
    const status = await detectInstalledAgents({ exec: fakeExec({}) })
    expect(getInstalledBackends(status)).toEqual([])
    expect(status.pi.reason).toBe('Pi CLI is not installed.')
  })
})

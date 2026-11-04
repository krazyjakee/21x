import { describe, expect, it } from 'vitest'
import { isRtkEnabled, rtkBackendCoverage, rtkCoverageFor, rtkEffectiveState, rtkGlobalHooksAfterOptOut } from './rtk'

const installed = { installed: true }

describe('isRtkEnabled', () => {
  it('is on until the user opts out, so existing profiles need no migration', () => {
    expect(isRtkEnabled(undefined)).toBe(true)
    expect(isRtkEnabled(null)).toBe(true)
    expect(isRtkEnabled('')).toBe(true)
    expect(isRtkEnabled('true')).toBe(true)
    expect(isRtkEnabled('false')).toBe(false)
  })
})

describe('rtkEffectiveState', () => {
  it('separates the preference from what actually happens', () => {
    expect(rtkEffectiveState(true, { installed: true })).toBe('on')
    expect(rtkEffectiveState(true, { installed: false })).toBe('unavailable')
    expect(rtkEffectiveState(true, undefined)).toBe('unavailable')
    expect(rtkEffectiveState(false, { installed: true })).toBe('off')
    expect(rtkEffectiveState(false, { installed: false })).toBe('off')
  })
})

describe('rtkCoverageFor', () => {
  it('never reports an instruction as enforcement', () => {
    expect(rtkCoverageFor('claude-code')).toBe('rewrite')
    expect(rtkCoverageFor('opencode')).toBe('rewrite')
    expect(rtkCoverageFor('pi')).toBe('rewrite')
    expect(rtkCoverageFor('codex')).toBe('instructions')
    expect(rtkCoverageFor('cursor')).toBe('instructions')
  })

  it('treats an agent with no backend as the default backend, OpenCode', () => {
    expect(rtkCoverageFor(undefined)).toBe('rewrite')
  })
})

describe('rtkBackendCoverage', () => {
  it('lists only usable backends', () => {
    const backends = rtkBackendCoverage({
      claudeCode: installed,
      codex: installed,
      opencode: { installed: false },
      pi: { installed: true, supported: false }
    })
    expect(backends.map(backend => backend.key)).toEqual(['claudeCode', 'codex'])
  })
})

describe('rtkGlobalHooksAfterOptOut', () => {
  const detection = { claudeCode: installed, opencode: installed, codex: installed, pi: installed, cursor: { installed: false } }

  it('names the backends whose global hook 21x cannot stop', () => {
    const rtk = { installed: true, integrations: { claudeCode: true, opencode: false, codex: true, pi: true, cursor: true } }
    expect(rtkGlobalHooksAfterOptOut(detection, rtk).map(backend => backend.key)).toEqual(['claudeCode'])
  })

  it('is empty when no global hook exists', () => {
    expect(rtkGlobalHooksAfterOptOut(detection, { installed: true, integrations: {} })).toEqual([])
    expect(rtkGlobalHooksAfterOptOut(detection, undefined)).toEqual([])
  })
})

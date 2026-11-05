import { describe, expect, it } from 'vitest'
import { isRtkEnabled, rtkBackendCoverage, rtkCoverageFor, rtkEffectiveState, rtkGlobalHooks } from './rtk'

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
    expect(rtkEffectiveState(true, { installed: true, version: '0.49.0' })).toBe('on')
    expect(rtkEffectiveState(true, { installed: false })).toBe('unavailable')
    expect(rtkEffectiveState(true, undefined)).toBe('unavailable')
    expect(rtkEffectiveState(false, { installed: true, version: '0.49.0' })).toBe('off')
    expect(rtkEffectiveState(false, { installed: false })).toBe('off')
  })

  it('does not report On for an RTK that cannot rewrite', () => {
    expect(rtkEffectiveState(true, { installed: true, version: '0.23.0' })).toBe('on')
    expect(rtkEffectiveState(true, { installed: true, version: '1.0.0' })).toBe('on')
    expect(rtkEffectiveState(true, { installed: true, version: '0.22.9' })).toBe('unsupported')
    expect(rtkEffectiveState(true, { installed: true, version: null })).toBe('unsupported')
  })
})

describe('rtkCoverageFor', () => {
  it('never reports an instruction as enforcement', () => {
    expect(rtkCoverageFor('claude-code')).toBe('approved')
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

describe('rtkGlobalHooks', () => {
  const detection = { claudeCode: installed, opencode: installed, codex: installed, pi: installed, cursor: { installed: false } }

  it('names the backends whose global hook 21x cannot stop', () => {
    const rtk = { installed: true, version: '0.49.0', integrations: { claudeCode: true, opencode: false, codex: true, pi: true, cursor: true } }
    expect(rtkGlobalHooks(detection, rtk).map(backend => backend.key)).toEqual(['claudeCode'])
  })

  it('is empty when no global hook exists', () => {
    expect(rtkGlobalHooks(detection, { installed: true, integrations: {} })).toEqual([])
    expect(rtkGlobalHooks(detection, undefined)).toEqual([])
  })
})

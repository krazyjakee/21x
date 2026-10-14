import type { JsonValue } from './service-protocol'
import { describe, expect, it } from 'vitest'
import { AGENT_INSTALLER_CODECS, AGENT_INSTALLER_DETECTION_KEYS, AGENT_INSTALLER_BACKEND_KEYS, AGENT_INSTALLER_MINIMUM_PI_VERSION, AGENT_INSTALLER_EVENT_CODECS, AGENT_INSTALLER_PUBLIC_ERRORS, AGENT_INSTALLER_PROGRESS, isAgentInstallerDetection, projectAgentInstallerProgress } from './agent-installer-codecs'
import { MINIMUM_PI_VERSION } from '../main/agent-installer/detect.js'
const codec = AGENT_INSTALLER_CODECS['agent-installer:detect']
function snapshot(): Record<string, unknown> {
  return { ...Object.fromEntries(AGENT_INSTALLER_DETECTION_KEYS.map(key => [key, { installed: false, version: null }])),
    rtk: { installed: false, version: null, configured: false, integrations: Object.fromEntries(AGENT_INSTALLER_BACKEND_KEYS.map(key => [key, false])) },
    pi: { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' } }
}
describe('agent CLI detection codec', () => {
  it('retains exact empty preload arguments and every actual detector status key', () => {
    expect(codec.encodeArguments([])).toEqual({}); expect(codec.decodeArguments({})).toEqual([])
    expect(AGENT_INSTALLER_MINIMUM_PI_VERSION).toBe(MINIMUM_PI_VERSION)
    const value = snapshot(), wire = codec.encodeResult(value)
    expect(wire).toEqual({ defined: true, value }); expect(codec.decodeResult(wire.defined ? wire.value : undefined)).toEqual(value)
    expect(codec.validateWireResult({ defined: false })).toBe(false)
    const invalidPayloads: JsonValue[] = [{ command: 'arbitrary' }, { environment: { TOKEN: 'private' } }, { home: '/foreign' }, { caller: 'trusted' }]
    for (const payload of invalidPayloads) expect(() => codec.decodeArguments(payload)).toThrow('arguments')
  })
  it('preserves Pi minimum-version and genuine RTK readiness semantics', () => {
    const value = snapshot()
    value.pi = { installed: true, version: '0.80.5', supported: true, reason: null }
    value.rtk = { installed: true, version: '0.49.0', configured: true, integrations: Object.fromEntries(AGENT_INSTALLER_BACKEND_KEYS.map(key => [key, key === 'pi'])) }
    expect(isAgentInstallerDetection(value)).toBe(true)
    expect(isAgentInstallerDetection({ ...value, pi: { installed: true, version: '0.80.4', supported: true, reason: null } })).toBe(false)
    value.pi = { installed: true, version: '0.80.4', supported: false, reason: 'Pi 0.80.4 is unsupported. Update to 0.80.5 or newer.' }
    expect(isAgentInstallerDetection({ ...value, rtk: { ...(value.rtk as object), configured: false } })).toBe(true)
    expect(isAgentInstallerDetection({ ...value, rtk: { ...(value.rtk as object), configured: true } })).toBe(false)
  })
  it('admits only bounded version syntax and fixed failures, without raw stderr or credentials', () => {
    const value = snapshot()
    for (const version of ['22.1.0', '0.80.5-rc.1', '2.53.0.windows.1']) expect(isAgentInstallerDetection({ ...value, nodejs: { installed: true, version } })).toBe(true)
    for (const version of ['private-token', '1.0.PRIVATE_TOKEN', '1.0.0\n/path', '1.0.0' + 'x'.repeat(256)]) expect(isAgentInstallerDetection({ ...value, nodejs: { installed: true, version } })).toBe(false)
    expect(isAgentInstallerDetection({ ...value, nodejs: { installed: false, version: null, reason: 'CLI detection timed out.' } })).toBe(true)
    expect(isAgentInstallerDetection({ ...value, nodejs: { installed: false, version: null, reason: 'private stderr' } })).toBe(false)
    expect(isAgentInstallerDetection({ ...value, nodejs: { installed: false, version: '1.0.0' } })).toBe(false)
    expect(isAgentInstallerDetection({ ...value, command: 'private' })).toBe(false)
    expect(isAgentInstallerDetection({ ...value, pi: { installed: false, version: null, supported: false, reason: 'private path' } })).toBe(false)
  })
})

describe('finite portable installation wire', () => {
  const install = AGENT_INSTALLER_CODECS['agent-installer:install']
  it('retains the exact agentName preload payload for every shipping detector key', () => {
    for (const name of AGENT_INSTALLER_DETECTION_KEYS) {
      expect(install.encodeArguments([name])).toEqual({ agentName: name })
      expect(install.decodeArguments({ agentName: name })).toEqual([name])
    }
    for (const value of [{}, { agentName: 'claude-code' }, { agentName: '../npm' }, { agentName: 'codex\0' }, { agentName: '😀'.repeat(1000) }, { agentName: 'codex', command: 'arbitrary' }, { agentName: 'codex', caller: 'main' }, { agentName: 'codex', uiLeaseId: 'forged' }]) {
      expect(() => install.decodeArguments(value as JsonValue)).toThrow('arguments')
    }
    expect(install.validateArguments(['codex', { environment: { TOKEN: 'private' } }])).toBe(false)
  })
  it('requires full actual detection and fixed failure text, never synthetic missing status', () => {
    for (const error of Object.values(AGENT_INSTALLER_PUBLIC_ERRORS)) {
      const value = { success: false, error, newStatus: snapshot() }
      const wire = install.encodeResult(value)
      expect(install.validateWireResult(wire)).toBe(true)
      expect(install.decodeResult(wire.defined ? wire.value : undefined)).toEqual(value)
    }
    const value = { success: true, error: null, newStatus: snapshot() }
    expect(install.validateResult(value)).toBe(true)
    for (const bad of [
      { ...value, error: AGENT_INSTALLER_PUBLIC_ERRORS.failed },
      { ...value, success: false },
      { ...value, success: false, error: 'private token /profile/secret' },
      { ...value, newStatus: {} },
      { ...value, newStatus: { ...snapshot(), codex: { installed: true, version: 'private token' } } },
      { ...value, newStatus: { ...snapshot(), credentials: 'x'.repeat(100000) } },
      { ...value, stdout: 'private log' }
    ]) expect(() => install.encodeResult(bad)).toThrow('result')
    expect(install.validateWireResult({ defined: false })).toBe(false)
  })
  it('admits only fixed projected progress and rejects unbounded/raw process output', () => {
    const event = AGENT_INSTALLER_EVENT_CODECS['agent-installer:progress']
    for (const stage of Object.keys(AGENT_INSTALLER_PROGRESS)) {
      const value = projectAgentInstallerProgress('pi', stage)
      expect(event.validatePayload(value)).toBe(true)
      expect(event.decodePayload(event.encodePayload(value))).toEqual(value)
    }
    const good = projectAgentInstallerProgress('codex', 'installing')
    for (const value of [{ ...good, stage: 'stdout' }, { ...good, output: 'PRIVATE_TOKEN' }, { ...good, output: '😀'.repeat(100000) }, { ...good, percent: 50.1 }, { ...good, percent: Infinity }, { ...good, agentName: 'other' }, { ...good, path: '/private' }]) expect(event.validatePayload(value)).toBe(false)
    expect(() => projectAgentInstallerProgress('codex', '__proto__')).toThrow('arguments')
  })
})

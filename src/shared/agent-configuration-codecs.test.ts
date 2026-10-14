import { describe, expect, it } from 'vitest'
import { AGENT_API_KEY_SET_MARKER, AGENT_CONFIGURATION_CODECS as codecs, AGENT_CONFIGURATION_EVENT_CODECS } from './agent-configuration-codecs'

const agent = { id: 'agent-one', name: 'Agent', server_url: 'http://localhost:4096', config: { coding_agent: 'codex', api_keys: { openai: 'private-value', anthropic: '' }, concurrency_cap: 2 }, is_default: false, created_at: 'created', updated_at: 'updated' }
describe('agent configuration public codecs', () => {
  it('masks result keys and strictly bounds the finite credential input', () => {
    const encoded = codecs['agent:getAll'].encodeResult([agent])
    expect(encoded).toMatchObject({ defined: true, value: [{ config: { api_keys: { openai: AGENT_API_KEY_SET_MARKER } } }] })
    expect(JSON.stringify(encoded)).not.toContain('private-value')
    expect(codecs['agent:getAll'].validateWireResult(encoded)).toBe(true)
    expect(codecs['agent:getAll'].validateResult([agent])).toBe(false)
    for (const value of ['new-key', AGENT_API_KEY_SET_MARKER]) {
      const args = ['agent-one', { config: { api_keys: { openai: value } } }] as Parameters<typeof codecs['agent:update']['encodeArguments']>[0]
      expect(codecs['agent:update'].decodeArguments(codecs['agent:update'].encodeArguments(args))).toEqual(args)
    }
    for (const value of ['bad\nkey', 'bad\0key', '界'.repeat(5462)])
      expect(() => codecs['agent:update'].encodeArguments(['agent-one', { config: { api_keys: { openai: value } } }])).toThrow('arguments')
    expect(() => codecs['agent:update'].decodeArguments({ id: 'agent-one', data: { config: { api_keys: { unknown: 'key' } } } })).toThrow('arguments')
    expect(() => codecs['agent:update'].decodeArguments({ id: 'agent-one', data: { config: { api_keys: { openai: 42 } } } })).toThrow('arguments')
    expect(codecs['agent:update'].encodeArguments(['agent-one', { config: { api_keys: { openai: '', anthropic: undefined, cursor: undefined } } }])).toEqual({ id: 'agent-one', data: { config: { api_keys: { openai: '' } } } })
  })
  it('retains missing update and explicit null backend result semantics', () => {
    expect(codecs['agent:update'].encodeResult(undefined)).toEqual({ defined: false })
    expect(codecs['agentConfig:listModels'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(codecs['agentConfig:getProviders'].encodeArguments([undefined, 'pi'])).toEqual({ backendType: 'pi' })
    expect(codecs['agentConfig:getProviders'].decodeArguments({ backendType: 'pi' })).toEqual([undefined, 'pi'])
  })
  it('bounds backend types, URL authority shape, caps and rejects caller-supplied paths', () => {
    for (const backend of ['opencode', 'claude-code', 'codex', 'cursor', 'pi']) expect(codecs['agentConfig:listModels'].validateArguments([backend])).toBe(true)
    for (const backend of ['codex-acp', 'arbitrary', '', null]) expect(codecs['agentConfig:listModels'].validateArguments([backend])).toBe(false)
    for (const url of ['file:///tmp/models', 'https://user:key@example.test', 'http://localhost:4096/?token=secret', 'http://localhost:4096/#fragment', 'x'.repeat(5000)]) {
      expect(codecs['agentConfig:getProviders'].validateArguments([url, 'opencode'])).toBe(false)
    }
    expect(() => codecs['agentConfig:getProviders'].decodeArguments({ backendType: 'opencode', directory: '/tmp' })).toThrow('arguments')
    expect(codecs['agent:create'].validateArguments([{ name: 'Agent', config: { concurrency_cap: 11 } }])).toBe(false)
  })
  it('projects only public provider/model fields and bounds the complete result', () => {
    const result = codecs['agentConfig:getProviders'].encodeResult({ providers: [{ id: 'provider', name: 'Provider', apiKey: 'private-key',
      models: { model: { name: 'Model', api_key: 'private-key', sdkPath: '/private/path' } } }], default: { provider: 'model', api_key: 'private-key' } })
    expect(result).toEqual({ defined: true, value: { providers: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }], default: { provider: 'model' } } })
    expect(codecs['agentConfig:getProviders'].validateWireResult(result)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/private-key|private\/path|api_key/)
    expect(() => codecs['agentConfig:listModels'].encodeResult(Array.from({ length: 4097 }, () => ({ id: 'm', name: 'Model' })))).toThrow('result')
    const largeModels = Array.from({ length: 1024 }, () => ({ id: 'model', name: '界'.repeat(512) }))
    expect(() => codecs['agentConfig:listModels'].encodeResult(largeModels)).toThrow('result')
    expect(codecs['agentConfig:listModels'].validateWireResult({ defined: true, value: largeModels })).toBe(false)
    const excessiveProviders = Array.from({ length: 2 }, (_, index) => ({ id: `p${index}`, name: 'Provider', models: Array.from({ length: 2049 }, () => ({ id: 'm', name: 'Model' })) }))
    expect(codecs['agentConfig:getProviders'].validateWireResult({ defined: true, value: { providers: excessiveProviders, default: {} } })).toBe(false)
    expect(codecs['agentConfig:getProviders'].validateResult({ providers: [], default: { foreign: 'model' } })).toBe(false)
    expect(AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh'].validatePayload({})).toBe(true)
    expect(AGENT_CONFIGURATION_EVENT_CODECS['tasks:refresh'].validatePayload({ config: agent.config })).toBe(false)
  })
})

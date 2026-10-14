import { describe, expect, it } from 'vitest'
import { TASK_SOURCE_PLUGIN_CODECS as codecs, TASK_SOURCE_RESOLVER_KEYS, TASK_SOURCE_PLUGIN_LIMITS, isTaskSourceResolverOptions } from './task-source-plugin-codecs'
import { TASK_SOURCE_KEY_SET_MARKER as marker } from './task-source-codecs'

describe('task source form control codecs', () => {
  it('preserves the fifth sourceId argument and exact optional holes on the actual preload signature', () => {
    const args: Parameters<import('./desktop-api').DesktopApi['plugins']['resolveOptions']> = ['notion', 'data_sources', { api_token: marker }, undefined, 'source-one']
    const payload = codecs['plugin:resolveOptions'].encodeArguments(args)
    expect(payload).toEqual({ pluginId: 'notion', resolverKey: 'data_sources', config: { api_token: marker }, sourceId: 'source-one' })
    expect(codecs['plugin:resolveOptions'].decodeArguments(payload)).toEqual(args)
    expect(codecs['plugin:resolveOptions'].decodeArguments({ pluginId: 'github-issues', resolverKey: 'owners', config: {} })).toEqual(['github-issues', 'owners', {}])
    expect(codecs['plugin:list'].decodeArguments({})).toEqual([])
  })

  it('admits only retained plugin/resolver pairs and finite config without body-provided authority', () => {
    for (const [pluginId, resolvers] of Object.entries(TASK_SOURCE_RESOLVER_KEYS)) for (const resolver of resolvers) expect(codecs['plugin:resolveOptions'].validateArguments([pluginId, resolver, {}])).toBe(true)
    for (const args of [['notion', 'execute_arbitrary', {}], ['retired-plugin', 'owners', {}], ['notion', 'owners', {}], ['notion', 'data_sources', { arbitrary_api_key: 'private' }],
      ['notion', 'data_sources', {}, '../foreign'], ['notion', 'data_sources', {}, undefined, '../foreign']]) expect(codecs['plugin:resolveOptions'].validateArguments(args)).toBe(false)
    expect(() => codecs['plugin:resolveOptions'].decodeArguments({ pluginId: 'notion', resolverKey: 'data_sources', config: {}, caller: { projectId: 'foreign' } })).toThrow('arguments')
    expect(codecs['plugin:resolveOptions'].validateArguments(['notion', 'data_sources', { api_token: '\uFEFFsecret-雪\nsecond-line' }])).toBe(true)
    expect(codecs['plugin:resolveOptions'].validateArguments(['notion', 'data_sources', { api_token: '雪'.repeat(5462) }])).toBe(false)
  })

  it('retains genuine plugin metadata/documentation/null without inventing schema or secret output fields', () => {
    const metadata = { id: 'notion', displayName: 'Notion', description: 'Real metadata\nMore information', icon: 'Notebook' }
    expect(codecs['plugin:list'].encodeResult([metadata])).toEqual({ defined: true, value: [metadata] })
    expect(codecs['plugin:list'].validateResult([{ ...metadata, config: { api_token: 'private' } }])).toBe(false)
    expect(codecs['plugin:list'].validateResult([metadata, metadata])).toBe(false)
    expect(codecs['plugin:list'].validateResult([{ ...metadata, id: 'arbitrary-plugin' }])).toBe(false)
    const document = '# Setup\n\nUse the actual [provider settings](https://example.test/settings).'
    expect(codecs['plugin:getDocumentation'].encodeResult(document)).toEqual({ defined: true, value: document })
    expect(codecs['plugin:getDocumentation'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(codecs['plugin:getDocumentation'].validateWireResult({ defined: false })).toBe(false)
    expect(() => codecs['plugin:getDocumentation'].encodeResult('雪'.repeat(42_667))).toThrow('result')
  })

  it('preserves JSON property option values and multibyte labels, rejecting private extras and oversized results', () => {
    const property = JSON.stringify({ name: 'Status', type: 'status', options: [{ value: 'Done', label: 'Done' }] })
    const options = [{ value: property, label: 'Status — 状態' }, { value: '', label: 'No filter' }]
    expect(codecs['plugin:resolveOptions'].encodeResult(options)).toEqual({ defined: true, value: options })
    expect(isTaskSourceResolverOptions([{ value: 'remote-id', label: 'Label', access_token: 'private' }])).toBe(false)
    expect(isTaskSourceResolverOptions([{ value: 'remote-id', label: '\0private' }])).toBe(false)
    expect(isTaskSourceResolverOptions(Array.from({ length: TASK_SOURCE_PLUGIN_LIMITS.options + 1 }, () => options[0]))).toBe(false)
    expect(isTaskSourceResolverOptions([{ value: 'x'.repeat(TASK_SOURCE_PLUGIN_LIMITS.optionValue + 1), label: 'Label' }])).toBe(false)
    expect(isTaskSourceResolverOptions(Array.from({ length: 512 }, () => ({ value: '雪'.repeat(4096), label: 'Label' })))).toBe(false)
    expect(codecs['plugin:resolveOptions'].validateWireResult({ defined: true, value: options, error: 'private-provider-error' })).toBe(false)
  })
})

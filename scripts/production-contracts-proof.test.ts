import { describe, expect, it } from 'vitest'
import { createProductionRequestCorpus, PROOF_COMMAND_CODECS, writeProductionRequestCorpus } from './production-contracts-proof'
import { isRecord } from '../src/shared/service-protocol'
import { PRODUCTION_COMMAND_CODECS } from '../src/service/production-desktop-bindings'
import { CONNECTOR_WRITE_ERROR, CONNECTOR_STORAGE_REMEDIATION, CONNECTOR_SYNC_ERROR } from '../src/shared/connector-codecs'
import { TASK_SOURCE_RESOLVER_KEYS } from '../src/shared/task-source-plugin-codecs'

describe('actual production TypeScript-to-native golden request corpus', () => {
  it('uses the actual production override map and encodes all 114 finite command fixtures', () => {
    const corpus = createProductionRequestCorpus()
    expect(corpus.operations).toEqual(Object.keys(PRODUCTION_COMMAND_CODECS).sort())
    expect(corpus.operations).toHaveLength(114)
    expect(new Set(corpus.requests.map(row => row.operation))).toEqual(new Set(corpus.operations))
    for (const row of corpus.requests) {
      const codec = PRODUCTION_COMMAND_CODECS[row.operation as keyof typeof PRODUCTION_COMMAND_CODECS]
      expect(codec.validateArguments(codec.decodeArguments(row.payload)), `${row.operation}/${row.case}`).toBe(true)
    }
  })
  it('includes nested transcript paging, optional metadata and image/tool history cases rather than generic data', () => {
    const corpus = createProductionRequestCorpus()
    expect(corpus.requests.find(row => row.operation === 'agentSession:getTranscriptPage' && row.case === 'baseline')?.payload).toEqual({ taskId: 'task_fixture', page: { version: 1, mode: 'snapshot', after: 0 } })
    expect(corpus.requests.some(row => row.case === 'all-optional-fields' && row.operation === 'skills:create')).toBe(true)
    expect(corpus.requests.find(row => row.case === 'nullable-git-fields')?.payload).toEqual({ id: 'project_fixture', data: { git_provider: null, git_org: null } })
    expect(corpus.requests.some(row => row.case === 'tool-history')).toBe(true)
    const large = corpus.requests.find(row => row.case === 'frame-bounded-large-config')!
    expect(Buffer.byteLength(JSON.stringify(large.payload))).toBeGreaterThan(900_000)
    expect(Buffer.byteLength(JSON.stringify(large.payload))).toBeLessThan(1024 * 1024 - 1024)
    const image = corpus.requests.find(row => row.case === 'image-only')?.payload
    expect(image).toMatchObject({ sessionId: 'session_fixture', text: '', images: { version: 1, images: [{ encoding: 'base64', byteLength: 12 }] } })
  })
  it('rejects an added payload authority grant through every actual TypeScript codec', () => {
    const corpus = createProductionRequestCorpus()
    for (const row of corpus.requests) {
      expect(isRecord(row.payload)).toBe(true)
      const codec = PROOF_COMMAND_CODECS[row.operation as keyof typeof PROOF_COMMAND_CODECS]
      expect(() => codec.decodeArguments({ ...(row.payload as Record<string, unknown>), authority: { namespace: '*' } } as never), `${row.operation}/${row.case}`).toThrow()
    }
  })
  it('covers every source plugin and exact MCP credential/OAuth and source mutation shapes', () => {
    const corpus = createProductionRequestCorpus()
    const sources = corpus.requests.filter(row => row.operation === 'taskSource:create')
    expect(new Set(sources.map(row => isRecord(row.payload) && isRecord(row.payload.data) ? row.payload.data.plugin_id : undefined))).toEqual(new Set(['linear', 'hubspot', 'github-issues', 'forgejo-issues', 'notion', 'youtrack', 'connector-bridge']))
    expect(corpus.requests.find(row => row.case === 'empty-project-filter')?.payload).toEqual({ projectId: '' })
    expect(corpus.requests.find(row => row.case === 'connector-fractional-poll-config')?.payload).toMatchObject({ data: { config: { poll_interval_minutes: 0.5 } } })
    expect(corpus.requests.find(row => row.case === 'finite-source-credential-write')?.payload).toMatchObject({ data: { config: { api_token: 'synthetic\nfixture-credential' } } })
    expect(corpus.requests.find(row => row.operation === 'mcp:submitManualClientId')?.payload).toEqual({ id: 'mcp.fixture:one', clientId: 'fixture-client-id' })
    expect(corpus.requests.find(row => row.operation === 'taskSource:reassign' && row.case === 'baseline')?.payload).toEqual({ taskId: 'task_fixture', userIds: ['external:user-one', 'external:user-two'], assigneeDisplay: 'Fixture Users' })
    expect(() => PROOF_COMMAND_CODECS['mcp:create'].encodeArguments([{ name: 'Fixture', oauth_metadata: { client_secret: 'foreign' } }] as never)).toThrow()
    expect(() => PROOF_COMMAND_CODECS['taskSource:update'].encodeArguments(['source_fixture', { config: { command: 'arbitrary' } }])).toThrow()
    expect(() => PROOF_COMMAND_CODECS['agent:update'].encodeArguments(['agent_fixture', { config: { api_keys: { foreign: 'synthetic' } } }] as never)).toThrow()
  })
  it('retains explicit outcomes and projects all credential-bearing DTOs before result transport', () => {
    const mcp = { id: 'mcp.fixture:one', name: 'Fixture', type: 'local', command: 'fixture-mcp', args: [], url: '', headers: { Authorization: 'synthetic-private-header' }, environment: { FIXTURE_TOKEN: 'synthetic-private-env' }, tools: [], oauth_metadata: { client_secret: 'synthetic-private-client' }, source: 'user', created_at: '2026-10-14', updated_at: '2026-10-14' }
    const mcpResult = PROOF_COMMAND_CODECS['mcp:create'].encodeResult(mcp)
    expect(mcpResult).toMatchObject({ defined: true, value: { headers: { Authorization: '__21x_mcp_secret_set__' }, environment: { FIXTURE_TOKEN: '__21x_mcp_secret_set__' }, oauth_metadata: { client_secret: '__21x_mcp_secret_set__' } } })
    expect(PROOF_COMMAND_CODECS['mcp:create'].validateWireResult(mcpResult)).toBe(true)
    expect(PROOF_COMMAND_CODECS['mcp:create'].validateWireResult({ defined: true, value: mcp })).toBe(false)
    expect(() => PROOF_COMMAND_CODECS['mcp:create'].encodeResult(undefined)).toThrow()
    expect(PROOF_COMMAND_CODECS['mcp:update'].encodeResult(undefined)).toEqual({ defined: false })
    const source = { id: 'source_fixture', mcp_server_id: null, name: 'Fixture', plugin_id: 'notion', config: { api_token: 'synthetic-private-token', data_source_id: 'external:database', hidden_internal: 'private' }, list_tool: 'legacy_list', list_tool_args: { secret: 'private' }, update_tool: 'legacy_update', update_tool_args: { secret: 'private' }, last_synced_at: null, enabled: false, project_id: 'project_fixture', created_at: '2026-10-14', updated_at: '2026-10-14' }
    const result = PROOF_COMMAND_CODECS['taskSource:create'].encodeResult(source)
    expect(result).toMatchObject({ defined: true, value: { config: { api_token: '__21x_api_key_set__', data_source_id: 'external:database' }, list_tool_args: {}, update_tool_args: {} } })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(PROOF_COMMAND_CODECS['taskSource:create'].validateWireResult(result)).toBe(true)
    expect(PROOF_COMMAND_CODECS['taskSource:create'].validateWireResult({ defined: true, value: source })).toBe(false)
    expect(() => PROOF_COMMAND_CODECS['taskSource:create'].encodeResult(undefined)).toThrow()
    expect(PROOF_COMMAND_CODECS['taskSource:update'].encodeResult(undefined)).toEqual({ defined: false })
    expect(PROOF_COMMAND_CODECS['taskSource:exportUpdate'].encodeResult(undefined)).toEqual({ defined: false })
    const sync = { source_id: 'source_fixture', imported: 0, updated: 1, errors: ['Explicit source refusal'] }
    expect(PROOF_COMMAND_CODECS['taskSource:sync'].decodeResult(sync)).toEqual(sync)
    expect(PROOF_COMMAND_CODECS['taskSource:reassign'].decodeResult({ success: false, error: 'Explicit source refusal' })).toEqual({ success: false, error: 'Explicit source refusal' })
  })
  it('rejects malformed connector credentials, storage/scope grants and field byte overflows', () => {
    const set = PROOF_COMMAND_CODECS['connectors:setCredentials'], oauth = PROOF_COMMAND_CODECS['connectors:oauthConnect']
    for (const secret of ['__21x_api_key_set__', '__21x_mcp_secret_set__', ' __21x_api_key_set__ ', 'bad\0value', 'bad\nvalue', '', 'x'.repeat(4097), 'é'.repeat(2049)]) expect(() => set.encodeArguments(['connector.fixture:one', { secret }]), secret.slice(0, 20)).toThrow()
    expect(() => set.decodeArguments({ instanceId: 'connector.fixture:one', input: { secret: 'fixture', authority: { namespace: '*' } } })).toThrow()
    expect(() => set.decodeArguments({ instanceId: 'connector.fixture:one', input: { secret: 'fixture' }, storage: 'file', profileRoot: '/foreign/profile' })).toThrow()
    expect(() => oauth.decodeArguments({ instanceId: 'connector.fixture:one', input: { accessToken: 'foreign' } })).toThrow()
    expect(() => PROOF_COMMAND_CODECS['connectors:ensureInstance'].encodeArguments(['@activepieces/piece-foreign'])).toThrow()
    const failure = set.encodeResult({ ok: false, error: 'private backend details', remediation: 'private path', sessionOnlyAvailable: true })
    expect(failure).toEqual({ defined: true, value: { ok: false, error: CONNECTOR_WRITE_ERROR, remediation: CONNECTOR_STORAGE_REMEDIATION, sessionOnlyAvailable: true } })
    expect(set.validateWireResult({ defined: true, value: { ok: false, error: 'private backend details' } })).toBe(false)
    const sync = PROOF_COMMAND_CODECS['connectors:syncStatus'].encodeResult({ lastError: 'private connector response', lastSyncedAt: null, attemptCount: 1, nextRetryAt: 500, deadLetterCount: 0 })
    expect(sync).toMatchObject({ defined: true, value: { lastError: CONNECTOR_SYNC_ERROR } })
    expect(PROOF_COMMAND_CODECS['connectors:clearCredentials'].encodeResult(undefined)).toEqual({ defined: false })
    expect(PROOF_COMMAND_CODECS['connectors:credentialStatus'].validateWireResult({ defined: true, value: { storage: 'session', persistentAvailable: true, secret: 'private' } })).toBe(false)
    const corpus = createProductionRequestCorpus()
    expect(corpus.requests.find(row => row.case === 'typed-omitted-client-secret')?.payload).toEqual({ instanceId: 'connector.fixture:one', input: { clientId: 'fixture-client' }, storage: 'persistent' })
    expect(corpus.requests.find(row => row.case === 'typed-omitted-unused-secret')?.payload).toEqual({ instanceId: 'connector.fixture:one', input: { username: 'fixture-user', password: 'synthetic-fixture-password' }, storage: 'session' })
    expect(() => oauth.encodeArguments(['connector.fixture:one', { clientId: 'fixture', foreign: undefined }] as never)).toThrow()
  })
  it('covers every retained plugin resolver pair and keeps source identity in the fifth argument', () => {
    const corpus = createProductionRequestCorpus(), expected = Object.entries(TASK_SOURCE_RESOLVER_KEYS).flatMap(([plugin, resolvers]) => resolvers.map(resolver => `resolver-${plugin}-${resolver}`))
    expect(corpus.requests.filter(row => row.operation === 'plugin:resolveOptions' && row.case.startsWith('resolver-') && row.case !== 'resolver-credential-byte-boundary').map(row => row.case).sort()).toEqual(expected.sort())
    const scoped = corpus.requests.find(row => row.case === 'fifth-only-source-scope')!
    expect(scoped.payload).toEqual({ pluginId: 'linear', resolverKey: 'users', config: {}, sourceId: 'source_fixture' })
    const resolver = PROOF_COMMAND_CODECS['plugin:resolveOptions']
    expect(resolver.decodeArguments(scoped.payload)).toEqual(['linear', 'users', {}, undefined, 'source_fixture'])
    for (const args of [ ['notion', 'owners', {}], ['unknown-plugin', 'users', {}], ['linear', 'users', { authority: '*' }], ['notion', 'data_sources', { api_token: 'bad\0secret' }], ['notion', 'data_sources', { api_token: 'x'.repeat(16385) }], ['linear', 'users', {}, '/foreign/path'] ]) expect(() => resolver.encodeArguments(args as never)).toThrow()
    expect(() => resolver.decodeArguments({ pluginId: 'linear', resolverKey: 'users', config: {}, profileRoot: '/private' })).toThrow()
    expect(PROOF_COMMAND_CODECS['plugin:getDocumentation'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(() => PROOF_COMMAND_CODECS['plugin:getDocumentation'].encodeResult(undefined)).toThrow()
    expect(() => PROOF_COMMAND_CODECS['plugin:getDocumentation'].encodeResult('x'.repeat(128001))).toThrow()
    expect(resolver.validateWireResult({ defined: true, value: [{ value: 'external:user', label: 'Fixture\nUser' }] })).toBe(true)
    expect(resolver.validateWireResult({ defined: true, value: [{ value: 'external:user', label: 'Fixture', secret: 'private' }] })).toBe(false)
    expect(resolver.validateWireResult({ defined: true, value: [{ value: 'external:user', label: 'é'.repeat(2049) }] })).toBe(false)
    expect(PROOF_COMMAND_CODECS['plugin:list'].validateWireResult({ defined: true, value: [{ id: 'linear', displayName: 'Linear', description: '', icon: 'linear' }, { id: 'linear', displayName: 'Duplicate', description: '', icon: 'linear' }] })).toBe(false)
  })
  it('exports the validated corpus only when the coordinator selects an artifact path', async () => {
    const path = process.env.TWENTYONEX_PRODUCTION_CONTRACTS_OUT
    if (!path) return
    const corpus = await writeProductionRequestCorpus(path)
    expect(corpus.operations).toHaveLength(114)
  })
})

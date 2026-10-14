import { AGENT_INSTALLER_CODECS, AGENT_INSTALLER_DETECTION_KEYS } from '../src/shared/agent-installer-codecs'
import { ARTIFACT_CODECS } from '../src/shared/artifact-codecs'
import { describe, expect, it } from 'vitest'
import { createProductionRequestCorpus, PROOF_COMMAND_CODECS, writeProductionRequestCorpus } from './production-contracts-proof'
import { isRecord } from '../src/shared/service-protocol'
import { PRODUCTION_COMMAND_CODECS } from '../src/service/production-desktop-bindings'
import { CONNECTOR_WRITE_ERROR, CONNECTOR_STORAGE_REMEDIATION, CONNECTOR_SYNC_ERROR } from '../src/shared/connector-codecs'
import { TASK_SOURCE_RESOLVER_KEYS } from '../src/shared/task-source-plugin-codecs'
import { CLAUDE_PLUGIN_LOCAL_SOURCE } from '../src/shared/claude-plugin-codecs'
import { SESSION_CONTEXT_GENERATION_STATES, SESSION_CONTEXT_HANDOFF_STATES } from '../src/shared/session-context-codecs'
import { MOBILE_EVENTS, MOBILE_EVENT_CODECS } from '../src/shared/mobile-codecs'
import { sanitizeChatImageName, base64ByteLength } from '../src/shared/chat-images'

describe('actual production TypeScript-to-native golden request corpus', () => {
  it('uses the actual production override map and encodes all 223 finite command fixtures', () => {
    const corpus = createProductionRequestCorpus()
    expect(corpus.operations).toEqual(Object.keys(PRODUCTION_COMMAND_CODECS).sort())
    expect(corpus.operations).toHaveLength(223)
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
  it('covers CLI UTF16 limits, finite maps and ECMA trim without exceeding the native envelope', () => {
    const corpus = createProductionRequestCorpus(), rows = corpus.requests.filter(row => row.case.startsWith('cli-'))
    expect(rows.map(row => row.case)).toEqual(['cli-ecma-nonwhitespace-name-command', 'cli-utf16-args-env-boundaries', 'cli-http-url-header-boundaries', 'cli-sse-empty-records', 'cli-utf16-tool-boundary'])
    for (const row of rows) expect(Buffer.byteLength(JSON.stringify({ protocolVersion: 1, kind: 'request', id: 'fixture', engineEpoch: 'engine-fixture', operation: row.operation, payload: row.payload }))).toBeLessThan(900000)
    expect(rows[0].payload).toMatchObject({ request: { name: '\u0085', definition: { command: '\u0085' } } })
    const bounded = PROOF_COMMAND_CODECS['cliMcp:upsert'].decodeArguments(rows[1].payload)[0]
    expect(bounded.targets).toEqual(['claude-code', 'opencode', 'codex'])
    expect(bounded.name.length).toBe(128); expect(bounded.definition.command?.length).toBe(4096)
    expect(bounded.definition.args).toHaveLength(128); expect(bounded.definition.args?.[127].length).toBe(4096)
    expect(Object.keys(bounded.definition.env!)).toHaveLength(128); expect(bounded.definition.env?.FIXTURE_127.length).toBe(16384)
    const remote = PROOF_COMMAND_CODECS['cliMcp:upsert'].decodeArguments(rows[2].payload)[0]
    expect(remote.definition.url?.length).toBe(4096); expect(Object.keys(remote.definition.headers!)).toHaveLength(128)
    expect(remote.definition.headers?.['X-Fixture-127'].length).toBe(16384)
    const upsert = PROOF_COMMAND_CODECS['cliMcp:upsert']
    for (const request of [
      { ...bounded, name: bounded.name + 'x' },
      { ...bounded, definition: { ...bounded.definition, command: bounded.definition.command + 'x' } },
      { ...bounded, definition: { ...bounded.definition, args: [...bounded.definition.args!, 'overflow'] } },
      { ...bounded, definition: { ...bounded.definition, env: { ...bounded.definition.env, EXTRA: 'overflow' } } },
      { ...bounded, definition: { ...bounded.definition, env: { FIXTURE: '🌱'.repeat(8192) + 'x' } } },
      { ...remote, definition: { ...remote.definition, headers: { ...remote.definition.headers, EXTRA: 'overflow' } } },
      { ...remote, definition: { transport: 'http', url: 'https://fixture.example/mcp?token=private' } },
      { ...bounded, name: '\uFEFF', definition: { transport: 'stdio', command: 'fixture' } },
      { ...bounded, definition: { transport: 'stdio', command: '\uFEFF' } },
      { ...bounded, name: '\ud800' }
    ]) expect(() => upsert.encodeArguments([request] as never)).toThrow()
    expect(() => PROOF_COMMAND_CODECS['cliMcp:setToolEnabled'].encodeArguments([{ cli: 'codex', name: 'fixture', tool: '🌱'.repeat(64) + 'x', enabled: true }])).toThrow()
  })
  it('covers plain-base64 image totals and raw name compatibility with exact metadata and undefined removal', () => {
    const corpus = createProductionRequestCorpus(), rows = corpus.requests.filter(row => row.case.startsWith('attachment-'))
    expect(rows.map(row => row.case)).toEqual(['attachment-single-512k-plain-base64', 'attachment-five-total-512k', 'attachment-raw-name-sanitization', 'attachment-empty-images', 'attachment-uppercase-version-five-uuid'])
    const save = PROOF_COMMAND_CODECS['chatImages:saveToTask'], remove = PROOF_COMMAND_CODECS['attachments:remove']
    for (const row of rows) expect(Buffer.byteLength(JSON.stringify({ protocolVersion: 1, kind: 'request', id: 'fixture', engineEpoch: 'engine-fixture', operation: row.operation, payload: row.payload }))).toBeLessThan(900000)
    const [, single] = save.decodeArguments(rows[0].payload), [, five] = save.decodeArguments(rows[1].payload)
    expect(single).toHaveLength(1); expect(base64ByteLength(single[0].data)).toBe(512 * 1024)
    expect(typeof single[0].data).toBe('string'); expect(single[0].data.startsWith('data:')).toBe(false)
    expect(five).toHaveLength(5); expect(five.reduce((total, image) => total + base64ByteLength(image.data), 0)).toBe(512 * 1024)
    const [, rawNames] = save.decodeArguments(rows[2].payload)
    expect(rawNames[0].name).toBe('../unsafe\0.png')
    expect(rawNames.map(image => sanitizeChatImageName(image.name, image.mimeType))).toEqual(['unsafe.png', 'image-CON.png', 'fixture.png', 'report.png', 'image.png'])
    expect(save.decodeArguments(rows[3].payload)).toEqual(['task_fixture', []])
    expect(remove.decodeArguments(rows[4].payload)).toEqual(['t'.repeat(128), 'ABCDEFAB-CDEF-5ABC-ABCD-ABCDEFABCDEF'])
    const tooLarge = Buffer.alloc(512 * 1024 + 1); tooLarge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (const images of [[...rawNames, rawNames[0]], [{ ...single[0], data: tooLarge.toString('base64') }], [{ ...rawNames[0], data: 'data:image/png;base64,iVBORw0KGgoAAAAA' }], [{ ...rawNames[0], data: 'not-base64' }], [{ ...rawNames[0], name: '\ud800' }]]) expect(() => save.encodeArguments(['task_fixture', images])).toThrow()
    for (const id of ['00000000-0000-0000-8000-000000000001', '00000000-0000-4000-7000-000000000001', '../file']) expect(() => remove.encodeArguments(['task_fixture', id])).toThrow()
    const record = { id: '00000000-0000-4000-8000-000000000001', filename: 'unsafe.png', size: 12, mime_type: 'image/png', added_at: '2026-10-14T00:00:00Z' }
    expect(save.encodeResult([record])).toEqual({ defined: true, value: [record] })
    expect(save.validateWireResult({ defined: true, value: [{ ...record, path: '/private/file', data: 'private' }] })).toBe(false)
    expect(save.validateWireResult({ defined: true, value: [{ ...record, filename: '../unsafe.png' }] })).toBe(false)
    expect(save.validateWireResult({ defined: false })).toBe(false)
    expect(remove.encodeResult(undefined)).toEqual({ defined: false }); expect(remove.decodeResult(undefined)).toBeUndefined()
    for (const value of [{ defined: true, value: true }, { defined: false, value: null }]) expect(remove.validateWireResult(value)).toBe(false)
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
  it('covers finite rollover policies and full context states without adding owner authority', () => {
    const corpus = createProductionRequestCorpus(), policy = { mode: 'observe', contextRatio: 0.6, compactions: 3, wakeups: 20, turns: 10, maxAgeDays: 7 }
    expect(corpus.requests.filter(row => row.case.startsWith('rollover-mode-')).map(row => row.case)).toEqual(['rollover-mode-off', 'rollover-mode-observe', 'rollover-mode-on'])
    const codec = PROOF_COMMAND_CODECS['sessionContext:setPolicy']
    for (const extra of [{ mode: 'automatic' }, { contextRatio: 0 }, { contextRatio: 1.1 }, { compactions: 0 }, { wakeups: 1000001 }, { turns: 1.5 }, { maxAgeDays: 3651 }]) expect(() => codec.encodeArguments([{ ...policy, ...extra }] as never)).toThrow()
    expect(() => codec.decodeArguments({ policy, ownerId: 'foreign_owner' })).toThrow()
    const snapshot = { scope: { kind: 'commander', ownerId: 'session_fixture' }, generation: { id: 'generation:fixture', key: 'chat:fixture', engine: 'chat', state: 'running', createdAt: 100, backendId: null }, usage: { tokens: 1200, source: 'estimated', contextWindow: 16000, model: 'fixture/model', observedAt: 110 }, counters: { compactions: 1, wakeups: 0, turns: 2, ageMs: 10 }, policy, reasons: ['turns'], warnings: ['Human\nwarning'], summaries: [{ id: 'summary:fixture', content: 'Human\nsummary', kind: 'summary', createdAt: 105, source: 'fallback' }], handoff: { id: 'handoff:fixture', state: 'creation_unconfirmed' } }
    const context = PROOF_COMMAND_CODECS['sessionContext:getSnapshot']
    for (const state of SESSION_CONTEXT_GENERATION_STATES) expect(context.validateWireResult({ defined: true, value: { ...snapshot, generation: { ...snapshot.generation, state } } })).toBe(true)
    for (const state of SESSION_CONTEXT_HANDOFF_STATES) expect(context.validateWireResult({ defined: true, value: { ...snapshot, handoff: { ...snapshot.handoff, state } } })).toBe(true)
    expect(context.validateWireResult({ defined: true, value: { ...snapshot, generation: null, usage: { tokens: null, source: 'unknown', contextWindow: null, model: null, observedAt: null }, handoff: null } })).toBe(true)
    expect(context.validateWireResult({ defined: true, value: { ...snapshot, usage: { ...snapshot.usage, source: 'unknown' } } })).toBe(false)
    expect(context.validateWireResult({ defined: true, value: { ...snapshot, summaries: [{ ...snapshot.summaries[0], content: 'x'.repeat(65537) }] } })).toBe(false)
    expect(context.validateWireResult({ defined: true, value: { ...snapshot, handoff: { ...snapshot.handoff, profileRoot: '/private' } } })).toBe(false)
    expect(context.validateWireResult({ defined: false })).toBe(false)
  })
  it('covers safe marketplace/install inputs and preserves public projections without private manifest/resources', () => {
    const corpus = createProductionRequestCorpus(), add = PROOF_COMMAND_CODECS['claudePlugin:addMarketplaceSource'], install = PROOF_COMMAND_CODECS['claudePlugin:installPlugin']
    expect(corpus.requests.find(row => row.case === 'typed-omitted-source-options')?.payload).toEqual({ data: { name: 'Fixture optional', source_url: 'fixture/marketplace' } })
    for (const name of ['../foreign', 'bad/path', 'CON', 'lpt1.json', 'trailing.', 'bad\0name', 'x'.repeat(129)]) expect(() => install.encodeArguments([name, 'marketplace.fixture:one'])).toThrow()
    expect(() => install.encodeArguments(['fixture-plugin', 'marketplace.fixture:one', 'project'])).toThrow()
    expect(() => install.decodeArguments({ pluginName: 'fixture-plugin', marketplaceId: 'marketplace.fixture:one', scope: 'user', profileRoot: '/private' })).toThrow()
    expect(() => add.encodeArguments([{ name: 'Fixture', source_type: 'local', source_url: CLAUDE_PLUGIN_LOCAL_SOURCE }])).toThrow()
    expect(() => add.encodeArguments([{ name: 'Fixture', source_type: 'url', source_url: 'https://user:pass@example.test/catalog' }])).toThrow()
    expect(() => add.encodeArguments([{ name: 'Fixture', source_url: 'fixture/marketplace#../foreign' }])).toThrow()
    const rawSource = { id: 'marketplace.fixture:one', name: 'Fixture', source_type: 'local', source_url: '/private/profile/catalog', metadata: { token: 'private' }, auto_update: false, created_at: '2026-10-14', updated_at: '2026-10-14' }
    expect(add.encodeResult(rawSource)).toEqual({ defined: true, value: { ...rawSource, source_url: CLAUDE_PLUGIN_LOCAL_SOURCE, metadata: {} } })
    expect(add.validateWireResult({ defined: true, value: rawSource })).toBe(false)
    const raw = { id: 'plugin.fixture:one', name: 'fixture-plugin', marketplace_id: rawSource.id, manifest: { name: 'fixture-plugin', author: 'Fixture Author', mcpServers: { private: { command: '/private/tool', env: { TOKEN: 'private' } } }, agents: '/private/agents' }, source: { source: 'github', repo: 'fixture/marketplace', auth: 'private' }, scope: 'user', enabled: true, version: '1.0', installed_at: '2026-10-14', updated_at: '2026-10-14' }
    const projected = install.encodeResult(raw)
    expect(projected).toMatchObject({ defined: true, value: { manifest: { name: 'fixture-plugin', author: { name: 'Fixture Author' } }, source: { source: 'github', repo: 'fixture/marketplace' } } })
    expect(JSON.stringify(projected)).not.toContain('private')
    expect(install.validateWireResult({ defined: true, value: raw })).toBe(false)
    const resources = PROOF_COMMAND_CODECS['claudePlugin:getPluginResources'].encodeResult({ skills: [{ id: 'skill:fixture', name: 'Fixture', description: 'Public description' }], mcpServers: [{ id: 'mcp:fixture', name: 'Fixture', command: '/private/tool', args: ['private'] }], agents: [{ id: 'agent:fixture', name: 'Fixture', description: 'private system prompt' }], commands: [{ name: 'commands/fixture.md', content: 'private command body' }] })
    expect(resources).toMatchObject({ defined: true, value: { mcpServers: [{ command: '', args: [] }], agents: [{ description: '' }], commands: ['commands/fixture.md'] } })
    expect(JSON.stringify(resources)).not.toContain('private')
    expect(PROOF_COMMAND_CODECS['claudePlugin:enablePlugin'].encodeResult(undefined)).toEqual({ defined: false })
    expect(PROOF_COMMAND_CODECS['claudePlugin:fetchCatalog'].encodeResult(null)).toEqual({ defined: true, value: null })
    expect(() => install.encodeResult(undefined)).toThrow()
  })
  it('covers exact mobile settings, pairing URLs and public session/event boundaries', () => {
    const corpus = createProductionRequestCorpus(), access = PROOF_COMMAND_CODECS['mobile:setAccess'], custom = PROOF_COMMAND_CODECS['mobile:setCustomUrl']
    expect(corpus.requests.find(row => row.case === 'mobile-typed-omitted-option')?.payload).toEqual({ options: { enabled: false } })
    expect(corpus.requests.find(row => row.case === 'mobile-fractional-idle')?.payload).toEqual({ options: { sessionIdleDays: 0.125 } })
    for (const options of [{}, { enabled: undefined }, { enabled: 'true' }, { sessionIdleDays: 0 }, { sessionIdleDays: 366 }, { enabled: true, profileRoot: '/private' }]) expect(() => access.encodeArguments([options] as never)).toThrow()
    for (const url of ['file:///private', 'https://user:pass@example.test', 'https://example.test?token=private', 'https://example.test#private', ' https://example.test', 'https://example.test/bad\0path']) expect(() => custom.encodeArguments([url])).toThrow()
    expect(() => custom.encodeArguments(['https://mobile.example.test/' + 'x'.repeat(2049 - 'https://mobile.example.test/'.length)])).toThrow()
    expect(corpus.requests.find(row => row.case === 'mobile-address-byte-boundary')?.payload).toMatchObject({ url: expect.any(String) })
    expect(() => PROOF_COMMAND_CODECS['mobile:revokeSession'].decodeArguments({ sessionId: 'mobile.fixture:one', caller: { capabilities: ['*'] } })).toThrow()
    const info = { enabled: false, lanAccess: false, sessionIdleDays: 7, url: 'http://127.0.0.1:3210/pair?code=init.fixture:one', port: 3210, lanUrl: null, tunnelUrl: null, tunnelActive: false, remoteMode: 'quick', customUrl: null }
    const getInfo = PROOF_COMMAND_CODECS['mobile:getInfo']
    expect(getInfo.validateWireResult({ defined: true, value: info })).toBe(true)
    for (const url of ['https://example.test/pair?code=one&code=two', 'https://example.test/pair?code=one&token=private', 'https://example.test/not-pair?code=one', 'https://example.test/pair?code=bad%2Fcode']) expect(getInfo.validateWireResult({ defined: true, value: { ...info, url } })).toBe(false)
    expect(getInfo.validateWireResult({ defined: true, value: { ...info, sessionToken: 'private' } })).toBe(false)
    const row = { id: 'mobile.fixture:one', device_name: 'Fixture Phone', paired_at: 1000, last_seen: 1001 }
    expect(PROOF_COMMAND_CODECS['mobile:getSessions'].encodeResult([{ ...row, revoked: false }])).toEqual({ defined: true, value: [row] })
    expect(() => PROOF_COMMAND_CODECS['mobile:getSessions'].encodeResult([{ ...row, token_hash: 'private' }])).toThrow()
    expect(PROOF_COMMAND_CODECS['mobile:getSessions'].validateWireResult({ defined: true, value: [row, row] })).toBe(false)
    expect(PROOF_COMMAND_CODECS['mobile:startTunnel'].validateWireResult({ defined: false })).toBe(false)
    expect(MOBILE_EVENTS).toEqual(['mobile:pairing-initiated', 'mobile:device-connected'])
    expect(MOBILE_EVENT_CODECS['mobile:pairing-initiated'].validatePayload({ pin: '123456', pairCodeId: 'pair.fixture:one', expiresAt: 1000 })).toBe(true)
    expect(MOBILE_EVENT_CODECS['mobile:pairing-initiated'].validatePayload({ pin: '12345', pairCodeId: 'fixture', expiresAt: 1000 })).toBe(false)
    expect(MOBILE_EVENT_CODECS['mobile:device-connected'].validatePayload({ sessionId: row.id, deviceName: row.device_name, sessionToken: 'private' })).toBe(false)
    expect(() => MOBILE_EVENT_CODECS['mobile:device-connected'].decodePayload({ sessionId: row.id, deviceName: 'bad\0name' })).toThrow()
  })
  it('keeps CLI metadata and artifact DTOs exact without exposing raw child output or arbitrary file authority', () => {
    const codec = AGENT_INSTALLER_CODECS['agent-installer:detect']
    const snapshot = Object.fromEntries(AGENT_INSTALLER_DETECTION_KEYS.map(key => [key, { installed: false, version: null }]))
    Object.assign(snapshot, { pi: { installed: false, version: null, supported: false, reason: 'Pi CLI is not installed.' },
      rtk: { installed: false, version: null, configured: false, integrations: { claudeCode: false, opencode: false, codex: false, cursor: false, pi: false } } })
    expect(codec.encodeResult(snapshot)).toEqual({ defined: true, value: snapshot })
    expect(() => codec.encodeResult({ ...snapshot, codex: { installed: false, version: null, stdout: 'private child output' } })).toThrow()
    expect(() => ARTIFACT_CODECS['artifacts:read'].decodeArguments({ taskId: 'task_fixture', relativePath: '../private.txt' })).toThrow()
    expect(() => ARTIFACT_CODECS['artifacts:read'].encodeResult({ kind: 'text', content: 'x'.repeat(128 * 1024 + 1) })).toThrow()
    expect(ARTIFACT_CODECS['artifacts:read'].encodeResult({ kind: 'text', content: 'Owned YAML', mimeType: 'application/yaml' })).toEqual({ defined: true, value: { kind: 'text', content: 'Owned YAML', mimeType: 'application/yaml' } })
  })
  it('exports the validated corpus only when the coordinator selects an artifact path', async () => {
    const path = process.env.TWENTYONEX_PRODUCTION_CONTRACTS_OUT
    if (!path) return
    const corpus = await writeProductionRequestCorpus(path)
    expect(corpus.operations).toHaveLength(223)
  })
})

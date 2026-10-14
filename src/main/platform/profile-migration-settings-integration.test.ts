import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applySchema } from '../database/schema'
import { AuthenticatedSecretStorage, AUTHENTICATED_SECRET_FORMAT } from './authenticated-secret-storage'
import { acquireProfileLock } from './profile-lock'
import { createProfileMigrationFixture, rehearseProfileCredentialImport } from './profile-migration-rehearsal'
import { DEFAULT_PROJECT_ID } from '../../shared/projects'
import type { RecordCredentialProvenance } from './record-credential-conversion'

it('reopens a rehearsal candidate using actual DatabaseManager credential readers and format-aware writes', async () => {
  // Fresh bootstrap is separate from shared Electron test setup, as in a new host.
  vi.resetModules()
  const sourceRoot = createProfileMigrationFixture()
  const readerRoot = createProfileMigrationFixture()
  const sourceLock = acquireProfileLock(sourceRoot)
  const readerLock = acquireProfileLock(readerRoot)
  const sourceKey = randomBytes(32)
  const destinationKey = randomBytes(32)
  // Real authenticated transformations; synthetic in-memory keys are not OS proof.
  const legacy = new AuthenticatedSecretStorage(sourceKey, 'synthetic-settings-legacy')
  const destination = new AuthenticatedSecretStorage(destinationKey, 'synthetic-settings-destination')
  sourceKey.fill(0)
  destinationKey.fill(0)
  const originalSetting = 'safeStorage:v1:' + legacy.encryptString('\uFEFFsynthetic-setting-雪-🔑').toString('base64')
  const originalAgentConfig = ' { "api_keys" : {"openai":"fixture-agent-openai","anthropic":"fixture-agent-anthropic","cursor":"fixture-agent-cursor"}, "coding_agent":"codex", "model":"gpt-4o", "historical_metadata":{"number":1e2} } '
  const originalHeaders = '{"Authorization":"Bearer fixture-header","X-Version":"fixture-version"}'
  const originalEnvironment = '{"TOKEN":"fixture-env","EMPTY":""}'
  const originalOAuthMetadata = JSON.stringify({ resource_url: 'https://example.test', authorization_server_url: 'https://example.test', authorization_endpoint: 'https://example.test/authorize',
    token_endpoint: 'https://example.test/token', client_id: 'fixture-client', client_secret: 'fixture-mcp-client-secret', registration_method: 'manual', discovered_at: 'fixture-discovery' })
  const originalSourceConfig = '{"client_secret":"fixture-source-client","access_token":"fixture-source-access","api_token":"fixture-source-api","auth_type":"private_app","historical_filters":{"number":1e2}}'
  const recordInterpretations: RecordCredentialProvenance[] = [
    ...['openai', 'anthropic', 'cursor'].map(key => ({ location: { table: 'agents' as const, rowId: 'agent-json', column: 'config' as const, jsonPath: ['api_keys', key] as const }, interpretation: 'plaintext-utf8' as const })),
    ...['Authorization', 'X-Version'].map(key => ({ location: { table: 'mcp_servers' as const, rowId: 'mcp-json', column: 'headers' as const, jsonPath: [key] as const }, interpretation: 'plaintext-utf8' as const })),
    { location: { table: 'mcp_servers', rowId: 'mcp-json', column: 'environment', jsonPath: ['TOKEN'] }, interpretation: 'plaintext-utf8' },
    { location: { table: 'mcp_servers', rowId: 'mcp-json', column: 'oauth_metadata', jsonPath: ['client_secret'] }, interpretation: 'plaintext-utf8' },
    ...(['client_secret', 'access_token', 'api_token'] as const).map(key => ({ location: { table: 'task_sources' as const, rowId: 'source-json', column: 'config' as const, jsonPath: [key] as const }, interpretation: 'plaintext-utf8' as const }))
  ]
  const { configureSecretStorage } = await import('./secret-storage')
  configureSecretStorage(destination)
  const { DatabaseManager } = await import('../database/manager')
  const { ConnectorStore } = await import('../connectors/connector-store')
  const { ConnectorCredentialStore } = await import('../connectors/credentials')
  const manager = new DatabaseManager({
    paths: { profileRoot: readerLock.profileRoot, workspaceRoot: join(readerRoot, 'workspaces'), attachmentRoot: join(readerRoot, 'attachments') },
    managedTaskMcp: { disabled: true }, logger: { log: () => {}, error: () => {} }
  })
  try {
    const source = new Database(join(sourceLock.profileRoot, '21x.db'))
    try {
      // Match production fixture setup to avoid individually durable schema DDL.
      source.pragma('journal_mode=WAL')
      source.pragma('synchronous=NORMAL')
      source.pragma('foreign_keys=ON')
      applySchema(source)
      source.transaction(() => {
        source.prepare('INSERT INTO secrets(id,name,env_var_name,value,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run('secret-row', 'Fixture secret', 'SYNTHETIC_SETTING_FIXTURE', legacy.encryptString('\uFEFFsynthetic-secret-雪-🔑'), 'fixture-created', 'fixture-updated')
        source.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
          .run('fixture_api_key', originalSetting)
        source.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
          .run('ordinary_setting', '21x-credential:unsupported:ordinary UI metadata')
        source.prepare('INSERT INTO oauth_tokens(id,provider,access_token,refresh_token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run('oauth-row', 'fixture-provider', legacy.encryptString('synthetic-access'), legacy.encryptString('synthetic-refresh'), 'fixture-expiry', 'fixture-created', 'fixture-updated')
        source.prepare('INSERT INTO connector_instances(id,piece_name,piece_version,display_name,auth,auth_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run('connector-row', 'fixture-piece', '1.0.0', 'Fixture connector', legacy.encryptString(JSON.stringify({ type: 'basic', username: 'fixture-user', password: 'synthetic-password' })), 'basic', 123, 456)
        source.prepare('INSERT INTO agents(id,name,config,created_at,updated_at) VALUES(?,?,?,?,?)').run('agent-json', 'Preserved agent', originalAgentConfig, 'fixture-created', 'fixture-updated')
        source.prepare('INSERT INTO mcp_servers(id,name,type,command,args,headers,environment,oauth_metadata,tools,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run('mcp-json', 'Preserved MCP', 'local', 'fixture-command', '["--retained"]', originalHeaders, originalEnvironment, originalOAuthMetadata, '[{"name":"fixture-tool","description":"Retained tool"}]', 'fixture-created', 'fixture-updated')
        source.prepare('INSERT INTO task_sources(id,name,mcp_server_id,list_tool,plugin_id,config,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run('source-json', 'Preserved source', 'mcp-json', 'retained-list-tool', 'hubspot', originalSourceConfig, DEFAULT_PROJECT_ID, 'fixture-created', 'fixture-updated')
        source.prepare('INSERT INTO tasks(id,title,description,source_id,agent_id,session_id,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run('task-json', 'Retained task', 'Retained history', 'source-json', 'agent-json', 'retained-backend-session', DEFAULT_PROJECT_ID, 'fixture-created', 'fixture-updated')
        source.prepare('INSERT INTO project_resources(id,project_id,label,url,notes,created_at) VALUES(?,?,?,?,?,?)')
          .run('resource-json', DEFAULT_PROJECT_ID, 'Retained resource', 'https://example.test/reference', 'Retained notes', 'fixture-created')
      })()
    } finally { source.close() }
    sourceLock.assertHeld()
    const result = rehearseProfileCredentialImport({
      lock: sourceLock,
      providers: { legacy, destination: { storage: destination, formatId: destination.formatId, persistentProtection: 'os-protected' } },
      recordInterpretations,
      blobInterpretations: [
        { location: { table: 'secrets', rowId: 'secret-row', column: 'value' }, interpretation: 'safeStorage' },
        { location: { table: 'oauth_tokens', rowId: 'oauth-row', column: 'access_token' }, interpretation: 'safeStorage' },
        { location: { table: 'oauth_tokens', rowId: 'oauth-row', column: 'refresh_token' }, interpretation: 'safeStorage' },
        { location: { table: 'connector_instances', rowId: 'connector-row', column: 'auth' }, interpretation: 'safeStorage' }
      ]
    })
    const retainedCandidate = readFileSync(result.candidatePath)
    // Startup mutates only a rehearsal-owned copy; candidate and original stay intact.
    readerLock.assertHeld()
    const reopenedPath = join(readerLock.profileRoot, '21x.db')
    copyFileSync(result.candidatePath, reopenedPath)
    chmodSync(reopenedPath, 0o600)
    manager.initialize()
    const prefix = `21x-credential:${AUTHENTICATED_SECRET_FORMAT}:`
    const storedSetting = () => manager.db.prepare("SELECT value FROM settings WHERE key='fixture_api_key'").pluck().get() as string
    const ciphertextBeforeRead = storedSetting()
    expect(ciphertextBeforeRead.startsWith(prefix)).toBe(true)
    expect(manager.encryptPlaintextApiKeys()).toBe(0)
    expect(manager.getSetting('fixture_api_key')).toBe('\uFEFFsynthetic-setting-雪-🔑')
    expect(manager.getAllSettings().fixture_api_key).toBe('\uFEFFsynthetic-setting-雪-🔑')
    expect(manager.getSetting('ordinary_setting')).toBe('21x-credential:unsupported:ordinary UI metadata')
    expect(storedSetting()).toBe(ciphertextBeforeRead)
    expect(manager.getSecretsWithValues(['secret-row'])[0].value).toBe('\uFEFFsynthetic-secret-雪-🔑')
    expect(manager.getOAuthToken('oauth-row')).toMatchObject({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })
    expect(new ConnectorCredentialStore(new ConnectorStore(manager)).get('connector-row'))
      .toEqual({ type: 'basic', username: 'fixture-user', password: 'synthetic-password' })
    expect(manager.getAgent('agent-json')?.config.api_keys).toEqual({ openai: 'fixture-agent-openai', anthropic: 'fixture-agent-anthropic', cursor: 'fixture-agent-cursor' })
    expect(manager.getAgent('agent-json')?.config.model).toBe('gpt-4o')
    expect(manager.getMcpServer('mcp-json')).toMatchObject({ id: 'mcp-json', command: 'fixture-command', args: ['--retained'], headers: { Authorization: 'Bearer fixture-header', 'X-Version': 'fixture-version' }, environment: { TOKEN: 'fixture-env', EMPTY: '' }, oauth_metadata: { client_secret: 'fixture-mcp-client-secret', client_id: 'fixture-client' } })
    expect(manager.getTaskSource('source-json')).toMatchObject({ id: 'source-json', mcp_server_id: 'mcp-json', list_tool: 'retained-list-tool', config: { client_secret: 'fixture-source-client', access_token: 'fixture-source-access', api_token: 'fixture-source-api', historical_filters: { number: 100 } } })
    expect(manager.getTask('task-json')).toMatchObject({ id: 'task-json', source_id: 'source-json', agent_id: 'agent-json', session_id: 'retained-backend-session', project_id: DEFAULT_PROJECT_ID })
    expect(manager.db.prepare('SELECT id,label,notes FROM project_resources WHERE id=?').get('resource-json')).toEqual({ id: 'resource-json', label: 'Retained resource', notes: 'Retained notes' })
    const storedAgent = () => manager.db.prepare('SELECT config FROM agents WHERE id=?').pluck().get('agent-json') as string
    const beforeAgent = storedAgent()
    expect(beforeAgent).not.toContain('fixture-agent-openai'); expect(beforeAgent).toContain('"number":1e2')
    manager.updateAgent('agent-json', { config: { ...manager.getAgent('agent-json')!.config, model: 'updated-model' } })
    expect(JSON.parse(storedAgent()).api_keys).toEqual(JSON.parse(beforeAgent).api_keys)
    manager.setSetting('fixture_api_key', 'synthetic-replacement')
    expect(storedSetting().startsWith(prefix)).toBe(true)
    expect(storedSetting()).not.toContain('synthetic-replacement')
    manager.close()
    readerLock.assertHeld()
    manager.initialize()
    expect(manager.getSetting('fixture_api_key')).toBe('synthetic-replacement')
    expect(manager.getAgent('agent-json')?.config.api_keys?.openai).toBe('fixture-agent-openai')
    expect(manager.getMcpServer('mcp-json')?.environment.TOKEN).toBe('fixture-env')
    expect(manager.getTaskSource('source-json')?.config.api_token).toBe('fixture-source-api')
    manager.db.prepare("UPDATE agents SET config=json_set(config,'$.api_keys.openai',?) WHERE id='agent-json'").run('21x-record-credential:v1:21x-credential:21x.aes256gcm.v1:Y2lwaGVy')
    expect(() => manager.getAgent('agent-json')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    manager.db.prepare("UPDATE settings SET value=? WHERE key='fixture_api_key'").run('21x-credential:21x.aes256gcm.v2:Y2lwaGVy')
    expect(() => manager.getSetting('fixture_api_key')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(() => manager.getAllSettings()).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(() => manager.encryptPlaintextApiKeys()).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(readFileSync(result.candidatePath)).toEqual(retainedCandidate)
    // The source legacy wrapper is never rewritten by this startup/read proof.
    const original = new Database(join(sourceRoot, '21x.db'), { readonly: true })
    try {
      expect(original.prepare("SELECT value FROM settings WHERE key='fixture_api_key'").pluck().get())
        .toBe(originalSetting)
      expect(original.prepare("SELECT config FROM agents WHERE id='agent-json'").pluck().get()).toBe(originalAgentConfig)
      expect(original.prepare("SELECT headers FROM mcp_servers WHERE id='mcp-json'").pluck().get()).toBe(originalHeaders)
      expect(original.prepare("SELECT config FROM task_sources WHERE id='source-json'").pluck().get()).toBe(originalSourceConfig)
    } finally { original.close() }
  } finally {
    manager.close()
    legacy.dispose()
    destination.dispose()
    sourceLock.release()
    readerLock.release()
    rmSync(sourceRoot, { recursive: true, force: true })
    rmSync(readerRoot, { recursive: true, force: true })
  }
}, 60000)

import { AUTHENTICATED_SECRET_STORAGE_FORMAT } from './secret-storage'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatedSecretStorage } from './authenticated-secret-storage'
import { prepareCredentialMigration, type RecordCredentialLocation } from './credential-migration'
import { applyRecordCredentialChanges, collectRecordCredentialInputs, normalizedRecordCredentialText, recordCredentialProvenanceHash, type RecordCredentialProvenance } from './record-credential-conversion'

let db: Database.Database, legacy: AuthenticatedSecretStorage, destination: AuthenticatedSecretStorage
const location = (table: RecordCredentialLocation['table'], column: RecordCredentialLocation['column'], jsonPath: string[]): RecordCredentialLocation => ({ table, column, rowId: table, jsonPath }) as unknown as RecordCredentialLocation
const paths = [
  location('agents', 'config', ['api_keys', 'openai']), location('agents', 'config', ['api_keys', 'anthropic']), location('agents', 'config', ['api_keys', 'retired_vendor']),
  location('mcp_servers', 'headers', ['Authorization']), location('mcp_servers', 'headers', ['X-Public']),
  location('mcp_servers', 'environment', ['TOKEN']), location('mcp_servers', 'environment', ['PATH']), location('mcp_servers', 'oauth_metadata', ['client_secret']),
  ...['client_secret', 'access_token', 'api_token'].map(key => location('task_sources', 'config', [key]))
]
const proofs = (): RecordCredentialProvenance[] => paths.map(location => ({ location, interpretation: 'plaintext-utf8' }))
const original = {
  config: ' { "api_keys" : { "openai" : "agent-a", "anthropic":"agent-b", "cursor":"", "retired_vendor":"agent-old" }, "model":"fixture-model", "nested":{"number":1e2}, "api_key_note":"metadata" } ',
  headers: '{"Authorization":"Bearer mcp-a","X-Public":"version-v1","Empty":""}',
  environment: '{"TOKEN":"mcp-env","PATH":"fixture-bin"}',
  oauth_metadata: '{"client_secret":"mcp-secret","client_id":"fixture-client","server_metadata":{"issuer":"https://example.test","number":1e2}}',
  source_config: '{"client_secret":"source-client","access_token":"source-access","api_token":"source-api","repo":"fixture/repo","legacy":{"filter":true}}'
}
function read(table: string, column: string): string { return db.prepare(`SELECT ${column} FROM ${table}`).pluck().get() as string }
function plan(provenance = proofs()) {
  return prepareCredentialMigration(collectRecordCredentialInputs(db, provenance), { legacy, destination: { storage: destination, formatId: destination.formatId, persistentProtection: 'os-protected' } })
}
beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE agents(id TEXT PRIMARY KEY,config TEXT); CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,headers TEXT,environment TEXT,oauth_metadata TEXT); CREATE TABLE task_sources(id TEXT PRIMARY KEY,config TEXT)')
  db.prepare('INSERT INTO agents VALUES(?,?)').run('agents', original.config)
  db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?)').run('mcp_servers', original.headers, original.environment, original.oauth_metadata)
  db.prepare('INSERT INTO task_sources VALUES(?,?)').run('task_sources', original.source_config)
  legacy = new AuthenticatedSecretStorage(Buffer.alloc(32, 71), 'record-source-fixture')
  destination = new AuthenticatedSecretStorage(Buffer.alloc(32, 72), 'record-destination-fixture')
})
afterEach(() => { db.close(); legacy.dispose(); destination.dispose(); vi.restoreAllMocks() })
describe('trusted record credential conversion', () => {
  it('covers every adapter-protected JSON field without changing other JSON bytes or clear values', () => {
    const prepared = plan()
    expect(prepared.changes).toHaveLength(paths.length)
    expect(JSON.stringify(prepared)).not.toMatch(/agent-a|agent-b|source-api|Bearer mcp-a|mcp-env/)
    db.transaction(() => applyRecordCredentialChanges(db, prepared.changes, prepared.destinationFormat))()
    for (const [table, column, before] of [['agents', 'config', original.config], ['mcp_servers', 'headers', original.headers], ['mcp_servers', 'environment', original.environment],
      ['mcp_servers', 'oauth_metadata', original.oauth_metadata], ['task_sources', 'config', original.source_config]]) {
      const excluded = paths.filter(path => path.table === table && path.column === column)
      expect(normalizedRecordCredentialText(read(table, column), excluded)).toBe(normalizedRecordCredentialText(before, excluded))
    }
    const agent = JSON.parse(read('agents', 'config'))
    expect(agent.api_keys.cursor).toBe(''); expect(agent.model).toBe('fixture-model'); expect(agent.nested.number).toBe(100)
    expect(read('agents', 'config')).toContain('"number":1e2')
    const prefix = `21x-record-credential:v1:21x-credential:${destination.formatId}:`
    expect(destination.decryptString(Buffer.from(agent.api_keys.openai.slice(prefix.length), 'base64'))).toBe('agent-a')
    expect(Object.isFrozen(prepared.changes[0].location)).toBe(true)
    expect(Object.isFrozen((prepared.changes[0].location as RecordCredentialLocation).jsonPath)).toBe(true)
    expect(JSON.parse(read('mcp_servers', 'headers')).Empty).toBe('')
  })

  it('requires complete, unique and exact app-issued provenance, never recognizing protection from a prefix', () => {
    for (const provenance of [[], proofs().slice(1), [...proofs(), proofs()[0]], [...proofs(), { location: location('task_sources', 'config', ['unknown_secret']), interpretation: 'plaintext-utf8' }]]) {
      expect(() => collectRecordCredentialInputs(db, provenance as RecordCredentialProvenance[])).toThrow('RECORD_COVERAGE_INCOMPLETE')
    }
    const config = JSON.parse(original.config)
    config.api_keys.openai = `21x-record-credential:v1:21x-credential:${legacy.formatId}:` + legacy.encryptString('original-plaintext').toString('base64')
    db.prepare('UPDATE agents SET config=?').run(JSON.stringify(config))
    expect(() => plan()).toThrow('INVALID_SOURCE_FORMAT')
    const provenance = proofs().map<RecordCredentialProvenance>(proof => proof.location.table === 'agents' && proof.location.jsonPath.at(-1) === 'openai'
      ? { ...proof, interpretation: 'authenticated-record' as const, formatId: AUTHENTICATED_SECRET_STORAGE_FORMAT } : proof)
    const prepared = plan(provenance)
    expect(destination.decryptString(Buffer.from(prepared.changes.find(change => 'jsonPath' in change.location && change.location.jsonPath.at(-1) === 'openai')!.ciphertextBase64, 'base64'))).toBe('original-plaintext')
    expect(recordCredentialProvenanceHash(provenance)).not.toBe(recordCredentialProvenanceHash(proofs()))
    expect(recordCredentialProvenanceHash([...proofs()].reverse())).toBe(recordCredentialProvenanceHash(proofs()))
  })

  it.each(['duplicate', 'escaped-duplicate', 'nonstring', 'null-map', 'array-map', 'malformed'] as const)('refuses %s JSON rather than dropping or guessing credentials', kind => {
    const values = {
      duplicate: '{"api_keys":{"openai":"one","openai":"two"}}',
      'escaped-duplicate': '{"api_keys":{"openai":"one","open\\u0061i":"two"}}',
      nonstring: '{"api_keys":{"openai":42}}', 'null-map': '{"api_keys":null}', 'array-map': '{"api_keys":[]}', malformed: '{"api_keys":'
    }
    db.prepare('UPDATE agents SET config=?').run(values[kind])
    expect(() => collectRecordCredentialInputs(db, proofs())).toThrow('RECORD_INVALID_JSON')
    expect(read('agents', 'config')).toBe(values[kind])
  })

  it('checks stored sizes before JSON materialization and enforces leaf/count bounds', () => {
    db.prepare('UPDATE agents SET config=?').run(JSON.stringify({ api_keys: { openai: 'x'.repeat(1_048_577) } }))
    const parse = vi.spyOn(JSON, 'parse')
    expect(() => collectRecordCredentialInputs(db, proofs())).toThrow('RECORD_BOUNDS_EXCEEDED')
    expect(parse).not.toHaveBeenCalled()
    db.prepare('UPDATE agents SET config=?').run(original.config)
    expect(() => collectRecordCredentialInputs(db, [{ location: location('agents', 'config', ['api_keys', 'x'.repeat(257)]), interpretation: 'plaintext-utf8' }])).toThrow('RECORD_COVERAGE_INCOMPLETE')
  })

  it('preserves prototype-named dictionary fields safely and keeps escaped token/whitespace representation', () => {
    db.prepare('UPDATE agents SET config=?').run(' { "api_keys" : { "__proto__" : "fixture-proto", "open\\u0061i" : "line\\n雪" }, "other" : {"__proto__":"metadata"} } ')
    db.exec('DELETE FROM mcp_servers; DELETE FROM task_sources')
    const locations = [location('agents', 'config', ['api_keys', '__proto__']), location('agents', 'config', ['api_keys', 'openai'])]
    const before = read('agents', 'config'), prepared = plan(locations.map(location => ({ location, interpretation: 'plaintext-utf8' })))
    applyRecordCredentialChanges(db, prepared.changes, prepared.destinationFormat)
    expect(normalizedRecordCredentialText(read('agents', 'config'), locations)).toBe(normalizedRecordCredentialText(before, locations))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('handles absent historical record classes/metadata columns without creating or canonicalizing them', () => {
    db.exec('DROP TABLE agents; DROP TABLE task_sources; DROP TABLE mcp_servers; CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,headers TEXT,environment TEXT)')
    db.prepare('INSERT INTO mcp_servers VALUES(?,?,?)').run('mcp_servers', ' {"Authorization":"old-header"} ', '{}')
    const prepared = plan([{ location: location('mcp_servers', 'headers', ['Authorization']), interpretation: 'plaintext-utf8' }])
    applyRecordCredentialChanges(db, prepared.changes, prepared.destinationFormat)
    expect(prepared.changes).toHaveLength(1)
    expect((db.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>).map(row => row.name)).toEqual(['id', 'headers', 'environment'])
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='agents'").get()).toBeUndefined()
    expect(read('mcp_servers', 'headers')).toMatch(/^ \{"Authorization":.*\} $/)
  })

  it('rejects trigger credential swaps and rolls back every record column transactionally', () => {
    const prepared = plan()
    db.exec("CREATE TRIGGER swap_credential AFTER UPDATE OF config ON task_sources BEGIN UPDATE agents SET config=json_set(config,'$.api_keys.openai','trigger-private') WHERE id='agents'; END")
    expect(() => db.transaction(() => applyRecordCredentialChanges(db, prepared.changes, prepared.destinationFormat))()).toThrow('RECORD_PRESERVATION_FAILED')
    expect(read('agents', 'config')).toBe(original.config); expect(read('task_sources', 'config')).toBe(original.source_config)
    expect(read('mcp_servers', 'headers')).toBe(original.headers)
  })
})

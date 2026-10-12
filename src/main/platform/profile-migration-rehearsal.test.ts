import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { applySchema } from '../database/schema'
import { AuthenticatedSecretStorage } from './authenticated-secret-storage'
import { acquireProfileLock, type ProfileLock } from './profile-lock'
import { createProfileMigrationFixture, rehearseProfileCredentialImport, rehearseProfileCredentialRollback, type RehearsalBoundary, type RehearsalOptions } from './profile-migration-rehearsal'

const require = createRequire(import.meta.url)
const fixtures: { root: string; lock: ProfileLock; legacy: AuthenticatedSecretStorage; destination: AuthenticatedSecretStorage; sourceKey: Buffer; destinationKey: Buffer; options: RehearsalOptions }[] = []
function fixture() {
  const root = createProfileMigrationFixture()
  const lock = acquireProfileLock(root)
  const sourceKey = randomBytes(32)
  const destinationKey = randomBytes(32)
  // These real AES providers are synthetic unit keys, not an OS-store attestation.
  // The separate four-target T03 reports prove actual Electron/native OS stores.
  const legacy = new AuthenticatedSecretStorage(sourceKey, 'synthetic-legacy')
  const destination = new AuthenticatedSecretStorage(destinationKey, 'synthetic-destination')
  const db = new Database(join(root, '21x.db'))
  db.pragma('foreign_keys=ON')
  applySchema(db) // Actual current production schema, indexes, FTS and migration metadata.
  db.prepare('INSERT INTO secrets(id,name,env_var_name,value,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('secret-row', 'Fixture secret', 'FIXTURE', legacy.encryptString('\uFEFFsynthetic-雪-🔑'), 'fixture-created', 'fixture-updated')
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('fixture_api_key', 'safeStorage:v1:' + legacy.encryptString('synthetic-setting').toString('base64'))
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('ordinary_setting', 'unchanged metadata')
  db.prepare('INSERT INTO oauth_tokens(id,provider,source_id,access_token,refresh_token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('oauth-row', 'fixture-provider', null, legacy.encryptString('synthetic-access'), legacy.encryptString('synthetic-refresh'), 'fixture-expiry', 'fixture-created', 'fixture-updated')
  db.prepare('INSERT INTO connector_instances(id,piece_name,piece_version,display_name,auth,auth_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('connector-row', 'fixture-piece', '1.0.0', 'Fixture connector', legacy.encryptString(JSON.stringify({ type: 'basic', username: 'fixture-user', password: 'synthetic-password' })), 'basic', 123, 456)
  db.close()
  mkdirSync(join(root, 'attachments'))
  writeFileSync(join(root, 'attachments/evidence.bin'), Buffer.from('ordinary fixture resource'))
  const options: RehearsalOptions = {
    lock, providers: { legacy, destination: { storage: destination, formatId: '21x.aes256gcm.v1', persistentProtection: 'os-protected' } },
    blobInterpretations: [
      { location: { table: 'secrets', rowId: 'secret-row', column: 'value' }, interpretation: 'safeStorage' },
      { location: { table: 'oauth_tokens', rowId: 'oauth-row', column: 'access_token' }, interpretation: 'safeStorage' },
      { location: { table: 'oauth_tokens', rowId: 'oauth-row', column: 'refresh_token' }, interpretation: 'safeStorage' },
      { location: { table: 'connector_instances', rowId: 'connector-row', column: 'auth' }, interpretation: 'safeStorage' }
    ], resourcePaths: ['attachments/evidence.bin']
  }
  const value = { root, lock, legacy, destination, sourceKey, destinationKey, options }
  fixtures.push(value)
  return value
}
function query(path: string, sql: string) {
  const db = new Database(path, { readonly: true })
  try { return db.prepare(sql).all() } finally { db.close() }
}
const originalRows = (root: string) => query(join(root, '21x.db'), 'SELECT id,name,env_var_name,value,created_at,updated_at FROM secrets')

afterEach(() => {
  for (const value of fixtures.splice(0)) {
    value.legacy.dispose(); value.destination.dispose()
    value.sourceKey.fill(0); value.destinationKey.fill(0)
    value.lock.release()
    // Read-only original capsules are retained by production code. Tests own cleanup.
    rmSync(value.root, { recursive: true, force: true })
  }
})

describe('bounded actual SQLite import rehearsal', () => {
  it('commits a real encrypted candidate while retaining original rows, schema and byte-identical resources', () => {
    const value = fixture()
    const originals = originalRows(value.root)
    const resource = readFileSync(join(value.root, 'attachments/evidence.bin'))
    const first = rehearseProfileCredentialImport(value.options)
    expect(first.state).toBe('committed')
    expect(first.credentialChanges).toBe(5)
    expect(originalRows(value.root)).toEqual(originals)
    expect(readFileSync(join(value.root, 'attachments/evidence.bin'))).toEqual(resource)
    const candidate = new Database(first.candidatePath, { readonly: true })
    try {
      expect(candidate.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(candidate.pragma('foreign_key_check')).toEqual([])
      const secret = candidate.prepare('SELECT id,name,value,created_at,updated_at FROM secrets').get() as { id: string; name: string; value: Buffer; created_at: string; updated_at: string }
      expect(secret.id).toBe('secret-row')
      expect(secret.created_at).toBe('fixture-created')
      expect(secret.updated_at).toBe('fixture-updated')
      expect(value.destination.decryptString(secret.value)).toBe('\uFEFFsynthetic-雪-🔑')
      const setting = candidate.prepare("SELECT value FROM settings WHERE key='fixture_api_key'").pluck().get() as string
      const prefix = '21x-credential:21x.aes256gcm.v1:'
      expect(setting.startsWith(prefix)).toBe(true)
      expect(value.destination.decryptString(Buffer.from(setting.slice(prefix.length), 'base64'))).toBe('synthetic-setting')
      expect(candidate.prepare("SELECT value FROM settings WHERE key='ordinary_setting'").pluck().get()).toBe('unchanged metadata')
    } finally { candidate.close() }
    const backup = readFileSync(first.encryptedOriginalPath)
    expect(backup.includes(Buffer.from('SQLite format 3'))).toBe(false)
    expect(backup.includes(Buffer.from('synthetic-setting'))).toBe(false)
    const originalInode = statSync(first.encryptedOriginalPath).ino
    const repeated = rehearseProfileCredentialImport(value.options)
    expect(repeated.recovered).toBe(true)
    expect(readFileSync(repeated.encryptedOriginalPath)).toEqual(backup)
    expect(statSync(repeated.encryptedOriginalPath).ino).toBe(originalInode)
    const rollback = rehearseProfileCredentialRollback(value.options)
    expect(query(rollback, 'SELECT id,name,env_var_name,value,created_at,updated_at FROM secrets')).toEqual(originals)
    expect(rehearseProfileCredentialRollback(value.options)).toBe(rollback)
  })

  it.each<RehearsalBoundary>(['backup-published', 'journal-prepared', 'candidate-written', 'journal-ready', 'candidate-published', 'journal-committed'])('recovers idempotently from interruption after %s', (interruptAfter) => {
    const value = fixture()
    const before = originalRows(value.root)
    expect(() => rehearseProfileCredentialImport({ ...value.options, interruptAfter })).toThrow('REHEARSAL_INTERRUPTED')
    const backupPath = join(value.root, 'credential-import-rehearsal/original.sqlite.enc')
    const backup = readFileSync(backupPath)
    const result = rehearseProfileCredentialImport(value.options)
    expect(result.state).toBe('committed')
    expect(readFileSync(backupPath)).toEqual(backup)
    expect(originalRows(value.root)).toEqual(before)
    expect(query(result.candidatePath, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('snapshots stopped WAL consistently and includes every committed row', () => {
    const value = fixture()
    const source = new Database(join(value.root, '21x.db'))
    source.pragma('journal_mode=WAL')
    source.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('wal_only_setting', 'committed WAL metadata')
    // Closing the stopped producer is required; this harness is not a live copy.
    source.close()
    const result = rehearseProfileCredentialImport(value.options)
    expect(query(result.candidatePath, "SELECT value FROM settings WHERE key='wal_only_setting'")).toEqual([{ value: 'committed WAL metadata' }])
  })

  it('authenticates chunk identities and rejects reordering of a multi-chunk original snapshot', () => {
    const value = fixture()
    const source = new Database(join(value.root, '21x.db'))
    source.exec('CREATE TABLE fixture_bulk(id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)')
    source.prepare('INSERT INTO fixture_bulk(id,bytes) VALUES(1,zeroblob(700000))').run()
    source.close()
    const result = rehearseProfileCredentialImport(value.options)
    expect(query(result.candidatePath, 'SELECT length(bytes) AS bytes FROM fixture_bulk')).toEqual([{ bytes: 700000 }])
    const capsule = JSON.parse(readFileSync(result.encryptedOriginalPath, 'utf8')) as { chunks: string[] }
    expect(capsule.chunks.length).toBeGreaterThan(1)
    capsule.chunks.reverse()
    const fs = require('node:fs') as typeof import('node:fs')
    fs.chmodSync(result.encryptedOriginalPath, 0o600)
    writeFileSync(result.encryptedOriginalPath, JSON.stringify(capsule))
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_SNAPSHOT_CORRUPT')
  })

  it('fails closed if normalization would change hidden row identities', () => {
    const value = fixture()
    const source = new Database(join(value.root, '21x.db'))
    source.exec('CREATE TABLE fixture_rowids(value TEXT NOT NULL); INSERT INTO fixture_rowids(rowid,value) VALUES(100,\'preserve identity\')')
    source.close()
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_PRESERVATION_FAILED')
    expect(existsSync(join(value.root, 'credential-import-rehearsal/candidate.sqlite'))).toBe(false)
    expect(query(join(value.root, '21x.db'), 'SELECT rowid,value FROM fixture_rowids')).toEqual([{ rowid: 100, value: 'preserve identity' }])
  })

  it('rejects a credential trigger that changes an unrelated AUTOINCREMENT sequence', () => {
    const value = fixture()
    const source = new Database(join(value.root, '21x.db'))
    source.exec("CREATE TABLE fixture_sequence(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT); INSERT INTO fixture_sequence(value) VALUES('ordinary'); CREATE TRIGGER fixture_sequence_mutation BEFORE UPDATE OF value ON secrets BEGIN UPDATE sqlite_sequence SET seq=999 WHERE name='fixture_sequence'; END")
    source.close()
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_PRESERVATION_FAILED')
    expect(query(join(value.root, '21x.db'), "SELECT seq FROM sqlite_sequence WHERE name='fixture_sequence'")).toEqual([{ seq: 1 }])
  })

  it('rejects an active SQLite transaction even with the fixture profile sentinel held', () => {
    const value = fixture()
    const busy = new Database(join(value.root, '21x.db'))
    try {
      busy.exec('BEGIN IMMEDIATE')
      expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_SOURCE_BUSY')
      expect(existsSync(join(value.root, 'credential-import-rehearsal/original.sqlite.enc'))).toBe(false)
    } finally { busy.close() }
  })

  it('fails closed on missing provenance, changed resources and unsupported credential-bearing config', () => {
    const missing = fixture()
    expect(() => rehearseProfileCredentialImport({ ...missing.options, blobInterpretations: [] })).toThrow('REHEARSAL_COVERAGE_INCOMPLETE')
    expect(existsSync(join(missing.root, 'credential-import-rehearsal/original.sqlite.enc'))).toBe(false)
    const value = fixture()
    rehearseProfileCredentialImport(value.options)
    writeFileSync(join(value.root, 'attachments/evidence.bin'), 'changed fixture bytes')
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_RESOURCE_CHANGED')
    const unsupported = fixture()
    const source = new Database(join(unsupported.root, '21x.db'))
    source.prepare('INSERT INTO agents(id,name,config,created_at,updated_at) VALUES(?,?,?,?,?)').run('agent-config', 'Fixture agent', JSON.stringify({ api_keys: { openai: 'synthetic-unsupported' } }), 'created', 'updated')
    source.close()
    expect(() => rehearseProfileCredentialImport(unsupported.options)).toThrow('REHEARSAL_COVERAGE_INCOMPLETE')
  })

  it('rejects bounded overflow and an unheld guard before opening or backing up the source', () => {
    const value = fixture()
    expect(() => rehearseProfileCredentialImport({ ...value.options, maxBytes: 4096 })).toThrow('REHEARSAL_BOUNDS_EXCEEDED')
    value.lock.release()
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_LOCK_INVALID')
  })

  it('fails closed on an unavailable provider or corrupt source without publishing partial conversions', () => {
    const unavailable = fixture()
    unavailable.destination.dispose()
    expect(() => rehearseProfileCredentialImport(unavailable.options)).toThrow('REHEARSAL_PROVIDER_UNAVAILABLE')
    expect(existsSync(join(unavailable.root, 'credential-import-rehearsal/original.sqlite.enc'))).toBe(false)
    const corrupt = fixture()
    const source = new Database(join(corrupt.root, '21x.db'))
    const bytes = source.prepare('SELECT value FROM secrets').pluck().get() as Buffer
    bytes[0] ^= 0xff
    source.prepare('UPDATE secrets SET value=?').run(bytes)
    source.close()
    const before = originalRows(corrupt.root)
    expect(() => rehearseProfileCredentialImport(corrupt.options)).toThrow('REHEARSAL_SOURCE_INVALID')
    expect(originalRows(corrupt.root)).toEqual(before)
    expect(existsSync(join(corrupt.root, 'credential-import-rehearsal/candidate.sqlite'))).toBe(false)
  })

  it('rejects an invalid fixture marker without treating a held sentinel as live-profile authorization', () => {
    const value = fixture()
    writeFileSync(join(value.root, '.21x-migration-rehearsal.json'), JSON.stringify({ version: 1, scope: 'live-profile', fixtureId: 'a'.repeat(32) }))
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow('REHEARSAL_SCOPE_INVALID')
    expect(existsSync(join(value.root, 'credential-import-rehearsal/original.sqlite.enc'))).toBe(false)
  })

  it.each(['.21x-profile-lock.sqlite', '21x.db', 'credential-import-rehearsal\\journal.enc'])('rejects SQLite ownership/output resource %s before opening another descriptor', (path) => {
    const value = fixture()
    expect(() => rehearseProfileCredentialImport({ ...value.options, resourcePaths: [path] })).toThrow('REHEARSAL_SCOPE_INVALID')
    value.lock.assertHeld()
    expect(existsSync(join(value.root, 'credential-import-rehearsal/original.sqlite.enc'))).toBe(false)
  })

  it('converts explicit legacy plaintext safely but refuses plaintext-original rollback files', () => {
    const value = fixture()
    const source = new Database(join(value.root, '21x.db'))
    source.prepare("UPDATE settings SET value=? WHERE key='fixture_api_key'").run('synthetic-fallback-setting')
    source.close()
    const result = rehearseProfileCredentialImport(value.options)
    expect(readFileSync(result.encryptedOriginalPath).includes(Buffer.from('synthetic-fallback-setting'))).toBe(false)
    expect(readFileSync(result.candidatePath).includes(Buffer.from('synthetic-fallback-setting'))).toBe(false)
    expect(() => rehearseProfileCredentialRollback(value.options)).toThrow('REHEARSAL_ROLLBACK_PLAINTEXT')
    expect(existsSync(join(value.root, 'credential-import-rehearsal/rollback-original.sqlite'))).toBe(false)
  })

  it.each(['original.sqlite.enc', 'journal.enc', 'candidate.sqlite'])('rejects corrupt persisted %s without overwriting the original capsule', (file) => {
    const value = fixture()
    const result = rehearseProfileCredentialImport(value.options)
    const backup = readFileSync(result.encryptedOriginalPath)
    const path = join(value.root, 'credential-import-rehearsal', file)
    if (file === 'original.sqlite.enc') {
      // Corrupting the test-owned capsule is outside the production immutable API.
      const fs = require('node:fs') as typeof import('node:fs')
      fs.chmodSync(path, 0o600)
    }
    writeFileSync(path, 'corrupt fixture artifact')
    expect(() => rehearseProfileCredentialImport(value.options)).toThrow()
    if (file !== 'original.sqlite.enc') expect(readFileSync(result.encryptedOriginalPath)).toEqual(backup)
  })

  it('recovers after a real owner crash immediately after journal-ready rename', async () => {
    const value = fixture()
    value.lock.release()
    const driver = join(value.root, 'fixture-driver.cjs')
    // Public code only. Provider keys are handed privately over child stdin.
    writeFileSync(driver, `
      const fs = require('node:fs');
      const ts = require(process.argv[2]);
      require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop:true } }).outputText, filename);
      const root = process.argv[3];
      const sourceModule = process.argv[4];
      const { createInterface } = require('node:readline');
      createInterface({ input:process.stdin }).once('line',line => {
        const control=JSON.parse(line);
        const { acquireProfileLock }=require(sourceModule.replace('profile-migration-rehearsal.ts','profile-lock.ts'));
        const { AuthenticatedSecretStorage }=require(sourceModule.replace('profile-migration-rehearsal.ts','authenticated-secret-storage.ts'));
        const rename=fs.renameSync; let journals=0;
        fs.renameSync=(from,to)=>{rename(from,to);if(to.endsWith('journal.enc')&&++journals===2){fs.writeSync(1,'CRASH_BOUNDARY\\n');process.kill(process.pid,'SIGKILL')}};
        const legacy=new AuthenticatedSecretStorage(Buffer.from(control.sourceKey,'base64'),'synthetic-legacy');
        const destination=new AuthenticatedSecretStorage(Buffer.from(control.destinationKey,'base64'),'synthetic-destination');
        require(sourceModule).rehearseProfileCredentialImport({lock:acquireProfileLock(root),providers:{legacy,destination:{storage:destination,formatId:'21x.aes256gcm.v1',persistentProtection:'os-protected'}},blobInterpretations:control.blobInterpretations,resourcePaths:control.resourcePaths});
        process.exit(2);
      });
    `)
    const child = spawn(process.execPath, [driver, require.resolve('typescript'), value.root, fileURLToPath(new URL('./profile-migration-rehearsal.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] })
    let receipt = ''
    child.stdout.on('data', (bytes) => { if (receipt.length < 128) receipt += bytes.toString() })
    const terminated = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture child deadline')) }, 5000)
      child.on('error', () => { clearTimeout(deadline); reject(new Error('fixture child unavailable')) })
      child.on('close', () => { clearTimeout(deadline); resolve() })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ sourceKey: value.sourceKey.toString('base64'), destinationKey: value.destinationKey.toString('base64'), blobInterpretations: value.options.blobInterpretations, resourcePaths: value.options.resourcePaths }) + '\n')
    await terminated
    expect(receipt).toBe('CRASH_BOUNDARY\n')
    value.lock = acquireProfileLock(value.root)
    value.options = { ...value.options, lock: value.lock }
    const result = rehearseProfileCredentialImport(value.options)
    expect(result.recovered).toBe(true)
    expect(query(result.candidatePath, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
  }, 10000)
})

import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applySchema } from '../database/schema'
import { AuthenticatedSecretStorage, AUTHENTICATED_SECRET_FORMAT } from './authenticated-secret-storage'
import { acquireProfileLock } from './profile-lock'
import { createProfileMigrationFixture, rehearseProfileCredentialImport } from './profile-migration-rehearsal'

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
      })()
    } finally { source.close() }
    sourceLock.assertHeld()
    const result = rehearseProfileCredentialImport({
      lock: sourceLock,
      providers: { legacy, destination: { storage: destination, formatId: destination.formatId, persistentProtection: 'os-protected' } },
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
    manager.setSetting('fixture_api_key', 'synthetic-replacement')
    expect(storedSetting().startsWith(prefix)).toBe(true)
    expect(storedSetting()).not.toContain('synthetic-replacement')
    manager.close()
    readerLock.assertHeld()
    manager.initialize()
    expect(manager.getSetting('fixture_api_key')).toBe('synthetic-replacement')
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
})

import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { decryptRecordCredential, decryptSettingValue } from '../main/database/serializers'
import { acquireProfileLock } from '../main/platform/profile-lock'
import { DROPPED_CREDENTIALS_SETTING, MANAGED_TASK_MCP_MARKER, createSafeStorageDecoder, importElectronProfile } from './electron-profile-import'

const PASSWORD = Buffer.from('fixture-libsecret-password')
/** Chromium os_crypt v11 (Linux) ciphertext, as Electron safeStorage writes it. */
function osCrypt(value: string, password = PASSWORD): Buffer {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v11'), cipher.update(value, 'utf8'), cipher.final()])
}

const roots: string[] = []
let storage: AuthenticatedSecretStorage | undefined
let previous: SecretStorage | undefined
afterEach(() => {
  if (storage) { releaseSecretStorage(storage); storage.dispose(); storage = undefined }
  if (previous) { configureSecretStorage(previous); previous = undefined }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), '21x-electron-import-')); roots.push(root)
  const electron = join(root, 'electron'), profile = join(root, 'profile')
  mkdirSync(electron); mkdirSync(profile)
  const db = new SQLite(join(electron, '21x.db'))
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE secrets (id TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY, access_token BLOB NOT NULL, refresh_token BLOB);
    CREATE TABLE agents (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', environment TEXT NOT NULL DEFAULT '{}', oauth_metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE agent_provider_recovery (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, next_retry_at INTEGER, record TEXT NOT NULL);
    CREATE TABLE delivery_outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL, last_error TEXT);
    CREATE TABLE agent_start_queue (id TEXT PRIMARY KEY, state TEXT NOT NULL, last_error TEXT);`)
  db.prepare('INSERT INTO agent_provider_recovery VALUES (?, ?, NULL, ?)').run('captain', 'accepted', JSON.stringify({ taskId: 'captain', state: 'accepted', prompt: 'old instruction' }))
  db.prepare('INSERT INTO delivery_outbox VALUES (?, ?, NULL), (?, ?, NULL)').run('d1', 'pending', 'd2', 'acknowledged')
  db.prepare('INSERT INTO agent_start_queue VALUES (?, ?, NULL), (?, ?, NULL)').run('q1', 'queued', 'q2', 'started')
  db.pragma('journal_mode = WAL')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('openai_api_key', 'safeStorage:v1:' + osCrypt('sk-openai').toString('base64'))
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('anthropic_api_key', 'plain-anthropic')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('theme', 'dark')
  db.prepare('INSERT INTO secrets VALUES (?, ?)').run('s1', osCrypt('db-password'))
  db.prepare('INSERT INTO secrets VALUES (?, ?)').run('s2', Buffer.from('plaintext-secret'))
  db.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?)').run('o1', osCrypt('access'), null)
  db.prepare('INSERT INTO agents VALUES (?, ?)').run('a1', JSON.stringify({ coding_agent: 'codex', api_keys: { openai: 'agent-key', anthropic: '' } }))
  db.prepare('INSERT INTO mcp_servers (id, name, environment) VALUES (?, ?, ?)').run('managed', 'task-management', JSON.stringify({ TOKEN: 'mcp-token' }))
  db.prepare('INSERT INTO tasks VALUES (?, ?)').run('t1', 'Imported task')
  db.close()
  storage = new AuthenticatedSecretStorage(randomBytes(32), 'fixture-profile')
  try { previous = getSecretStorage(); releaseSecretStorage(previous) } catch { previous = undefined }
  configureSecretStorage(storage)
  return { electron, profile, destination: join(profile, '21x.db'), storage }
}

describe('Electron profile import', () => {
  it('copies the data and re-encrypts every credential class under the new profile key', async () => {
    const f = fixture()
    const before = readFileSync(join(f.electron, '21x.db'))
    await expect(importElectronProfile({ profileRoot: f.electron, destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => Buffer.from(PASSWORD), platform: 'linux' })).resolves.toBe(true)
    expect(readFileSync(join(f.electron, '21x.db'))).toEqual(before)
    const db = new SQLite(f.destination, { readonly: true })
    try {
      const setting = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value
      expect(decryptSettingValue(setting('openai_api_key'))).toBe('sk-openai')
      expect(decryptSettingValue(setting('anthropic_api_key'))).toBe('plain-anthropic')
      expect(setting('theme')).toBe('dark')
      const secret = (id: string) => f.storage.decryptString((db.prepare('SELECT value FROM secrets WHERE id = ?').get(id) as { value: Buffer }).value)
      expect(secret('s1')).toBe('db-password')
      expect(secret('s2')).toBe('plaintext-secret')
      expect(f.storage.decryptString((db.prepare('SELECT access_token FROM oauth_tokens').get() as { access_token: Buffer }).access_token)).toBe('access')
      const config = JSON.parse((db.prepare('SELECT config FROM agents').get() as { config: string }).config)
      expect(decryptRecordCredential(config.api_keys.openai)).toBe('agent-key')
      expect(config.api_keys.anthropic).toBe('')
      const env = JSON.parse((db.prepare('SELECT environment FROM mcp_servers').get() as { environment: string }).environment)
      expect(decryptRecordCredential(env.TOKEN)).toBe('mcp-token')
      expect(decryptSettingValue(setting(MANAGED_TASK_MCP_MARKER))).toBe('managed')
      expect(db.prepare('SELECT title FROM tasks').pluck().get()).toBe('Imported task')
      // Interrupted work is settled, never resumed by itself on first launch.
      const recovery = db.prepare('SELECT state, record FROM agent_provider_recovery').get() as { state: string; record: string }
      expect(recovery.state).toBe('cancelled'); expect(JSON.parse(recovery.record).state).toBe('cancelled')
      expect(db.prepare('SELECT id, state FROM delivery_outbox ORDER BY id').all()).toEqual([{ id: 'd1', state: 'cancelled' }, { id: 'd2', state: 'acknowledged' }])
      expect(db.prepare('SELECT id, state FROM agent_start_queue ORDER BY id').all()).toEqual([{ id: 'q1', state: 'cancelled' }, { id: 'q2', state: 'started' }])
    } finally { db.close() }
  })

  it('clears a credential it cannot read instead of failing the whole import', async () => {
    const f = fixture()
    await importElectronProfile({ profileRoot: f.electron, destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null, platform: 'linux' })
    const db = new SQLite(f.destination, { readonly: true })
    try {
      expect((db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get() as { value: string }).value).toBe('')
      expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(DROPPED_CREDENTIALS_SETTING) as { value: string }).value).toBe('3')
      expect(db.prepare('SELECT title FROM tasks').pluck().get()).toBe('Imported task')
    } finally { db.close() }
  })

  it('waits for the Electron app to close and leaves nothing behind', async () => {
    const f = fixture()
    const lock = acquireProfileLock(f.electron)
    try {
      await expect(importElectronProfile({ profileRoot: f.electron, destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null }))
        .rejects.toMatchObject({ code: 'ELECTRON_PROFILE_IN_USE' })
    } finally { lock.release() }
    expect(existsSync(f.destination)).toBe(false)
  })

  it('reports nothing to import without an Electron database', async () => {
    const f = fixture()
    rmSync(join(f.electron, '21x.db'))
    await expect(importElectronProfile({ profileRoot: f.electron, destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null })).resolves.toBe(false)
  })

  it('decodes macOS v10 with the Keychain password and Linux v10 with the fixed one', () => {
    const encrypt = (key: Buffer, value: string) => {
      const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      return Buffer.concat([Buffer.from('v10'), cipher.update(value), cipher.final()])
    }
    expect(createSafeStorageDecoder(PASSWORD, 'darwin')(encrypt(pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1'), 'mac'))).toBe('mac')
    expect(createSafeStorageDecoder(null, 'linux')(encrypt(pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'), 'linux'))).toBe('linux')
    expect(createSafeStorageDecoder(null, 'linux')(Buffer.from('plain'))).toBeNull()
  })
})

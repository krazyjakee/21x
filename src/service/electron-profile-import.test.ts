import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatedSecretStorage } from '../main/platform/authenticated-secret-storage'
import { configureSecretStorage, getSecretStorage, releaseSecretStorage, type SecretStorage } from '../main/platform/secret-storage'
import { decryptRecordCredential, decryptSettingValue } from '../main/database/serializers'
import { acquireProfileLock, HOST_CLAIM_TIMEOUT_MS, PROFILE_LOCK_FILE, TAURI_SHARED_WORKSPACES_FILE, tauriSharesWorkspaces, type ProfileLock } from '../main/platform/profile-lock'
import { holdProfileElsewhere, profileFreeElsewhere, profileListing, stopOtherHosts } from '../../test/helpers/profile-holder'
import { DROPPED_CREDENTIALS_SETTING, ELECTRON_SHARED_ROOT_SETTING, MANAGED_TASK_MCP_MARKER, createSafeStorageDecoder, ensureTauriSharedMarker, holdElectronProfile, importElectronProfile, readLegacyMarker, writeLegacyMarker } from './electron-profile-import'

vi.mock('../main/platform/profile-lock', async importOriginal => {
  const actual = await importOriginal<typeof import('../main/platform/profile-lock')>()
  return { ...actual, acquireProfileLock: vi.fn(actual.acquireProfileLock) }
})

const PASSWORD = Buffer.from('fixture-libsecret-password')
/** Chromium os_crypt v11 (Linux) ciphertext, as Electron safeStorage writes it. */
function osCrypt(value: string, password = PASSWORD): Buffer {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v11'), cipher.update(value, 'utf8'), cipher.final()])
}

const roots: string[] = []
let storage: AuthenticatedSecretStorage | undefined
let previous: SecretStorage | undefined
const holds: ProfileLock[] = []
const hold = (root: string) => { const lock = holdElectronProfile(root); holds.push(lock); return lock }
afterEach(async () => {
  await stopOtherHosts()
  for (const lock of holds.splice(0)) lock.release()
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

describe('the marker a shared profile leaves for Electron', () => {
  const folder = (): string => { const root = mkdtempSync(join(tmpdir(), '21x-shared-marker-')); roots.push(root); return root }
  const markerIn = (root: string): string => join(root, TAURI_SHARED_WORKSPACES_FILE)
  const staged = (root: string): string => `${markerIn(root)}.writing`

  it('is a private regular file with no path, secret or task in it', () => {
    const root = folder()
    ensureTauriSharedMarker(hold(root))
    const info = lstatSync(markerIn(root))
    expect(info.isFile()).toBe(true); expect(info.mode & 0o777).toBe(0o600); expect(info.size).toBeLessThan(512)
    expect(readFileSync(markerIn(root), 'utf8')).not.toContain(root)
    expect(readFileSync(markerIn(root), 'utf8')).not.toContain('/')
    expect(tauriSharesWorkspaces(root)).toBe(true)
    expect(existsSync(staged(root))).toBe(false)
  })
  it('leaves one already there exactly as it found it', () => {
    const root = folder(); writeFileSync(markerIn(root), 'an older note')
    const before = lstatSync(markerIn(root), { bigint: true })
    ensureTauriSharedMarker(hold(root))
    const after = lstatSync(markerIn(root), { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
    expect(readFileSync(markerIn(root), 'utf8')).toBe('an older note')
  })
  it('follows no link at either name', () => {
    const root = folder(), outside = join(folder(), 'outside')
    symlinkSync(outside, staged(root))
    ensureTauriSharedMarker(hold(root))
    expect(existsSync(outside)).toBe(false); expect(lstatSync(markerIn(root)).isFile()).toBe(true)
    const linked = folder()
    symlinkSync(outside, markerIn(linked))
    ensureTauriSharedMarker(hold(linked))
    expect(existsSync(outside)).toBe(false); expect(readlinkSync(markerIn(linked))).toBe(outside)
  })
  it('writes nothing without the lock', () => {
    const root = folder()
    expect(() => ensureTauriSharedMarker({ profileRoot: root, assertHeld() { throw new Error('PROFILE_LOCK_LOST') } })).toThrow('PROFILE_LOCK_LOST')
    expect(readdirSync(root)).toEqual([])
  })
  it('fails and leaves nothing when the folder cannot be written', () => {
    if (process.getuid?.() === 0) return
    const root = folder(), lock = hold(root), before = profileListing(root)
    chmodSync(root, 0o500)
    try {
      expect(() => ensureTauriSharedMarker(lock)).toThrow()
      expect(profileListing(root)).toEqual(before)
    } finally { chmodSync(root, 0o700) }
  })
  it('fails when something it cannot clear is in the way of the write', () => {
    const root = folder(), lock = hold(root)
    mkdirSync(staged(root))
    expect(() => ensureTauriSharedMarker(lock)).toThrow()
    expect(existsSync(markerIn(root))).toBe(false)
  })
})

describe('Electron profile import', () => {
  it('copies the data and re-encrypts every credential class under the new profile key', async () => {
    const f = fixture()
    const before = readFileSync(join(f.electron, '21x.db'))
    await expect(importElectronProfile({ profileRoot: f.electron, lock: hold(f.electron), destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => Buffer.from(PASSWORD), platform: 'linux' })).resolves.toBe(true)
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
    await importElectronProfile({ profileRoot: f.electron, lock: hold(f.electron), destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null, platform: 'linux' })
    const db = new SQLite(f.destination, { readonly: true })
    try {
      expect((db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get() as { value: string }).value).toBe('')
      expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(DROPPED_CREDENTIALS_SETTING) as { value: string }).value).toBe('3')
      expect(db.prepare('SELECT title FROM tasks').pluck().get()).toBe('Imported task')
    } finally { db.close() }
  })

  it('records the share inside the copy, so a published database always carries it', async () => {
    const f = fixture()
    await importElectronProfile({ profileRoot: f.electron, lock: hold(f.electron), destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null, platform: 'linux' })
    const db = new SQLite(f.destination, { readonly: true })
    try {
      expect((db.prepare('SELECT value FROM settings WHERE key = ?').get(ELECTRON_SHARED_ROOT_SETTING) as { value: string }).value).toBe(f.electron)
    } finally { db.close() }
  })

  it('replaces a directory at the marker path, so a restore cannot fail forever', () => {
    const f = fixture(), profile = join(f.electron, '..', 'profile')
    mkdirSync(join(profile, '.legacy-profile-root', 'in-the-way'), { recursive: true })
    expect(readLegacyMarker(profile)).toBeNull()
    writeLegacyMarker(profile, '/electron/root')
    expect(readLegacyMarker(profile)).toBe('/electron/root')
  })

  it('reads the marker back as written, replaces a planted link, and reads a missing one as nothing', () => {
    const f = fixture(), profile = join(f.electron, '..', 'profile'), target = join(f.electron, 'target')
    expect(readLegacyMarker(profile)).toBeNull()
    writeFileSync(target, 'untouched')
    symlinkSync(target, join(profile, '.legacy-profile-root'))
    expect(readLegacyMarker(profile)).toBeNull()
    writeLegacyMarker(profile, '/electron/root')
    expect(readLegacyMarker(profile)).toBe('/electron/root')
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('waits the shared claim time for the Electron profile, and announces itself', () => {
    const f = fixture()
    vi.mocked(acquireProfileLock).mockClear()
    hold(f.electron)
    expect(HOST_CLAIM_TIMEOUT_MS).toBeGreaterThan(0)
    expect(acquireProfileLock).toHaveBeenCalledWith(f.electron, { timeoutMs: HOST_CLAIM_TIMEOUT_MS, tauriHolder: true })
  })

  it('refuses while the Electron app runs, writes nothing, and works once it quits', async () => {
    const f = fixture()
    const electron = await holdProfileElsewhere(f.electron)
    const before = profileListing(f.electron)
    expect(() => hold(f.electron)).toThrow('ELECTRON_PROFILE_IN_USE')
    expect(profileListing(f.electron)).toEqual(before)
    expect(existsSync(f.destination)).toBe(false)
    await electron.quit()
    hold(f.electron).assertHeld()
  })

  it('keeps the Electron app out after the import, until the session releases', async () => {
    const f = fixture()
    const lock = hold(f.electron)
    await importElectronProfile({ profileRoot: f.electron, lock, destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null, platform: 'linux' })
    expect(await profileFreeElsewhere(f.electron)).toBe(false)
    lock.release()
    expect(await profileFreeElsewhere(f.electron)).toBe(true)
  })

  it('does not blame the Electron app when another Tauri session holds the profile', async () => {
    const f = fixture()
    await holdProfileElsewhere(f.electron, { tauri: true })
    expect(() => hold(f.electron)).toThrow(/^PROFILE_IN_USE$/)
  })

  it('stops the launch on a lock it cannot trust, without blaming the Electron app', () => {
    const f = fixture()
    const target = join(f.profile, 'elsewhere'); writeFileSync(target, 'untouched')
    symlinkSync(target, join(f.electron, PROFILE_LOCK_FILE))
    expect(() => hold(f.electron)).toThrow('PROFILE_LOCK_INVALID')
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('never imports without the hold', async () => {
    const f = fixture()
    const lock = { assertHeld() { throw new Error('PROFILE_LOCK_LOST') } }
    await expect(importElectronProfile({ profileRoot: f.electron, lock, destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null })).rejects.toThrow('PROFILE_LOCK_LOST')
    expect(existsSync(f.destination)).toBe(false)
  })

  it('reports nothing to import without an Electron database', async () => {
    const f = fixture()
    rmSync(join(f.electron, '21x.db'))
    await expect(importElectronProfile({ profileRoot: f.electron, lock: hold(f.electron), destination: f.destination, storage: f.storage, loadSafeStoragePassword: async () => null })).resolves.toBe(false)
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

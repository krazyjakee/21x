import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeStorage } from 'electron'
import type Database from 'better-sqlite3'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { decryptSettingValue, encryptSettingValue, isEncryptedSettingValue } from './database/serializers'

/**
 * The shared test setup mocks `safeStorage.isEncryptionAvailable` as false, so
 * every other test runs the plaintext fallback. These tests stand in a fake OS
 * keychain that really transforms the bytes (a keyed XOR behind a marker), so
 * the encrypted path runs end to end: what hits the database must not be the
 * plaintext, and what comes back out must be.
 */

const MARKER = Buffer.from('fake-keychain:')
const KEY = 0x5a

function fakeEncrypt(value: string): Buffer {
  const plain = Buffer.from(value, 'utf8')
  const out = Buffer.alloc(MARKER.length + plain.length)
  MARKER.copy(out)
  for (let i = 0; i < plain.length; i++) out[MARKER.length + i] = plain[i] ^ KEY
  return out
}

function fakeDecrypt(value: Buffer): string {
  if (value.length < MARKER.length || !value.subarray(0, MARKER.length).equals(MARKER)) {
    throw new Error('Decryption failed: not encrypted by this keychain')
  }
  const out = Buffer.alloc(value.length - MARKER.length)
  for (let i = 0; i < out.length; i++) out[i] = value[MARKER.length + i] ^ KEY
  return out.toString('utf8')
}

function useFakeKeychain(available = true): void {
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(available)
  vi.mocked(safeStorage.encryptString).mockImplementation(fakeEncrypt)
  vi.mocked(safeStorage.decryptString).mockImplementation(fakeDecrypt)
}

function expectCiphertext(stored: Buffer, plaintext: string): void {
  expect(Buffer.isBuffer(stored)).toBe(true)
  expect(stored.subarray(0, MARKER.length).equals(MARKER)).toBe(true)
  expect(stored.toString('utf8')).not.toContain(plaintext)
  expect(stored.toString('latin1')).not.toContain(plaintext)
}

describe('safeStorage encrypted path', () => {
  let db: DatabaseManager
  let rawDb: InstanceType<typeof Database>

  beforeEach(() => {
    useFakeKeychain()
    ;({ db, rawDb } = createTestDb())
  })

  afterEach(() => {
    // Back to the shared setup's defaults (keychain unavailable, identity transform).
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    vi.mocked(safeStorage.encryptString).mockImplementation((value: string) => Buffer.from(value, 'utf8'))
    vi.mocked(safeStorage.decryptString).mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  describe('secrets', () => {
    it('stores the value as ciphertext and decrypts it for the main process only', () => {
      const secret = db.createSecret({ name: 'API', description: '', env_var_name: 'API_KEY', value: 'sk-plain-123' })!

      const row = rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }
      expectCiphertext(row.value, 'sk-plain-123')
      expect(safeStorage.encryptString).toHaveBeenCalledWith('sk-plain-123')

      expect(db.getSecretsWithValues([secret.id])[0].value).toBe('sk-plain-123')
      // Renderer-facing records never carry the value at all.
      expect(db.getSecret(secret.id)).not.toHaveProperty('value')
      expect(db.getSecrets()[0]).not.toHaveProperty('value')
    })

    it('re-encrypts a rotated value', () => {
      const secret = db.createSecret({ name: 'API', description: '', env_var_name: 'API_KEY', value: 'sk-old' })!
      const before = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }).value

      db.updateSecret(secret.id, { value: 'sk-new' })

      const after = (rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }).value
      expect(after.equals(before)).toBe(false)
      expectCiphertext(after, 'sk-new')
      expectCiphertext(after, 'sk-old')
      expect(db.getSecretsWithValues([secret.id])[0].value).toBe('sk-new')
    })

    it('falls back to plaintext bytes when no keychain is available', () => {
      useFakeKeychain(false)
      const secret = db.createSecret({ name: 'API', description: '', env_var_name: 'API_KEY', value: 'sk-plain' })!

      const row = rawDb.prepare('SELECT value FROM secrets WHERE id = ?').get(secret.id) as { value: Buffer }
      expect(row.value.toString('utf8')).toBe('sk-plain')
      expect(db.getSecretsWithValues([secret.id])[0].value).toBe('sk-plain')
    })
  })

  describe('OAuth tokens', () => {
    let sourceId: string

    beforeEach(() => {
      sourceId = db.createTaskSource({ name: 'HubSpot', plugin_id: 'hubspot', mcp_server_id: null })!.id
    })

    it('encrypts access and refresh tokens at rest and decrypts them on read', () => {
      const token = db.createOAuthToken({
        provider: 'hubspot',
        source_id: sourceId,
        access_token: 'access-abc',
        refresh_token: 'refresh-xyz',
        expires_in: 3600,
        scope: 'tickets'
      })!

      const row = rawDb.prepare('SELECT access_token, refresh_token FROM oauth_tokens WHERE id = ?').get(token.id) as {
        access_token: Buffer; refresh_token: Buffer
      }
      expectCiphertext(row.access_token, 'access-abc')
      expectCiphertext(row.refresh_token, 'refresh-xyz')

      expect(token).toMatchObject({ access_token: 'access-abc', refresh_token: 'refresh-xyz', scope: 'tickets' })
      expect(db.getOAuthTokenBySource(sourceId)).toMatchObject({ access_token: 'access-abc', refresh_token: 'refresh-xyz' })
    })

    it('re-encrypts refreshed tokens and keeps a missing refresh token null', () => {
      const token = db.createOAuthToken({
        provider: 'hubspot',
        source_id: sourceId,
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: null
      })!

      db.updateOAuthToken(token.id, 'access-2', null, 60)

      const row = rawDb.prepare('SELECT access_token, refresh_token FROM oauth_tokens WHERE id = ?').get(token.id) as {
        access_token: Buffer; refresh_token: Buffer | null
      }
      expectCiphertext(row.access_token, 'access-2')
      expectCiphertext(row.access_token, 'access-1')
      expect(row.refresh_token).toBeNull()
      expect(db.getOAuthToken(token.id)).toMatchObject({ access_token: 'access-2', refresh_token: null })
    })
  })

  describe('API key settings', () => {
    it('stores *_api_key settings as marked ciphertext and reads them back as plaintext', () => {
      db.setSetting('anthropic_api_key', 'sk-ant-secret')
      db.setSetting('theme', 'dark')

      const stored = (rawDb.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get() as { value: string }).value
      expect(isEncryptedSettingValue(stored)).toBe(true)
      expect(stored).not.toContain('sk-ant-secret')
      expect(Buffer.from(stored.slice('safeStorage:v1:'.length), 'base64').toString('latin1')).not.toContain('sk-ant-secret')

      expect(db.getSetting('anthropic_api_key')).toBe('sk-ant-secret')
      expect(db.getAllSettings()).toMatchObject({ anthropic_api_key: 'sk-ant-secret', theme: 'dark' })
      // Non-key settings are stored as-is.
      expect(rawDb.prepare("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: 'dark' })
    })

    it('does not encrypt an empty key, so clearing a key clears it', () => {
      db.setSetting('openai_api_key', 'sk-openai')
      db.setSetting('openai_api_key', '')
      expect(rawDb.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get()).toEqual({ value: '' })
      expect(db.getSetting('openai_api_key')).toBe('')
    })

    it('encrypts keys that older versions saved in plaintext, exactly once', () => {
      // Rows written before encryption existed, or while the keychain was unavailable.
      rawDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('openai_api_key', 'sk-legacy')
      rawDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark')
      db.setSetting('anthropic_api_key', 'sk-already-encrypted')

      expect(db.encryptPlaintextApiKeys()).toBe(1)

      const legacy = (rawDb.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get() as { value: string }).value
      expect(isEncryptedSettingValue(legacy)).toBe(true)
      expect(legacy).not.toContain('sk-legacy')
      expect(db.getSetting('openai_api_key')).toBe('sk-legacy')
      expect(db.getSetting('anthropic_api_key')).toBe('sk-already-encrypted')
      expect(rawDb.prepare("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: 'dark' })

      expect(db.encryptPlaintextApiKeys()).toBe(0)
    })

    it('leaves plaintext keys alone while the keychain is unavailable', () => {
      useFakeKeychain(false)
      db.setSetting('openai_api_key', 'sk-fallback')
      expect(rawDb.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get()).toEqual({ value: 'sk-fallback' })
      expect(db.encryptPlaintextApiKeys()).toBe(0)
      expect(db.getSetting('openai_api_key')).toBe('sk-fallback')
    })

    it('never returns ciphertext when the key cannot be decrypted', () => {
      db.setSetting('anthropic_api_key', 'sk-ant-secret')

      // Keychain gone (e.g. the OS profile changed): the stored blob is unreadable.
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      expect(db.getSetting('anthropic_api_key')).toBe('')
      expect(db.getAllSettings().anthropic_api_key).toBe('')

      // Keychain back, but the blob was not produced by it.
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
      rawDb.prepare('UPDATE settings SET value = ? WHERE key = ?')
        .run('safeStorage:v1:' + Buffer.from('garbage').toString('base64'), 'anthropic_api_key')
      expect(db.getSetting('anthropic_api_key')).toBe('')
    })
  })

  describe('encryptSettingValue / decryptSettingValue', () => {
    it('round-trips through the keychain', () => {
      const encrypted = encryptSettingValue('sk-round-trip')
      expect(encrypted.startsWith('safeStorage:v1:')).toBe(true)
      expect(encrypted).not.toContain('sk-round-trip')
      expect(decryptSettingValue(encrypted)).toBe('sk-round-trip')
    })

    it('passes plaintext values through unchanged', () => {
      expect(decryptSettingValue('sk-legacy-plain')).toBe('sk-legacy-plain')
      expect(encryptSettingValue('')).toBe('')
      useFakeKeychain(false)
      expect(encryptSettingValue('sk-no-keychain')).toBe('sk-no-keychain')
    })
  })
})

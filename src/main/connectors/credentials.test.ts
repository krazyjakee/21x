import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { safeStorage } from 'electron'
import type Database from 'better-sqlite3'
import { createTestDb } from '../../../test/helpers/db-test-helper'
import { ConnectorStore } from './connector-store'
import {
  CONNECTOR_CREDENTIALS_REMEDIATION,
  ConnectorCredentialStore,
  ConnectorCredentialsUnavailableError,
  redactCredentials,
  type ConnectorCredentials
} from './credentials'

/**
 * The shared setup mocks safeStorage as unavailable with an identity
 * transform. These tests stand in a fake keychain that really transforms the
 * bytes (as in database-encryption.test.ts), so ciphertext in the database is
 * verifiably not the plaintext.
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

function useFakeKeychain(available: boolean): void {
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(available)
  vi.mocked(safeStorage.encryptString).mockImplementation(fakeEncrypt)
  vi.mocked(safeStorage.decryptString).mockImplementation(fakeDecrypt)
}

const SECRET: ConnectorCredentials = { type: 'secret_text', secret: 'sk-live-abcdef123456' }
const BASIC: ConnectorCredentials = { type: 'basic', username: 'alice', password: 'hunter2-very-secret' }
const CUSTOM: ConnectorCredentials = {
  type: 'custom_auth',
  props: { apiKey: 'custom-key-987654', region: 'eu-west-1', nested: { token: 'tok_zzzzzz' } }
}

describe('ConnectorCredentialStore', () => {
  let rawDb: InstanceType<typeof Database>
  let store: ConnectorStore
  let creds: ConnectorCredentialStore
  let instanceId: string

  function storedAuth(id: string): Buffer | null {
    const row = rawDb.prepare('SELECT auth FROM connector_instances WHERE id = ?').get(id) as { auth: Buffer | null } | undefined
    return row?.auth ?? null
  }

  beforeEach(() => {
    ;({ rawDb } = createTestDb())
    store = new ConnectorStore({ db: rawDb })
    creds = new ConnectorCredentialStore(store)
    instanceId = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
  })

  afterEach(() => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    vi.mocked(safeStorage.encryptString).mockImplementation((value: string) => Buffer.from(value, 'utf8'))
    vi.mocked(safeStorage.decryptString).mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  describe('with encryption available', () => {
    beforeEach(() => useFakeKeychain(true))

    it.each([SECRET, BASIC, CUSTOM])('round-trips $type credentials as ciphertext', (value) => {
      creds.set(instanceId, value)

      const stored = storedAuth(instanceId)!
      expect(Buffer.isBuffer(stored)).toBe(true)
      expect(stored.subarray(0, MARKER.length).equals(MARKER)).toBe(true)
      for (const text of [stored.toString('utf8'), stored.toString('latin1')]) {
        expect(text).not.toContain('sk-live')
        expect(text).not.toContain('hunter2')
        expect(text).not.toContain('custom-key')
      }

      expect(creds.get(instanceId)).toEqual(value)
      expect(creds.getStorage(instanceId)).toBe('persistent')
      expect(store.getInstance(instanceId)).toMatchObject({ authType: value.type, hasStoredAuth: true })
      // The renderer-safe record never carries the secret.
      expect(JSON.stringify(store.getInstance(instanceId))).not.toContain('sk-live')
    })

    it('survives a new credential store (i.e. an app restart)', () => {
      creds.set(instanceId, SECRET)
      expect(new ConnectorCredentialStore(store).get(instanceId)).toEqual(SECRET)
    })

    it('returns null, without leaking, when the ciphertext cannot be decrypted', () => {
      rawDb.prepare('UPDATE connector_instances SET auth = ? WHERE id = ?').run(Buffer.from('garbage'), instanceId)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(creds.get(instanceId)).toBeNull()
      warn.mockRestore()
    })

    it('clear() forgets the stored credentials', () => {
      creds.set(instanceId, SECRET)
      creds.clear(instanceId)
      expect(creds.get(instanceId)).toBeNull()
      expect(storedAuth(instanceId)).toBeNull()
      expect(creds.getStorage(instanceId)).toBeNull()
    })

    it('rejects malformed credentials and unknown instances', () => {
      expect(() => creds.set(instanceId, { type: 'secret_text' } as never)).toThrow(/Invalid/)
      expect(() => creds.set('missing', SECRET)).toThrow(/not found/)
    })
  })

  describe('with encryption unavailable', () => {
    beforeEach(() => useFakeKeychain(false))

    it('refuses persistent setup with a typed error and remediation, and stores nothing', () => {
      vi.mocked(safeStorage.encryptString).mockClear()
      expect(creds.isPersistentStorageAvailable()).toBe(false)
      let error: unknown
      try {
        creds.set(instanceId, SECRET)
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(ConnectorCredentialsUnavailableError)
      expect(error).toMatchObject({
        code: 'CONNECTOR_CREDENTIALS_UNAVAILABLE',
        remediation: CONNECTOR_CREDENTIALS_REMEDIATION,
        sessionOnlyAvailable: true
      })
      expect((error as Error).message).not.toContain(SECRET.secret)
      expect(storedAuth(instanceId)).toBeNull()
      expect(safeStorage.encryptString).not.toHaveBeenCalled()
      expect(creds.get(instanceId)).toBeNull()
    })

    it('offers explicit session-only storage that never touches the database', () => {
      creds.set(instanceId, BASIC, 'session')
      expect(creds.get(instanceId)).toEqual(BASIC)
      expect(creds.getStorage(instanceId)).toBe('session')
      expect(storedAuth(instanceId)).toBeNull()
      const dump = JSON.stringify(rawDb.prepare('SELECT * FROM connector_instances').all())
      expect(dump).not.toContain('hunter2')

      // Session credentials do not outlive the process.
      expect(new ConnectorCredentialStore(store).get(instanceId)).toBeNull()
    })

    it('never decrypts persisted ciphertext as plaintext', () => {
      rawDb.prepare('UPDATE connector_instances SET auth = ? WHERE id = ?')
        .run(Buffer.from(JSON.stringify(SECRET), 'utf8'), instanceId)
      expect(creds.get(instanceId)).toBeNull()
    })
  })

  it('switching to session mode drops the persisted copy', () => {
    useFakeKeychain(true)
    creds.set(instanceId, SECRET)
    creds.set(instanceId, BASIC, 'session')
    expect(storedAuth(instanceId)).toBeNull()
    expect(creds.get(instanceId)).toEqual(BASIC)
  })

  it('deleting a connector wipes its stored and session credentials', () => {
    useFakeKeychain(true)
    const other = store.createInstance({ pieceName: 'p', pieceVersion: '1' }).id
    creds.set(instanceId, SECRET)
    creds.set(other, BASIC, 'session')

    store.deleteInstance(instanceId)
    store.deleteInstance(other)

    expect(creds.get(instanceId)).toBeNull()
    expect(creds.get(other)).toBeNull()
    expect(creds.getStorage(other)).toBeNull()
    expect(rawDb.prepare('SELECT COUNT(*) AS n FROM connector_instances').get()).toEqual({ n: 0 })
  })

  it('redact() scrubs the instance credentials from text', () => {
    useFakeKeychain(true)
    creds.set(instanceId, SECRET)
    expect(creds.redact(instanceId, `401 for key ${SECRET.secret}`)).toBe('401 for key [REDACTED]')
  })
})

describe('redactCredentials', () => {
  it('redacts a secret-text value', () => {
    expect(redactCredentials('Authorization: Bearer sk-live-abcdef123456', SECRET)).toBe('Authorization: Bearer [REDACTED]')
  })

  it('redacts a basic password, the user:pass pair and its base64 header form', () => {
    const header = Buffer.from('alice:hunter2-very-secret').toString('base64')
    const out = redactCredentials(`pw=hunter2-very-secret url=https://alice:hunter2-very-secret@x Basic ${header}`, BASIC)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain(header)
    expect(out).toContain('pw=[REDACTED]')
  })

  it('redacts nested custom-auth props and URL-encoded forms', () => {
    const creds: ConnectorCredentials = { type: 'custom_auth', props: { token: 'a b/c+d==secret', nested: { key: 'tok_zzzzzz' } } }
    const out = redactCredentials(`q=${encodeURIComponent('a b/c+d==secret')} raw=a b/c+d==secret k=tok_zzzzzz`, creds)
    expect(out).toBe('q=[REDACTED] raw=[REDACTED] k=[REDACTED]')
  })

  it('leaves text alone when there are no credentials, and ignores very short values', () => {
    expect(redactCredentials('nothing here', null)).toBe('nothing here')
    const short: ConnectorCredentials = { type: 'custom_auth', props: { region: 'eu', port: 1 } }
    expect(redactCredentials('eu port 1', short)).toBe('eu port 1')
  })

  it('accepts several credentials at once', () => {
    expect(redactCredentials('sk-live-abcdef123456 / tok_zzzzzz', [SECRET, CUSTOM])).toBe('[REDACTED] / [REDACTED]')
  })
})

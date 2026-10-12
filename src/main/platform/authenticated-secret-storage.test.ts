import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AuthenticatedSecretStorage, initializeProtectedSecretStorage, ProtectedSecretStorageError } from './authenticated-secret-storage'

describe('standard authenticated secret provider', () => {
  it.each(['', 'synthetic-secret', '\uFEFFsecret-雪-🔑'])('roundtrips exact UTF-8 text using distinct randomized ciphertexts', (value) => {
    const key = randomBytes(32)
    const provider = new AuthenticatedSecretStorage(key, 'fixture-profile')
    key.fill(0) // Constructor owns a defensive copy.
    const first = provider.encryptString(value)
    const second = provider.encryptString(value)
    expect(first.equals(second)).toBe(false)
    expect(provider.decryptString(first)).toBe(value)
    expect(provider.decryptString(second)).toBe(value)
    if (value) expect(first.includes(Buffer.from(value))).toBe(false)
    provider.dispose()
  })

  it.each([0, 12, 24, -1])('rejects tampering at envelope offset %s before exposing plaintext', (offset) => {
    const provider = new AuthenticatedSecretStorage(randomBytes(32), 'fixture')
    const ciphertext = provider.encryptString('SYNTHETIC-SECRET-NOT-IN-ERROR')
    ciphertext[offset === -1 ? ciphertext.length - 1 : offset] ^= 0xff
    expect(() => provider.decryptString(ciphertext)).toThrow('INVALID_SECRET_CIPHERTEXT')
    provider.dispose()
  })

  it('rejects a different key/context, truncated tags, and legacy ciphertext', () => {
    const key = randomBytes(32)
    const original = new AuthenticatedSecretStorage(key, 'original')
    const otherProfile = new AuthenticatedSecretStorage(key, 'other')
    const otherKey = new AuthenticatedSecretStorage(randomBytes(32), 'original')
    const value = original.encryptString('synthetic')
    expect(() => otherProfile.decryptString(value)).toThrow('INVALID_SECRET_CIPHERTEXT')
    expect(() => otherKey.decryptString(value)).toThrow('INVALID_SECRET_CIPHERTEXT')
    expect(() => original.decryptString(value.subarray(0, 20))).toThrow('INVALID_SECRET_CIPHERTEXT')
    expect(() => original.decryptString(Buffer.from('safeStorage:v1:legacy'))).toThrow('INVALID_SECRET_CIPHERTEXT')
    for (const provider of [original, otherProfile, otherKey]) provider.dispose()
    key.fill(0)
  })

  it('rejects wrong key lengths, invalid contexts, oversized values, and lossy surrogates', () => {
    expect(() => new AuthenticatedSecretStorage(randomBytes(31), 'fixture')).toThrow('INVALID_SECRET_KEY')
    expect(() => new AuthenticatedSecretStorage(randomBytes(32), '/profile/path')).toThrow('INVALID_SECRET_KEY')
    const provider = new AuthenticatedSecretStorage(randomBytes(32), 'fixture')
    expect(() => provider.encryptString('x'.repeat(1_048_577))).toThrow('INVALID_SECRET_VALUE')
    expect(() => provider.encryptString('\uD800')).toThrow('INVALID_SECRET_VALUE')
    provider.dispose()
  })

  it('throws after disposal, including availability checks that legacy callers use for fallback', () => {
    const provider = new AuthenticatedSecretStorage(randomBytes(32), 'fixture')
    provider.dispose()
    provider.dispose()
    expect(() => provider.isEncryptionAvailable()).toThrow('SECRET_STORE_UNAVAILABLE')
    expect(() => provider.encryptString('synthetic')).toThrow('SECRET_STORE_UNAVAILABLE')
    expect(() => provider.decryptString(Buffer.alloc(0))).toThrow('SECRET_STORE_UNAVAILABLE')
  })
})

describe('one-time protected-key bootstrap', () => {
  it('creates an independent 32-byte key, reads it back, and clears bootstrap buffers', async () => {
    let retained: Buffer | undefined
    let creationBuffer: Buffer | undefined
    let readBuffer: Buffer | undefined
    const store = {
      create: vi.fn(async (_profile: string, key: Buffer) => { creationBuffer = key; retained = Buffer.from(key) }),
      load: vi.fn(async () => { readBuffer = Buffer.from(retained!); return readBuffer })
    }
    const provider = await initializeProtectedSecretStorage(store, 'fixture', 'create')
    expect(retained).toHaveLength(32)
    expect(creationBuffer).toEqual(Buffer.alloc(32))
    expect(readBuffer).toEqual(Buffer.alloc(32))
    const ciphertext = provider.encryptString('synthetic')
    const reopened = await initializeProtectedSecretStorage(store, 'fixture', 'load')
    expect(reopened.decryptString(ciphertext)).toBe('synthetic')
    expect(store.create).toHaveBeenCalledTimes(1)
    provider.dispose()
    reopened.dispose()
    retained!.fill(0)
  })

  it('never creates or replaces a key after a failed load and redacts bootstrap exceptions', async () => {
    const store = { create: vi.fn(async () => {}), load: vi.fn(async () => { throw new Error('SYNTHETIC-SECRET-MUST-NOT-LEAK') }) }
    await expect(initializeProtectedSecretStorage(store, 'fixture', 'load')).rejects.toMatchObject({ code: 'SECRET_STORE_UNAVAILABLE' })
    expect(store.create).not.toHaveBeenCalled()
    try { await initializeProtectedSecretStorage(store, 'fixture', 'load') } catch (error) {
      expect(error).toBeInstanceOf(ProtectedSecretStorageError)
      expect(String(error)).not.toContain('SYNTHETIC-SECRET-MUST-NOT-LEAK')
      expect(error).not.toHaveProperty('cause')
    }
  })
})

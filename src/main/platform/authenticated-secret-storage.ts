import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { SecretStorage } from './secret-storage'

export const AUTHENTICATED_SECRET_FORMAT = '21x.aes256gcm.v1'
const MAGIC = Buffer.from('21x-secret\x01', 'ascii')
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_PLAINTEXT_BYTES = 1_048_576
const OVERHEAD = MAGIC.length + NONCE_BYTES + TAG_BYTES

export class ProtectedSecretStorageError extends Error {
  constructor(readonly code: 'SECRET_STORE_UNAVAILABLE' | 'INVALID_SECRET_KEY' | 'INVALID_SECRET_VALUE' | 'INVALID_SECRET_CIPHERTEXT') {
    super(code)
    this.name = 'ProtectedSecretStorageError'
  }
}

/**
 * Standard Node/OpenSSL AES-256-GCM. The 32-byte key is loaded from an OS store
 * once at trusted bootstrap; no native RPC occurs during serialization. This
 * format is experimental until the T03/T04 contract review, not legacy safeStorage.
 */
export class AuthenticatedSecretStorage implements SecretStorage {
  #key: Buffer | undefined
  readonly #aad: Buffer

  constructor(key: Buffer, profileId: string) {
    if (!Buffer.isBuffer(key) || key.length !== 32 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profileId)) {
      throw new ProtectedSecretStorageError('INVALID_SECRET_KEY')
    }
    this.#key = Buffer.from(key)
    this.#aad = Buffer.concat([MAGIC, Buffer.from(profileId, 'utf8')])
  }

  /** Throws after disposal so callers cannot interpret it as legacy plaintext permission. */
  isEncryptionAvailable(): boolean {
    if (!this.#key) throw new ProtectedSecretStorageError('SECRET_STORE_UNAVAILABLE')
    return true
  }

  encryptString(value: string): Buffer {
    this.isEncryptionAvailable()
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_PLAINTEXT_BYTES) throw new ProtectedSecretStorageError('INVALID_SECRET_VALUE')
    const plaintext = Buffer.from(value, 'utf8')
    try {
      // Reject lossy encoding of unpaired UTF-16 surrogates.
      if (plaintext.toString('utf8') !== value) throw new ProtectedSecretStorageError('INVALID_SECRET_VALUE')
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', this.#key!, nonce, { authTagLength: TAG_BYTES })
      cipher.setAAD(this.#aad)
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted])
    } catch (error) {
      if (error instanceof ProtectedSecretStorageError) throw error
      throw new ProtectedSecretStorageError('SECRET_STORE_UNAVAILABLE')
    } finally {
      plaintext.fill(0)
    }
  }

  decryptString(value: Buffer): string {
    this.isEncryptionAvailable()
    if (!Buffer.isBuffer(value) || value.length < OVERHEAD || value.length > MAX_PLAINTEXT_BYTES + OVERHEAD || !value.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ProtectedSecretStorageError('INVALID_SECRET_CIPHERTEXT')
    }
    const nonce = value.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES)
    const tag = value.subarray(MAGIC.length + NONCE_BYTES, OVERHEAD)
    let first: Buffer | undefined
    let last: Buffer | undefined
    let plaintext: Buffer | undefined
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key!, nonce, { authTagLength: TAG_BYTES })
      decipher.setAAD(this.#aad)
      decipher.setAuthTag(tag)
      first = decipher.update(value.subarray(OVERHEAD))
      last = decipher.final() // Authentication must succeed before plaintext is exposed.
      plaintext = Buffer.concat([first, last])
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext)
    } catch {
      throw new ProtectedSecretStorageError('INVALID_SECRET_CIPHERTEXT')
    } finally {
      first?.fill(0)
      last?.fill(0)
      plaintext?.fill(0)
    }
  }

  dispose(): void {
    this.#key?.fill(0)
    this.#key = undefined
  }
}

/** Native store interface is asynchronous only during trusted initialization. */
export interface ProtectedApplicationKeyStore {
  load(profileId: string): Promise<Buffer>
  /** Must refuse an existing key; never replace one because a store is locked. */
  create(profileId: string, key: Buffer): Promise<void>
}

export async function initializeProtectedSecretStorage(
  store: ProtectedApplicationKeyStore,
  profileId: string,
  mode: 'load' | 'create'
): Promise<AuthenticatedSecretStorage> {
  // The trusted caller must hold the cross-host profile lock before create:
  // OS generic credential stores do not provide compare-and-create atomics.
  let key: Buffer | undefined
  try {
    if (mode === 'create') {
      const generated = randomBytes(32)
      try { await store.create(profileId, generated) } finally { generated.fill(0) }
    } else if (mode !== 'load') throw new ProtectedSecretStorageError('INVALID_SECRET_KEY')
    key = await store.load(profileId)
    return new AuthenticatedSecretStorage(key, profileId)
  } catch (error) {
    if (error instanceof ProtectedSecretStorageError) throw error
    throw new ProtectedSecretStorageError('SECRET_STORE_UNAVAILABLE')
  } finally {
    if (Buffer.isBuffer(key)) key.fill(0)
  }
}

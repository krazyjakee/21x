/**
 * Synchronous encryption boundary for the service process. The desktop host
 * supplies its provider during trusted bootstrap, before opening the database.
 *
 * Availability is a property of the provider, not a default for a missing
 * provider. Serialization policy (including Electron's legacy fallbacks) stays
 * with the caller. This interface does not establish ciphertext compatibility
 * between hosts or authorize converting a profile.
 *
 * A future native provider must complete any asynchronous initialization before
 * registration; database serialization must not hide synchronous native RPC.
 */
export const ELECTRON_SECRET_STORAGE_FORMAT = 'electron.safeStorage.v1'
export const AUTHENTICATED_SECRET_STORAGE_FORMAT = '21x.aes256gcm.v1'
export type SecretStorageFormatId = typeof ELECTRON_SECRET_STORAGE_FORMAT | typeof AUTHENTICATED_SECRET_STORAGE_FORMAT

export interface SecretStorage {
  /**
   * Identifies ciphertext compatibility, not an OS-store security attestation.
   * Absence is the transitional, three-method Electron legacy contract only;
   * new providers must declare their format and cannot consume another wrapper.
   */
  readonly formatId?: SecretStorageFormatId
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class SecretStorageNotConfiguredError extends Error {
  readonly code = 'SECRET_STORAGE_NOT_CONFIGURED'

  constructor() {
    super('Secret storage must be configured before credential access')
    this.name = 'SecretStorageNotConfiguredError'
  }
}

export class SecretStorageFormatError extends Error {
  readonly code = 'SECRET_STORAGE_FORMAT_INVALID'

  constructor() {
    super('SECRET_STORAGE_FORMAT_INVALID')
    this.name = 'SecretStorageFormatError'
  }
}

let configuredStorage: SecretStorage | undefined

/** Register once per service process. Repeating the same registration is safe. */
export function configureSecretStorage(storage: SecretStorage): void {
  // Validate before assignment, without probing encryption or the OS keychain.
  // A failed bootstrap leaves the registry available for a valid registration.
  try {
    const format = storage.formatId
    if (format !== undefined && format !== ELECTRON_SECRET_STORAGE_FORMAT && format !== AUTHENTICATED_SECRET_STORAGE_FORMAT) {
      throw new SecretStorageFormatError()
    }
  } catch { throw new SecretStorageFormatError() }
  if (configuredStorage && configuredStorage !== storage) {
    throw new Error('Secret storage is already configured')
  }
  configuredStorage = storage
}

/** Missing bootstrap wiring must never silently become plaintext storage. */
export function getSecretStorage(): SecretStorage {
  if (!configuredStorage) throw new SecretStorageNotConfiguredError()
  return configuredStorage
}

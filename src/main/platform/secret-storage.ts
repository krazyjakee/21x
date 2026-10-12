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
export interface SecretStorage {
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

let configuredStorage: SecretStorage | undefined

/** Register once per service process. Repeating the same registration is safe. */
export function configureSecretStorage(storage: SecretStorage): void {
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

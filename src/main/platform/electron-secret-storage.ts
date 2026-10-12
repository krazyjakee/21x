import { safeStorage } from 'electron'
import type { SecretStorage } from './secret-storage'

/**
 * Preserve the shipping Electron implementation and byte formats. Resolve its
 * methods at call time so availability changes (and test mocks) remain visible.
 * Register after Electron is ready; do not probe the keychain at module import.
 */
export const electronSecretStorage: SecretStorage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value)
}

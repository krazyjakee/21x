import { safeStorage } from 'electron'
import { ELECTRON_SECRET_STORAGE_FORMAT, type SecretStorage } from './secret-storage'

/**
 * Preserve the shipping Electron implementation and byte formats. Resolve its
 * methods at call time so availability changes (and test mocks) remain visible.
 * Register after Electron is ready; do not probe the keychain at module import.
 */
export const electronSecretStorage: SecretStorage = {
  formatId: ELECTRON_SECRET_STORAGE_FORMAT,
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value)
}

import { describe, expect, it, vi } from 'vitest'
import { safeStorage } from 'electron'
import { electronSecretStorage } from './electron-secret-storage'

describe('Electron secret storage adapter', () => {
  it('tracks live availability and cipher methods instead of capturing bootstrap values', () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
    expect(electronSecretStorage.isEncryptionAvailable()).toBe(false)

    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
    const ciphertext = Buffer.from('host-ciphertext')
    vi.mocked(safeStorage.encryptString).mockReturnValue(ciphertext)
    vi.mocked(safeStorage.decryptString).mockReturnValue('test-secret')

    expect(electronSecretStorage.isEncryptionAvailable()).toBe(true)
    expect(electronSecretStorage.encryptString('test-secret')).toBe(ciphertext)
    expect(electronSecretStorage.decryptString(ciphertext)).toBe('test-secret')
    expect(safeStorage.encryptString).toHaveBeenCalledWith('test-secret')
    expect(safeStorage.decryptString).toHaveBeenCalledWith(ciphertext)
  })
})

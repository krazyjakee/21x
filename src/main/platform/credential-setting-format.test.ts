import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretStorage } from './secret-storage'
import { AuthenticatedSecretStorage, AUTHENTICATED_SECRET_FORMAT } from './authenticated-secret-storage'

const nativePrefix = `21x-credential:${AUTHENTICATED_SECRET_FORMAT}:`
const providers: AuthenticatedSecretStorage[] = []
beforeEach(() => vi.resetModules())
afterEach(() => { for (const provider of providers.splice(0)) provider.dispose() })

function legacy(available = true): SecretStorage {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`)),
    decryptString: vi.fn((value: Buffer) => {
      if (!value.toString().startsWith('cipher:')) throw new Error('unreadable')
      return value.toString().slice(7)
    })
  }
}
async function configured(storage: SecretStorage) {
  const { configureSecretStorage } = await import('./secret-storage')
  configureSecretStorage(storage)
  return import('../database/serializers')
}
function native() {
  const key = randomBytes(32)
  const provider = new AuthenticatedSecretStorage(key, 'synthetic-setting-format')
  key.fill(0)
  providers.push(provider)
  return provider
}

describe('credential setting format contract', () => {
  it('encrypts authenticated record values and refuses wrong-provider or unknown record envelopes', async () => {
    const provider = native(), codec = await configured(provider)
    const plaintext = ' \uFEFFrecord-secret-雪 '
    const value = codec.encryptRecordCredential(plaintext)
    expect(value.startsWith('21x-record-credential:v1:21x-credential:21x.aes256gcm.v1:')).toBe(true)
    expect(value).not.toContain(plaintext)
    expect(codec.decryptRecordCredential(value)).toBe(plaintext)
    expect(codec.decryptRecordCredential('legacy plaintext')).toBe('legacy plaintext')
    expect(() => codec.decryptRecordCredential('21x-record-credential:v2:any')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(() => codec.decryptRecordCredential('21x-record-credential:v1:plaintext')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    const registry = await import('./secret-storage')
    registry.releaseSecretStorage(provider); registry.configureSecretStorage(legacy())
    expect(codec.encryptRecordCredential(plaintext)).toBe(plaintext)
    expect(() => codec.decryptRecordCredential(value)).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
  })
  it('declares stable formats while preserving old three-method providers and legacy bytes', async () => {
    const provider = legacy()
    const codec = await configured(provider)
    expect((await import('./electron-secret-storage')).electronSecretStorage.formatId).toBe('electron.safeStorage.v1')
    expect(native().formatId).toBe('21x.aes256gcm.v1')
    const stored = codec.encryptSettingValue('synthetic')
    expect(stored).toBe('safeStorage:v1:' + Buffer.from('cipher:synthetic').toString('base64'))
    expect(codec.decryptSettingValue(stored)).toBe('synthetic')
    expect(codec.decryptSettingValue('legacy plaintext')).toBe('legacy plaintext')
    expect(codec.decryptSettingValue('safeStorage:v1:invalid!')).toBe('')
    expect(codec.encryptSettingValue('')).toBe('')
  })

  it('retains the explicitly unavailable Electron plaintext/empty-read fallback', async () => {
    const codec = await configured({ ...legacy(false), formatId: 'electron.safeStorage.v1' })
    expect(codec.encryptSettingValue('synthetic')).toBe('synthetic')
    expect(codec.decryptSettingValue('safeStorage:v1:Y2lwaGVyOnN5bnRoZXRpYw==')).toBe('')
  })

  it('roundtrips authenticated settings, preserves exact BOM/Unicode, and recognizes both wrappers', async () => {
    const provider = native()
    const codec = await configured(provider)
    const value = '\uFEFFsynthetic-雪-🔑'
    const stored = codec.encryptSettingValue(value)
    expect(stored.startsWith(nativePrefix)).toBe(true)
    expect(stored).not.toContain(value)
    expect(codec.decryptSettingValue(stored)).toBe(value)
    expect(codec.isEncryptedSettingValue(stored)).toBe(true)
    expect(codec.isEncryptedSettingValue('safeStorage:v1:Y2lwaGVy')).toBe(true)
    expect(codec.isEncryptedSettingValue('legacy plaintext')).toBe(false)
    expect(codec.decryptSettingValue('legacy plaintext')).toBe('legacy plaintext')
    expect(codec.encryptSettingValue('')).toBe('')
  })

  it.each(['safeStorage:v2:Y2lwaGVy', 'safeStorage:v01:Y2lwaGVy', 'safeStorage:', '21x-credential:', '21x-credential:21x.aes256gcm.v2:Y2lwaGVy'])('rejects reserved unsupported wrapper %s before decrypting or startup conversion', async (value) => {
    const provider = legacy()
    const codec = await configured(provider)
    expect(() => codec.decryptSettingValue(value)).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(() => codec.isEncryptedSettingValue(value)).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(provider.decryptString).not.toHaveBeenCalled()
    expect(provider.encryptString).not.toHaveBeenCalled()
  })

  it.each([false, true])('refuses native wrappers with a legacy provider even when availability is %s', async (available) => {
    const provider = legacy(available)
    const codec = await configured(provider)
    expect(() => codec.decryptSettingValue(nativePrefix + 'Y2lwaGVy')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(provider.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(provider.decryptString).not.toHaveBeenCalled()
  })

  it('refuses legacy ciphertext with an authenticated provider rather than guessing compatibility', async () => {
    const codec = await configured(native())
    expect(() => codec.decryptSettingValue('safeStorage:v1:Y2lwaGVy')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
  })

  it.each(['', 'Y2lwaGVy', 'Y2lwaGVy====', '!!!!', 'Y2lwaGVy\n', 'Zh=='])('rejects malformed or truncated native payload %s', async (encoded) => {
    const codec = await configured(native())
    expect(() => codec.decryptSettingValue(nativePrefix + encoded)).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
  })

  it('rejects an oversized encoded payload before decrypting', async () => {
    const provider = native()
    const decrypt = vi.spyOn(provider, 'decryptString')
    const codec = await configured(provider)
    expect(() => codec.decryptSettingValue(nativePrefix + 'A'.repeat(1_398_204))).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('rejects tampered ciphertext, wrong keys and unavailable providers with fixed errors', async () => {
    const provider = native()
    const other = native()
    const codec = await configured(provider)
    const ciphertext = provider.encryptString('SYNTHETIC-DO-NOT-LOG')
    ciphertext[ciphertext.length - 1] ^= 1
    expect(() => codec.decryptSettingValue(nativePrefix + ciphertext.toString('base64'))).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(() => codec.decryptSettingValue(nativePrefix + other.encryptString('synthetic').toString('base64'))).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    provider.dispose()
    for (const value of ['synthetic', '']) {
      expect(() => codec.encryptSettingValue(value)).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
      expect(() => codec.decryptSettingValue(value)).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    }
  })

  it('does not permit an authenticated provider returning false or throwing to write plaintext', async () => {
    const provider: SecretStorage = { ...legacy(false), formatId: AUTHENTICATED_SECRET_FORMAT }
    const codec = await configured(provider)
    expect(() => codec.encryptSettingValue('synthetic')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
    expect(provider.encryptString).not.toHaveBeenCalled()
    vi.mocked(provider.isEncryptionAvailable).mockImplementation(() => { throw new Error('SYNTHETIC-DO-NOT-LOG') })
    expect(() => codec.encryptSettingValue('synthetic')).toThrow('CREDENTIAL_SETTING_FORMAT_INVALID')
  })

  it.each(['future.v1', null])('rejects undeclared runtime format %s atomically at bootstrap', async (formatId) => {
    const registry = await import('./secret-storage')
    const invalid = { ...legacy(), formatId } as unknown as SecretStorage
    expect(() => registry.configureSecretStorage(invalid)).toThrow(registry.SecretStorageFormatError)
    try { registry.configureSecretStorage(invalid) } catch (error) {
      expect(error).toMatchObject({ code: 'SECRET_STORAGE_FORMAT_INVALID', message: 'SECRET_STORAGE_FORMAT_INVALID' })
      expect(error).not.toHaveProperty('cause')
    }
    expect(() => registry.getSecretStorage()).toThrow(registry.SecretStorageNotConfiguredError)
    expect(invalid.isEncryptionAvailable).not.toHaveBeenCalled()
    const validLegacy = legacy()
    registry.configureSecretStorage(validLegacy)
    expect(registry.getSecretStorage()).toBe(validLegacy)
    expect(() => registry.configureSecretStorage(invalid)).toThrow('SECRET_STORAGE_FORMAT_INVALID')
    expect(registry.getSecretStorage()).toBe(validLegacy)
    const codec = await import('../database/serializers')
    expect(codec.decryptSettingValue(codec.encryptSettingValue('synthetic'))).toBe('synthetic')
  })
})

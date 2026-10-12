import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecretStorage } from './secret-storage'
import type { ConnectorStore } from '../connectors/connector-store'

// Fresh module registries exercise missing bootstrap wiring independently of
// the shared test setup. No production reset/replace API is exposed for tests.
beforeEach(() => vi.resetModules())

function fakeStorage(available = true): SecretStorage {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`, 'utf8')),
    decryptString: vi.fn((value: Buffer) => {
      const text = value.toString('utf8')
      if (!text.startsWith('cipher:')) throw new Error('Unreadable ciphertext')
      return text.slice('cipher:'.length)
    })
  }
}

function connectorStore(auth: Buffer | null = null) {
  const store = {
    onInstanceDeleted: vi.fn(),
    getInstance: vi.fn(() => ({ id: 'instance' })),
    getAuthBlob: vi.fn(() => ({ auth })),
    setAuthBlob: vi.fn()
  }
  return { store, typed: store as unknown as ConnectorStore }
}

describe('host secret storage bootstrap', () => {
  it('requires registration and prevents changing providers in a running process', async () => {
    const registry = await import('./secret-storage')
    expect(() => registry.getSecretStorage()).toThrow(registry.SecretStorageNotConfiguredError)

    const storage = fakeStorage()
    registry.configureSecretStorage(storage)
    expect(registry.getSecretStorage()).toBe(storage)
    expect(() => registry.configureSecretStorage(storage)).not.toThrow()
    expect(() => registry.configureSecretStorage(fakeStorage())).toThrow('already configured')
    expect(registry.getSecretStorage()).toBe(storage)
  })

  it('fails closed before serializing or decrypting any credential without a provider', async () => {
    const { SecretStorageNotConfiguredError } = await import('./secret-storage')
    const serializers = await import('../database/serializers')
    expect(() => serializers.encryptSecret('test-secret')).toThrow(SecretStorageNotConfiguredError)
    expect(() => serializers.encryptSettingValue('test-secret')).toThrow(SecretStorageNotConfiguredError)
    expect(() => serializers.encryptSettingValue('')).toThrow(SecretStorageNotConfiguredError)
    expect(() => serializers.decryptSettingValue('legacy-plaintext')).toThrow(SecretStorageNotConfiguredError)
    expect(() => serializers.decryptSettingValue('safeStorage:v1:Y2lwaGVy')).toThrow(SecretStorageNotConfiguredError)
    expect(() => serializers.deserializeSecretWithValue({ value: Buffer.from('cipher') } as never))
      .toThrow(SecretStorageNotConfiguredError)

    const { ConnectorCredentialStore } = await import('../connectors/credentials')
    const { store, typed } = connectorStore(Buffer.from('cipher'))
    const credentials = new ConnectorCredentialStore(typed)
    expect(() => credentials.isPersistentStorageAvailable()).toThrow(SecretStorageNotConfiguredError)
    expect(() => credentials.set('instance', { type: 'secret_text', secret: 'test-secret' }))
      .toThrow(SecretStorageNotConfiguredError)
    expect(() => credentials.get('instance')).toThrow(SecretStorageNotConfiguredError)
    expect(store.setAuthBlob).not.toHaveBeenCalled()
  })

  it('keeps explicitly selected session credentials available without a provider', async () => {
    const { ConnectorCredentialStore } = await import('../connectors/credentials')
    const { store, typed } = connectorStore()
    const credentials = new ConnectorCredentialStore(typed)
    const value = { type: 'secret_text' as const, secret: 'session-secret' }
    credentials.set('instance', value, 'session')
    expect(credentials.get('instance')).toEqual(value)
    expect(credentials.getStorage('instance')).toBe('session')
    expect(store.setAuthBlob).toHaveBeenCalledWith('instance', 'secret_text', null)
    expect(new ConnectorCredentialStore(typed).get('instance')).toBeNull()
  })
})

describe('injected provider serialization policy', () => {
  it('uses provider ciphertext while preserving the legacy settings envelope', async () => {
    const { configureSecretStorage } = await import('./secret-storage')
    const storage = fakeStorage()
    configureSecretStorage(storage)
    const serializers = await import('../database/serializers')

    const blob = serializers.encryptSecret('blob-secret')
    expect(blob).toEqual(Buffer.from('cipher:blob-secret'))
    expect(serializers.deserializeSecretWithValue({ value: blob } as never).value).toBe('blob-secret')

    const setting = serializers.encryptSettingValue('setting-secret')
    expect(setting).toBe('safeStorage:v1:' + Buffer.from('cipher:setting-secret').toString('base64'))
    expect(serializers.decryptSettingValue(setting)).toBe('setting-secret')
    expect(serializers.decryptSettingValue('legacy-plaintext')).toBe('legacy-plaintext')
    expect(serializers.decryptSettingValue('safeStorage:v1:' + Buffer.from('corrupt').toString('base64'))).toBe('')
    expect(storage.encryptString).toHaveBeenCalledWith('blob-secret')
    expect(storage.decryptString).toHaveBeenCalledWith(blob)
  })

  it('retains Electron fallback policy when the configured provider is unavailable', async () => {
    const { configureSecretStorage } = await import('./secret-storage')
    const storage = fakeStorage(false)
    configureSecretStorage(storage)
    const serializers = await import('../database/serializers')

    expect(serializers.encryptSecret('legacy-secret')).toEqual(Buffer.from('legacy-secret'))
    expect(serializers.deserializeSecretWithValue({ value: Buffer.from('legacy-secret') } as never).value)
      .toBe('legacy-secret')
    expect(serializers.encryptSettingValue('legacy-setting')).toBe('legacy-setting')
    expect(serializers.decryptSettingValue('legacy-setting')).toBe('legacy-setting')
    expect(serializers.decryptSettingValue('safeStorage:v1:Y2lwaGVy')).toBe('')

    const { ConnectorCredentialStore, ConnectorCredentialsUnavailableError } = await import('../connectors/credentials')
    const { store, typed } = connectorStore(Buffer.from('cipher'))
    const credentials = new ConnectorCredentialStore(typed)
    expect(credentials.isPersistentStorageAvailable()).toBe(false)
    expect(() => credentials.set('instance', { type: 'secret_text', secret: 'test-secret' }))
      .toThrow(ConnectorCredentialsUnavailableError)
    expect(credentials.get('instance')).toBeNull()
    expect(store.setAuthBlob).not.toHaveBeenCalled()
    expect(storage.encryptString).not.toHaveBeenCalled()
    expect(storage.decryptString).not.toHaveBeenCalled()
  })

  it('does not change failed encryption into a plaintext write', async () => {
    const { configureSecretStorage } = await import('./secret-storage')
    const storage = fakeStorage()
    vi.mocked(storage.encryptString).mockImplementation(() => { throw new Error('Keychain locked') })
    configureSecretStorage(storage)
    const serializers = await import('../database/serializers')
    expect(() => serializers.encryptSecret('test-secret')).toThrow('Keychain locked')
    expect(() => serializers.encryptSettingValue('test-secret')).toThrow('Keychain locked')

    const { ConnectorCredentialStore } = await import('../connectors/credentials')
    const { store, typed } = connectorStore()
    expect(() => new ConnectorCredentialStore(typed).set('instance', { type: 'secret_text', secret: 'test-secret' }))
      .toThrow('Keychain locked')
    expect(store.setAuthBlob).not.toHaveBeenCalled()
  })
})

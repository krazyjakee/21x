import { describe, expect, it, vi } from 'vitest'
import type { SecretStorage } from './secret-storage'
import {
  CREDENTIAL_MIGRATION_LIMITS,
  CredentialMigrationError,
  prepareCredentialMigration,
  type CredentialMigrationDestination,
  type CredentialMigrationErrorCode,
  type LegacyCredentialInput
} from './credential-migration'

/** Opaque fixture lookup, NOT a cryptographic implementation or OS evidence. */
function fixtureStorage(label: string) {
  const values = new Map<string, string>()
  let issued = 0
  const storage: SecretStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plaintext: string) => {
      const ciphertext = Buffer.from(`${label}-opaque-${++issued}`)
      values.set(ciphertext.toString('base64'), plaintext)
      return ciphertext
    }),
    decryptString: vi.fn((ciphertext: Buffer) => {
      const value = values.get(ciphertext.toString('base64'))
      if (value === undefined) throw new Error('provider error including SECRET-MUST-NOT-LEAK')
      return value
    })
  }
  return { storage, values }
}

function providers() {
  const legacy = fixtureStorage('legacy')
  const target = fixtureStorage('destination')
  const destination: CredentialMigrationDestination = {
    storage: target.storage, formatId: 'fixture-store.v1', persistentProtection: 'os-protected'
  }
  return { legacy, target, injected: { legacy: legacy.storage, destination } }
}

function secret(value: Buffer, rowId = 'secret-1', interpretation: 'safeStorage' | 'plaintext-utf8' | undefined = 'safeStorage'): LegacyCredentialInput {
  return { location: { table: 'secrets', column: 'value', rowId }, source: { kind: 'blob', value, interpretation } }
}

function setting(value: string, rowId = 'provider_api_key'): LegacyCredentialInput {
  return { location: { table: 'settings', column: 'value', rowId }, source: { kind: 'setting', value } }
}

function oauth(value: Buffer, column: 'access_token' | 'refresh_token', interpretation: 'safeStorage' | 'plaintext-utf8' = 'safeStorage'): LegacyCredentialInput {
  return { location: { table: 'oauth_tokens', column, rowId: 'oauth-1' }, source: { kind: 'blob', value, interpretation } }
}

function errorCode(action: () => unknown, code: CredentialMigrationErrorCode): CredentialMigrationError {
  let received: unknown
  try { action() } catch (error) { received = error }
  expect(received).toBeInstanceOf(CredentialMigrationError)
  expect(received).toMatchObject({ code })
  expect(String(received)).not.toContain('SECRET-MUST-NOT-LEAK')
  expect(JSON.stringify(received)).not.toContain('SECRET-MUST-NOT-LEAK')
  expect(received).not.toHaveProperty('cause')
  return received as CredentialMigrationError
}

describe('legacy credential rehearsal preparation', () => {
  it('converts secret/settings/OAuth/connector formats through injected providers without touching originals', () => {
    const p = providers()
    const connector = {
      type: 'oauth2', clientId: 'fixture-client', clientSecret: 'fixture-client-secret',
      accessToken: 'fixture-connector-access', refreshToken: 'fixture-connector-refresh',
      expiresAt: 1_800_000_000_000, tokenType: 'Bearer', scope: null, revoked: false
    }
    const plaintexts = ['fixture-secret', 'fixture-setting', 'legacy-plaintext-key', 'fixture-access', 'fixture-refresh', JSON.stringify(connector), 'fallback-secret']
    const inputs: LegacyCredentialInput[] = [
      secret(p.legacy.storage.encryptString(plaintexts[0])),
      setting('safeStorage:v1:' + p.legacy.storage.encryptString(plaintexts[1]).toString('base64')),
      setting(plaintexts[2], 'other_api_key'),
      oauth(p.legacy.storage.encryptString(plaintexts[3]), 'access_token'),
      oauth(p.legacy.storage.encryptString(plaintexts[4]), 'refresh_token'),
      { location: { table: 'connector_instances', column: 'auth', rowId: 'connector-1' }, source: { kind: 'blob', interpretation: 'safeStorage', value: p.legacy.storage.encryptString(plaintexts[5]) }, connectorAuthType: 'oauth2' },
      secret(Buffer.from(plaintexts[6]), 'fallback', 'plaintext-utf8')
    ]
    const originals = inputs.map((input) => input.source.kind === 'blob' ? Buffer.from(input.source.value) : input.source.value)
    const plan = prepareCredentialMigration(inputs, p.injected)
    expect(plan).toMatchObject({ planVersion: 1, destinationFormat: 'fixture-store.v1' })
    expect(plan.changes.map((change) => p.target.storage.decryptString(Buffer.from(change.ciphertextBase64, 'base64')))).toEqual(plaintexts)
    expect(plan.encryptedBytes).toBe(plan.changes.reduce((total, change) => total + Buffer.from(change.ciphertextBase64, 'base64').length, 0))
    for (const [index, input] of inputs.entries()) expect(input.source.value).toEqual(originals[index])
    for (const plaintext of plaintexts) {
      expect(JSON.stringify(plan)).not.toContain(plaintext)
      expect(plan.changes.map((change) => Buffer.from(change.ciphertextBase64, 'base64').toString()).join('')).not.toContain(plaintext)
    }
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.changes)).toBe(true)
    expect(Object.isFrozen(plan.changes[0])).toBe(true)
    expect(Object.isFrozen(plan.changes[0].location)).toBe(true)
    expect(Reflect.set(plan.changes[0].location, 'rowId', 'changed')).toBe(false)
    Reflect.set(inputs[0].location, 'rowId', 'changed-input')
    expect(plan.changes[0].location.rowId).toBe('secret-1')
  })

  it.each([
    ['secret_text', { type: 'secret_text', secret: 'credential-secret' }],
    ['basic', { type: 'basic', username: 'fixture-user', password: 'credential-password' }],
    ['custom_auth', { type: 'custom_auth', props: { nested: { token: 'credential-token' }, region: 'fixture' } }]
  ] as const)('preserves the complete %s connector JSON payload', (authType, value) => {
    const p = providers()
    const plaintext = JSON.stringify(value, null, 2)
    const input: LegacyCredentialInput = { location: { table: 'connector_instances', rowId: 'connector', column: 'auth' }, connectorAuthType: authType, source: { kind: 'blob', interpretation: 'safeStorage', value: p.legacy.storage.encryptString(plaintext) } }
    const plan = prepareCredentialMigration([input], p.injected)
    expect(p.target.storage.decryptString(Buffer.from(plan.changes[0].ciphertextBase64, 'base64'))).toBe(plaintext)
  })

  it('keeps genuine empty secret/settings values while rejecting empty OAuth tokens', () => {
    const p = providers()
    const inputs = [secret(p.legacy.storage.encryptString('')), setting('')]
    const plan = prepareCredentialMigration(inputs, p.injected)
    expect(plan.changes.map((change) => p.target.storage.decryptString(Buffer.from(change.ciphertextBase64, 'base64')))).toEqual(['', ''])
    errorCode(() => prepareCredentialMigration([oauth(Buffer.alloc(0), 'refresh_token', 'plaintext-utf8')], p.injected), 'INVALID_SOURCE_FORMAT')
    errorCode(() => prepareCredentialMigration([oauth(p.legacy.storage.encryptString(''), 'access_token')], p.injected), 'INVALID_SOURCE_FORMAT')
  })

  it('does not require a legacy decoder for explicitly proven plaintext inputs', () => {
    const p = providers()
    const plan = prepareCredentialMigration([secret(Buffer.from('fallback'), 'plaintext', 'plaintext-utf8'), setting('fallback-key')], { destination: p.injected.destination })
    expect(plan.changes).toHaveLength(2)
    expect(p.legacy.storage.decryptString).not.toHaveBeenCalled()
  })

  it('preserves a leading UTF-8 BOM and Unicode in legacy plaintext byte-for-byte', () => {
    const p = providers()
    const plaintext = '\uFEFFpassword-雪-🔑'
    const original = Buffer.from(plaintext, 'utf8')
    const input = secret(original, 'unicode-secret', 'plaintext-utf8')
    const plan = prepareCredentialMigration([input], p.injected)
    const decoded = p.target.storage.decryptString(Buffer.from(plan.changes[0].ciphertextBase64, 'base64'))
    expect(decoded).toBe(plaintext)
    expect(Buffer.from(decoded, 'utf8')).toEqual(original)
    expect(input.source.value).toEqual(Buffer.from(plaintext, 'utf8'))
  })

  it('passes defensive ciphertext copies to a mutating legacy provider', () => {
    const p = providers()
    const blob = p.legacy.storage.encryptString('preserved-value')
    const original = Buffer.from(blob)
    const decode = p.legacy.storage.decryptString
    vi.mocked(p.legacy.storage.decryptString).mockImplementation((value) => {
      const plaintext = p.legacy.values.get(value.toString('base64'))!
      value.fill(0)
      return plaintext
    })
    const plan = prepareCredentialMigration([secret(blob)], p.injected)
    expect(plan.changes).toHaveLength(1)
    expect(blob).toEqual(original)
    expect(decode).toHaveBeenCalled()
  })
})

describe('migration fails closed without partial usable output', () => {
  it('requires explicit trusted interpretation for every untagged BLOB before encrypting anything', () => {
    const p = providers()
    const ambiguous = secret(Buffer.from('could-be-ciphertext'))
    Reflect.deleteProperty(ambiguous.source, 'interpretation')
    errorCode(() => prepareCredentialMigration([setting('valid'), ambiguous], p.injected), 'AMBIGUOUS_BLOB')
    expect(p.target.storage.encryptString).not.toHaveBeenCalled()
  })

  it.each(['safeStorage:v2:YWJj', 'safeStorage:v01:YWJj', 'safeStorage:', 'safeStorage:v1:', 'safeStorage:v1:!!!', 'safeStorage:v1:AB=='])('rejects unsupported or corrupt setting envelopes: %s', (value) => {
    const p = providers()
    errorCode(() => prepareCredentialMigration([setting(value)], p.injected), 'INVALID_SOURCE_FORMAT')
    expect(p.target.storage.encryptString).not.toHaveBeenCalled()
  })

  it('rejects invalid UTF-8 in explicitly identified legacy plaintext', () => {
    const p = providers()
    errorCode(() => prepareCredentialMigration([secret(Buffer.from([0xc0, 0x80]), 'bad-utf8', 'plaintext-utf8')], p.injected), 'INVALID_SOURCE_FORMAT')
    expect(p.target.storage.encryptString).not.toHaveBeenCalled()
  })

  it('rejects duplicate destinations and unsupported table/column sources', () => {
    const p = providers()
    errorCode(() => prepareCredentialMigration([setting('one'), setting('two')], p.injected), 'DUPLICATE_LOCATION')
    errorCode(() => prepareCredentialMigration([setting('value', 'not-a-credential')], p.injected), 'INVALID_SOURCE')
    const input = secret(Buffer.from('value'), 'secret', 'plaintext-utf8')
    Reflect.set(input.location, 'column', 'config')
    errorCode(() => prepareCredentialMigration([input], p.injected), 'INVALID_SOURCE')
    expect(p.target.storage.encryptString).not.toHaveBeenCalled()
  })

  it('rejects plaintext connector auth, malformed JSON, and mismatched auth_type metadata', () => {
    const p = providers()
    const input: LegacyCredentialInput = { location: { table: 'connector_instances', rowId: 'connector', column: 'auth' }, connectorAuthType: 'secret_text', source: { kind: 'blob', interpretation: 'plaintext-utf8', value: Buffer.from('{"type":"secret_text","secret":"fixture"}') } }
    errorCode(() => prepareCredentialMigration([input], p.injected), 'INVALID_SOURCE_FORMAT')
    const encrypted: LegacyCredentialInput = { ...input, source: { kind: 'blob', interpretation: 'safeStorage', value: p.legacy.storage.encryptString('SECRET-MUST-NOT-LEAK invalid json') } }
    errorCode(() => prepareCredentialMigration([encrypted], p.injected), 'INVALID_SOURCE_FORMAT')
    const mismatch: LegacyCredentialInput = { ...input, source: { kind: 'blob', interpretation: 'safeStorage', value: p.legacy.storage.encryptString('{"type":"basic","username":"fixture","password":"password"}') } }
    errorCode(() => prepareCredentialMigration([mismatch], p.injected), 'INVALID_SOURCE_FORMAT')
    expect(p.target.storage.encryptString).not.toHaveBeenCalled()
  })

  it('rejects missing, unavailable, or throwing legacy providers without forwarding errors', () => {
    const p = providers()
    const input = secret(p.legacy.storage.encryptString('fixture'))
    errorCode(() => prepareCredentialMigration([input], { destination: p.injected.destination }), 'LEGACY_UNAVAILABLE')
    vi.mocked(p.legacy.storage.isEncryptionAvailable).mockReturnValue(false)
    errorCode(() => prepareCredentialMigration([input], p.injected), 'LEGACY_UNAVAILABLE')
    vi.mocked(p.legacy.storage.isEncryptionAvailable).mockImplementation(() => { throw new Error('SECRET-MUST-NOT-LEAK locked') })
    errorCode(() => prepareCredentialMigration([input], p.injected), 'LEGACY_UNAVAILABLE')
    expect(p.target.storage.encryptString).not.toHaveBeenCalled()
  })

  it('never returns an earlier successful conversion after a later ciphertext fails', () => {
    const p = providers()
    const inputs = [secret(p.legacy.storage.encryptString('first'), 'first'), secret(Buffer.from('corrupt'), 'second')]
    const originals = inputs.map((input) => Buffer.from(input.source.value as Buffer))
    let output: unknown = null
    const error = errorCode(() => { output = prepareCredentialMigration(inputs, p.injected) }, 'LEGACY_DECRYPT_FAILED')
    expect(error.recordIndex).toBe(1)
    expect(output).toBeNull()
    expect(p.target.storage.encryptString).toHaveBeenCalledTimes(1)
    expect(inputs.map((input) => input.source.value)).toEqual(originals)
  })

  it('requires a protected destination and blocks missing/locked/identity providers', () => {
    const p = providers()
    const inputs = [setting('fixture')]
    errorCode(() => prepareCredentialMigration(inputs, {}), 'DESTINATION_NOT_SECURE')
    const unprotected = { ...p.injected.destination }
    Reflect.set(unprotected, 'persistentProtection', 'plaintext')
    errorCode(() => prepareCredentialMigration(inputs, { destination: unprotected }), 'DESTINATION_NOT_SECURE')
    vi.mocked(p.target.storage.isEncryptionAvailable).mockReturnValue(false)
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_UNAVAILABLE')
    vi.mocked(p.target.storage.isEncryptionAvailable).mockReturnValue(true)
    vi.mocked(p.target.storage.encryptString).mockImplementation((value) => Buffer.from(value))
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_NOT_SECURE')
  })

  it('blocks encryption failures, invalid outputs, failed verification, and a store locking mid-conversion', () => {
    const p = providers()
    const inputs = [setting('fixture')]
    vi.mocked(p.target.storage.encryptString).mockImplementation(() => { throw new Error('SECRET-MUST-NOT-LEAK locked') })
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_ENCRYPT_FAILED')
    vi.mocked(p.target.storage.encryptString).mockReturnValue('bad-return-type' as never)
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_ENCRYPT_FAILED')
    vi.mocked(p.target.storage.encryptString).mockReturnValue(Buffer.from('opaque'))
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_VERIFY_FAILED')
    vi.mocked(p.target.storage.decryptString).mockReturnValue('different')
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_VERIFY_FAILED')
    vi.mocked(p.target.storage.isEncryptionAvailable).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)
    errorCode(() => prepareCredentialMigration(inputs, p.injected), 'DESTINATION_UNAVAILABLE')
  })

  it('bounds record counts, individual/aggregate input, decoded values, and encrypted output', () => {
    const p = providers()
    errorCode(() => prepareCredentialMigration([setting('one'), setting('two', 'other_api_key')], p.injected, { maxRecords: 1 }), 'BOUNDS_EXCEEDED')
    errorCode(() => prepareCredentialMigration([setting('long')], p.injected, { maxRecordBytes: 2 }), 'BOUNDS_EXCEEDED')
    errorCode(() => prepareCredentialMigration([setting('one'), setting('two', 'other_api_key')], p.injected, { maxInputBytes: 5 }), 'BOUNDS_EXCEEDED')
    errorCode(() => prepareCredentialMigration([secret(p.legacy.storage.encryptString('x'.repeat(100)))], p.injected, { maxRecordBytes: 30 }), 'BOUNDS_EXCEEDED')
    errorCode(() => prepareCredentialMigration([setting('value')], p.injected, { maxOutputBytes: 1 }), 'BOUNDS_EXCEEDED')
    errorCode(() => prepareCredentialMigration([], p.injected, { maxInputBytes: CREDENTIAL_MIGRATION_LIMITS.maxInputBytes + 1 }), 'BOUNDS_EXCEEDED')
    errorCode(() => prepareCredentialMigration([], p.injected, { maxRecords: 0 }), 'BOUNDS_EXCEEDED')
  })
})

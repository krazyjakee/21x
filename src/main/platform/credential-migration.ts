import { TextDecoder } from 'node:util'
import type { SecretStorage } from './secret-storage'

const LEGACY_SETTING_PREFIX = 'safeStorage:v1:'

export type CredentialLocation =
  | { readonly table: 'secrets'; readonly rowId: string; readonly column: 'value' }
  | { readonly table: 'settings'; readonly rowId: string; readonly column: 'value' }
  | { readonly table: 'oauth_tokens'; readonly rowId: string; readonly column: 'access_token' | 'refresh_token' }
  | { readonly table: 'connector_instances'; readonly rowId: string; readonly column: 'auth' }

export type LegacyCredentialSource =
  | { readonly kind: 'setting'; readonly value: string }
  | {
      readonly kind: 'blob'
      readonly value: Buffer
      /** Trusted exporter provenance; never inferred from ciphertext bytes. */
      readonly interpretation?: 'safeStorage' | 'plaintext-utf8'
    }

export interface LegacyCredentialInput {
  readonly location: CredentialLocation
  readonly source: LegacyCredentialSource
  /** Required for connector auth: compare against its persisted auth_type. */
  readonly connectorAuthType?: 'secret_text' | 'basic' | 'custom_auth' | 'oauth2'
}

export interface CredentialMigrationDestination {
  readonly storage: SecretStorage
  /** Explicit, versioned provider format identity; this planner defines no cipher. */
  readonly formatId: string
  /** Must be established by trusted bootstrap, not by inspecting encrypted bytes. */
  readonly persistentProtection: 'os-protected'
}

export interface CredentialMigrationProviders {
  readonly legacy?: SecretStorage
  readonly destination?: CredentialMigrationDestination
}

export interface CredentialMigrationLimits {
  readonly maxRecords: number
  readonly maxRecordBytes: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
}

/** Callers may lower these limits; raising them requires a reviewed code change. */
export const CREDENTIAL_MIGRATION_LIMITS: CredentialMigrationLimits = Object.freeze({
  maxRecords: 10_000,
  maxRecordBytes: 1_048_576,
  maxInputBytes: 16_777_216,
  maxOutputBytes: 33_554_432
})

export type CredentialMigrationErrorCode =
  | 'INVALID_SOURCE' | 'AMBIGUOUS_BLOB' | 'INVALID_SOURCE_FORMAT'
  | 'DUPLICATE_LOCATION' | 'BOUNDS_EXCEEDED'
  | 'LEGACY_UNAVAILABLE' | 'LEGACY_DECRYPT_FAILED'
  | 'DESTINATION_NOT_SECURE' | 'DESTINATION_UNAVAILABLE'
  | 'DESTINATION_ENCRYPT_FAILED' | 'DESTINATION_VERIFY_FAILED'

/** Deliberately excludes row IDs, plaintext, provider error text, and causes. */
export class CredentialMigrationError extends Error {
  constructor(readonly code: CredentialMigrationErrorCode, readonly recordIndex?: number) {
    super(`Credential migration preparation failed: ${code}` + (recordIndex === undefined ? '' : ` at record ${recordIndex}`))
    this.name = 'CredentialMigrationError'
  }
}

export interface PreparedCredentialChange {
  readonly location: CredentialLocation
  /** Provider-owned ciphertext only; base64 makes the result deeply immutable. */
  readonly ciphertextBase64: string
}

export interface PreparedCredentialMigration {
  readonly planVersion: 1
  readonly destinationFormat: string
  readonly inputBytes: number
  readonly encryptedBytes: number
  readonly changes: readonly PreparedCredentialChange[]
}

function fail(code: CredentialMigrationErrorCode, index?: number): never {
  throw new CredentialMigrationError(code, index)
}

function available(storage: SecretStorage | undefined, code: CredentialMigrationErrorCode, index?: number): void {
  try {
    if (!storage?.isEncryptionAvailable()) fail(code, index)
  } catch {
    fail(code, index)
  }
}

function validLocation(location: CredentialLocation): boolean {
  if (!location || typeof location.rowId !== 'string' || !location.rowId || location.rowId.length > 256) return false
  switch (location.table) {
    case 'secrets': return location.column === 'value'
    case 'settings': return location.column === 'value' && location.rowId.endsWith('_api_key')
    case 'oauth_tokens': return location.column === 'access_token' || location.column === 'refresh_token'
    case 'connector_instances': return location.column === 'auth'
    default: return false
  }
}

function resolveLimits(overrides: Partial<CredentialMigrationLimits>): CredentialMigrationLimits {
  const limits = { ...CREDENTIAL_MIGRATION_LIMITS, ...overrides }
  for (const key of Object.keys(CREDENTIAL_MIGRATION_LIMITS) as (keyof CredentialMigrationLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > CREDENTIAL_MIGRATION_LIMITS[key]) fail('BOUNDS_EXCEEDED')
  }
  return limits
}

function decryptLegacy(value: Buffer, storage: SecretStorage | undefined, index: number): string {
  available(storage, 'LEGACY_UNAVAILABLE', index)
  const copy = Buffer.from(value)
  try {
    const decoded = storage!.decryptString(copy)
    if (typeof decoded !== 'string') fail('LEGACY_DECRYPT_FAILED', index)
    return decoded
  } catch {
    fail('LEGACY_DECRYPT_FAILED', index)
  } finally {
    copy.fill(0)
  }
}

function decodeSource(input: LegacyCredentialInput, storage: SecretStorage | undefined, index: number): string {
  if (input.source.kind === 'setting') {
    const value = input.source.value
    if (!value.startsWith(LEGACY_SETTING_PREFIX)) return value
    const encoded = value.slice(LEGACY_SETTING_PREFIX.length)
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('INVALID_SOURCE_FORMAT', index)
    const ciphertext = Buffer.from(encoded, 'base64')
    try {
      if (ciphertext.toString('base64') !== encoded) fail('INVALID_SOURCE_FORMAT', index)
      return decryptLegacy(ciphertext, storage, index)
    } finally {
      ciphertext.fill(0)
    }
  }
  if (input.source.interpretation === 'safeStorage') return decryptLegacy(input.source.value, storage, index)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.source.value)
  } catch {
    fail('INVALID_SOURCE_FORMAT', index)
  }
}

function validateConnector(value: string, authType: LegacyCredentialInput['connectorAuthType'], index: number): void {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { fail('INVALID_SOURCE_FORMAT', index) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('INVALID_SOURCE_FORMAT', index)
  const record = parsed as Record<string, unknown>
  if (record.type !== authType) fail('INVALID_SOURCE_FORMAT', index)
  const nullableString = (field: unknown): boolean => field === null || typeof field === 'string'
  let valid = false
  switch (record.type) {
    case 'secret_text': valid = typeof record.secret === 'string'; break
    case 'basic': valid = typeof record.username === 'string' && typeof record.password === 'string'; break
    case 'custom_auth': valid = !!record.props && typeof record.props === 'object' && !Array.isArray(record.props); break
    case 'oauth2':
      valid = typeof record.clientId === 'string' && nullableString(record.clientSecret) &&
        typeof record.accessToken === 'string' && !!record.accessToken && nullableString(record.refreshToken) &&
        (record.expiresAt === null || typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)) &&
        typeof record.tokenType === 'string' && nullableString(record.scope) &&
        (record.revoked === undefined || typeof record.revoked === 'boolean')
      break
  }
  if (!valid) fail('INVALID_SOURCE_FORMAT', index)
}

function encryptAndVerify(value: string, destination: CredentialMigrationDestination, index: number, outputBudget: number): Buffer {
  if (outputBudget < 1) fail('BOUNDS_EXCEEDED', index)
  available(destination.storage, 'DESTINATION_UNAVAILABLE', index)
  let ciphertext: Buffer
  try {
    const produced = destination.storage.encryptString(value)
    if (!Buffer.isBuffer(produced)) fail('DESTINATION_ENCRYPT_FAILED', index)
    if (produced.length > outputBudget) fail('BOUNDS_EXCEEDED', index)
    ciphertext = Buffer.from(produced)
  } catch (error) {
    if (error instanceof CredentialMigrationError) throw error
    fail('DESTINATION_ENCRYPT_FAILED', index)
  }
  const plaintextBytes = Buffer.from(value, 'utf8')
  let verified = false
  try {
    // Reject empty/identity transforms. This sanity check does not prove crypto
    // strength; bootstrap must attest to a real protected destination provider.
    if (!ciphertext.length || ciphertext.equals(plaintextBytes)) fail('DESTINATION_NOT_SECURE', index)
    available(destination.storage, 'DESTINATION_UNAVAILABLE', index)
    const copy = Buffer.from(ciphertext)
    try {
      if (destination.storage.decryptString(copy) !== value) fail('DESTINATION_VERIFY_FAILED', index)
    } catch {
      fail('DESTINATION_VERIFY_FAILED', index)
    } finally {
      copy.fill(0)
    }
    verified = true
    return ciphertext
  } finally {
    plaintextBytes.fill(0)
    if (!verified) ciphertext.fill(0)
  }
}

/**
 * Rehearse conversion entirely in the trusted service process. Returns a deeply
 * immutable encrypted-only plan after EVERY record passes. No database, files,
 * IPC, logging, provider registration, or application bootstrapping is involved.
 * Source buffers are never passed directly to providers and remain untouched.
 * Applying this plan to a profile needs separate transactional T10 machinery.
 */
export function prepareCredentialMigration(
  inputs: readonly LegacyCredentialInput[],
  providers: CredentialMigrationProviders,
  overrides: Partial<CredentialMigrationLimits> = {}
): PreparedCredentialMigration {
  const limits = resolveLimits(overrides)
  if (!Array.isArray(inputs) || inputs.length > limits.maxRecords) fail('BOUNDS_EXCEEDED')
  const destination = providers?.destination
  if (!destination || destination.persistentProtection !== 'os-protected' ||
      typeof destination.formatId !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(destination.formatId)) fail('DESTINATION_NOT_SECURE')
  available(destination.storage, 'DESTINATION_UNAVAILABLE')

  let inputBytes = 0
  let needsLegacy = false
  const locations = new Set<string>()
  // Validate the full manifest before starting encryption. Ambiguous or
  // duplicate rows cannot become a partially usable plan.
  for (const [index, input] of inputs.entries()) {
    if (!input || !validLocation(input.location) || !input.source) fail('INVALID_SOURCE', index)
    const key = JSON.stringify([input.location.table, input.location.rowId, input.location.column])
    if (locations.has(key)) fail('DUPLICATE_LOCATION', index)
    locations.add(key)
    let bytes: number
    if (input.source.kind === 'setting') {
      if (input.location.table !== 'settings' || typeof input.source.value !== 'string') fail('INVALID_SOURCE', index)
      if (input.source.value.startsWith('safeStorage:') && !input.source.value.startsWith(LEGACY_SETTING_PREFIX)) fail('INVALID_SOURCE_FORMAT', index)
      bytes = Buffer.byteLength(input.source.value, 'utf8')
      needsLegacy ||= input.source.value.startsWith(LEGACY_SETTING_PREFIX)
    } else if (input.source.kind === 'blob') {
      if (input.location.table === 'settings' || !Buffer.isBuffer(input.source.value)) fail('INVALID_SOURCE', index)
      if (input.source.interpretation !== 'safeStorage' && input.source.interpretation !== 'plaintext-utf8') fail('AMBIGUOUS_BLOB', index)
      if (input.location.table === 'connector_instances' && (input.source.interpretation !== 'safeStorage' || !input.connectorAuthType)) fail('INVALID_SOURCE_FORMAT', index)
      bytes = input.source.value.length
      if (input.source.interpretation === 'safeStorage' && !bytes) fail('INVALID_SOURCE_FORMAT', index)
      needsLegacy ||= input.source.interpretation === 'safeStorage'
    } else fail('INVALID_SOURCE', index)
    inputBytes += bytes
    if (bytes > limits.maxRecordBytes || inputBytes > limits.maxInputBytes) fail('BOUNDS_EXCEEDED', index)
  }
  if (needsLegacy) available(providers.legacy, 'LEGACY_UNAVAILABLE')

  const changes: PreparedCredentialChange[] = []
  let encryptedBytes = 0
  for (const [index, input] of inputs.entries()) {
    const plaintext = decodeSource(input, providers.legacy, index)
    if (Buffer.byteLength(plaintext, 'utf8') > limits.maxRecordBytes) fail('BOUNDS_EXCEEDED', index)
    if (input.location.table === 'oauth_tokens' && !plaintext) fail('INVALID_SOURCE_FORMAT', index)
    if (input.location.table === 'connector_instances') validateConnector(plaintext, input.connectorAuthType, index)
    const ciphertext = encryptAndVerify(plaintext, destination, index, limits.maxOutputBytes - encryptedBytes)
    try {
      encryptedBytes += ciphertext.length
      changes.push(Object.freeze({
        location: Object.freeze({ table: input.location.table, rowId: input.location.rowId, column: input.location.column }) as CredentialLocation,
        ciphertextBase64: ciphertext.toString('base64')
      }))
    } finally {
      ciphertext.fill(0)
    }
  }
  return Object.freeze({ planVersion: 1, destinationFormat: destination.formatId,
    inputBytes, encryptedBytes, changes: Object.freeze(changes) })
}

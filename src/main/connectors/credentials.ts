import { safeStorage } from 'electron'
import type { ConnectorStore } from './connector-store'

/**
 * Credentials for embedded connector pieces (docs/connectors.md).
 *
 * Persistent credentials are always safeStorage ciphertext. Unlike the rest of
 * the database layer (encryptSecret), there is no plaintext fallback: when the
 * OS keychain is unavailable, persistent setup is refused with
 * ConnectorCredentialsUnavailableError and the caller may opt in to
 * session-only credentials, which live in memory and are never written.
 *
 * Credential values must never be logged or put into errors, task content or
 * dead letters; run such text through redactCredentials() first.
 */

export type ConnectorCredentials =
  | { type: 'secret_text'; secret: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'custom_auth'; props: Record<string, unknown> }

export type ConnectorAuthType = ConnectorCredentials['type']
export type ConnectorCredentialStorage = 'persistent' | 'session'

export const CONNECTOR_CREDENTIALS_REMEDIATION =
  process.platform === 'linux'
    ? 'Your system keyring is not available, so 21x cannot encrypt connector credentials. ' +
      'Install and unlock a Secret Service keyring (GNOME Keyring or KWallet), or start 21x with ' +
      '--password-store=gnome-libsecret (or kwallet5/kwallet6), then try again. ' +
      'Until then you can use session-only credentials, which are forgotten when 21x quits.'
    : 'The operating system keychain is not available, so 21x cannot encrypt connector credentials. ' +
      'Make sure you are signed in to your user account and the keychain is unlocked, then try again. ' +
      'Until then you can use session-only credentials, which are forgotten when 21x quits.'

/** Persistent credential storage was requested but safeStorage cannot encrypt. */
export class ConnectorCredentialsUnavailableError extends Error {
  readonly code = 'CONNECTOR_CREDENTIALS_UNAVAILABLE'
  readonly remediation = CONNECTOR_CREDENTIALS_REMEDIATION
  readonly sessionOnlyAvailable = true
  constructor() {
    super(`Connector credentials cannot be stored securely. ${CONNECTOR_CREDENTIALS_REMEDIATION}`)
    this.name = 'ConnectorCredentialsUnavailableError'
  }
}

const REDACTED = '[REDACTED]'
/** Shorter values would redact ordinary words and digits; they carry little secret entropy anyway. */
const MIN_REDACT_LENGTH = 4

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'number' || typeof value === 'bigint') out.push(String(value))
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out)
}

/** Every secret string a credential could leak as, including derived forms like a Basic header. */
export function credentialSecrets(creds: ConnectorCredentials): string[] {
  const out: string[] = []
  switch (creds.type) {
    case 'secret_text':
      out.push(creds.secret)
      break
    case 'basic':
      out.push(creds.password, `${creds.username}:${creds.password}`)
      out.push(Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64'))
      break
    case 'custom_auth':
      collectStrings(creds.props, out)
      break
  }
  for (const s of [...out]) {
    const encoded = encodeURIComponent(s)
    if (encoded !== s) out.push(encoded)
  }
  return out
}

/** Replaces every credential value in `text`. Use on errors and log lines before they leave the host. */
export function redactCredentials(text: string, creds: ConnectorCredentials | ConnectorCredentials[] | null | undefined): string {
  if (!creds || !text) return text
  const secrets = (Array.isArray(creds) ? creds : [creds])
    .flatMap(credentialSecrets)
    .filter((s) => s.length >= MIN_REDACT_LENGTH)
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const s of secrets) out = out.split(s).join(REDACTED)
  return out
}

function isCredentials(value: unknown): value is ConnectorCredentials {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'secret_text': return typeof v.secret === 'string'
    case 'basic': return typeof v.username === 'string' && typeof v.password === 'string'
    case 'custom_auth': return !!v.props && typeof v.props === 'object' && !Array.isArray(v.props)
    default: return false
  }
}

export class ConnectorCredentialStore {
  private readonly session = new Map<string, ConnectorCredentials>()

  constructor(private readonly store: ConnectorStore) {
    // Removing a connector wipes its session credentials too; the persistent
    // ciphertext lives on the instance row and goes with it.
    store.onInstanceDeleted((id) => this.session.delete(id))
  }

  /** Whether persistent (encrypted) credentials can be stored right now. */
  isPersistentStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Stores credentials for an instance. `persistent` (default) encrypts them
   * into the database and throws ConnectorCredentialsUnavailableError when the
   * keychain cannot encrypt. `session` keeps them in memory for this app run
   * only, and clears any persisted copy.
   */
  set(instanceId: string, creds: ConnectorCredentials, storage: ConnectorCredentialStorage = 'persistent'): void {
    if (!isCredentials(creds)) throw new Error('Invalid connector credentials')
    if (!this.store.getInstance(instanceId)) throw new Error(`Connector instance not found: ${instanceId}`)
    if (storage === 'persistent') {
      if (!safeStorage.isEncryptionAvailable()) throw new ConnectorCredentialsUnavailableError()
      const blob = safeStorage.encryptString(JSON.stringify(creds))
      this.store.setAuthBlob(instanceId, creds.type, blob)
      this.session.delete(instanceId)
    } else {
      this.session.set(instanceId, creds)
      this.store.setAuthBlob(instanceId, creds.type, null)
    }
  }

  /**
   * The instance's credentials for `context.auth`, or null when none are set or
   * the stored ciphertext can no longer be decrypted (keychain reset or
   * unavailable). Session credentials win over persisted ones.
   */
  get(instanceId: string): ConnectorCredentials | null {
    const sessionCreds = this.session.get(instanceId)
    if (sessionCreds) return sessionCreds
    const row = this.store.getAuthBlob(instanceId)
    if (!row?.auth || !safeStorage.isEncryptionAvailable()) return null
    try {
      const parsed = JSON.parse(safeStorage.decryptString(row.auth)) as unknown
      return isCredentials(parsed) ? parsed : null
    } catch {
      // Deliberately no error detail: it could echo the decrypted text.
      console.warn(`[Connectors] Stored credentials for ${instanceId} could not be decrypted`)
      return null
    }
  }

  /** Where the instance's credentials live, or null when it has none. */
  getStorage(instanceId: string): ConnectorCredentialStorage | null {
    if (this.session.has(instanceId)) return 'session'
    return this.store.getAuthBlob(instanceId)?.auth ? 'persistent' : null
  }

  /** Forgets the instance's credentials in both memory and the database. */
  clear(instanceId: string): void {
    this.session.delete(instanceId)
    this.store.setAuthBlob(instanceId, null, null)
  }

  /** redactCredentials() with this instance's current credentials. */
  redact(instanceId: string, text: string): string {
    return redactCredentials(text, this.get(instanceId))
  }
}

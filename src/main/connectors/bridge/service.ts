import type {
  ConnectorBridgeCredentialInput,
  ConnectorBridgeCredentialStatus,
  ConnectorBridgeInstance,
  ConnectorBridgeOAuthConnectInput,
  ConnectorBridgeOAuthInfo,
  ConnectorBridgePiece,
  ConnectorBridgeSetCredentialsResult,
  ConnectorBridgeSyncStatus
} from '../../../shared/connector-bridge'
import { getAllowedPiece, type AllowedPieceOAuth } from '../allowlist'
import { narrowScopes } from '../oauth'
import { CONNECTOR_TASK_MAPPINGS, getTaskMapping } from './mappings'
import type { ConnectorTaskMapping } from './mapping'
import type { ConnectorRuntime } from './runtime-core'
import {
  ConnectorCredentialsUnavailableError,
  type ConnectorCredentialStorage,
  type ConnectorCredentials
} from '../credentials'

/**
 * Portable service for the connector-bridge task source form (issue #13): list the
 * pieces that have a task mapping, create the connector instance behind a
 * source, and store / clear its credentials. Credentials are write-only from
 * the caller's side; no method returns them. Only instances of mapped,
 * allowlisted pieces can be touched here.
 */

const MAX_CREDENTIAL_CHARS = 4096
/** LocalOAuthServer listens on the first free port in 3000-3010. */
const OAUTH_REDIRECT_URI_HINT = 'http://localhost:3000/callback (ports 3001-3010 are tried when 3000 is busy)'

function oauthInfo(mapping: ConnectorTaskMapping, oauth: AllowedPieceOAuth | undefined): ConnectorBridgeOAuthInfo | undefined {
  if (mapping.auth.type !== 'oauth2' || !oauth) return undefined
  return {
    mode: oauth.mode,
    pkce: oauth.pkce,
    clientSecretRequired: oauth.mode === 'user-supplied' && !oauth.pkce,
    scopes: narrowScopes(oauth.scopes, mapping.auth.scopes),
    redirectUriHint: OAUTH_REDIRECT_URI_HINT
  }
}

function bridgePieces(): ConnectorBridgePiece[] {
  return Object.values(CONNECTOR_TASK_MAPPINGS)
    .filter((m) => getAllowedPiece(m.pieceName))
    .map((m) => ({
      pieceName: m.pieceName,
      label: m.label,
      authType: m.auth.type,
      authLabels: { ...m.auth.labels },
      authHelp: m.auth.help,
      oauth: oauthInfo(m, getAllowedPiece(m.pieceName)?.oauth),
      configProps: m.configProps.map((p) => ({ ...p }))
    }))
}

function requireMapping(pieceName: unknown): ConnectorTaskMapping {
  const mapping = typeof pieceName === 'string' ? getTaskMapping(pieceName) : undefined
  if (!mapping || !getAllowedPiece(mapping.pieceName)) throw new Error('Unknown connector piece')
  return mapping
}

function requireBridgeInstance(runtime: ConnectorRuntime, instanceId: unknown): { id: string; mapping: ConnectorTaskMapping } {
  const instance = typeof instanceId === 'string' ? runtime.store.getInstance(instanceId) : undefined
  if (!instance) throw new Error('Connector not found')
  return { id: instance.id, mapping: requireMapping(instance.pieceName) }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  if (value.length > MAX_CREDENTIAL_CHARS) throw new Error(`${label} is too long`)
  return value.trim()
}

function toCredentials(mapping: ConnectorTaskMapping, input: ConnectorBridgeCredentialInput): ConnectorCredentials {
  const labels = mapping.auth.labels
  if (mapping.auth.type === 'oauth2') throw new Error(`${mapping.label} connects through OAuth; use Connect`)
  if (mapping.auth.type === 'basic') {
    return {
      type: 'basic',
      username: text(input?.username, labels.username ?? 'Username'),
      password: text(input?.password, labels.password ?? 'Password')
    }
  }
  return { type: 'secret_text', secret: text(input?.secret, labels.secret ?? 'Secret') }
}

export class ConnectorBridgeService {
  /** Resolve on each call so runtime shutdown cannot be bypassed by a cached instance. */
  constructor(private readonly runtime: () => ConnectorRuntime) {}

  bridgePieces(): ConnectorBridgePiece[] { return bridgePieces() }

  ensureInstance(pieceName: string, instanceId?: string): ConnectorBridgeInstance {
    const mapping = requireMapping(pieceName)
    const { store } = this.runtime()
    const existing = typeof instanceId === 'string' && instanceId ? store.getInstance(instanceId) : undefined
    if (existing && existing.pieceName === mapping.pieceName) return { instanceId: existing.id, pieceName: existing.pieceName }
    const piece = getAllowedPiece(mapping.pieceName)!
    const created = store.createInstance({ pieceName: mapping.pieceName, pieceVersion: piece.version, displayName: mapping.label })
    return { instanceId: created.id, pieceName: created.pieceName }
  }

  credentialStatus(instanceId: string): ConnectorBridgeCredentialStatus {
    const rt = this.runtime()
    const { id, mapping } = requireBridgeInstance(rt, instanceId)
    const status: ConnectorBridgeCredentialStatus = {
      storage: rt.credentialStore.getStorage(id),
      persistentAvailable: rt.credentialStore.isPersistentStorageAvailable()
    }
    if (mapping.auth.type === 'oauth2') status.oauth = rt.credentials.status(id)
    return status
  }

  setCredentials(instanceId: string, input: ConnectorBridgeCredentialInput, storage?: ConnectorCredentialStorage): ConnectorBridgeSetCredentialsResult {
    const rt = this.runtime()
    try {
      const { id, mapping } = requireBridgeInstance(rt, instanceId)
      const mode: ConnectorCredentialStorage = storage === 'session' ? 'session' : 'persistent'
      rt.credentialStore.set(id, toCredentials(mapping, input), mode)
      return { ok: true, storage: mode }
    } catch (err) {
      if (err instanceof ConnectorCredentialsUnavailableError) {
        return { ok: false, error: err.message, remediation: err.remediation, sessionOnlyAvailable: err.sessionOnlyAvailable }
      }
      // Validation messages only; they never echo the submitted values.
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save the credentials' }
    }
  }

  /**
   * OAuth2 pieces (issue #15): runs the browser flow through the runtime host and
   * stores the token set. The client id / secret travel caller -> service once
   * and, like every other credential, never come back.
   */
  async oauthConnect(instanceId: string, input: ConnectorBridgeOAuthConnectInput, storage?: ConnectorCredentialStorage): Promise<ConnectorBridgeSetCredentialsResult> {
    const rt = this.runtime()
    try {
      const { id, mapping } = requireBridgeInstance(rt, instanceId)
      if (mapping.auth.type !== 'oauth2') throw new Error(`${mapping.label} does not use OAuth`)
      const mode: ConnectorCredentialStorage = storage === 'session' ? 'session' : 'persistent'
      await rt.credentials.connect(
        id,
        { clientId: input?.clientId, clientSecret: input?.clientSecret, scopes: mapping.auth.scopes },
        mode
      )
      return { ok: true, storage: mode }
    } catch (err) {
      if (err instanceof ConnectorCredentialsUnavailableError) {
        return { ok: false, error: err.message, remediation: err.remediation, sessionOnlyAvailable: err.sessionOnlyAvailable }
      }
      // Flow and token-endpoint errors carry no credential values (see connector-oauth-provider.ts).
      return { ok: false, error: err instanceof Error ? err.message : 'Could not connect' }
    }
  }

  clearCredentials(instanceId: string): void {
    const rt = this.runtime()
    const { id } = requireBridgeInstance(rt, instanceId)
    rt.credentialStore.clear(id)
  }

  syncStatus(instanceId: string): ConnectorBridgeSyncStatus {
    const rt = this.runtime()
    const { id } = requireBridgeInstance(rt, instanceId)
    const state = rt.store.getSyncState(id)
    return {
      lastError: state?.lastError ?? null,
      lastSyncedAt: state?.lastSyncedAt ?? null,
      attemptCount: state?.attemptCount ?? 0,
      nextRetryAt: state?.nextRetryAt ?? null,
      deadLetterCount: rt.store.listDeadLetters(id).length
    }
  }
}

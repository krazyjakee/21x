import { runLoopbackOAuthFlow, type LoopbackCallbackServer } from '../oauth/connector-oauth-flow'
import { ConnectorOAuthProvider, OAuthTokenRequestError } from '../oauth/providers/connector-oauth-provider'
import { CONNECTOR_PIECE_ALLOWLIST, getAllowedPiece, type AllowedPieceOAuth, type ConnectorPieceAllowlist } from './allowlist'
import type { ConnectorStore } from './connector-store'
import {
  ConnectorCredentialsUnavailableError,
  type ConnectorCredentialStorage,
  type ConnectorCredentialStore,
  type ConnectorCredentials,
  type ConnectorOAuth2Credentials
} from './credentials'
import type { PieceCredentialSource } from './piece-host/client'

/**
 * OAuth2 for connector pieces (issue #15, docs/connectors.md "OAuth2 pieces").
 *
 * Sits between the credential store and the piece host as the
 * PieceCredentialSource every piece call resolves through:
 *
 * - `connect()` runs the loopback authorization-code flow
 *   (src/main/oauth/connector-oauth-flow.ts, PKCE when the allowlist entry
 *   says the provider supports it) and stores the token set with the
 *   instance's other credentials: safeStorage ciphertext, or session-only.
 * - `get()` hands back credentials with a usable access token, refreshing one
 *   that expires within REFRESH_MARGIN_MS first and persisting the result.
 *   A token that is expired with no refresh token, or whose refresh the
 *   provider refuses (invalid_grant), is reported as ConnectorOAuthError with
 *   a message the sync status can show; the set is marked `revoked` so the
 *   status reads "reconnect" until the user does.
 * - Non-OAuth credentials pass straight through.
 *
 * No client secret is shipped: it comes from the user's own app registration
 * (`mode: 'user-supplied'`) or is absent for a registered public client.
 */

export const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000

export type ConnectorOAuthErrorReason = 'not_configured' | 'not_connected' | 'revoked' | 'expired' | 'refresh_failed'

/** The instance's OAuth token cannot be used; the message is user-facing. */
export class ConnectorOAuthError extends Error {
  readonly code = 'CONNECTOR_OAUTH'
  constructor(
    readonly reason: ConnectorOAuthErrorReason,
    message: string
  ) {
    super(message)
    this.name = 'ConnectorOAuthError'
  }
}

export interface ConnectorOAuthConnectInput {
  /** Required for `user-supplied` mode; ignored for `registered`. */
  clientId?: string
  /** Required unless the provider takes PKCE without a secret. */
  clientSecret?: string
  /** Narrows the allowlist scopes to what the caller's mapping needs. */
  scopes?: string[]
}

export type ConnectorOAuthState = 'none' | 'connected' | 'revoked'

export interface ConnectorOAuthStatus {
  state: ConnectorOAuthState
  expiresAt: number | null
}

export interface ConnectorOAuthServiceOptions {
  store: ConnectorStore
  credentials: ConnectorCredentialStore
  /** Opens the provider's authorization page; `shell.openExternal` in the app. */
  openExternal: (url: string) => Promise<void> | void
  allowlist?: ConnectorPieceAllowlist
  /** For the token endpoint; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  now?: () => number
  /** Loopback server factory; tests inject one on a known port. */
  createServer?: () => LoopbackCallbackServer
}

const MAX_CLIENT_FIELD_CHARS = 4096

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  if (value.length > MAX_CLIENT_FIELD_CHARS) throw new Error(`${label} is too long`)
  return value.trim()
}

export class ConnectorOAuthService implements PieceCredentialSource {
  private readonly store: ConnectorStore
  private readonly credentials: ConnectorCredentialStore
  private readonly allowlist: ConnectorPieceAllowlist
  private readonly now: () => number
  private readonly refreshing = new Map<string, Promise<ConnectorCredentials | null>>()

  constructor(private readonly options: ConnectorOAuthServiceOptions) {
    this.store = options.store
    this.credentials = options.credentials
    this.allowlist = options.allowlist ?? CONNECTOR_PIECE_ALLOWLIST
    this.now = options.now ?? Date.now
  }

  /** The allowlist's OAuth2 settings for a piece, or undefined when it is not an OAuth2 piece. */
  oauthSpec(pieceName: string): AllowedPieceOAuth | undefined {
    return getAllowedPiece(pieceName, this.allowlist)?.oauth
  }

  /**
   * Runs the browser flow for the instance and stores the resulting token set.
   * Persistent storage is checked before the browser opens, so an unavailable
   * keychain fails fast with ConnectorCredentialsUnavailableError and the
   * caller can offer session-only storage.
   */
  async connect(instanceId: string, input: ConnectorOAuthConnectInput, storage: ConnectorCredentialStorage = 'persistent'): Promise<void> {
    const instance = this.store.getInstance(instanceId)
    if (!instance) throw new Error(`Connector instance not found: ${instanceId}`)
    const spec = this.oauthSpec(instance.pieceName)
    if (!spec) throw new ConnectorOAuthError('not_configured', `${instance.displayName || instance.pieceName} does not use OAuth2`)
    if (!spec.loopbackRedirect) {
      throw new ConnectorOAuthError('not_configured', `${instance.displayName || instance.pieceName} does not accept a localhost redirect, which 21x needs for OAuth2`)
    }
    if (storage === 'persistent' && !this.credentials.isPersistentStorageAvailable()) throw new ConnectorCredentialsUnavailableError()

    const clientId = spec.mode === 'registered' ? requireText(spec.clientId, 'Registered client id') : requireText(input.clientId, 'Client ID')
    const clientSecret = spec.mode === 'registered'
      ? null
      : spec.pkce && !(typeof input.clientSecret === 'string' && input.clientSecret.trim())
        ? null
        : requireText(input.clientSecret, 'Client secret')

    const scopes = narrowScopes(spec.scopes, input.scopes)
    const provider = this.provider(instance.pieceName, { ...spec, scopes })
    const { token } = await runLoopbackOAuthFlow({
      provider,
      config: clientSecret ? { client_id: clientId, client_secret: clientSecret } : { client_id: clientId },
      openExternal: this.options.openExternal,
      server: this.options.createServer?.()
    })
    const creds: ConnectorOAuth2Credentials = {
      type: 'oauth2',
      clientId,
      clientSecret,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in > 0 ? this.now() + token.expires_in * 1000 : null,
      tokenType: token.token_type ?? 'Bearer',
      scope: token.scope ?? (scopes.length ? scopes.join(' ') : null)
    }
    this.credentials.set(instanceId, creds, storage)
  }

  /** Forgets the token set and the client registration. */
  disconnect(instanceId: string): void {
    this.credentials.clear(instanceId)
  }

  status(instanceId: string): ConnectorOAuthStatus {
    const creds = this.credentials.get(instanceId)
    if (!creds || creds.type !== 'oauth2') return { state: 'none', expiresAt: null }
    if (creds.revoked || !creds.accessToken) return { state: 'revoked', expiresAt: null }
    return { state: 'connected', expiresAt: creds.expiresAt }
  }

  /**
   * PieceCredentialSource: the instance's credentials with a fresh access
   * token. Throws ConnectorOAuthError when the OAuth token is unusable.
   */
  get(instanceId: string): Promise<ConnectorCredentials | null> {
    const inflight = this.refreshing.get(instanceId)
    if (inflight) return inflight
    const run = this.resolve(instanceId).finally(() => {
      if (this.refreshing.get(instanceId) === run) this.refreshing.delete(instanceId)
    })
    this.refreshing.set(instanceId, run)
    return run
  }

  private async resolve(instanceId: string): Promise<ConnectorCredentials | null> {
    const creds = this.credentials.get(instanceId)
    if (!creds || creds.type !== 'oauth2') return creds
    const label = this.label(instanceId)
    if (creds.revoked || !creds.accessToken) {
      throw new ConnectorOAuthError('revoked', `${label} access was revoked or has expired; reconnect it in the task source settings.`)
    }
    if (creds.expiresAt === null || creds.expiresAt - this.now() > OAUTH_REFRESH_MARGIN_MS) return creds
    if (!creds.refreshToken) {
      this.markRevoked(instanceId, creds)
      throw new ConnectorOAuthError('expired', `${label} access has expired and cannot be renewed; reconnect it in the task source settings.`)
    }

    const pieceName = this.store.getInstance(instanceId)?.pieceName ?? ''
    const spec = this.oauthSpec(pieceName)
    if (!spec) throw new ConnectorOAuthError('not_configured', `${label} is no longer an OAuth2 connector`)
    const provider = this.provider(pieceName, spec)
    try {
      const token = await provider.refreshToken(creds.refreshToken, creds.clientId, creds.clientSecret ?? '')
      const updated: ConnectorOAuth2Credentials = {
        ...creds,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? creds.refreshToken,
        expiresAt: token.expires_in > 0 ? this.now() + token.expires_in * 1000 : null,
        tokenType: token.token_type ?? creds.tokenType,
        scope: token.scope ?? creds.scope
      }
      this.persist(instanceId, updated)
      return updated
    } catch (err) {
      if (err instanceof OAuthTokenRequestError && err.isInvalidGrant) {
        this.markRevoked(instanceId, creds)
        throw new ConnectorOAuthError('revoked', `${label} access was revoked or has expired; reconnect it in the task source settings.`)
      }
      if (err instanceof ConnectorCredentialsUnavailableError) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new ConnectorOAuthError('refresh_failed', `${label} access token could not be renewed: ${detail}`)
    }
  }

  private markRevoked(instanceId: string, creds: ConnectorOAuth2Credentials): void {
    try {
      this.persist(instanceId, { ...creds, accessToken: '', refreshToken: null, expiresAt: null, revoked: true })
    } catch {
      // The keychain went away: nothing to persist, the next get() reports it.
    }
  }

  /** Writes back where the credentials already live (persistent or session). */
  private persist(instanceId: string, creds: ConnectorOAuth2Credentials): void {
    const storage = this.credentials.getStorage(instanceId) ?? 'persistent'
    this.credentials.set(instanceId, creds, storage)
  }

  private provider(pieceName: string, spec: AllowedPieceOAuth): ConnectorOAuthProvider {
    const fetchImpl = this.options.fetch
    return new ConnectorOAuthProvider(
      {
        id: `connector:${pieceName}`,
        authUrl: spec.authUrl,
        tokenUrl: spec.tokenUrl,
        scopes: spec.scopes,
        pkce: spec.pkce,
        authParams: spec.authParams
      },
      fetchImpl ? (input, init) => fetchImpl(input, init) : undefined
    )
  }

  private label(instanceId: string): string {
    const instance = this.store.getInstance(instanceId)
    return instance?.displayName || instance?.pieceName || 'The connector'
  }
}

/** The requested scopes, limited to what the allowlist grants; the allowlist set when none are requested. */
export function narrowScopes(allowed: string[], requested?: string[]): string[] {
  if (!requested || requested.length === 0) return allowed
  const granted = new Set(allowed)
  const out = requested.filter((s) => granted.has(s))
  return out.length ? out : allowed
}

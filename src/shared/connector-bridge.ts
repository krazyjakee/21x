/**
 * Renderer-safe types for the connector-bridge IPC (`connectors:*`, issue #13).
 * Credentials only ever travel renderer -> main; nothing here carries them back.
 */

export type ConnectorBridgeAuthType = 'secret_text' | 'basic' | 'oauth2'
export type ConnectorBridgeCredentialStorage = 'persistent' | 'session'

/** How an OAuth2 piece connects (issue #15); mirrors the allowlist's `oauth` entry minus URLs. */
export interface ConnectorBridgeOAuthInfo {
  mode: 'user-supplied' | 'registered'
  pkce: boolean
  /** The user must paste a client secret (no PKCE, or a confidential client). */
  clientSecretRequired: boolean
  scopes: string[]
  /** What to register with the provider as the OAuth redirect URL. */
  redirectUriHint: string
}

export interface ConnectorBridgeOAuthConnectInput {
  clientId?: string
  clientSecret?: string
}

export type ConnectorBridgeOAuthState = 'none' | 'connected' | 'revoked'

export interface ConnectorBridgeConfigProp {
  key: string
  label: string
  required?: boolean
  description?: string
  placeholder?: string
}

export interface ConnectorBridgePiece {
  pieceName: string
  label: string
  authType: ConnectorBridgeAuthType
  /** Form labels: `username`/`password` for basic, `secret` for secret_text. */
  authLabels: Record<string, string>
  authHelp?: string
  /** Present when `authType` is `oauth2`. */
  oauth?: ConnectorBridgeOAuthInfo
  configProps: ConnectorBridgeConfigProp[]
}

export interface ConnectorBridgeInstance {
  instanceId: string
  pieceName: string
}

export interface ConnectorBridgeCredentialStatus {
  storage: ConnectorBridgeCredentialStorage | null
  persistentAvailable: boolean
  /** OAuth2 pieces: `revoked` means the token was refused and the user must reconnect. */
  oauth?: { state: ConnectorBridgeOAuthState; expiresAt: number | null }
}

/** Fields entered in the form; which ones apply depends on the piece's auth type. */
export interface ConnectorBridgeCredentialInput {
  username?: string
  password?: string
  secret?: string
}

export type ConnectorBridgeSetCredentialsResult =
  | { ok: true; storage: ConnectorBridgeCredentialStorage }
  | { ok: false; error: string; remediation?: string; sessionOnlyAvailable?: boolean }

export interface ConnectorBridgeSyncStatus {
  lastError: string | null
  lastSyncedAt: number | null
  attemptCount: number
  nextRetryAt: number | null
  deadLetterCount: number
}

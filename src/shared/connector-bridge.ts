/**
 * Renderer-safe types for the connector-bridge IPC (`connectors:*`, issue #13).
 * Credentials only ever travel renderer -> main; nothing here carries them back.
 */

export type ConnectorBridgeAuthType = 'secret_text' | 'basic'
export type ConnectorBridgeCredentialStorage = 'persistent' | 'session'

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
  configProps: ConnectorBridgeConfigProp[]
}

export interface ConnectorBridgeInstance {
  instanceId: string
  pieceName: string
}

export interface ConnectorBridgeCredentialStatus {
  storage: ConnectorBridgeCredentialStorage | null
  persistentAvailable: boolean
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

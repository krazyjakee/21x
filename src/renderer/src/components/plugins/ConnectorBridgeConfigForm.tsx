import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { connectorBridgeApi } from '@/lib/ipc-client'
import type {
  ConnectorBridgeCredentialStatus,
  ConnectorBridgeCredentialStorage,
  ConnectorBridgePiece,
  ConnectorBridgeSetCredentialsResult,
  ConnectorBridgeSyncStatus
} from '@shared/connector-bridge'
import type { PluginFormProps } from './PluginFormProps'

/**
 * Config form for the connector-bridge task source (issue #13).
 *
 * Choose an allowlisted piece, enter its credentials (sent once to the
 * main-process credential store and never read back), fill in the piece's
 * mapping props and a poll interval. The config only keeps the piece name,
 * the connector instance id, the props and the interval.
 *
 * OAuth2 pieces (issue #15) take the user's own app registration (client id
 * and, when the provider needs one, secret) and a Connect button that runs
 * the browser flow in the main process; the form then shows the connected /
 * revoked state and a Disconnect button.
 */
export function ConnectorBridgeConfigForm({ value, onChange }: PluginFormProps) {
  const [pieces, setPieces] = useState<ConnectorBridgePiece[]>([])
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [credentialStatus, setCredentialStatus] = useState<ConnectorBridgeCredentialStatus | null>(null)
  const [syncStatus, setSyncStatus] = useState<ConnectorBridgeSyncStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remediation, setRemediation] = useState<string | null>(null)
  const [sessionOffered, setSessionOffered] = useState(false)

  const valueRef = useRef(value)
  valueRef.current = value

  const pieceName = (value.piece_name as string) || ''
  const instanceId = (value.connector_instance_id as string) || ''
  const props = (value.props && typeof value.props === 'object' ? value.props : {}) as Record<string, string>
  const piece = pieces.find((p) => p.pieceName === pieceName)
  const isOAuth = piece?.authType === 'oauth2'

  useEffect(() => {
    connectorBridgeApi.bridgePieces().then(setPieces).catch(() => setPieces([]))
  }, [])

  // Default the piece and interval on a new source.
  useEffect(() => {
    if (!pieceName && pieces.length > 0) {
      onChange({ poll_interval_minutes: 15, ...valueRef.current, piece_name: pieces[0].pieceName })
    }
  }, [pieces, pieceName, onChange])

  const refreshStatus = useCallback(async () => {
    if (!instanceId) {
      setCredentialStatus(null)
      setSyncStatus(null)
      return
    }
    try {
      setCredentialStatus(await connectorBridgeApi.credentialStatus(instanceId))
      setSyncStatus(await connectorBridgeApi.syncStatus(instanceId))
    } catch {
      setCredentialStatus(null)
      setSyncStatus(null)
    }
  }, [instanceId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const choosePiece = (name: string) => {
    if (name === pieceName) return
    // A connection belongs to one piece; switching starts a new one.
    onChange({ ...value, piece_name: name, connector_instance_id: '', props: {} })
    setCredentials({})
    setError(null)
    setRemediation(null)
    setSessionOffered(false)
  }

  const updateProp = (key: string, val: string) => {
    onChange({ ...value, props: { ...props, [key]: val } })
  }

  /** Creates the instance if needed, runs `store` against it, and applies the shared result handling. */
  const withInstance = async (
    store: (id: string) => Promise<ConnectorBridgeSetCredentialsResult>
  ) => {
    if (!piece) return
    setSaving(true)
    setError(null)
    try {
      const instance = await connectorBridgeApi.ensureInstance(piece.pieceName, instanceId || undefined)
      if (instance.instanceId !== instanceId) {
        onChange({ ...valueRef.current, connector_instance_id: instance.instanceId })
      }
      const result = await store(instance.instanceId)
      if (result.ok) {
        setCredentials({})
        setRemediation(null)
        setSessionOffered(false)
        setCredentialStatus(await connectorBridgeApi.credentialStatus(instance.instanceId))
      } else {
        setError(result.error)
        setRemediation(result.remediation ?? null)
        setSessionOffered(!!result.sessionOnlyAvailable)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : isOAuth ? 'Could not connect' : 'Could not save the credentials')
    } finally {
      setSaving(false)
    }
  }

  const saveCredentials = (storage: ConnectorBridgeCredentialStorage) =>
    withInstance((id) => connectorBridgeApi.setCredentials(id, credentials, storage))

  const connectOAuth = (storage: ConnectorBridgeCredentialStorage) =>
    withInstance((id) =>
      connectorBridgeApi.oauthConnect(id, { clientId: credentials.clientId, clientSecret: credentials.clientSecret }, storage)
    )

  const disconnect = async () => {
    if (!instanceId) return
    setSaving(true)
    setError(null)
    try {
      await connectorBridgeApi.clearCredentials(instanceId)
      setCredentials({})
      setSessionOffered(false)
      setRemediation(null)
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect')
    } finally {
      setSaving(false)
    }
  }

  const credentialFields: { key: string; label: string; optional?: boolean }[] = piece
    ? piece.authType === 'basic'
      ? [
          { key: 'username', label: piece.authLabels.username ?? 'Username' },
          { key: 'password', label: piece.authLabels.password ?? 'Password' }
        ]
      : piece.authType === 'oauth2'
        ? piece.oauth?.mode === 'registered'
          ? []
          : [
              { key: 'clientId', label: piece.authLabels.clientId ?? 'Client ID' },
              // A PKCE provider may take a public client; the secret is then optional.
              { key: 'clientSecret', label: piece.authLabels.clientSecret ?? 'Client secret', optional: piece.oauth?.clientSecretRequired === false }
            ]
        : [{ key: 'secret', label: piece.authLabels.secret ?? 'Secret' }]
    : []
  const credentialsComplete = credentialFields.every((f) => f.optional || (credentials[f.key] ?? '').trim())

  const oauthState = credentialStatus?.oauth?.state ?? 'none'
  const connected = isOAuth ? oauthState === 'connected' : !!credentialStatus?.storage

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="bridge-piece">Connector</Label>
        <select
          id="bridge-piece"
          value={pieceName}
          onChange={(e) => choosePiece(e.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
        >
          {pieces.length === 0 && <option value="">No connectors available</option>}
          {pieces.map((p) => (
            <option key={p.pieceName} value={p.pieceName}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Only allowlisted connector actions run. Coding agents never see this connection.
        </p>
      </div>

      {piece && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">{isOAuth ? 'Connection' : 'Credentials'}</p>
            {connected && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 className="h-3 w-3" />
                {credentialStatus?.storage === 'session' ? 'Connected for this session' : 'Connected'}
              </span>
            )}
            {isOAuth && oauthState === 'revoked' && (
              <span className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                Access revoked; reconnect
              </span>
            )}
          </div>
          {piece.authHelp && <p className="text-xs text-muted-foreground">{piece.authHelp}</p>}
          {isOAuth && piece.oauth && (
            <p className="text-xs text-muted-foreground">
              Redirect URL to register: <code className="text-xs bg-muted px-1 rounded">{piece.oauth.redirectUriHint}</code>
              {piece.oauth.scopes.length > 0 && <> · Scopes requested: {piece.oauth.scopes.join(', ')}</>}
              {piece.oauth.pkce ? ' · PKCE' : ''}
            </p>
          )}
          {credentialFields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`bridge-cred-${f.key}`}>
                {f.label}
                {f.optional ? ' (optional)' : ''}
              </Label>
              <Input
                id={`bridge-cred-${f.key}`}
                type={f.key === 'clientId' ? 'text' : 'password'}
                autoComplete="off"
                value={credentials[f.key] ?? ''}
                onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                placeholder={connected || oauthState === 'revoked' ? 'Stored; enter a new value to replace it' : ''}
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            {isOAuth ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void connectOAuth('persistent')}
                disabled={saving || !credentialsComplete}
                variant={connected ? 'outline' : 'default'}
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                {saving ? `Waiting for ${piece.label}…` : connected ? `Reconnect ${piece.label}` : `Connect ${piece.label}`}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={() => void saveCredentials('persistent')}
                disabled={saving || !credentialsComplete}
              >
                {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                Save credentials
              </Button>
            )}
            {isOAuth && (connected || oauthState === 'revoked') && (
              <Button type="button" size="sm" variant="ghost" onClick={() => void disconnect()} disabled={saving}>
                Disconnect
              </Button>
            )}
          </div>
          {isOAuth && saving && (
            <p className="text-xs text-muted-foreground">
              Finish signing in to {piece.label} in your browser. This window updates when {piece.label} sends you back.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          {remediation && remediation !== error && <p className="text-xs text-muted-foreground">{remediation}</p>}
          {sessionOffered && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void (isOAuth ? connectOAuth('session') : saveCredentials('session'))}
              disabled={saving || !credentialsComplete}
            >
              Keep for this session only
            </Button>
          )}
        </div>
      )}

      {piece && piece.configProps.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-border">
          {piece.configProps.map((p) => (
            <div key={p.key} className="space-y-1.5">
              <Label htmlFor={`bridge-prop-${p.key}`}>
                {p.label}
                {p.required ? ' *' : ''}
              </Label>
              <Input
                id={`bridge-prop-${p.key}`}
                value={props[p.key] ?? ''}
                onChange={(e) => updateProp(p.key, e.target.value)}
                placeholder={p.placeholder}
              />
              {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="bridge-interval">Sync every (minutes)</Label>
        <Input
          id="bridge-interval"
          type="number"
          min={0}
          value={String(value.poll_interval_minutes ?? 15)}
          onChange={(e) => onChange({ ...value, poll_interval_minutes: e.target.value === '' ? 0 : Number(e.target.value) })}
        />
        <p className="text-xs text-muted-foreground">0 syncs only when you click Sync.</p>
      </div>

      {syncStatus && (syncStatus.lastError || syncStatus.deadLetterCount > 0 || syncStatus.nextRetryAt) && (
        <div className="space-y-1 pt-2 border-t border-border text-xs text-muted-foreground">
          {syncStatus.nextRetryAt && <p>Retrying after {new Date(syncStatus.nextRetryAt).toLocaleString()}.</p>}
          {syncStatus.deadLetterCount > 0 && (
            <p>{syncStatus.deadLetterCount} item(s) kept failing and were set aside.</p>
          )}
          {syncStatus.lastError && <p className="whitespace-pre-wrap text-destructive">{syncStatus.lastError}</p>}
        </div>
      )}
    </div>
  )
}

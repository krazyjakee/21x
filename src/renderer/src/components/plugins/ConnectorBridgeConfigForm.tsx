import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { Button } from '@/components/ui/Button'
import { connectorBridgeApi } from '@/lib/ipc-client'
import type {
  ConnectorBridgeCredentialStatus,
  ConnectorBridgeCredentialStorage,
  ConnectorBridgePiece,
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

  const saveCredentials = async (storage: ConnectorBridgeCredentialStorage) => {
    if (!piece) return
    setSaving(true)
    setError(null)
    try {
      const instance = await connectorBridgeApi.ensureInstance(piece.pieceName, instanceId || undefined)
      if (instance.instanceId !== instanceId) {
        onChange({ ...valueRef.current, connector_instance_id: instance.instanceId })
      }
      const result = await connectorBridgeApi.setCredentials(instance.instanceId, credentials, storage)
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
      setError(err instanceof Error ? err.message : 'Could not save the credentials')
    } finally {
      setSaving(false)
    }
  }

  const credentialFields = piece
    ? piece.authType === 'basic'
      ? [
          { key: 'username', label: piece.authLabels.username ?? 'Username' },
          { key: 'password', label: piece.authLabels.password ?? 'Password' }
        ]
      : [{ key: 'secret', label: piece.authLabels.secret ?? 'Secret' }]
    : []
  const credentialsComplete = credentialFields.every((f) => (credentials[f.key] ?? '').trim())

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
            <p className="text-xs font-medium text-muted-foreground">Credentials</p>
            {credentialStatus?.storage && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 className="h-3 w-3" />
                {credentialStatus.storage === 'session' ? 'Connected for this session' : 'Connected'}
              </span>
            )}
          </div>
          {piece.authHelp && <p className="text-xs text-muted-foreground">{piece.authHelp}</p>}
          {credentialFields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`bridge-cred-${f.key}`}>{f.label}</Label>
              <Input
                id={`bridge-cred-${f.key}`}
                type="password"
                autoComplete="off"
                value={credentials[f.key] ?? ''}
                onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                placeholder={credentialStatus?.storage ? 'Stored; enter a new value to replace it' : ''}
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            onClick={() => void saveCredentials('persistent')}
            disabled={saving || !credentialsComplete}
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            Save credentials
          </Button>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {remediation && remediation !== error && <p className="text-xs text-muted-foreground">{remediation}</p>}
          {sessionOffered && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void saveCredentials('session')}
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

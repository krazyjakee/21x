import { useState, useEffect } from 'react'
import QRCode from 'qrcode'
import { SettingsSection } from '../../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { mobileApi } from '@/lib/ipc-client'
import { useMobilePairing } from './use-mobile-pairing'

const toQrDataUrl = (url: string): Promise<string> => QRCode.toDataURL(url, { width: 200, margin: 1 })

function CopyableUrl({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="text-sm font-mono bg-accent/50 rounded px-2.5 py-1 text-foreground select-all max-w-[260px] truncate">
        {url.split('#')[0]}
      </code>
      <button
        onClick={() => navigator.clipboard.writeText(url)}
        className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        title="Copy URL"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
        </svg>
      </button>
    </div>
  )
}

export function ConnectPhoneSection() {
  const [loading, setLoading] = useState(true)
  const [mobileLanUrl, setMobileLanUrl] = useState('')
  const [mobileTunnelUrl, setMobileTunnelUrl] = useState<string | null>(null)
  const [tunnelActive, setTunnelActive] = useState(false)
  const [tunnelLoading, setTunnelLoading] = useState(false)
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const [remoteMode, setRemoteMode] = useState<'quick' | 'custom'>('quick')
  const [customUrlInput, setCustomUrlInput] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const { pairingPin, pinSecondsLeft, sessions, revokeSession, revokeAllSessions } = useMobilePairing()

  useEffect(() => {
    const load = async () => {
      try {
        const info = await mobileApi.getInfo()
        setMobileLanUrl(info.lanUrl)
        setMobileTunnelUrl(info.tunnelUrl)
        setTunnelActive(info.tunnelActive)
        setRemoteMode(info.remoteMode)
        setCustomUrlInput(info.customUrl ?? '')
        const qrUrl = info.tunnelUrl ?? info.lanUrl ?? info.url
        if (qrUrl) setQrDataUrl(await toQrDataUrl(qrUrl))
      } catch (error) {
        console.error('Failed to load mobile URL:', error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Single place that applies a new active remote URL (null falls back to the
  // LAN URL) so the quick-tunnel switch, custom-URL button and mode switch
  // cannot drift apart.
  const applyRemoteUrl = async (url: string | null) => {
    setMobileTunnelUrl(url)
    setTunnelActive(Boolean(url))
    const qrUrl = url ?? mobileLanUrl
    if (qrUrl) setQrDataUrl(await toQrDataUrl(qrUrl))
  }

  const runTunnelAction = async (action: () => Promise<void>, fallbackError: string, logFailure = false) => {
    setTunnelLoading(true)
    setTunnelError(null)
    try {
      await action()
    } catch (err) {
      if (logFailure) console.error('Tunnel toggle failed:', err)
      setTunnelError(err instanceof Error ? err.message : fallbackError)
    } finally {
      setTunnelLoading(false)
    }
  }

  const handleRemoteModeChange = async (mode: 'quick' | 'custom') => {
    setTunnelError(null)
    if (mode === 'custom') {
      setRemoteMode('custom')
      return
    }
    await runTunnelAction(async () => {
      await mobileApi.stopTunnel()
      await mobileApi.clearCustomUrl()
      setRemoteMode('quick')
      await applyRemoteUrl(null)
    }, 'Failed to switch remote access method')
  }

  const handleTunnelToggle = (checked: boolean) =>
    runTunnelAction(async () => {
      if (checked) {
        const { tunnelUrl: url } = await mobileApi.startTunnel()
        await applyRemoteUrl(url)
      } else {
        await mobileApi.stopTunnel()
        await applyRemoteUrl(null)
      }
    }, 'Failed to start remote access', true)

  const handleSetCustomUrl = () =>
    runTunnelAction(async () => {
      const { url } = await mobileApi.setCustomUrl(customUrlInput.trim())
      await applyRemoteUrl(url)
    }, 'Failed to set custom URL')

  const regenerateQr = async () => {
    try {
      const info = await mobileApi.getInfo()
      const qrUrl = info.tunnelUrl ?? info.lanUrl ?? info.url
      if (qrUrl) setQrDataUrl(await toQrDataUrl(qrUrl))
    } catch { /* ignore */ }
  }

  return (
    <SettingsSection
      title="Connect Phone"
      description="Access 20x from your phone or any browser"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label>Local network</Label>
            <p className="text-xs text-muted-foreground">Works on same Wi-Fi</p>
          </div>
          {mobileLanUrl ? (
            <CopyableUrl url={mobileLanUrl} />
          ) : loading ? (
            <span className="text-sm text-muted-foreground">Loading...</span>
          ) : (
            <span className="text-sm text-muted-foreground">Unavailable</span>
          )}
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label>Remote access method</Label>
            <p className="text-xs text-muted-foreground">Cloudflare quick tunnel, or bring your own URL</p>
          </div>
          <Select
            value={remoteMode}
            disabled={tunnelLoading}
            onChange={(e) => handleRemoteModeChange(e.target.value as 'quick' | 'custom')}
            options={[
              { value: 'quick', label: 'Cloudflare Quick Tunnel' },
              { value: 'custom', label: 'Custom URL' }
            ]}
            className="w-auto"
          />
        </div>

        {remoteMode === 'quick' ? (
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>Remote access</Label>
              <p className="text-xs text-muted-foreground">
                {tunnelActive
                  ? 'Accessible from anywhere via Cloudflare tunnel'
                  : 'Enable to access from outside your network'}
              </p>
            </div>
            <Switch checked={tunnelActive} disabled={tunnelLoading} onCheckedChange={handleTunnelToggle} />
          </div>
        ) : (
          <div className="flex items-center justify-between py-2 border-b border-border gap-3">
            <div className="space-y-0.5">
              <Label>Custom URL</Label>
              <p className="text-xs text-muted-foreground">Your own tunnel or reverse proxy pointed at 20x</p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={customUrlInput}
                onChange={(e) => setCustomUrlInput(e.target.value)}
                placeholder="https://my-tunnel.example.com"
                className="w-56"
                disabled={tunnelLoading}
              />
              <Button
                size="sm"
                disabled={tunnelLoading || !customUrlInput.trim()}
                onClick={handleSetCustomUrl}
              >
                {tunnelActive ? 'Update' : 'Enable'}
              </Button>
            </div>
          </div>
        )}
        {tunnelError && (
          <p className="text-xs text-destructive -mt-1 mb-2">{tunnelError}</p>
        )}

        {tunnelActive && mobileTunnelUrl && (
          <div className="flex items-center justify-between py-2 border-b border-border">
            <div className="space-y-0.5">
              <Label>Remote URL</Label>
              <p className="text-xs text-muted-foreground">Share or scan to connect</p>
            </div>
            <CopyableUrl url={mobileTunnelUrl} />
          </div>
        )}

        {qrDataUrl && (
          <div className="flex flex-col items-center gap-3 pt-2">
            <div className="relative">
              <img src={qrDataUrl} alt="QR code" className="rounded-lg border border-border" width={200} height={200} />
              {/* Shown once the phone has scanned and is waiting for the PIN */}
              {pairingPin && (
                <div className="absolute inset-0 bg-background/95 rounded-lg flex flex-col items-center justify-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Enter this PIN on your phone</p>
                  <div className="flex gap-1.5">
                    {pairingPin.split('').map((d, i) => (
                      <span key={i} className="w-8 h-10 flex items-center justify-center bg-accent rounded-md text-xl font-mono font-bold text-foreground">
                        {d}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Expires in {pinSecondsLeft}s</p>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {pairingPin ? 'Phone is waiting for PIN' : tunnelActive ? 'Scan from anywhere' : 'Scan on same Wi-Fi'}
            </p>
            <button
              onClick={regenerateQr}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Regenerate QR
            </button>
          </div>
        )}

        {sessions.length > 0 && (
          <div className="pt-2 space-y-2">
            <div className="flex items-center justify-between">
              <Label>Connected devices</Label>
              <button
                onClick={revokeAllSessions}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Revoke all
              </button>
            </div>
            <div className="space-y-1">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-1.5 px-2 rounded-md bg-accent/30">
                  <div>
                    <p className="text-sm text-foreground">📱 {s.device_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Last seen {new Date(s.last_seen * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => revokeSession(s.id)}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}

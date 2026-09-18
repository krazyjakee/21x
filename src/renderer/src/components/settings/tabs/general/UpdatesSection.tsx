import { useState, useEffect } from 'react'
import { RefreshCw, Download, Check, Loader2 } from 'lucide-react'
import { SettingsSection } from '../../SettingsSection'
import { Button } from '@/components/ui/Button'
import { updaterApi } from '@/lib/ipc-client'

export function UpdatesSection() {
  const [updateStatus, setUpdateStatus] = useState<string>('idle')
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updatePercent, setUpdatePercent] = useState(0)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  useEffect(() => {
    return updaterApi.onStatus((data) => {
      setUpdateStatus(data.status)
      if (data.version) setUpdateVersion(data.version)
      if (data.percent !== undefined) setUpdatePercent(data.percent)
      if (data.error) setUpdateError(data.error)
    })
  }, [])

  useEffect(() => {
    updaterApi.getVersion()
      .then(setCurrentVersion)
      .catch((error) => console.error('Failed to load app version:', error))
  }, [])

  return (
    <SettingsSection
      title="Updates"
      description="Check for new versions and install updates"
    >
      <div className="flex items-center gap-3">
        {currentVersion && (
          <span className="text-xs text-muted-foreground flex items-center gap-1.5 mr-2">
            Current version: v{currentVersion}
          </span>
        )}
        {updateStatus === 'idle' || updateStatus === 'up-to-date' || updateStatus === 'error' ? (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              setUpdateError(null)
              setUpdateStatus('checking')
              await updaterApi.check()
            }}
          >
            <RefreshCw className="size-3.5 mr-1.5" />
            Check for Updates
          </Button>
        ) : updateStatus === 'checking' ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            Checking...
          </Button>
        ) : updateStatus === 'available' ? (
          <Button size="sm" onClick={() => updaterApi.download()}>
            <Download className="size-3.5 mr-1.5" />
            Download v{updateVersion}
          </Button>
        ) : updateStatus === 'downloading' ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            Downloading... {updatePercent}%
          </Button>
        ) : updateStatus === 'downloaded' ? (
          <Button size="sm" onClick={() => updaterApi.install()}>
            <Check className="size-3.5 mr-1.5" />
            Install & Restart (v{updateVersion})
          </Button>
        ) : null}

        {updateStatus === 'up-to-date' && (
          <span className="text-xs text-emerald-400 flex items-center gap-1.5">
            <Check className="size-3.5" />
            You&apos;re on the latest version
          </span>
        )}

        {updateError && (
          <span className="text-xs text-red-400">{updateError}</span>
        )}
      </div>
    </SettingsSection>
  )
}

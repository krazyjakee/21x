import { useEffect, useState } from 'react'
import { Download, Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { desktopApi } from '@/lib/desktop-api'
import { settingsApi } from '@/lib/ipc-client'
import type { ToolStatus } from '@/types/electron'
import {
  isRtkEnabled,
  RTK_ENABLED_SETTING,
  RTK_STATE_LABELS,
  rtkBackendCoverage,
  rtkEffectiveState,
  rtkGlobalHooksAfterOptOut,
  type RtkCoverage
} from '@shared/rtk'

const COVERAGE_LABELS: Record<RtkCoverage, string> = {
  rewrite: 'Every command goes through RTK',
  instructions: 'Instructions only, not enforced'
}

const SWITCH_ID = 'rtk-enabled'

/**
 * The RTK preference and what it does right now. `setupOpen` is the setup
 * dialog's state: RTK can be installed there, so closing it reloads this row.
 */
export function RtkSetting({ setupOpen }: { setupOpen: boolean }) {
  const [enabled, setEnabled] = useState(true)
  const [preferenceLoaded, setPreferenceLoaded] = useState(false)
  const [detection, setDetection] = useState<Record<string, ToolStatus> | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [saving, setSaving] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (setupOpen) return
    let active = true
    setDetecting(true)
    void Promise.allSettled([settingsApi.get(RTK_ENABLED_SETTING), desktopApi.agentInstaller.detect()]).then(([preference, tools]) => {
      if (!active) return
      setPreferenceLoaded(preference.status === 'fulfilled')
      if (preference.status === 'fulfilled') setEnabled(isRtkEnabled(preference.value))
      setDetection(tools.status === 'fulfilled' ? tools.value as Record<string, ToolStatus> : null)
      setError(preference.status === 'rejected' ? 'The RTK preference could not be loaded.' : null)
      setDetecting(false)
    })
    return () => { active = false }
  }, [setupOpen])

  const handleToggle = async (checked: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await settingsApi.set(RTK_ENABLED_SETTING, String(checked))
      setEnabled(checked)
    } catch {
      setError('The RTK preference could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const handleInstall = async () => {
    setInstalling(true)
    setError(null)
    try {
      const result = await desktopApi.agentInstaller.install('rtk') as {
        success: boolean
        error: string | null
        newStatus?: Record<string, ToolStatus>
      }
      if (result?.newStatus) setDetection(result.newStatus)
      if (!result?.success) setError(result?.error || 'RTK could not be installed.')
    } catch {
      setError('RTK could not be installed.')
    } finally {
      setInstalling(false)
    }
  }

  const rtk = detection?.rtk
  const state = rtkEffectiveState(enabled, rtk)
  const coverage = detection ? rtkBackendCoverage(detection) : []
  const remainingHooks = detection ? rtkGlobalHooksAfterOptOut(detection, rtk) : []

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5" data-testid="rtk-setting">
      <div className="flex items-center gap-3">
        <Zap className="size-5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <Label htmlFor={SWITCH_ID}>RTK output compression</Label>
            {detecting ? (
              <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Checking RTK" />
            ) : detection || !enabled ? (
              <span className={`text-xs ${state === 'on' ? 'text-emerald-400' : 'text-muted-foreground'}`} data-testid="rtk-effective-state">
                {RTK_STATE_LABELS[state]}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Shortens noisy shell output in Captain and task agent sessions. Commands RTK has no filter for
            run unchanged. A change applies to new sessions.
          </p>
        </div>
        <Switch
          id={SWITCH_ID}
          checked={enabled}
          onCheckedChange={checked => void handleToggle(checked)}
          disabled={!preferenceLoaded || saving}
        />
      </div>

      {!detecting && !detection && (
        <p className="text-xs text-muted-foreground">Could not check whether RTK is installed.</p>
      )}

      {!detecting && state === 'unavailable' && detection && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            RTK is not installed, so commands run unchanged. Installing it also adds RTK&apos;s global
            hooks for your coding agents, which apply in your terminal too.
          </p>
          <Button size="sm" variant="outline" onClick={() => void handleInstall()} disabled={installing}>
            {installing ? <Loader2 className="size-3 animate-spin" /> : <><Download className="size-3 mr-1" />Install</>}
          </Button>
        </div>
      )}

      {state === 'on' && coverage.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground" data-testid="rtk-coverage">
          {coverage.map(backend => (
            <li key={backend.key}>{backend.label}: {COVERAGE_LABELS[backend.coverage]}</li>
          ))}
        </ul>
      )}

      {state === 'off' && remainingHooks.length > 0 && (
        <p className="text-xs text-amber-400" data-testid="rtk-global-hooks">
          A global RTK hook still rewrites commands for {remainingHooks.map(backend => backend.label).join(', ')}.
          21x cannot turn it off for a session. To remove it, run <code>rtk init -g --uninstall</code> in a
          terminal, which also removes it outside 21x.
        </p>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

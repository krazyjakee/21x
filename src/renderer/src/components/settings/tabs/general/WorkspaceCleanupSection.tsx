import { useState, useEffect } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { SettingsSection } from '../../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { Button } from '@/components/ui/Button'
import { settingsApi, worktreeApi, onWorkspaceCleanupProgress } from '@/lib/ipc-client'

/** Human-readable summary of a cleanup run, or null when there is nothing to report. */
function describeCleanupOutcome(cleaned: number | undefined, nodeModulesCleaned: number | undefined): string | null {
  const parts: string[] = []
  if (cleaned !== undefined && cleaned > 0) {
    parts.push(`Cleaned ${cleaned} workspace${cleaned !== 1 ? 's' : ''}`)
  }
  if (nodeModulesCleaned !== undefined && nodeModulesCleaned > 0) {
    parts.push(`pruned ${nodeModulesCleaned} idle node_modules`)
  }
  return parts.length > 0 ? parts.join(', ') : null
}

const SELECT_CLASS = 'bg-transparent border rounded px-2 py-1 text-sm disabled:opacity-50'

function DayOptions({ days }: { days: number[] }) {
  return (
    <>
      {days.map((d) => (
        <option key={d} value={String(d)}>{d} day{d !== 1 ? 's' : ''}</option>
      ))}
    </>
  )
}

export function WorkspaceCleanupSection() {
  const [loading, setLoading] = useState(true)
  const [autocleanEnabled, setAutocleanEnabled] = useState(false)
  const [autocleanDays, setAutocleanDays] = useState('7')
  const [nodeModulesGcEnabled, setNodeModulesGcEnabled] = useState(true)
  const [nodeModulesGcDays, setNodeModulesGcDays] = useState('7')
  const [cleanupRunning, setCleanupRunning] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<string | null>(null)
  const [cleanupProgress, setCleanupProgress] = useState<{ current: number; total: number; message?: string } | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const cleanupEnabled = await settingsApi.get('workspace_autocleanup_enabled')
        if (cleanupEnabled !== null) setAutocleanEnabled(cleanupEnabled === 'true')
        const cleanupDays = await settingsApi.get('workspace_autocleanup_days')
        if (cleanupDays) setAutocleanDays(cleanupDays)
        const nmGcEnabled = await settingsApi.get('workspace_nodemodules_gc_enabled')
        if (nmGcEnabled !== null) setNodeModulesGcEnabled(nmGcEnabled !== 'false')
        const nmGcDays = await settingsApi.get('workspace_nodemodules_gc_days')
        if (nmGcDays) setNodeModulesGcDays(nmGcDays)
      } catch (error) {
        console.error('Failed to load workspace cleanup settings:', error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    return onWorkspaceCleanupProgress((event) => {
      if (event.phase === 'done') {
        setCleanupRunning(false)
        setCleanupProgress(null)
        const summary = describeCleanupOutcome(event.cleaned, event.nodeModulesCleaned)
        if (summary) {
          setCleanupResult(summary)
        } else if (event.errors && event.errors.length > 0) {
          setCleanupResult(`Cleanup finished with ${event.errors.length} error${event.errors.length !== 1 ? 's' : ''}`)
        } else {
          setCleanupResult('No workspaces to clean')
        }
      } else {
        setCleanupRunning(true)
        setCleanupProgress({ current: event.current, total: event.total, message: event.message })
      }
    })
  }, [])

  const handleCleanNow = async () => {
    setCleanupRunning(true)
    setCleanupResult(null)
    setCleanupProgress(null)
    try {
      const result = await worktreeApi.runCleanupNow()
      // The progress listener normally settles the final state via the 'done'
      // event; the IPC response is a fallback for when no progress arrived.
      if (!cleanupProgress) {
        const summary = describeCleanupOutcome(result.cleaned, result.nodeModulesCleaned)
        if (summary) {
          setCleanupResult(summary)
        } else if (result.errors.length > 0 && result.errors[0] === 'Cleanup is already in progress') {
          setCleanupResult('Cleanup already in progress')
        } else {
          setCleanupResult('No workspaces to clean')
        }
        setCleanupRunning(false)
      }
    } catch (error) {
      setCleanupResult('Cleanup failed')
      setCleanupRunning(false)
      console.error('Workspace cleanup error:', error)
    }
  }

  return (
    <SettingsSection
      title="Workspace Auto-Cleanup"
      description="Automatically clean up workspace files for completed tasks after a configurable retention period"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="autoclean-enabled">Enable auto-cleanup</Label>
            <p className="text-xs text-muted-foreground">
              Automatically remove workspace files for tasks completed more than the configured number of days ago
            </p>
          </div>
          <Switch
            id="autoclean-enabled"
            checked={autocleanEnabled}
            onCheckedChange={async (checked) => {
              setAutocleanEnabled(checked)
              await settingsApi.set('workspace_autocleanup_enabled', checked ? 'true' : 'false')
            }}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="autoclean-days">Retention period</Label>
            <p className="text-xs text-muted-foreground">
              Days to keep workspace files after task completion
            </p>
          </div>
          <select
            id="autoclean-days"
            value={autocleanDays}
            onChange={async (e) => {
              setAutocleanDays(e.target.value)
              await settingsApi.set('workspace_autocleanup_days', e.target.value)
            }}
            disabled={loading || !autocleanEnabled}
            className={SELECT_CLASS}
          >
            <DayOptions days={[1, 3, 7, 14, 30, 60, 90]} />
          </select>
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="nodemodules-gc-enabled">Prune idle node_modules</Label>
            <p className="text-xs text-muted-foreground">
              Delete dependency folders untouched for more than the configured days, in every workspace.
              Source files are kept — dependencies reinstall on the next run.
            </p>
          </div>
          <Switch
            id="nodemodules-gc-enabled"
            checked={nodeModulesGcEnabled}
            onCheckedChange={async (checked) => {
              setNodeModulesGcEnabled(checked)
              await settingsApi.set('workspace_nodemodules_gc_enabled', checked ? 'true' : 'false')
            }}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="nodemodules-gc-days">Dependency inactivity period</Label>
            <p className="text-xs text-muted-foreground">
              Days without changes before a node_modules folder is pruned
            </p>
          </div>
          <select
            id="nodemodules-gc-days"
            value={nodeModulesGcDays}
            onChange={async (e) => {
              setNodeModulesGcDays(e.target.value)
              await settingsApi.set('workspace_nodemodules_gc_days', e.target.value)
            }}
            disabled={loading || !nodeModulesGcEnabled}
            className={SELECT_CLASS}
          >
            <DayOptions days={[1, 3, 7, 14, 30]} />
          </select>
        </div>

        <div className="py-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Manual cleanup</Label>
              <p className="text-xs text-muted-foreground">
                Run workspace cleanup and idle dependency pruning now
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!cleanupRunning && cleanupResult && (
                <span className="text-xs text-muted-foreground">{cleanupResult}</span>
              )}
              <Button variant="outline" size="sm" disabled={cleanupRunning} onClick={handleCleanNow}>
                {cleanupRunning ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5 mr-1.5" />
                )}
                {cleanupRunning ? 'Cleaning...' : 'Clean Now'}
              </Button>
            </div>
          </div>

          {cleanupRunning && cleanupProgress && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{cleanupProgress.message || 'Preparing...'}</span>
                {cleanupProgress.total > 0 && (
                  <span>{cleanupProgress.current}/{cleanupProgress.total}</span>
                )}
              </div>
              <div className="h-1.5 w-full bg-accent/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{
                    width: cleanupProgress.total > 0
                      ? `${Math.round((cleanupProgress.current / cleanupProgress.total) * 100)}%`
                      : '0%'
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}

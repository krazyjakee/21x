import { useState, useEffect } from 'react'
import { SettingsSection } from '../../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { settingsApi } from '@/lib/ipc-client'

const FIELD_CLASS = 'bg-transparent border rounded px-2 py-1 text-sm disabled:opacity-50'

export function HeartbeatSection() {
  const [loading, setLoading] = useState(true)
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(true)
  const [heartbeatInterval, setHeartbeatInterval] = useState('30')
  const [heartbeatActiveStart, setHeartbeatActiveStart] = useState('')
  const [heartbeatActiveEnd, setHeartbeatActiveEnd] = useState('')
  const [heartbeatGlobalInstructions, setHeartbeatGlobalInstructions] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const hbEnabled = await settingsApi.get('heartbeat_enabled_global')
        if (hbEnabled !== null) setHeartbeatEnabled(hbEnabled !== 'false')
        const hbInterval = await settingsApi.get('heartbeat_default_interval')
        if (hbInterval) setHeartbeatInterval(hbInterval)
        const hbStart = await settingsApi.get('heartbeat_active_hours_start')
        if (hbStart) setHeartbeatActiveStart(hbStart)
        const hbEnd = await settingsApi.get('heartbeat_active_hours_end')
        if (hbEnd) setHeartbeatActiveEnd(hbEnd)
        const hbGlobal = await settingsApi.get('heartbeat_global_instructions')
        if (hbGlobal) setHeartbeatGlobalInstructions(hbGlobal)
      } catch (error) {
        console.error('Failed to load heartbeat settings:', error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const fieldsDisabled = loading || !heartbeatEnabled

  return (
    <SettingsSection
      title="Heartbeat Monitoring"
      description="Periodic checks on tasks in review — monitors PRs, issues, and deployments"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="heartbeat-enabled">Enable heartbeat</Label>
            <p className="text-xs text-muted-foreground">
              Periodically check tasks with heartbeat.md files for updates
            </p>
          </div>
          <Switch
            id="heartbeat-enabled"
            checked={heartbeatEnabled}
            onCheckedChange={async (checked) => {
              setHeartbeatEnabled(checked)
              await settingsApi.set('heartbeat_enabled_global', checked ? 'true' : 'false')
            }}
            disabled={loading}
          />
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label htmlFor="heartbeat-interval">Default interval</Label>
            <p className="text-xs text-muted-foreground">
              How often to check each task (can be overridden per-task)
            </p>
          </div>
          <select
            id="heartbeat-interval"
            value={heartbeatInterval}
            onChange={async (e) => {
              setHeartbeatInterval(e.target.value)
              await settingsApi.set('heartbeat_default_interval', e.target.value)
            }}
            disabled={fieldsDisabled}
            className={FIELD_CLASS}
          >
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">4 hours</option>
          </select>
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border">
          <div className="space-y-0.5">
            <Label>Active hours</Label>
            <p className="text-xs text-muted-foreground">
              Only run heartbeat checks during these hours (leave empty for always)
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <input
              type="time"
              value={heartbeatActiveStart}
              onChange={async (e) => {
                setHeartbeatActiveStart(e.target.value)
                await settingsApi.set('heartbeat_active_hours_start', e.target.value)
              }}
              disabled={fieldsDisabled}
              className={FIELD_CLASS}
              placeholder="09:00"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="time"
              value={heartbeatActiveEnd}
              onChange={async (e) => {
                setHeartbeatActiveEnd(e.target.value)
                await settingsApi.set('heartbeat_active_hours_end', e.target.value)
              }}
              disabled={fieldsDisabled}
              className={FIELD_CLASS}
              placeholder="22:00"
            />
          </div>
        </div>

        <div className="py-2">
          <div className="space-y-1.5 mb-2">
            <Label htmlFor="heartbeat-global-instructions">Global instructions</Label>
            <p className="text-xs text-muted-foreground">
              Default instructions prepended to every heartbeat check. Per-task heartbeat.md takes priority.
            </p>
          </div>
          <textarea
            id="heartbeat-global-instructions"
            value={heartbeatGlobalInstructions}
            onChange={(e) => setHeartbeatGlobalInstructions(e.target.value)}
            onBlur={async () => {
              await settingsApi.set('heartbeat_global_instructions', heartbeatGlobalInstructions)
            }}
            disabled={fieldsDisabled}
            rows={6}
            className="w-full bg-transparent border rounded px-3 py-2 text-sm font-mono disabled:opacity-50 resize-y placeholder:text-muted-foreground"
            placeholder="e.g. Always run `gh api` calls to verify status. Never skip checks. Reply HEARTBEAT_OK only when everything is clean."
          />
        </div>
      </div>
    </SettingsSection>
  )
}

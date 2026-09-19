import { useEffect, useState } from 'react'
import { Switch } from '@/components/ui/Switch'
import { settingsApi } from '@/lib/ipc-client'
import {
  COMMANDER_BRIEFING_SETTING,
  DEFAULT_COMMANDER_BRIEFING,
  parseCommanderBriefingSettings,
  serializeCommanderBriefingSettings,
  type CommanderBriefingSettings as BriefingSettings
} from '@shared/scheduled-coordination'
import { SettingsSection } from './SettingsSection'
import { CronScheduleInput } from './CronScheduleInput'

/**
 * Settings → Projects → Commander briefing (#67). One app setting, JSON in
 * `commander_briefing`; the main process runs it on schedule, window open or
 * not, and leaves a new unread Commander session.
 */
export function CommanderBriefingSettings() {
  const [settings, setSettings] = useState<BriefingSettings>(DEFAULT_COMMANDER_BRIEFING)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    settingsApi
      .get(COMMANDER_BRIEFING_SETTING)
      .then((raw) => {
        if (cancelled) return
        setSettings(parseCommanderBriefingSettings(raw))
        setLoaded(true)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patch = (fields: Partial<BriefingSettings>) => {
    const next = { ...settings, ...fields }
    setSettings(next)
    setError(null)
    settingsApi.set(COMMANDER_BRIEFING_SETTING, serializeCommanderBriefingSettings(next)).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <SettingsSection
      title="Commander briefing"
      description="A scheduled summary across your projects, built from each project's status. It opens a new Commander session titled with the date, left unread, with a desktop notification. It runs with the window closed."
    >
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <div>
          <p className="text-sm font-medium">Scheduled briefing</p>
          <p className="text-xs text-muted-foreground">Off by default. When a chat model is configured, the Commander also adds a short spoken-style summary.</p>
        </div>
        <Switch
          checked={settings.enabled}
          disabled={!loaded}
          onCheckedChange={(checked) => patch({ enabled: checked })}
          aria-label="Scheduled Commander briefing"
        />
      </div>
      <div className={settings.enabled ? 'space-y-3' : 'space-y-3 opacity-50'}>
        <CronScheduleInput
          id="commander-briefing-cron"
          value={settings.cron}
          disabled={!loaded || !settings.enabled}
          onChange={(cron) => patch({ cron })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.speak}
            disabled={!loaded || !settings.enabled}
            onChange={(e) => patch({ speak: e.target.checked })}
            aria-label="Read the briefing aloud"
          />
          Read the briefing aloud when a window is open and spoken answers are set up (Settings → Voice)
        </label>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </SettingsSection>
  )
}

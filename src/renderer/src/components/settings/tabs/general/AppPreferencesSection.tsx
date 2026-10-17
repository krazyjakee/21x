import { captureDesktopRead, desktopApi, desktopSupports, getDesktopHost } from '@/lib/desktop-api'
import { useState, useEffect, useRef } from 'react'
import { SettingsSection } from '../../SettingsSection'
import { Label } from '@/components/ui/Label'
import { Switch } from '@/components/ui/Switch'
import { settingsApi } from '@/lib/ipc-client'
import { CAPTAIN_PREWARM_SETTING } from '@/components/orchestrator/OrchestratorPanel'

function PreferenceRow({ id, label, description, checked, onCheckedChange, disabled }: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled: boolean
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  )
}

export function AppPreferencesSection() {
  const [loading, setLoading] = useState(true)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [captainPrewarm, setCaptainPrewarm] = useState(true)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(false), changePending = useRef(false)

  useEffect(() => {
    mounted.current = true
    const host = getDesktopHost()
    let active = true, revision = 0, loaded = false
    let loadedGeneration: number | undefined
    const load = async () => {
      if (!active) return
      if (host.connection.status !== 'ready') {
        revision++; loaded = false; setLoading(true)
        return
      }
      if (loaded && loadedGeneration === host.connectionGeneration) return
      loaded = true; loadedGeneration = host.connectionGeneration
      const attempt = ++revision, scope = captureDesktopRead()
      setLoading(true); setPreferenceError(null)
      const results = await Promise.allSettled([
        desktopSupports('app.getLoginItemSettings') ? desktopApi.app.getLoginItemSettings() : Promise.resolve(undefined),
        desktopSupports('app.getNotificationPermission') ? desktopApi.app.getNotificationPermission() : Promise.resolve(undefined),
        desktopSupports('app.getMinimizeToTray') ? desktopApi.app.getMinimizeToTray() : Promise.resolve(undefined),
        settingsApi.get(CAPTAIN_PREWARM_SETTING)
      ])
      if (!active || attempt !== revision || !scope.isCurrent()) return
      const [login, notification, tray, warm] = results
      if (login.status === 'fulfilled' && login.value) setLaunchAtStartup(login.value.openAtLogin)
      if (notification.status === 'fulfilled' && notification.value !== undefined) setNotificationsEnabled(notification.value === 'granted')
      if (tray.status === 'fulfilled' && tray.value !== undefined) setMinimizeToTray(tray.value)
      if (warm.status === 'fulfilled') setCaptainPrewarm(warm.value !== 'false')
      setPreferenceError(results.some(result => result.status === 'rejected') ? 'Some preferences could not be loaded. Reconnect to try again.' : null)
      setLoading(false)
    }
    const cleanup = host.kind === 'tauri' ? host.subscribeConnection(() => { void load() }) : undefined
    void load()
    return () => { active = false; mounted.current = false; revision++; cleanup?.() }
  }, [])

  async function changePreference<T>(write: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    if (changePending.current) return
    const scope = captureDesktopRead()
    changePending.current = true; setSaving(true); setPreferenceError(null)
    try {
      scope.assertCurrent()
      const result = await write()
      if (mounted.current && scope.isCurrent()) apply(result)
    } catch {
      if (mounted.current && scope.isCurrent()) setPreferenceError('The preference could not be saved. Check its current value before trying again.')
    } finally {
      changePending.current = false
      if (mounted.current) setSaving(false)
    }
  }

  const handleLaunchAtStartupChange = async (checked: boolean) => {
    if (!desktopSupports('app.setLoginItemSettings')) return
    await changePreference(() => desktopApi.app.setLoginItemSettings(checked), result => setLaunchAtStartup(result.openAtLogin))
  }

  const handleCaptainPrewarmChange = async (checked: boolean): Promise<void> => {
    if (getDesktopHost().kind === 'tauri') return
    await changePreference(() => settingsApi.set(CAPTAIN_PREWARM_SETTING, checked ? 'true' : 'false'), () => setCaptainPrewarm(checked))
  }

  const handleNotificationsChange = async (checked: boolean) => {
    if (!desktopSupports('app.requestNotificationPermission')) return
    if (!checked) { setNotificationsEnabled(false); return }
    await changePreference(() => desktopApi.app.requestNotificationPermission(), permission => setNotificationsEnabled(permission === 'granted'))
  }

  const handleMinimizeToTrayChange = async (checked: boolean) => {
    if (!desktopSupports('app.setMinimizeToTray')) return
    await changePreference(() => desktopApi.app.setMinimizeToTray(checked), result => setMinimizeToTray(result))
  }

  return (
    <SettingsSection
      title="Application Preferences"
      description="Configure general application behavior and preferences"
    >
      <div className="space-y-4">
        {preferenceError && <p role="alert" className="text-sm text-destructive">{preferenceError}</p>}
        <PreferenceRow
          id="launch-startup"
          label="Launch at startup"
          description={desktopSupports('app.setLoginItemSettings') ? 'Automatically launch the app when you log in' : 'Launch at login is unavailable in this preview.'}
          checked={launchAtStartup}
          onCheckedChange={handleLaunchAtStartupChange}
          disabled={loading || saving || !desktopSupports('app.setLoginItemSettings')}
        />
        <PreferenceRow
          id="captain-prewarm"
          label="Start Captain at launch"
          description="Bring the agent up in the background so your first message does not wait for it. Costs one idle agent process. Applies at the next launch."
          checked={captainPrewarm}
          onCheckedChange={handleCaptainPrewarmChange}
          disabled={loading || saving || getDesktopHost().kind === 'tauri'}
        />
        <PreferenceRow
          id="enable-notifications"
          label="Enable notifications"
          description="Show desktop notifications for task updates"
          checked={notificationsEnabled}
          onCheckedChange={handleNotificationsChange}
          disabled={loading || saving || !desktopSupports('app.requestNotificationPermission')}
        />
        <PreferenceRow
          id="minimize-tray"
          label="Minimize to tray"
          description="Keep app running in system tray when closed"
          checked={minimizeToTray}
          onCheckedChange={handleMinimizeToTrayChange}
          disabled={loading || saving || !desktopSupports('app.setMinimizeToTray')}
        />
      </div>
    </SettingsSection>
  )
}

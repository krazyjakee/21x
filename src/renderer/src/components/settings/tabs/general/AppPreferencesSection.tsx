import { desktopApi, desktopSupports, getDesktopHost } from '@/lib/desktop-api'
import { useState, useEffect } from 'react'
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

  useEffect(() => {
    const load = async () => {
      try {
        const loginSettings = await desktopApi?.app?.getLoginItemSettings()
        if (loginSettings) setLaunchAtStartup(loginSettings.openAtLogin)
        const notifPerm = await desktopApi?.app?.getNotificationPermission()
        setNotificationsEnabled(notifPerm === 'granted')
        const tray = await desktopApi?.app?.getMinimizeToTray()
        setMinimizeToTray(tray || false)
      } catch (error) {
        console.error('Failed to load app preferences:', error)
      } finally {
        setLoading(false)
      }

      try {
        const warm = await settingsApi.get(CAPTAIN_PREWARM_SETTING)
        setCaptainPrewarm(warm !== 'false')
      } catch (error) {
        console.error('Failed to load the Captain warm-up setting:', error)
      }
    }
    load()
  }, [])

  const handleLaunchAtStartupChange = async (checked: boolean) => {
    try {
      await desktopApi?.app?.setLoginItemSettings(checked)
      setLaunchAtStartup(checked)
    } catch (error) {
      console.error('Failed to update launch at startup:', error)
    }
  }

  const handleCaptainPrewarmChange = async (checked: boolean): Promise<void> => {
    setCaptainPrewarm(checked)
    // Takes effect at the next launch: the session it governs is started once,
    // when the window opens.
    await settingsApi.set(CAPTAIN_PREWARM_SETTING, checked ? 'true' : 'false')
  }

  const handleNotificationsChange = async (checked: boolean) => {
    try {
      if (checked) {
        const permission = await desktopApi?.app?.requestNotificationPermission()
        setNotificationsEnabled(permission === 'granted')
      } else {
        setNotificationsEnabled(false)
      }
    } catch (error) {
      console.error('Failed to update notifications:', error)
    }
  }

  const handleMinimizeToTrayChange = async (checked: boolean) => {
    try {
      await desktopApi?.app?.setMinimizeToTray(checked)
      setMinimizeToTray(checked)
    } catch (error) {
      console.error('Failed to update minimize to tray:', error)
    }
  }

  return (
    <SettingsSection
      title="Application Preferences"
      description="Configure general application behavior and preferences"
    >
      <div className="space-y-4">
        {getDesktopHost().kind === 'tauri' && <p className="text-sm text-muted-foreground">These application preferences are unavailable in this preview.</p>}
        <PreferenceRow
          id="launch-startup"
          label="Launch at startup"
          description="Automatically launch the app when you log in"
          checked={launchAtStartup}
          onCheckedChange={handleLaunchAtStartupChange}
          disabled={loading || !desktopSupports('app.setLoginItemSettings')}
        />
        <PreferenceRow
          id="captain-prewarm"
          label="Start Captain at launch"
          description="Bring the agent up in the background so your first message does not wait for it. Costs one idle agent process. Applies at the next launch."
          checked={captainPrewarm}
          onCheckedChange={handleCaptainPrewarmChange}
          disabled={loading || getDesktopHost().kind === 'tauri'}
        />
        <PreferenceRow
          id="enable-notifications"
          label="Enable notifications"
          description="Show desktop notifications for task updates"
          checked={notificationsEnabled}
          onCheckedChange={handleNotificationsChange}
          disabled={loading || !desktopSupports('app.requestNotificationPermission')}
        />
        <PreferenceRow
          id="minimize-tray"
          label="Minimize to tray"
          description="Keep app running in system tray when closed"
          checked={minimizeToTray}
          onCheckedChange={handleMinimizeToTrayChange}
          disabled={loading || !desktopSupports('app.setMinimizeToTray')}
        />
      </div>
    </SettingsSection>
  )
}

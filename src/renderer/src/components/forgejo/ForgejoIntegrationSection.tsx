import { useCallback, useEffect, useState } from 'react'
import { CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { useSettingsStore } from '@/stores/settings-store'
import type { TeaCliStatus } from '@/types/electron'

/** Terminal commands that resolve each tea status. 20x never runs these or
 * handles Forgejo credentials — tea owns the logins and tokens. */
function remedyCommands(status: TeaCliStatus): string[] {
  switch (status.code) {
    case 'not-installed': return ['go install code.gitea.io/tea@latest', 'tea login add']
    case 'no-login': return ['tea login add']
    case 'unauthorized': return status.login ? [`tea login edit ${status.login}`] : ['tea login add']
    case 'unreachable': return ['tea login list']
    default: return []
  }
}

export function ForgejoIntegrationSection() {
  const teaCliStatus = useSettingsStore((s) => s.teaCliStatus)
  const checkTeaCli = useSettingsStore((s) => s.checkTeaCli)
  const setForgejoLogin = useSettingsStore((s) => s.setForgejoLogin)
  const [checking, setChecking] = useState(false)

  const recheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      await checkTeaCli()
    } finally {
      setChecking(false)
    }
  }, [checkTeaCli])

  useEffect(() => {
    void recheck()
  }, [recheck])

  const selectLogin = async (name: string): Promise<void> => {
    setChecking(true)
    try {
      await setForgejoLogin(name || null)
    } finally {
      setChecking(false)
    }
  }

  const logins = teaCliStatus?.logins ?? []
  const commands = teaCliStatus ? remedyCommands(teaCliStatus) : []
  // A stale selection must stay fixable even when only one login remains.
  const showLoginPicker = logins.length > 1 || teaCliStatus?.code === 'login-not-found'

  return (
    <SettingsSection
      title="Forgejo Integration"
      description="Uses your existing tea CLI logins for Forgejo repositories, issues, pull requests, and CI status. 20x never stores Forgejo credentials."
    >
      <div className="space-y-3">
        {showLoginPicker && (
          <div className="space-y-1">
            <label htmlFor="forgejo-login" className="text-xs font-medium text-muted-foreground">
              tea login
            </label>
            <Select
              id="forgejo-login"
              value={teaCliStatus?.login ?? ''}
              disabled={checking}
              onChange={(e) => void selectLogin(e.target.value)}
              options={[
                ...(teaCliStatus?.login ? [] : [{ value: '', label: 'Choose a login…' }]),
                ...logins.map((login) => ({
                  value: login.name,
                  label: `${login.name} — ${login.user ? `${login.user}@` : ''}${login.url}${login.isDefault ? ' (tea default)' : ''}`
                }))
              ]}
            />
          </div>
        )}

        <div className="flex items-start gap-2 text-xs">
          {!teaCliStatus || checking ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking tea CLI…
            </span>
          ) : teaCliStatus.authenticated ? (
            <span className="flex items-center gap-1.5 text-foreground">
              <CheckCircle className="h-3.5 w-3.5 text-primary" />
              Using tea login “{teaCliStatus.login}”{teaCliStatus.username ? ` as ${teaCliStatus.username}` : ''} on {teaCliStatus.serverUrl}
            </span>
          ) : (
            <div className="flex-1 space-y-2">
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
                <span>{teaCliStatus.message || 'tea is not ready.'}</span>
              </p>
              {commands.map((cmd) => (
                <code key={cmd} className="block bg-muted px-3 py-2 rounded select-all">{cmd}</code>
              ))}
              <Button size="sm" variant="outline" onClick={() => void recheck()}>
                Re-check
              </Button>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}

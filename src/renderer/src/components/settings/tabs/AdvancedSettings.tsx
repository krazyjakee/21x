import { useState, useEffect } from 'react'
import { CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { SettingsSection } from '../SettingsSection'
import { useSettingsStore } from '@/stores/settings-store'
import { settingsApi } from '@/lib/ipc-client'
import { GhCliGuidance } from '@/components/github/GhCliGuidance'
import { ForgejoIntegrationSection } from '@/components/forgejo/ForgejoIntegrationSection'

/** Global cap on concurrently working agent sessions, enforced by the main process. Empty/0 = unlimited. */
const MAX_CONCURRENT_AGENT_SESSIONS_SETTING = 'max_concurrent_agent_sessions'

export function AdvancedSettings() {
  const { githubOrg, ghCliStatus, setGithubOrg, checkGhCli } = useSettingsStore()
  const [orgInput, setOrgInput] = useState(githubOrg || '')

  // API Keys — the main process only tells us whether a key is saved, never its value.
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({})

  useEffect(() => {
    checkGhCli()
    if (githubOrg) setOrgInput(githubOrg)

    const loadKeys = async () => {
      const keys = await settingsApi.getAll()
      setSavedKeys({
        anthropic_api_key: !!keys.anthropic_api_key,
        openai_api_key: !!keys.openai_api_key,
        google_api_key: !!keys.google_api_key
      })
    }
    loadKeys()
  }, [githubOrg])

  const saveApiKey = async (key: string, value: string) => {
    await settingsApi.set(key, value.trim())
    setSavedKeys((prev) => ({ ...prev, [key]: !!value.trim() }))
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="GitHub Integration"
        description="Uses your existing GitHub CLI (gh) sign-in for repository operations and worktree management"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            {ghCliStatus?.authenticated ? (
              <span className="flex items-center gap-1.5 text-foreground">
                <CheckCircle className="h-3.5 w-3.5 text-primary" />
                Using gh CLI{ghCliStatus.username ? ` as ${ghCliStatus.username}` : ''}
              </span>
            ) : (
              <div className="flex-1 space-y-2">
                <GhCliGuidance status={ghCliStatus} />
                <Button size="sm" variant="outline" onClick={() => checkGhCli()}>
                  Re-check
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              placeholder="GitHub org name"
              className="flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!orgInput.trim() || orgInput.trim() === githubOrg}
              onClick={() => setGithubOrg(orgInput.trim())}
            >
              Save
            </Button>
          </div>
        </div>
      </SettingsSection>

      <ForgejoIntegrationSection />

      <AgentConcurrencySection />

      <SettingsSection
        title="API Keys"
        description="Configure API keys for AI providers (stored securely locally)"
      >
        <div className="space-y-4">
          <ApiKeyField
            id="anthropic-key"
            label="Anthropic API Key"
            placeholder="sk-ant-..."
            hint="Used by Claude Code agents"
            saved={!!savedKeys.anthropic_api_key}
            onSave={(value) => saveApiKey('anthropic_api_key', value)}
          />

          <ApiKeyField
            id="openai-key"
            label="OpenAI API Key"
            placeholder="sk-..."
            hint="Used by Codex agents"
            saved={!!savedKeys.openai_api_key}
            onSave={(value) => saveApiKey('openai_api_key', value)}
          />

          <ApiKeyField
            id="google-key"
            label="Google API Key"
            placeholder="AI..."
            hint="For Gemini models (future support)"
            saved={!!savedKeys.google_api_key}
            onSave={(value) => saveApiKey('google_api_key', value)}
          />
        </div>
      </SettingsSection>
    </div>
  )
}

/**
 * Starts over this cap (or over an agent's own "max parallel sessions") wait
 * in a queue and start on their own when a running session finishes.
 * Mastermind, heartbeat and triage sessions are not counted.
 */
function AgentConcurrencySection() {
  const [saved, setSaved] = useState('')
  const [value, setValue] = useState('')

  useEffect(() => {
    settingsApi.get(MAX_CONCURRENT_AGENT_SESSIONS_SETTING).then((stored) => {
      const normalized = stored && parseInt(stored, 10) > 0 ? String(parseInt(stored, 10)) : ''
      setSaved(normalized)
      setValue(normalized)
    })
  }, [])

  const normalizedInput = value.trim() && parseInt(value, 10) > 0 ? String(parseInt(value, 10)) : ''

  const save = async () => {
    await settingsApi.set(MAX_CONCURRENT_AGENT_SESSIONS_SETTING, normalizedInput)
    setSaved(normalizedInput)
    setValue(normalizedInput)
  }

  return (
    <SettingsSection
      title="Agent Concurrency"
      description="Maximum agent sessions working at once across all agents. Extra starts are queued and run when a slot frees. Leave empty for no global limit; each agent's own limit still applies. The Mastermind, heartbeat checks and triage are not counted."
    >
      <div className="space-y-1.5">
        <Label htmlFor="max-concurrent-agent-sessions">Max concurrent agent sessions</Label>
        <div className="flex items-center gap-2">
          <Input
            id="max-concurrent-agent-sessions"
            type="number"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Unlimited"
            className="flex-1"
          />
          <Button size="sm" variant="outline" disabled={normalizedInput === saved} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}

interface ApiKeyFieldProps {
  id: string
  label: string
  placeholder: string
  hint: string
  saved: boolean
  onSave: (value: string) => Promise<void>
}

/**
 * Saved keys are never sent back to the renderer, so the input stays empty and
 * only reports whether a key is stored. Typing a new value replaces it.
 */
function ApiKeyField({ id, label, placeholder, hint, saved, onSave }: ApiKeyFieldProps) {
  const [value, setValue] = useState('')

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={saved ? '•••••••• (saved)' : placeholder}
          className="flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!value.trim()}
          onClick={async () => {
            await onSave(value)
            setValue('')
          }}
        >
          Save
        </Button>
        {saved && (
          <Button size="sm" variant="ghost" onClick={() => onSave('')}>
            Clear
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

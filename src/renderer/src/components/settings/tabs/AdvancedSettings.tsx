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

export function AdvancedSettings() {
  const { githubOrg, ghCliStatus, setGithubOrg, checkGhCli } = useSettingsStore()
  const [orgInput, setOrgInput] = useState(githubOrg || '')

  // API Keys
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey, setOpenaiKey] = useState('')
  const [googleKey, setGoogleKey] = useState('')

  useEffect(() => {
    checkGhCli()
    if (githubOrg) setOrgInput(githubOrg)

    // Load API keys
    const loadKeys = async () => {
      const keys = await settingsApi.getAll()
      setAnthropicKey(keys.anthropic_api_key || '')
      setOpenaiKey(keys.openai_api_key || '')
      setGoogleKey(keys.google_api_key || '')
    }
    loadKeys()
  }, [githubOrg])

  const saveApiKey = async (key: string, value: string) => {
    if (value.trim()) {
      await settingsApi.set(key, value.trim())
    } else {
      // Optionally delete the key if empty
      await settingsApi.set(key, '')
    }
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

      <SettingsSection
        title="API Keys"
        description="Configure API keys for AI providers (stored securely locally)"
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="anthropic-key">Anthropic API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="anthropic-key"
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-..."
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveApiKey('anthropic_api_key', anthropicKey)}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Used by Claude Code agents
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="openai-key">OpenAI API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="openai-key"
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-..."
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveApiKey('openai_api_key', openaiKey)}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Used by Codex agents
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="google-key">Google API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                id="google-key"
                type="password"
                value={googleKey}
                onChange={(e) => setGoogleKey(e.target.value)}
                placeholder="AI..."
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveApiKey('google_api_key', googleKey)}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              For Gemini models (future support)
            </p>
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}

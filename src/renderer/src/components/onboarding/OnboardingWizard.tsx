import React, { useEffect, useState, useCallback } from 'react'
import {
  Check,
  Loader2,
  AlertTriangle,
  ArrowRight,
  Download,
  Sparkles
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogDescription
} from '@/components/ui/Dialog'
import { useAgentStore } from '@/stores/agent-store'
import { useSettingsStore, type GitProvider } from '@/stores/settings-store'
import { CodingAgentType, CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS } from '@/types'
import { VoiceRuntimeRow } from '@/components/voice/VoiceRuntimeRow'
import { agentConfigApi } from '@/lib/ipc-client'
import { AnthropicLogo, OpenCodeLogo, OpenAILogo, PiLogo } from '@/components/icons/AgentLogos'
import type { ToolStatus } from '@/types/electron'

/* ─── Enums & Constants ─── */

enum DetectKey {
  CLAUDE_CODE = 'claudeCode',
  OPENCODE = 'opencode',
  CODEX = 'codex',
  CURSOR = 'cursor',
  PI = 'pi',
  GH = 'gh',
  GLAB = 'glab'
}

enum ProviderChoiceValue {
  NONE = 'none'
}

const STORAGE_KEYS = {
  DEBUG_ONBOARDING: 'debug:onboarding',
  FORCE_ONBOARDING: 'force-onboarding'
} as const

const DEFAULT_AGENT_NAME = 'Robo'

/* ─── Force-onboarding flag ─── */

export function isForceOnboarding(): boolean {
  return (
    localStorage.getItem(STORAGE_KEYS.DEBUG_ONBOARDING) === 'true' ||
    localStorage.getItem(STORAGE_KEYS.FORCE_ONBOARDING) === 'true'
  )
}

/** Compare major.minor only — don't re-open for patch bumps */
export function shouldShowOnboarding(
  completedVersion: string | null | undefined,
  currentVersion: string
): boolean {
  if (isForceOnboarding()) return true
  if (!completedVersion) return true
  const [cMaj, cMin] = currentVersion.split('.').map(Number)
  const [sMaj, sMin] = completedVersion.split('.').map(Number)
  return cMaj !== sMaj || cMin !== sMin
}

/* ─── Agent card metadata ─── */

interface AgentOption {
  type: CodingAgentType
  label: string
  tagline: string
  Logo: React.ComponentType<{ className?: string }>
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    type: CodingAgentType.CLAUDE_CODE,
    label: 'Claude Code',
    tagline: 'Anthropic',
    Logo: AnthropicLogo
  },
  {
    type: CodingAgentType.OPENCODE,
    label: 'OpenCode',
    tagline: 'Open-source, free models',
    Logo: OpenCodeLogo
  },
  {
    type: CodingAgentType.CODEX,
    label: 'Codex',
    tagline: 'OpenAI',
    Logo: OpenAILogo
  },
  {
    type: CodingAgentType.PI,
    label: 'Pi',
    tagline: 'Open-source coding agent',
    Logo: PiLogo
  }
]

/* ─── Tool status helpers ─── */

function getAgentToolKey(type: CodingAgentType): DetectKey {
  switch (type) {
    case CodingAgentType.CLAUDE_CODE:
      return DetectKey.CLAUDE_CODE
    case CodingAgentType.OPENCODE:
      return DetectKey.OPENCODE
    case CodingAgentType.CODEX:
      return DetectKey.CODEX
    case CodingAgentType.CURSOR:
      return DetectKey.CURSOR
    case CodingAgentType.PI:
      return DetectKey.PI
  }
}

/* ─── Auto-select best default model ─── */

/** Pick first model from a provider's model list (array or object). */
function pickFirstModel(
  providerId: string,
  models: unknown
): string | null {
  if (Array.isArray(models)) {
    for (const m of models as { id?: string; name?: string }[]) {
      if (m?.id) return `${providerId}/${m.id}`
    }
  } else if (models && typeof models === 'object') {
    for (const [key, m] of Object.entries(models as Record<string, { id?: string }>)) {
      const modelId = m?.id || key
      if (modelId) return `${providerId}/${modelId}`
    }
  }
  return null
}

/** Pick first "free" model from a provider's model list. */
function pickFreeModel(
  providerId: string,
  models: unknown
): string | null {
  if (!Array.isArray(models)) return null
  for (const m of models as { id?: string; name?: string }[]) {
    if (m?.id && (m.name || '').toLowerCase().includes('free')) {
      return `${providerId}/${m.id}`
    }
  }
  return null
}

async function getDefaultModel(type: CodingAgentType): Promise<string> {
  if (type === CodingAgentType.CLAUDE_CODE) {
    return CLAUDE_MODELS[0]?.id || ''
  }
  if (type === CodingAgentType.CODEX) {
    return CODEX_MODELS[0]?.id || ''
  }
  if (type === CodingAgentType.CURSOR) {
    return CURSOR_MODELS[0]?.id || ''
  }
  // OpenCode and Pi — use the providers the local agent is configured with.
  try {
    const result = await agentConfigApi.getProviders(undefined, type)
    if (result?.providers) {
      const providers = Array.isArray(result.providers) ? result.providers : []

      // 1. Prefer the first free model from any provider
      for (const p of providers) {
        const free = pickFreeModel(p.id, p.models)
        if (free) return free
      }

      // 2. Fall back to first model from first provider
      for (const p of providers) {
        const first = pickFirstModel(p.id, p.models)
        if (first) return first
      }
    }
  } catch {
    // Silently fail — user can configure model later in settings
  }
  return ''
}

/* ─── Helpers ─── */

function hasCompleteDefaultAgent(): boolean {
  const agents = useAgentStore.getState().agents
  return agents.some((a) => a.is_default && !!a.config.coding_agent && !!a.config.model)
}

/* ─── Git Provider Choice (inline, optional) ─── */

type ProviderChoice = GitProvider | ProviderChoiceValue.NONE

interface GitProviderOption {
  value: ProviderChoice
  label: string
  cliKey: DetectKey
  cliName: string
}

const GIT_PROVIDER_OPTIONS: GitProviderOption[] = [
  { value: 'github', label: 'GitHub', cliKey: DetectKey.GH, cliName: 'gh' },
  { value: 'gitlab', label: 'GitLab', cliKey: DetectKey.GLAB, cliName: 'glab' }
]

function GitProviderRow({
  selected,
  onSelect,
  toolStatus
}: {
  selected: ProviderChoice | null
  onSelect: (p: ProviderChoice) => void
  toolStatus: Record<string, ToolStatus> | null
}) {

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">
        Where are your repos? <span className="opacity-60">(optional)</span>
      </p>
      <div className="flex gap-2">
        {GIT_PROVIDER_OPTIONS.map((opt) => {
          const cli = toolStatus?.[opt.cliKey]
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect(selected === opt.value ? ProviderChoiceValue.NONE : opt.value)}
              className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                selected === opt.value
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/40'
              }`}
            >
              {opt.label}
              {selected === opt.value && <Check className="inline size-3" />}
              {toolStatus && cli?.installed && (
                <span className="text-emerald-400 text-[10px] font-normal flex items-center gap-0.5">
                  <Check className="size-2.5" />
                  {opt.cliName}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Main OnboardingWizard ─── */

interface OnboardingWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OnboardingWizard({ open, onOpenChange }: OnboardingWizardProps) {
  const [selectedAgent, setSelectedAgent] = useState<CodingAgentType | null>(null)
  const [providerChoice, setProviderChoice] = useState<ProviderChoice | null>(null)
  const [toolStatus, setToolStatus] = useState<Record<string, ToolStatus> | null>(null)
  const [creating, setCreating] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { fetchAgents, agents, createAgent, updateAgent } = useAgentStore()
  const { fetchSettings, setGitProvider } = useSettingsStore()

  // Initialize state on open
  useEffect(() => {
    if (!open) return
    setError(null)

    Promise.all([fetchAgents(), fetchSettings()]).then(() => {
      // Pre-select agent if one is already configured
      const existing = useAgentStore.getState().agents.find(
        (a) => a.is_default && a.config.coding_agent
      )
      if (existing?.config.coding_agent) {
        setSelectedAgent(existing.config.coding_agent as CodingAgentType)
      }
      // Restore git provider choice
      const gp = useSettingsStore.getState().gitProvider
      if (gp) setProviderChoice(gp)
    })

    // Detect tools in background
    window.electronAPI.agentInstaller
      .detect()
      .then(setToolStatus)
      .catch(() => {})
  }, [open, fetchAgents, fetchSettings])

  // Listen for install progress events
  useEffect(() => {
    if (!open) return
    const cleanup = window.electronAPI.agentInstaller.onProgress(
      (data: { stage: string }) => {
        if (data.stage === 'complete' || data.stage === 'error') {
          setInstalling(null)
          window.electronAPI.agentInstaller
            .detect()
            .then(setToolStatus)
            .catch(() => {})
        }
      }
    )
    return cleanup
  }, [open])

  const handleInstall = useCallback(async (toolKey: string) => {
    setError(null)
    setInstalling(toolKey)
    try {
      const result = (await window.electronAPI.agentInstaller.install(toolKey)) as {
        success: boolean
        error: string | null
        newStatus: Record<string, ToolStatus>
      }
      if (result?.newStatus) {
        setToolStatus(result.newStatus)
      } else {
        const fresh = await window.electronAPI.agentInstaller.detect()
        setToolStatus(fresh)
      }
      if (!result?.success) {
        setError(result?.error || 'Installation failed. Try again or install the agent manually.')
        return false
      }
      const status = result.newStatus?.[toolKey]
      if (!status?.installed || status.supported === false) {
        setError(status?.reason || 'The agent executable is not ready after installation.')
        return false
      }
      return true
    } catch {
      const fresh = await window.electronAPI.agentInstaller.detect()
      setToolStatus(fresh)
      setError('Installation failed. Try again or install the agent manually.')
      return false
    } finally {
      setInstalling(null)
    }
  }, [])

  const handleProviderSelect = useCallback(
    async (p: ProviderChoice) => {
      setProviderChoice(p)
      await setGitProvider(p === ProviderChoiceValue.NONE ? null : p)
    },
    [setGitProvider]
  )

  const createDefaultAgent = useCallback(
    async (agentType: CodingAgentType) => {
      const model = await getDefaultModel(agentType)

      const existingDefault = agents.find(
        (a) => a.is_default && (!a.config.coding_agent || !a.config.model)
      )

      if (existingDefault) {
        await updateAgent(existingDefault.id, {
          name: existingDefault.name || DEFAULT_AGENT_NAME,
          config: {
            ...existingDefault.config,
            coding_agent: agentType,
            model: model || undefined
          }
        })
      } else if (!hasCompleteDefaultAgent()) {
        await createAgent({
          name: DEFAULT_AGENT_NAME,
          config: {
            coding_agent: agentType,
            model: model || undefined
          },
          is_default: true
        })
      }
    },
    [agents, createAgent, updateAgent]
  )

  const handleStart = async () => {
    if (!selectedAgent) return
    setError(null)

    // Install or update the selected runtime before creating
    // an agent that depends on it.
    setCreating(true)
    try {
      const toolKey = getAgentToolKey(selectedAgent)
      const status = toolStatus?.[toolKey]
      if (status && (!status.installed || status.supported === false)) {
        const ready = await handleInstall(toolKey)
        if (!ready) return
      }
      await createDefaultAgent(selectedAgent)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up agent. You can configure it later in Settings.')
    } finally {
      setCreating(false)
    }
  }

  const handleSkip = () => {
    onOpenChange(false)
  }

  // Compute tool health for the selected agent
  const selectedAgentStatus =
    selectedAgent && toolStatus
      ? toolStatus[getAgentToolKey(selectedAgent)]
      : null
  const agentReady = selectedAgentStatus
    ? selectedAgentStatus.installed && selectedAgentStatus.supported !== false
    : null

  /* ─── Render ─── */

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleSkip()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Welcome to 20x</DialogTitle>
          <DialogDescription>
            Get 20x more done with AI agents
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {/* ── Agent options ── */}
          <div>
            <p className="text-xs text-muted-foreground mb-2">
              Choose your agent:
            </p>
            <div className="grid grid-cols-4 gap-2.5">
              {AGENT_OPTIONS.map((agent) => {
                const isSelected = selectedAgent === agent.type
                const toolKey = getAgentToolKey(agent.type)
                const detected = toolStatus?.[toolKey]
                const isInstalled = detected?.installed === true
                const isReady = isInstalled && detected.supported !== false
                return (
                  <button
                    key={agent.type}
                    type="button"
                    onClick={() => setSelectedAgent(agent.type)}
                    className={`group relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all cursor-pointer ${
                      isSelected
                        ? 'border-primary bg-primary/5 shadow-md'
                        : 'border-border hover:border-muted-foreground/40 hover:bg-muted/20'
                    }`}
                  >
                    <agent.Logo
                      className={`size-9 transition-transform ${
                        isSelected ? 'scale-110' : 'group-hover:scale-105'
                      }`}
                    />
                    <div className="text-center">
                      <p className="text-xs font-semibold text-foreground leading-tight">
                        {agent.label}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {agent.tagline}
                      </p>
                    </div>
                    {/* Detected status */}
                    {toolStatus && (
                      <span className={`text-[10px] flex items-center gap-0.5 ${
                        isReady ? 'text-emerald-400' : detected?.supported === false ? 'text-amber-400' : 'text-muted-foreground/50'
                      }`}>
                        {isReady ? (
                          <>
                            <Check className="size-2.5" />
                            {detected?.version ? `v${detected.version}` : 'Installed'}
                          </>
                        ) : isInstalled ? (
                          'Update required'
                        ) : (
                          'Not installed'
                        )}
                      </span>
                    )}
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5">
                        <Check className="size-3.5 text-primary" />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Git provider (optional) ── */}
          {selectedAgent && (
            <GitProviderRow
              selected={providerChoice}
              onSelect={handleProviderSelect}
              toolStatus={toolStatus}
            />
          )}

          {/* ── Voice control (optional extra download) ── */}
          <VoiceRuntimeRow variant="compact" />

          {/* ── Install prompt (only when selected agent is not installed) ── */}
          {toolStatus && selectedAgent && agentReady === false && (
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-muted/20 text-xs">
              <AlertTriangle className="size-4 text-amber-400 shrink-0" />
              <span className="text-muted-foreground flex-1">
                {selectedAgentStatus?.reason || `${AGENT_OPTIONS.find((a) => a.type === selectedAgent)?.label} will be installed automatically`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px]"
                disabled={!!installing}
                onClick={() => handleInstall(getAgentToolKey(selectedAgent))}
              >
                {installing === getAgentToolKey(selectedAgent) ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <>
                    <Download className="size-2.5 mr-0.5" />
                    Install now
                  </>
                )}
              </Button>
            </div>
          )}

          {/* ── Error ── */}
          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* ── Actions ── */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleStart}
              disabled={!selectedAgent || creating}
              className="flex-1"
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin mr-1.5" />
              ) : (
                <Sparkles className="size-4 mr-1.5" />
              )}
              {agentReady === false ? 'Install & Get Started' : 'Get Started'}
              {!creating && <ArrowRight className="size-4 ml-1.5" />}
            </Button>
            <Button
              variant="ghost"
              onClick={handleSkip}
              className="text-muted-foreground"
            >
              Skip
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

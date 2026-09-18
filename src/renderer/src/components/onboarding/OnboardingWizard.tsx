import React, { useEffect, useState, useCallback } from 'react'
import {
  Check,
  Loader2,
  AlertTriangle,
  ArrowRight,
  Download,
  Info,
  MousePointer2,
  RefreshCw,
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
  GLAB = 'glab',
  TEA = 'tea'
}

enum ProviderChoiceValue {
  NONE = 'none'
}

const STORAGE_KEYS = {
  DEBUG_ONBOARDING: 'debug:onboarding',
  FORCE_ONBOARDING: 'force-onboarding'
} as const

const DEFAULT_AGENT_NAME = 'Robo'

/** Backend used for the default agent when nothing is installed yet. */
export const FALLBACK_BACKEND = CodingAgentType.OPENCODE

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
  /** Whether the in-app installer can install this backend. */
  installable: boolean
  /** Shown instead of an Install button when the backend is not installable here. */
  setupHint?: string
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    type: CodingAgentType.CLAUDE_CODE,
    label: 'Claude Code',
    tagline: 'Anthropic',
    Logo: AnthropicLogo,
    installable: true
  },
  {
    type: CodingAgentType.OPENCODE,
    label: 'OpenCode',
    tagline: 'Open-source, free models',
    Logo: OpenCodeLogo,
    installable: true
  },
  {
    type: CodingAgentType.CODEX,
    label: 'Codex',
    tagline: 'OpenAI',
    Logo: OpenAILogo,
    installable: true
  },
  {
    type: CodingAgentType.CURSOR,
    label: 'Cursor',
    tagline: 'cursor-agent CLI',
    Logo: MousePointer2,
    installable: false,
    setupHint: 'Install from cursor.com'
  },
  {
    type: CodingAgentType.PI,
    label: 'Pi',
    tagline: 'Open-source coding agent',
    Logo: PiLogo,
    installable: true
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

/** Installed and not flagged unsupported. */
function isBackendReady(status: ToolStatus | undefined): boolean {
  return !!status && status.installed && status.supported !== false
}

/**
 * Every detected backend, in card order. Installation alone determines
 * availability — there is no single-selection gate.
 */
export function getAvailableBackends(
  toolStatus: Record<string, ToolStatus> | null
): CodingAgentType[] {
  if (!toolStatus) return []
  return AGENT_OPTIONS
    .map((a) => a.type)
    .filter((type) => isBackendReady(toolStatus[getAgentToolKey(type)]))
}

/**
 * Backend for the default agent: the user's explicit (optional) choice,
 * else the first detected backend, else OpenCode.
 */
export function resolveDefaultBackend(
  toolStatus: Record<string, ToolStatus> | null,
  preferred: CodingAgentType | null
): CodingAgentType {
  if (preferred) return preferred
  return getAvailableBackends(toolStatus)[0] ?? FALLBACK_BACKEND
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
export function pickFreeModel(
  providerId: string,
  models: unknown
): string | null {
  const candidates = Array.isArray(models)
    ? (models as { id?: string; name?: string }[]).map((model) => ({
        id: model?.id,
        name: model?.name
      }))
    : models && typeof models === 'object'
      ? Object.entries(models as Record<string, { id?: string; name?: string }>).map(
          ([key, model]) => ({
            id: model?.id || key,
            name: model?.name
          })
        )
      : []

  for (const model of candidates) {
    if (
      model.id &&
      `${model.id} ${model.name || ''}`.toLowerCase().includes('free')
    ) {
      return `${providerId}/${model.id}`
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
  { value: 'gitlab', label: 'GitLab', cliKey: DetectKey.GLAB, cliName: 'glab' },
  { value: 'forgejo', label: 'Forgejo', cliKey: DetectKey.TEA, cliName: 'tea' }
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
              className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
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

/* ─── Default backend (separate, optional) ─── */

function DefaultBackendRow({
  toolStatus,
  preferred,
  onSelect
}: {
  toolStatus: Record<string, ToolStatus> | null
  preferred: CodingAgentType | null
  onSelect: (type: CodingAgentType | null) => void
}) {
  const effective = resolveDefaultBackend(toolStatus, preferred)
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">
        Default backend for new agents{' '}
        <span className="opacity-60">(optional — uses the first installed one)</span>
      </p>
      <div className="flex gap-2 flex-wrap" role="group" aria-label="Default backend">
        {AGENT_OPTIONS.map((agent) => {
          const active = effective === agent.type
          const ready = isBackendReady(toolStatus?.[getAgentToolKey(agent.type)])
          return (
            <button
              key={agent.type}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(preferred === agent.type ? null : agent.type)}
              className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                active
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/40'
              } ${!ready ? 'opacity-70' : ''}`}
            >
              {agent.label}
              {active && <Check className="inline size-3" />}
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
  const [preferredBackend, setPreferredBackend] = useState<CodingAgentType | null>(null)
  const [providerChoice, setProviderChoice] = useState<ProviderChoice | null>(null)
  const [toolStatus, setToolStatus] = useState<Record<string, ToolStatus> | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { fetchAgents, agents, createAgent, updateAgent } = useAgentStore()
  const { fetchSettings, setGitProvider } = useSettingsStore()

  /** Re-probe every backend; reflects installs/removals since the last run. */
  const runDetection = useCallback(async () => {
    setDetecting(true)
    try {
      const fresh = await window.electronAPI.agentInstaller.detect()
      setToolStatus(fresh)
      return fresh
    } catch {
      return null
    } finally {
      setDetecting(false)
    }
  }, [])

  // Initialize state on open
  useEffect(() => {
    if (!open) return
    setError(null)

    Promise.all([fetchAgents(), fetchSettings()]).then(() => {
      // Restore an explicit default backend if one is already configured
      const existing = useAgentStore.getState().agents.find(
        (a) => a.is_default && a.config.coding_agent
      )
      if (existing?.config.coding_agent) {
        setPreferredBackend(existing.config.coding_agent as CodingAgentType)
      }
      // Restore git provider choice
      const gp = useSettingsStore.getState().gitProvider
      if (gp) setProviderChoice(gp)
    })

    // Detect tools in background
    void runDetection()
  }, [open, fetchAgents, fetchSettings, runDetection])

  // Listen for install progress events
  useEffect(() => {
    if (!open) return
    const cleanup = window.electronAPI.agentInstaller.onProgress(
      (data: { stage: string }) => {
        if (data.stage === 'complete' || data.stage === 'error') {
          setInstalling(null)
          void runDetection()
        }
      }
    )
    return cleanup
  }, [open, runDetection])

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
        await runDetection()
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
      await runDetection()
      setError('Installation failed. Try again or install the agent manually.')
      return false
    } finally {
      setInstalling(null)
    }
  }, [runDetection])

  const handleProviderSelect = useCallback(
    async (p: ProviderChoice) => {
      setProviderChoice(p)
      await setGitProvider(p === ProviderChoiceValue.NONE ? null : p)
    },
    [setGitProvider]
  )

  const createDefaultAgent = useCallback(
    async (agentType: CodingAgentType, backendReady: boolean) => {
      // Only ask an installed backend for its models; an absent one can't answer.
      const model = backendReady ? await getDefaultModel(agentType) : ''

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
    setError(null)
    setCreating(true)
    try {
      const backend = resolveDefaultBackend(toolStatus, preferredBackend)
      const ready = isBackendReady(toolStatus?.[getAgentToolKey(backend)])
      await createDefaultAgent(backend, ready)
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

  const availableBackends = getAvailableBackends(toolStatus)
  const availableLabels = AGENT_OPTIONS
    .filter((a) => availableBackends.includes(a.type))
    .map((a) => a.label)

  /* ─── Render ─── */

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleSkip()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Welcome to 21x</DialogTitle>
          <DialogDescription>
            Get 21x more done with AI agents
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {/* ── Installed backends ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted-foreground">
                Installed coding agents{' '}
                <span className="opacity-60">(every installed agent is available)</span>
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                disabled={detecting || !!installing}
                onClick={() => void runDetection()}
                aria-label="Re-check installed agents"
              >
                {detecting ? (
                  <Loader2 className="size-3 animate-spin mr-1" />
                ) : (
                  <RefreshCw className="size-3 mr-1" />
                )}
                Re-check
              </Button>
            </div>
            <div className="grid grid-cols-5 gap-2.5">
              {AGENT_OPTIONS.map((agent) => {
                const toolKey = getAgentToolKey(agent.type)
                const detected = toolStatus?.[toolKey]
                const isInstalled = detected?.installed === true
                const isReady = isBackendReady(detected)
                return (
                  <div
                    key={agent.type}
                    data-testid={`backend-card-${agent.type}`}
                    data-available={isReady ? 'true' : 'false'}
                    className={`relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-colors ${
                      isReady
                        ? 'border-emerald-500/50 bg-emerald-500/5'
                        : 'border-border'
                    }`}
                  >
                    <agent.Logo className="size-9" />
                    <div className="text-center">
                      <p className="text-xs font-semibold text-foreground leading-tight">
                        {agent.label}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {agent.tagline}
                      </p>
                    </div>
                    {/* Health / detected status — informational, never a gate */}
                    {toolStatus && (
                      <span
                        className={`text-[10px] flex items-center gap-0.5 ${
                          isReady
                            ? 'text-emerald-400'
                            : detected?.supported === false && isInstalled
                              ? 'text-amber-400'
                              : 'text-muted-foreground/50'
                        }`}
                        title={detected?.reason || undefined}
                      >
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
                    {toolStatus && !isReady && (
                      agent.installable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1.5 text-[10px]"
                          disabled={!!installing || detecting}
                          onClick={() => handleInstall(toolKey)}
                          aria-label={`Install ${agent.label}`}
                        >
                          {installing === toolKey ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Download className="size-2.5 mr-0.5" />
                              {isInstalled ? 'Update' : 'Install'}
                            </>
                          )}
                        </Button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/70 text-center">
                          {agent.setupHint}
                        </span>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Availability summary / install-later notice ── */}
          {toolStatus && (
            availableBackends.length > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="backend-summary">
                Ready to use: <span className="text-foreground">{availableLabels.join(', ')}</span>
              </p>
            ) : (
              <div
                className="flex items-start gap-2.5 px-3 py-2 rounded-lg border border-border bg-muted/20 text-xs"
                data-testid="no-backend-notice"
              >
                <Info className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                <span className="text-muted-foreground">
                  No coding agent is installed yet. You can finish setup now and install one
                  later — use the Install buttons above or Settings &rarr; Agent &amp; Tool Setup.
                  Any agent you install will be picked up automatically.
                </span>
              </div>
            )
          )}

          {/* ── Default backend (separate from discovery, optional) ── */}
          <DefaultBackendRow
            toolStatus={toolStatus}
            preferred={preferredBackend}
            onSelect={setPreferredBackend}
          />

          {/* ── Git provider (optional) ── */}
          <GitProviderRow
            selected={providerChoice}
            onSelect={handleProviderSelect}
            toolStatus={toolStatus}
          />

          {/* ── Voice control (optional extra download) ── */}
          <VoiceRuntimeRow variant="compact" />

          {/* ── Error ── */}
          {error && (
            <p className="text-xs text-destructive flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" />
              {error}
            </p>
          )}

          {/* ── Actions ── */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleStart}
              disabled={creating}
              className="flex-1"
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin mr-1.5" />
              ) : (
                <Sparkles className="size-4 mr-1.5" />
              )}
              Get Started
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

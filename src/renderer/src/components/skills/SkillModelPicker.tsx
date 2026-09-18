import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { agentConfigApi } from '@/lib/ipc-client'
import { useAgentStore } from '@/stores/agent-store'
import { CodingAgentType, CODING_AGENTS, CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS } from '@/types'

interface ModelOption {
  value: string
  label: string
}

/** Flattens a provider listing into `provider/model` ids, as the agent form does. */
function providerModelOptions(result: Awaited<ReturnType<typeof agentConfigApi.getProviders>>): ModelOption[] {
  const options: ModelOption[] = []
  for (const provider of result?.providers ?? []) {
    const models = provider.models
    const entries: [string, { id?: string; name?: string } | undefined][] = Array.isArray(models)
      ? (models as { id?: string; name?: string }[]).map((m) => [m?.id ?? '', m])
      : models && typeof models === 'object'
        ? Object.entries(models as Record<string, { id?: string; name?: string }>)
        : []
    for (const [key, m] of entries) {
      const id = m?.id || key
      if (id) options.push({ value: `${provider.id}/${id}`, label: `${provider.name} - ${m?.name || id}` })
    }
  }
  return options
}

/**
 * Picks a skill's optional preferred model. The backend choice only selects
 * which model list to show (skills are not tied to a backend); the model is
 * checked again against the session's backend when the skill runs.
 */
export function SkillModelPicker({ value, onChange }: { value: string; onChange: (model: string) => void }) {
  const defaultAgent = useAgentStore((s) => s.agents.find((a) => a.is_default) ?? s.agents[0])
  const [backend, setBackend] = useState<CodingAgentType>(
    (defaultAgent?.config.coding_agent as CodingAgentType | undefined) ?? CodingAgentType.OPENCODE
  )
  const [options, setOptions] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fixed = backend === CodingAgentType.CLAUDE_CODE ? CLAUDE_MODELS
      : backend === CodingAgentType.CODEX ? CODEX_MODELS
        : backend === CodingAgentType.CURSOR ? CURSOR_MODELS
          : null
    if (fixed) {
      setOptions(fixed.map((m) => ({ value: m.id, label: m.name })))
      return
    }
    setLoading(true)
    agentConfigApi.getProviders(defaultAgent?.server_url, backend)
      .then((result) => { if (!cancelled) setOptions(providerModelOptions(result)) })
      .catch(() => { if (!cancelled) setOptions([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [backend, defaultAgent?.server_url])

  const unknown = !!value && options.length > 0 && !options.some((o) => o.value === value)

  return (
    <div className="space-y-1.5">
      <Label htmlFor="skill-preferred-model">Preferred model (optional)</Label>
      <div className="flex gap-2">
        <select
          aria-label="Backend for the model list"
          value={backend}
          onChange={(e) => setBackend(e.target.value as CodingAgentType)}
          className="rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
        >
          {CODING_AGENTS.map((ca) => (
            <option key={ca.value} value={ca.value}>{ca.label}</option>
          ))}
        </select>
        <div className="flex-1">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground border border-input rounded-md">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading models...
            </div>
          ) : options.length > 0 ? (
            <SearchableSelect
              id="skill-preferred-model"
              value={value}
              onChange={onChange}
              placeholder="Use the agent's model"
              options={unknown ? [{ value, label: value }, ...options] : options}
            />
          ) : (
            <Input
              id="skill-preferred-model"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="provider/model-id"
            />
          )}
        </div>
        {value && (
          <Button type="button" variant="ghost" size="icon" aria-label="Clear preferred model" onClick={() => onChange('')}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <p className={`text-[10px] ${unknown ? 'text-destructive' : 'text-muted-foreground'}`}>
        {unknown
          ? `${value} is not offered by this backend. Sessions on it will keep the agent's model.`
          : "Used for sessions this skill is attached to when the agent's backend offers it; otherwise the agent's model is kept."}
      </p>
    </div>
  )
}
